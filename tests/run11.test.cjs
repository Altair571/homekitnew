const test = require('node:test');
const assert = require('node:assert/strict');
const { environment, storage, base, quiet } = require('./helpers.cjs');
const tick = () => new Promise(setImmediate);
const write = (characteristic, value) => new Promise((resolve, reject) =>
    characteristic.emit('set', value, error => error ? reject(error) : resolve()));

function fixture(source) {
    const env = environment({ realHap: true });
    const hap = env.load('./src/hap.ts');
    const protocol = env.load(base + 'hksv-recording-protocol.ts');
    const { tlvEncode } = env.load(base + 'hksv-stream-tiers.ts');
    const state = storage();
    const acc = new hap.Accessory('Run 11 regression', '00000000-0000-4000-8000-000000000011');
    const logs = [];
    const { Hksv27Camera } = env.load(base + 'camera-hksv27.ts');
    const camera = new Hksv27Camera(acc, { handleStreamRequest(req, cb) { cb(); } }, state,
        { ...quiet, log(message) { logs.push(message); } },
        { sensorClass: '4k', sensorWidth: 3840, sensorHeight: 2160, recordingSource: source });
    const recording = new hap.Service.CameraRecordingManagement('Recording');
    acc.addService(recording);
    camera.attachRecordingManagement(recording);
    const active = recording.getCharacteristic(hap.Characteristic.Active);
    const audio = recording.getCharacteristic(hap.Characteristic.RecordingAudioActive);
    const char = name => acc.services.flatMap(s => s.characteristics).find(c => c.displayName === name);
    const point = tlvEncode(1, Buffer.from('https://example.invalid/ingest/'), 2, tlvEncode(1, Buffer.from('test CA'))).toString('base64');
    // Synthetic identity for lifecycle tests only; no network upload is performed.
    const provision = async () => {
        state.setItem('hksv27-client-certificate', 'test certificate');
        state.setItem('hksv27-client-key-pem', 'test key');
        await write(char('Camera Recording Publishing Point'), point);
    };
    return { env, hap, protocol, tlvEncode, state, acc, camera, recording, active, audio, char, point, provision, logs };
}

test('recorder waits for Active and provisioning; duplicate writes do not restart it', async () => {
    let starts = 0, stops = 0;
    const f = fixture(async function* (tier, signal) {
        starts++;
        assert.equal(tier.width, 3840);
        try { await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); }
        finally { stops++; }
    });
    try {
        await tick(); assert.equal(starts, 0);
        f.active.updateValue(1); await tick(); assert.equal(starts, 0);
        await f.provision(); await tick(); assert.equal(starts, 1);
        for (let i = 0; i < 10; i++) {
            f.active.updateValue(1);
            f.audio.emit('change', { oldValue: 1, newValue: 1, reason: 'write' });
            await write(f.char('Camera Recording Publishing Point'), f.point);
        }
        await tick(); assert.equal(starts, 1); assert.equal(stops, 0);
        f.active.updateValue(0); await tick(); assert.equal(stops, 1);
        await tick(); assert.equal(starts, 1);
    } finally { f.camera.handleFactoryReset(); }
});

test('recorder replacement waits for asynchronous cleanup and unpair cannot restart it', async () => {
    let starts = 0, current = 0, peak = 0, finishOld;
    const f = fixture(async function* (_tier, signal) {
        const n = ++starts; peak = Math.max(peak, ++current);
        try {
            await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
            if (n === 1) await new Promise(resolve => { finishOld = resolve; });
        } finally { current--; }
    });
    try {
        await f.provision(); f.active.updateValue(1); await tick();
        f.audio.emit('change', { oldValue: 0, newValue: 1, reason: 'write' });
        await tick(); assert.equal(starts, 1);
        f.audio.emit('change', { oldValue: 1, newValue: 0, reason: 'write' });
        await tick(); assert.equal(starts, 1);
        finishOld(); await tick(); assert.equal(starts, 2); assert.equal(peak, 1);
        f.camera.handleFactoryReset(); await tick(); await tick();
        assert.equal(current, 0); assert.equal(starts, 2);
    } finally { finishOld?.(); f.camera.handleFactoryReset(); }
});

