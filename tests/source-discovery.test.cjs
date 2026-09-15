const test = require('node:test');
const assert = require('node:assert/strict');
const { environment, base, quiet, storage } = require('./helpers.cjs');
const { camera, ffmpeg } = require('./rtsp-stalled-audio.cjs');
const discoveryId = base + 'hksv-source-discovery.ts';
const probeId = base + 'hksv-video-probe.ts';
const mainVideo = { codec: 'h265', width: 3840, height: 2160, fps: 30 };

test('valid stream options retain the largest native tier without opening a stream', async () => {
    let opens = 0;
    const device = { async getVideoStreamOptions() { return [
        { id: 'sub', video: { width: 1920, height: 1080 } }, { id: 'main', video: mainVideo },
    ]; }, async getVideoStream() { opens++; } };
    const actual = await environment().load(discoveryId).discoverHksvCameraSource(device, quiet);
    assert.equal(actual.width, 3840); assert.equal(actual.fps, 30); assert.equal(opens, 0);
});

test('camera API failure recovers native descriptor dimensions without requesting conversion', async () => {
    const calls = [], env = environment({ mediaManager: { async convertMediaObjectToJSON(media) { return media; } } });
    const device = { async getVideoStreamOptions() { throw new Error('statusCode 404'); },
        async getVideoStream(request) { calls.push(request); return { mediaStreamOptions: { id: 'main', video: mainVideo } }; } };
    const actual = await env.load(discoveryId).discoverHksvCameraSource(device, quiet);
    assert.equal(actual.width, 3840); assert.equal(calls.length, 1);
    assert.equal(calls[0].adaptive, false); assert.equal(calls[0].audio, null);
    assert.equal(Object.keys(calls[0].video).length, 0);
});

test('probed stream dimensions guide later native selection when the provider defaults to its substream', async () => {
    const requests = [], env = environment({ mediaManager: { async convertMediaObjectToJSON(media) { return media; } } });
    env.mock(probeId, { async probeVideoRate(input) {
        return input.mediaStreamOptions.id === 'main' ? mainVideo : { ...mainVideo, width: 1920, height: 1080 };
    } });
    const device = { async getVideoStreamOptions() { return [{ id: 'sub', video: {} }, { id: 'main', video: {} }]; },
        async getVideoStream(request) { requests.push(request); return { mediaStreamOptions: { id: request.id || 'sub', video: {} } }; } };
    assert.equal((await env.load(discoveryId).discoverHksvCameraSource(device, quiet)).width, 3840);
    await env.load(base + 'hksv-media.ts').getNativeHksvVideoStream(device, { video: mainVideo });
    assert.equal(requests.at(-1).id, 'main');
    assert.equal(requests.at(-1).adaptive, false);
    assert.equal(Object.keys(requests.at(-1).video).length, 0);
});

async function accessoryFixture(available, hevcEnabled = true) {
    const messages = [], log = { ...quiet, warn(...x) { messages.push(x.join(' ')); }, error(...x) { messages.push(x.join(' ')); }, log(...x) { messages.push(x.join(' ')); } };
    const env = environment({ realHap: true, mediaManager: { async convertMediaObjectToJSON(media) { return media; } } });
    const hap = env.load('./src/hap.ts');
    const acc = new hap.Accessory('Front', '00000000-0000-4000-8000-000000001111');
    const state = storage({ streamHevc4k: String(hevcEnabled), hksv27DisabledServices: JSON.stringify(['Legacy Recording Config', 'Legacy RTP Live View']) });
    const sdk = env.load('../../sdk/dist/src/index.js').default;
    sdk.deviceManager.getMixinConsole = () => log;
    sdk.deviceManager.getMixinStorage = () => state;
    let handler, modern;
    env.mock('./src/common.ts', { addSupportedType(type) { handler = type; } });
    env.mock('./src/types/common.ts', { makeAccessory() { return acc; } });
    env.mock(base + 'camera-streaming.ts', { createCameraStreamingDelegate() { return {}; } });
    env.mock(base + 'camera-recording.ts', { iframeIntervalSeconds: 4 });
    env.mock(base + 'camera-utils.ts', { FORCE_OPUS: true });
    env.mock(probeId, { async probeVideoRate() { return available ? mainVideo : undefined; } });
    const api = env.load(base + 'camera-hksv27.ts');
    env.mock(base + 'camera-hksv27.ts', { enableHksv27Camera(...args) { modern = api.enableHksv27Camera(...args); return modern; } });
    env.load('./src/types/camera.ts');
    const device = { id: 'front', name: 'Front', interfaces: ['VideoCamera'],
        async getVideoStreamOptions() { return [{ id: 'main', video: {} }]; },
        async getVideoStream() { return { mediaStreamOptions: { id: 'main', video: {} } }; } };
    const result = await handler.getAccessory(device, {});
    return { result, hap, modern, messages };
}

