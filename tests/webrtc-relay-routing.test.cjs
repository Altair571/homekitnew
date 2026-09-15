const test = require('node:test');
const assert = require('node:assert/strict');
const { environment, base, quiet } = require('./helpers.cjs');
const { Receiver } = require('./sframe-receiver.cjs');
const { derive, WireReceiver } = require('./srtp-wire-receiver.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
    const end = Date.now() + 5000;
    while (!check()) {
        if (Date.now() > end) throw Error('Relay routing fixture timed out');
        await delay(10);
    }
}

// Apple's observed answer retains video RID but declines both MID extensions.
// Test actual BUNDLE/SRTP delivery for that combination using synthetic media.
test('independent wire oracle matches RFC 3711 key derivation vectors', () => {
    const key = Buffer.from('e1f97a0d3e018be0d64fa32c06de4139', 'hex');
    const salt = Buffer.from('0ec675ad498afeebb6960b3aabe6', 'hex');
    assert.equal(derive(key, salt, 0, 16).toString('hex'), 'c61e7a93744f39ee10734afe3ff7a087');
    assert.equal(derive(key, salt, 2, 14).toString('hex'), '30cbbc08863d8c85d49db34a9ae1');
    assert.equal(derive(key, salt, 1, 20).toString('hex'), 'cebe321f6ff7716b6fd4ab49af256a156d38baa4');
});

