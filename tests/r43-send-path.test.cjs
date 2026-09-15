// r43 removes per-packet work from the send path without changing what is sent.
// Each test pins the work that was removed, so a later release cannot put it back
// unnoticed, and pins the observable behaviour that must not have moved with it.
const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { environment, base } = require('./helpers.cjs');

const env = environment();
const { RtpPacket, RtpHeader } = env.load('../../external/werift/packages/rtp/src/index.ts');
const { HevcAccessUnitAssembler, SFrameRtpSender } = env.load(base + 'hksv-sframe.ts');
const { FRAME_MARKING_URI: uri, createFrameMarkingProbe } = env.load(base + 'hksv-frame-marking.ts');
const { createHksvRtpPacer } = env.load(base + 'hksv-rtp-pacer.ts');
const { RtspServer } = env.load('../../common/src/rtsp-server.ts');

const packet = (payload, sequenceNumber = 0, timestamp = 1, marker = true) =>
    new RtpPacket(new RtpHeader({ sequenceNumber, timestamp, marker, ssrc: 44, payloadType: 99 }), payload);
const hevcFrame = (...types) => Buffer.concat(types.map(type => Buffer.from([0, 0, 0, 3, type << 1, 1, 0x80])));

// --- hksv-sframe.ts -------------------------------------------------------

test('r43 assembles an access unit that does not alias the packets it came from', () => {
    const assembler = new HevcAccessUnitAssembler();
    // One NAL sent whole, and one sent as three fragmentation units.
    const single = Buffer.from([38, 1, 0x11, 0x22]);
    const fragments = [Buffer.from([98, 1, 128 | 19, 0xaa, 0xbb]), Buffer.from([98, 1, 19, 0xcc]), Buffer.from([98, 1, 64 | 19, 0xdd])];
    const payloads = [single, ...fragments];
    let frame;
    payloads.forEach((payload, i) => {
        frame = assembler.push(packet(payload, i, 7, i === payloads.length - 1)) ?? frame;
    });
    const expected = Buffer.concat([
        Buffer.from([0, 0, 0, 4]), single,
        Buffer.from([0, 0, 0, 6]), Buffer.from([38, 1, 0xaa, 0xbb, 0xcc, 0xdd]),
    ]);
    assert.deepEqual(frame, expected);
    // The assembler owns every byte it returns: the caller's buffers may be reused.
    for (const payload of payloads) payload.fill(0xee);
    assert.deepEqual(frame, expected);
});

test('r43 slices one ciphertext into packets that own their payloads', () => {
    const sender = new SFrameRtpSender(Buffer.alloc(32, 9), 5n, 0x11223344, true, 64);
    try {
        const nal = Buffer.alloc(200, 0x5a); nal[0] = 38; nal[1] = 1;
        const packets = sender.push(packet(nal, 0, 9));
        assert(packets.length > 2, 'a 200 byte NAL does not fit one 64 byte slice');
        const copies = packets.map(p => Buffer.from(p.payload));
        for (let i = 0; i < packets.length; i++) {
            assert.equal(packets[i].payload[0], (i === 0 ? 128 : 0) | (i === packets.length - 1 ? 64 : 0));
            assert(packets[i].payload.length <= 65, 'a slice carries the descriptor byte and at most one slice of ciphertext');
        }
        // No two packets share storage, so one may be modified or padded in place.
        packets[0].payload.fill(0);
        for (let i = 1; i < packets.length; i++) assert.deepEqual(packets[i].payload, copies[i]);
    } finally { sender.close(); }
});

