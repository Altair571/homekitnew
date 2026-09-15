/** HKSV WebRTC: codec negotiation, bounded sessions, and camera privacy gating. */
import { timeoutPromise } from '@scrypted/common/src/promise-utils';
import { randomBytes } from 'crypto';
import type { FFmpegInput } from '@scrypted/sdk';
import { MediaStreamTrack, RTCPeerConnection, RTCRtpCodecParameters, useSdesMid, useSdesRTPStreamId } from '@koush/werift-src/packages/webrtc/src/index';
import { RtpPacket } from '@koush/werift-src/packages/rtp/src/index';
import { startRtpForwarderProcess } from '../../../../webrtc/src/rtp-forwarders';
import { Accessory, Characteristic, Formats, Perms, Service } from '../../hap';
import { logCharacteristicReads, MinimalStorage, recordBisectSignal, StreamingGate } from './camera-multitier';
import { SensorUUIDCharacteristicUUID, StreamingEnabledUUID, tlvDecodeMap } from './hksv-multitier-protocol';
import {
    buildWebRTCReofferResponse,
    buildWebRTCSessionStatusResponse,
    buildWebRTCSolicitOfferResponse,
    CameraWebRTCStreamManagementServiceUUID,
    parseWebRTCProvideAnswer,
    parseWebRTCReoffer,
    parseWebRTCSolicitOffer,
    parseWebRTCStreamingControl,
    parseWebRTCUpdateSession,
    WebRTCIceCandidate,
    WebRTCNumberOfActiveSessionsUUID,
    WebRTCOfferStatus,
    WebRTCProvideAnswerUUID,
    WebRTCReofferUUID,
    WebRTCSolicitOfferUUID,
    WebRTCStreamingControlUUID,
    WebRTCStreamingStatus,
    WebRTCSupportedAudioStreamTiersUUID,
    WebRTCSupportedVideoStreamTiersUUID,
    WebRTCUpdateSessionUUID,
} from './hksv-webrtc-protocol';

import { videoCopyDecision, HksvMediaSelection, normalizeVideoCodec, videoEncoderArguments } from './hksv-media';
import { createHksvRtpPacer } from './hksv-rtp-pacer';
import { WebRTCReceiveKeys } from './hksv-webrtc-receive-keys';
import { SFrameRtpSender } from './hksv-sframe';
import { createWebRTCMediaProbe } from './hksv-webrtc-probe';
import { createFrameMarkingProbe, frameMarkingExtension } from './hksv-frame-marking';
import { createRelayPublisher, createRelayVariantRotation, relayStreamId, usesStreamIdRid, withRelaySdpVariant } from './hksv-relay-publish';
import type { RelayVariant } from './hksv-relay-publish';
import { CameraVideoQuality, RECOMMENDED_BITRATES_KBPS, VideoStreamTier } from './hksv-stream-tiers';
import { encodeSupportedVideoStreamTiers, TierVideoCodec } from './hksv-stream-tiers';
import { classifyWebRTCPath, summarizeWebRTCSdp, summarizeWebRTCCandidates, summarizeWebRTCTransport, WebRTCPathSummary } from './hksv-webrtc-diagnostics';
import { protectWebRTCDtlsStartup } from './hksv-webrtc-dtls';
import { observeWebRTCWire } from './hksv-webrtc-wire-diagnostics';
import { observeWebRTCContract, summarizeWebRTCContractSdp } from './hksv-webrtc-contract';

const WEBRTC_STREAMING_ENABLED_KEY = 'hksv27-webrtc-streaming-enabled';
/** §3.7: the accessory must support at least six simultaneous WebRTC sessions. */
const MAX_SESSIONS = 6;
/** A solicited session the controller never answers is reaped after this long. */
const UNANSWERED_SESSION_TIMEOUT = 60000;
// Apple's relay requires a video RID even when only one encoding is sent.
const VIDEO_RID = '1';

/** Off-LAN viewers (cellular, Apple's relay) lose packets a LAN never drops, and
 * one lost packet discards a whole HEVC access unit. r25 sent every session the
 * LAN profile: the 4K tier in 32 KB bursts at 40 Mbps with a 128-packet
 * retransmission history, so remote keyframes never arrived intact and audio
 * gapped. Remote sessions now use the camera's remote stream, a capped tier,
 * pacing near the tier bitrate, smaller packets and Opus loss protection. LAN
 * sessions keep the r25 behavior exactly.
 */
const REMOTE_QUALITY_KEY = 'hksv27WebRTCRemoteQuality';
const PATH_MODE_KEY = 'hksv27WebRTCPathMode';
const REMOTE_SLICE_BYTES = 1000;
const REMOTE_PACING_MULTIPLIER = 4;
const REMOTE_PACING_FLOOR_BPS = 2_000_000;
const REMOTE_PACING_BURST_BYTES = 16384;
const REMOTE_OPUS_PACKET_LOSS_PERCENT = 15;
/** r41: remote viewers join after the first IDR. Force one every 0.5 s for 4 s, then send one every second. */
const REMOTE_KEYFRAMES = { gopSeconds: 1, startupIntervalSeconds: 0.5, startupSeconds: 4 };
const REMOTE_RESOLUTION_KEY = 'hksv27WebRTCRemoteResolution';
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
    const mbps = Number(/^(\d+(?:\.\d+)?) ?mbps\b/.exec(value)?.[1]);
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

