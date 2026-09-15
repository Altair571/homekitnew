const test = require('node:test');
const assert = require('node:assert/strict');
const { environment, base, quiet, storage } = require('./helpers.cjs');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, ms = 10000, label = 'r37 relay fixture timed out') {
    const end = Date.now() + ms;
    while (!check()) {
        if (Date.now() > end) throw Error(label);
        await delay(10);
    }
}
const json = value => JSON.parse(JSON.stringify(value));
const RID_URI = 'urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id';

// Independent protobuf wire reader and writer; neither uses the module under test.
function readVarint(buffer, at) {
    let value = 0n, shift = 0n;
    for (;;) {
        const byte = buffer[at++];
        if (byte === undefined) throw Error('truncated varint');
        value |= BigInt(byte & 127) << shift;
        if (!(byte & 128)) return [value, at];
        shift += 7n;
    }
}
function fields(buffer) {
    const out = [];
    for (let at = 0; at < buffer.length;) {
        let key; [key, at] = readVarint(buffer, at);
        const field = Number(key >> 3n), wire = Number(key & 7n);
        if (wire === 0) { let value; [value, at] = readVarint(buffer, at); out.push({ field, wire, value }); }
        else if (wire === 2) {
            let length; [length, at] = readVarint(buffer, at);
            out.push({ field, wire, bytes: buffer.subarray(at, at + Number(length)) });
            at += Number(length);
        }
        else throw Error('unexpected wire type ' + wire);
    }
    return out;
}
const only = (list, number) => {
    const found = list.filter(f => f.field === number);
    assert.equal(found.length, 1, 'field ' + number + ' occurs exactly once');
    return found[0];
};
const varints = bytes => {
    const out = [];
    for (let at = 0; at < bytes.length;) { let value; [value, at] = readVarint(bytes, at); out.push(Number(value)); }
    return out;
};
const writeVarint = value => {
    let v = BigInt(value); const out = [];
    do { let byte = Number(v & 127n); v >>= 7n; if (v) byte |= 128; out.push(byte); } while (v);
    return Buffer.from(out);
};
const field = (number, value) => Buffer.isBuffer(value)
    ? Buffer.concat([writeVarint(number * 8 + 2), writeVarint(value.length), value])
    : Buffer.concat([writeVarint(number * 8), writeVarint(value)]);
const registration = message => fields(only(fields(only(fields(message), 30).bytes), 2).bytes)
    .filter(f => f.field === 1).map(f => fields(f.bytes))
    .map(c => [Number(only(c, 1).value), Number(only(c, 2).value), only(c, 3).bytes.toString(),
        c.find(f => f.field === 4)?.bytes.toString(), Number(only(c, 10).value)]);