// A deterministic mix of single NALs, aggregation packets and fragmentation units,
// through every sender shape, hashed. r42 produced this digest; r43 must too, and so
// must every release after it. This is the whole point: the wire bytes do not change.
test('r43 puts the same bytes on the wire as r42', () => {
    const hash = require('node:crypto').createHash('sha256');
    const key = Buffer.alloc(32, 0x3b), kid = 0x0102030405060708n, ssrc = 0x0badf00d;
    const inputs = () => {
        const out = [];
        let sequence = 0, timestamp = 0;
        const add = (payload, marker) => out.push(new RtpPacket(new RtpHeader(
            { payloadType: 99, sequenceNumber: sequence++ & 65535, timestamp, ssrc: 3, marker }), payload));
        for (let frame = 0; frame < 24; frame++) {
            timestamp += 3000;
            const vps = Buffer.concat([Buffer.from([64, 1]), Buffer.alloc(20, frame)]);
            const sps = Buffer.concat([Buffer.from([66, 1]), Buffer.alloc(30, frame + 1)]);
            add(Buffer.concat([Buffer.from([96, 1, 0, vps.length]), vps, Buffer.from([0, sps.length]), sps]), false);
            add(Buffer.concat([Buffer.from([68, 1]), Buffer.alloc(12, frame + 2)]), false);
            const slice = Buffer.alloc(400 + frame * 37, frame + 3);
            for (let offset = 0, i = 0; offset < slice.length; offset += 300, i++) {
                const end = offset + 300 >= slice.length;
                add(Buffer.concat([Buffer.from([98, 1, (i === 0 ? 128 : 0) | (end ? 64 : 0) | 19]),
                    slice.subarray(offset, offset + 300)]), end);
            }
        }
        return out;
    };
    const assembler = new HevcAccessUnitAssembler();
    for (const input of inputs()) { const frame = assembler.push(input); if (frame) hash.update(frame); }
    for (const video of [true, false]) for (const maxSlice of [64, 1100]) {
        const sender = new SFrameRtpSender(key, kid, ssrc, video, maxSlice);
        // The real starting sequence number is random per session.
        sender.sequence = 4242;
        try { for (const input of inputs()) for (const out of sender.push(input)) hash.update(out.serialize()); }
        finally { sender.close(); }
    }
    assert.equal(hash.digest('hex'), 'e5504b803cb8f5d10e6f3bc94a1fb4af441eb64289d15e0f57710c6e3497ee14');
});

// --- hksv-frame-marking.ts ------------------------------------------------

function markingSession(sdp) {
    const state = { reads: 0, sdp };
    const session = {
        pc: { get remoteDescription() { state.reads++; return { type: 'answer', sdp: state.sdp }; } },
        videoTransceiver: { sender: { headerExtensions: [{ id: 4, uri }] } },
    };
    return { state, session };
}

const negotiated = `v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 99\r\na=recvonly\r\na=extmap:4 ${uri}\r\n`;

test('r43 reads the remote description once per access unit, not once per packet', () => {
    const { state, session } = markingSession(negotiated);
    const marking = createFrameMarkingProbe(session);
    marking.observeFrame(hevcFrame(19), { timestamp: 90 });
    const after = state.reads;
    for (let i = 0; i < 64; i++)
        marking.decorate({ payload: Buffer.from([0xc0]), header: { timestamp: 90, extensions: [] } });
    assert.equal(state.reads, after, 'werift rebuilds the whole SDP for each read');
    const counts = marking.snapshot();
    assert.equal(counts.markedPackets, 64);
    assert.equal(counts.markedIndependentPackets, 64);
});

test('r43 still marks from the description in force for the frame being sent', () => {
    const { state, session } = markingSession(negotiated);
    const marking = createFrameMarkingProbe(session);
    marking.observeFrame(hevcFrame(19), { timestamp: 90 });
    const first = { payload: Buffer.from([0xc0]), header: { timestamp: 90, extensions: [] } };
    marking.decorate(first);
    assert.equal(first.header.extensions[0].payload[0], 0xe0);
    // A renegotiation that drops the extension takes effect with the next frame.
    state.sdp = 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 99\r\n';
    marking.observeFrame(hevcFrame(19), { timestamp: 96 });
    const next = { payload: Buffer.from([0xc0]), header: { timestamp: 96, extensions: [] } };
    marking.decorate(next);
    assert.equal(next.header.extensions.length, 0);
    assert.equal(marking.snapshot().negotiated, false);
});

