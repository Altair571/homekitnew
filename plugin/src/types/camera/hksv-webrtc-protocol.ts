/**
 * hksv-webrtc-protocol.ts
 *
 * Dependency-free wire-format codecs for the "Camera WebRTC Stream Management" service
 * (UUID 0x00008033), per the HKSV Open Source Compatibility Guide (rev. 2026-06-03),
 * §3.7 / §4.17–§4.24 and the §5 call sequence:
 *
 *   controller writes WebRTC Solicit Offer (options: SFrame Enabled)
 *     → accessory responds: session id + SDP offer + ICE candidates (+ SFrame config)
 *   controller writes WebRTC Provide Answer (session id, SDP answer, candidates)
 *     → accessory establishes the connection, responds with status
 *   WebRTC Streaming Control ends sessions; Reoffer renegotiates; Update Session rotates
 *   SFrame keys; Number of Active Sessions notifies the count.
 *
 * Validated by hksv-webrtc-protocol.test.ts.
 */

import { tlvEncode, tlvDecodeRaw, u8, u16 } from './hksv-stream-tiers';
import { tlvDecodeMap } from './hksv-multitier-protocol';
import { readUIntLE, u64 } from './hksv-recording-protocol';

// ---------------------------------------------------------------------------
// UUIDs (Apple base UUID suffix -0000-1000-8000-0026BB765291)
// ---------------------------------------------------------------------------

export const CameraWebRTCStreamManagementServiceUUID = '00008033-0000-1000-8000-0026BB765291';
export const WebRTCSolicitOfferUUID = '00008053-0000-1000-8000-0026BB765291';
export const WebRTCProvideAnswerUUID = '00008054-0000-1000-8000-0026BB765291';
export const WebRTCStreamingControlUUID = '00008056-0000-1000-8000-0026BB765291';
export const WebRTCNumberOfActiveSessionsUUID = '00008057-0000-1000-8000-0026BB765291';
export const WebRTCReofferUUID = '00008058-0000-1000-8000-0026BB765291';
export const WebRTCUpdateSessionUUID = '0000805C-0000-1000-8000-0026BB765291';
export const WebRTCSupportedVideoStreamTiersUUID = '00008059-0000-1000-8000-0026BB765291';
export const WebRTCSupportedAudioStreamTiersUUID = '0000805A-0000-1000-8000-0026BB765291';

// ---------------------------------------------------------------------------
// Shared enums / shapes
// ---------------------------------------------------------------------------

/** §4.18 WebRTC Streaming Status enumeration. */
export const WebRTCStreamingStatus = {
    SUCCESS: 0,
    UNKNOWN_SESSION_IDENTIFIER: 1,
    BUSY: 2,
    ERROR: 3,
} as const;
export type WebRTCStreamingStatus = typeof WebRTCStreamingStatus[keyof typeof WebRTCStreamingStatus];

/** §4.17 Solicit Offer response status enumeration. */
export const WebRTCOfferStatus = {
    SUCCESS: 0,
    PRIVACY_MODE_ACTIVE: 1,
    ERROR: 2,
} as const;
export type WebRTCOfferStatus = typeof WebRTCOfferStatus[keyof typeof WebRTCOfferStatus];

export interface WebRTCIceCandidate {
    /** RFC 8839/8825-style ICE candidate line. */
    candidate: string;
    /** Media stream identification tag, or undefined if no association exists. */
    sdpMid?: string;
    /** Zero-based m-line index, or undefined if no association exists. */
    sdpMLineIndex?: number;
}

export interface SFrameKeyData {
    key: Buffer;
    kid: bigint;
}

const IceCandidateTypes = {
    CANDIDATE: 0x01, // string
    SDP_MID: 0x02, // string
    SDP_MLINE_INDEX: 0x03, // uint16
} as const;

const SFrameKeyDataTypes = {
    KEY: 0x01, // data
    KID: 0x02, // uint64
} as const;