function fixture(relayVariants) {
    const env = environment();
    env.mock('os', { ...require('node:os'), networkInterfaces: () => ({}) });
    const id = '../../external/werift/packages/webrtc/src/index.ts';
    const werift = env.load(id);
    class LocalPeer extends werift.RTCPeerConnection {
        constructor(config) {
            super({ ...config, iceServers: [], iceUseIpv6: false, iceAdditionalHostAddresses: ['127.0.0.1'] });
        }
        addTransceiver(...args) {
            const t = super.addTransceiver(...args);
            t.dtlsTransport.iceTransport.connection.stunServer = undefined;
            return t;
        }
        createSctpTransport() {
            const sctp = super.createSctpTransport();
            sctp.dtlsTransport.iceTransport.connection.stunServer = undefined;
            return sctp;
        }
    }
    env.mock(id, { ...werift, RTCPeerConnection: LocalPeer });
    const proto = env.load(base + 'hksv-webrtc-protocol.ts');
    const { buildSensorVideoTiers } = env.load(base + 'hksv-stream-tiers.ts');
    const logs = [];
    const record = (...args) => logs.push(args.join(' '));
    const management = new (env.load(base + 'camera-webrtc.ts').WebRTCStreamManagement)({ addService() {} },
        { log: record, warn: record, error: record }, {
            sensorUuid: Buffer.alloc(16), supportedVideoTiersValue: '', supportedAudioTiersValue: '',
            videoTiers: buildSensorVideoTiers(3840, 2160), relayVariants,
            getMedia: async () => { throw Error('r37 relay test must not open a camera'); },
        });
    management.startMedia = async () => {};
    const remotes = [];
    const offer = async () => {
        const offered = proto.parseWebRTCSolicitOfferResponse(Buffer.from(await management.handleSolicitOffer(''), 'base64'));
        assert.equal(offered.status, 0, logs.join('\n'));
        return { offered, session: management.sessions.get(offered.sessionId.toString('hex')) };
    };
    const connect = async (offered, session, { declineDataChannel = false, appleRid } = {}) => {
        const remote = new LocalPeer({ codecs: session.pc.config.codecs,
            headerExtensions: { video: [werift.useSdesMid(), werift.useSdesRTPStreamId()], audio: [werift.useSdesMid()] } });
        remotes.push(remote);
        const channels = [], messages = [], packets = [];
        remote.onDataChannel.subscribe(channel => {
            channels.push(channel);
            channel.onMessage.subscribe(data => messages.push(Buffer.from(data)));
        });
        const routeRtp = remote.router.routeRtp;
        remote.router.routeRtp = packet => { packets.push(packet); routeRtp(packet); };
        await remote.setRemoteDescription({ type: 'offer', sdp: offered.sdpOffer });
        await remote.setLocalDescription(await remote.createAnswer());
        let answer = remote.localDescription.sdp;
        if (declineDataChannel) {
            // RFC 8841/JSEP rejection: port 0, no SCTP port, and no longer bundled.
            const parts = answer.split(/(?=^m=)/m);
            const i = parts.findIndex(s => s.startsWith('m=application '));
            const mid = /^a=mid:(\S+?)\r?$/m.exec(parts[i])[1];
            parts[i] = 'm=application 0 UDP/DTLS/SCTP webrtc-datachannel\r\nc=IN IP4 0.0.0.0\r\na=mid:' + mid + '\r\n';
            answer = parts.join('').replace(/^a=group:BUNDLE ([^\r\n]+)/m,
                (_, mids) => 'a=group:BUNDLE ' + mids.split(' ').filter(m => m !== mid).join(' '));
        }
        if (appleRid) {
            // The bundled test peer's RID parser misreads offer restrictions; use Apple's answer shape.
            answer = answer.split(/(?=^m=)/m).map(section => !section.startsWith('m=video ') ? section
                : section.replace(/^a=(?:rid|simulcast):[^\r\n]*\r?\n/gm, '') + 'a=rid:' + appleRid + ' recv\r\na=simulcast:recv ' + appleRid + '\r\n').join('');
        }
        const response = await management.handleProvideAnswer(proto.encodeWebRTCProvideAnswer({
            sessionId: offered.sessionId, sdpAnswer: answer, additionalCandidates: [] }));
        return { remote, channels, messages, packets, answer, status: proto.parseWebRTCSessionStatusResponse(response).status };
    };
    const close = async () => {
        management.closeAllSessions();
        for (const remote of remotes) await remote.close().catch(() => {});
    };
    return { env, management, logs, offer, connect, close };
}

const V = 0xcf3827b9, A = 0xdb23a6d1;
const SDP = ['v=0', 'o=- 1 0 IN IP4 0.0.0.0', 's=-', 't=0 0', 'a=group:BUNDLE 0 1',
    'm=video 9 UDP/TLS/RTP/SAVPF 99', 'a=mid:0', 'a=msid:stream-v track-v', `a=ssrc:${V} cname:front`, 'a=rtpmap:99 H265/90000',
    'a=rid:1 send pt=99;max-width=640;max-height=360;max-fps=15', 'a=simulcast:send 1',
    'm=audio 9 UDP/TLS/RTP/SAVPF 110', 'a=mid:1', 'a=msid:stream-a track-a', `a=ssrc:${A} cname:front`, 'a=rtpmap:110 opus/48000/2', ''].join('\r\n');

test('r37 rotates known relay variants in order and derives Apple stream IDs from SSRCs', () => {
    const r = environment().load(base + 'hksv-relay-publish.ts');
    assert.deepEqual([...r.R37_RELAY_VARIANTS], ['dc-register', 'dc-register-publish', 'sdp-ssrc-labels', 'sdp-sim-group', 'sdp-rid-streamid']);
    const rotation = r.createRelayVariantRotation(['sdp-sim-group', 'unknown', 'dc-register']);
    assert.deepEqual(json([rotation.next(), rotation.next(), rotation.next()]), [
        { variant: 'sdp-sim-group', index: 0, count: 2 }, { variant: 'dc-register', index: 1, count: 2 },
        { variant: 'sdp-sim-group', index: 0, count: 2 }]);
    assert.equal(r.createRelayVariantRotation([]).next(), undefined);
    assert.equal(r.relayStreamId(V), 10169, 'r36 blob: cf3827b9 -> 10169');
    assert.equal(r.relayStreamId(A), 42705, 'r36 blob: db23a6d1 -> 42705');
});