test('r43 resolves the description for a packet that arrives before any frame', () => {
    const { state, session } = markingSession(negotiated);
    const marking = createFrameMarkingProbe(session);
    const orphan = { payload: Buffer.from([0xc0]), header: { timestamp: 90, extensions: [] } };
    marking.decorate(orphan);
    assert(state.reads > 0);
    assert.equal(orphan.header.extensions.length, 0);
    assert.equal(marking.snapshot().metadataMissingPackets, 1, 'negotiated, but no frame metadata to mark with');
});

// --- hksv-webrtc-probe.ts -------------------------------------------------

function probeFixture() {
    const fixtureEnv = environment();
    const rtp = fixtureEnv.load('../../external/werift/packages/rtp/src/index.ts');
    const { SrtpSession } = fixtureEnv.load('../../external/werift/packages/rtp/src/srtp/srtp.ts');
    const { SrtcpSession } = fixtureEnv.load('../../external/werift/packages/rtp/src/srtp/srtcp.ts');
    const sframe = fixtureEnv.load(base + 'hksv-sframe.ts');
    const session = { videoTransceiver: { sender: { ssrc: 0xfedcba98 } }, audioTransceiver: { sender: { ssrc: 0x76543210 } },
        sframeConfiguration: { key: Buffer.alloc(32, 0x17), kid: 0x0102030405060708n } };
    const config = { profile: 1, keys: { localMasterKey: Buffer.alloc(16, 0x25), localMasterSalt: Buffer.alloc(14, 0x26),
        remoteMasterKey: Buffer.alloc(16, 0x27), remoteMasterSalt: Buffer.alloc(14, 0x28) } };
    const dtls = { srtp: new SrtpSession(config), srtcp: new SrtcpSession(config), updateSrtpSession() { return 47; } };
    const probe = fixtureEnv.load(base + 'hksv-webrtc-probe.ts').createWebRTCMediaProbe(session, () => 1000);
    probe.installTransport(dtls);
    const sender = new sframe.SFrameRtpSender(session.sframeConfiguration.key, session.sframeConfiguration.kid,
        session.audioTransceiver.sender.ssrc, false, undefined, (f, h, e) => probe.sourceFrame('audio', f, h, e));
    let sequence = 0, timestamp = 0;
    const send = () => {
        timestamp += 960;
        const input = new rtp.RtpPacket(new rtp.RtpHeader({ payloadType: 110, sequenceNumber: sequence++ & 65535,
            timestamp, ssrc: 99, marker: true }), Buffer.from([0xf8, 0xff, 0xfe]));
        probe.observeInput('audio', input);
        let sent = 0;
        for (const out of sender.push(input)) {
            probe.observeRtp('audio', out.payload, out.header);
            probe.observeUdp('audio', dtls.srtp.encrypt(out.payload, out.header), dtls);
            sent++;
        }
        return sent;
    };
    return { probe, send, snapshot: () => JSON.parse(JSON.stringify(probe.snapshot())),
        close: () => { probe.dispose(); sender.close(); } };
}