test('Camera Key stops unusable encoding and repeated Active writes keep it idle', async () => {
    let starts = 0, stopped = false;
    const f = fixture(async function* (_tier, signal) {
        starts++;
        await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
        stopped = true;
    });
    try {
        await f.provision(); f.active.updateValue(1); await tick(); assert.equal(starts, 1);
        await write(f.char('Camera Key'), f.protocol.encodeCameraKey({ key: Buffer.alloc(32, 7), keyNumber: 1n }).toString('base64'));
        await tick(); assert(stopped);
        for (let i = 0; i < 10; i++) f.active.updateValue(1);
        await tick(); assert.equal(starts, 1);
        assert.equal(f.logs.filter(l => l.includes('recording buffer idle: Camera Key')).length, 1);
    } finally { f.camera.handleFactoryReset(); }
});

test('empty publishing point and certificate reset cleanly; invalid replacements preserve state', async () => {
    const f = fixture();
    try {
        await f.provision();
        await assert.rejects(write(f.char('Camera Recording Publishing Point'),
            f.tlvEncode(1, Buffer.from('http://example.invalid/')).toString('base64')), /HTTPS/);
        assert.equal(f.state.getItem('hksv27-publishing-point'), f.point);
        await write(f.char('Camera Recording Publishing Point'), f.tlvEncode(1, Buffer.alloc(0)).toString('base64'));
        assert.equal(f.state.getItem('hksv27-publishing-point'), null);
        await write(f.char('Camera Recording Publishing Point'), '');
        await assert.rejects(write(f.char('Camera Client Certificate'),
            f.protocol.encodeClientCertificate({ clientCertificate: Buffer.from('not DER'), ca: Buffer.alloc(0) }).toString('base64')));
        assert.equal(f.state.getItem('hksv27-client-certificate'), 'test certificate');
        assert.equal(f.camera.certificateNeedsUpdate(), true);
        await write(f.char('Camera Client Certificate'), '');
        assert.equal(f.state.getItem('hksv27-client-certificate'), null);
        assert.equal(f.state.getItem('hksv27-client-ca'), null);
        assert.equal(f.camera.certificateNeedsUpdate(), true);
        assert(!f.logs.some(l => l.includes('provisioned (0 bytes)')));
    } finally { f.camera.handleFactoryReset(); }
});

test('native recording source selects main 4K despite remote-recorder destination', async () => {
    const { getNativeHksvVideoStream } = environment().load(base + 'hksv-media.ts');
    const device = {
        async getVideoStreamOptions() { return [
            { id: 'sub', video: { codec: 'h265', width: 1920, height: 1080, fps: 25 } },
            { id: 'main', video: { codec: 'h265', width: 3840, height: 2160, fps: 25 } },
        ]; },
        async getVideoStream(options) { return options; },
    };
    const request = { destination: 'remote-recorder', video: { codec: 'h265', width: 3840, height: 2160, fps: 30, bitrate: 4500000 }, audio: { codec: 'aac' } };
    let result = await getNativeHksvVideoStream(device, request);
    assert.equal(result.id, 'main'); assert.equal(result.adaptive, false);
    assert.equal(result.video.codec, undefined); assert.equal(result.video.fps, undefined);
    result = await getNativeHksvVideoStream(device, { ...request, video: { width: 1280, height: 720 }, audio: null });
    assert.equal(result.id, 'sub'); assert.equal(result.audio, null);
    result = await getNativeHksvVideoStream(device, { ...request, id: 'sub' });
    assert.equal(result.id, 'sub');
});

test('Run 12 removes actual legacy HAP live services and keeps tier advertisements and recording', () => {
    const f = fixture();
    try {
        const { CameraController, Characteristic } = f.hap;
        const controller = new CameraController({ cameraStreamCount: 2, delegate: {}, streamingOptions: {
            supportedCryptoSuites: [0], video: { codec: { profiles: [0, 1, 2], levels: [0, 1, 2] }, resolutions: [[640, 360, 30]] },
            audio: { codecs: [{ type: 'OPUS', samplerate: 24 }] },
        } });
        f.acc.configureController(controller);
        const legacy = controller.streamManagements.map(s => s.getService());
        assert(legacy.every(s => f.acc.services.includes(s)));
        const tiers = f.camera.multiTier.supportedVideoTiersValue;
        f.camera.useMultiTierLiveViewOnly(legacy);
        assert(legacy.every(s => !f.acc.services.includes(s)));
        assert(f.acc.services.includes(f.recording));
        assert(f.acc.services.includes(f.camera.multiTier.service));
        assert(f.camera.multiTier.service.isPrimaryService);
        assert.equal(f.camera.multiTier.supportedVideoTiersValue, tiers);
        assert.equal(f.recording.getCharacteristic(Characteristic.Active).value, 0);
    } finally { f.camera.handleFactoryReset(); }
});