test('r37 media registration uses the relay web protobuf tags, actual SSRCs and stream IDs', () => {
    const r = environment().load(base + 'hksv-relay-publish.ts');
    const uuid = Buffer.alloc(16, 0xab);
    const bytes = Buffer.from(r.encodeRelayMediaRegistration([
        { kind: 'video', ssrc: V, mid: '0', rid: '1' }, { kind: 'audio', ssrc: A, mid: '1' }], uuid, 0x0102030405060708n));
    assert.deepEqual([...bytes.subarray(0, 2)], [0x0a, 0x10], 'uuid is 16-byte field 1');
    assert.deepEqual([...bytes.subarray(18, 20)], [0xf2, 0x01], 'mediaInfoRequest is field 30');
    const top = fields(bytes);
    assert.deepEqual(top.map(f => f.field), [1, 30]);
    assert.deepEqual(only(top, 1).bytes, uuid);
    assert.deepEqual(registration(bytes), [[10169, V, '0', '1', 1], [42705, A, '1', undefined, 0]]);
    const parameters = fields(only(fields(only(top, 30).bytes), 2).bytes);
    assert.equal(only(parameters, 2).value, 0x0102030405060708n);
    const ntp = r.ntpTimestamp(Date.UTC(2026, 8, 15, 2, 9, 0, 500));
    assert.equal(ntp >> 32n, BigInt(Date.UTC(2026, 8, 15, 2, 9, 0) / 1000 + 2208988800));
    assert.equal(ntp & 0xffffffffn, 0x80000000n);
});

test('r37 published stream request and relay replies decode, and malformed replies are contained', () => {
    const r = environment().load(base + 'hksv-relay-publish.ts');
    const publish = Buffer.from(r.encodeRelayPublishedStreams([10169, 42705], 7, Buffer.alloc(16, 1)));
    assert.deepEqual([...publish.subarray(18, 20)], [0xc2, 0x02], 'sessionInfoRequest is field 40');
    const request = fields(only(fields(publish), 40).bytes);
    assert.equal(only(request, 1).value, 7n);
    assert.deepEqual(varints(only(request, 2).bytes), [10169, 42705]);

    const uuid = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
    const peer = field(2, Buffer.concat([field(2, 8409436528765048517n), field(3, Buffer.concat([writeVarint(10169), writeVarint(42705)]))]));
    const update = json(r.decodeRelayMessage(Buffer.concat([field(1, uuid), field(42, Buffer.concat([field(1, 4), peer]))])));
    assert.equal(update.uuid, '00112233');
    assert.deepEqual(update.kinds, ['sessionInfoUpdate']);
    assert.deepEqual(update.sessionInfoUpdate, { generationCounter: 4,
        peerPublished: [{ participant: '8409436528765048517', streams: [10169, 42705] }], peerSubscribed: [] });
    const failed = json(r.decodeRelayMessage(Buffer.concat([field(1, uuid),
        field(31, field(2, Buffer.concat([field(1, 1001), field(2, Buffer.from('InvalidField'))])))])));
    assert.deepEqual(failed.mediaInfoResponse, { error: { code: 1001, message: 'InvalidField' } });
    assert.deepEqual(json(r.decodeRelayMessage(Buffer.concat([field(1, uuid), field(31, Buffer.alloc(0))]))).mediaInfoResponse, { ok: true });
    for (const bad of [Buffer.from([0x0a, 0x7f, 1]), Buffer.alloc(11, 0xff), Buffer.from([0x0b])])
        assert.equal(r.decodeRelayMessage(bad).malformed, true);
    assert.equal(r.decodeRelayMessage('text').text, true);
});