test('r43 verifies a bounded startup budget and keeps the free counters for the session', () => {
    const f = probeFixture();
    try {
        const budget = f.snapshot().verifiedPacketsPerStream;
        assert.equal(budget, 4000, 'the budget is reported so a diagnostic JSON explains its own counters');
        let sent = 0;
        while (sent < budget + 250) sent += f.send();
        const s = f.snapshot().audio;
        // Header, sequence and timing observation covers every packet of the session.
        assert.equal(s.udpPackets, sent);
        assert.equal(s.rtpPackets, sent);
        // The sender starts at a random RTP sequence number, so compare the span.
        assert.equal((s.lastSequence - s.firstSequence + 65536) % 65536, (sent - 1) % 65536);
        assert.equal(s.sequenceDiscontinuities, 0);
        assert.equal(s.duplicateOrLatePackets, 0);
        // The independent decrypt and digests stop, and say how many they skipped.
        assert.equal(s.srtpVerified, budget);
        assert.equal(s.srtpVerifySkipped, sent - budget);
        assert.equal(s.srtpPayloadMatches, budget);
        assert.equal(s.srtpExpectedMissing, 0, 'every verified datagram still has its source digest');
        assert.equal(s.srtpAuthFailures, 0);
        assert.equal(s.srtpPayloadMismatches, 0);
        assert.equal(s.srtpParseFailures, 0);
        // Sampling inside the budget is unchanged: the first twelve frames.
        assert.equal(s.sframeVerified, 12);
        assert.equal(s.sframeSourceMatches, 12);
        assert.equal(s.sframeAuthFailures, 0);
        assert.equal(s.sframeSourceMismatches, 0);
        assert.equal(s.sframeIncomplete, 0);
        assert.equal(s.sourceFrames, sent, 'the encoder side is counted for the whole session');
        assert.equal(f.snapshot().rtcp.observationErrors, 0);
    } finally { f.close(); }
});

// --- hksv-rtp-pacer.ts ----------------------------------------------------

test('r43 paces a burst on the default monotonic clock', async () => {
    const sent = [], total = 128;
    const pacer = createHksvRtpPacer(p => sent.push(p), e => assert.fail(e.message));
    try {
        for (let i = 0; i < total; i++) pacer.enqueue({ payload: Buffer.alloc(1100) });
        assert(sent.length > 0 && sent.length < total, 'the burst credit bounds what leaves immediately');
        // A clock that did not advance in real time would leave the rest queued.
        const deadline = Date.now() + 5000;
        while (sent.length < total && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(sent.length, total, 'the rest drains as credit accrues');
    } finally { pacer.close(); }
});

// --- rtsp-server.ts -------------------------------------------------------

async function record(server, count) {
    const out = [];
    for await (const sample of server.handleRecord()) {
        out.push(sample);
        if (out.length === count) break;
    }
    return out;
}

function interleaved(channel, payload) {
    const header = Buffer.alloc(4);
    header.writeUInt8(36, 0); header.writeUInt8(channel, 1); header.writeUInt16BE(payload.length, 2);
    return Buffer.concat([header, payload]);
}

test('r43 routes an interleaved channel to its track without walking the track list', async () => {
    const client = new PassThrough();
    const server = new RtspServer(client);
    server.setupInterleaved({ control: 'video', codec: 'h265' }, 0, 1);
    server.setupInterleaved({ control: 'audio', codec: 'opus' }, 2, 3);
    for (const [channel, byte] of [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5]])
        client.write(interleaved(channel, Buffer.from([byte])));
    const samples = await record(server, 5);
    assert.deepEqual(samples.map(s => s.type), ['h265', 'h265', 'opus', 'opus', 'h265']);
    assert.deepEqual(samples.map(s => s.rtcp), [false, true, false, true, false]);
    assert.deepEqual(samples.map(s => s.packet[0]), [1, 2, 3, 4, 5]);
});

test('r43 finds a track set up after packets have already been read', async () => {
    const client = new PassThrough();
    const server = new RtspServer(client);
    server.setupInterleaved({ control: 'video', codec: 'h265' }, 0, 1);
    client.write(interleaved(0, Buffer.from([1])));
    assert.deepEqual((await record(server, 1)).map(s => s.type), ['h265']);
    server.setupInterleaved({ control: 'audio', codec: 'opus' }, 2, 3);
    client.write(interleaved(2, Buffer.from([2])));
    assert.deepEqual((await record(server, 1)).map(s => s.type), ['opus']);
});

test('r43 still rejects an interleaved channel with no track', async () => {
    const client = new PassThrough();
    const server = new RtspServer(client);
    server.setupInterleaved({ control: 'video', codec: 'h265' }, 0, 1);
    client.write(interleaved(8, Buffer.from([1])));
    await assert.rejects(record(server, 1), /unknown channel/i);
});
