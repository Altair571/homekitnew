#!/usr/bin/env python3
"""Build r42 from the tested r41 ZIP: 1440p and 4K remote options, higher remote bitrates, and camera-stream passthrough."""
import importlib.util
import json
import re
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('r35builder', ROOT / 'build-r35-from-r34.py')
b = importlib.util.module_from_spec(spec); spec.loader.exec_module(b)
BASE_SHA = '3efaa0b348958ee1867fde686de4aab25f6ab1a739d3d276c3586529db72e3c5'
OLD_BUILD = 'hevc-fixes-2026-09-16-r41'
BUILD = 'hevc-fixes-2026-09-16-r42'
HKSV27 = b.PREFIX + 'camera-hksv27.ts'
CAMERA = './src/types/camera.ts'
MIXIN = './src/camera-mixin.ts'


def base_archive():
    for path in (ROOT / 'plugin-hevc-webrtc-r41.zip', Path.home() / 'Desktop' / 'plugin-hevc-webrtc-r41.zip'):
        if path.is_file() and b.digest(path.read_bytes()) == BASE_SHA:
            return path
    raise SystemExit('The checksum-locked r41 ZIP was not found.')


def edit_media(s):
    s = b.once(s, "export function videoEncoderArguments(codec: CameraVideoCodec, width: number, height: number, fps: number, bitrateKbps: number, keyframes?: KeyframeSchedule): string[] {\n",
               "/** r42: 'auto' lets x265 size its own thread pool; the default keeps the two threads every earlier build used. */\n"
               "export function videoEncoderArguments(codec: CameraVideoCodec, width: number, height: number, fps: number, bitrateKbps: number, keyframes?: KeyframeSchedule, options?: { threads?: 'limited' | 'auto' }): string[] {\n")
    return b.once(s, ":keyint=${gop}:min-keyint=${gop}:pools=2:frame-threads=2:log-level=error`]",
                  ":keyint=${gop}:min-keyint=${gop}${options?.threads === 'auto' ? '' : ':pools=2:frame-threads=2'}:log-level=error`]")


RESOLUTION_OLD = '''const REMOTE_RESOLUTION_KEY = 'hksv27WebRTCRemoteResolution';

/** r41: the offer carries one tier. 1080p is opt-in because cellular viewers may refuse it. */
export function offeredResolution(setting?: string | null): '360p' | '1080p' {
    return (setting ?? '').trim().startsWith('1080p') ? '1080p' : '360p';
}
'''

