import sdk, { FFmpegInput, ResponseMediaStreamOptions, ScryptedMimeTypes, VideoCamera } from '@scrypted/sdk';
import { rememberNativeHksvStreams } from './hksv-media';
import { probeVideoRate } from './hksv-video-probe';

function hasDimensions(video: ResponseMediaStreamOptions['video']) {
    return Number.isInteger(video?.width) && video.width >= 2 && video.width <= 16384
        && Number.isInteger(video?.height) && video.height >= 2 && video.height <= 16384;
}

async function bounded<T>(work: Promise<T>, timeoutMs: number): Promise<T | undefined> {
    let timer: NodeJS.Timeout;
    try {
        return await Promise.race([work.catch(() => undefined),
            new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), timeoutMs); })]);
    }
    finally { clearTimeout(timer); }
}

/** Discover missing camera API dimensions from the existing native Scrypted stream.
 * These are temporary descriptors, never reused for playback or forced through an encoder. */
export async function discoverHksvCameraSource(device: VideoCamera, console: Console) {
    const listed = await bounded(device.getVideoStreamOptions(), 2000) || [];
    const known = listed.filter(s => hasDimensions(s.video));
    const largest = (streams: ResponseMediaStreamOptions[]) => streams.reduce((a, b) =>
        !a || b.video.width * b.video.height > a.video.width * a.video.height ? b : a, undefined);
    if (known.length) return largest(known).video;

    console.warn('HomeKit camera dimensions missing from stream options; checking native Scrypted streams');
    // Bound startup even if a provider has many streams or is unavailable. No size is guessed.
    const candidates = [...new Set(listed.filter(s => s.video !== null).map(s => s.id))].slice(0, 4);
    if (!candidates.length) candidates.push(undefined);
    const discovered: ResponseMediaStreamOptions[] = [];
    const deadline = Date.now() + 8000;
    for (const id of candidates) {
        const timeout = Math.min(3000, deadline - Date.now());
        if (timeout <= 0) break;
        let stop: () => void;
        const cancel = { killed: false, killPromise: new Promise<void>(resolve => { stop = resolve; }) };
        try {
            const source = await bounded((async () => {
                const media = await device.getVideoStream({ id, destination: 'local',
                    destinationType: '@scrypted/homekit', container: 'rtsp', adaptive: false,
                    video: {}, audio: null });
                if (cancel.killed) return;
                const input = await sdk.mediaManager.convertMediaObjectToJSON<FFmpegInput>(media, ScryptedMimeTypes.FFmpegInput);
                if (cancel.killed) return;
                const native = input.mediaStreamOptions;
                if (id != null && native?.id != null && native.id !== id) return;
                const video = hasDimensions(native?.video) ? native.video
                    : await probeVideoRate(input, cancel, Math.min(timeout, 2000));
                if (!hasDimensions(video)) return;
                return { id: native?.id ?? id, video } as ResponseMediaStreamOptions;
            })(), timeout);
            if (source) discovered.push(source);
        }
        finally { cancel.killed = true; stop(); }
    }
    if (!discovered.length)
        throw new Error('Camera dimensions unavailable from stream options and native stream checks; legacy services retained. Check the camera integration and restart HomeKit.');
    // Used only for source selection; playback still verifies its own media descriptor.
    rememberNativeHksvStreams(device, discovered);
    const selected = largest(discovered).video;
    console.log(`HomeKit camera dimensions recovered from native Scrypted stream: ${selected.width}x${selected.height}${selected.fps ? `@${selected.fps}` : ''}`);
    return selected;
}
