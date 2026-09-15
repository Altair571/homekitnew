import { spawn } from 'child_process';
import sdk, { FFmpegInput } from '@scrypted/sdk';
import { safeKillFFmpeg } from '@scrypted/common/src/media-helpers';
import { parseSdp } from '@scrypted/common/src/sdp-utils';
import type { VideoStreamTier } from './hksv-stream-tiers';
import { CameraVideoCodec, canCopyVideo, normalizeVideoCodec } from './hksv-media';

interface Cancellation {
    killed: boolean;
    killPromise: Promise<void>;
}

/** Per-camera, in-memory cache. A changed source description or 60 seconds invalidates it. */
export function createVideoRateCache(now: () => number = Date.now) {
    let entry: { key: string; video: Partial<FFmpegInput['mediaStreamOptions']['video']>; expires: number };
    const key = (input: FFmpegInput) => {
        const video = input.mediaStreamOptions?.video;
        return JSON.stringify([input.mediaStreamOptions?.id, normalizeVideoCodec(video?.codec), video?.width, video?.height, video?.fps,
            input.mediaStreamOptions?.sdp]);
    };
    return {
        remember(input: FFmpegInput, verified: number | ReturnType<typeof parseInputVideoDescription>) {
            entry = { key: key(input), video: typeof verified === 'number' ? { fps: verified } : { ...verified }, expires: now() + 60000 };
        },
        apply(input: FFmpegInput): FFmpegInput {
            if (!entry || entry.expires <= now() || entry.key !== key(input)) return input;
            return { ...input, mediaStreamOptions: { ...input.mediaStreamOptions,
                video: { ...input.mediaStreamOptions?.video, ...entry.video } } };
        },
    };
}

/** Prefer the stream description already supplied by Scrypted's rebroadcast provider.
 * If it does not resolve the requested-rate mismatch, retain the bounded probe fallback. */
export function applyScryptedSdpVideoRate(input: FFmpegInput, expectedFps: number): FFmpegInput {
    const sdp = input.mediaStreamOptions?.sdp;
    if (typeof sdp !== 'string') return input;
    try {
        const section = parseSdp(sdp).msections.find(m => m.type === 'video');
        const video = input.mediaStreamOptions?.video;
        if (!section || normalizeVideoCodec(section.codec) !== normalizeVideoCodec(video?.codec)) return input;
        const rates = section.lines.filter(l => /^a=(?:x-)?framerate:/.test(l))
            .map(l => Number(l.slice(l.indexOf(':') + 1).trim()));
        if (!rates.length || rates.some(rate => rate !== expectedFps)) return input;
        const dimensions = section.lines.find(l => l.startsWith('a=x-dimensions:'));
        if (dimensions) {
            const size = /^a=x-dimensions:\s*(\d+)\s*,\s*(\d+)\s*$/.exec(dimensions);
            if (!size || Number(size[1]) !== video?.width || Number(size[2]) !== video?.height) return input;
        }
        if (video?.fps === expectedFps) return input;
        return { ...input, mediaStreamOptions: { ...input.mediaStreamOptions, video: { ...video, fps: expectedFps } } };
    }
    catch { return input; }
}