PLAN_HELPERS = '''const REMOTE_RESOLUTION_KEY = 'hksv27WebRTCRemoteResolution';
const REMOTE_BITRATE_KEY = 'hksv27WebRTCRemoteBitrate';
/** r42: re-encode bitrate for each opt-in remote resolution while the bitrate setting is Automatic. */
export const AUTOMATIC_REMOTE_KBPS = { '1080p': 4000, '1440p': 6000, '2160p': 10000 } as const;
/** r42: a camera stream sent unchanged is variable bitrate, so its offer leaves headroom above the reported rate. */
const CAMERA_STREAM_PEAK_MULTIPLIER = 1.5;
const SOURCE_STREAMS_TIMEOUT = 1500;

export type RemoteResolution = '360p' | '1080p' | '1440p' | '2160p';
export type RemoteBitrate = { mode: 'automatic' } | { mode: 'camera' } | { mode: 'fixed'; kbps: number };

/** r41/r42: the offer carries one tier. Anything above 360p is opt-in because cellular viewers may refuse it. */
export function offeredResolution(setting?: string | null): RemoteResolution {
    const value = (setting ?? '').trim();
    return (['1080p', '1440p', '2160p'] as const).find(resolution => value.startsWith(resolution)) ?? '360p';
}

export function offeredBitrate(setting?: string | null): RemoteBitrate {
    const value = (setting ?? '').trim().toLowerCase();
    if (value.startsWith('camera')) return { mode: 'camera' };
    const mbps = Number(/^(\\d+(?:\\.\\d+)?) ?mbps\\b/.exec(value)?.[1]);
    return mbps > 0 && mbps <= 50 ? { mode: 'fixed', kbps: Math.round(mbps * 1000) } : { mode: 'automatic' };
}

/** A camera stream as Scrypted lists it; only the fields the remote plan reads. */
export interface SourceStreamOption {
    id?: string;
    video?: { codec?: string; width?: number; height?: number; fps?: number; bitrate?: number } | null;
}

/** r42: what a session's offer declares and how its remote video is produced. */
export interface RemoteVideoPlan {
    resolution: RemoteResolution;
    tier: VideoStreamTier;
    /** Declared in the offer's b=AS, b=TIAS and RID max-br. */
    peakKbps: number;
    /** Send the camera's own HEVC stream unchanged instead of re-encoding it. */
    cameraStream: boolean;
    label: string;
}

function lowestTier(tiers: VideoStreamTier[]): VideoStreamTier | undefined {
    let lowest: VideoStreamTier | undefined;
    for (const tier of tiers) {
        if (!lowest || tier.quality > lowest.quality
            || (tier.quality === lowest.quality && tier.width * tier.height < lowest.width * lowest.height))
            lowest = tier;
    }
    return lowest;
}

/** r42: the camera tier for a resolution. 1440p on a 4K camera scales its high tier; a smaller camera offers its best tier. */
export function remoteResolutionTier(tiers: VideoStreamTier[], resolution: RemoteResolution): VideoStreamTier | undefined {
    const lowest = lowestTier(tiers);
    if (resolution === '360p' || !lowest) return lowest;
    if (resolution === '1080p')
        return tiers.find(tier => Math.min(tier.width, tier.height) === 1080)
            ?? tiers.find(tier => tier.quality === CameraVideoQuality.MEDIUM) ?? lowest;
    const target = resolution === '1440p' ? 1440 : 2160;
    const highest = tiers.reduce((a, b) => b.width * b.height > a.width * a.height ? b : a);
    const short = Math.min(highest.width, highest.height);
    if (short <= target) return highest;
    const even = (value: number) => Math.round(value * target / short / 2) * 2;
    return { ...highest, width: even(highest.width), height: even(highest.height) };
}

/** r42: the plan for the resolution and bitrate settings. Without a stream list, a camera-stream plan is
 * verified against the stream that actually opens when media starts. */
export function remoteVideoPlan(tiers: VideoStreamTier[], resolution: RemoteResolution, bitrate: RemoteBitrate, streams?: SourceStreamOption[]): RemoteVideoPlan | undefined {
    const base = remoteResolutionTier(tiers, resolution);
    if (!base) return undefined;
    if (resolution === '360p')
        return { resolution, tier: base, peakKbps: peakBitrateKbps(base.averageBitrateKbps), cameraStream: false, label: '360p (default)' };
    const size = `${base.width}x${base.height}`;
    const automatic = AUTOMATIC_REMOTE_KBPS[resolution];
    const reencode = (kbps: number, why: string): RemoteVideoPlan => ({ resolution, tier: { ...base, averageBitrateKbps: kbps },
        peakKbps: peakBitrateKbps(kbps), cameraStream: false, label: `${resolution} ${size}, re-encoded at ${kbps} kbps (${why})` });
    if (bitrate.mode === 'fixed') return reencode(bitrate.kbps, 'bitrate setting');
    // Automatic sends a 4K camera's own stream: a software 4K re-encode cannot add detail and may not keep 30 fps.
    if (bitrate.mode === 'automatic' && resolution !== '2160p') return reencode(automatic, 'Automatic');
    const match = streams?.find(stream => normalizeVideoCodec(stream.video?.codec) === 'h265'
        && stream.video?.width === base.width && stream.video?.height === base.height);
    if (streams && !match) return reencode(automatic, `no HEVC camera stream is ${size}`);
    const reported = Math.round(Number(match?.video?.bitrate) / 1000);
    const kbps = reported > 0 ? reported : automatic;
    return { resolution, tier: { ...base, averageBitrateKbps: kbps }, peakKbps: Math.ceil(kbps * CAMERA_STREAM_PEAK_MULTIPLIER), cameraStream: true,
        label: `${resolution} ${size}, camera stream sent unchanged (${reported > 0 ? `camera reports ${reported} kbps` : 'camera bitrate not reported'}${bitrate.mode === 'automatic' ? ', Automatic' : ''})` };
}

/** r42: whether the stream that opened can be sent unchanged for a camera-stream plan. Its bitrate is not enforced. */
export function cameraStreamDecision(input: FFmpegInput, selection: HksvMediaSelection): { copy: boolean; reason: string } {
    const video = input.mediaStreamOptions?.video;
    const codec = normalizeVideoCodec(video?.codec);
    if (codec !== selection.codec)
        return { copy: false, reason: `camera stream codec ${codec || 'unknown'} is not ${selection.codec}` };
    if (video?.width !== selection.tier.width || video?.height !== selection.tier.height)
        return { copy: false, reason: `camera stream ${video?.width || '?'}x${video?.height || '?'} is not ${selection.tier.width}x${selection.tier.height}` };
    if (typeof video.fps === 'number' && video.fps > selection.tier.frameRate)
        return { copy: false, reason: `camera stream ${video.fps} fps exceeds ${selection.tier.frameRate} fps` };
    const kbps = Math.round(Number(video.bitrate) / 1000);
    return { copy: true, reason: `camera stream setting: ${video.width}x${video.height}${video.fps ? `@${video.fps}` : ''} ${codec.toUpperCase()}`
        + `${kbps > 0 ? `, camera reports ${kbps} kbps` : ''}, sent without re-encoding` };
}
'''

