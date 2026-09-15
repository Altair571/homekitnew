const test = require('node:test');
const assert = require('node:assert/strict');
const { environment, base } = require('./helpers.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));

function packet(pt = 99, ssrc = 123) {
    const data = Buffer.alloc(64, 42);
    data[0] = 0x80; data[1] = pt;
    data.writeUInt32BE(ssrc, 8);
    return data;
}
function fixture() {
    const env = environment();
    const calls = [], received = [], passthrough = [];
    const originalResult = Promise.resolve('original');
    const udp = { type: 'udp', rinfo: { address: '192.0.2.2', port: 12345 },
        socket: { send(...args) { calls.push(args); } },
        send(...args) { passthrough.push(args); return originalResult; },
        onData(...args) { received.push(args); return 'received'; },
    };
    const protocol = { transport: udp };
    const connection = { protocols: [protocol], nominated: undefined };
    const dtls = { iceTransport: { connection }, async sendRtp(data) { return data.length; } };
    const originals = { send: udp.send, onData: udp.onData, sendRtp: dtls.sendRtp };
    const session = { pc: { dtlsTransports: [dtls] },
        videoTransceiver: { sender: { ssrc: 123 } }, audioTransceiver: { sender: { ssrc: 456 } } };
    const observation = env.load(base + 'hksv-webrtc-wire-diagnostics.ts').observeWebRTCWire(session);
    return { env, session, connection, protocol, dtls, udp, calls, received, passthrough,
        originalResult, originals, observation, snapshot: () => JSON.parse(JSON.stringify(observation.snapshot())) };
}

test('wire counts wait for actual socket callbacks and separate video from audio', async () => {
    const f = fixture(), video = packet(), audio = packet(110, 456);
    let settled = false;
    const p = f.udp.send(video, ['192.0.2.1', 1234]).then(() => settled = true);
    const a = f.udp.send(audio);
    await tick();
    assert.equal(settled, false);
    assert.equal(f.snapshot().video.pendingSends, 1);
    assert.equal(f.snapshot().audio.sendCompletions, 0);
    assert.equal(f.calls[0][0], video, 'ciphertext buffer must be passed unchanged');
    assert.deepEqual(f.calls[0].slice(1, 3), [1234, '192.0.2.1']);
    assert.deepEqual(f.calls[1].slice(1, 3), [12345, '192.0.2.2']);
    f.calls[1][3](); await a;
    assert.equal(f.snapshot().audio.bytesCompleted, 64);
    assert.equal(f.snapshot().video.sendCompletions, 0);
    f.calls[0][3](); await p;
    assert.equal(f.snapshot().video.sendCompletions, 1);
    assert.equal(f.snapshot().video.pendingSends, 0);
    assert.equal(f.snapshot().video.unexpectedSsrc, 0);
    f.observation.dispose();
});

test('async socket errors are counted without retaining messages or addresses', async () => {
    const f = fixture();
    for (const code of ['EMSGSIZE', 'unknown-private-value']) {
        const p = f.udp.send(packet());
        const rejected = assert.rejects(p, error => error.code === code);
        f.calls.at(-1)[3](Object.assign(new Error('private-key-and-address'), { code }));
        await rejected;
    }
    const stats = f.snapshot();
    assert.deepEqual(stats.video.errors, { EMSGSIZE: 1, other: 1 });
    assert.equal(stats.video.sendCompletions, 0);
    assert.equal(stats.video.pendingSends, 0);
    assert.doesNotMatch(JSON.stringify(stats), /private|192\.0|12345/);
    f.observation.dispose();
});

test('synchronous socket failure propagates with one error count', async () => {
    const f = fixture();
    f.udp.socket.send = () => { throw Object.assign(Error('closed socket'), { code: 'ERR_SOCKET_DGRAM_NOT_RUNNING' }); };
    await assert.rejects(f.udp.send(packet()));
    assert.equal(f.snapshot().video.sendErrors, 1);
    assert.equal(f.snapshot().video.pendingSends, 0);
    f.observation.dispose();
});

test('unexpected outgoing SSRC is counted without retaining the identifier', async () => {
    const f = fixture(), p = f.udp.send(packet(99, 987654321));
    f.calls[0][3](); await p;
    assert.equal(f.snapshot().video.unexpectedSsrc, 1);
    assert.doesNotMatch(JSON.stringify(f.snapshot()), /987654321/);
    f.observation.dispose();
});

test('STUN DTLS RTCP and other RTP payloads preserve the original send path', () => {
    const f = fixture();
    for (const p of [Buffer.from([0, 1, 2]), Buffer.from([22, 254, 253]), packet(200), packet(111), Buffer.alloc(0)])
        assert.equal(f.udp.send(p), f.originalResult);
    assert.equal(f.passthrough.length, 5);
    assert.equal(f.calls.length, 0);
    assert.equal(f.snapshot().video.sendAttempts, 0);
    f.observation.dispose();
});

test('ClientHello source observations do not filter valid ICE candidate traffic', () => {
    const f = fixture(), hello = Buffer.alloc(30);
    hello[0] = 22; hello[1] = 254; hello[2] = 253; hello[13] = 1;
    const addr = ['192.0.2.1', 9999];
    assert.equal(f.udp.onData(hello, addr), 'received');
    f.connection.nominated = { protocol: f.protocol, remoteAddr: addr };
    f.udp.onData(hello, addr);
    f.udp.onData(hello, ['192.0.2.2', 9999]);
    f.connection.nominated.protocol = {};
    f.udp.onData(hello, addr);
    assert.equal(f.received.length, 4);
    assert.ok(f.received.every(args => args[0] === hello));
    assert.deepEqual(f.snapshot().clientHellos, { beforeNomination: 1,
        selectedSocketAndPeer: 1, otherSocket: 1, sameSocketOtherPeer: 1 });
    f.observation.dispose();
});

test('observations restore hooks, preserve later hooks, and return detached snapshots', () => {
    const f = fixture(), snap = f.observation.snapshot();
    snap.video.errors.private = 1;
    assert.deepEqual(f.snapshot().video.errors, {});
    const laterHook = () => {};
    f.udp.onData = laterHook;
    f.observation.dispose(); f.observation.dispose();
    assert.equal(f.udp.send, f.originals.send);
    assert.equal(f.udp.onData, laterHook);
    assert.equal(f.dtls.sendRtp, f.originals.sendRtp);
});

test('actual vendor sendRtp can swallow an error while wire counters retain it', async () => {
    const env = environment();
    const { RTCDtlsTransport } = env.load('../../external/werift/packages/webrtc/src/transport/dtls.ts');
    const original = RTCDtlsTransport.prototype.sendRtp;
    const udp = { type: 'udp', socket: { send(data, port, host, cb) { cb(Object.assign(Error('synthetic'), { code: 'ENOBUFS' })); } },
        send() { throw Error('unobserved original must not run for media'); }, onData() {} };
    const connection = { protocols: [{ transport: udp }], async send(data) { await udp.send(data, ['127.0.0.1', 1]); } };
    const dtls = { config: { debug: {} }, bytesSent: 0, packetsSent: 0,
        srtp: { encrypt: () => packet() }, iceTransport: { connection }, sendRtp: original };
    const observation = env.load(base + 'hksv-webrtc-wire-diagnostics.ts').observeWebRTCWire({
        pc: { dtlsTransports: [dtls] }, videoTransceiver: { sender: { ssrc: 123 } } });
    assert.equal(await dtls.sendRtp(Buffer.alloc(0), { payloadType: 99 }), 64);
    const stats = observation.snapshot();
    assert.equal(dtls.packetsSent, 1, 'legacy counter still reports an attempted packet');
    assert.equal(stats.video.rtpCalls, 1);
    assert.equal(stats.video.sendCompletions, 0);
    assert.equal(stats.video.sendErrors, 1);
    assert.equal(stats.video.errors.ENOBUFS, 1);
    observation.dispose();
});

test('RTP encryption failures and rejected sends have separate counters', async () => {
    const env = environment();
    const dtls = { async sendRtp(payload) { if (payload.length) throw Error('synthetic'); return 0; } };
    const observer = env.load(base + 'hksv-webrtc-wire-diagnostics.ts').observeWebRTCWire({ pc: { dtlsTransports: [dtls] } });
    assert.equal(await dtls.sendRtp(Buffer.alloc(0), { payloadType: 99 }), 0);
    await assert.rejects(dtls.sendRtp(Buffer.alloc(1), { payloadType: 110 }));
    assert.equal(observer.snapshot().video.rtpReturnedZero, 1);
    assert.equal(observer.snapshot().audio.rtpRejected, 1);
    observer.dispose();
});

test('an offer canceled during ICE gathering cannot install hooks after cleanup', async () => {
    const { rtcEnvironment } = require('./webrtc-helpers.cjs');
    const f = rtcEnvironment();
    let observations = 0, release, entered;
    f.env.load(base + 'hksv-webrtc-wire-diagnostics.ts').observeWebRTCWire = () => {
        observations++;
        return { snapshot() {}, dispose() {} };
    };
    const gate = new Promise(resolve => release = resolve);
    const started = new Promise(resolve => entered = resolve);
    const management = new f.Class({ addService() {} }, { log() {}, warn() {}, error() {} }, f.opts);
    const result = management.handleSolicitOffer('');
    f.peers[0].setLocalDescription = async offer => { entered(); await gate; f.peers[0].localDescription = offer; };
    await started;
    management.closeAllSessions();
    release();
    const response = f.proto.parseWebRTCSolicitOfferResponse(Buffer.from(await result, 'base64'));
    assert.notEqual(response.status, 0);
    assert.equal(observations, 0);
    assert.equal(management.sessions.size, 0);
});