test('actual accessory construction recovers missing dimensions and Run 12 removes all legacy RTP services', async () => {
    const f = await accessoryFixture(true);
    try {
        assert(f.modern);
        assert.equal(f.modern.multiTier.videoTiers[0].width, 3840);
        assert.equal(f.modern.multiTier.videoTiers[0].height, 2160);
        assert.equal(f.modern.multiTier.videoTiers[0].frameRate, 30);
        assert(f.result.services.includes(f.modern.multiTier.service));
        assert(!f.result.services.some(s => s.UUID === f.hap.Service.CameraRTPStreamManagement.UUID));
        assert(f.messages.some(l => l.includes('legacy RTP live-view services removed')));
    } finally { f.modern?.handleFactoryReset(); }
});

test('unavailable native dimensions never invent 4K or remove the working legacy service', async () => {
    const f = await accessoryFixture(false);
    assert.equal(f.modern, undefined);
    assert(f.result.services.some(s => s.UUID === f.hap.Service.CameraRTPStreamManagement.UUID));
    assert(f.messages.some(l => l.includes('Camera dimensions unavailable') && l.includes('legacy services retained')));
});

test('HEVC-disabled cameras retain legacy services and receive the same stream diagnostics', async () => {
    const f = await accessoryFixture(false, false);
    assert.equal(f.modern, undefined);
    assert.equal(f.result.services.filter(s => s.UUID === f.hap.Service.CameraRTPStreamManagement.UUID).length, 8);
    assert(f.messages.some(s => s.includes('HEVC option=false; legacy RTP=8; multi-tier RTP=0; WebRTC=0')));
});

test('late provider completion after discovery timeout cannot launch a probe', { timeout: 6000 }, async () => {
    let finish, probes = 0;
    const env = environment({ mediaManager: { async convertMediaObjectToJSON(media) { return media; } } });
    env.mock(probeId, { async probeVideoRate() { probes++; return mainVideo; } });
    const pending = env.load(discoveryId).discoverHksvCameraSource({
        async getVideoStreamOptions() { return [{ id: 'main', video: {} }]; },
        async getVideoStream() { return new Promise(resolve => { finish = resolve; }); },
    }, quiet);
    await assert.rejects(pending, /Camera dimensions unavailable/);
    finish({ mediaStreamOptions: { id: 'main', video: {} } });
    await new Promise(setImmediate);
    assert.equal(probes, 0);
});

test('real native RTSP headers recover dimensions when camera configuration metadata is absent', { timeout: 10000 }, async () => {
    const source = await camera({ singleClient: true, fps: 30 });
    const env = environment({ mediaManager: { async convertMediaObjectToJSON(media) { return media; }, async getFFmpegPath() { return ffmpeg; } } });
    try {
        const video = await env.load(discoveryId).discoverHksvCameraSource({
            async getVideoStreamOptions() { return [{ id: 'main', video: {} }]; },
            async getVideoStream() { return { ...source.input, mediaStreamOptions: { id: 'main', video: {} } }; },
        }, quiet);
        assert.equal(video.codec, 'h265'); assert.equal(video.width, 320); assert.equal(video.height, 180); assert.equal(video.fps, 30);
        assert.equal(source.connections, 1);
        assert.equal(source.audioSetups, 0);
    } finally { await source.close(); }
});