PACING_OLD = '''export function remotePacing(tier: VideoStreamTier): { bytesPerSecond: number; burstBytes: number } {
    return {
        bytesPerSecond: Math.max(REMOTE_PACING_FLOOR_BPS, tier.averageBitrateKbps * 1000 * REMOTE_PACING_MULTIPLIER) / 8,
        burstBytes: REMOTE_PACING_BURST_BYTES,
    };
}
'''

PACING_NEW = '''export function remotePacing(tier: VideoStreamTier): { bytesPerSecond: number; burstBytes: number } {
    const bytesPerSecond = Math.max(REMOTE_PACING_FLOOR_BPS, tier.averageBitrateKbps * 1000 * REMOTE_PACING_MULTIPLIER) / 8;
    // r42: timers can fire about every 15 ms (Windows), so each wake-up carries that much credit; otherwise
    // 4K bitrates queue until the session fails. Tiers up to 1080p at 1.7 Mbps keep the 16 KB burst.
    return { bytesPerSecond, burstBytes: Math.max(REMOTE_PACING_BURST_BYTES, Math.ceil(bytesPerSecond / 64)) };
}
'''

THROUGHPUT_METHODS = '''    /** r42: probe counters 5 s after the answer; the 15 s line measures from here, after the startup keyframe burst. */
    private markThroughput(session: HapWebRTCSession): void {
        try {
            const video: any = session.probe?.snapshot()?.video;
            if (typeof video?.lastInputAtMs === 'number')
                session.throughputMark = { atMs: video.lastInputAtMs, frames: video.sourceFrames ?? 0, bytes: video.sourceBytes ?? 0 };
        }
        catch (_) { }
    }

    /** r42: one line to judge remote quality: the frame rate and bitrate actually sent, and the loss the relay reports. */
    private logThroughput(session: HapWebRTCSession): void {
        try {
            const video: any = session.probe?.snapshot()?.video;
            const mark = session.throughputMark;
            if (!mark || typeof video?.lastInputAtMs !== 'number') return;
            const seconds = (video.lastInputAtMs - mark.atMs) / 1000;
            if (!(seconds >= 1)) return;
            const fps = (video.sourceFrames - mark.frames) / seconds;
            const kbps = (video.sourceBytes - mark.bytes) * 8 / seconds / 1000;
            const plan = session.videoPlan;
            const slow = plan && !plan.cameraStream && fps < plan.tier.frameRate * 0.9
                ? `; below ${plan.tier.frameRate} fps, so this server may not re-encode ${plan.resolution} in real time` : '';
            const loss = session.feedback.fractionLostPercent;
            this.console.log(`HomeKit WebRTC throughput: session ${session.sessionId.toString('hex').slice(0, 8)}…, ${plan?.label ?? 'default tier'}; `
                + `video ${fps.toFixed(1)} fps, ${Math.round(kbps)} kbps over ${seconds.toFixed(1)} s, relay loss ${typeof loss === 'number' ? `${loss}%` : 'not reported'}${slow}`);
        }
        catch (_) { }
    }

    private assertReceiveInactive(session: HapWebRTCSession): void {
'''

TIER_OLD = '''    private offeredVideoTier(): VideoStreamTier | undefined {
        let lowest: VideoStreamTier | undefined;
        for (const tier of this.opts.videoTiers) {
            if (!lowest || tier.quality > lowest.quality
                || (tier.quality === lowest.quality && tier.width * tier.height < lowest.width * lowest.height))
                lowest = tier;
        }
        // r41: an explicit 1080p setting offers the camera's medium tier instead.
        if (offeredResolution(this.storage?.getItem(REMOTE_RESOLUTION_KEY)) === '1080p')
            return this.opts.videoTiers.find(tier => tier.quality === CameraVideoQuality.MEDIUM) ?? lowest;
        return lowest;
    }

    private offeredVideoRidLimits(): VideoRidLimits {
        const offered = this.offeredVideoTier();
'''

