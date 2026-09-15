import sdk, { FFmpegInput, ScryptedMimeTypes, VideoCamera } from '@scrypted/sdk';
import { startFFMPegFragmentedMP4Session } from '@scrypted/common/src/ffmpeg-mp4-parser-session';
import { safeKillFFmpeg } from '@scrypted/common/src/media-helpers';
import { VideoStreamTier } from './hksv-stream-tiers';
import { getNativeHksvVideoStream, videoEncoderArguments } from './hksv-media';
import { NTP_SECOND, TimedFragment } from './hksv-recording-buffer';

type Box = { type: string; data: Buffer };
export function mp4Boxes(data: Buffer): Box[] {
    const boxes: Box[] = [];
    for (let offset = 0; offset < data.length;) {
        if (offset + 8 > data.length) throw new Error('Truncated MP4 box');
        const length = data.readUInt32BE(offset);
        if (length < 8 || offset + length > data.length) throw new Error('Invalid MP4 box length');
        boxes.push({ type: data.toString('ascii', offset + 4, offset + 8), data: data.subarray(offset + 8, offset + length) });
        offset += length;
    }
    return boxes;
}
function child(data: Buffer, type: string): Buffer {
    const box = mp4Boxes(data).find(b => b.type === type);
    if (!box) throw new Error(`MP4 ${type} box missing`);
    return box.data;
}
export function videoTiming(moov: Buffer) {
    for (const trak of mp4Boxes(moov).filter(b => b.type === 'trak')) {
        const mdia = child(trak.data, 'mdia');
        if (child(mdia, 'hdlr').toString('ascii', 8, 12) !== 'vide') continue;
        const tkhd = child(trak.data, 'tkhd'), mdhd = child(mdia, 'mdhd');
        return { trackId: tkhd.readUInt32BE(tkhd[0] ? 20 : 12), timescale: mdhd.readUInt32BE(mdhd[0] ? 20 : 12) };
    }
    throw new Error('MP4 has no video track');
}
export function fragmentTiming(moof: Buffer, prft: Buffer, timing: { trackId: number; timescale: number }) {
    if (prft.readUInt32BE(4) !== timing.trackId) throw new Error('PRFT does not reference video');
    const ntp = prft.readBigUInt64BE(8);
    const referenceTime = prft[0] ? prft.readBigUInt64BE(16) : BigInt(prft.readUInt32BE(16));
    for (const traf of mp4Boxes(moof).filter(b => b.type === 'traf')) {
        const tfhd = child(traf.data, 'tfhd');
        if (tfhd.readUInt32BE(4) !== timing.trackId) continue;
        const flags = tfhd.readUInt32BE(0) & 0xffffff;
        let offset = 8 + ((flags & 1) ? 8 : 0) + ((flags & 2) ? 4 : 0);
        const defaultDuration = flags & 8 ? tfhd.readUInt32BE(offset) : 0;
        const tfdt = child(traf.data, 'tfdt');
        const startTime = tfdt[0] ? tfdt.readBigUInt64BE(4) : BigInt(tfdt.readUInt32BE(4));
        let duration = 0n;
        for (const run of mp4Boxes(traf.data).filter(b => b.type === 'trun')) {
            const trun = run.data, f = trun.readUInt32BE(0) & 0xffffff, count = trun.readUInt32BE(4);
            let at = 8 + ((f & 1) ? 4 : 0) + ((f & 4) ? 4 : 0);
            for (let i = 0; i < count; i++) {
                duration += BigInt(f & 0x100 ? trun.readUInt32BE(at) : defaultDuration);
                at += ((f & 0x100) ? 4 : 0) + ((f & 0x200) ? 4 : 0) + ((f & 0x400) ? 4 : 0) + ((f & 0x800) ? 4 : 0);
            }
        }
        if (!duration || !timing.timescale) throw new Error('MP4 video duration missing');
        const start = ntp + (startTime - referenceTime) * NTP_SECOND / BigInt(timing.timescale);
        return { start, end: start + duration * NTP_SECOND / BigInt(timing.timescale) };
    }
    throw new Error('Video fragment missing');
}

