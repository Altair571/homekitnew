const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { environment, base, quiet } = require('./helpers.cjs');
const field = (tag, data) => Buffer.concat([Buffer.from([tag, data.length]), data]);
const sid = Buffer.alloc(16, 0x23);
const address = Buffer.concat([field(1, Buffer.from([0])), field(2, Buffer.from('127.0.0.1')),
    field(3, Buffer.from([0x40, 0x9c])), field(4, Buffer.from([0x41, 0x9c]))]);
const crypto = Buffer.concat([field(1, Buffer.from([0])), field(2, Buffer.alloc(16, 0xab)), field(3, Buffer.alloc(14, 0xcd))]);
const setupValue = Buffer.concat([field(1, sid), field(3, address), field(4, crypto), field(5, crypto)]).toString('base64');

function fixture() {
    const env = environment({ realHap: true }), messages = [];
    const hap = env.load('./src/hap.ts');
    const acc = new hap.Accessory('Camera', '00000000-0000-4000-8000-000000001111');
    const connection = new EventEmitter();
    Object.assign(connection, { remoteAddress: '192.168.1.102', localAddress: '127.0.0.1' });
    const log = { ...quiet, log(...args) { messages.push(args.join(' ')); } };
    const install = hevc => env.load(base + 'camera-stream-diagnostics.ts').installCameraStreamDiagnostics(acc, log, hevc);
    return { env, hap, acc, connection, messages, install, log };
}

test('legacy HAP setup success, busy and disabled responses remain intact and observable', async () => {
    const f = fixture(), requests = [];
    const controller = new f.hap.CameraController({ cameraStreamCount: 1,
        streamingOptions: { supportedCryptoSuites: [0], video: { codec: { profiles: [1], levels: [2] }, resolutions: [[640, 360, 30]] },
            audio: { codecs: [{ type: 'OPUS', samplerate: 24 }] } },
        delegate: { prepareStream(request, cb) { requests.push(request); cb(null, {
            addressOverride: '127.0.0.1', video: { ...request.video, port: 40000, ssrc: 123 }, audio: { ...request.audio, port: 40001, ssrc: 456 },
        }); }, handleStreamRequest(_request, cb) { cb(); } },
    });
    f.acc.configureController(controller);
    const sm = controller.streamManagements[0], service = sm.getService();
    const setup = service.getCharacteristic(f.hap.Characteristic.SetupEndpoints);
    const active = service.getCharacteristic(f.hap.Characteristic.Active);
    const before = service.characteristics.slice();
    f.install(false);
    try {
        await setup.handleSetRequest(setupValue, f.connection);
        const response = await setup.handleGetRequest(f.connection);
        const map = f.env.load(base + 'hksv-multitier-protocol.ts').tlvDecodeMap(Buffer.from(response, 'base64'));
        assert.equal(map[2][0], 0); assert.equal(requests.length, 1);
        await setup.handleSetRequest(setupValue, f.connection);
        await setup.handleGetRequest(f.connection);
        assert.equal(requests.length, 1);
        active.updateValue(false);
        await assert.rejects(setup.handleSetRequest(setupValue, f.connection), e => e === -70412);
        assert(f.messages.some(s => s.includes('setupStatus=0')));
        assert(f.messages.some(s => s.includes('setupStatus=1')));
        assert(f.messages.some(s => s.includes('rejected hapStatus=-70412')));
        assert(f.messages.some(s => s.includes('peer=192.168.1.102') && s.includes('received')));
        assert(f.messages.some(s => s.includes('HEVC option=false; legacy RTP=1')));
        assert.deepEqual(service.characteristics, before);
        assert(!f.messages.join('\n').includes(setupValue));
        assert(!f.messages.join('\n').includes(Buffer.alloc(16, 0xab).toString('base64')));
    } finally { controller.handleControllerRemoved(); }
});