function encodeIceCandidate(c: WebRTCIceCandidate): Buffer {
    const parts: Array<number | Buffer> = [IceCandidateTypes.CANDIDATE, Buffer.from(c.candidate, 'utf8')];
    if (c.sdpMid !== undefined)
        parts.push(IceCandidateTypes.SDP_MID, Buffer.from(c.sdpMid, 'utf8'));
    if (c.sdpMLineIndex !== undefined)
        parts.push(IceCandidateTypes.SDP_MLINE_INDEX, u16(c.sdpMLineIndex));
    return tlvEncode(...parts);
}

function parseIceCandidate(buf: Buffer): WebRTCIceCandidate {
    const m = tlvDecodeMap(buf);
    const out: WebRTCIceCandidate = { candidate: (m[IceCandidateTypes.CANDIDATE] ?? Buffer.alloc(0)).toString('utf8') };
    if (m[IceCandidateTypes.SDP_MID])
        out.sdpMid = m[IceCandidateTypes.SDP_MID].toString('utf8');
    if (m[IceCandidateTypes.SDP_MLINE_INDEX])
        out.sdpMLineIndex = Number(readUIntLE(m[IceCandidateTypes.SDP_MLINE_INDEX]));
    return out;
}

function encodeSFrameKeyData(k: SFrameKeyData): Buffer {
    return tlvEncode(
        SFrameKeyDataTypes.KEY, k.key,
        SFrameKeyDataTypes.KID, u64(k.kid),
    );
}

function parseSFrameKeyData(buf: Buffer): SFrameKeyData {
    validateKeyTlv(buf);
    const m = tlvDecodeMap(buf);
    if (!m[SFrameKeyDataTypes.KEY]?.length || m[SFrameKeyDataTypes.KEY].length > 1024)
        throw new Error('Invalid WebRTC receive key data');
    return {
        key: m[SFrameKeyDataTypes.KEY],
        kid: parseKeyId(m[SFrameKeyDataTypes.KID]),
    };
}

function parseKeyId(value?: Buffer): bigint {
    // HAP integer TLVs may use a shorter little-endian representation.
    if (!value?.length || value.length > 8) throw new Error('Invalid WebRTC key identifier');
    return readUIntLE(value);
}

function validateKeyTlv(buffer: Buffer): void {
    for (let offset = 0; offset < buffer.length;) {
        if (offset + 2 > buffer.length || offset + 2 + buffer[offset + 1] > buffer.length)
            throw new Error('Truncated WebRTC key update');
        offset += 2 + buffer[offset + 1];
    }
}

/** Split a repeated list under `type` (0x00-delimited; adjacent same-type fragments merged). */
function splitOnType(buf: Buffer, type: number): Buffer[] {
    const entries: Buffer[] = [];
    let current: Buffer | undefined;
    let lastType = -1;
    for (const r of tlvDecodeRaw(buf)) {
        if (r.type === type) {
            if (lastType === type && current)
                current = Buffer.concat([current, r.value]);
            else {
                if (current) entries.push(current);
                current = r.value;
            }
        }
        lastType = r.type;
    }
    if (current) entries.push(current);
    return entries;
}

// ---------------------------------------------------------------------------
// §4.17 WebRTC Solicit Offer (0x00008053)
// ---------------------------------------------------------------------------

const SolicitOfferTypes = {
    OPTIONS: 0x01,
} as const;

const OfferOptionsTypes = {
    SFRAME_ENABLED: 0x01, // boolean
} as const;

const SolicitOfferResponseTypes = {
    SESSION_ID: 0x01, // data
    SDP_OFFER: 0x02, // string
    ADDITIONAL_CANDIDATES: 0x03, // repeated WebRTC ICE Candidate
    STATUS: 0x04, // enum
    SFRAME_CONFIGURATION: 0x05, // SFrame Key Data
} as const;

export interface WebRTCSolicitOfferWrite {
    sframeEnabled?: boolean;
}