for (const profile of [1, 7]) test('RID-only BUNDLE video and audio independently authenticate on wire, SRTP profile=' + profile, { timeout: 15000 }, async () => {
    const env = environment();
    env.mock('os', { ...require('node:os'), networkInterfaces: () => ({}) });
    const rtcId = '../../external/werift/packages/webrtc/src/index.ts';
    const werift = env.load(rtcId);
    class LocalPeer extends werift.RTCPeerConnection {
        constructor(config) {
            super({ ...config, iceServers: [], iceUseIpv6: false, iceAdditionalHostAddresses: ['127.0.0.1'] });
        }
        addTransceiver(...args) {
            const t = super.addTransceiver(...args);
            t.dtlsTransport.srtpProfiles = [profile];
            t.dtlsTransport.iceTransport.connection.stunServer = undefined;
            return t;
        }
    }
    env.mock(rtcId, { ...werift, RTCPeerConnection: LocalPeer });
    const proto = env.load(base + 'hksv-webrtc-protocol.ts');
    const { RtpHeader, RtpPacket } = env.load('../../external/werift/packages/rtp/src/index.ts');
    const { SFrameRtpSender } = env.load(base + 'hksv-sframe.ts');
    const management = new (env.load(base + 'camera-webrtc.ts').WebRTCStreamManagement)({ addService() {} }, quiet, {
        sensorUuid: Buffer.alloc(16), supportedVideoTiersValue: '', supportedAudioTiersValue: '',
        videoTiers: [{ identifier: 1, quality: 2, width: 320, height: 180, frameRate: 15, averageBitrateKbps: 180 }],
        getMedia: async () => { throw Error('Synthetic routing fixture must not open a camera'); },
    });
    management.startMedia = async () => {};
    let remote, videoSframe, audioSframe;
    try {
        const offer = proto.parseWebRTCSolicitOfferResponse(Buffer.from(await management.handleSolicitOffer(''), 'base64'));
        const session = management.sessions.get(offer.sessionId.toString('hex'));
        const received = { video: [], audio: [] };
        remote = new LocalPeer({ codecs: session.pc.config.codecs,
            headerExtensions: { video: [werift.useSdesRTPStreamId()], audio: [] } });
        remote.onTrack.subscribe(track => track.onReceiveRtp.subscribe(packet => received[track.kind].push(packet)));
        await remote.setRemoteDescription({ type: 'offer', sdp: offer.sdpOffer });
        await remote.setLocalDescription(await remote.createAnswer());
        assert.doesNotMatch(remote.localDescription.sdp, /urn:ietf:params:rtp-hdrext:sdes:mid/);
        assert.match(remote.localDescription.sdp, /a=extmap:3 urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id/);
        const answer = await management.handleProvideAnswer(proto.encodeWebRTCProvideAnswer({
            sessionId: offer.sessionId, sdpAnswer: remote.localDescription.sdp, additionalCandidates: [],
        }));
        assert.equal(proto.parseWebRTCSessionStatusResponse(answer).status, 0);
        await until(() => session.pc.connectionState === 'connected' && remote.connectionState === 'connected');
        assert.equal(session.pc.dtlsTransports.length, 1);
        const transport = remote.dtlsTransports[0];
        assert.equal(transport.dtls.srtp.srtpProfile, profile);
        const { remoteKey, remoteSalt } = transport.dtls.extractSessionKeys(16, profile === 7 ? 12 : 14);
        const oracle = new WireReceiver(remoteKey, remoteSalt, profile);
        const wire = [], wireErrors = [];
        transport.iceTransport.connection.onData.subscribe(data => {
            if (data[0] >>> 6 !== 2 || ![99, 110].includes(data[1] & 127)) return;
            try { wire.push({ encrypted: Buffer.from(data), clear: oracle.read(data) }); }
            catch (error) { wireErrors.push(error); }
        });
        const { key, kid } = offer.sframeConfiguration;
        videoSframe = new SFrameRtpSender(key, kid, session.videoTransceiver.sender.ssrc, true, 1000);
        audioSframe = new SFrameRtpSender(key, kid, session.audioTransceiver.sender.ssrc, false);
        const nal = Buffer.concat([Buffer.from([38, 1]), Buffer.alloc(1800, 42)]);
        const opus = Buffer.from([0xf8, 0xff, 0xfe]);
        const packet = (pt, data) => new RtpPacket(new RtpHeader({
            version: 2, payloadType: pt, sequenceNumber: 7, timestamp: 90000, ssrc: 44, marker: true,
        }), data);
        const fragments = videoSframe.push(packet(99, nal));
        assert.equal(fragments.length, 2);
        for (const fragment of fragments) session.vtrack.writeRtp(fragment);
        for (const p of audioSframe.push(packet(110, opus))) session.atrack.writeRtp(p);
        await until(() => received.video.length === 2 && received.audio.length === 1);
        if (session.wire) {
            await until(() => session.wire.snapshot().video.sendCompletions === 2
                && session.wire.snapshot().audio.sendCompletions === 1);
            const observed = session.wire.snapshot();
            assert.ok(observed.installedUdpTransports >= 1);
            assert.equal(observed.video.rtpCalls, 2);
            assert.equal(observed.audio.rtpCalls, 1);
            assert.equal(observed.video.sendErrors + observed.audio.sendErrors, 0);
            assert.equal(observed.video.unexpectedSsrc + observed.audio.unexpectedSsrc, 0);
            assert.equal(observed.video.pendingSends + observed.audio.pendingSends, 0);
        }
        assert.equal(wireErrors.length, 0, wireErrors[0]?.message);
        assert.equal(wire.length, 3);
        for (const { encrypted, clear } of wire) {
            const routed = received[clear.payloadType === 99 ? 'video' : 'audio'].find(p => p.header.sequenceNumber === clear.seq);
            assert.deepEqual(clear.payload, routed.payload);
            if (clear.payloadType === 99) {
                assert.equal(clear.header.length, 20);
                assert.equal(clear.header.subarray(12).toString('hex'), 'bede000130310000');
            } else assert.equal(clear.header.length, 12);
            const corrupted = Buffer.from(encrypted); corrupted[corrupted.length - 1] ^= 1;
            assert.throws(() => new WireReceiver(remoteKey, remoteSalt, profile).read(corrupted));
        }
        for (const p of received.video) {
            assert.equal(p.header.payloadType, 99);
            assert.equal(p.header.ssrc, session.videoTransceiver.sender.ssrc);
            assert.equal(p.header.extensions.length, 1);
            assert.equal(p.header.extensions[0].id, 3);
            assert.equal(p.header.extensions[0].payload.toString(), '1');
        }
        assert.equal(received.audio[0].header.extensions.length, 0);
        const receiver = new Receiver(offer.sframeConfiguration, 6);
        assert.equal(receiver.push(received.video[0]), undefined);
        const length = Buffer.alloc(4); length.writeUInt32BE(nal.length);
        assert.deepEqual(receiver.push(received.video[1]), Buffer.concat([length, nal]));
        assert.deepEqual(new Receiver(offer.sframeConfiguration, 8).push(received.audio[0]), opus);
    } finally {
        videoSframe?.close(); audioSframe?.close();
        management.closeAllSessions();
        await remote?.close();
    }
});