/** Read only input #0's first video description, never an output encoder's rate. */
export function parseInputVideoDescription(stderr: string) {
    const input = stderr.split(/(?:Stream mapping:|Output #)/, 1)[0];
    const line = /Stream #0:\d+(?:\[[^\]]*\])?(?:\([^)]*\))?: Video: ([^\r\n]+)/.exec(input)?.[1];
    if (!line) return;
    const codec = normalizeVideoCodec(line.split(/[\s,(]/, 1)[0]);
    const size = /(?:^|,\s*)(\d+)x(\d+)(?=[\s,\[])/.exec(line);
    const rate = /(?:^|,\s*)(\d+(?:\.\d+)?) fps(?:,|\s|$)/.exec(line);
    if (!codec || !size || !rate) return;
    const width = Number(size[1]), height = Number(size[2]), fps = Number(rate[1]);
    if (width < 2 || height < 2 || width > 16384 || height > 16384 || !Number.isFinite(fps) || fps <= 0) return;
    return { codec, width, height, fps };
}

export function needsVideoRateProbe(input: FFmpegInput, codec: CameraVideoCodec, tier: VideoStreamTier) {
    const video = input.mediaStreamOptions?.video;
    return input.container?.startsWith('rtsp') && !canCopyVideo(input, codec, tier)
        && canCopyVideo({ ...input, mediaStreamOptions: { ...input.mediaStreamOptions,
            video: { ...video, codec: video?.codec || codec, width: video?.width || tier.width,
                height: video?.height || tier.height, fps: tier.frameRate } } }, codec, tier);
}

/** Consumes this one-use descriptor. No video is decoded or encoded. The caller must
 * obtain another descriptor before playback, even after a failed or timed-out probe. */
export async function probeVideoRate(input: FFmpegInput, cancel: Cancellation, timeoutMs = 2000) {
    const path = await sdk.mediaManager.getFFmpegPath();
    if (cancel.killed) throw new Error('Video rate check canceled');
    const args = input.inputArguments.flatMap((arg, index) => arg === '-i'
        ? [...(/^rtsps?:/.test(input.inputArguments[index + 1]) ? ['-allowed_media_types', 'video'] : []), '-an', arg] : [arg]);
    const cp = spawn(path, ['-hide_banner', ...args, '-map', '0:v:0', '-c:v', 'copy', '-frames:v', '0', '-f', 'null', '-'],
        { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    return await new Promise<ReturnType<typeof parseInputVideoDescription>>((resolve, reject) => {
        let finished = false;
        const finish = (error?: Error, result?: ReturnType<typeof parseInputVideoDescription>) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            if (cp.pid && cp.exitCode === null) void safeKillFFmpeg(cp);
            if (error) reject(error); else resolve(result);
        };
        const timer = setTimeout(() => finish(new Error('Video rate check timed out')), timeoutMs);
        cancel.killPromise.then(() => finish(new Error('Video rate check canceled')));
        cp.on('error', () => finish(new Error('Video rate check could not start FFmpeg')));
        cp.on('close', code => finish(code === 0 ? undefined : new Error('Video rate check failed'),
            code === 0 ? parseInputVideoDescription(stderr) : undefined));
        // Retain a bounded private buffer; source URLs/credentials never enter diagnostics.
        cp.stderr.on('data', data => { if (stderr.length < 32768) stderr = (stderr + data.toString()).slice(0, 32768); });
    });
}

export async function refreshVideoRate(input: FFmpegInput, getFreshInput: () => Promise<FFmpegInput>,
    console: Console, cancel: Cancellation, cache?: ReturnType<typeof createVideoRateCache>) {
    let actual: Awaited<ReturnType<typeof probeVideoRate>>;
    try { actual = await probeVideoRate(input, cancel); }
    catch (e) {
        if (cancel.killed) throw new Error('Video rate check canceled');
        console.warn('HomeKit source frame-rate check unavailable; retaining metadata and conversion rules');
    }
    if (cancel.killed) throw new Error('Video rate check canceled');
    // Probe URLs accept one connection; never reconnect the playback process to one.
    const fresh = await getFreshInput();
    if (cancel.killed) throw new Error('Video rate check canceled');
    const video = fresh.mediaStreamOptions?.video;
    const sameId = fresh.mediaStreamOptions?.id === input.mediaStreamOptions?.id;
    // Missing metadata can be filled only for an identifiable source. Existing known
    // codec/dimensions must agree; a changed source must never inherit the probe result.
    const sameKnownVideo = actual && actual.codec === normalizeVideoCodec(video?.codec)
        && actual.width === video?.width && actual.height === video?.height;
    const compatibleVideo = actual && (!video?.codec || actual.codec === normalizeVideoCodec(video.codec))
        && (!video?.width || actual.width === video.width) && (!video?.height || actual.height === video.height);
    if (actual && sameId && (fresh.mediaStreamOptions?.id != null || sameKnownVideo) && compatibleVideo) {
        console.log(`HomeKit source verified: ${actual.codec} ${actual.width}x${actual.height}@${actual.fps}; metadata reported ${video?.fps || 'unknown'} fps`);
        cache?.remember(fresh, actual);
        return { ...fresh, mediaStreamOptions: { ...fresh.mediaStreamOptions, video: { ...video, ...actual } } };
    }
    console.warn('HomeKit source frame rate not verified; retaining metadata and conversion rules');
    return fresh;
}
