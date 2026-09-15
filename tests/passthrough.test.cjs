const test = require('node:test');
const assert = require('node:assert/strict');
const { environment, storage, base, quiet } = require('./helpers.cjs');

test('4K HEVC passthrough tolerates unreported bitrate but explains real mismatches', () => {
    const { videoCopyDecision } = environment().load(base + 'hksv-media.ts');
    const tier = { width: 3840, height: 2160, frameRate: 30, averageBitrateKbps: 4500 };
    const source = { codec: 'h265', width: 3840, height: 2160, fps: 30 };
    const decision = changes => videoCopyDecision({ mediaStreamOptions: { video: { ...source, ...changes } } }, 'h265', tier);
    assert.equal(decision({}).copy, true);
    assert.match(decision({}).reason, /bitrate unreported/);
    assert.equal(decision({ bitrate: 0 }).copy, true);
    assert.equal(decision({ bitrate: 4500000 }).copy, true);
    assert.equal(decision({ codec: 'hevc' }).copy, true);
    for (const [change, reason] of [
        [{ bitrate: 6000000 }, /6000 kbps exceeds requested 4500/],
        [{ fps: 25 }, /25 does not match 30/],
        [{ fps: undefined }, /frame rate unknown/],
        [{ width: 1920, height: 1080 }, /1920x1080/],
        [{ width: undefined }, /dimensions/],
        [{ codec: 'h264' }, /codec h264/],
    ]) {
        assert.equal(decision(change).copy, false);
        assert.match(decision(change).reason, reason);
    }
    assert.equal(videoCopyDecision({ mediaStreamOptions: { video: { ...source, fps: 24 } } }, 'h265', { ...tier, frameRate: 24 }).copy, true);
});

test('native stream selection prefers a matching HEVC source without requesting upstream conversion', async () => {
    const { getNativeHksvVideoStream } = environment().load(base + 'hksv-media.ts');
    const video = { codec: 'h265', width: 3840, height: 2160, fps: 30 };
    const options = { destination: 'local', container: 'rtsp', adaptive: true, tool: 'ffmpeg',
        video: { ...video, bitrate: 4500000 }, audio: { codec: 'opus' } };
    const result = await getNativeHksvVideoStream({
        async getVideoStreamOptions() { return [
            { id: 'h264', video: { ...video, codec: 'h264' } },
            { id: '25fps', video: { ...video, fps: 25 } },
            { id: 'native', video },
        ]; },
        async getVideoStream(request) { return request; },
    }, options);
    assert.equal(result.id, 'native');
    assert.equal(result.adaptive, false); assert.equal(result.tool, undefined);
    assert.equal(Object.keys(result.video).length, 0);
    assert.equal(Object.keys(result.audio).length, 0);
    assert.equal(options.video.bitrate, 4500000, 'caller constraints remain unchanged');
});

test('24 fps is advertised for native 4K/2K high tiers while medium stays 30 fps', () => {
    const api = environment().load(base + 'hksv-stream-tiers.ts');
    for (const [width, height] of [[3840, 2160], [2560, 1440], [2160, 3840]]) {
        const tiers = api.buildSensorVideoTiers(width, height, 24);
        assert.deepEqual(Array.from(tiers, t => t.frameRate), [24, 30, 15]);
        for (const rate of [undefined, 25, 30])
            assert.deepEqual(Array.from(api.buildSensorVideoTiers(width, height, rate), t => t.frameRate), [30, 30, 15]);
    }
    assert.equal(api.buildSensorVideoTiers(1920, 1080, 24)[0].frameRate, 30);
    for (const sensor of ['4k', '2k'])
        assert.deepEqual(Array.from(api.buildHksvVideoTiers(sensor, { frameRate: 24 }), t => t.frameRate), [24, 30, 15]);
});

test('the HAP camera surface propagates a native 24 fps tier to RTP and WebRTC advertisements', () => {
    const env = environment({ realHap: true });
    const { Accessory } = env.load('./src/hap.ts');
    const { Hksv27Camera } = env.load(base + 'camera-hksv27.ts');
    const accessory = new Accessory('Native HEVC', '00000000-0000-4000-8000-000000000024');
    const camera = new Hksv27Camera(accessory, {}, storage(), quiet, {
        sensorClass: '4k', sensorWidth: 3840, sensorHeight: 2160, frameRate: 24,
    });
    try {
        assert.equal(camera.multiTier.videoTiers[0].frameRate, 24);
        assert.equal(camera.multiTier.videoTiers[1].frameRate, 30);
        assert.equal(camera.webrtc.opts.videoTiers[0].frameRate, 24);
    } finally { camera.handleFactoryReset(); }
});