TIER_NEW = '''    private offeredVideoTier(): VideoStreamTier | undefined {
        return this.settingsVideoPlan()?.tier;
    }

    /** r42: the remote video plan for the current settings. */
    private settingsVideoPlan(streams?: SourceStreamOption[]): RemoteVideoPlan | undefined {
        return remoteVideoPlan(this.opts.videoTiers, offeredResolution(this.storage?.getItem(REMOTE_RESOLUTION_KEY)),
            offeredBitrate(this.storage?.getItem(REMOTE_BITRATE_KEY)), streams);
    }

    /** r42: only a camera-stream plan reads the stream list, so the default offer stays synchronous until ICE gathering. */
    private wantsCameraStream(): boolean {
        const resolution = offeredResolution(this.storage?.getItem(REMOTE_RESOLUTION_KEY));
        const bitrate = offeredBitrate(this.storage?.getItem(REMOTE_BITRATE_KEY));
        return !!this.opts.getSourceStreams && resolution !== '360p'
            && (bitrate.mode === 'camera' || (bitrate.mode === 'automatic' && resolution === '2160p'));
    }

    private async cameraStreamVideoPlan(): Promise<RemoteVideoPlan | undefined> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const streams = await Promise.race([
            Promise.resolve().then(() => this.opts.getSourceStreams!()).then(list => Array.isArray(list) ? list : undefined, () => undefined),
            new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), SOURCE_STREAMS_TIMEOUT); }),
        ]);
        clearTimeout(timer);
        if (!streams) this.console.warn('HomeKit WebRTC: camera stream list unavailable; the camera stream is checked when media starts');
        return this.settingsVideoPlan(streams);
    }

    private offeredVideoRidLimits(session?: HapWebRTCSession): VideoRidLimits {
        const offered = session?.videoPlan?.tier ?? this.offeredVideoTier();
'''

SELECTION_OLD = '''        const rid = session.videoRidLimits;
        const tiers = this.opts.videoTiers.filter(t => t.frameRate <= maxFr
            && t.width <= (rid?.width ?? Infinity)
            && t.height <= (rid?.height ?? Infinity)
            && t.frameRate <= (rid?.frameRate ?? Infinity)
            && Math.ceil(t.width / 16) * Math.ceil(t.height / 16) <= maxFs
            && (codec !== 'h264' || Math.ceil(t.width / 16) * Math.ceil(t.height / 16) <= h264MaxFs)
            && (codec !== 'h265' || t.width * t.height <= hevcMaxPicture));
        if (!tiers.length) throw new Error('No advertised tier fits the negotiated codec limits');
        // r32: send exactly the tier the offer declared while the answer and codec allow it.
        const offered = this.offeredVideoTier();
        const tier = offered && tiers.includes(offered) ? offered
'''

SELECTION_NEW = '''        const rid = session.videoRidLimits;
        const fits = (t: VideoStreamTier) => t.frameRate <= maxFr
            && t.width <= (rid?.width ?? Infinity)
            && t.height <= (rid?.height ?? Infinity)
            && t.frameRate <= (rid?.frameRate ?? Infinity)
            && Math.ceil(t.width / 16) * Math.ceil(t.height / 16) <= maxFs
            && (codec !== 'h264' || Math.ceil(t.width / 16) * Math.ceil(t.height / 16) <= h264MaxFs)
            && (codec !== 'h265' || t.width * t.height <= hevcMaxPicture);
        const tiers = this.opts.videoTiers.filter(fits);
        if (!tiers.length) throw new Error('No advertised tier fits the negotiated codec limits');
        // r32: send exactly the tier the offer declared while the answer and codec allow it.
        // r42: the declared tier can be a scaled 1440p tier or carry its own bitrate, so check it rather than list membership.
        const offered = session.videoPlan?.tier ?? this.offeredVideoTier();
        const tier = offered && fits(offered) ? offered
'''

PATH_LOG_OLD = '''                    ? `remote profile: ${qualityName(selection.tier.quality)} tier ${selection.tier.width}x${selection.tier.height}@${selection.tier.frameRate} ${selection.tier.averageBitrateKbps} kbps, remote stream, paced ${Math.round(remotePacing(selection.tier).bytesPerSecond * 8 / 1000)} kbps, ${REMOTE_SLICE_BYTES}-byte slices, Opus FEC, keyframes every ${REMOTE_KEYFRAMES.startupIntervalSeconds} s for ${REMOTE_KEYFRAMES.startupSeconds} s then every ${REMOTE_KEYFRAMES.gopSeconds} s`
'''

