const test = require('node:test');
const assert = require('node:assert/strict');
const { environment, base } = require('./helpers.cjs');
const env = environment();
const { FRAME_MARKING_URI: uri, independentHevcFrame, createFrameMarkingProbe } = env.load(base + 'hksv-frame-marking.ts');
const { SFrameRtpSender } = env.load(base + 'hksv-sframe.ts');
const { RtpHeader, RtpPacket } = env.load('../../external/werift/packages/rtp/src/index.ts');
const { Receiver } = require('./sframe-receiver.cjs');
const frame = (...types) => Buffer.concat(types.map(type => Buffer.from([0, 0, 0, 3, type << 1, 1, 0x80])));
const state = (extra = '', direction = '') => ({
    pc: { remoteDescription: { type: 'answer', sdp: `v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 99\r\na=recvonly\r\na=extmap:4${direction} ${uri}\r\n${extra}` } },
    videoTransceiver: { sender: { headerExtensions: [{ id: 4, uri }] } },
});

test('r36 derives independence from HEVC VCL and rejects unsupported layouts', () => {
    assert.equal(independentHevcFrame(frame(32, 33, 34, 19)), true);
    assert.equal(independentHevcFrame(frame(32, 33, 34, 21)), true);
    assert.equal(independentHevcFrame(frame(1)), false);
    assert.equal(independentHevcFrame(frame(19, 1)), false);
    for (const f of [frame(32, 33, 34), Buffer.alloc(0), frame(19).subarray(0, 6), Buffer.from([0, 0, 0, 255, 38, 1]), frame(49)])
        assert.equal(independentHevcFrame(f), undefined);
    const temporal = frame(19); temporal[5] = 2;
    const spatial = frame(19); spatial[5] = 9;
    assert.equal(independentHevcFrame(temporal), undefined);
    assert.equal(independentHevcFrame(spatial), undefined);
});

test('r36 requires accepted receive direction and an actual negotiated sender extension', () => {
    for (const direction of ['', '/recvonly', '/sendrecv']) assert.equal(createFrameMarkingProbe(state('', direction)).snapshot().negotiated, true);
    for (const direction of ['/sendonly', '/inactive']) assert.equal(createFrameMarkingProbe(state('', direction)).snapshot().negotiated, false);
    for (const alter of [s => s.videoTransceiver.sender.headerExtensions = [], s => s.pc.remoteDescription.sdp = 'v=0\r\n',
        s => s.pc.remoteDescription.sdp = s.pc.remoteDescription.sdp.replace('video 9', 'video 0'),
        s => s.pc.remoteDescription.sdp = s.pc.remoteDescription.sdp.replace('a=recvonly', 'a=inactive'),
        s => s.pc.remoteDescription.sdp = s.pc.remoteDescription.sdp.replace('extmap:4', 'extmap:5')]) {
        const s = state(); alter(s); assert.equal(createFrameMarkingProbe(s).snapshot().negotiated, false);
    }
});

test('r36 marks complete encrypted fragments without changing SFrame plaintext or RID', () => {
    const s = state(), marking = createFrameMarkingProbe(s), key = Buffer.alloc(32, 7), kid = 291n, ssrc = 0x12345678;
    const sender = new SFrameRtpSender(key, kid, ssrc, true, 64, (frame, header) => marking.observeFrame(frame, header));
    const receiver = new Receiver({ key, kid });
    try {
        const nal = Buffer.alloc(250, 0x55); nal[0] = 38; nal[1] = 1;
        const packets = sender.push(new RtpPacket(new RtpHeader({ timestamp: 90, marker: true, payloadType: 99 }), nal));
        assert(packets.length > 2); let plain;
        for (let i = 0; i < packets.length; i++) {
            const p = packets[i], payload = Buffer.from(p.payload);
            p.header.extensions.push({ id: 3, payload: Buffer.from('1') });
            marking.decorate(p);
            assert.deepEqual(p.payload, payload);
            assert.equal(p.header.extensions.find(e => e.id === 3).payload.toString(), '1');
            assert.equal(p.header.extensions.find(e => e.id === 4).payload[0], 0x20 | (i === 0 ? 0x80 : 0) | (i === packets.length - 1 ? 0x40 : 0));
            const decoded = RtpPacket.deSerialize(p.serialize());
            assert.equal(decoded.header.extensions.find(e => e.id === 4).payload.length, 1);
            plain = receiver.push(decoded) || plain;
        }
        assert.deepEqual(plain.subarray(4), nal);
        assert.equal(marking.snapshot().markedStarts, 1); assert.equal(marking.snapshot().markedEnds, 1);
        // A reoffer can remove the extension; no stale ID may survive.
        s.pc.remoteDescription.sdp = 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 99\r\n';
        const next = sender.push(new RtpPacket(new RtpHeader({ timestamp: 180, marker: true, sequenceNumber: 1, payloadType: 99 }), Buffer.from([2, 1, 0x80])))[0];
        marking.decorate(next); assert.equal(next.header.extensions.length, 0);
        assert.equal(marking.snapshot().negotiated, false);
    } finally { sender.close(); }
});

test('r36 does not mark stale metadata or unnegotiated video', () => {
    const s = state(), p = createFrameMarkingProbe(s);
    p.observeFrame(frame(19), { timestamp: 100 });
    const packet = { payload: Buffer.from([0xc0]), header: { timestamp: 101, extensions: [] } };
    p.decorate(packet); assert.equal(packet.header.extensions.length, 0);
    assert.equal(p.snapshot().metadataMissingPackets, 1);
});

test('r36 offer uses real werift extension IDs without disturbing bundled MID/RID', async () => {
    const { RTCPeerConnection, useSdesMid, useSdesRTPStreamId } = env.load('../../external/werift/packages/webrtc/src/index.ts');
    const { alignBundledMidExtension } = env.load(base + 'camera-webrtc.ts');
    const pc = new RTCPeerConnection({ iceUseIpv4: false, iceUseIpv6: false,
        headerExtensions: { video: [useSdesMid(), useSdesRTPStreamId(), { uri }], audio: [useSdesMid()] } });
    try {
        alignBundledMidExtension(pc);
        pc.addTransceiver('video', { direction: 'sendonly' }); pc.addTransceiver('audio', { direction: 'sendonly' });
        const offer = await pc.createOffer(), video = offer.sdp.split('m=video')[1].split('m=audio')[0];
        assert.match(video, /a=extmap:3 urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id/);
        assert.match(video, /a=extmap:4 urn:ietf:params:rtp-hdrext:framemarking/);
        assert.equal((offer.sdp.match(/a=extmap:2 urn:ietf:params:rtp-hdrext:sdes:mid/g) || []).length, 2);
    } finally { await pc.close(); }
});
