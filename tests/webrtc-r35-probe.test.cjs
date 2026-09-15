const test = require('node:test');
const assert = require('node:assert/strict');
const { environment, base } = require('./helpers.cjs');

function fixture(profile = 1, options = {}) {
    const env = environment({ mediaManager: options.mediaManager });
    if (options.spawn) env.mock('child_process', { spawn: options.spawn });
    const rtp = env.load('../../external/werift/packages/rtp/src/index.ts');
    const { SrtpSession } = env.load('../../external/werift/packages/rtp/src/srtp/srtp.ts');
    const { SrtcpSession } = env.load('../../external/werift/packages/rtp/src/srtp/srtcp.ts');
    const { SFrameRtpSender } = env.load(base + 'hksv-sframe.ts');
    let time = 1000;
    const session = { videoTransceiver: { sender: { ssrc: 0xfedcba98 } }, audioTransceiver: { sender: { ssrc: 0x76543210 } },
        sframeConfiguration: { key: Buffer.alloc(32, 0x17), kid: 0x0102030405060708n } };
    const config = { profile, keys: { localMasterKey: Buffer.alloc(16, 0x25), localMasterSalt: Buffer.alloc(profile === 7 ? 12 : 14, 0x26),
        remoteMasterKey: Buffer.alloc(16, 0x27), remoteMasterSalt: Buffer.alloc(profile === 7 ? 12 : 14, 0x28) } };
    const dtls = { srtp: new SrtpSession(config), srtcp: new SrtcpSession(config), updateSrtpSession() { return 47; } };
    const peer = new SrtcpSession({ profile, keys: { ...config.keys, localMasterKey: config.keys.remoteMasterKey, localMasterSalt: config.keys.remoteMasterSalt } });
    const probe = env.load(base + 'hksv-webrtc-probe.ts').createWebRTCMediaProbe(session, () => time);
    probe.installTransport(dtls);
    const senders = {};
    for (const kind of ['video', 'audio']) {
        senders[kind] = new SFrameRtpSender(session.sframeConfiguration.key, session.sframeConfiguration.kid,
            session[kind + 'Transceiver'].sender.ssrc, kind === 'video', 64, (f, h, e) => probe.sourceFrame(kind, f, h, e));
    }
    let inputSeq = 0, timestamp = 0;
    function packets(kind = 'video') {
        timestamp += kind === 'video' ? 6000 : 960;
        const nals = kind === 'video' ? [32, 33, 34, 19].map(type => Buffer.concat([Buffer.from([type << 1, 1]), Buffer.alloc(60, type)])) : [Buffer.from([0xf8, 0xff, 0xfe])];
        return nals.flatMap((payload, i) => { const p = new rtp.RtpPacket(new rtp.RtpHeader({
            payloadType: kind === 'video' ? 99 : 110, sequenceNumber: inputSeq++ & 65535, timestamp, ssrc: 99,
            marker: i === nals.length - 1 }), payload); probe.observeInput(kind, p); return senders[kind].push(p); });
    }
    function emit(p, kind = 'video', mutate) {
        probe.observeRtp(kind, p.payload, p.header);
        const data = dtls.srtp.encrypt(p.payload, p.header);
        mutate?.(data);
        probe.observeUdp(kind, data, dtls);
        return data;
    }
    const report = ssrc => new rtp.RtcpReceiverInfo({ ssrc, fractionLost: 4, packetsLost: 0xfffffe, highestSequence: 0, jitter: 13, lsr: 12, dlsr: 20 });
    const senderInfo = () => new rtp.RtcpSenderInfo({ ntpTimestamp: 1n << 32n, rtpTimestamp: 6000, packetCount: 100, octetCount: 9000 });
    const receive = (...ps) => dtls.srtcp.decrypt(peer.encrypt(Buffer.concat(ps.map(p => p.serialize()))));
    const snapshot = () => JSON.parse(JSON.stringify(probe.snapshot()));
    const close = () => { probe.dispose(); Object.values(senders).forEach(s => s.close()); };
    return { env, rtp, session, dtls, peer, probe, packets, emit, report, senderInfo, receive, snapshot, close,
        senders, advance: n => time += n, config };
}