PATH_LOG_NEW = '''                    ? `remote profile: ${qualityName(selection.tier.quality)} tier ${selection.tier.width}x${selection.tier.height}@${selection.tier.frameRate} ${selection.tier.averageBitrateKbps} kbps, remote stream, paced ${Math.round(remotePacing(selection.tier).bytesPerSecond * 8 / 1000)} kbps, ${REMOTE_SLICE_BYTES}-byte slices, Opus FEC, `
                        + (this.sendsCameraStream(session, selection) ? 'camera stream requested, keyframes from the camera'
                            : `keyframes every ${REMOTE_KEYFRAMES.startupIntervalSeconds} s for ${REMOTE_KEYFRAMES.startupSeconds} s then every ${REMOTE_KEYFRAMES.gopSeconds} s`)
                        + (session.videoPlan ? `; plan ${session.videoPlan.label}` : '')
'''

DECISION_OLD = '''            const nativeDecision = videoCopyDecision(input, selection.codec, selection.tier, { allowLowerFrameRate: selection.remote });
            // r41: remote viewers need a bounded bitrate and frequent keyframes, so the camera stream is never passed through.
            const decision = selection.remote && nativeDecision.copy
                ? { copy: false, reason: `remote viewers get a controlled bitrate and keyframe schedule (source matched: ${nativeDecision.reason})` }
                : nativeDecision;
'''

DECISION_NEW = '''            const nativeDecision = videoCopyDecision(input, selection.codec, selection.tier, { allowLowerFrameRate: selection.remote });
            // r41: remote viewers need a bounded bitrate and frequent keyframes, so the camera stream is not passed through,
            // r42: unless the session's plan asks for the camera stream and the stream that opened matches the offered tier.
            const cameraStream = this.sendsCameraStream(session, selection) ? cameraStreamDecision(input, selection) : undefined;
            const decision = cameraStream?.copy ? cameraStream
                : cameraStream ? { copy: false, reason: `${cameraStream.reason}; re-encoding instead` }
                : selection.remote && nativeDecision.copy
                ? { copy: false, reason: `remote viewers get a controlled bitrate and keyframe schedule (source matched: ${nativeDecision.reason})` }
                : nativeDecision;
'''

ENCODER_OLD = '''                            selection.tier.frameRate, selection.tier.averageBitrateKbps, selection.remote ? REMOTE_KEYFRAMES : undefined))],
'''

ENCODER_NEW = '''                            selection.tier.frameRate, selection.tier.averageBitrateKbps, selection.remote ? REMOTE_KEYFRAMES : undefined,
                            // r42: two x265 threads cannot hold 1440p or 4K at 30 fps; 1080p and below keep the earlier arguments.
                            selection.tier.width * selection.tier.height > 1920 * 1080 ? { threads: 'auto' } : undefined))],
'''


