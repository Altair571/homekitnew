import type { FFmpegInput, RequestMediaStreamOptions, ResponseMediaStreamOptions, VideoCamera } from '@scrypted/sdk';
import { parseSdp } from '@scrypted/common/src/sdp-utils';
import type { VideoStreamTier } from './hksv-stream-tiers';

export type CameraVideoCodec = 'h264' | 'h265';
const discoveredStreams = new WeakMap<VideoCamera, ResponseMediaStreamOptions[]>();
export function rememberNativeHksvStreams(device: VideoCamera, streams: ResponseMediaStreamOptions[]) {
    discoveredStreams.set(device, streams.map(s => ({ id: s.id, video: { ...s.video } })));
}
export interface HksvMediaSelection {
    codec: CameraVideoCodec;
    tier: VideoStreamTier;
    /** Off-LAN viewer: remote stream destination, capped tier, pacing and loss protection. */
    remote?: boolean;
}

export function normalizeVideoCodec(codec?: string): CameraVideoCodec | undefined {
    switch (codec?.toLowerCase()) {
        case 'h264': case 'avc': case 'avc1': return 'h264';
        case 'h265': case 'hevc': case 'hvc1': case 'hev1': return 'h265';
    }
}

/** Missing bitrate metadata is not evidence of an over-budget stream. Dimensions,
 * codec and frame rate must still match; known over-budget streams are converted. */
export function videoCopyDecision(input: FFmpegInput, codec: CameraVideoCodec, tier?: VideoStreamTier, options?: { allowLowerFrameRate?: boolean }): { copy: boolean; reason: string } {
    const video = input.mediaStreamOptions?.video;
    if (normalizeVideoCodec(video?.codec) !== codec)
        return { copy: false, reason: `source codec ${normalizeVideoCodec(video?.codec) || 'unknown'} does not match ${codec}` };
    if (!tier) return { copy: true, reason: 'source codec matches legacy stream' };
    if (video?.width !== tier.width || video?.height !== tier.height)
        return { copy: false, reason: `source dimensions ${video?.width || '?'}x${video?.height || '?'} do not match ${tier.width}x${tier.height}` };
    // A remote substream below the tier frame rate never exceeds the negotiated max-fps.
    const fps = video?.fps;
    if (fps !== tier.frameRate && !(options?.allowLowerFrameRate && typeof fps === 'number' && fps > 0 && fps < tier.frameRate))
        return { copy: false, reason: `source frame rate ${video?.fps || 'unknown'} does not match ${tier.frameRate} fps` };
    const bitrate = video?.bitrate;
    if (Number.isFinite(bitrate) && bitrate > tier.averageBitrateKbps * 1000)
        return { copy: false, reason: `source bitrate ${Math.round(bitrate / 1000)} kbps exceeds requested ${tier.averageBitrateKbps} kbps` };
    return { copy: true, reason: Number.isFinite(bitrate) && bitrate > 0
        ? 'native codec, dimensions, frame rate and bitrate match'
        : 'native codec, dimensions and frame rate match; bitrate unreported, passing through without bitrate enforcement' };
}

export function canCopyVideo(input: FFmpegInput, codec: CameraVideoCodec, tier?: VideoStreamTier): boolean {
    return videoCopyDecision(input, codec, tier).copy;
}

/** r41: keyframe schedule for viewers that join after the stream has started. */
export interface KeyframeSchedule {
    /** Regular keyframe interval in seconds. */
    gopSeconds: number;
    /** Force an IDR this often during the first startupSeconds. */
    startupIntervalSeconds: number;
    startupSeconds: number;
}

export function videoEncoderArguments(codec: CameraVideoCodec, width: number, height: number, fps: number, bitrateKbps: number, keyframes?: KeyframeSchedule): string[] {
    const bitrate = Math.max(64, Math.round(bitrateKbps)) * 1000;
    const gop = Math.max(1, Math.round(fps * (keyframes?.gopSeconds ?? 2)));
    return [
        '-c:v', codec === 'h265' ? 'libx265' : 'libx264',
        '-preset', 'ultrafast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p',
        '-profile:v', codec === 'h265' ? 'main' : 'baseline',
        '-bf', '0', '-g', String(gop), '-keyint_min', String(gop),
        ...(keyframes ? ['-forced-idr', '1', '-force_key_frames', `expr:lte(t,${keyframes.startupSeconds})*gte(t,n_forced*${keyframes.startupIntervalSeconds})`] : []),
        ...(codec === 'h264' ? ['-sc_threshold', '0'] : []),
        ...(codec === 'h265' ? ['-x265-params', `repeat-headers=1:aud=1:bframes=0:open-gop=0:scenecut=0:keyint=${gop}:min-keyint=${gop}:pools=2:frame-threads=2:log-level=error`] : ['-x264-params', 'repeat-headers=1:scenecut=0']),
        '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1`,
        '-r', String(fps), '-b:v', String(bitrate), '-maxrate', String(bitrate), '-bufsize', String(bitrate * 2),
    ];
}

/** Select by native dimensions before removing the output constraints. In particular,
 * remote-recorder otherwise selects the configured remote substream even for a 4K tier. */
export async function getNativeHksvVideoStream(device: VideoCamera, options: RequestMediaStreamOptions) {
    let id = options.id;
    if (id == null) {
        const listed = await device.getVideoStreamOptions().catch(() => []);
        const remembered = discoveredStreams.get(device) || [];
        const streams = (listed.length ? listed : remembered).map(s => {
            const recovered = remembered.find(r => s.id != null && r.id === s.id);
            return recovered && s.video !== null && (!s.video?.width || !s.video?.height)
                ? { ...s, video: { ...recovered.video, ...s.video,
                    width: s.video?.width || recovered.video.width, height: s.video?.height || recovered.video.height } } : s;
        });
        const known = streams.filter(s => s.id != null && s.video?.width > 0 && s.video?.height > 0);
        const fits = known.filter(s => s.video.width >= (options.video?.width || 0)
            && s.video.height >= (options.video?.height || 0));
        const exact = fits.filter(s => s.video.width === options.video?.width && s.video.height === options.video?.height
            && normalizeVideoCodec(s.video.codec) === normalizeVideoCodec(options.video?.codec)
            && s.video.fps === options.video?.fps);
        const area = (s: typeof known[number]) => s.video.width * s.video.height;
        id = (exact.length ? exact : fits.length ? fits.sort((a, b) => area(a) - area(b)) : known.sort((a, b) => area(b) - area(a)))[0]?.id;
    }
    return device.getVideoStream({ ...options, id, adaptive: false, tool: undefined,
        video: {}, audio: options.audio === null ? null : {},
    });
}

export function assertVideoSdp(sdp: string, expected: CameraVideoCodec): void {
    const section = parseSdp(sdp).msections.find(m => m.type === 'video');
    if (normalizeVideoCodec(section?.codec) !== expected)
        throw new Error(`HomeKit selected ${expected}, but the outgoing SDP describes ${section?.codec || 'no video'}`);
}

export function rtpDestination(address: string, port: number): string {
    return `${address.includes(':') && !address.startsWith('[') ? `[${address}]` : address}:${port}`;
}

/** Some camera plugins reject output constraints instead of returning their native codec. */
export async function getHksvVideoStream(device: VideoCamera, options: RequestMediaStreamOptions) {
    try { return await device.getVideoStream(options); }
    catch (requestedError) {
        try {
            return await getNativeHksvVideoStream(device, options);
        }
        catch (nativeError) { throw new Error('Camera could not provide either the requested or a native stream', { cause: nativeError }); }
    }
}