export function parseWebRTCSolicitOffer(buffer: Buffer): WebRTCSolicitOfferWrite {
    const m = tlvDecodeMap(buffer);
    const options = m[SolicitOfferTypes.OPTIONS] ? tlvDecodeMap(m[SolicitOfferTypes.OPTIONS]) : {};
    return {
        sframeEnabled: options[OfferOptionsTypes.SFRAME_ENABLED]?.length
            ? options[OfferOptionsTypes.SFRAME_ENABLED][0] !== 0 : undefined,
    };
}

export function encodeWebRTCSolicitOffer(w: WebRTCSolicitOfferWrite): Buffer {
    if (w.sframeEnabled === undefined) return Buffer.alloc(0);
    return tlvEncode(
        SolicitOfferTypes.OPTIONS,
        tlvEncode(OfferOptionsTypes.SFRAME_ENABLED, u8(w.sframeEnabled ? 1 : 0)),
    );
}

export interface WebRTCSolicitOfferResponse {
    sessionId: Buffer;
    status: WebRTCOfferStatus;
    sdpOffer?: string;
    additionalCandidates?: WebRTCIceCandidate[];
    sframeConfiguration?: SFrameKeyData;
}

export function buildWebRTCSolicitOfferResponse(r: WebRTCSolicitOfferResponse): Buffer {
    const parts: Array<number | Buffer | Buffer[]> = [
        SolicitOfferResponseTypes.SESSION_ID, r.sessionId,
    ];
    if (r.sdpOffer !== undefined)
        parts.push(SolicitOfferResponseTypes.SDP_OFFER, Buffer.from(r.sdpOffer, 'utf8'));
    if (r.additionalCandidates?.length)
        parts.push(SolicitOfferResponseTypes.ADDITIONAL_CANDIDATES, r.additionalCandidates.map(encodeIceCandidate));
    parts.push(SolicitOfferResponseTypes.STATUS, u8(r.status));
    if (r.sframeConfiguration)
        parts.push(SolicitOfferResponseTypes.SFRAME_CONFIGURATION, encodeSFrameKeyData(r.sframeConfiguration));
    return tlvEncode(...parts);
}

export function parseWebRTCSolicitOfferResponse(buffer: Buffer): WebRTCSolicitOfferResponse {
    const m = tlvDecodeMap(buffer);
    const out: WebRTCSolicitOfferResponse = {
        sessionId: m[SolicitOfferResponseTypes.SESSION_ID] ?? Buffer.alloc(0),
        status: (m[SolicitOfferResponseTypes.STATUS]?.readUInt8(0) ?? WebRTCOfferStatus.ERROR) as WebRTCOfferStatus,
    };
    if (m[SolicitOfferResponseTypes.SDP_OFFER])
        out.sdpOffer = m[SolicitOfferResponseTypes.SDP_OFFER].toString('utf8');
    const candidates = splitOnType(buffer, SolicitOfferResponseTypes.ADDITIONAL_CANDIDATES).map(parseIceCandidate);
    if (candidates.length)
        out.additionalCandidates = candidates;
    if (m[SolicitOfferResponseTypes.SFRAME_CONFIGURATION])
        out.sframeConfiguration = parseSFrameKeyData(m[SolicitOfferResponseTypes.SFRAME_CONFIGURATION]);
    return out;
}

// ---------------------------------------------------------------------------
// §4.18 WebRTC Provide Answer (0x00008054)
// ---------------------------------------------------------------------------

const ProvideAnswerTypes = {
    SESSION_ID: 0x01, // data
    SDP_ANSWER: 0x02, // string
    ADDITIONAL_CANDIDATES: 0x03, // repeated
} as const;

export interface WebRTCProvideAnswerWrite {
    sessionId: Buffer;
    sdpAnswer: string;
    additionalCandidates: WebRTCIceCandidate[];
}