export function remoteQualityFloor(setting?: string | null): CameraVideoQuality {
    switch ((setting ?? '').trim().toLowerCase().split(/[\s(]/)[0]) {
        case 'high': return CameraVideoQuality.HIGH;
        case 'low': return CameraVideoQuality.LOW;
        default: return CameraVideoQuality.MEDIUM;
    }
}

/** Larger quality enumerations are lower quality: the best tier at or below the floor. */
export function selectRemoteTier(tiers: VideoStreamTier[], floor: CameraVideoQuality): VideoStreamTier | undefined {
    return tiers.find(tier => tier.quality >= floor) ?? tiers[tiers.length - 1];
}

export function qualityName(quality: CameraVideoQuality): string {
    return Object.entries(CameraVideoQuality).find(([, value]) => value === quality)?.[0]?.toLowerCase() ?? String(quality);
}

export function remotePacing(tier: VideoStreamTier): { bytesPerSecond: number; burstBytes: number } {
    const bytesPerSecond = Math.max(REMOTE_PACING_FLOOR_BPS, tier.averageBitrateKbps * 1000 * REMOTE_PACING_MULTIPLIER) / 8;
    // r42: timers can fire about every 15 ms (Windows), so each wake-up carries that much credit; otherwise
    // 4K bitrates queue until the session fails. Tiers up to 1080p at 1.7 Mbps keep the 16 KB burst.
    return { bytesPerSecond, burstBytes: Math.max(REMOTE_PACING_BURST_BYTES, Math.ceil(bytesPerSecond / 64)) };
}

export function forcedPathKind(setting?: string | null): 'lan' | 'remote' | undefined {
    const mode = (setting ?? '').trim().toLowerCase();
    if (mode.startsWith('always remote')) return 'remote';
    if (mode.startsWith('always lan') || mode.startsWith('always local')) return 'lan';
    return undefined;
}

export interface WebRTCFeedbackCounters {
    nacks: number;
    nackedPackets: number;
    plis: number;
    receiverReports: number;
    fractionLostPercent?: number;
    packetsLost?: number;
    jitter?: number;
}

/** Bounded numeric receiver feedback for diagnostics; RTCP is never logged raw. */
export function observeSenderFeedback(sender: any, feedback: WebRTCFeedbackCounters): void {
    try {
        sender?.onGenericNack?.subscribe?.((nack: any) => {
            feedback.nacks++;
            feedback.nackedPackets += Array.isArray(nack?.lost) ? nack.lost.length : 0;
        });
        sender?.onPictureLossIndication?.subscribe?.(() => { feedback.plis++; });
        sender?.onRtcp?.subscribe?.((packet: any) => {
            for (const report of Array.isArray(packet?.reports) ? packet.reports : []) {
                if (report?.ssrc !== sender.ssrc) continue;
                feedback.receiverReports++;
                if (Number.isFinite(report.fractionLost)) feedback.fractionLostPercent = Math.round(report.fractionLost * 1000 / 255) / 10;
                if (Number.isFinite(report.packetsLost)) feedback.packetsLost = report.packetsLost;
                if (Number.isFinite(report.jitter)) feedback.jitter = report.jitter;
            }
        });
    }
    catch (_) { }
}

/** Make the sole HEVC payload mapping explicit for Apple's remote media relay.
 * RFC 8851 permits the previous implicit mapping. This is an interoperability
 * experiment for the iPhone's empty remote camera group, not a standards fix.
 * Decorate the wire description after werift serializes it: the bundled RID
 * parser treats restrictions as part of the direction. No transport, codec or
 * sender parameter changes, and no new RID is added when a reoffer omits it.
 */
type VideoRidLimits = { width: number; height: number; frameRate: number };

/** Signal the SFrame RTP payload format at media level (RTP SFrame draft §6).
 * HomeKit negotiates SFrame through its authenticated characteristic as well.
 * Preserve that agreement when older controller SDP omits this attribute.
 * Relay interoperability is unverified; do not change the actual cipher here.
 */
export function withSFramePacketization(sdp: string, enabled: boolean): string {
    if (!enabled) return sdp;
    return sdp.split(/(?=^m=)/m).map(section => {
        if (!/^m=(?:audio|video) [1-9][0-9]*(?:\/\d+)? /.test(section)
            || /^a=inactive\r?$/m.test(section) || /^a=sframe\r?$/m.test(section)) return section;
        const newline = section.includes('\r\n') ? '\r\n' : '\n';
        return section.replace(/^(m=[^\r\n]+)(\r?\n|$)/, (_, line) => line + newline + 'a=sframe' + newline);
    }).join('');
}

/** r33: werift numbers header extensions across media kinds, so audio MID was 1 and
 * video MID 2. One BUNDLE transport needs one MID extension ID in every m-section
 * (RFC 8843), and Apple's relay omitted MID from its answers. Use the video MID ID.
 */
export function alignBundledMidExtension(pc: RTCPeerConnection): void {
    const extensions: any = (pc as any)?.getConfiguration?.()?.headerExtensions ?? {};
    const all: any[] = [...(extensions.video ?? []), ...(extensions.audio ?? [])];
    const mid = all.find(extension => extension?.uri === 'urn:ietf:params:rtp-hdrext:sdes:mid');
    if (!mid)
        return;
    for (const extension of all)
        if (extension.uri === mid.uri)
            extension.id = mid.id;
}
/** r33 diagnostics: count RTCP from the relay by type and by the local stream it names.
 * Bounded counters only; RTCP bodies, SSRC values and addresses are not retained.
 */
export function observeRelayRtcp(pc: any, videoSsrc: () => number | undefined, audioSsrc: () => number | undefined) {
    const router = pc?.router;
    const original = router?.routeRtcp;
    if (typeof original !== 'function')
        return { snapshot: () => ({ unavailable: true }), dispose() { } };
    const counts: Record<string, number> = {};
    const add = (key: string) => { counts[key] = (counts[key] ?? 0) + 1; };
    const media = (ssrc: unknown) => ssrc === videoSsrc() ? 'video' : ssrc === audioSsrc() ? 'audio' : 'other';
    const format = (feedback: any) => {
        const count = feedback?.count ?? feedback?.constructor?.count;
        return Number.isInteger(count) && count >= 0 && count < 32 ? count : '?';
    };
    const hook = (packet: any) => {
        try {
            add('packets');
            switch (packet?.type) {
                case 200:
                    add('sr');
                    for (const report of Array.isArray(packet.reports) ? packet.reports : [])
                        add('sr.' + media(report?.ssrc));
                    break;
                case 201:
                    for (const report of Array.isArray(packet.reports) ? packet.reports : [])
                        add('rr.' + media(report?.ssrc));
                    break;
                case 202: add('sdes'); break;
                case 203: add('bye'); break;
                case 205: add('rtpfb' + format(packet.feedback) + '.' + media(packet.feedback?.mediaSourceSsrc)); break;
                case 206: {
                    const count = format(packet.feedback);
                    add('psfb' + count + '.' + media(count === 15 ? packet.feedback?.ssrcFeedbacks?.[0] : packet.feedback?.mediaSsrc));
                    break;
                }
                default: add('other');
            }
        }
        catch (_) { }
        return original(packet);
    };
    router.routeRtcp = hook;
    return { snapshot: () => ({ ...counts }), dispose() { if (router.routeRtcp === hook) router.routeRtcp = original; } };
}

export function readVideoRidLimits(sdp: string, rid = VIDEO_RID): Partial<VideoRidLimits> {
    const section = sdp.split(/(?=^m=)/m).find(part => part.startsWith('m=video '));
    const restrictions = section && new RegExp('^a=rid:' + rid.replace(/[^A-Za-z0-9]/g, '') + ' recv(?: ([^\\r\\n]*))?\\r?$', 'm').exec(section)?.[1];
    const limits: Partial<VideoRidLimits> = {};
    for (const [wire, field] of [['max-width', 'width'], ['max-height', 'height'], ['max-fps', 'frameRate']] as const) {
        const value = restrictions?.split(';').find(part => part.startsWith(wire + '='))?.slice(wire.length + 1);
        if (value === undefined) continue;
        if (!/^\d+(?:\.\d+)?$/.test(value) || !Number.isFinite(Number(value)) || Number(value) <= 0)
            throw new Error('Invalid remote video RID limit');
        limits[field] = Number(value);
    }
    return limits;
}

export function withExplicitVideoRidPayload(sdp: string, limits?: VideoRidLimits, rid = VIDEO_RID): string {
    return sdp.split(/(?=^m=)/m).map(section => {
        if (!section.startsWith('m=video ')) return section;
        const payload = /^a=rtpmap:(\d+) H265\/90000\r?$/mi.exec(section)?.[1];
        const formats = section.split(/\r?\n/, 1)[0].split(/\s+/).slice(3);
        if (!payload || !formats.includes(payload)) return section;
        const dimensions = limits
            ? ';max-width=' + limits.width + ';max-height=' + limits.height + ';max-fps=' + limits.frameRate : '';
        const id = rid.replace(/[^A-Za-z0-9]/g, '');
        return section.replace(new RegExp('^a=rid:' + id + ' send(\\r?)$', 'm'), 'a=rid:' + id + ' send pt=' + payload + dimensions + '$1');
    }).join('');
}

/** r39: the offer shape that plays remotely through Apple's relay in HAP-NodeJS PR 1132
 * (camera.ui). The relay turns the offer into the viewer's media blob; a video stream without
 * a bitrate reaches the viewer as "no valid streams". The RID is declared for the relay's
 * parser only: no RTP header extension is negotiated, so packets carry none and the relay
 * maps them by SSRC. SFrame stays signaled through the HomeKit characteristic alone.
 */
const RTP_STREAM_ID_URI = 'urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id';

/** Apple's recommended peak for a tier's average bitrate (camera.ui advertises the peak). */
export function peakBitrateKbps(averageBitrateKbps: number): number {
    const match = Object.values(RECOMMENDED_BITRATES_KBPS).find(rate => rate.average === averageBitrateKbps);
    return match ? match.maximum : Math.ceil(averageBitrateKbps * 1.06);
}

export function withSecureVideoOffer(sdp: string, limits: VideoRidLimits, peakKbps: number): string {
    const lines = sdp.split(/\r?\n/);
    const start = lines.findIndex(line => line.startsWith('m=video '));
    if (start < 0) return sdp;
    let end = lines.findIndex((line, index) => index > start && line.startsWith('m='));
    if (end < 0) end = lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
    if (lines.slice(start, end).some(line => line.startsWith('a=rid:') || line.startsWith('b=AS:'))) return sdp;
    const bitrate = Math.round(peakKbps * 1000);
    const used = new Set(lines.map(line => Number(/^a=extmap:(\d+)/.exec(line)?.[1])).filter(Number.isInteger));
    let id = 1;
    while (used.has(id) && id < 14) id++;
    lines.splice(end, 0, 'a=extmap:' + id + ' ' + RTP_STREAM_ID_URI,
        'a=rid:' + VIDEO_RID + ' send max-width=' + limits.width + ';max-height=' + limits.height + ';max-fps=' + limits.frameRate + ';max-br=' + bitrate,
        'a=simulcast:send ' + VIDEO_RID);
    const connection = lines.findIndex((line, index) => index > start && index < end && line.startsWith('c='));
    lines.splice(connection < 0 ? start + 1 : connection + 1, 0, 'b=AS:' + Math.round(peakKbps), 'b=TIAS:' + bitrate);
    return lines.join('\r\n');
}

const webrtcHevcCodec = new RTCRtpCodecParameters({
    mimeType: 'video/H265', clockRate: 90000, payloadType: 99,
    parameters: 'profile-id=1;tier-flag=0;level-id=153;tx-mode=SRST',
    rtcpFeedback: [{ type: 'nack' }, { type: 'nack', parameter: 'pli' }, { type: 'ccm', parameter: 'fir' }],
});

const webrtcAudioCodec = new RTCRtpCodecParameters({
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2,
    payloadType: 110,
    parameters: 'minptime=20;useinbandfec=1;stereo=0;sprop-stereo=0',
});

export interface WebRTCManagementOptions {
    sensorUuid: Buffer;
    storage?: MinimalStorage;
    /** §4.23/§4.24 use the same TLV layout as the RTP tiers characteristics. */
    supportedVideoTiersValue: string;
    supportedAudioTiersValue: string;
    gate?: StreamingGate;
    videoTiers: VideoStreamTier[];
    getMedia?: (selection: HksvMediaSelection) => Promise<FFmpegInput>;
    /** r37: rotate relay publication experiments per solicited offer; omitted keeps the r36 offer. */
    relayVariants?: readonly RelayVariant[];
    /** r39: offer the shape that plays through Apple's relay in HAP-NodeJS PR 1132 (camera.ui). */
    secureVideoOffer?: boolean;
    /** r40: answer the relay reoffer that adds a talkback audio section instead of closing the session.
     * The added receiver is never played; the camera's own video and audio stay send-only. */
    acceptRelayTalkback?: boolean;
    /** r42: the camera's streams, so a remote viewer can receive a camera stream that already matches the offered tier. */
    getSourceStreams?: () => Promise<SourceStreamOption[]>;
}

interface HapWebRTCSession {
    sessionId: Buffer;
    pc: RTCPeerConnection;
    vtrack: MediaStreamTrack;
    atrack: MediaStreamTrack;
    videoTransceiver: any;
    audioTransceiver: any;
    starting?: boolean;
    mediaGeneration: number;
    answered: boolean;
    closed: boolean;
    forwarder?: Awaited<ReturnType<typeof startRtpForwarderProcess>>;
    audioForwarder?: Awaited<ReturnType<typeof startRtpForwarderProcess>>;
    audioTimer?: ReturnType<typeof setTimeout>;
    pacer?: ReturnType<typeof createHksvRtpPacer>;
    receiveKeys: WebRTCReceiveKeys;
    sframeConfiguration?: { key: Buffer; kid: bigint };
    videoSframe?: SFrameRtpSender;
    audioSframe?: SFrameRtpSender;
    videoRidLimits?: Partial<VideoRidLimits>;
    /** Nominated-pair classification; set when media starts. */
    path?: WebRTCPathSummary & { forced?: boolean };
    remote?: boolean;
    feedback: WebRTCFeedbackCounters;
    transports: Set<RTCPeerConnection['dtlsTransports'][number]>;
    dtlsStartup: Map<any, () => void>;
    reapTimer?: ReturnType<typeof setTimeout>;
    diagnosticTimer?: ReturnType<typeof setTimeout>;
    probeTimers?: ReturnType<typeof setTimeout>[];
    probe?: ReturnType<typeof createWebRTCMediaProbe>;
    frameMarking?: ReturnType<typeof createFrameMarkingProbe>;
    videoRid: string;
    relayVariant?: RelayVariant;
    relay?: ReturnType<typeof createRelayPublisher>;
    wire?: ReturnType<typeof observeWebRTCWire>;
    relayRtcp?: ReturnType<typeof observeRelayRtcp>;
    contract?: ReturnType<typeof observeWebRTCContract>;
    createdAt: number;
    /** r40: the negotiation the running media was started for. */
    mediaSignature?: string;
    /** r41: startup milestones for the timing summary. */
    answeredAt?: number;
    connectedAt?: number;
    startupLogged?: boolean;
    /** r42: the remote video plan this session's offer declared. */
    videoPlan?: RemoteVideoPlan;
    /** r42: probe counters 5 s after the answer, for the steady-state throughput line. */
    throughputMark?: { atMs: number; frames: number; bytes: number };
}

export class WebRTCStreamManagement {
    readonly service: Service;
    private readonly console: Console;
    private readonly storage?: MinimalStorage;
    private readonly getMedia?: WebRTCManagementOptions['getMedia'];
    private readonly opts: WebRTCManagementOptions;
    private locallyEnabled = true;
    private readonly sessions = new Map<string, HapWebRTCSession>();
    private activeSessionsChar: Characteristic;
    private resetPersistedState?: () => void;
    private readonly relayRotation?: ReturnType<typeof createRelayVariantRotation>;

    constructor(accessory: Accessory, console: Console, opts: WebRTCManagementOptions) {
        this.console = console;
        this.opts = opts;
        this.storage = opts.storage;
        this.getMedia = opts.getMedia;
        this.relayRotation = opts.relayVariants?.length ? createRelayVariantRotation(opts.relayVariants) : undefined;
        this.service = new Service('HomeKit WebRTC Streaming', CameraWebRTCStreamManagementServiceUUID, 'hksv27-webrtc');

        opts.gate?.onChanged(() => { if (!this.streamingEnabled()) this.closeAllSessions(); });
        // §4.23 repeats tiers, not codec groups. SDP must match this HEVC advertisement.
        const supportedVideo = encodeSupportedVideoStreamTiers([
            { codec: TierVideoCodec.H265, payloadType: 99, tiers: opts.videoTiers },
        ]).toString('base64');

        // --- Supported tiers (PR + Notify) ---
        const videoTiers = new Characteristic('WebRTC Supported Video Stream Tiers', WebRTCSupportedVideoStreamTiersUUID, {
            format: Formats.TLV8, perms: [Perms.PAIRED_READ, Perms.NOTIFY],
        });
        videoTiers.updateValue(supportedVideo);
        logCharacteristicReads(videoTiers, console, 'WebRTC Supported Video Stream Tiers', () => supportedVideo);
        this.service.addCharacteristic(videoTiers);

        const audioTiers = new Characteristic('WebRTC Supported Audio Stream Tiers', WebRTCSupportedAudioStreamTiersUUID, {
            format: Formats.TLV8, perms: [Perms.PAIRED_READ, Perms.NOTIFY],
        });
        audioTiers.updateValue(opts.supportedAudioTiersValue);
        logCharacteristicReads(audioTiers, console, 'WebRTC Supported Audio Stream Tiers', () => opts.supportedAudioTiersValue);
        this.service.addCharacteristic(audioTiers);

        // --- Streaming Enabled (persisted) ---
        const streamingEnabled = new Characteristic('Streaming Enabled', StreamingEnabledUUID, {
            format: Formats.BOOL,
            perms: [Perms.PAIRED_READ, Perms.PAIRED_WRITE, Perms.NOTIFY, Perms.TIMED_WRITE],
        });
        this.locallyEnabled = this.storage?.getItem(WEBRTC_STREAMING_ENABLED_KEY) !== 'false';
        const enabled = () => this.locallyEnabled;
        streamingEnabled.updateValue(enabled());
        logCharacteristicReads(streamingEnabled, console, 'Streaming Enabled (WebRTC)', enabled);
        streamingEnabled.on('set', (value: any, cb: any) => {
            this.console.log(`HomeKit iOS 27: controller wrote Streaming Enabled (WebRTC) = ${value}`);
            recordBisectSignal(this.storage, `Streaming Enabled (WebRTC) = ${!!value}`);
            this.storage?.setItem(WEBRTC_STREAMING_ENABLED_KEY, (!!value).toString());
            this.locallyEnabled = !!value;
            if (!this.streamingEnabled()) this.closeAllSessions();
            cb(null);
        });
        this.resetPersistedState = () => {
            this.storage?.removeItem(WEBRTC_STREAMING_ENABLED_KEY);
            this.locallyEnabled = true;
            streamingEnabled.updateValue(true);
        };
        this.service.addCharacteristic(streamingEnabled);

        // --- Sensor UUID ---
        const sensorUuid = new Characteristic('Sensor UUID', SensorUUIDCharacteristicUUID, {
            format: Formats.DATA, perms: [Perms.PAIRED_READ],
        });
        const sensorUuidValue = opts.sensorUuid.toString('base64');
        sensorUuid.updateValue(sensorUuidValue);
        logCharacteristicReads(sensorUuid, console, 'Sensor UUID (WebRTC)', () => sensorUuidValue);
        this.service.addCharacteristic(sensorUuid);

        // --- Number of Active Sessions (uint8, PR + Notify) ---
        this.activeSessionsChar = new Characteristic('WebRTC Number of Active Sessions', WebRTCNumberOfActiveSessionsUUID, {
            format: Formats.UINT8, perms: [Perms.PAIRED_READ, Perms.NOTIFY], minValue: 0, maxValue: 255,
        });
        this.activeSessionsChar.updateValue(0);
        logCharacteristicReads(this.activeSessionsChar, console, 'WebRTC Number of Active Sessions', () => this.sessions.size);
        this.service.addCharacteristic(this.activeSessionsChar);

        // --- Solicit Offer (PR/PW/WR): create a session + SDP offer ---
        const solicit = new Characteristic('WebRTC Solicit Offer', WebRTCSolicitOfferUUID, {
            format: Formats.TLV8, perms: [Perms.PAIRED_READ, Perms.PAIRED_WRITE, Perms.WRITE_RESPONSE],
        });
        let lastSolicitResponse = '';
        logCharacteristicReads(solicit, console, 'WebRTC Solicit Offer', () => lastSolicitResponse);
        solicit.on('set', (value: any, cb: any) => {
            this.handleSolicitOffer(value)
                .then(response => {
                    lastSolicitResponse = response;
                    cb(null, response);
                })
                .catch(e => {
                    this.console.error('WebRTC solicit offer failed', e);
                    cb(e);
                });
        });
        this.service.addCharacteristic(solicit);

        // --- Provide Answer / Streaming Control / Reoffer / Update Session ---
        this.addSessionCharacteristic('WebRTC Provide Answer', WebRTCProvideAnswerUUID,
            value => this.handleProvideAnswer(value));
        this.addSessionCharacteristic('WebRTC Streaming Control', WebRTCStreamingControlUUID,
            async value => this.handleStreamingControl(value));
        this.addSessionCharacteristic('WebRTC Reoffer', WebRTCReofferUUID,
            value => this.handleReoffer(value));
        this.addSessionCharacteristic('WebRTC Update Session', WebRTCUpdateSessionUUID,
            async value => this.handleUpdateSession(value));

        accessory.addService(this.service);
    }

    private addSessionCharacteristic(name: string, uuid: string, handler: (value: Buffer) => Promise<Buffer>): void {
        const char = new Characteristic(name, uuid, {
            format: Formats.TLV8,
            perms: [Perms.PAIRED_READ, Perms.PAIRED_WRITE, Perms.WRITE_RESPONSE],
        });
        let lastResponse = '';
        logCharacteristicReads(char, this.console, name, () => lastResponse);
        char.on('set', (value: any, cb: any) => {
            handler(Buffer.from(value, 'base64'))
                .then(response => {
                    lastResponse = response.toString('base64');
                    cb(null, lastResponse);
                })
                .catch(e => {
                    this.console.error(`${name} write failed`, e);
                    cb(e);
                });
        });
        this.service.addCharacteristic(char);
    }

    private updateSessionCount(): void {
        this.activeSessionsChar.updateValue(Math.min(255, this.sessions.size));
    }

    private streamingEnabled(): boolean {
        return this.locallyEnabled && (this.opts.gate?.isActive() ?? true);
    }

    /** Reset persisted state to spec defaults (last pairing removed). */
    handleFactoryReset(): void {
        this.closeAllSessions();
        this.resetPersistedState?.();
    }

    // ------------------------------------------------------------------
    // §4.17 Solicit Offer → new peer connection + SDP offer
    // ------------------------------------------------------------------

    private async handleSolicitOffer(value: string): Promise<string> {
        recordBisectSignal(this.storage, 'WebRTC Solicit Offer written');
        const req = parseWebRTCSolicitOffer(Buffer.from(value, 'base64'));
        const sessionId = randomBytes(16);

        if (!this.streamingEnabled() || this.sessions.size >= MAX_SESSIONS) {
            this.console.log(`HomeKit iOS 27: WebRTC Solicit Offer rejected (${this.streamingEnabled() ? 'session limit' : 'streaming disabled'})`);
            return buildWebRTCSolicitOfferResponse({
                sessionId,
                status: this.streamingEnabled() ? WebRTCOfferStatus.ERROR : WebRTCOfferStatus.PRIVACY_MODE_ACTIVE,
            }).toString('base64');
        }
        if (!this.getMedia) {
            this.console.error('HomeKit iOS 27: WebRTC Solicit Offer with no media source wired; responding Error');
            return buildWebRTCSolicitOfferResponse({ sessionId, status: WebRTCOfferStatus.ERROR }).toString('base64');
        }

        // r42: decide the remote resolution, bitrate and camera-stream use once; media and reoffers follow this plan.
        const videoPlan = this.wantsCameraStream() ? await this.cameraStreamVideoPlan() : this.settingsVideoPlan();
        const secureVideoOffer = !!this.opts.secureVideoOffer;
        const pc = new RTCPeerConnection({
            codecs: {
                video: [webrtcHevcCodec],
                audio: [webrtcAudioCodec],
            },
            // r39: like camera.ui, negotiate no RTP header extensions and gather IPv4 only.
            headerExtensions: secureVideoOffer ? { video: [], audio: [] } : {
                video: [useSdesMid(), useSdesRTPStreamId(), frameMarkingExtension()],
                audio: [useSdesMid()],
            },
            ...(secureVideoOffer ? { iceUseIpv6: false } : {}),
        });
        alignBundledMidExtension(pc);
        const vtrack = new MediaStreamTrack({ kind: 'video' });
        const atrack = new MediaStreamTrack({ kind: 'audio' });
        const videoTransceiver = pc.addTransceiver(vtrack, secureVideoOffer ? { direction: 'sendonly' } : {
            direction: 'sendonly', simulcast: [{ rid: VIDEO_RID, direction: 'send' }],
        });
        const audioTransceiver = pc.addTransceiver(atrack, { direction: 'sendonly' });
        const relayRtcp = observeRelayRtcp(pc, () => videoTransceiver.sender?.ssrc, () => audioTransceiver.sender?.ssrc);
        const feedback: WebRTCFeedbackCounters = { nacks: 0, nackedPackets: 0, plis: 0, receiverReports: 0 };
        observeSenderFeedback(videoTransceiver.sender, feedback);

        const candidates: WebRTCIceCandidate[] = [];
        pc.onIceCandidate.subscribe((candidate: any) => {
            try {
                const json = candidate?.toJSON ? candidate.toJSON() : candidate;
                if (json?.candidate) {
                    candidates.push({
                        candidate: json.candidate,
                        sdpMid: json.sdpMid ?? undefined,
                        sdpMLineIndex: json.sdpMLineIndex ?? undefined,
                    });
                }
            }
            catch (e) {
            }
        });

        const session: HapWebRTCSession = {
            sessionId, pc, vtrack, atrack, videoTransceiver, audioTransceiver, relayRtcp,
            createdAt: Date.now(),
            videoPlan,
            mediaGeneration: 0,
            videoRid: VIDEO_RID,
            answered: false,
            closed: false,
            feedback,
            receiveKeys: new WebRTCReceiveKeys(),
            // tvOS 27 requires SFrame config even for its empty Solicit Offer.
            sframeConfiguration: req.sframeEnabled !== false
                ? { key: randomBytes(32), kid: randomBytes(8).readBigUInt64BE() } : undefined,
            transports: new Set(pc.dtlsTransports),
            dtlsStartup: new Map(pc.dtlsTransports.map(transport => [transport, protectWebRTCDtlsStartup(transport)])),
        };
        const sessionHex = sessionId.toString('hex');

        session.probe = createWebRTCMediaProbe(session);
        session.frameMarking = createFrameMarkingProbe(session);
        const relayPick = this.relayRotation?.next();
        if (relayPick) {
            session.relayVariant = relayPick.variant;
            // r37: Apple's relay acknowledges video only when the RID is its stream ID.
            if (usesStreamIdRid(relayPick.variant)) session.videoRid = String(relayStreamId(videoTransceiver.sender.ssrc));
            session.relay = createRelayPublisher(session, relayPick, message => this.console.log(message));
            this.console.log(`HomeKit WebRTC r38 relay variant ${relayPick.index + 1}/${relayPick.count} ${relayPick.variant}: session ${sessionHex.slice(0, 8)}…`);
        }
        this.sessions.set(sessionHex, session);
        session.reapTimer = setTimeout(() => this.closeSession(sessionHex), UNANSWERED_SESSION_TIMEOUT);
        this.updateSessionCount();

        pc.iceConnectionStateChange?.subscribe(() => {
            if (!session.closed) this.logDiagnostics(session, 'ice-state');
        });
        for (const transport of session.transports) transport.onStateChange?.subscribe(() => {
            if (!session.closed && session.pc.dtlsTransports.includes(transport)) this.logDiagnostics(session, 'dtls-state');
        });
        pc.connectionStateChange.subscribe((state: string) => {
            this.console.log(`HomeKit iOS 27: WebRTC session ${sessionHex.slice(0, 8)}… connection state: ${state}`);
            if (state === 'connected') {
                session.connectedAt ??= Date.now();
                this.startMedia(session).catch(e => { this.console.error('WebRTC media start failed', e); this.closeSession(sessionHex); });
            }
            else if (state === 'failed' || state === 'closed' || state === 'disconnected')
                this.closeSession(sessionHex);
        });

        try {
            // A data channel variant adds an SCTP transport; release it like the offered media transports.
            session.relay?.attach(pc);
            for (const transport of pc.dtlsTransports) {
                if (session.transports.has(transport)) continue;
                session.transports.add(transport);
                session.dtlsStartup.set(transport, protectWebRTCDtlsStartup(transport));
            }
            const offer = await pc.createOffer();
            // This bundled werift awaits ICE gathering inside setLocalDescription.
            await pc.setLocalDescription(offer);
            if (session.closed || !this.streamingEnabled()) throw new Error('Session canceled during ICE gathering');
            session.wire = observeWebRTCWire(session);
            const sdp = secureVideoOffer
                ? withSecureVideoOffer(pc.localDescription?.sdp ?? offer.sdp, this.offeredVideoRidLimits(session),
                    session.videoPlan?.peakKbps ?? peakBitrateKbps(this.offeredVideoTier()?.averageBitrateKbps ?? 180))
                : withRelaySdpVariant(withSFramePacketization(withExplicitVideoRidPayload(pc.localDescription?.sdp ?? offer.sdp, this.offeredVideoRidLimits(session)), !!session.sframeConfiguration),
                    session.relayVariant, { videoSsrc: videoTransceiver.sender.ssrc, audioSsrc: audioTransceiver.sender.ssrc, videoRid: session.videoRid }, VIDEO_RID);
            this.console.log(`HomeKit WebRTC offer ready: session ${sessionHex.slice(0, 8)}…, H265, send-only, video RID=${session.videoRid}${secureVideoOffer ? ' (secure video offer)' : ''}, outgoing SFrame=${!!session.sframeConfiguration}`);
            this.console.log(`HomeKit WebRTC SSRCs: session ${sessionHex.slice(0, 8)}…, video 0x${(videoTransceiver.sender.ssrc >>> 0).toString(16).padStart(8, '0')}, audio 0x${(audioTransceiver.sender.ssrc >>> 0).toString(16).padStart(8, '0')} (compare with the viewer media blob)`);
            if (session.videoPlan) this.console.log(`HomeKit WebRTC remote video plan: session ${sessionHex.slice(0, 8)}…, ${session.videoPlan.label}; offer declares ${session.videoPlan.tier.width}x${session.videoPlan.tier.height}@${session.videoPlan.tier.frameRate} up to ${session.videoPlan.peakKbps} kbps`);
            session.contract = observeWebRTCContract(session, sdp);
            this.logDiagnostics(session, 'offer', sdp, candidates);
            return buildWebRTCSolicitOfferResponse({ sessionId, status: WebRTCOfferStatus.SUCCESS,
                sdpOffer: sdp, additionalCandidates: candidates, sframeConfiguration: session.sframeConfiguration }).toString('base64');
        }
        catch (e) {
            this.closeSession(sessionHex);
            this.console.error('WebRTC offer failed', e);
            return buildWebRTCSolicitOfferResponse({ sessionId, status: WebRTCOfferStatus.ERROR }).toString('base64');
        }
    }

    // ------------------------------------------------------------------
    // §4.18 Provide Answer → remote description + media on connect
    // ------------------------------------------------------------------

    private async handleProvideAnswer(value: Buffer): Promise<Buffer> {
        recordBisectSignal(this.storage, 'WebRTC Provide Answer written');
        const parsed = parseWebRTCProvideAnswer(value);
        const sessionHex = parsed.sessionId.toString('hex');
        const session = this.sessions.get(sessionHex);
        this.console.log(`HomeKit iOS 27: WebRTC Provide Answer, session ${sessionHex.slice(0, 8)}…, `
            + `${parsed.sdpAnswer.length}b SDP, ${parsed.additionalCandidates.length} candidate(s)`);
        if (!session)
            return buildWebRTCSessionStatusResponse(parsed.sessionId, WebRTCStreamingStatus.UNKNOWN_SESSION_IDENTIFIER);

        try {
            if (!this.streamingEnabled() || session.answered) throw new Error('WebRTC answer not allowed');
            session.contract?.setRemote(parsed.sdpAnswer, 'answer');
            this.logDiagnostics(session, 'answer-received', parsed.sdpAnswer, parsed.additionalCandidates);
            session.videoRidLimits = readVideoRidLimits(parsed.sdpAnswer, session.videoRid);
            // r37: a declined data channel section must not reach werift's SCTP setup.
            await session.pc.setRemoteDescription({ type: 'answer', sdp: session.relay?.prepareAnswer(parsed.sdpAnswer) ?? parsed.sdpAnswer } as any);
            // Bundled werift advertises options.simulcast but prepareSend omits
            // its RID. Restore it after negotiation (which resets this field).
            // The sender emits it only if the RID extension was negotiated.
            // r39: the secure video offer negotiates no extension, so packets carry no RID.
            if (!this.opts.secureVideoOffer) session.videoTransceiver.sender.rtpStreamId = session.videoRid;
            this.closeUnusedTransports(session);
            if (session.closed || !this.streamingEnabled()) throw new Error('WebRTC answer canceled');
            this.assertReceiveInactive(session);
            this.mediaSelection(session);
            session.answered = true;
            session.answeredAt ??= Date.now();
            // Keep the setup timeout until a connection actually carries media.
            for (const candidate of parsed.additionalCandidates) {
                try {
                    await session.pc.addIceCandidate({
                        candidate: candidate.candidate,
                        sdpMid: candidate.sdpMid,
                        sdpMLineIndex: candidate.sdpMLineIndex,
                    } as any);
                }
                catch (e) {
                    this.console.warn('WebRTC candidate add failed', e);
                }
            }
            if (session.closed || !this.streamingEnabled()) throw new Error('WebRTC answer canceled');
            this.logDiagnostics(session, 'answer-applied');
            session.diagnosticTimer = setTimeout(() => {
                if (!session.closed) this.logDiagnostics(session, 'answer-after-5s');
                if (!session.closed) this.logStartup(session);
                if (!session.closed) this.markThroughput(session);
            }, 5000);
            session.diagnosticTimer.unref?.();
            session.probeTimers = [15000, 30000, 60000].map(ms => {
                const timer = setTimeout(() => {
                    if (!session.closed) this.logDiagnostics(session, 'r35-after-' + ms / 1000 + 's');
                    if (!session.closed && ms === 15000) this.logThroughput(session);
                }, ms);
                timer.unref?.(); return timer;
            });
            if (session.pc.connectionState === 'connected')
                void this.startMedia(session).catch(e => { this.console.error('WebRTC media start failed', e); this.closeSession(sessionHex); });
            return buildWebRTCSessionStatusResponse(parsed.sessionId, WebRTCStreamingStatus.SUCCESS);
        }
        catch (e) {
            this.console.error('WebRTC provide answer failed', e);
            this.closeSession(sessionHex);
            return buildWebRTCSessionStatusResponse(parsed.sessionId, WebRTCStreamingStatus.ERROR);
        }
    }

    // ------------------------------------------------------------------
    // Media: feed the negotiated tracks from the plugin pipeline
    // ------------------------------------------------------------------

    private logDiagnostics(session: HapWebRTCSession, stage: string, sdp?: string, candidates?: WebRTCIceCandidate[]): void {
        // Observation must not affect signaling or connection callbacks, even
        // when a log sink throws or a vendor transport is being torn down.
        try {
            const details = sdp === undefined
                ? { ...summarizeWebRTCTransport(session.pc), path: session.path, feedback: { ...session.feedback }, relayRtcp: session.relayRtcp?.snapshot(), wire: session.wire?.snapshot(), contract: session.contract?.snapshot(), probe: session.probe?.snapshot(), frameMarking: session.frameMarking?.snapshot(), relayPublication: session.relay?.snapshot() }
                : { sdp: summarizeWebRTCSdp(sdp), additionalCandidates: summarizeWebRTCCandidates(candidates ?? []), contractSdp: summarizeWebRTCContractSdp(sdp) };
            this.console.log(`HomeKit WebRTC diagnostic: session ${session.sessionId.toString('hex').slice(0, 8)}… `
                + `stage=${stage} elapsedMs=${Date.now() - session.createdAt} ${JSON.stringify(details)}`);
        }
        catch (_) { }
    }

    /** r41: one line to compare startup latency between builds and networks. */
    private logStartup(session: HapWebRTCSession): void {
        try {
            if (session.startupLogged) return;
            session.startupLogged = true;
            const probe: any = session.probe?.snapshot();
            const since = (time?: number) => time === undefined ? undefined : time - session.createdAt;
            const at = (ms?: number) => typeof ms === 'number' && Number.isFinite(ms) ? `${Math.round(ms)} ms` : 'not yet';
            this.console.log(`HomeKit WebRTC startup: session ${session.sessionId.toString('hex').slice(0, 8)}…, answer ${at(since(session.answeredAt))}, `
                + `connected ${at(since(session.connectedAt))}, first video ${at(probe?.video?.firstInputAtMs)}, first keyframe ${at(probe?.video?.firstIrapAtMs)}, `
                + `relay video ack ${at(probe?.video?.firstReportAtMs)}, first audio ${at(probe?.audio?.firstInputAtMs)}, keyframes sent ${probe?.video?.sourceIrapFrames ?? 0}`);
        }
        catch (_) { }
    }

    /** r42: probe counters 5 s after the answer; the 15 s line measures from here, after the startup keyframe burst. */
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
        // Key provisioning does not enable talkback or a receive transceiver.
        // Inspect every transceiver: a reoffer can introduce additional m-lines.
        for (const transceiver of session.pc.getTransceivers()) {
            // r40: Apple's relay reoffers a talkback section (viewer to camera). It may add an audio
            // receiver that is never played; the camera's own video and audio stay send-only.
            const allowed = this.isRelayTalkback(session, transceiver) ? ['recvonly', 'inactive'] : ['sendonly', 'inactive'];
            if (!allowed.includes(transceiver.direction)
                || (transceiver.currentDirection && !allowed.includes(transceiver.currentDirection)))
                throw new Error('WebRTC receiving media is not supported by this send-only session');
        }
    }

    private isRelayTalkback(session: HapWebRTCSession, transceiver: any): boolean {
        return !!this.opts.acceptRelayTalkback && transceiver.kind === 'audio'
            && transceiver !== session.videoTransceiver && transceiver !== session.audioTransceiver;
    }

    private talkbackReceivers(session: HapWebRTCSession): number {
        return session.pc.getTransceivers().filter((transceiver: any) => this.isRelayTalkback(session, transceiver)
            && transceiver.direction === 'recvonly').length;
    }

    /** r40: what the running media was started for; a reoffer that leaves it unchanged needs no restart. */
    private mediaSignature(session: HapWebRTCSession, selection: HksvMediaSelection): string {
        const { tier } = selection;
        return JSON.stringify([selection.codec, selection.remote, tier.width, tier.height, tier.frameRate, tier.averageBitrateKbps,
            session.videoTransceiver.sender.codec?.payloadType, session.audioTransceiver.sender.codec?.payloadType,
            session.videoTransceiver.sender.ssrc, session.audioTransceiver.sender.ssrc]);
    }

    private closeUnusedTransports(session: HapWebRTCSession): void {
        // The bundled peer replaces audio's transport when the answer uses
        // BUNDLE, but pc.close() then sees only the shared transport. Release the
        // abandoned offered transport too, without changing offer compatibility.
        const current = new Set(session.pc.dtlsTransports);
        for (const transport of session.transports) {
            if (current.has(transport)) continue;
            session.transports.delete(transport);
            session.dtlsStartup.get(transport)?.();
            session.dtlsStartup.delete(transport);
            void transport.stop().catch(e => this.console.warn('WebRTC unused transport close failed', e));
        }
        for (const transport of current) session.transports.add(transport);
    }

    /** r32 relay experiment. The bundled sender cannot send simulcast, so r31's single
     * RID was sized to the 4K tier: off-LAN viewers saw one 4.4 Mbps stream above their
     * downlink budget and never received video. Offer and send the lowest tier instead.
     */
    private offeredVideoTier(): VideoStreamTier | undefined {
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
        const tiers = offered ? [offered] : this.opts.videoTiers;
        return {
            width: Math.max(...tiers.map(t => t.width)),
            height: Math.max(...tiers.map(t => t.height)),
            frameRate: Math.max(...tiers.map(t => t.frameRate)),
        };
    }

    private mediaSelection(session: HapWebRTCSession): HksvMediaSelection {
        const codec = normalizeVideoCodec(session.videoTransceiver.sender.codec?.mimeType?.split('/')[1]);
        if (!codec) throw new Error('Answer did not negotiate H264 or H265');
        const audio = session.audioTransceiver.sender.codec;
        if (audio?.mimeType?.toLowerCase() !== 'audio/opus' || audio.clockRate !== 48000)
            throw new Error('Answer did not negotiate Opus/48000');
        const params = session.videoTransceiver.sender.codec?.parameters ?? '';
        const maxFs = Number(/(?:^|;)max-fs=(\d+)/.exec(params)?.[1]) || Infinity;
        const maxFr = Number(/(?:^|;)max-fr=(\d+)/.exec(params)?.[1]) || Infinity;
        const h264Level = parseInt(/profile-level-id=[0-9a-f]{4}([0-9a-f]{2})/i.exec(params)?.[1] || '33', 16);
        const h264MaxFs = h264Level <= 30 ? 1620 : h264Level <= 31 ? 3600 : h264Level <= 32 ? 5120 : h264Level <= 41 ? 8192 : h264Level <= 42 ? 8704 : h264Level <= 50 ? 22080 : 36864;
        const hevcLevel = Number(/(?:^|;)level-id=(\d+)/.exec(params)?.[1]) || 153;
        const hevcMaxPicture = hevcLevel <= 30 ? 36864 : hevcLevel <= 60 ? 122880 : hevcLevel <= 63 ? 245760
            : hevcLevel <= 90 ? 552960 : hevcLevel <= 93 ? 983040 : hevcLevel <= 123 ? 2228224 : 8912896;
        const rid = session.videoRidLimits;
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
            : session.remote ? selectRemoteTier(tiers, remoteQualityFloor(this.storage?.getItem(REMOTE_QUALITY_KEY))) ?? tiers[0] : tiers[0];
        return { codec, tier, remote: !!session.remote };
    }

    /** r42: a remote session whose plan asks for the camera's own stream at the tier it sends. */
    private sendsCameraStream(session: HapWebRTCSession, selection: HksvMediaSelection): boolean {
        return !!(selection.remote && session.videoPlan?.cameraStream && session.videoPlan.tier === selection.tier);
    }

    /** Classify the nominated ICE pair once the transport is connected; a setting may force it. */
    private resolveSessionPath(session: HapWebRTCSession): void {
        const observed = classifyWebRTCPath(session.pc);
        const forced = forcedPathKind(this.storage?.getItem(PATH_MODE_KEY));
        session.path = forced ? { ...observed, kind: forced, forced: true } : observed;
        session.remote = session.path.kind === 'remote';
    }

    private async startMedia(session: HapWebRTCSession): Promise<void> {
        if (session.forwarder || session.starting || session.closed || !session.answered || !this.getMedia) return;
        if (!this.streamingEnabled()) throw new Error('Camera streaming is disabled');
        this.assertReceiveInactive(session);
        session.starting = true;
        const generation = ++session.mediaGeneration;
        try {
            this.resolveSessionPath(session);
            const selection = this.mediaSelection(session);
            session.mediaSignature = this.mediaSignature(session, selection);
            const path = session.path!;
            this.console.log(`HomeKit WebRTC path: ${path.kind}${path.forced ? ' (forced by setting)' : ''}; reason ${path.reason}, local ${path.local}, remote ${path.remote}, IPv${path.family}; `
                + (selection.remote
                    ? `remote profile: ${qualityName(selection.tier.quality)} tier ${selection.tier.width}x${selection.tier.height}@${selection.tier.frameRate} ${selection.tier.averageBitrateKbps} kbps, remote stream, paced ${Math.round(remotePacing(selection.tier).bytesPerSecond * 8 / 1000)} kbps, ${REMOTE_SLICE_BYTES}-byte slices, Opus FEC, `
                        + (this.sendsCameraStream(session, selection) ? 'camera stream requested, keyframes from the camera'
                            : `keyframes every ${REMOTE_KEYFRAMES.startupIntervalSeconds} s for ${REMOTE_KEYFRAMES.startupSeconds} s then every ${REMOTE_KEYFRAMES.gopSeconds} s`)
                        + (session.videoPlan ? `; plan ${session.videoPlan.label}` : '')
                    : 'LAN profile unchanged from r25'));
            const input = await this.getMedia(selection);
            if (session.closed || generation !== session.mediaGeneration || !this.streamingEnabled()) return;
            const noAudio = input.mediaStreamOptions?.audio === null;
            // Front's AAC can stall a combined FFmpeg video/audio output. Give
            // video its own RTSP/TCP reader and use a fresh descriptor for audio.
            const videoInput = { ...input,
                inputArguments: input.inputArguments.flatMap((arg, index) => arg === '-i'
                    ? [...(input.container?.startsWith('rtsp') && /^rtsps?:/.test(input.inputArguments[index + 1])
                        ? ['-allowed_media_types', 'video'] : []), '-an', arg] : [arg]),
                mediaStreamOptions: { ...input.mediaStreamOptions, audio: null },
            };
            const videoPayloadType = session.videoTransceiver.sender.codec.payloadType;
            const audioPayloadType = session.audioTransceiver.sender.codec?.payloadType;
            if (audioPayloadType === undefined) throw new Error('Answer did not negotiate Opus');
            if (session.sframeConfiguration) {
                const { key, kid } = session.sframeConfiguration;
                // Werift rewrites SSRC at send time. Derive from that final SSRC,
                // never the FFmpeg source SSRC. Reoffers retain the counters.
                const videoSsrc = session.videoTransceiver.sender.ssrc;
                const audioSsrc = session.audioTransceiver.sender.ssrc;
                if ((session.videoSframe && session.videoSframe.ssrc !== videoSsrc)
                    || (session.audioSframe && session.audioSframe.ssrc !== audioSsrc))
                    throw new Error('SFrame sender SSRC changed during session');
                session.videoSframe ??= new SFrameRtpSender(key, kid, videoSsrc, true, selection.remote ? REMOTE_SLICE_BYTES : undefined, (frame, header, encrypted) => { session.probe?.sourceFrame('video', frame, header, encrypted); session.frameMarking?.observeFrame(frame, header); });
                session.audioSframe ??= new SFrameRtpSender(key, kid, audioSsrc, false, undefined, (frame, header, encrypted) => session.probe?.sourceFrame('audio', frame, header, encrypted));
            }
            const active = () => !session.closed && generation === session.mediaGeneration && this.streamingEnabled();
            let firstVideo: () => void;
            const ready = new Promise<void>(resolve => firstVideo = resolve);
            let forwarded = false;
            const pacer = session.pacer = createHksvRtpPacer(packet => {
                if (!active()) return;
                session.vtrack.writeRtp(packet);
                if (!forwarded) {
                    forwarded = true;
                    this.console.log(`HomeKit WebRTC first ${selection.codec} RTP packet; forwarding to controller`);
                    firstVideo();
                }
            }, error => { this.console.error(error.message); this.closeSession(session.sessionId.toString('hex')); },
            selection.remote ? remotePacing(selection.tier) : undefined);
            const nativeDecision = videoCopyDecision(input, selection.codec, selection.tier, { allowLowerFrameRate: selection.remote });
            // r41: remote viewers need a bounded bitrate and frequent keyframes, so the camera stream is not passed through,
            // r42: unless the session's plan asks for the camera stream and the stream that opened matches the offered tier.
            const cameraStream = this.sendsCameraStream(session, selection) ? cameraStreamDecision(input, selection) : undefined;
            const decision = cameraStream?.copy ? cameraStream
                : cameraStream ? { copy: false, reason: `${cameraStream.reason}; re-encoding instead` }
                : selection.remote && nativeDecision.copy
                ? { copy: false, reason: `remote viewers get a controlled bitrate and keyframe schedule (source matched: ${nativeDecision.reason})` }
                : nativeDecision;
            this.console.log(`HomeKit WebRTC output: ${selection.codec} ${selection.tier.width}x${selection.tier.height}@${selection.tier.frameRate}, ${decision.copy ? 'copy' : 'encode'}, Opus/48000`);
            this.console.log(`HomeKit WebRTC video ${decision.copy ? 'passthrough' : 're-encode'} reason: ${decision.reason}`);
            const forwarder = await startRtpForwarderProcess(this.console, videoInput, {
                video: {
                    codecCopy: 'transcode', packetSize: 1150, payloadType: videoPayloadType,
                    encoderArguments: ['-map', '0:v:0', ...(decision.copy
                        ? ['-c:v', 'copy', '-bsf:v', 'dump_extra']
                        : videoEncoderArguments(selection.codec, selection.tier.width, selection.tier.height,
                            selection.tier.frameRate, selection.tier.averageBitrateKbps, selection.remote ? REMOTE_KEYFRAMES : undefined,
                            // r42: two x265 threads cannot hold 1440p or 4K at 30 fps; 1080p and below keep the earlier arguments.
                            selection.tier.width * selection.tier.height > 1920 * 1080 ? { threads: 'auto' } : undefined))],
                    onRtp: (rtp, codec) => {
                        if (!active() || normalizeVideoCodec(codec) !== selection.codec) return;
                        try {
                            const packet = RtpPacket.deSerialize(rtp);
                            packet.header.payloadType = videoPayloadType;
                            session.probe?.observeInput('video', packet);
                            for (const output of session.videoSframe ? session.videoSframe.push(packet) : [packet]) {
                                if (session.videoSframe) session.frameMarking?.decorate(output);
                                pacer.enqueue(output);
                            }
                        }
                        catch { this.console.error('HomeKit WebRTC video packet encryption failed'); this.closeSession(session.sessionId.toString('hex')); }
                    },
                },
            }, { rtspMode: 'tcp' });
            if (!active()) { forwarder.kill(); return; }
            session.forwarder = forwarder;
            this.startAudio(session, selection, noAudio, generation, audioPayloadType);
            try {
                const section = await timeoutPromise(15000, Promise.race([forwarder.videoSection, forwarder.killPromise.then(() => { throw new Error('WebRTC media process exited'); })]));
                if (normalizeVideoCodec(section?.codec) !== selection.codec
                    || (selection.codec === 'h265' && Number(section?.fmtp?.[0]?.parameters?.['profile-id'] || 1) !== 1))
                    throw new Error('WebRTC outgoing codec/profile does not match the negotiated Main HEVC or H264 stream');
                await timeoutPromise(15000, Promise.race([ready, forwarder.killPromise.then(() => { throw new Error('WebRTC media process exited'); })]));
            } catch (e) { forwarder.kill(); throw e; }
            if (!active()) return;
            clearTimeout(session.reapTimer);
            this.console.log(`HomeKit WebRTC media ready: session ${session.sessionId.toString('hex').slice(0, 8)}…`);
            forwarder.killPromise.then(() => { if (active()) this.closeSession(session.sessionId.toString('hex')); },
                () => { if (active()) this.closeSession(session.sessionId.toString('hex')); });
        }
        catch (e) {
            if (generation === session.mediaGeneration) this.closeSession(session.sessionId.toString('hex'));
            throw e;
        }
        finally { if (generation === session.mediaGeneration) session.starting = false; }
    }

    private startAudio(session: HapWebRTCSession, selection: HksvMediaSelection, silence: boolean, generation: number, payloadType: number): void {
        void (async () => {
            let forwarder: HapWebRTCSession['audioForwarder'];
            let expired = false;
            const active = () => !session.closed && generation === session.mediaGeneration && this.streamingEnabled();
            const timer = session.audioTimer = setTimeout(() => {
                expired = true;
                forwarder?.kill();
                if (active()) this.console.warn('HomeKit WebRTC audio produced no packets within 10s; video continues without audio');
            }, 10000);
            timer.unref?.();
            try {
                const input: FFmpegInput = silence ? {
                    inputArguments: ['-re', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono'],
                } : await this.getMedia(selection);
                if (!active() || expired) return;
                this.console.log('HomeKit WebRTC audio using an independent stream request');
                forwarder = await startRtpForwarderProcess(this.console, input, { audio: {
                    codecCopy: 'transcode', packetSize: 400, payloadType,
                    // Remote: VoIP mode carries in-band FEC, so a lost packet is concealed
                    // from its successor instead of leaving an audible gap.
                    encoderArguments: ['-map', '0:a:0', '-c:a', 'libopus', '-application', selection.remote ? 'voip' : 'lowdelay',
                        '-frame_duration', '20', '-ar', '24000', '-b:a', '32k', '-ac', '1',
                        ...(selection.remote ? ['-fec:a', '1', '-packet_loss', String(REMOTE_OPUS_PACKET_LOSS_PERCENT)] : [])],
                    onRtp: rtp => {
                        if (!active() || expired) return;
                        clearTimeout(timer);
                        try {
                            const packet = RtpPacket.deSerialize(rtp);
                            packet.header.payloadType = payloadType;
                            session.probe?.observeInput('audio', packet);
                            for (const output of session.audioSframe ? session.audioSframe.push(packet) : [packet])
                                session.atrack.writeRtp(output);
                        }
                        catch { this.console.error('HomeKit WebRTC audio packet encryption failed'); this.closeSession(session.sessionId.toString('hex')); }
                    },
                } }, { rtspClientForceTcp: true });
                if (!active() || expired) { forwarder.kill(); return; }
                session.audioForwarder = forwarder;
                await forwarder.killPromise;
                if (active() && !expired) this.console.warn('HomeKit WebRTC audio stopped; video continues without audio');
            }
            catch (e) {
                forwarder?.kill();
                if (active() && !expired) this.console.warn('HomeKit WebRTC audio failed; video continues without audio', e);
            }
            finally {
                clearTimeout(timer);
                if (session.audioTimer === timer) session.audioTimer = undefined;
                if (session.audioForwarder === forwarder) session.audioForwarder = undefined;
            }
        })();
    }

    private stopMedia(session: HapWebRTCSession): void {
        ++session.mediaGeneration;
        session.starting = false;
        session.mediaSignature = undefined;
        session.pacer?.close();
        session.pacer = undefined;
        session.videoSframe?.resetFrame();
        clearTimeout(session.audioTimer);
        session.audioTimer = undefined;
        for (const forwarder of [session.forwarder, session.audioForwarder]) {
            try { forwarder?.kill(); } catch (e) { }
        }
        session.forwarder = session.audioForwarder = undefined;
    }

    // ------------------------------------------------------------------
    // §4.19 Streaming Control / §4.21 Reoffer / §4.22 Update Session
    // ------------------------------------------------------------------

    private async handleStreamingControl(value: Buffer): Promise<Buffer> {
        const parsed = parseWebRTCStreamingControl(value);
        const sessionHex = parsed.sessionId.toString('hex');
        this.console.log(`HomeKit iOS 27: WebRTC Streaming Control, command ${parsed.command}, session ${sessionHex.slice(0, 8)}…`);
        if (!this.sessions.has(sessionHex))
            return buildWebRTCSessionStatusResponse(parsed.sessionId, WebRTCStreamingStatus.UNKNOWN_SESSION_IDENTIFIER);
        if (parsed.command !== 1) return buildWebRTCSessionStatusResponse(parsed.sessionId, WebRTCStreamingStatus.ERROR);
        this.closeSession(sessionHex);
        return buildWebRTCSessionStatusResponse(parsed.sessionId, WebRTCStreamingStatus.SUCCESS);
    }

    private async handleReoffer(value: Buffer): Promise<Buffer> {
        const parsed = parseWebRTCReoffer(value);
        const sessionHex = parsed.sessionId.toString('hex');
        const session = this.sessions.get(sessionHex);
        this.console.log(`HomeKit iOS 27: WebRTC Reoffer, session ${sessionHex.slice(0, 8)}…`);
        if (!session)
            return buildWebRTCReofferResponse({ sessionId: parsed.sessionId, status: WebRTCStreamingStatus.UNKNOWN_SESSION_IDENTIFIER });
        if ((parsed.sframeEnabled !== undefined && parsed.sframeEnabled !== !!session.sframeConfiguration) || !this.streamingEnabled())
            return buildWebRTCReofferResponse({ sessionId: parsed.sessionId, status: WebRTCStreamingStatus.ERROR });
        try {
            // r40: a reoffer that leaves the send media unchanged (Apple's relay adds talkback) keeps
            // the running FFmpeg processes; restarting them froze the viewer and delayed audio.
            const keepMedia = !!this.opts.acceptRelayTalkback;
            if (!keepMedia) this.stopMedia(session);
            session.answered = false;
            session.contract?.setRemote(parsed.sdpOffer, 'offer');
            this.logDiagnostics(session, 'reoffer-received', parsed.sdpOffer);
            session.videoRidLimits = readVideoRidLimits(parsed.sdpOffer, session.videoRid);
            await session.pc.setRemoteDescription({ type: 'offer', sdp: parsed.sdpOffer } as any);
            if (!this.opts.secureVideoOffer) session.videoTransceiver.sender.rtpStreamId = session.videoRid;
            this.closeUnusedTransports(session);
            if (session.closed || !this.streamingEnabled()) throw new Error('WebRTC reoffer canceled');
            this.assertReceiveInactive(session);
            const answer = await session.pc.createAnswer();
            await session.pc.setLocalDescription(answer);
            if (session.closed || !this.streamingEnabled()) throw new Error('WebRTC reoffer canceled');
            this.assertReceiveInactive(session);
            const selection = this.mediaSelection(session);
            session.answered = true;
            const answerLimits = { ...this.offeredVideoRidLimits(session), ...session.videoRidLimits };
            const localAnswer = (session.pc.localDescription as any)?.sdp ?? (answer as any).sdp;
            // r39: like camera.ui, answer a relay reoffer with werift's description unchanged.
            const sdpAnswer = this.opts.secureVideoOffer ? localAnswer
                : withRelaySdpVariant(withSFramePacketization(withExplicitVideoRidPayload(withExplicitVideoRidPayload(localAnswer,
                    answerLimits), answerLimits, session.videoRid), !!session.sframeConfiguration),
                    session.relayVariant, { videoSsrc: session.videoTransceiver.sender.ssrc, audioSsrc: session.audioTransceiver.sender.ssrc, videoRid: session.videoRid }, VIDEO_RID);
            session.contract?.setLocal(sdpAnswer);
            this.logDiagnostics(session, 'reoffer-answer', sdpAnswer);
            const talkback = this.talkbackReceivers(session);
            const accepted = talkback ? `, ${talkback} talkback audio receiver(s) accepted (not played)` : '';
            if (keepMedia && session.mediaSignature !== undefined && session.mediaSignature === this.mediaSignature(session, selection)) {
                this.console.log(`HomeKit WebRTC reoffer answered: session ${sessionHex.slice(0, 8)}…, running media kept${accepted}`);
            }
            else {
                if (keepMedia) this.stopMedia(session);
                this.console.log(`HomeKit WebRTC reoffer answered: session ${sessionHex.slice(0, 8)}…, media restarts for the new negotiation${accepted}`);
                if (session.pc.connectionState === 'connected') await this.startMedia(session);
            }
            return buildWebRTCReofferResponse({
                sessionId: parsed.sessionId,
                status: WebRTCStreamingStatus.SUCCESS,
                sdpAnswer,
                sframeConfiguration: session.sframeConfiguration,
            });
        }
        catch (e) {
            this.closeSession(sessionHex);
            this.console.error('WebRTC reoffer failed', e);
            return buildWebRTCReofferResponse({ sessionId: parsed.sessionId, status: WebRTCStreamingStatus.ERROR });
        }
    }

    private async handleUpdateSession(value: Buffer): Promise<Buffer> {
        let sessionId = Buffer.alloc(0);
        try {
            if (value.length > 65536) throw new Error('WebRTC key update too large');
            const id = tlvDecodeMap(value)[1];
            if (id?.length === 16) sessionId = id;
            const parsed = parseWebRTCUpdateSession(value);
            const sessionHex = parsed.sessionId.toString('hex');
            const session = this.sessions.get(sessionHex);
            if (!session) return buildWebRTCSessionStatusResponse(sessionId, WebRTCStreamingStatus.UNKNOWN_SESSION_IDENTIFIER);
            if (!this.streamingEnabled()) throw new Error('Camera streaming is disabled');
            this.assertReceiveInactive(session);
            session.receiveKeys.update(parsed.receiveKeysToAdd, parsed.receiveKidsToRemove);
            this.console.log(`HomeKit iOS 27: WebRTC Update Session, session ${sessionHex.slice(0, 8)}…, `
                + `+${parsed.receiveKeysToAdd.length}/-${parsed.receiveKidsToRemove.length} receive SFrame key(s) retained; `
                + (this.talkbackReceivers(session) ? `${this.talkbackReceivers(session)} talkback audio receiver(s) accepted (not played)` : 'receive direction inactive')
                + '; status=0');
            return buildWebRTCSessionStatusResponse(sessionId, WebRTCStreamingStatus.SUCCESS);
        }
        catch (e) {
            // Never log the request buffer, key IDs, or key material.
            this.console.warn('HomeKit WebRTC Update Session rejected: invalid keys or receive state');
            return buildWebRTCSessionStatusResponse(sessionId, WebRTCStreamingStatus.ERROR);
        }
    }

    closeAllSessions(): void { for (const id of this.sessions.keys()) this.closeSession(id); }

    private closeSession(sessionHex: string): void {
        const session = this.sessions.get(sessionHex);
        if (!session)
            return;
        this.logDiagnostics(session, 'closing');
        this.sessions.delete(sessionHex);
        session.closed = true;
        clearTimeout(session.diagnosticTimer);
        for (const timer of session.probeTimers ?? []) clearTimeout(timer);
        if (session.reapTimer)
            clearTimeout(session.reapTimer);
        session.receiveKeys.clear();
        this.stopMedia(session);
        session.videoSframe?.close();
        session.audioSframe?.close();
        session.sframeConfiguration?.key.fill(0);
        this.closeUnusedTransports(session);
        session.wire?.dispose();
        session.probe?.dispose();
        session.relay?.dispose();
        session.relayRtcp?.dispose();
        session.transports.clear();
        for (const dispose of session.dtlsStartup.values()) dispose();
        session.dtlsStartup.clear();
        try {
            Promise.resolve(session.pc.close()).catch(e => this.console.warn('WebRTC close failed', e));
        }
        catch (e) {
        }
        this.updateSessionCount();
        this.console.log(`HomeKit iOS 27: WebRTC session ${sessionHex.slice(0, 8)}… closed (${this.sessions.size} active)`);
    }
}