for (const profile of [1, 7]) test('independent SRTP verifier and SFrame receiver recover video/audio under profile ' + profile, () => {
    const f = fixture(profile);
    try {
        for (const kind of ['video', 'audio']) {
            const packets = f.packets(kind); for (const p of packets) f.emit(p, kind);
            const s = f.snapshot()[kind];
            assert.equal(s.srtpVerified, packets.length); assert.equal(s.srtpAuthFailures, 0);
            assert.equal(s.srtpPayloadMatches, packets.length); assert.equal(s.sframeVerified, 1);
            assert.equal(s.sframeSourceMatches, 1); assert.equal(s.sframeAuthFailures, 0);
            assert.equal(s.sourceFrames, 1);
        }
        const video = f.snapshot().video;
        for (const key of ['sourceIrapFrames', 'sourceVpsFrames', 'sourceSpsFrames', 'sourcePpsFrames']) assert.equal(video[key], 1);
        assert.equal(video.sourceInvalidNalFrames, 0); assert.equal(f.snapshot().rtcp.observationErrors, 0);
    } finally { f.close(); }
});

test('ciphertext or SRTP tag corruption is classified before SFrame processing', () => {
    const f = fixture();
    try {
        f.emit(f.packets('audio')[0], 'audio', data => data[data.length - 1] ^= 1);
        assert.equal(f.snapshot().audio.srtpAuthFailures, 1);
        assert.equal(f.snapshot().audio.sframeSampled, 0);
    } finally { f.close(); }
});

test('valid SRTP wrapping a corrupt SFrame tag isolates inner authentication failure', () => {
    const f = fixture();
    try {
        const packets = f.packets(); packets.at(-1).payload[packets.at(-1).payload.length - 1] ^= 1;
        for (const p of packets) f.emit(p);
        const s = f.snapshot(); assert.equal(s.video.srtpAuthFailures, 0); assert.equal(s.video.sframeAuthFailures, 1);
        assert.equal(s.evidence, 'local-sframe-check-failed');
    } finally { f.close(); }
});

test('mismatched encryption key and key ID have distinct counters', () => {
    for (const wrongId of [false, true]) {
        const f = fixture();
        try {
            const packets = f.packets();
            if (wrongId) f.session.sframeConfiguration.kid++;
            else f.session.sframeConfiguration.key = Buffer.alloc(32, 99);
            for (const p of packets) f.emit(p);
            assert.equal(f.snapshot().video[wrongId ? 'sframeKidMismatches' : 'sframeAuthFailures'], 1);
        } finally { f.close(); }
    }
});

test('valid ciphertext with a different source fingerprint is distinguished from authentication failure', () => {
    const f = fixture();
    try {
        const packets = f.packets(); f.probe.sourceFrame('video', Buffer.from([0, 0, 0, 2, 38, 1]), packets[0].header, Buffer.concat(packets.map(p => p.payload.subarray(1))));
        for (const p of packets) f.emit(p);
        assert.equal(f.snapshot().video.sframeVerified, 1); assert.equal(f.snapshot().video.sframeSourceMismatches, 1);
    } finally { f.close(); }
});

test('missing fragments fail assembly while SRTP authentication remains valid', () => {
    const f = fixture();
    try {
        const packets = f.packets(); assert(packets.length > 2);
        for (const [i, p] of packets.entries()) if (i !== 1) f.emit(p);
        const s = f.snapshot().video; assert.equal(s.srtpAuthFailures, 0); assert(s.sequenceDiscontinuities > 0);
        assert.equal(s.sframeVerified, 0); assert(s.sframeIncomplete > 0);
    } finally { f.close(); }
});

test('sequence rollover and duplicate retransmission do not create false crypto or counter faults', () => {
    const f = fixture();
    try {
        f.senders.video.sequence = 65534;
        const packets = f.packets(); for (const p of packets) f.emit(p);
        // Reuse ciphertext: do not ask the real sender to advance its ROC again.
        const p = f.packets()[0]; const data = f.emit(p); f.probe.observeUdp('video', data, f.dtls);
        const s = f.snapshot().video; assert.equal(s.srtpAuthFailures, 0); assert.equal(s.sequenceDiscontinuities, 0);
        assert.equal(s.duplicateOrLatePackets, 1); assert.equal(s.sframeCounterRegressions, 0);
    } finally { f.close(); }
});

