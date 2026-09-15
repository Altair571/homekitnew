const test = require('node:test');
const assert = require('node:assert/strict');
const { environment, base } = require('./helpers.cjs');
const load = () => environment().load(base + 'hksv-webrtc-contract.ts');
const midUri = 'urn:ietf:params:rtp-hdrext:sdes:mid';
const ridUri = 'urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id';
function sdp({ sframe = true, rid = '1', paused = false, direction = 'recvonly', port = 9,
    extDirection = '', ext = true, sessionSframe = false } = {}) {
    return ['v=0', 'a=group:BUNDLE privateVideo privateAudio',
        ...(sessionSframe ? ['a=sframe'] : []),
        `m=video ${port} UDP/TLS/RTP/SAVPF 99`, 'a=mid:privateVideo', `a=${direction}`,
        'a=rtpmap:99 H265/90000', ...(sframe ? ['a=sframe'] : []),
        ...(rid ? [`a=rid:${rid} recv pt=99`, `a=simulcast:recv ${paused ? '~' : ''}${rid}`] : []),
        ...(ext ? [`a=extmap:3${extDirection} ${ridUri}`, `a=extmap:4 ${midUri}`] : []),
        'm=audio 9 UDP/TLS/RTP/SAVPF 110', 'a=mid:privateAudio', 'a=recvonly',
        'a=rtpmap:110 opus/48000/2', ...(sframe ? ['a=sframe'] : []), ''].join('\r\n');
}
function fixture(answer = sdp(), { hap = true, now } = {}) {
    const env = environment(), api = env.load(base + 'hksv-webrtc-contract.ts');
    const session = { sframeConfiguration: hap ? { key: Buffer.from('DO-NOT-LOG-KEY'), kid: 92837465n } : undefined,
        videoTransceiver: { sender: { ssrc: 987654321, codec: { payloadType: 99, clockRate: 90000 }, rtpStreamId: '1' } },
        audioTransceiver: { sender: { ssrc: 1122334455, codec: { payloadType: 110, clockRate: 48000 } } } };
    const offer = sdp().replaceAll('recvonly', 'sendonly').replace('m=audio', 'a=ssrc:987654321 cname:PRIVATE-CNAME\r\nm=audio');
    const observer = api.observeWebRTCContract(session, offer, now);
    observer.setRemote(answer, 'answer');
    const { RtpPacket, RtpHeader } = env.load('../../external/werift/packages/rtp/src/index.ts');
    const header = new RtpHeader({ payloadType: 99, sequenceNumber: 1, timestamp: 3000,
        ssrc: 987654321, marker: true, extension: true,
        extensions: [{ id: 3, payload: Buffer.from('1') }, { id: 4, payload: Buffer.from('privateVideo') }] });
    const payload = Buffer.from([0xc0, 1, 2, 3, 4, 5]);
    const send = () => { observer.observeRtp('video', payload, header); observer.observeUdp('video', new RtpPacket(header, payload).serialize()); };
    const snap = () => JSON.parse(JSON.stringify(observer.snapshot()));
    return { observer, header, payload, send, snap, session, RtpPacket, RtpHeader };
}

test('contract distinguishes explicit SFrame agreement from HAP-only and remote-only', () => {
    for (const [remote, hap, expected] of [[true, true, 'explicit'], [false, true, 'hap-only'], [true, false, 'remote-only'], [false, false, 'none']]) {
        const f = fixture(sdp({ sframe: remote }), { hap });
        assert.equal(f.snap().video.accepted.sframe, expected);
        assert.equal(f.snap().audio.accepted.sframe, expected);
    }
    assert.equal(fixture(sdp({ sframe: false, sessionSframe: true })).snap().video.accepted.sframe, 'hap-only');
});

test('supplemental SDP summary retains pause and extension direction, omitting secrets', () => {
    const input = sdp({ paused: true, extDirection: '/recvonly' }) + 'a=ice-pwd:PRIVATE-PASSWORD\r\na=fingerprint:sha-256 SECRET-FINGERPRINT\r\n';
    const result = JSON.parse(JSON.stringify(load().summarizeWebRTCContractSdp(input)));
    assert.equal(result.media[0].pausedReceiveCount, 1);
    assert.equal(result.media[0].extensions[0].direction, 'recvonly');
    assert.doesNotMatch(JSON.stringify(result), /privateVideo|privateAudio|PRIVATE|SECRET|987654321/);
    assert.equal(load().summarizeWebRTCContractSdp('x'.repeat(65537)).invalid, true);
    assert.equal(load().summarizeWebRTCContractSdp('v=0\r\n').invalid, true);
});

