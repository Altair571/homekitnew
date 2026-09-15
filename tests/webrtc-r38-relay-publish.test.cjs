const test = require('node:test');
const assert = require('node:assert/strict');
const { environment, base, quiet, storage } = require('./helpers.cjs');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, ms = 10000, label = 'r38 relay fixture timed out') {
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
            getMedia: async () => { throw Error('r38 relay test must not open a camera'); },
        });
    management.startMedia = async () => {};
    const remotes = [];
    const offer = async () => {
        const offered = proto.parseWebRTCSolicitOfferResponse(Buffer.from(await management.handleSolicitOffer(''), 'base64'));
        assert.equal(offered.status, 0, logs.join('\n'));
        return { offered, session: management.sessions.get(offered.sessionId.toString('hex')) };
    };
    const connect = async (offered, session, appleRid) => {
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
        // The bundled test peer's RID parser misreads offer restrictions; use Apple's answer shape.
        const answer = remote.localDescription.sdp.split(/(?=^m=)/m).map(section => !section.startsWith('m=video ') ? section
            : section.replace(/^a=(?:rid|simulcast):[^\r\n]*\r?\n/gm, '') + 'a=rid:' + appleRid + ' recv\r\na=simulcast:recv ' + appleRid + '\r\n').join('');
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

test('r38 rotates stream-ID RID variants and classifies what each adds', () => {
    const r = environment().load(base + 'hksv-relay-publish.ts');
    assert.equal(r.RELAY_REVISION, 38);
    assert.deepEqual([...r.R38_RELAY_VARIANTS], ['rid-streamid', 'rid-dc-register', 'rid-dc-register-publish']);
    const rotation = r.createRelayVariantRotation();
    assert.deepEqual([rotation.next(), rotation.next(), rotation.next(), rotation.next()].map(p => [p.variant, p.index, p.count]),
        [['rid-streamid', 0, 3], ['rid-dc-register', 1, 3], ['rid-dc-register-publish', 2, 3], ['rid-streamid', 0, 3]]);
    assert.deepEqual([...r.R38_RELAY_VARIANTS].map(v => [r.usesStreamIdRid(v), r.usesRelayDataChannel(v), r.publishesRelayStreams(v)]),
        [[true, false, false], [true, true, false], [true, true, true]]);
    assert.deepEqual([...r.R37_RELAY_VARIANTS].map(v => r.usesStreamIdRid(v)), [false, false, false, false, true]);
});

test('r38 SDP renames the video RID to the stream ID for every r38 variant and nothing else', () => {
    const r = environment().load(base + 'hksv-relay-publish.ts');
    const ids = { videoSsrc: V, audioSsrc: A, videoRid: '10169' };
    const expected = SDP.replace('a=rid:1 send', 'a=rid:10169 send').replace('a=simulcast:send 1\r', 'a=simulcast:send 10169\r');
    for (const variant of r.R38_RELAY_VARIANTS) {
        const renamed = r.withRelaySdpVariant(SDP, variant, ids, '1');
        assert.equal(renamed, expected, variant);
        assert.equal(r.withRelaySdpVariant(renamed, variant, ids, '1'), renamed, variant + ' is idempotent');
    }
    for (const variant of [undefined, 'dc-register', 'dc-register-publish']) assert.equal(r.withRelaySdpVariant(SDP, variant, ids, '1'), SDP);
});

test('r38 rid-streamid offers the stream-ID RID without a data channel', { timeout: 20000 }, async () => {
    const f = fixture(['rid-streamid']);
    try {
        const { offered, session } = await f.offer();
        const rid = String(session.videoTransceiver.sender.ssrc & 0xffff);
        assert.equal(session.videoRid, rid);
        assert.match(offered.sdpOffer, new RegExp('^a=rid:' + rid + ' send pt=99;max-width=640;max-height=360;max-fps=15\\r?$', 'm'));
        assert.doesNotMatch(offered.sdpOffer, /^a=rid:1 /m);
        assert.doesNotMatch(offered.sdpOffer, /^m=application /m);
        assert.equal(session.relay.snapshot().dataChannel, 'not-applicable');
        assert(f.logs.some(l => l.includes('r38 relay variant 1/1 rid-streamid:')));
    } finally { await f.close(); }
});

test('r38 rid-dc-register-publish registers and publishes with the stream-ID RID, and RTP carries it', { timeout: 60000 }, async () => {
    const f = fixture(['rid-dc-register-publish']);
    const { RtpPacket, RtpHeader } = f.env.load('../../external/werift/packages/rtp/src/index.ts');
    try {
        const { offered, session } = await f.offer();
        const vs = session.videoTransceiver.sender.ssrc, as = session.audioTransceiver.sender.ssrc;
        const rid = String(vs & 0xffff);
        assert.equal(session.videoRid, rid);
        assert.match(offered.sdpOffer, /^m=application 9 UDP\/DTLS\/SCTP webrtc-datachannel\r?$/m);
        assert.match(offered.sdpOffer, new RegExp('^a=rid:' + rid + ' send pt=99;max-width=640;max-height=360;max-fps=15\\r?$', 'm'));
        assert.doesNotMatch(offered.sdpOffer, /^a=rid:1 /m);
        assert(f.logs.some(l => l.includes('r38 relay variant 1/1 rid-dc-register-publish:')));
        const link = await f.connect(offered, session, rid);
        assert.equal(link.status, 0, f.logs.join('\n'));
        await until(() => link.messages.length >= 1, 15000, 'registration:\n' + f.logs.join('\n'));
        assert.deepEqual(registration(link.messages[0]), [
            [vs & 0xffff, vs, session.videoTransceiver.mid, rid, 1], [as & 0xffff, as, session.audioTransceiver.mid, undefined, 0]]);
        link.channels[0].send(Buffer.concat([field(1, only(fields(link.messages[0]), 1).bytes), field(31, Buffer.alloc(0))]));
        await until(() => link.messages.length >= 2, 15000, 'published streams:\n' + f.logs.join('\n'));
        assert.deepEqual(varints(only(fields(only(fields(link.messages[1]), 40).bytes), 2).bytes), [vs & 0xffff, as & 0xffff]);
        await until(() => session.pc.connectionState === 'connected' && link.remote.dtlsTransports.every(t => t.state === 'connected'));
        const sender = session.videoTransceiver.sender;
        await sender.sendRtp(new RtpPacket(new RtpHeader({ sequenceNumber: 40, timestamp: 90000, payloadType: 99 }), Buffer.from([0xc0, 1, 2])));
        await until(() => link.packets.some(p => p.header.sequenceNumber === 40));
        const packet = link.packets.find(p => p.header.sequenceNumber === 40);
        const ridId = sender.headerExtensions.find(x => x.uri === RID_URI)?.id;
        assert.equal(packet.header.extensions.find(e => e.id === ridId)?.payload.toString(), rid);
        const snapshot = json(session.relay.snapshot());
        assert.deepEqual([snapshot.revision, snapshot.variant, snapshot.answer, snapshot.sctp, snapshot.sent.length],
            [38, 'rid-dc-register-publish', 'accepted', 'connected', 2]);
    } finally { await f.close(); }
});
