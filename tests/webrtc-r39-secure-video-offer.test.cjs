const test = require('node:test');
const assert = require('node:assert/strict');
const { environment, base, quiet, storage } = require('./helpers.cjs');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, ms = 10000, label = 'r39 secure video offer fixture timed out') {
    const end = Date.now() + ms;
    while (!check()) {
        if (Date.now() > end) throw Error(label);
        await delay(10);
    }
}
const RID_URI = 'urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id';
const sections = sdp => sdp.split(/(?=^m=)/m);
const media = (sdp, kind) => sections(sdp).find(section => section.startsWith('m=' + kind + ' '));

function fixture(options) {
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
    const logs = [];
    const record = (...args) => logs.push(args.join(' '));
    const management = new (env.load(base + 'camera-webrtc.ts').WebRTCStreamManagement)({ addService() {} },
        { log: record, warn: record, error: record }, {
            sensorUuid: Buffer.alloc(16), supportedVideoTiersValue: '', supportedAudioTiersValue: '',
            videoTiers: buildSensorVideoTiers(3840, 2160), ...options,
            getMedia: async () => { throw Error('r39 offer test must not open a camera'); },
        });
    management.startMedia = async () => {};
    const remotes = [];
    const offer = async () => {
        const offered = proto.parseWebRTCSolicitOfferResponse(Buffer.from(await management.handleSolicitOffer(''), 'base64'));
        assert.equal(offered.status, 0, logs.join('\n'));
        return { offered, session: management.sessions.get(offered.sessionId.toString('hex')) };
    };
    const close = async () => {
        management.closeAllSessions();
        for (const remote of remotes) await remote.close().catch(() => {});
    };
    return { env, werift, LocalPeer, proto, management, logs, remotes, offer, close };
}

// A werift offer before decoration: video first, CRLF line endings, trailing CRLF.
const WERIFT_OFFER = ['v=0', 'o=- 1 0 IN IP4 0.0.0.0', 's=-', 't=0 0', 'a=group:BUNDLE 0 1', 'a=msid-semantic:WMS *',
    'm=video 9 UDP/TLS/RTP/SAVPF 99', 'c=IN IP4 0.0.0.0', 'a=ice-ufrag:u', 'a=ice-pwd:p', 'a=mid:0', 'a=sendonly', 'a=rtcp-mux',
    'a=rtpmap:99 H265/90000', 'a=ssrc:1111 cname:front',
    'm=audio 9 UDP/TLS/RTP/SAVPF 110', 'c=IN IP4 0.0.0.0', 'a=mid:1', 'a=sendonly', 'a=rtpmap:110 opus/48000/2', 'a=ssrc:2222 cname:front', ''].join('\r\n');

test('r39 peak bitrates follow the recommended table and the camera.ui 360p peak', () => {
    const camera = environment().load(base + 'camera-webrtc.ts');
    assert.deepEqual([180, 768, 1700, 2800, 4500].map(camera.peakBitrateKbps), [190, 800, 1800, 3000, 5000]);
    assert.equal(camera.peakBitrateKbps(1000), 1060);
});