test('accepted final RTP and serialized SRTP-visible headers have no mismatches', () => {
    const f = fixture(); f.send();
    const snap = f.snap();
    assert.equal(snap.video.counters.checkedRtp, 1);
    assert.equal(snap.video.counters.udpHeaderChecks, 1);
    assert.equal(snap.video.counters.sframeStarts, 1);
    assert.equal(snap.video.counters.sframeEnds, 1);
    assert.equal(snap.video.counters.ridMismatch, 0);
    assert.deepEqual(snap.video.udpMismatches, {});
    assert.doesNotMatch(JSON.stringify(snap), /privateVideo|privateAudio|DO-NOT|92837465|987654321|1122334455|PRIVATE-CNAME/);
});

test('actual wrong RID and missing MID are reported before and after serialization', () => {
    const f = fixture();
    f.header.extensions = [{ id: 3, payload: Buffer.from('wrong') }]; f.send();
    assert.ok(f.snap().video.counters.ridMismatch > 0);
    assert.ok(f.snap().video.udpMismatches.ridMismatch > 0);
    assert.equal(f.snap().video.counters.missingMid, 1);
    assert.equal(f.snap().video.udpMismatches.missingMid, 1);
});

test('declined extensions, invalid directions and paused RIDs remain observable without modifying media', () => {
    for (const [answer, field] of [[sdp({ ext: false }), 'unnegotiatedExtension'],
        [sdp({ extDirection: '/sendonly' }), 'extensionDirectionMismatch'],
        [sdp({ paused: true }), 'ridPaused'], [sdp({ direction: 'sendonly' }), 'directionMismatch'],
        [sdp({ port: 0 }), 'rejectedMedia'], [sdp({ rid: '' }), 'ridWithoutReceiveDeclaration']]) {
        const f = fixture(answer), before = new f.RtpPacket(f.header, f.payload).serialize(); f.send();
        assert.ok(f.snap().video.counters[field] > 0, field);
        assert.deepEqual(new f.RtpPacket(f.header, f.payload).serialize(), before, 'observation must not mutate packet');
    }
});

test('payload remapping and SSRC changes are compared against both sender and offer', () => {
    const f = fixture(); f.header.payloadType = 98; f.header.ssrc = 42; f.send();
    for (const field of ['payloadTypeMismatch', 'ssrcMismatch', 'ssrcNotInLocalSdp', 'ridPayloadMismatch']) {
        assert.equal(f.snap().video.counters[field], 1, field);
        assert.equal(f.snap().video.udpMismatches[field], 1, field);
    }
});

test('UDP packets without extensions still check negotiated PT and expected RID', () => {
    const f = fixture(); f.header.extensions = []; f.header.extension = false; f.header.payloadType = 97;
    f.observer.observeUdp('video', new f.RtpPacket(f.header, f.payload).serialize());
    assert.equal(f.snap().video.udpMismatches.payloadTypeMismatch, 1);
    assert.equal(f.snap().video.udpMismatches.missingRid, 1);
});

test('two-byte extension headers and CSRC offsets are parsed without touching encrypted payload', () => {
    const f = fixture(sdp().replace('extmap:3 ', 'extmap:30 '));
    const packet = Buffer.alloc(12 + 4 + 4 + 20 + 16, 0);
    packet[0] = 0x91; packet[1] = 99; packet.writeUInt32BE(987654321, 8);
    packet.writeUInt16BE(0x1000, 16); packet.writeUInt16BE(5, 18);
    packet.set([30, 1, 49, 4, 12], 20); packet.write('privateVideo', 25);
    f.observer.observeUdp('video', packet);
    assert.deepEqual(f.snap().video.udpMismatches, {});
    assert.equal(f.snap().video.counters.malformedHeader, 0);
});

test('malformed packet lengths are bounded and do not throw', () => {
    const f = fixture();
    for (const p of [Buffer.alloc(0), Buffer.from([0x9f, 99, ...Buffer.alloc(10)]),
        Buffer.from([0x90, 99, ...Buffer.alloc(10), 0xbe, 0xde, 255, 255])]) f.observer.observeUdp('video', p);
    assert.equal(f.snap().video.counters.malformedHeader, 3);
});

test('SFrame descriptor diagnostics distinguish raw, packetized, bad reserved bits and incomplete marker', () => {
    const f = fixture();
    for (const b of [0x80, 0x40, 0xe0, 0xc1]) f.observer.observeRtp('video', Buffer.from([b, 0]), f.header);
    const s = f.snap().video.counters;
    assert.equal(s.sframeRawPackets, 2); assert.equal(s.sframePacketizedPackets, 1);
    assert.equal(s.sframeStarts, 2); assert.equal(s.sframeEnds, 2);
    assert.equal(s.sframeMarkerMismatch, 1); assert.equal(s.malformedSFrameDescriptor, 1);
});

