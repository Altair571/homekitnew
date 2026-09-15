const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { environment, base, quiet, storage, never } = require('./helpers.cjs');
const { camera, ffmpeg } = require('./rtsp-stalled-audio.cjs');
const probeId = base + 'hksv-video-probe.ts';
const tier = { width: 3840, height: 2160, frameRate: 30, averageBitrateKbps: 4500 };
const input = { container: 'rtsp', inputArguments: ['-i', 'rtsp://example.invalid/camera'],
    mediaStreamOptions: { id: 'main', video: { codec: 'h265', width: 3840, height: 2160, fps: 25 } } };
const description = fps => `Input #0, rtsp, from 'rtsp://secret.invalid/':\n  Stream #0:0: Video: hevc (Main), yuv420p(tv), 3840x2160, ${fps} fps, ${fps} tbr, 90k tbn\nStream mapping:\nOutput #0, rtp:\n  Stream #0:0: Video: hevc, 3840x2160, 30 fps\n`;
function cancel() { let stop; const c = { killed: false, killPromise: new Promise(r => stop = r), kill() { this.killed = true; stop(); } }; return c; }

test('rate probe reads input frame rate and never mistakes the output encoder rate for input', () => {
    const { parseInputVideoDescription, needsVideoRateProbe } = environment().load(probeId);
    assert.equal(parseInputVideoDescription(description(25)).fps, 25);
    assert.equal(parseInputVideoDescription(description(30)).fps, 30);
    assert.equal(parseInputVideoDescription(description(25).replace('25 fps, ', '')), undefined);
    assert.equal(needsVideoRateProbe(input, 'h265', tier), true);
    for (const video of [ { fps: 30 }, { bitrate: 6000000 }, { width: 1920 }, { codec: 'h264' } ])
        assert.equal(needsVideoRateProbe({ ...input, mediaStreamOptions: { ...input.mediaStreamOptions,
            video: { ...input.mediaStreamOptions.video, ...video } } }, 'h265', tier), false);
});

function mockedProbe(response, stalled = false) {
    const env = environment({ mediaManager: { getFFmpegPath: async () => 'ffmpeg' } });
    const cp = new EventEmitter(); cp.stderr = new EventEmitter(); cp.pid = 1; cp.exitCode = null;
    let killed = 0;
    env.mock('../../common/src/media-helpers.ts', { safeKillFFmpeg() { killed++; cp.exitCode = 0; } });
    env.mock('child_process', { spawn() {
        if (!stalled) queueMicrotask(() => { cp.stderr.emit('data', Buffer.from(response)); cp.exitCode = 0; cp.emit('close', 0); });
        return cp;
    } });
    return { env, cp, get killed() { return killed; } };
}

test('verified 30 fps replaces stale 25 fps metadata; real 25 fps and changed sources stay incompatible', async () => {
    for (const [actualRate, id, expectedRate] of [[30, 'main', 30], [25, 'main', 25], [30, 'different', 25]]) {
        const { env } = mockedProbe(description(actualRate)); let requests = 0;
        const fresh = { ...input, mediaStreamOptions: { ...input.mediaStreamOptions, id } };
        const result = await env.load(probeId).refreshVideoRate(input, async () => { requests++; return fresh; }, quiet, cancel());
        assert.equal(result.mediaStreamOptions.video.fps, expectedRate);
        assert.equal(input.mediaStreamOptions.video.fps, 25);
        assert.equal(fresh.mediaStreamOptions.video.fps, 25);
        assert.equal(requests, 1, 'a fresh playback descriptor is acquired');
    }
});

test('unparseable probe still reacquires playback; cancellation stops probe and prevents reacquisition', async () => {
    const { env } = mockedProbe('cannot determine input rate'); let requested = 0;
    const fresh = await env.load(probeId).refreshVideoRate(input, async () => { requested++; return input; }, quiet, cancel());
    assert.equal(requested, 1); assert.equal(fresh.mediaStreamOptions.video.fps, 25);
    const stalled = mockedProbe('', true), c = cancel(); requested = 0;
    const pending = stalled.env.load(probeId).refreshVideoRate(input, async () => { requested++; return input; }, quiet, c);
    await new Promise(setImmediate); c.kill(); await assert.rejects(pending, /canceled/);
    assert.equal(requested, 0); assert.equal(stalled.killed, 1);
});