export function parseWebRTCProvideAnswer(buffer: Buffer): WebRTCProvideAnswerWrite {
    const m = tlvDecodeMap(buffer);
    return {
        sessionId: m[ProvideAnswerTypes.SESSION_ID] ?? Buffer.alloc(0),
        sdpAnswer: (m[ProvideAnswerTypes.SDP_ANSWER] ?? Buffer.alloc(0)).toString('utf8'),
        additionalCandidates: splitOnType(buffer, ProvideAnswerTypes.ADDITIONAL_CANDIDATES).map(parseIceCandidate),
    };
}

export function encodeWebRTCProvideAnswer(w: WebRTCProvideAnswerWrite): Buffer {
    const parts: Array<number | Buffer | Buffer[]> = [
        ProvideAnswerTypes.SESSION_ID, w.sessionId,
        ProvideAnswerTypes.SDP_ANSWER, Buffer.from(w.sdpAnswer, 'utf8'),
    ];
    if (w.additionalCandidates.length)
        parts.push(ProvideAnswerTypes.ADDITIONAL_CANDIDATES, w.additionalCandidates.map(encodeIceCandidate));
    return tlvEncode(...parts);
}

// Session-id + status responses are shared by Provide Answer, Streaming Control and
// Update Session (§4.18/§4.19/§4.22).
const SessionStatusResponseTypes = {
    SESSION_ID: 0x01,
    STATUS: 0x02,
} as const;

export function buildWebRTCSessionStatusResponse(sessionId: Buffer, status: WebRTCStreamingStatus): Buffer {
    return tlvEncode(
        SessionStatusResponseTypes.SESSION_ID, sessionId,
        SessionStatusResponseTypes.STATUS, u8(status),
    );
}

export function parseWebRTCSessionStatusResponse(buffer: Buffer): { sessionId: Buffer, status: WebRTCStreamingStatus } {
    const m = tlvDecodeMap(buffer);
    return {
        sessionId: m[SessionStatusResponseTypes.SESSION_ID] ?? Buffer.alloc(0),
        status: (m[SessionStatusResponseTypes.STATUS]?.readUInt8(0) ?? WebRTCStreamingStatus.ERROR) as WebRTCStreamingStatus,
    };
}

// ---------------------------------------------------------------------------
// §4.19 WebRTC Streaming Control (0x00008056)
// ---------------------------------------------------------------------------

export const WebRTCStreamingCommand = {
    END: 1,
} as const;
export type WebRTCStreamingCommand = typeof WebRTCStreamingCommand[keyof typeof WebRTCStreamingCommand];

const StreamingControlTypes = {
    SESSION_ID: 0x01,
    COMMAND: 0x02,
} as const;

export function parseWebRTCStreamingControl(buffer: Buffer): { sessionId: Buffer, command: WebRTCStreamingCommand } {
    const m = tlvDecodeMap(buffer);
    return {
        sessionId: m[StreamingControlTypes.SESSION_ID] ?? Buffer.alloc(0),
        command: (m[StreamingControlTypes.COMMAND]?.readUInt8(0) ?? WebRTCStreamingCommand.END) as WebRTCStreamingCommand,
    };
}

export function encodeWebRTCStreamingControl(sessionId: Buffer, command: WebRTCStreamingCommand): Buffer {
    return tlvEncode(
        StreamingControlTypes.SESSION_ID, sessionId,
        StreamingControlTypes.COMMAND, u8(command),
    );
}

// ---------------------------------------------------------------------------
// §4.21 WebRTC Reoffer (0x00008058)
// ---------------------------------------------------------------------------

const ReofferTypes = {
    SESSION_ID: 0x01,
    SDP_OFFER: 0x02,
    OPTIONS: 0x03,
} as const;

const ReofferResponseTypes = {
    SESSION_ID: 0x01,
    SDP_ANSWER: 0x02,
    STATUS: 0x03,
    SFRAME_CONFIGURATION: 0x04,
} as const;

export interface WebRTCReofferWrite {
    sessionId: Buffer;
    sdpOffer: string;
    sframeEnabled?: boolean;
}

