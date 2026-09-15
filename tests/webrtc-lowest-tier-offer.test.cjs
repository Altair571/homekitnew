const test = require('node:test');
const assert = require('node:assert/strict');
const { environment, base, quiet, storage } = require('./helpers.cjs');

test('offer declares the lowest advertised tier instead of a 4K-sized RID', { timeout: 15000 }, async () => {
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
        getMedia: async () => { throw Error('Offer test must not open a camera'); },
    });
    management.startMedia = async () => {};
    try {
        const offered = proto.parseWebRTCSolicitOfferResponse(Buffer.from(await management.handleSolicitOffer(''), 'base64'));
        assert.equal(offered.status, 0);
        const video = offered.sdpOffer.split(/(?=^m=)/m).find(section => section.startsWith('m=video'));
        assert.match(video, /^a=rid:1 send pt=99;max-width=640;max-height=360;max-fps=15\r?$/m);
        assert.equal((video.match(/^a=rid:/mg) || []).length, 1);
        assert.doesNotMatch(offered.sdpOffer, /max-width=3840|max-width=1920/);
    } finally {
        management.closeAllSessions();
    }
});

test('media selection sends the declared lowest tier for remote and LAN sessions', () => {
    const env = environment();
    const { buildSensorVideoTiers, CameraVideoQuality } = env.load(base + 'hksv-stream-tiers.ts');
    const { WebRTCStreamManagement, readVideoRidLimits } = env.load(base + 'camera-webrtc.ts');
    const manager = Object.create(WebRTCStreamManagement.prototype);
    manager.opts = { videoTiers: buildSensorVideoTiers(3840, 2160) };
    const session = (remote, videoRidLimits = {}) => ({
        remote, videoRidLimits,
        videoTransceiver: { sender: { codec: { mimeType: 'video/H265', parameters: 'level-id=153' } } },
        audioTransceiver: { sender: { codec: { mimeType: 'audio/opus', clockRate: 48000 } } },
    });
    for (const setting of ['High', 'Medium', 'Low', null]) {
        manager.storage = storage(setting ? { hksv27WebRTCRemoteQuality: setting } : {});
        for (const remote of [true, false]) {
            const { tier } = manager.mediaSelection(session(remote));
            assert.equal(tier.quality, CameraVideoQuality.LOW);
            assert.deepEqual([tier.width, tier.height, tier.frameRate, tier.averageBitrateKbps], [640, 360, 15, 180]);
        }
    }
    const echoed = readVideoRidLimits('m=video 9 UDP/TLS/RTP/SAVPF 99\r\na=rid:1 recv pt=99;max-width=640;max-height=360;max-fps=15\r\n');
    assert.equal(manager.mediaSelection(session(true, echoed)).tier.width, 640);
});