test('r37 SDP variants change only their own attributes and are idempotent', () => {
    const r = environment().load(base + 'hksv-relay-publish.ts');
    const ids = { videoSsrc: V, audioSsrc: A, videoRid: '1' };
    const apply = (variant, i = ids, sdp = SDP) => r.withRelaySdpVariant(sdp, variant, i, '1');
    for (const variant of [undefined, 'dc-register', 'dc-register-publish']) assert.equal(apply(variant), SDP);

    const labels = apply('sdp-ssrc-labels');
    assert.equal(apply('sdp-ssrc-labels', ids, labels), labels);
    assert(labels.includes(`a=ssrc:${V} cname:front\r\na=ssrc:${V} msid:stream-v track-v\r\na=ssrc:${V} mslabel:stream-v\r\na=ssrc:${V} label:track-v\r\n`));
    assert(labels.includes(`a=ssrc:${A} cname:front\r\na=ssrc:${A} msid:stream-a track-a\r\na=ssrc:${A} mslabel:stream-a\r\na=ssrc:${A} label:track-a\r\n`));
    assert.equal(labels.replace(/^a=ssrc:\d+ (?:msid|mslabel|label):[^\r\n]*\r\n/gm, ''), SDP);

    const sim = apply('sdp-sim-group');
    assert.equal(apply('sdp-sim-group', ids, sim), sim);
    assert(sim.includes(`a=msid:stream-v track-v\r\na=ssrc-group:SIM ${V}\r\na=ssrc:${V} cname:front`));
    assert.equal(sim.replace(`a=ssrc-group:SIM ${V}\r\n`, ''), SDP);

    const rid = apply('sdp-rid-streamid', { ...ids, videoRid: '10169' });
    assert.match(rid, /^a=rid:10169 send pt=99;max-width=640;max-height=360;max-fps=15\r$/m);
    assert.match(rid, /^a=simulcast:send 10169\r$/m);
    assert.equal(rid.replace('a=rid:10169', 'a=rid:1').replace('a=simulcast:send 10169', 'a=simulcast:send 1'), SDP);
    assert.equal(apply('sdp-rid-streamid'), SDP, 'RID 1 needs no rename');
    const rejected = SDP.replace('m=video 9 ', 'm=video 0 ');
    assert.equal(apply('sdp-sim-group', ids, rejected), rejected);
});

test('r37 classifies the answer data channel and removes only a declined section', () => {
    const r = environment().load(base + 'hksv-relay-publish.ts');
    const head = 'v=0\r\no=- 1 0 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\na=group:BUNDLE 0 1\r\n';
    const av = 'm=video 9 UDP/TLS/RTP/SAVPF 99\r\na=mid:0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 110\r\na=mid:1\r\n';
    const accepted = head + av + 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=mid:2\r\na=sctp-port:5000\r\n';
    assert.deepEqual(json(r.classifyRelayDataChannelAnswer(accepted)), { state: 'accepted', sdp: accepted });
    const legacy = head + av + 'm=application 9 DTLS/SCTP 5000\r\na=mid:2\r\na=sctpmap:5000 webrtc-datachannel 1024\r\n';
    assert.equal(r.classifyRelayDataChannelAnswer(legacy).state, 'accepted');
    const declined = head + av + 'm=application 0 UDP/DTLS/SCTP webrtc-datachannel\r\nc=IN IP4 0.0.0.0\r\na=mid:2\r\n';
    assert.deepEqual(json(r.classifyRelayDataChannelAnswer(declined)), { state: 'declined', sdp: head + av });
    const noPort = head + av + 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=mid:2\r\n';
    assert.deepEqual(json(r.classifyRelayDataChannelAnswer(noPort)), { state: 'declined', sdp: head + av });
    assert.deepEqual(json(r.classifyRelayDataChannelAnswer(head + av)), { state: 'absent', sdp: head + av });
});

test('r37 without relay variants keeps the r36 offer', { timeout: 20000 }, async () => {
    const f = fixture(undefined);
    try {
        const { offered, session } = await f.offer();
        assert.doesNotMatch(offered.sdpOffer, /^m=application /m);
        assert.match(offered.sdpOffer, /^a=rid:1 send pt=99;max-width=640;max-height=360;max-fps=15\r?$/m);
        assert.equal(session.relay, undefined);
        assert.equal(session.videoRid, '1');
        assert.equal(session.transports.size, 2);
        assert.equal(f.logs.filter(l => /r\d+ relay/.test(l)).length, 0);
    } finally { await f.close(); }
});

