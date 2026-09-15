const test = require('node:test');
const assert = require('node:assert/strict');
const { environment, base, quiet } = require('./helpers.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
    const end = Date.now() + 5000;
    while (!check()) {
        if (Date.now() > end) throw Error('RID negotiation fixture timed out');
        await delay(10);
    }
}

for (const acceptRid of [true, false]) test(acceptRid
    ? 'video RID survives the answer and a remote reoffer'
    : 'an answer declining RTP extensions receives no unnegotiated headers', { timeout: 15000 }, async () => {
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
    const { tlvEncode, buildSensorVideoTiers } = env.load(base + 'hksv-stream-tiers.ts');
    const { tlvDecodeMap } = env.load(base + 'hksv-multitier-protocol.ts');
    const { RtpPacket, RtpHeader } = env.load('../../external/werift/packages/rtp/src/index.ts');
    const management = new (env.load(base + 'camera-webrtc.ts').WebRTCStreamManagement)({ addService() {} }, quiet, {
        sensorUuid: Buffer.alloc(16), supportedVideoTiersValue: '', supportedAudioTiersValue: '',
        videoTiers: buildSensorVideoTiers(3840, 2160),
        getMedia: async () => { throw Error('Header negotiation test must not open a camera'); },
    });
    management.startMedia = async () => {};
    let remote;
    try {
        const offered = proto.parseWebRTCSolicitOfferResponse(Buffer.from(await management.handleSolicitOffer(''), 'base64'));
        assert.equal(offered.status, 0);
        assert.match(offered.sdpOffer, /^a=rid:1 send pt=99;max-width=640;max-height=360;max-fps=15\r?$/m);
        const session = management.sessions.get(offered.sessionId.toString('hex'));
        const assertSenderDeclarations = sdp => {
            const sections = sdp.split(/(?=^m=)/m);
            for (const kind of ['video', 'audio']) {
                const section = sections.find(s => s.startsWith(`m=${kind} `));
                const sender = session[kind + 'Transceiver'].sender;
                const declared = [...section.matchAll(/^a=ssrc:(\d+)\s/gm)].map(m => Number(m[1]));
                assert(declared.includes(sender.ssrc), `${kind} SDP must declare the actual sender SSRC; the relay rejected r33 without it`);
            }
        };
        assertSenderDeclarations(offered.sdpOffer);
        const midIds = [...offered.sdpOffer.matchAll(/^a=extmap:(\d+) urn:ietf:params:rtp-hdrext:sdes:mid\r?$/gm)].map(m => m[1]);
        assert.equal(midIds.length, 2);
        assert.equal(new Set(midIds).size, 1, 'audio and video keep the same MID extension ID');
        const received = [];
        remote = new LocalPeer({
            codecs: session.pc.config.codecs,
            headerExtensions: {
                video: acceptRid ? [werift.useSdesMid(), werift.useSdesRTPStreamId()] : [],
                audio: [],
            },
        });
        // Observe decrypted SRTP before track routing: the bundled receiver
        // cannot route a RID-advertised track when it declines the extension.
        // The live media test separately verifies normal track delivery.
        const routeRtp = remote.router.routeRtp;
        remote.router.routeRtp = packet => {
            received.push(packet);
            routeRtp(packet);
        };
        await remote.setRemoteDescription({ type: 'offer', sdp: offered.sdpOffer });
        await remote.setLocalDescription(await remote.createAnswer());
        const response = await management.handleProvideAnswer(proto.encodeWebRTCProvideAnswer({
            sessionId: offered.sessionId, sdpAnswer: remote.localDescription.sdp, additionalCandidates: [],
        }));
        assert.equal(proto.parseWebRTCSessionStatusResponse(response).status, 0);
        await until(() => session.pc.connectionState === 'connected' && remote.connectionState === 'connected');
        const sender = session.videoTransceiver.sender;
        const send = async sequenceNumber => {
            await sender.sendRtp(new RtpPacket(new RtpHeader({ sequenceNumber, timestamp: sequenceNumber * 3000, payloadType: 99 }), Buffer.from([38, 1, 128])));
            await until(() => received.some(packet => packet.header.sequenceNumber === sequenceNumber));
            const packet = received.find(packet => packet.header.sequenceNumber === sequenceNumber);
            assert.equal(packet.header.ssrc, sender.ssrc, 'actual RTP uses the SSRC declared in SDP');
            if (acceptRid) {
                const ext = sender.headerExtensions.find(e => e.uri.endsWith(':rtp-stream-id'));
                assert.equal(packet.header.extensions.find(e => e.id === ext.id)?.payload.toString(), '1');
            } else assert.equal(packet.header.extensions.length, 0, 'unnegotiated extensions must not be emitted');
        };
        await send(10);
        if (!acceptRid) return;
        // Exercise the real bundled prepareSend reset during remote reoffer.
        remote.getTransceivers().find(t => t.kind === 'video').options.simulcast = [{ rid: '1', direction: 'recv' }];
        await remote.setLocalDescription(await remote.createOffer());
        const reanswer = tlvDecodeMap(await management.handleReoffer(tlvEncode(1, offered.sessionId, 2, Buffer.from(remote.localDescription.sdp))));
        assert.equal(reanswer[3][0], 0);
        assert.match(reanswer[2].toString(), /^a=rid:1 send pt=99;max-width=640;max-height=360;max-fps=15\r?$/m);
        assertSenderDeclarations(reanswer[2].toString());
        await remote.setRemoteDescription({ type: 'answer', sdp: reanswer[2].toString() });
        assert.equal(session.closed, false);
        await send(11);
    } finally {
        management.closeAllSessions();
        await remote?.close();
    }
});
