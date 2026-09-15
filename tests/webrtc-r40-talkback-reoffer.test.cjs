const test = require('node:test');
const assert = require('node:assert/strict');
const { environment, base, quiet, never, storage } = require('./helpers.cjs');
const { rtcEnvironment } = require('./webrtc-helpers.cjs');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const tick = () => new Promise(setImmediate);
async function until(check, ms = 10000, label = 'r40 talkback reoffer fixture timed out') {
    const end = Date.now() + ms;
    while (!check()) {
        if (Date.now() > end) throw Error(label);
        await delay(10);
    }
}
const KEPT = 'running media kept, 1 talkback audio receiver(s) accepted (not played)';

// Mock peers with running media; each reoffer runs one extra negotiation step after the mock's own.
async function mockSession(options = {}) {
    const processes = [], logs = [];
    const e = rtcEnvironment({ startForwarder: async (c, input, tracks) => {
        const p = { kill() { this.killed = true; }, killPromise: never, videoSection: Promise.resolve({ codec: 'h265' }) };
        processes.push(p);
        queueMicrotask(() => tracks.video?.onRtp(Buffer.alloc(1), 'h265'));
        return p;
    } });
    const record = (...a) => logs.push(a.join(' '));
    const rtc = new e.Class({ addService() {} }, { ...quiet, log: record, warn: record, error: record },
        { ...e.opts, secureVideoOffer: true, acceptRelayTalkback: true, ...options });
    const offer = e.proto.parseWebRTCSolicitOfferResponse(Buffer.from(await rtc.handleSolicitOffer(''), 'base64'));
    const session = rtc.sessions.get(offer.sessionId.toString('hex'));
    const peer = e.peers[0];
    await peer.setRemoteDescription({});
    session.answered = true;
    await rtc.startMedia(session);
    await tick();
    const { tlvEncode } = e.env.load(base + 'hksv-stream-tiers.ts');
    const { tlvDecodeMap } = e.env.load(base + 'hksv-multitier-protocol.ts');
    const reoffer = async negotiate => {
        const set = peer.setRemoteDescription.bind(peer);
        peer.setRemoteDescription = async o => { await set(o); peer.setRemoteDescription = set; negotiate(); };
        const status = tlvDecodeMap(await rtc.handleReoffer(tlvEncode(1, offer.sessionId, 2, Buffer.from('v=0\r\n'))))[3][0];
        await tick();
        return status;
    };
    const update = async () => e.proto.parseWebRTCSessionStatusResponse(await rtc.handleUpdateSession(e.proto.encodeWebRTCUpdateSession({
        sessionId: offer.sessionId, receiveKeysToAdd: [{ kid: 0x51n, key: Buffer.alloc(32, 0x51) }], receiveKidsToRemove: [] }))).status;
    return { e, rtc, session, peer, processes, logs, reoffer, update };
}

test('r40 answers the relay talkback reoffer without restarting media or touching outgoing keys', async () => {
    const m = await mockSession();
    try {
        assert.equal(m.processes.length, 2, 'video and audio forwarders are running');
        assert.equal(await m.update(), 0);
        assert(m.logs.some(l => l.includes('receive direction inactive; status=0')));
        const key = Buffer.from(m.session.sframeConfiguration.key);
        const status = await m.reoffer(() => m.peer.transceivers.push({ kind: 'audio', direction: 'recvonly', sender: { ssrc: 4321 } }));
        assert.equal(status, 0, m.logs.join('\n'));
        assert.equal(m.session.closed, false);
        assert.equal(m.session.answered, true);
        assert.equal(m.processes.length, 2, 'no FFmpeg restart');
        assert(m.processes.every(p => !p.killed), 'running media kept');
        assert(m.session.forwarder && m.session.audioForwarder);
        assert(m.session.sframeConfiguration.key.equals(key));
        assert(m.logs.some(l => l.includes(KEPT)), m.logs.join('\n'));
        assert(!m.logs.some(l => l.includes('reoffer failed')));
        assert.equal(await m.update(), 0, 'receive keys for the talkback stream are accepted');
        assert(m.logs.some(l => l.includes('1 talkback audio receiver(s) accepted (not played); status=0')));
    } finally { m.rtc.closeAllSessions(); }
});

test('r40 still refuses incoming video, receiving on the camera tracks, and talkback without the option', async () => {
    const cases = [
        ['incoming video', {}, m => m.peer.transceivers.push({ kind: 'video', direction: 'recvonly', sender: { ssrc: 4322 } })],
        ['camera audio receiving', {}, m => { m.session.audioTransceiver.currentDirection = 'sendrecv'; }],
        ['talkback without acceptRelayTalkback', { acceptRelayTalkback: false },
            m => m.peer.transceivers.push({ kind: 'audio', direction: 'recvonly', sender: { ssrc: 4323 } })],
    ];
    for (const [name, options, negotiate] of cases) {
        const m = await mockSession(options);
        try {
            assert.equal(await m.reoffer(() => negotiate(m)), 3, name);
            assert.equal(m.session.closed, true, name);
            assert(m.processes.every(p => p.killed), name + ': media stops with the session');
            assert(m.logs.some(l => l.includes('WebRTC receiving media is not supported')), name);
        } finally { m.rtc.closeAllSessions(); }
    }
});