test('r37 data channel variants register sender streams, then publish them, over real SCTP', { timeout: 60000 }, async () => {
    const f = fixture(['dc-register', 'dc-register-publish']);
    try {
        const first = await f.offer();
        assert.match(first.offered.sdpOffer, /^m=application 9 UDP\/DTLS\/SCTP webrtc-datachannel\r?$/m);
        assert.match(first.offered.sdpOffer, /^a=group:BUNDLE 0 1 2\r?$/m);
        const video = first.offered.sdpOffer.split(/(?=^m=)/m).find(s => s.startsWith('m=video '));
        assert.match(video, /^a=mid:0\r?$/m);
        assert.match(video, /^a=rid:1 send pt=99;max-width=640;max-height=360;max-fps=15\r?$/m);
        assert(f.logs.some(l => l.includes(' relay variant 1/2 dc-register:')));
        const s = first.session;
        const offeredTransports = [...s.transports];
        assert.equal(offeredTransports.length, 3, 'video, audio and data channel transports are tracked');
        const link = await f.connect(first.offered, s);
        assert.equal(link.status, 0, f.logs.join('\n'));
        await until(() => link.messages.length >= 1, 15000, 'registration message:\n' + f.logs.join('\n'));
        assert.equal(link.channels[0].label, '0');
        const top = fields(link.messages[0]);
        const uuid = only(top, 1).bytes;
        assert.equal(uuid.length, 16);
        const vs = s.videoTransceiver.sender.ssrc, as = s.audioTransceiver.sender.ssrc;
        assert.deepEqual(registration(link.messages[0]), [
            [vs & 0xffff, vs, s.videoTransceiver.mid, '1', 1], [as & 0xffff, as, s.audioTransceiver.mid, undefined, 0]]);
        link.channels[0].send(Buffer.concat([field(1, uuid), field(31, Buffer.alloc(0))]));
        await until(() => s.relay.snapshot().received >= 1, 10000, 'relay reply is observed');
        const snapshot = json(s.relay.snapshot());
        assert.deepEqual([snapshot.dataChannel, snapshot.answer, snapshot.sctp], ['offered', 'accepted', 'connected']);
        assert.equal(snapshot.registrationReplied, true);
        assert.deepEqual(snapshot.replies[0].kinds, ['mediaInfoResponse']);
        assert(f.logs.some(l => l.includes('received {"bytes":')));
        await delay(2300);
        assert.equal(link.messages.length, 1, 'dc-register sends only the registration');
        for (const transport of offeredTransports.filter(t => !s.pc.dtlsTransports.includes(t)))
            await until(() => transport.iceTransport.state === 'closed', 5000, 'an unused offered transport must close');

        const second = await f.offer();
        assert(f.logs.some(l => l.includes(' relay variant 2/2 dc-register-publish:')));
        const t = second.session;
        const publish = await f.connect(second.offered, t);
        assert.equal(publish.status, 0, f.logs.join('\n'));
        await until(() => publish.messages.length >= 1, 15000, 'second registration');
        publish.channels[0].send(Buffer.concat([field(1, only(fields(publish.messages[0]), 1).bytes), field(31, Buffer.alloc(0))]));
        await until(() => publish.messages.length >= 2, 15000, 'published stream request:\n' + f.logs.join('\n'));
        const published = fields(only(fields(publish.messages[1]), 40).bytes);
        assert.equal(Number(only(published, 1).value), 1);
        assert.deepEqual(varints(only(published, 2).bytes), [t.videoTransceiver.sender.ssrc & 0xffff, t.audioTransceiver.sender.ssrc & 0xffff]);
        assert.equal(json(t.relay.snapshot()).sent.length, 2);
    } finally { await f.close(); }
});