for (const profile of [1, 7]) test('RTCP compound sender and receiver reports are all parsed before werift routing, profile ' + profile, () => {
    const f = fixture(profile);
    try {
        const p = f.packets('audio')[0]; f.emit(p, 'audio');
        const video = f.report(f.session.videoTransceiver.sender.ssrc), audio = f.report(f.session.audioTransceiver.sender.ssrc);
        audio.highestSequence = p.header.sequenceNumber;
        f.receive(new f.rtp.RtcpSrPacket({ ssrc: 7, senderInfo: f.senderInfo(), reports: [video, audio] }),
            new f.rtp.RtcpRrPacket({ ssrc: 8, reports: [video] }));
        const s = f.snapshot(); assert.equal(s.video.srBlocks, 1); assert.equal(s.video.rrBlocks, 1);
        assert.equal(s.audio.srBlocks, 1); assert.equal(s.audio.reportSequenceMatches, 1);
        assert.equal(s.video.lastReport.packetsLost, -2); assert.equal(s.video.lastReport.originSsrc, '00000008');
        assert.equal(s.rtcp.inboundAuthVerified, 1); assert.equal(s.rtcp.compoundPackets, 2);
        assert.equal(s.rtcp.inboundPlaintextMatches, 1); assert.equal(s.rtcp.inboundPlaintextMismatches, 0);
        assert.equal(s.rtcp.observationErrors, 0);
    } finally { f.close(); }
});

for (const profile of [1, 7]) test('RTCP authentication faults remain visible, profile ' + profile, () => {
    const f = fixture(profile);
    try {
        const data = f.peer.encrypt(new f.rtp.RtcpRrPacket({ ssrc: 7, reports: [f.report(88)] }).serialize());
        data[data.length - (profile === 7 ? 5 : 1)] ^= 1;
        try { f.dtls.srtcp.decrypt(data); } catch (_) { }
        assert.equal(f.snapshot().rtcp.inboundAuthFailures, 1);
    } finally { f.close(); }
});

test('unknown report targets and empty sender reports remain visible and bounded', () => {
    const f = fixture();
    try {
        for (let i = 0; i < 30; i++) f.receive(new f.rtp.RtcpRrPacket({ ssrc: 7, reports: [f.report(100 + i)] }));
        f.receive(new f.rtp.RtcpSrPacket({ ssrc: 7, senderInfo: f.senderInfo(), reports: [] }));
        const s = f.snapshot(); assert.equal(s.rtcp.unknownReportBlocks, 30); assert.equal(s.unknownReportSamples.length, 8);
        assert.equal(s.rtcp.emptyReportPackets, 1); assert.equal(s.video.reportBlocks, 0);
    } finally { f.close(); }
});

test('outgoing sender report counters expose actual video/audio RTP clock and packet counts', () => {
    const f = fixture();
    try {
        f.dtls.srtcp.encrypt(new f.rtp.RtcpSrPacket({ ssrc: f.session.videoTransceiver.sender.ssrc,
            senderInfo: f.senderInfo(), reports: [] }).serialize());
        const s = f.snapshot(); assert.equal(s.video.outgoingSr, 1); assert.equal(s.video.lastOutgoingSr.packetCount, 100);
        assert.equal(s.video.lastOutgoingSr.rtpTimestamp, 6000); assert.equal(s.rtcp.outgoingEncryptCompleted, 1);
    } finally { f.close(); }
});

test('malformed compound RTCP is counted without changing decryption output', () => {
    const f = fixture();
    try {
        const plaintext = Buffer.from([0x81, 201, 0, 1, 0, 0, 0, 7]); // Missing its advertised report block.
        const decoded = f.dtls.srtcp.decrypt(f.peer.encrypt(plaintext));
        assert.deepEqual(decoded, plaintext); assert.equal(f.snapshot().rtcp.malformed, 1);
    } finally { f.close(); }
});

