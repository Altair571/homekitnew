const test = require('node:test');
const assert = require('node:assert/strict');
const { environment, base, quiet } = require('./helpers.cjs');
const { rtcEnvironment } = require('./webrtc-helpers.cjs');
const { withSFramePacketization } = environment().load(base + 'camera-webrtc.ts');

const media = newline => ['v=0', 'a=group:BUNDLE 0 1',
    'm=video 9 UDP/TLS/RTP/SAVPF 99', 'a=mid:0', 'a=sendonly', 'a=rtpmap:99 H265/90000',
    'm=audio 9 UDP/TLS/RTP/SAVPF 110', 'a=mid:1', 'a=sendonly', 'a=rtpmap:110 opus/48000/2', ''].join(newline);

test('SFrame indication is media-scoped, idempotent, and absent from plain RTP offers', () => {
    for (const newline of ['\r\n', '\n']) {
        const input = media(newline), output = withSFramePacketization(input, true);
        assert.equal(withSFramePacketization(input, false), input);
        assert.equal(output.split('a=sframe' + newline).length - 1, 2);
        assert.equal(output.replaceAll('a=sframe' + newline, ''), input);
        assert.equal(withSFramePacketization(output, true), output);
        assert(!output.split('m=video')[0].includes('a=sframe'));
    }
});

test('SFrame indication does not activate rejected, inactive, or application sections', () => {
    const input = 'v=0\r\nm=video 0 UDP/TLS/RTP/SAVPF 99\r\n'
        + 'm=audio 9 UDP/TLS/RTP/SAVPF 110\r\na=inactive\r\n'
        + 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n';
    assert.equal(withSFramePacketization(input, true), input);
});

test('HomeKit offer and reoffer response use the authenticated SFrame selection', async () => {
    for (const encrypted of [true, false]) {
        const e = rtcEnvironment();
        const manager = new e.Class({ addService() {} }, quiet, e.opts);
        // Exercise actual management lifecycle with synthetic SDP and no sockets/media.
        const prototype = e.env.load('../../external/werift/packages/webrtc/src/index.ts').RTCPeerConnection.prototype;
        prototype.createOffer = async () => ({ type: 'offer', sdp: media('\r\n') });
        prototype.createAnswer = async () => ({ type: 'answer', sdp: media('\r\n') });
        try {
            const offer = e.proto.parseWebRTCSolicitOfferResponse(Buffer.from(await manager.handleSolicitOffer(
                e.proto.encodeWebRTCSolicitOffer({ sframeEnabled: encrypted }).toString('base64')), 'base64'));
            assert.equal(offer.status, 0);
            assert.equal((offer.sdpOffer.match(/^a=sframe\r?$/mg) || []).length, encrypted ? 2 : 0);
            const tlv = e.env.load(base + 'hksv-stream-tiers.ts').tlvEncode;
            const map = e.env.load(base + 'hksv-multitier-protocol.ts').tlvDecodeMap;
            const reoffer = map(await manager.handleReoffer(tlv(1, offer.sessionId, 2, Buffer.from(media('\r\n')))));
            assert.equal(reoffer[3][0], 0);
            assert.equal((reoffer[2].toString().match(/^a=sframe\r?$/mg) || []).length, encrypted ? 2 : 0);
            assert.equal(e.media.length, 0);
        } finally { manager.closeAllSessions(); }
    }
});
