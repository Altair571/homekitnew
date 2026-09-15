import { RtpPacket } from '@koush/werift-src/packages/rtp/src/rtp/rtp';
import { getSpsPps } from '@scrypted/common/src/sdp-utils';
import { timeoutPromise } from '@scrypted/common/src/promise-utils';
import type { FFmpegInput, ScryptedDevice, VideoCamera } from '@scrypted/sdk';
import { RtpTracks, startRtpForwarderProcess } from '../../../../webrtc/src/rtp-forwarders';
import { AudioStreamingCodecType, VideoCodecType } from '../../hap';
import { getDebugMode } from './camera-debug-mode-storage';
import { CameraStreamingSession, waitForFirstVideoRtcp } from './camera-streaming-session';
import { createCameraStreamSender } from './camera-streaming-srtp-sender';
import { videoCopyDecision, normalizeVideoCodec, videoEncoderArguments } from './hksv-media';
import { createHksvRtpPacer } from './hksv-rtp-pacer';

export async function startCameraStreamFfmpeg(device: ScryptedDevice & VideoCamera, console: Console, storage: Storage, input: FFmpegInput, session: CameraStreamingSession,
    getAudioInput?: () => Promise<FFmpegInput>) {
    const request = session.startRequest;
    const modern = !!(request as any).hksv27;
    const codec = request.video.codec === VideoCodecType.H265 ? 'h265' : 'h264';
    const debug = getDebugMode(storage);
    const tier = modern ? {
        identifier: 0, quality: 2 as const, width: request.video.width, height: request.video.height,
        frameRate: request.video.fps, averageBitrateKbps: request.video.max_bit_rate,
    } : undefined;
    const decision = debug.video ? { copy: false, reason: 'Transcode Video debug mode is enabled' }
        : videoCopyDecision(input, codec, tier);
    const copy = decision.copy;
    const noAudio = input.mediaStreamOptions?.audio === null;
    const needsSilence = noAudio && modern;
    const ffmpegInput = needsSilence && !modern ? {
        ...input,
        inputArguments: [...input.inputArguments, '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono'],
    } : input;
    // FFmpeg packetizes new-tier video; our sender encrypts and uses Setup Endpoints ports.
    const h264 = input.mediaStreamOptions?.video?.h264Info;
    const oddity = h264 && (h264.fuab || h264.stapb || h264.mtap16 || h264.mtap32 || h264.sei);
    const allowNative = storage.getItem('rtpSender') === 'Scrypted' || !oddity || input.mediaStreamOptions?.tool === 'scrypted';
    const native = allowNative && !modern && codec === 'h264' && copy && input.container === 'rtsp'
        && storage.getItem('rtpSender') !== 'FFmpeg';
    const videoOptions = {
        codec, maxPacketSize: native ? request.video.mtu : undefined,
        sps: undefined as Buffer, pps: undefined as Buffer,
    };
    const videoSender = createCameraStreamSender(console, session.vconfig, session.videoReturn,
        session.videossrc, request.video.pt, session.prepareRequest.video.port,
        session.prepareRequest.targetAddress, request.video.rtcp_interval, videoOptions);
    let firstVideo: () => void;
    let firstAudio: () => void;
    const audioReady = new Promise<void>(resolve => firstAudio = resolve);
    const ready = new Promise<void>(resolve => firstVideo = resolve);
    let forwarded = false;
    const sendVideo = (packet: RtpPacket) => {
        if (session.killed) return;
        videoSender.sendRtp(packet);
        if (!forwarded) {
            forwarded = true;
            console.log(`HomeKit first ${codec} RTP packet; forwarding to controller`);
            firstVideo();
        }
    };
    const pacer = modern ? createHksvRtpPacer(sendVideo, error => { console.error(error.message); session.kill(); }) : undefined;
    session.killPromise.then(() => pacer?.close());
    const tracks: RtpTracks = {
        video: {
            codecCopy: native ? codec : 'transcode',
            encoderArguments: [
                '-map', '0:v:0',
                ...(copy ? ['-c:v', 'copy', ...(codec === 'h265' || input.mediaStreamOptions?.oobCodecParameters ? ['-bsf:v', 'dump_extra'] : [])]
                    : videoEncoderArguments(codec, request.video.width, request.video.height, request.video.fps, request.video.max_bit_rate)),
            ],
            packetSize: Math.min(request.video.mtu || 1200, 1200) - 22,
            payloadType: request.video.pt,
            ssrc: session.videossrc,
            onMSection(section) {
                if (codec === 'h264') {
                    const params = getSpsPps(section);
                    videoOptions.sps = params?.sps;
                    videoOptions.pps = params?.pps;
                }
            },
            onRtp(data, actualCodec) {
                if (session.killed || normalizeVideoCodec(actualCodec) !== codec) return;
                const packet = RtpPacket.deSerialize(data);
                if (pacer) pacer.enqueue(packet); else sendVideo(packet);
            },
        },
    };
    if (!noAudio || needsSilence) {
        const opus = request.audio.codec === AudioStreamingCodecType.OPUS;
        const audioSender = opus ? createCameraStreamSender(console, session.aconfig, session.audioReturn,
            session.audiossrc, request.audio.pt, session.prepareRequest.audio.port,
            session.prepareRequest.targetAddress, request.audio.rtcp_interval, undefined, {
                audioPacketTime: request.audio.packet_time,
                audioSampleRate: request.audio.sample_rate,
                rtpClockRate: modern ? 48000 : undefined,
                framesPerPacket: request.audio.packet_time / 20,
            }) : undefined;
        const aacSender = !opus ? createCameraStreamSender(console, session.aconfig, session.audioReturn,
            session.audiossrc, request.audio.pt, session.prepareRequest.audio.port,
            session.prepareRequest.targetAddress, request.audio.rtcp_interval,
            { codec: 'aac', maxPacketSize: undefined, sps: undefined, pps: undefined }) : undefined;
        const sender = audioSender || aacSender;
        tracks.audio = {
            codecCopy: !modern && !debug.audio && opus ? 'opus' : 'transcode',
            encoderArguments: [
                '-map', needsSilence && !modern ? '1:a:0' : '0:a:0',
                ...(opus ? ['-c:a', 'libopus', '-application', 'lowdelay', '-frame_duration', String(request.audio.packet_time)]
                    : ['-c:a', 'libfdk_aac', '-profile:a', 'aac_eld']),
                '-ar', `${request.audio.sample_rate}k`, '-b:a', `${request.audio.max_bit_rate}k`,
                '-ac', String(request.audio.channel),
            ],
            packetSize: 400, payloadType: request.audio.pt, ssrc: session.audiossrc,
            firstPacket() { firstAudio(); },
            onRtp(data) { if (!session.killed) sender.sendRtp(RtpPacket.deSerialize(data)); },
        };
    }
    if (!modern) await waitForFirstVideoRtcp(console, session);
    if (session.killed) throw new Error('HomeKit session ended before media startup');
    console.log(`HomeKit output: ${codec} ${request.video.width}x${request.video.height}@${request.video.fps}, ${copy ? 'copy' : 'encode'}, ${modern ? '48 kHz Opus clock' : 'legacy audio clock'}`);
    console.log(`HomeKit video ${copy ? 'passthrough' : 're-encode'} reason: ${decision.reason}`);
    if (modern) console.log('HomeKit video relay: local RTSP/TCP, paced SRTP output (40 Mbps burst limit)');
    // FFmpeg 6 waits for all RTP output headers before writing the shared SDP and
    // starting muxers. Missing audio must not block the independent video stream.
    const videoInput = modern ? {
        ...input,
        inputArguments: input.inputArguments.flatMap((arg, index) => arg === '-i'
            ? [...(input.container?.startsWith('rtsp') && /^rtsps?:/.test(input.inputArguments[index + 1])
                ? ['-allowed_media_types', 'video'] : []), '-an', arg] : [arg]),
        mediaStreamOptions: { ...input.mediaStreamOptions, audio: null },
    } : ffmpegInput;
    const process = await startRtpForwarderProcess(console, videoInput, modern ? { video: tracks.video } : tracks,
        modern ? { rtspMode: 'tcp' } : undefined);
    session.killPromise.then(() => process.kill());
    process.killPromise.then(() => session.kill(), () => session.kill());
    if (session.killed) { process.kill(); throw new Error('Media startup canceled'); }
    if (modern && tracks.audio) {
        // Audio-only RTSP forwarding retains the bundled ADTS-in-RTP recovery for
        // cameras whose AAC packets FFmpeg's RTSP demuxer cannot read.
        void (async () => {
            let audioProcess: Awaited<ReturnType<typeof startRtpForwarderProcess>>;
            let expired = false;
            const timer = setTimeout(() => {
                expired = true;
                audioProcess?.kill();
                if (!session.killed) console.warn('HomeKit audio produced no packets within 10s; video continues without audio');
            }, 10000);
            timer.unref?.();
            session.killPromise.then(() => { clearTimeout(timer); audioProcess?.kill(); });
            audioReady.then(() => clearTimeout(timer));
            try {
                // Scrypted's prebuffer URLs accept one connection. Reusing the video
                // descriptor here lets the native audio client consume it before the
                // video FFmpeg process connects. Request an independent descriptor.
                if (!needsSilence && !getAudioInput) throw new Error('Independent audio source is unavailable');
                const audioInput: FFmpegInput = needsSilence ? {
                    inputArguments: ['-re', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono'],
                } : await getAudioInput();
                if (session.killed || expired) return;
                console.log('HomeKit audio using an independent stream request');
                audioProcess = await startRtpForwarderProcess(console, audioInput, { audio: tracks.audio }, { rtspClientForceTcp: true });
                if (session.killed || expired) { audioProcess.kill(); return; }
                await audioProcess.killPromise;
                if (!session.killed && !expired) console.warn('HomeKit audio stopped; video continues without audio');
            }
            catch (e) {
                audioProcess?.kill();
                if (!session.killed && !expired) console.warn('HomeKit audio failed; video continues without audio', e);
            }
            finally { clearTimeout(timer); }
        })();
    }
    try {
        const section = await timeoutPromise(10000, Promise.race([
            process.videoSection,
            process.killPromise.then(() => { throw new Error(session.killed ? 'Media startup canceled' : 'Video process exited before producing video'); }),
        ]));
        if (normalizeVideoCodec(section?.codec) !== codec)
            throw new Error(`HomeKit selected ${codec}; outgoing media is ${section?.codec || 'missing'}`);
        if (codec === 'h265' && Number(section?.fmtp?.[0]?.parameters?.['profile-id'] || 1) !== 1)
            throw new Error('HEVC stream is not Main profile; enable Transcode Video for this source');
        await timeoutPromise(10000, Promise.race([ready, session.killPromise.then(() => { throw new Error('Media startup canceled'); })]));
    }
    catch (e) { process.kill(); throw e; }
}