test('burst counters measure fixed buckets per media kind with detached snapshots', () => {
    let t = 1;
    const f = fixture(undefined, { now: () => t });
    const p = Buffer.alloc(100); p[0] = 0x80; p[1] = 99; p.writeUInt32BE(987654321, 8);
    for (const time of [1, 2, 12, 102, 1002]) { t = time; f.observer.observeUdp('video', p); }
    const s = f.snap().video.counters;
    assert.equal(s.maxBytesPer10ms, 200); assert.equal(s.maxBytesPer100ms, 300); assert.equal(s.maxBytesPer1s, 400);
    const returned = f.observer.snapshot(); returned.video.counters.maxBytesPer10ms = 999;
    assert.equal(f.snap().video.counters.maxBytesPer10ms, 200);
    assert.equal(f.snap().audio.counters.maxBytesPer10ms, 0);
});

test('reoffers update the observed contract and preserve cumulative session counters', () => {
    const f = fixture(); f.send();
    f.observer.setRemote(sdp({ sframe: false, paused: true }), 'offer'); f.send();
    assert.equal(f.snap().revision, 2); assert.equal(f.snap().remoteDescriptionType, 'offer');
    assert.equal(f.snap().video.accepted.sframe, 'hap-only');
    assert.equal(f.snap().video.counters.checkedRtp, 2); assert.equal(f.snap().video.counters.ridPaused, 1);
});

test('observer failures cannot block the existing wire send path', async () => {
    const env = environment(), calls = [];
    const udp = { type: 'udp', socket: { send(data, port, host, cb) { calls.push(data); cb(); } }, send() {}, onData() {} };
    const dtls = { iceTransport: { connection: { protocols: [{ transport: udp }] } }, async sendRtp(payload) { return payload.length; } };
    const session = { pc: { dtlsTransports: [dtls] }, contract: { observeRtp() { throw Error('test'); }, observeUdp() { throw Error('test'); } },
        videoTransceiver: { sender: { ssrc: 123 } } };
    const wire = env.load(base + 'hksv-webrtc-wire-diagnostics.ts').observeWebRTCWire(session);
    try {
        const p = Buffer.alloc(12); p[0] = 0x80; p[1] = 99; p.writeUInt32BE(123, 8);
        assert.equal(await dtls.sendRtp(p, { payloadType: 99 }), 12);
        await udp.send(p, ['127.0.0.1', 1]);
        assert.equal(calls[0], p); assert.equal(wire.snapshot().video.sendCompletions, 1);
    } finally { wire.dispose(); }
});

test('unexpected payload types are audited by sender SSRC without changing their original send path', async () => {
    const env = environment(), observed = [];
    const originalResult = Promise.resolve('unchanged');
    const udp = { type: 'udp', socket: { send() { throw Error('Original path must remain in use'); } },
        send() { return originalResult; }, onData() {} };
    const dtls = { iceTransport: { connection: { protocols: [{ transport: udp }] } }, async sendRtp() { return 12; } };
    const session = { pc: { dtlsTransports: [dtls] },
        contract: { observeRtp(kind) { observed.push('rtp-' + kind); }, observeUdp(kind) { observed.push('udp-' + kind); } },
        videoTransceiver: { sender: { ssrc: 123 } }, audioTransceiver: { sender: { ssrc: 456 } } };
    const wire = env.load(base + 'hksv-webrtc-wire-diagnostics.ts').observeWebRTCWire(session);
    try {
        const p = Buffer.alloc(12); p[0] = 0x80; p[1] = 96; p.writeUInt32BE(123, 8);
        await dtls.sendRtp(p, { payloadType: 96, ssrc: 123 });
        assert.equal(udp.send(p, ['127.0.0.1', 1]), originalResult);
        p[1] = 200; udp.send(p, ['127.0.0.1', 1]);
        assert.deepEqual(observed, ['rtp-video', 'udp-video'], 'RTCP must not enter the RTP observer');
    } finally { wire.dispose(); }
});