def edit_camera(s):
    once = b.once
    s = once(s, RESOLUTION_OLD, PLAN_HELPERS)
    s = once(s, PACING_OLD, PACING_NEW)
    s = once(s, "    acceptRelayTalkback?: boolean;\n}\n",
             "    acceptRelayTalkback?: boolean;\n"
             "    /** r42: the camera's streams, so a remote viewer can receive a camera stream that already matches the offered tier. */\n"
             "    getSourceStreams?: () => Promise<SourceStreamOption[]>;\n}\n")
    s = once(s, "    startupLogged?: boolean;\n}\n",
             "    startupLogged?: boolean;\n"
             "    /** r42: the remote video plan this session's offer declared. */\n"
             "    videoPlan?: RemoteVideoPlan;\n"
             "    /** r42: probe counters 5 s after the answer, for the steady-state throughput line. */\n"
             "    throughputMark?: { atMs: number; frames: number; bytes: number };\n}\n")
    s = once(s, "        const secureVideoOffer = !!this.opts.secureVideoOffer;\n",
             "        // r42: decide the remote resolution, bitrate and camera-stream use once; media and reoffers follow this plan.\n"
             "        const videoPlan = this.wantsCameraStream() ? await this.cameraStreamVideoPlan() : this.settingsVideoPlan();\n"
             "        const secureVideoOffer = !!this.opts.secureVideoOffer;\n")
    s = once(s, "            sessionId, pc, vtrack, atrack, videoTransceiver, audioTransceiver, relayRtcp,\n            createdAt: Date.now(),\n",
             "            sessionId, pc, vtrack, atrack, videoTransceiver, audioTransceiver, relayRtcp,\n            createdAt: Date.now(),\n            videoPlan,\n")
    s = once(s, "                ? withSecureVideoOffer(pc.localDescription?.sdp ?? offer.sdp, this.offeredVideoRidLimits(),\n"
                "                    peakBitrateKbps(this.offeredVideoTier()?.averageBitrateKbps ?? 180))\n"
                "                : withRelaySdpVariant(withSFramePacketization(withExplicitVideoRidPayload(pc.localDescription?.sdp ?? offer.sdp, this.offeredVideoRidLimits()), !!session.sframeConfiguration),\n",
             "                ? withSecureVideoOffer(pc.localDescription?.sdp ?? offer.sdp, this.offeredVideoRidLimits(session),\n"
             "                    session.videoPlan?.peakKbps ?? peakBitrateKbps(this.offeredVideoTier()?.averageBitrateKbps ?? 180))\n"
             "                : withRelaySdpVariant(withSFramePacketization(withExplicitVideoRidPayload(pc.localDescription?.sdp ?? offer.sdp, this.offeredVideoRidLimits(session)), !!session.sframeConfiguration),\n")
    s = once(s, "            session.contract = observeWebRTCContract(session, sdp);\n",
             "            if (session.videoPlan) this.console.log(`HomeKit WebRTC remote video plan: session ${sessionHex.slice(0, 8)}…, ${session.videoPlan.label}; "
             "offer declares ${session.videoPlan.tier.width}x${session.videoPlan.tier.height}@${session.videoPlan.tier.frameRate} up to ${session.videoPlan.peakKbps} kbps`);\n"
             "            session.contract = observeWebRTCContract(session, sdp);\n")
    s = once(s, "                if (!session.closed) this.logStartup(session);\n            }, 5000);\n",
             "                if (!session.closed) this.logStartup(session);\n"
             "                if (!session.closed) this.markThroughput(session);\n            }, 5000);\n")
    s = once(s, "                    if (!session.closed) this.logDiagnostics(session, 'r35-after-' + ms / 1000 + 's');\n",
             "                    if (!session.closed) this.logDiagnostics(session, 'r35-after-' + ms / 1000 + 's');\n"
             "                    if (!session.closed && ms === 15000) this.logThroughput(session);\n")
    s = once(s, "    private assertReceiveInactive(session: HapWebRTCSession): void {\n", THROUGHPUT_METHODS)
    s = once(s, TIER_OLD, TIER_NEW)
    s = once(s, SELECTION_OLD, SELECTION_NEW)
    s = once(s, "    /** Classify the nominated ICE pair once the transport is connected; a setting may force it. */\n",
             "    /** r42: a remote session whose plan asks for the camera's own stream at the tier it sends. */\n"
             "    private sendsCameraStream(session: HapWebRTCSession, selection: HksvMediaSelection): boolean {\n"
             "        return !!(selection.remote && session.videoPlan?.cameraStream && session.videoPlan.tier === selection.tier);\n"
             "    }\n\n"
             "    /** Classify the nominated ICE pair once the transport is connected; a setting may force it. */\n")
    s = once(s, PATH_LOG_OLD, PATH_LOG_NEW)
    s = once(s, DECISION_OLD, DECISION_NEW)
    s = once(s, ENCODER_OLD, ENCODER_NEW)
    return once(s, "const answerLimits = { ...this.offeredVideoRidLimits(), ...session.videoRidLimits };",
                "const answerLimits = { ...this.offeredVideoRidLimits(session), ...session.videoRidLimits };")


HKSV27_OPTION_OLD = "    getWebRTCMedia?: (selection: HksvMediaSelection) => Promise<any>;\n"
HKSV27_OPTION_NEW = (HKSV27_OPTION_OLD + "    /** r42: the camera's stream list, so remote viewers can receive a matching camera stream unchanged. */\n"
                     "    getWebRTCSourceStreams?: () => Promise<any[]>;\n")
HKSV27_PASS_OLD = "                getMedia: opts.getWebRTCMedia,\n"
HKSV27_PASS_NEW = HKSV27_PASS_OLD + "                getSourceStreams: opts.getWebRTCSourceStreams,\n"
CAMERA_OLD = "                    },\n                    disabledServices: hksv27Disabled,\n"
CAMERA_SOURCE = ("                    },\n"
                 "                    // r42: WebRTC checks at offer time whether a camera stream already matches a remote tier.\n"
                 "                    getWebRTCSourceStreams: () => device.getVideoStreamOptions(),\n"
                 "                    disabledServices: hksv27Disabled,\n")
CAMERA_BLOCK = ("                    },\n"
                "                    getWebRTCSourceStreams: () => device.getVideoStreamOptions(),\n"
                "                    disabledServices: hksv27Disabled,\n")