test('diagnostics preserve originals, do not retain secrets and stop on dispose', () => {
    const f = fixture();
    try {
        assert.equal(f.dtls.updateSrtpSession(), 47);
        for (let i = 0; i < 25; i++) for (const p of f.packets('audio')) f.emit(p, 'audio');
        const s = f.snapshot(); assert.equal(s.audio.sframeSampled, 12);
        f.advance(5000); for (const p of f.packets('audio')) f.emit(p, 'audio');
        assert.equal(f.snapshot().audio.sframeSampled, 13);
        const encoded = JSON.stringify(f.snapshot());
        for (const key of [f.session.sframeConfiguration.key, ...Object.values(f.config.keys)]) {
            assert(!encoded.includes(key.toString('hex'))); assert(!encoded.includes(key.toString('base64')));
        }
        assert(encoded.length < 20000);
        const before = f.snapshot().audio.udpPackets; f.probe.dispose();
        f.probe.observeUdp('audio', Buffer.alloc(80), f.dtls); assert.equal(f.snapshot().audio.udpPackets, before);
        assert.equal(f.config.keys.localMasterKey[0], 0x25, 'disposing probe must not zero transport keys');
    } finally { f.close(); }
});

test('unsupported SRTP profiles are reported as unverified, never as successful verification', () => {
    const f = fixture();
    try {
        const p = f.packets('audio')[0]; const data = f.dtls.srtp.encrypt(p.payload, p.header);
        f.dtls.srtp.config = { profile: 123 };
        f.probe.observeUdp('audio', data, f.dtls);
        assert.equal(f.snapshot().audio.srtpUnsupported, 1); assert.equal(f.snapshot().audio.srtpVerified, 0);
    } finally { f.close(); }
});

test('observer exceptions cannot alter encryption or stop production media', () => {
    const f = fixture();
    try {
        const { SFrameRtpSender } = f.env.load(base + 'hksv-sframe.ts');
        const sender = new SFrameRtpSender(Buffer.alloc(32, 1), 1n, 2, false, undefined, () => { throw Error('observer failed'); });
        const p = new f.rtp.RtpPacket(new f.rtp.RtpHeader({ ssrc: 2 }), Buffer.from([0xf8, 0xff, 0xfe]));
        assert.equal(sender.push(p).length, 1); sender.close();
    } finally { f.close(); }
});

for (const decodedFrames of [0, 1]) test('decoder sample distinguishes a decoded frame from an empty successful process, frames=' + decodedFrames, async () => {
    const { EventEmitter } = require('node:events');
    let calls = 0, inputBytes = 0;
    const f = fixture(1, { mediaManager: { getFFmpegPath: async () => '/fixture/ffmpeg' }, spawn(file, args, opts) {
        calls++; assert.equal(file, '/fixture/ffmpeg'); assert(args.includes('pipe:0')); assert(args.includes('pipe:1'));
        assert.equal(opts.windowsHide, true); assert.equal(opts.shell, undefined);
        const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
        child.stdin = new EventEmitter(); child.kill = () => {};
        child.stdin.end = (input, callback) => { inputBytes = input.length; setImmediate(() => {
            child.stdout.emit('data', Buffer.from('frame=' + decodedFrames + '\nprogress=end\n'));
            child.stderr.emit('data', Buffer.from('private-output-DO-NOT-LOG'));
            callback(); child.emit('close', 0);
        }); };
        return child;
    } });
    try {
        for (let i = 0; i < 3; i++) for (const p of f.packets()) f.emit(p);
        await new Promise(resolve => setTimeout(resolve, 15));
        const s = f.snapshot(); assert.equal(calls, 1); assert(inputBytes > 0);
        assert.equal(s.decoder.status, decodedFrames ? 'decoded' : 'decode-failed');
        assert.equal(s.video.sframeSourceMatches, 3);
        assert(!JSON.stringify(s).includes('DO-NOT-LOG'));
    } finally { f.close(); }
});

test('RTP timestamp rewriting does not break source-to-ciphertext correlation', () => {
    const f = fixture();
    try {
        for (const p of f.packets()) { p.header.timestamp = (p.header.timestamp + 0xeeeeeeee) >>> 0; f.emit(p); }
        assert.equal(f.snapshot().video.sframeSourceMatches, 1);
        assert.equal(f.snapshot().video.sframeSourceMissing, 0);
    } finally { f.close(); }
});