test('r40 restarts media only when a reoffer changes the negotiated send media', async () => {
    const m = await mockSession();
    try {
        m.peer.connectionState = 'connected';
        const status = await m.reoffer(() => {
            m.session.videoTransceiver.sender.codec = { ...m.session.videoTransceiver.sender.codec, payloadType: 100 };
        });
        await tick();
        assert.equal(status, 0, m.logs.join('\n'));
        assert.equal(m.session.closed, false);
        assert(m.processes[0].killed && m.processes[1].killed, 'the old pipeline stops');
        assert.equal(m.processes.length, 4, 'one new video and audio pipeline');
        assert(m.logs.some(l => l.includes('media restarts for the new negotiation')));
    } finally { m.rtc.closeAllSessions(); }
});

function realFixture(options) {
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
    const { buildSensorVideoTiers, tlvEncode } = env.load(base + 'hksv-stream-tiers.ts');
    const { tlvDecodeMap } = env.load(base + 'hksv-multitier-protocol.ts');
    const logs = [];
    const record = (...args) => logs.push(args.join(' '));
    const management = new (env.load(base + 'camera-webrtc.ts').WebRTCStreamManagement)({ addService() {} },
        { log: record, warn: record, error: record }, {
            sensorUuid: Buffer.alloc(16), supportedVideoTiersValue: '', supportedAudioTiersValue: '',
            videoTiers: buildSensorVideoTiers(3840, 2160), ...options,
            getMedia: async () => { throw Error('r40 reoffer test must not open a camera'); },
        });
    management.startMedia = async () => {};
    return { env, werift, LocalPeer, proto, tlvEncode, tlvDecodeMap, management, logs };
}

// The relay's answer declares the RID it receives, as in the r39 field answer.
const relayVideoReceive = sdp => sdp.split(/(?=^m=)/m).map(section => !section.startsWith('m=video ') ? section
    : section.replace(/^a=(?:rid|simulcast):[^\r\n]*\r?\n/gm, '') + 'a=rid:1 recv\r\na=simulcast:recv 1\r\n').join('');

// Shape the added section like the field reoffer: Opus 16 kHz mono, SFrame, two relay SSRCs.
function appleTalkbackSection(sdp) {
    const sections = sdp.split(/(?=^m=)/m);
    const last = sections.length - 1;
    assert.match(sections[last], /^m=audio /);
    const pt = /^m=audio \d+ \S+ (\d+)/.exec(sections[last])[1];
    const ssrc = /^a=ssrc:(\d+) /m.exec(sections[last]);
    sections[last] = sections[last]
        .replace(new RegExp('^a=rtpmap:' + pt + ' opus/48000/2', 'mi'), 'a=rtpmap:' + pt + ' opus/16000/1')
        .replace(new RegExp('^a=fmtp:' + pt + ' [^\\r\\n]*', 'm'), 'a=fmtp:' + pt + ' minptime=20;useinbandfec=0')
        + 'a=sframe\r\n' + (ssrc ? 'a=ssrc:' + ((Number(ssrc[1]) + 1) >>> 0) + ' cname:relay\r\n' : '');
    assert.match(sections[last], /opus\/16000\/1/);
    return sections.join('');
}