export function parseWebRTCReoffer(buffer: Buffer): WebRTCReofferWrite {
    const m = tlvDecodeMap(buffer);
    const out: WebRTCReofferWrite = {
        sessionId: m[ReofferTypes.SESSION_ID] ?? Buffer.alloc(0),
        sdpOffer: (m[ReofferTypes.SDP_OFFER] ?? Buffer.alloc(0)).toString('utf8'),
    };
    if (m[ReofferTypes.OPTIONS]) {
        const options = tlvDecodeMap(m[ReofferTypes.OPTIONS]);
        out.sframeEnabled = options[OfferOptionsTypes.SFRAME_ENABLED]?.length
            ? options[OfferOptionsTypes.SFRAME_ENABLED][0] !== 0 : undefined;
    }
    return out;
}

export interface WebRTCReofferResponse {
    sessionId: Buffer;
    status: WebRTCStreamingStatus;
    sdpAnswer?: string;
    sframeConfiguration?: SFrameKeyData;
}

export function buildWebRTCReofferResponse(r: WebRTCReofferResponse): Buffer {
    const parts: Array<number | Buffer> = [ReofferResponseTypes.SESSION_ID, r.sessionId];
    if (r.sdpAnswer !== undefined)
        parts.push(ReofferResponseTypes.SDP_ANSWER, Buffer.from(r.sdpAnswer, 'utf8'));
    parts.push(ReofferResponseTypes.STATUS, u8(r.status));
    if (r.sframeConfiguration)
        parts.push(ReofferResponseTypes.SFRAME_CONFIGURATION, encodeSFrameKeyData(r.sframeConfiguration));
    return tlvEncode(...parts);
}

// ---------------------------------------------------------------------------
// §4.22 WebRTC Update Session (0x0000805C)
// ---------------------------------------------------------------------------

const UpdateSessionTypes = {
    SESSION_ID: 0x01,
    RECEIVE_KEYS_TO_ADD: 0x02, // repeated SFrame Key Data
    RECEIVE_KIDS_TO_REMOVE: 0x03, // repeated SFrame KID { 1: uint64 }
} as const;

const SFrameKidTypes = { KID: 0x01 } as const;

export interface WebRTCUpdateSessionWrite {
    sessionId: Buffer;
    receiveKeysToAdd: SFrameKeyData[];
    receiveKidsToRemove: bigint[];
}

export function parseWebRTCUpdateSession(buffer: Buffer): WebRTCUpdateSessionWrite {
    if (buffer.length > 65536) throw new Error('WebRTC key update too large');
    validateKeyTlv(buffer);
    const m = tlvDecodeMap(buffer);
    if (m[UpdateSessionTypes.SESSION_ID]?.length !== 16) throw new Error('Invalid WebRTC session identifier');
    return {
        sessionId: m[UpdateSessionTypes.SESSION_ID],
        receiveKeysToAdd: splitOnType(buffer, UpdateSessionTypes.RECEIVE_KEYS_TO_ADD).map(parseSFrameKeyData),
        receiveKidsToRemove: splitOnType(buffer, UpdateSessionTypes.RECEIVE_KIDS_TO_REMOVE)
            .map(b => { validateKeyTlv(b); return parseKeyId(tlvDecodeMap(b)[SFrameKidTypes.KID]); }),
    };
}

export function encodeWebRTCUpdateSession(w: WebRTCUpdateSessionWrite): Buffer {
    const parts: Array<number | Buffer | Buffer[]> = [UpdateSessionTypes.SESSION_ID, w.sessionId];
    if (w.receiveKeysToAdd.length)
        parts.push(UpdateSessionTypes.RECEIVE_KEYS_TO_ADD, w.receiveKeysToAdd.map(encodeSFrameKeyData));
    if (w.receiveKidsToRemove.length)
        parts.push(UpdateSessionTypes.RECEIVE_KIDS_TO_REMOVE,
            w.receiveKidsToRemove.map(kid => tlvEncode(SFrameKidTypes.KID, u64(kid))));
    return tlvEncode(...parts);
}
