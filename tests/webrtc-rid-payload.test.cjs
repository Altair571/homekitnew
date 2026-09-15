const test = require('node:test');
const assert = require('node:assert/strict');
const { environment, base } = require('./helpers.cjs');
const { withExplicitVideoRidPayload, readVideoRidLimits, WebRTCStreamManagement } = environment().load(base + 'camera-webrtc.ts');

test('video dimensions are explicit without adding a bitrate promise or changing other media', () => {
    const input = 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 99\r\na=rtpmap:99 H265/90000\r\na=rid:1 send\r\n'
        + 'm=audio 9 UDP/TLS/RTP/SAVPF 110\r\na=rid:1 send\r\n';
    const result = withExplicitVideoRidPayload(input, { width: 3840, height: 2160, frameRate: 30 });
    assert.equal(result, input.replace('a=rid:1 send\r\n',
        'a=rid:1 send pt=99;max-width=3840;max-height=2160;max-fps=30\r\n'));
    assert.doesNotMatch(result, /max-br/);
});

test('receiver RID limits select a fitting advertised tier and reject an impossible size', () => {
    const tiers = [
        { width: 3840, height: 2160, frameRate: 30 },
        { width: 1280, height: 720, frameRate: 30 },
        { width: 640, height: 360, frameRate: 15 },
    ];
    const manager = Object.create(WebRTCStreamManagement.prototype);
    manager.opts = { videoTiers: tiers };
    const session = {
        videoTransceiver: { sender: { codec: { mimeType: 'video/H265', parameters: 'level-id=153' } } },
        audioTransceiver: { sender: { codec: { mimeType: 'audio/opus', clockRate: 48000 } } },
        videoRidLimits: readVideoRidLimits('v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 99\r\n'
            + 'a=rid:1 recv pt=99;max-width=1280;max-height=720;max-fps=15\r\n'),
    };
    assert.equal(manager.mediaSelection(session).tier, tiers[2]);
    session.videoRidLimits = { width: 100 };
    assert.throws(() => manager.mediaSelection(session), /No advertised tier/);
});

test('RID parsing ignores audio, other identifiers and send direction, but fails closed on invalid caps', () => {
    for (const rid of ['a=rid:1 send max-height=180', 'a=rid:2 recv max-height=180']) {
        assert.equal(Object.keys(readVideoRidLimits('m=video 9 UDP/TLS/RTP/SAVPF 99\n' + rid + '\n'
            + 'm=audio 9 UDP/TLS/RTP/SAVPF 110\na=rid:1 recv max-width=1\n')).length, 0);
    }
    for (const limit of ['0', '-1', 'NaN', '999999999999999999999999999999999999999e999']) {
        assert.throws(() => readVideoRidLimits('m=video 9 UDP/TLS/RTP/SAVPF 99\n'
            + 'a=rid:1 recv max-height=' + limit + '\n'), /Invalid remote video RID limit/);
    }
});

test('wire RID explicitly selects HEVC without changing bundled audio, ICE or DTLS', () => {
    const sdp = [
        'v=0', 'a=group:BUNDLE 0 1',
        'm=video 9 UDP/TLS/RTP/SAVPF 99', 'a=mid:0', 'a=sendonly',
        'a=rtpmap:99 H265/90000', 'a=fmtp:99 profile-id=1;level-id=153',
        'a=rid:1 send', 'a=simulcast:send 1', 'a=setup:actpass',
        'a=ice-ufrag:fixture', 'a=ice-pwd:fixture-only',
        'm=audio 9 UDP/TLS/RTP/SAVPF 110', 'a=mid:1', 'a=rtpmap:110 opus/48000/2',
        'a=rid:1 send', '',
    ].join('\r\n');
    const result = withExplicitVideoRidPayload(sdp);
    assert.equal(result, sdp.replace('a=rid:1 send\r\n', 'a=rid:1 send pt=99\r\n'));
    assert.equal(withExplicitVideoRidPayload(result), result);
});

test('a reoffer uses its selected payload number and preserves existing RID restrictions', () => {
    const sdp = 'v=0\nm=video 9 UDP/TLS/RTP/SAVPF 107\na=rtpmap:107 H265/90000\na=rid:1 send\n';
    assert.match(withExplicitVideoRidPayload(sdp), /^a=rid:1 send pt=107$/m);
    const restricted = sdp.replace('a=rid:1 send', 'a=rid:1 send pt=107;max-fps=15');
    assert.equal(withExplicitVideoRidPayload(restricted), restricted);
});

test('wire mapping never invents a RID or binds an unoffered or different codec', () => {
    for (const [formats, codec, rid] of [
        ['99', 'H265', ''], ['98', 'H265', 'a=rid:1 send'],
        ['99', 'H264', 'a=rid:1 send'], ['99', 'H265', 'a=rid:2 send'],
        ['99', 'H265', 'a=rid:1 recv'],
    ]) {
        const sdp = `v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF ${formats}\r\na=rtpmap:99 ${codec}/90000\r\n${rid}\r\n`;
        assert.equal(withExplicitVideoRidPayload(sdp), sdp);
    }
});