for (const explicitSframe of [true, false]) test(`real ICE/DTLS/SRTP with Apple's saved RID-only selection, SDP SFrame=${explicitSframe}`,
    { timeout: 15000 }, async () => {
    const env = environment();
    env.mock('os', { ...require('node:os'), networkInterfaces: () => ({}) });
    const id = '../../external/werift/packages/webrtc/src/index.ts', werift = env.load(id);
    class LocalPeer extends werift.RTCPeerConnection {
        constructor(config) { super({ ...config, iceServers: [], iceUseIpv6: false, iceAdditionalHostAddresses: ['127.0.0.1'] }); }
        addTransceiver(...args) {
            const t = super.addTransceiver(...args); t.dtlsTransport.iceTransport.connection.stunServer = undefined; return t;
        }
    }
    env.mock(id, { ...werift, RTCPeerConnection: LocalPeer });
    const camera = env.load(base + 'camera-webrtc.ts'), proto = env.load(base + 'hksv-webrtc-protocol.ts');
    const management = new camera.WebRTCStreamManagement({ addService() {} }, { log() {}, warn() {}, error() {} }, {
        sensorUuid: Buffer.alloc(16), supportedVideoTiersValue: '', supportedAudioTiersValue: '',
        videoTiers: [{ identifier: 1, width: 320, height: 180, frameRate: 15, averageBitrateKbps: 180 }],
        getMedia: async () => { throw Error('This negotiation test must not access a camera'); } });
    management.startMedia = async () => {};
    let remote;
    const until = async condition => {
        const deadline = Date.now() + 7000;
        while (!condition()) { if (Date.now() > deadline) throw Error('Local WebRTC timed out'); await new Promise(r => setTimeout(r, 10)); }
    };
    try {
        const offer = proto.parseWebRTCSolicitOfferResponse(Buffer.from(await management.handleSolicitOffer(''), 'base64'));
        assert.equal(offer.status, 0);
        const session = management.sessions.get(offer.sessionId.toString('hex'));
        remote = new LocalPeer({ codecs: session.pc.config.codecs,
            headerExtensions: { video: [werift.useSdesRTPStreamId()], audio: [] } });
        const received = [], route = remote.router.routeRtp;
        remote.router.routeRtp = p => { received.push(p); route(p); };
        await remote.setRemoteDescription({ type: 'offer', sdp: offer.sdpOffer });
        await remote.setLocalDescription(await remote.createAnswer());
        // The bundled test peer's RID parser does not understand restrictions
        // in the camera offer. Supply Apple's observed answer declarations
        // explicitly while retaining this peer's real ICE/DTLS credentials.
        const appleShape = remote.localDescription.sdp.split(/(?=^m=)/m).map(section => {
            if (!section.startsWith('m=video ')) return section;
            return section.replace(/^a=(?:rid|simulcast):[^\r\n]*\r?\n/gm, '')
                + 'a=rid:1 recv\r\na=simulcast:recv 1\r\n';
        }).join('');
        const answer = camera.withSFramePacketization(appleShape, explicitSframe);
        const response = await management.handleProvideAnswer(proto.encodeWebRTCProvideAnswer({
            sessionId: offer.sessionId, sdpAnswer: answer, additionalCandidates: [] }));
        assert.equal(proto.parseWebRTCSessionStatusResponse(response).status, 0);
        await until(() => session.pc.connectionState === 'connected' && remote.connectionState === 'connected');
        const { RtpPacket, RtpHeader } = env.load('../../external/werift/packages/rtp/src/index.ts');
        const payload = Buffer.from([0xc0, 1, 2, 3, 4, 5]);
        await session.videoTransceiver.sender.sendRtp(new RtpPacket(new RtpHeader({
            sequenceNumber: 10, timestamp: 90000, payloadType: 99, ssrc: 100, marker: true }), payload));
        await until(() => received.length && session.wire.snapshot().video.sendCompletions);
        assert.deepEqual(Buffer.from(received[0].payload), payload);
        const result = JSON.parse(JSON.stringify(session.contract.snapshot()));
        assert.equal(result.video.accepted.sframe, explicitSframe ? 'explicit' : 'hap-only');
        assert.deepEqual(result.video.accepted.extensions.map(e => e.name), ['rid']);
        assert.equal(result.video.counters.checkedRtp, 1);
        assert.equal(result.video.counters.ridMismatch, 0);
        assert.equal(result.video.counters.ssrcNotInLocalSdp, 0);
        assert.equal(result.video.counters.ssrcMismatch, 0);
        assert.deepEqual(result.video.udpMismatches, {});
        const ridId = result.video.accepted.extensions[0].id;
        assert.equal(received[0].header.extensions.find(e => e.id === ridId)?.payload.toString(), '1');
        assert.equal(result.video.counters.sframeStarts, 1);
    } finally { management.closeAllSessions(); await remote?.close(); }
});