export type RecordingSourceItem = { init: Buffer } | TimedFragment;
/** A continuous HEVC recorder; independent of the legacy H264/HDS configuration. */
export async function* createHksvRecordingSource(device: VideoCamera, console: Console, tier: VideoStreamTier,
    signal: AbortSignal, audioActive: () => boolean): AsyncGenerator<RecordingSourceItem> {
    if (signal.aborted) return;
    const media = await getNativeHksvVideoStream(device, { destination: 'remote-recorder', adaptive: false, container: 'rtsp',
        video: { codec: 'h265', width: tier.width, height: tier.height, fps: tier.frameRate }, audio: audioActive() ? {} : null });
    if (signal.aborted) return;
    const input = await sdk.mediaManager.convertMediaObjectToJSON<FFmpegInput>(media, ScryptedMimeTypes.FFmpegInput);
    if (signal.aborted) return;
    const silent = !audioActive() || input.mediaStreamOptions?.audio === null;
    const nativeVideo = input.mediaStreamOptions?.video;
    if (nativeVideo?.width && nativeVideo?.height && (nativeVideo.width < tier.width || nativeVideo.height < tier.height))
        throw new Error(`Recording source ${nativeVideo.width}x${nativeVideo.height} is smaller than the advertised ${tier.width}x${tier.height} tier`);
    // Do not demux unusable camera audio when recording audio has been disabled.
    const videoOnlyRtsp = silent && (input.container === 'rtsp' || input.url?.startsWith('rtsp:'));
    const inputArguments = videoOnlyRtsp
        ? input.inputArguments.flatMap(arg => arg === '-i' ? ['-allowed_media_types', 'video', arg] : [arg])
        : input.inputArguments;
    // Encoding fixes GOP duration, pixel format, frame rate, and dimensions for the indexed buffer.
    const session = await startFFMPegFragmentedMP4Session(
        [...inputArguments, ...(silent ? ['-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono'] : [])],
        ['-map', silent ? '1:a:0' : '0:a:0', '-c:a', 'aac', '-ar', '24000', '-ac', '1', '-b:a', '32k'],
        ['-map', '0:v:0', ...videoEncoderArguments('h265', tier.width, tier.height, tier.frameRate, tier.averageBitrateKbps)
                .map(arg => arg.replace('repeat-headers=1', 'repeat-headers=0')), '-flags', '+global_header',
            '-tag:v', 'hvc1', '-write_prft', 'wallclock'], console);
    const kill = () => safeKillFFmpeg(session.cp);
    signal.addEventListener('abort', kill, { once: true });
    if (signal.aborted) kill();
    let timing: ReturnType<typeof videoTiming>, anchor: Buffer, moof: Buffer;
    let init: Buffer[] = [], chunks: Buffer[] = [];
    try {
        for await (const atom of session.generator) {
            if (signal.aborted) return;
            const box = Buffer.concat([atom.header, atom.data]);
            if (atom.type === 'ftyp') init.push(box);
            else if (atom.type === 'moov') { timing = videoTiming(atom.data); init.push(box); yield { init: Buffer.concat(init) }; init = []; }
            else if (atom.type === 'prft') { anchor ??= atom.data; chunks.push(box); }
            else if (atom.type === 'moof') { moof = atom.data; chunks.push(box); }
            else if (atom.type === 'mdat') {
                if (!timing || !anchor || !moof) throw new Error('Recording lacks a video wall-clock timestamp');
                chunks.push(box);
                yield { data: Buffer.concat(chunks), ...fragmentTiming(moof, anchor, timing) };
                chunks = []; moof = undefined;
            }
        }
    }
    finally { signal.removeEventListener('abort', kill); kill(); }
}