test('r39 secure video offer adds the video bitrate and a declared-only RID exactly as camera.ui does', () => {
    const camera = environment().load(base + 'camera-webrtc.ts');
    const out = camera.withSecureVideoOffer(WERIFT_OFFER, { width: 640, height: 360, frameRate: 15 }, 190);
    const expected = WERIFT_OFFER
        .replace('m=video 9 UDP/TLS/RTP/SAVPF 99\r\nc=IN IP4 0.0.0.0\r\n', 'm=video 9 UDP/TLS/RTP/SAVPF 99\r\nc=IN IP4 0.0.0.0\r\nb=AS:190\r\nb=TIAS:190000\r\n')
        .replace('a=ssrc:1111 cname:front\r\n', 'a=ssrc:1111 cname:front\r\na=extmap:1 ' + RID_URI
            + '\r\na=rid:1 send max-width=640;max-height=360;max-fps=15;max-br=190000\r\na=simulcast:send 1\r\n');
    assert.equal(out, expected);
    assert.equal(camera.withSecureVideoOffer(out, { width: 640, height: 360, frameRate: 15 }, 190), out, 'idempotent');
    assert.equal(media(out, 'audio'), media(WERIFT_OFFER, 'audio'), 'audio section untouched');
    assert.doesNotMatch(out, /\r\n\r\n/);

    const withExtension = WERIFT_OFFER.replace('a=rtpmap:99 H265/90000', 'a=extmap:1 urn:ietf:params:rtp-hdrext:sdes:mid\r\na=rtpmap:99 H265/90000');
    assert.match(camera.withSecureVideoOffer(withExtension, { width: 640, height: 360, frameRate: 15 }, 190), /^a=extmap:2 urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id\r$/m);
    const videoLast = WERIFT_OFFER.split('m=audio')[0];
    const decorated = camera.withSecureVideoOffer(videoLast, { width: 640, height: 360, frameRate: 15 }, 190);
    assert.match(decorated, /a=simulcast:send 1\r\n$/);
    assert.doesNotMatch(decorated, /\r\n\r\n/);
    assert.equal(camera.withSecureVideoOffer('v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 110\r\n', { width: 1, height: 1, frameRate: 1 }, 1), 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 110\r\n');
});

test('r39 solicited offer negotiates no RTP extensions, declares the RID with bitrate, and omits a=sframe', { timeout: 20000 }, async () => {
    const f = fixture({ secureVideoOffer: true });
    try {
        const { offered, session } = await f.offer();
        const video = media(offered.sdpOffer, 'video'), audio = media(offered.sdpOffer, 'audio');
        assert.deepEqual(JSON.parse(JSON.stringify(session.pc.config.headerExtensions)), { video: [], audio: [] });
        assert.match(video, /^b=AS:190\r?$/m);
        assert.match(video, /^b=TIAS:190000\r?$/m);
        assert.doesNotMatch(audio, /^b=/m);
        assert.deepEqual(video.match(/^a=extmap:.*$/gm).map(l => l.replace(/\r$/, '')), ['a=extmap:1 ' + RID_URI]);
        assert.doesNotMatch(audio, /^a=extmap:/m);
        assert.match(video, /^a=rid:1 send max-width=640;max-height=360;max-fps=15;max-br=190000\r?$/m);
        assert.match(video, /^a=simulcast:send 1\r?$/m);
        assert.doesNotMatch(offered.sdpOffer, /^a=sframe/m);
        assert.doesNotMatch(offered.sdpOffer, /^m=application /m);
        assert.doesNotMatch(offered.sdpOffer, /pt=99/);
        assert.match(video, new RegExp('^a=ssrc:' + session.videoTransceiver.sender.ssrc + ' cname:', 'm'));
        assert.ok(offered.sframeConfiguration, 'SFrame keys still travel in the HomeKit response');
        assert.equal(session.relay, undefined);
        assert(f.logs.some(l => l.includes('video RID=1 (secure video offer)')));
    } finally { await f.close(); }
});

test('r39 packets reach the viewer without any RTP header extension after a relay-shaped answer', { timeout: 30000 }, async () => {
    const f = fixture({ secureVideoOffer: true });
    const { RtpPacket, RtpHeader } = f.env.load('../../external/werift/packages/rtp/src/index.ts');
    try {
        const { offered, session } = await f.offer();
        const remote = new f.LocalPeer({ codecs: session.pc.config.codecs,
            headerExtensions: { video: [f.werift.useSdesMid(), f.werift.useSdesRTPStreamId()], audio: [f.werift.useSdesMid()] } });
        f.remotes.push(remote);
        const received = [], routeRtp = remote.router.routeRtp;
        remote.router.routeRtp = packet => { received.push(packet); routeRtp(packet); };
        await remote.setRemoteDescription({ type: 'offer', sdp: offered.sdpOffer });
        await remote.setLocalDescription(await remote.createAnswer());
        // Apple's answer shape: the relay echoes the RID as a receive declaration.
        const answer = remote.localDescription.sdp.split(/(?=^m=)/m).map(section => !section.startsWith('m=video ') ? section
            : section.replace(/^a=(?:rid|simulcast):[^\r\n]*\r?\n/gm, '') + 'a=rid:1 recv\r\na=simulcast:recv 1\r\n').join('');
        const response = await f.management.handleProvideAnswer(f.proto.encodeWebRTCProvideAnswer({
            sessionId: offered.sessionId, sdpAnswer: answer, additionalCandidates: [] }));
        assert.equal(f.proto.parseWebRTCSessionStatusResponse(response).status, 0, f.logs.join('\n'));
        await until(() => session.pc.connectionState === 'connected' && remote.connectionState === 'connected');
        const sender = session.videoTransceiver.sender;
        assert.equal(sender.rtpStreamId, undefined);
        await sender.sendRtp(new RtpPacket(new RtpHeader({ sequenceNumber: 50, timestamp: 90000, payloadType: 99 }), Buffer.from([0xc0, 1, 2])));
        await until(() => received.some(p => p.header.sequenceNumber === 50));
        const packet = received.find(p => p.header.sequenceNumber === 50);
        assert.equal(packet.header.ssrc, sender.ssrc);
        assert.equal(packet.header.extensions.length, 0);
    } finally { await f.close(); }
});

test('r39 default management keeps the r36 offer for callers that do not opt in', { timeout: 20000 }, async () => {
    const f = fixture({});
    try {
        const { offered } = await f.offer();
        const video = media(offered.sdpOffer, 'video');
        assert.match(video, /^a=rid:1 send pt=99;max-width=640;max-height=360;max-fps=15\r?$/m);
        assert.doesNotMatch(video, /^b=AS:/m);
        assert.match(offered.sdpOffer, /^a=sframe\r?$/m);
    } finally { await f.close(); }
});

test('production HomeKit camera uses the r39 secure video offer without relay experiments', () => {
    const env = environment({ realHap: true });
    const { Accessory } = env.load('./src/hap.ts');
    const { Hksv27Camera } = env.load(base + 'camera-hksv27.ts');
    const camera = new Hksv27Camera(new Accessory('r39 offer wiring', '00000000-0000-4000-8000-000000000039'), {}, storage(), quiet,
        { sensorClass: '4k', sensorWidth: 3840, sensorHeight: 2160 });
    try {
        assert.equal(camera.webrtc.opts.secureVideoOffer, true);
        assert.equal(camera.webrtc.opts.relayVariants, undefined);
        assert.equal(camera.webrtc.relayRotation, undefined);
    } finally { camera.handleFactoryReset(); }
});