MIXIN_OLD = r'''        hksv27WebRTCRemoteResolution: {
            title: 'Experimental: WebRTC Remote Resolution (r41)',
            type: 'string',
            choices: ['360p (default)', '1080p (experimental)'],
            defaultValue: '360p (default)',
            description: 'Resolution offered to iOS 27 WebRTC viewers. 360p is known to work over cellular. 1080p sends the camera\'s medium tier (1080p at 30 fps, about 1.7 Mbps on 4K cameras); Apple may refuse it for cellular viewers, so try it on remote Wi-Fi first. Takes effect on the next live view.',
        },
'''
MIXIN_NEW = r'''        hksv27WebRTCRemoteResolution: {
            title: 'Experimental: WebRTC Remote Resolution (r42)',
            type: 'string',
            choices: ['360p (default)', '1080p (experimental)', '1440p / 2K (experimental)', '2160p / 4K (experimental)'],
            defaultValue: '360p (default)',
            description: 'Resolution sent to iOS 27 viewers away from home (WebRTC through Apple\'s relay). 360p is known to work over cellular, and 1080p played in r41. 1440p and 4K are untested and Apple may refuse them, especially on cellular. 1080p uses the camera\'s 1080p stream; 1440p scales down the 4K stream, which costs more CPU; 4K sends the camera\'s own 4K stream when it is HEVC. Takes effect on the next live view.',
        },
        hksv27WebRTCRemoteBitrate: {
            title: 'Experimental: WebRTC Remote Video Bitrate (r42)',
            type: 'string',
            choices: ['Automatic (default)', 'Camera stream, no re-encode', '2 Mbps', '4 Mbps', '6 Mbps', '8 Mbps', '12 Mbps', '16 Mbps'],
            defaultValue: 'Automatic (default)',
            description: 'For remote resolutions above 360p. Automatic re-encodes 1080p at 4 Mbps and 1440p at 6 Mbps, and sends a 4K camera\'s own HEVC stream unchanged. "Camera stream" sends the camera\'s stream unchanged when one has exactly the chosen resolution: no CPU and no re-encoding loss, but the picture waits for the camera\'s next keyframe. A fixed value always re-encodes at that bitrate; above the camera stream\'s own bitrate it cannot add detail. Takes effect on the next live view.',
        },
'''