test('r37 media transport still connects when an accepted data channel never associates', { timeout: 30000 }, async () => {
    const f = fixture(['dc-register']);
    try {
        const { offered, session } = await f.offer();
        const manager = session.pc.sctpManager;
        // A relay that accepts the section but never completes SCTP.
        manager.sctpTransport.start = () => new Promise(() => {});
        const link = await f.connect(offered, session);
        assert.equal(link.status, 0, f.logs.join('\n'));
        session.pc.sctpTransport.dtlsTransport.dataReceiver = () => {};
        await until(() => session.pc.connectionState === 'connected', 15000, 'media transport connects:\n' + f.logs.join('\n'));
        await until(() => link.remote.dtlsTransports.every(t => t.state === 'connected'), 5000, 'viewer DTLS completes');
        const snapshot = json(session.relay.snapshot());
        assert.deepEqual([snapshot.answer, snapshot.sctp, snapshot.sent.length], ['accepted', 'connecting', 0]);
        // Without the r37 guard, the bundled werift waits for this association before "connected".
        let settled = false;
        Object.getPrototypeOf(manager).connectSctp.call(manager).then(() => { settled = true; }, () => { settled = true; });
        await delay(300);
        assert.equal(settled, false);
    } finally { await f.close(); }
});

test('r37 sdp-rid-streamid negotiates a stream-ID RID and carries it on actual RTP', { timeout: 30000 }, async () => {
    const f = fixture(['sdp-rid-streamid']);
    const { RtpPacket, RtpHeader } = f.env.load('../../external/werift/packages/rtp/src/index.ts');
    try {
        const { offered, session } = await f.offer();
        const rid = String(session.videoTransceiver.sender.ssrc & 0xffff);
        assert.equal(session.videoRid, rid);
        assert.match(offered.sdpOffer, new RegExp('^a=rid:' + rid + ' send pt=99;max-width=640;max-height=360;max-fps=15\\r?$', 'm'));
        assert.match(offered.sdpOffer, new RegExp('^a=simulcast:send ' + rid + '\\r?$', 'm'));
        assert.doesNotMatch(offered.sdpOffer, /^a=rid:1 /m);
        assert.doesNotMatch(offered.sdpOffer, /^m=application /m);
        const link = await f.connect(offered, session, { appleRid: rid });
        assert.equal(link.status, 0, f.logs.join('\n'));
        await until(() => session.pc.connectionState === 'connected' && link.remote.connectionState === 'connected');
        const sender = session.videoTransceiver.sender;
        await sender.sendRtp(new RtpPacket(new RtpHeader({ sequenceNumber: 30, timestamp: 90000, payloadType: 99 }), Buffer.from([0xc0, 1, 2])));
        await until(() => link.packets.some(p => p.header.sequenceNumber === 30));
        const packet = link.packets.find(p => p.header.sequenceNumber === 30);
        const ridId = sender.headerExtensions.find(x => x.uri === RID_URI)?.id;
        assert.equal(packet.header.extensions.find(e => e.id === ridId)?.payload.toString(), rid);
        await until(() => session.contract.snapshot().video.counters.checkedRtp >= 1);
        const counters = session.contract.snapshot().video.counters;
        assert.deepEqual([counters.ridMismatch, counters.ridWithoutReceiveDeclaration, counters.missingRid], [0, 0, 0]);
    } finally { await f.close(); }
});

test('r37 keeps media when the answer declines the relay data channel', { timeout: 30000 }, async () => {
    const f = fixture(['dc-register']);
    try {
        const { offered, session } = await f.offer();
        const offeredTransports = [...session.transports];
        const link = await f.connect(offered, session, { declineDataChannel: true });
        assert.match(link.answer, /^m=application 0 UDP\/DTLS\/SCTP webrtc-datachannel\r?$/m);
        assert.doesNotMatch(link.answer, /^a=sctp-port:/m);
        assert.equal(link.status, 0, f.logs.join('\n'));
        await until(() => session.pc.connectionState === 'connected', 15000, 'media transport still connects:\n' + f.logs.join('\n'));
        // Both DTLS ends finish; closing mid-handshake leaves werift retransmitting for about 30 s.
        await until(() => link.remote.dtlsTransports.every(t => t.state === 'connected'), 5000, 'viewer DTLS completes');
        const snapshot = json(session.relay.snapshot());
        assert.deepEqual([snapshot.answer, snapshot.sctp, snapshot.sent.length], ['declined', 'skipped', 0]);
        assert.equal(session.pc.dtlsTransports.length, 1);
        for (const transport of offeredTransports.filter(t => !session.pc.dtlsTransports.includes(t)))
            await until(() => transport.iceTransport.state === 'closed', 5000, 'the declined data channel transport is released');
        assert(f.logs.some(l => l.includes('answer declined the data channel')));
    } finally { await f.close(); }
});