test('rate probe timeout kills the probe without leaking source URLs in the error', async () => {
    const stalled = mockedProbe('', true);
    await assert.rejects(stalled.env.load(probeId).probeVideoRate(input, cancel(), 20), /^Error: Video rate check timed out$/);
    assert.equal(stalled.killed, 1);
});

test('real RTSP: stale 25 fps metadata is refreshed from 30 fps HEVC and playback copies a fresh one-use URL', { timeout: 15000 }, async () => {
    const probe = await camera({ singleClient: true, fps: 30 }), playback = await camera({ singleClient: true, fps: 30 });
    const env = environment({ mediaManager: { getFFmpegPath: async () => ffmpeg } }), c = cancel(), children = [], sent = [], logs = [];
    const console = { ...quiet, log(...args) { logs.push(args.join(' ')); } };
    const stale = i => ({ ...i, mediaStreamOptions: { ...i.mediaStreamOptions, video: { ...i.mediaStreamOptions.video, fps: 25 } } });
    env.mock(base + 'camera-streaming-srtp-sender.ts', { createCameraStreamSender(_c, _conf, _s, _ssrc, pt) {
        return { sendRtcp() {}, sendRtp(packet) { if (pt === 99) sent.push(packet); } }; } });
    env.mock(base + 'camera-streaming-session.ts', { async waitForFirstVideoRtcp() {} });
    const forwarder = env.load('../webrtc/src/rtp-forwarders.ts');
    env.mock('../webrtc/src/rtp-forwarders.ts', { async startRtpForwarderProcess(...args) { const p = await forwarder.startRtpForwarderProcess(...args); children.push(p); return p; } });
    try {
        const updated = await env.load(probeId).refreshVideoRate(stale(probe.input), async () => stale(playback.input), console, c);
        assert.equal(updated.mediaStreamOptions.video.fps, 30);
        assert.equal(probe.connections, 1); assert.equal(playback.connections, 0);
        const s = { ...c, startRequest: { hksv27: true, video: { codec: 1, width: 320, height: 180, fps: 30, max_bit_rate: 180, pt: 99, mtu: 1200 },
            audio: { codec: 'OPUS', sample_rate: 24, packet_time: 20, channel: 1, pt: 110, max_bit_rate: 24 } },
            prepareRequest: { targetAddress: '127.0.0.1', video: { port: 1 }, audio: { port: 2 } }, videoReturn: {}, audioReturn: {}, vconfig: {}, aconfig: {}, videossrc: 10, audiossrc: 11 };
        await env.load(base + 'camera-streaming-ffmpeg.ts').startCameraStreamFfmpeg({}, console, storage(), updated, s);
        assert.equal(playback.connections, 1); assert(sent.length > 0);
        assert(logs.some(l => l.includes('HomeKit source verified: h265 320x180@30; metadata reported 25 fps')));
        assert(logs.some(l => l.includes('HomeKit output: h265 320x180@30, copy')));
        assert(!logs.some(l => l.includes('libx265')));
    } finally {
        c.kill(); for (const p of children) { p.kill(); p.cp?.kill('SIGKILL'); }
        await Promise.all([probe.close(), playback.close()]);
    }
});

test('missing codec and dimensions are verified on the same source, cached, and rejected for changed or anonymous sources', async () => {
    const unknown = { ...input, mediaStreamOptions: { id: 'main', video: {} } };
    for (const [id, video, success] of [['main', {}, true], ['other', {}, false], ['main', { width: 1920 }, false]]) {
        const { env } = mockedProbe(description(30));
        const api = env.load(probeId), cache = api.createVideoRateCache();
        assert.equal(api.needsVideoRateProbe(unknown, 'h265', tier), true);
        const fresh = { ...unknown, mediaStreamOptions: { id, video } };
        const result = await api.refreshVideoRate(unknown, async () => fresh, quiet, cancel(), cache);
        assert.equal(result.mediaStreamOptions.video.width === 3840, success);
        if (success) {
            assert.equal(result.mediaStreamOptions.video.codec, 'h265');
            assert.equal(cache.apply(fresh).mediaStreamOptions.video.width, 3840);
            assert.equal(cache.apply(fresh).mediaStreamOptions.video.fps, 30);
            assert.equal(fresh.mediaStreamOptions.video.width, undefined);
        }
    }
    const { env } = mockedProbe(description(30));
    const anonymous = { ...unknown, mediaStreamOptions: { video: {} } };
    const result = await env.load(probeId).refreshVideoRate(anonymous, async () => anonymous, quiet, cancel());
    assert.equal(result.mediaStreamOptions.video.width, undefined);
});