def main():
    archive = base_archive()
    with zipfile.ZipFile(archive) as z:
        assert z.testzip() is None
        entries = {i.filename: (i, z.read(i)) for i in z.infolist()}
    original = entries['main.nodejs.js'][1].decode()
    old = json.loads(entries['build-manifest.json'][1])
    assert old['buildId'] == OLD_BUILD and b.digest(original.encode()) == old['bundleSha256']
    before = b.modules(original)
    smap = json.loads(entries['main.nodejs.js.map'][1])
    out = ROOT / 'dist-r42'; out.mkdir(exist_ok=True)

    def source_index(suffix):
        matches = [i for i, n in enumerate(smap['sources']) if n.endswith(suffix)]
        assert len(matches) == 1, (suffix, matches)
        return matches[0]

    output = original
    for name, edit in (('camera-webrtc.ts', edit_camera), ('hksv-media.ts', edit_media)):
        index = source_index('/' + name)
        source = edit(smap['sourcesContent'][index])
        block = before[b.PREFIX + name]
        deps = json.loads(re.search(r'const dependencies = (\{.*?\});', block)[1])
        output = b.once(output, block, b.compile_module(name, source, deps))
        smap['sourcesContent'][index] = source
        (out / name).write_text(source)

    # Text edits keep these modules' existing compiled form; sourcesContent records the same change.
    text_edits = [
        ('/src/types/camera/camera-hksv27.ts', HKSV27, 'camera-hksv27.ts',
         [(HKSV27_OPTION_OLD, HKSV27_OPTION_NEW, None), (HKSV27_PASS_OLD, HKSV27_PASS_NEW, HKSV27_PASS_NEW)]),
        ('/src/types/camera.ts', CAMERA, 'camera.ts', [(CAMERA_OLD, CAMERA_SOURCE, CAMERA_BLOCK)]),
        ('/src/camera-mixin.ts', MIXIN, 'camera-mixin.ts', [(MIXIN_OLD, MIXIN_NEW, MIXIN_NEW)]),
    ]
    for suffix, module, filename, edits in text_edits:
        index = source_index(suffix)
        source, block = smap['sourcesContent'][index], before[module]
        for old_text, source_text, block_text in edits:
            source = b.once(source, old_text, source_text)
            if block_text is not None: block = b.once(block, old_text, block_text)
        smap['sourcesContent'][index] = source
        output = b.once(output, before[module], block)
        (out / filename).write_text(source)

    assert output.count(OLD_BUILD) == 2
    output = output.replace(OLD_BUILD, BUILD)
    smap['sourcesContent'] = [c.replace(OLD_BUILD, BUILD) if c else c for c in smap['sourcesContent']]
    after = b.modules(output)
    changed = [n for n in before if before[n] != after[n]]
    expected = {b.PREFIX + n for n in ['camera-webrtc.ts', 'hksv-media.ts', 'camera-stream-diagnostics.ts', 'camera-hksv27.ts']} | {CAMERA, MIXIN}
    assert set(changed) == expected, changed
    # camera-hksv27 changes only by the build label and the stream-list pass-through.
    assert after[HKSV27] == b.once(before[HKSV27].replace(OLD_BUILD, BUILD), HKSV27_PASS_OLD, HKSV27_PASS_NEW)
    assert set(after) == set(before)
    sha = b.digest(output.encode())
    manifest = {'buildId': BUILD, 'baseBuildId': OLD_BUILD, 'previousArchiveSha256': BASE_SHA,
        'originalArchiveSha256': old['originalArchiveSha256'], 'bundleSha256': sha,
        'editedModules': changed, 'addedModules': [],
        'change': 'Remote WebRTC quality options. "Experimental: WebRTC Remote Resolution (r42)" adds 1440p (the 4K tier scaled '
                  'to 1440 lines) and 2160p. New "Experimental: WebRTC Remote Video Bitrate (r42)": Automatic re-encodes 1080p at '
                  '4 Mbps (r41: 1.7 Mbps) and 1440p at 6 Mbps, and sends a 4K camera\'s own HEVC stream unchanged; "Camera stream" '
                  'sends a camera stream unchanged whenever one matches the chosen resolution; fixed values from 2 to 16 Mbps always '
                  're-encode. Each offer declares the plan\'s resolution and bitrate (a camera stream with 1.5x headroom over its '
                  'reported rate). 360p is unchanged. Remote encodes above 1080p let x265 choose its thread count, the remote pacer '
                  'burst grows with the pacing rate, and a throughput line (frame rate, bitrate, relay loss) is logged 15 s after the answer.',
        'evidence': 'r41 field log 2026-09-16 06:38-06:39 NZST: 360p startup first video 1645 ms and first audio 889 ms; 1080p '
                    '(1920x1080@30 at 1700 kbps, re-encoded from the camera\'s 1920x1080 HEVC substream reported at 2500 kbps) played '
                    'with relay receiver reports and 0% loss. The user reported the 1080p picture looked low quality.',
        'limitations': ['1440p and 4K through Apple\'s relay are untested; 1440p is not one of the tiers the camera advertises.',
            'Offers above 1.8 Mbps are untested; Apple may refuse them, especially on cellular.',
            'A camera stream sent unchanged starts at the camera\'s next keyframe and is not rate-limited.',
            'Re-encoding 1440p or 4K in software needs substantial CPU; the throughput line reports the frame rate reached.',
            'Re-encoding the 1080p substream above its own bitrate cannot add detail.',
            'Source map offsets are inherited; sourcesContent and dist-r42 contain the exact edited sources.']}
    if '--package' in sys.argv:
        v = json.loads((ROOT / 'diagnostics/r42-tests.json').read_text())
        log = (ROOT / 'diagnostics/r42-tests.log').read_bytes()
        assert v['bundleSha256'] == sha and v['returnCode'] == 0 and v['logSha256'] == b.digest(log)
        total, passed = re.search(rb'tests (\d+)\b', log), re.search(rb'pass (\d+)\b', log)
        assert total and passed and total[1] == passed[1] and int(total[1]) >= 245
        assert re.search(rb'fail 0\b', log) and re.search(rb'skipped 0\b', log)
        manifest['validationChecks'] = int(total[1])
    (out / 'main.nodejs.js').write_text(output)
    (out / 'main.nodejs.js.map').write_text(json.dumps(smap, separators=(',', ':')))
    (out / 'build-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    if '--package' in sys.argv:
        replacements = {n: (out / n).read_bytes() for n in ['main.nodejs.js', 'main.nodejs.js.map', 'build-manifest.json']}
        replacements['HEVC-TESTING.md'] = (ROOT / 'R42-TESTING.md').read_bytes()
        target = ROOT / 'plugin-hevc-webrtc-r42.zip'
        with zipfile.ZipFile(target, 'w') as z:
            for name, (info, data) in entries.items(): z.writestr(info, replacements.get(name, data))
        with zipfile.ZipFile(target) as z: assert z.testzip() is None and z.read('main.nodejs.js') == output.encode()
        result = {'archive': str(target), 'sha256': b.digest(target.read_bytes()), **manifest}
        (ROOT / 'diagnostics/r42-build.json').write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps(result, indent=2))
    else: print(json.dumps({'prepared': BUILD, 'bundleSha256': sha, 'editedModules': changed}))


if __name__ == '__main__': main()
