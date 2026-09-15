const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { environment, base, storage, quiet } = require('./helpers.cjs');

function fixture(disabled = ['Legacy Recording Config', 'Legacy RTP Live View'], takeSnapshot) {
    const env = environment({ realHap: true });
    const hap = env.load('./src/hap.ts');
    const acc = new hap.Accessory('Discovery regression', '00000000-0000-4000-8000-000000000014');
    const controller = new hap.CameraController({
        cameraStreamCount: 2, delegate: {},
        streamingOptions: { supportedCryptoSuites: [0],
            video: { codec: { profiles: [0, 1, 2], levels: [0, 1, 2] }, resolutions: [[640, 360, 30]] },
            audio: { codecs: [{ type: 'OPUS', samplerate: 24 }] } },
        recording: { delegate: { updateRecordingActive() {}, updateRecordingConfiguration() {} }, options: {
            prebufferLength: 4000, mediaContainerConfiguration: { type: 0, fragmentLength: 4000 },
            video: { type: 0, parameters: { profiles: [0], levels: [0] }, resolutions: [[1280, 720, 30]] },
            audio: { codecs: { type: 0, audioChannels: 1, samplerate: 2, bitrateMode: 0 } },
        } },
    });
    acc.configureController(controller);
    const logs = [];
    const { Hksv27Camera } = env.load(base + 'camera-hksv27.ts');
    const camera = new Hksv27Camera(acc, {}, storage(), { ...quiet, log: m => logs.push(m) }, {
        sensorClass: '4k', sensorWidth: 3840, sensorHeight: 2160, disabledServices: new Set(disabled), takeSnapshot,
    });
    const recording = controller.recordingManagement;
    camera.attachRecordingManagement(recording.recordingManagementService);
    camera.attachLegacyOperatingMode(recording.operatingModeService);
    if (disabled.includes('Legacy RTP Live View'))
        camera.useMultiTierLiveViewOnly(controller.streamManagements.map(sm => sm.getService()));
    camera.configureRecordingTransport(recording);
    let iid = 1;
    for (const service of acc.services) {
        service.iid = iid++;
        for (const characteristic of service.characteristics) characteristic.iid = iid++;
    }
    return { env, hap, acc, controller, camera, recording, logs,
        close() { camera.handleFactoryReset(); recording.destroy(); } };
}

test('reused HAP UUIDs match the bundled standard definitions, including RTP 0x116', () => {
    const env = environment({ realHap: true });
    const { Characteristic } = env.load('./src/hap.ts');
    let compared = 0;
    for (const module of ['hksv-multitier-protocol.ts', 'hksv-camera-capabilities.ts']) {
        for (const [name, uuid] of Object.entries(env.load(base + module))) {
            if (!name.endsWith('UUID')) continue;
            const standard = Characteristic[name.slice(0, -4)];
            if (standard) { assert.equal(uuid, standard.UUID, name); compared++; }
        }
    }
    assert.equal(compared, 8);
});

test('Home can discover and read AES-128 RTP configuration under 0x116 on the serialized service', async () => {
    const f = fixture();
    try {
        const service = await f.camera.multiTier.service.toHAP(undefined, true);
        const rtp = service.characteristics.filter(c => c.type === '116');
        assert.equal(rtp.length, 1, 'Home finds the required characteristic by UUID');
        assert.equal(rtp[0].format, 'tlv8');
        assert.deepEqual(Buffer.from(rtp[0].value, 'base64'), Buffer.from([2, 1, 0]));
        assert(!service.characteristics.some(c => c.type === '115'), 'not misidentified as legacy audio');
        assert.equal(service.characteristics.find(c => c.type === '75').value, 1, 'active BOOL on the HAP wire');
    } finally { f.close(); }
});

test('WebRTC advertises its matching RTP link and bisected services leave no dangling links', () => {
    for (const disabled of [[], ['WebRTC'], ['Multi-Tier RTP']]) {
        const f = fixture(disabled);
        try {
            for (const service of f.acc.services) {
                assert(service.linkedServices.every(link => f.acc.services.includes(link)));
                assert.equal(new Set(service.linkedServices).size, service.linkedServices.length);
            }
            if (!disabled.length) {
                const rtc = f.camera.webrtc.service.internalHAPRepresentation();
                assert(rtc.linked.includes(f.camera.multiTier.service.iid));
            }
            if (disabled.includes('Multi-Tier RTP'))
                assert(!f.camera.webrtc.service.linkedServices.includes(f.camera.multiTier.service));
        } finally { f.close(); }
    }
});

test('remote HEVC discovery finds WebRTC through the serialized multi-tier RTP service links', async () => {
    const f = fixture();
    try {
        const services = await Promise.all(f.acc.services.map(s => s.toHAP(undefined, true)));
        const rtp = services.find(s => s.iid === f.camera.multiTier.service.iid);
        const rtc = services.find(s => s.iid === f.camera.webrtc.service.iid);
        const shortType = type => parseInt(type.split('-')[0], 16);
        // Apple macOS 27 (26A428) looks up the WebRTC service by its UUID and
        // membership in streamManagementService.linkedServices. A reverse link
        // or matching Sensor UUID alone cannot satisfy that lookup.
        const findWebRTC = source => services.find(s => shortType(s.type) === 0x8033 && source.linked?.includes(s.iid));
        assert.equal(shortType(rtp.type), 0x8031);
        assert.equal(findWebRTC(rtp), rtc);
        assert(rtc.linked.includes(rtp.iid), 'retain the existing reverse association');
        assert.equal(findWebRTC({ ...rtp, linked: rtp.linked.filter(id => id !== rtc.iid) }), undefined,
            'the r13 graph fails discovery even though WebRTC is advertised');
        assert(!services.some(s => shortType(s.type) === 0x110), 'no H.264 fallback introduced');
    } finally { f.close(); }
});

