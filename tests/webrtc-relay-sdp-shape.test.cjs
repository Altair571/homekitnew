const test = require('node:test');
const assert = require('node:assert/strict');
const { environment, base, quiet } = require('./helpers.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, ms = 6000) {
    const end = Date.now() + ms;
    while (!check()) {
        if (Date.now() > end) throw Error('relay SDP fixture timed out');
        await delay(10);
    }
}
const MID = 'urn:ietf:params:rtp-hdrext:sdes:mid';
const RID = 'urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id';
const sections = sdp => sdp.split(/(?=^m=)/m);
const media = (sdp, kind) => sections(sdp).find(section => section.startsWith('m=' + kind + ' '));
const extmap = (section, uri) => Number(new RegExp('^a=extmap:(\\d+) ' + uri.replace(/\./g, '\\.') + '\\r?$', 'm').exec(section)?.[1]);

function fixture() {
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
    }
    env.mock(id, { ...werift, RTCPeerConnection: LocalPeer });
    const proto = env.load(base + 'hksv-webrtc-protocol.ts');
    const { buildSensorVideoTiers } = env.load(base + 'hksv-stream-tiers.ts');
    const management = new (env.load(base + 'camera-webrtc.ts').WebRTCStreamManagement)({ addService() {} }, quiet, {
        sensorUuid: Buffer.alloc(16), supportedVideoTiersValue: '', supportedAudioTiersValue: '',
        videoTiers: buildSensorVideoTiers(3840, 2160),
        getMedia: async () => { throw Error('Relay SDP test must not open a camera'); },
    });
    management.startMedia = async () => {};
    const offer = async () => {
        const offered = proto.parseWebRTCSolicitOfferResponse(Buffer.from(await management.handleSolicitOffer(''), 'base64'));
        assert.equal(offered.status, 0);
        return { offered, session: management.sessions.get(offered.sessionId.toString('hex')) };
    };
    return { env, werift, LocalPeer, proto, management, offer };
}

test('offer uses one MID extension ID and declares the sender SSRC alongside the video RID', { timeout: 15000 }, async () => {
    const { management, offer } = fixture();
    try {
        const { offered, session } = await offer();
        const video = media(offered.sdpOffer, 'video'), audio = media(offered.sdpOffer, 'audio');
        assert(Number.isInteger(extmap(video, MID)));
        assert.equal(extmap(audio, MID), extmap(video, MID));
        assert(Number.isInteger(extmap(video, RID)));
        assert.notEqual(extmap(video, RID), extmap(video, MID));
        assert.match(video, /^a=rid:1 send pt=99;max-width=640;max-height=360;max-fps=15\r?$/m);
        assert.match(video, /^a=simulcast:send 1\r?$/m);
        assert.match(video, /^a=msid:/m);
        // Apple's relay rejected r33 with "invalid sdp - no SSRC in mid:0".
        assert.match(video, new RegExp('^a=ssrc:' + session.videoTransceiver.sender.ssrc + ' cname:', 'm'));
        assert.match(audio, new RegExp('^a=ssrc:' + session.audioTransceiver.sender.ssrc + ' cname:', 'm'));
    } finally {
        management.closeAllSessions();
    }
});

test('a browser-style answer negotiates MID for both kinds and video packets carry MID and RID', { timeout: 20000 }, async () => {
    const { env, werift, LocalPeer, proto, management, offer } = fixture();
    const { RtpPacket, RtpHeader } = env.load('../../external/werift/packages/rtp/src/index.ts');
    let remote;
    try {
        const { offered, session } = await offer();
        const received = [];
        remote = new LocalPeer({
            codecs: session.pc.config.codecs,
            headerExtensions: { video: [werift.useSdesMid(), werift.useSdesRTPStreamId()], audio: [werift.useSdesMid()] },
        });
        const routeRtp = remote.router.routeRtp;
        remote.router.routeRtp = packet => { received.push(packet); routeRtp(packet); };
        await remote.setRemoteDescription({ type: 'offer', sdp: offered.sdpOffer });
        await remote.setLocalDescription(await remote.createAnswer());
        const answer = remote.localDescription.sdp;
        assert(Number.isInteger(extmap(media(answer, 'video'), MID)), answer);
        assert.equal(extmap(media(answer, 'audio'), MID), extmap(media(answer, 'video'), MID));
        const response = await management.handleProvideAnswer(proto.encodeWebRTCProvideAnswer({
            sessionId: offered.sessionId, sdpAnswer: answer, additionalCandidates: [],
        }));
        assert.equal(proto.parseWebRTCSessionStatusResponse(response).status, 0);
        await until(() => session.pc.connectionState === 'connected' && remote.connectionState === 'connected');
        const sender = session.videoTransceiver.sender;
        await sender.sendRtp(new RtpPacket(new RtpHeader({ sequenceNumber: 20, timestamp: 60000, payloadType: 99 }), Buffer.from([38, 1, 128])));
        await until(() => received.some(packet => packet.header.sequenceNumber === 20));
        const packet = received.find(packet => packet.header.sequenceNumber === 20);
        const value = uri => packet.header.extensions.find(e => e.id === sender.headerExtensions.find(x => x.uri === uri)?.id)?.payload.toString();
        assert.equal(value(MID), '0');
        assert.equal(value(RID), '1');
    } finally {
        management.closeAllSessions();
        await remote?.close();
    }
});

test('relay RTCP counters classify reports and feedback by local stream and restore routing on close', { timeout: 15000 }, async () => {
    const { env, management, offer } = fixture();
    const rtp = env.load('../../external/werift/packages/rtp/src/index.ts');
    const { session } = await offer();
    const router = session.pc.router;
    const hook = router.routeRtcp;
    const video = session.videoTransceiver.sender.ssrc, audio = session.audioTransceiver.sender.ssrc;
    const report = ssrc => new rtp.RtcpReceiverInfo({ ssrc, fractionLost: 0, packetsLost: 0, highestSequence: 0, jitter: 0, lsr: 0, dlsr: 0 });
    router.routeRtcp(new rtp.RtcpRrPacket({ ssrc: 7, reports: [report(video), report(audio), report(12345)] }));
    router.routeRtcp(new rtp.RtcpTransportLayerFeedback({ feedback: new rtp.GenericNack({ senderSsrc: 7, mediaSourceSsrc: audio }) }));
    const snapshot = session.relayRtcp.snapshot();
    assert.equal(snapshot.packets, 2);
    assert.equal(snapshot['rr.video'], 1);
    assert.equal(snapshot['rr.audio'], 1);
    assert.equal(snapshot['rr.other'], 1);
    assert.equal(snapshot['rtpfb1.audio'], 1);
    assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(String(video) + '|' + String(audio)));
    management.closeAllSessions();
    assert.notEqual(router.routeRtcp, hook);
});