test('diagnostics preserve onSet write responses and pre-handler validation failures', async () => {
    const f = fixture();
    const service = new f.hap.Service.CameraRTPStreamManagement('Camera', 'test'); f.acc.addService(service);
    const active = service.getCharacteristic(f.hap.Characteristic.Active);
    let called = 0;
    active.onSet(() => { called++; });
    const setup = service.getCharacteristic(f.hap.Characteristic.SetupEndpoints);
    const reply = Buffer.concat([field(1, sid), field(2, Buffer.from([1]))]).toString('base64');
    setup.setProps({ perms: ['pr', 'pw', 'wr'] }).onSet(() => reply);
    f.install(false); f.install(false);
    await assert.rejects(active.handleSetRequest({}, f.connection), e => e === -70410);
    assert.equal(called, 0);
    await active.handleSetRequest(1, f.connection); assert.equal(called, 1);
    assert.equal(await setup.handleSetRequest(setupValue, f.connection), reply);
    assert(f.messages.some(s => s.includes('setupStatus=1')));
    assert.equal(f.messages.filter(s => s.includes('WRITE legacy RTP[0] Active #1') && s.includes('received')).length, 1);
    assert(f.messages.some(s => s.includes('rejected hapStatus=-70410')));
});

test('new multi-tier HAP write response and session cleanup survive diagnostic observation', async () => {
    const f = fixture(), requests = [];
    const { MultiTierStreamManagement } = f.env.load(base + 'camera-multitier.ts');
    const mt = new MultiTierStreamManagement(f.acc, {
        prepareStream(request, cb) { requests.push(request); cb(null, { addressOverride: '127.0.0.1',
            video: { port: 40000, ssrc: 123 }, audio: { port: 40001, ssrc: 456 } }); },
        handleStreamRequest(_request, cb) { cb(); },
    }, quiet, { sensorClass: '4k' });
    f.install(true);
    try {
        const setup = mt.service.characteristics.find(c => c.UUID === f.hap.Characteristic.SetupEndpoints.UUID);
        const reply = await setup.handleSetRequest(setupValue, f.connection);
        assert.equal(await setup.handleGetRequest(f.connection), reply);
        assert.equal(requests.length, 1); assert.equal(mt.sessions.size, 1);
        assert(f.messages.some(s => s.includes('WRITE multi-tier RTP[0] Setup Endpoints') && s.includes('setupStatus=0')));
        f.connection.emit('closed'); assert.equal(mt.sessions.size, 0);
        assert(!f.messages.join('\n').includes(setupValue));
    } finally { mt.closeAllSessions(); }
});

test('observation preserves the exact promise and does not propagate logging failures', async () => {
    const f = fixture();
    const service = new f.hap.Service.CameraRTPStreamManagement('Camera', 'test'); f.acc.addService(service);
    const active = service.getCharacteristic(f.hap.Characteristic.Active);
    let resolve, calls = 0;
    const promise = new Promise(r => { resolve = r; });
    active.handleSetRequest = function(value, connection, context) {
        assert.equal(this, active); assert.equal(value, 1); assert.equal(connection, f.connection); assert.equal(context, 'context');
        calls++; return promise;
    };
    f.log.log = () => { throw Error('diagnostic sink unavailable'); };
    f.install(false);
    assert.equal(active.handleSetRequest(1, f.connection, 'context'), promise);
    resolve('unchanged'); assert.equal(await promise, 'unchanged'); assert.equal(calls, 1);
});

test('WebRTC write diagnostics expose protocol status without SDP or receive-key payloads',async()=>{
    const f=fixture(),p=f.env.load(base+'hksv-webrtc-protocol.ts');
    const service=new f.hap.Service('WebRTC',p.CameraWebRTCStreamManagementServiceUUID);f.acc.addService(service);
    for(const [uuid,tag] of [[p.WebRTCSolicitOfferUUID,4],[p.WebRTCProvideAnswerUUID,2],[p.WebRTCStreamingControlUUID,2],[p.WebRTCReofferUUID,3],[p.WebRTCUpdateSessionUUID,2]]){
        const c=new f.hap.Characteristic('WebRTC control',uuid,{format:'tlv8',perms:['pr','pw','wr']});service.addCharacteristic(c);
        const response=Buffer.concat([field(1,sid),field(tag,Buffer.from([3]))]).toString('base64');
        c.onSet(()=>response);f.install(true);
        const value=Buffer.concat([field(1,sid),field(2,Buffer.alloc(32,0xab))]).toString('base64');
        assert.equal(await c.handleSetRequest(value,f.connection),response);
        assert(f.messages.at(-1).includes('webrtcStatus=3'));
        assert(!f.messages.join('\n').includes(value));
    }
});