test('Run 12 retains the real HDS service, setup handler and recording links while stripping legacy TLVs', async () => {
    for (const stripped of [false, true]) {
        const f = fixture(stripped ? ['Legacy Recording Config', 'Legacy RTP Live View'] : []);
        try {
            const { Characteristic } = f.hap;
            const transport = f.recording.dataStreamManagement;
            const hds = transport.getService();
            const rms = f.recording.recordingManagementService;
            assert(f.acc.services.includes(hds));
            assert.equal(rms.characteristics.some(c => c.UUID === Characteristic.SelectedCameraRecordingConfiguration.UUID), !stripped);
            for (const service of [rms, f.camera.multiTier.service, f.camera.webrtc.service])
                assert(service.internalHAPRepresentation().linked.includes(hds.iid));
            const supported = hds.getCharacteristic(Characteristic.SupportedDataStreamTransportConfiguration);
            assert.equal(supported.value, 'AQMBAQA=');
            const setup = hds.getCharacteristic(Characteristic.SetupDataStreamTransport);
            let receivedConnection, receivedSalt;
            transport.dataStreamServer.prepareSession = (connection, salt, cb) => {
                receivedConnection = connection; receivedSalt = salt;
                cb(null, { port: 45678, accessoryKeySalt: Buffer.alloc(32, 2) });
            };
            const { tlvEncode } = f.env.load(base + 'hksv-stream-tiers.ts');
            const hapConnection = { sessionID: 'test' };
            const request = tlvEncode(1, Buffer.from([0]), 2, Buffer.from([0]), 3, Buffer.alloc(32, 1));
            const response = await new Promise((resolve, reject) => setup.emit('set', request.toString('base64'),
                (error, value) => error ? reject(error) : resolve(value), undefined, hapConnection));
            assert.equal(receivedConnection, hapConnection);
            assert.deepEqual(receivedSalt, Buffer.alloc(32, 1));
            const { tlvDecodeMap } = f.env.load(base + 'hksv-multitier-protocol.ts');
            const fields = tlvDecodeMap(Buffer.from(response, 'base64'));
            assert.equal(fields[1][0], 0, 'setup success');
            assert.equal(tlvDecodeMap(fields[2])[1].readUInt16LE(), 45678);
            assert.deepEqual(fields[3], Buffer.alloc(32, 2));
        } finally { f.close(); }
    }
});

test('HDS diagnostics observe request routing without replacing handlers or exposing payloads', () => {
    const f = fixture();
    try {
        const transport = f.recording.dataStreamManagement;
        const server = transport.dataStreamServer;
        f.camera.configureRecordingTransport(f.recording);
        assert.equal(server.listenerCount('connection-opened'), 1);
        const connection = new EventEmitter();
        let responses = 0;
        connection.sendResponse = () => { responses++; };
        connection.on('handle-message-globally', message => server.handleMessageGlobally(connection, message));
        server.emit('connection-opened', connection);
        connection.emit('handle-message-globally', { type: f.hap.MessageType.REQUEST,
            protocol: 'dataSend', topic: 'open', id: 1, message: {
                type: 'ipcamera.snapshot', target: 'controller', secret: 'sensitive-test-value',
                data: Buffer.from('private-JPEG-test-value'),
            } });
        assert.equal(responses, 1, 'existing handler still responds once');
        assert(f.logs.some(l => l.includes('HomeKit HDS request dataSend/open')));
        assert(!f.logs.join('\n').includes('sensitive-test-value'));
        assert(!f.logs.join('\n').includes('private-JPEG-test-value'));
        connection.emit('closed');
        assert.equal(connection.listenerCount('handle-message-globally'), 1, 'observer removed; handler retained');
    } finally { f.close(); }
});

test('the assembled Run 12 camera installs the snapshot adapter and global off cancels pending images', { timeout: 2000 }, async () => {
    let resolveImage;
    const f = fixture(undefined, () => new Promise(resolve => { resolveImage = resolve; }));
    try {
        const connection = new EventEmitter(), responses = [], sent = [];
        connection.sendResponse = (...args) => responses.push(args);
        connection.sendEvent = (...args) => sent.push(args);
        f.recording.dataStreamManagement.dataStreamServer.handleMessageGlobally(connection, {
            type: f.hap.MessageType.REQUEST, protocol: 'dataSend', topic: 'open', id: 1,
            message: { type: 'ipcamera.snapshot', target: 'controller', streamId: 1 },
        });
        assert.equal(responses.length, 1); assert.equal(responses[0][3], 0);
        assert.equal(f.camera.snapshots.transfers.size, 1);
        const global = f.camera.globalCameraActiveChar;
        await new Promise((resolve, reject) => global.emit('set', 0, error => error ? reject(error) : resolve()));
        resolveImage(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
        await new Promise(setImmediate);
        assert.equal(f.camera.snapshots.transfers.size, 0);
        assert(!sent.some(([_protocol, topic]) => topic === 'data'));
    } finally { f.close(); }
});