test('r40 real werift: the talkback reoffer is answered recvonly and Front video keeps reaching the viewer', { timeout: 40000 }, async () => {
    const f = realFixture({ secureVideoOffer: true, acceptRelayTalkback: true });
    const { RtpPacket, RtpHeader } = f.env.load('../../external/werift/packages/rtp/src/index.ts');
    let remote;
    try {
        const offered = f.proto.parseWebRTCSolicitOfferResponse(Buffer.from(await f.management.handleSolicitOffer(''), 'base64'));
        assert.equal(offered.status, 0, f.logs.join('\n'));
        const session = f.management.sessions.get(offered.sessionId.toString('hex'));
        remote = new f.LocalPeer({ codecs: session.pc.config.codecs, headerExtensions: { video: [f.werift.useSdesRTPStreamId()], audio: [] } });
        const received = [], routeRtp = remote.router.routeRtp;
        remote.router.routeRtp = packet => { received.push(packet); routeRtp(packet); };
        await remote.setRemoteDescription({ type: 'offer', sdp: offered.sdpOffer });
        await remote.setLocalDescription(await remote.createAnswer());
        const answered = await f.management.handleProvideAnswer(f.proto.encodeWebRTCProvideAnswer({
            sessionId: offered.sessionId, sdpAnswer: relayVideoReceive(remote.localDescription.sdp), additionalCandidates: [] }));
        assert.equal(f.proto.parseWebRTCSessionStatusResponse(answered).status, 0, f.logs.join('\n'));
        await until(() => session.pc.connectionState === 'connected' && remote.connectionState === 'connected');
        const sender = session.videoTransceiver.sender;
        const sendVideo = async sequenceNumber => {
            await sender.sendRtp(new RtpPacket(new RtpHeader({ sequenceNumber, timestamp: sequenceNumber * 6000, payloadType: 99 }), Buffer.from([0xc0, 1, 2])));
            await until(() => received.some(p => p.header.sequenceNumber === sequenceNumber && p.header.ssrc === sender.ssrc));
        };
        await sendVideo(60);
        // The media pipeline started for this negotiation is running.
        const running = { killed: false, kill() { this.killed = true; } };
        session.forwarder = running;
        session.mediaSignature = f.management.mediaSignature(session, f.management.mediaSelection(session));

        // The relay reoffers: its video and audio receive sections unchanged, plus talkback it sends.
        remote.getTransceivers().find(t => t.kind === 'video').options.simulcast = [{ rid: '1', direction: 'recv' }];
        const talkback = remote.addTransceiver('audio', { direction: 'sendonly' });
        await remote.setLocalDescription(await remote.createOffer());
        const response = f.tlvDecodeMap(await f.management.handleReoffer(f.tlvEncode(1, offered.sessionId, 2,
            Buffer.from(appleTalkbackSection(remote.localDescription.sdp)))));
        assert.equal(response[3][0], 0, f.logs.join('\n'));
        const reanswer = response[2].toString();
        const sections = reanswer.split(/(?=^m=)/m).filter(section => section.startsWith('m='));
        assert.equal(sections.length, 3);
        assert.match(sections[0], /^m=video /);
        assert.match(sections[0], /^a=sendonly\r?$/m);
        assert.match(sections[1], /^m=audio /);
        assert.match(sections[1], /^a=sendonly\r?$/m);
        assert.match(sections[2], /^m=audio /);
        assert.match(sections[2], /^a=recvonly\r?$/m);
        // werift omits a channel count of 1, as SDP allows.
        assert.match(sections[2], /^a=rtpmap:\d+ opus\/16000(?:\/1)?\r?$/mi);
        assert(response[4], 'reoffer returns the outgoing SFrame configuration');
        assert.equal(session.closed, false);
        assert.equal(running.killed, false, 'running media kept');
        assert.equal(session.pc.getTransceivers().length, 3);
        assert(f.logs.some(l => l.includes(KEPT)), f.logs.join('\n'));

        await remote.setRemoteDescription({ type: 'answer', sdp: reanswer });
        await sendVideo(61);
        const pt = Number(/^m=audio \d+ \S+ (\d+)/m.exec(sections[2])[1]);
        await Promise.resolve().then(() => talkback.sender.sendRtp(new RtpPacket(new RtpHeader({ sequenceNumber: 1, timestamp: 320, payloadType: pt }),
            Buffer.from([1, 2, 3])))).catch(() => {});
        await delay(100);
        assert.equal(session.closed, false, 'viewer talkback packets are ignored');
        const update = f.proto.encodeWebRTCUpdateSession({ sessionId: offered.sessionId,
            receiveKeysToAdd: [{ kid: 0x40n, key: Buffer.alloc(32, 0x40) }], receiveKidsToRemove: [] });
        assert.equal(f.proto.parseWebRTCSessionStatusResponse(await f.management.handleUpdateSession(update)).status, 0);
        await sendVideo(62);
        assert.equal(session.closed, false);
    } finally {
        f.management.closeAllSessions();
        await remote?.close().catch(() => {});
    }
});

test('production HomeKit camera accepts the relay talkback reoffer with the r39 secure video offer', () => {
    const env = environment({ realHap: true });
    const { Accessory } = env.load('./src/hap.ts');
    const { Hksv27Camera } = env.load(base + 'camera-hksv27.ts');
    const camera = new Hksv27Camera(new Accessory('r40 talkback wiring', '00000000-0000-4000-8000-000000000040'), {}, storage(), quiet,
        { sensorClass: '4k', sensorWidth: 3840, sensorHeight: 2160 });
    try {
        assert.equal(camera.webrtc.opts.secureVideoOffer, true);
        assert.equal(camera.webrtc.opts.acceptRelayTalkback, true);
        assert.equal(camera.webrtc.opts.relayVariants, undefined);
    } finally { camera.handleFactoryReset(); }
});
