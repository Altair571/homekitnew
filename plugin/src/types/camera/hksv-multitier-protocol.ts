/**
 * hksv-multitier-protocol.ts
 *
 * Pure, dependency-free wire-format codecs for the iOS/tvOS 27 "Camera Multi-Tier RTP Stream
 * Management" service (UUID 0x00008031). Builds on hksv-stream-tiers.ts and adds:
 *
 *   - Setup Endpoints           (reuses the existing HAP characteristic 0x00000118 layout)
 *   - RTP Streaming Control     (new characteristic 0x00008045: Start/End a tier within a session)
 *
 * These are the formats the new service negotiates with. The streaming itself is delegated to the
 * Scrypted plugin's existing CameraStreamingDelegate (which manages SRTP/UDP/ffmpeg), so this module
 * only has to parse the controller's writes and build the accessory's responses, then hand the
 * resulting parameters to that delegate. Everything here is unit-tested in
 * hksv-multitier-protocol.test.ts and validated against HAP-NodeJS's own decoder.
 *
 * Spec: HomeKit Secure Video Open Source Compatibility Guide, rev. 2026-06-03, sections 3.6, 4.16.
 */

import { tlvEncode, tlvDecodeRaw, u8, u16, u32 } from './hksv-stream-tiers';

// ---------------------------------------------------------------------------
// Characteristic / Service UUIDs (Apple base UUID suffix -0000-1000-8000-0026BB765291)
// ---------------------------------------------------------------------------

export const CameraMultiTierRTPStreamManagementUUID = '00008031-0000-1000-8000-0026BB765291';
export const SupportedVideoStreamTiersUUID = '00008043-0000-1000-8000-0026BB765291';
export const SupportedAudioStreamTiersUUID = '00008044-0000-1000-8000-0026BB765291';
export const RTPStreamingControlUUID = '00008045-0000-1000-8000-0026BB765291';
export const StreamingEnabledUUID = '00008041-0000-1000-8000-0026BB765291';
export const SensorUUIDCharacteristicUUID = '0000805B-0000-1000-8000-0026BB765291';
/** Existing HAP characteristics reused by the new service. */
export const SetupEndpointsUUID = '00000118-0000-1000-8000-0026BB765291';
// 0x115 is Supported Audio Stream Configuration, not Supported RTP Configuration.
export const SupportedRTPConfigurationUUID = '00000116-0000-1000-8000-0026BB765291';
export const StatusActiveUUID = '00000075-0000-1000-8000-0026BB765291';

// ---------------------------------------------------------------------------
// Setup Endpoints (0x00000118) — identical layout to the legacy HAP characteristic
// ---------------------------------------------------------------------------

const SetupEndpointsTypes = {
    SESSION_ID: 0x01,
    CONTROLLER_ADDRESS: 0x03,
    VIDEO_SRTP_PARAMETERS: 0x04,
    AUDIO_SRTP_PARAMETERS: 0x05,
} as const;

const AddressTypes = {
    ADDRESS_VERSION: 0x01,
    ADDRESS: 0x02,
    VIDEO_RTP_PORT: 0x03,
    AUDIO_RTP_PORT: 0x04,
} as const;

const SRTPParametersTypes = {
    SRTP_CRYPTO_SUITE: 0x01,
    MASTER_KEY: 0x02,
    MASTER_SALT: 0x03,
} as const;

const SetupEndpointsResponseTypes = {
    SESSION_ID: 0x01,
    STATUS: 0x02,
    ACCESSORY_ADDRESS: 0x03,
    VIDEO_SRTP_PARAMETERS: 0x04,
    AUDIO_SRTP_PARAMETERS: 0x05,
    VIDEO_SSRC: 0x06,
    AUDIO_SSRC: 0x07,
} as const;

export const IPAddressVersion = { IPV4: 0x00, IPV6: 0x01 } as const;
export const SetupEndpointsStatus = { SUCCESS: 0x00, BUSY: 0x01, ERROR: 0x02 } as const;
/** SRTP crypto suite enum (matches HAP SRTPCryptoSuites). */
export const SRTPCryptoSuite = { AES_CM_128_HMAC_SHA1_80: 0x00, AES_CM_256_HMAC_SHA1_80: 0x01, NONE: 0x02 } as const;

export interface SrtpParams {
    cryptoSuite: number;
    masterKey: Buffer;
    masterSalt: Buffer;
}

export interface SetupEndpointsRequest {
    /** Raw 16-byte session identifier (kept opaque so it round-trips byte-for-byte). */
    sessionId: Buffer;
    addressVersion: 'ipv4' | 'ipv6';
    controllerAddress: string;
    videoPort: number;
    audioPort: number;
    video: SrtpParams;
    audio: SrtpParams;
}

/** Decode a flat TLV8 buffer into a map of type -> concatenated value (HAP `tlv.decode` semantics). */
export function tlvDecodeMap(buffer: Buffer): Record<number, Buffer> {
    const out: Record<number, Buffer> = {};
    for (const { type, value } of tlvDecodeRaw(buffer)) {
        if (type === 0x00) continue; // delimiter
        out[type] = out[type] ? Buffer.concat([out[type], value]) : value;
    }
    return out;
}

function parseSrtp(buf: Buffer): SrtpParams {
    const m = tlvDecodeMap(buf);
    return {
        cryptoSuite: m[SRTPParametersTypes.SRTP_CRYPTO_SUITE]?.readUInt8(0) ?? SRTPCryptoSuite.NONE,
        masterKey: m[SRTPParametersTypes.MASTER_KEY] ?? Buffer.alloc(0),
        masterSalt: m[SRTPParametersTypes.MASTER_SALT] ?? Buffer.alloc(0),
    };
}

/** Parse a controller's Setup Endpoints write (base64 already decoded to a Buffer). */
export function parseSetupEndpoints(buffer: Buffer): SetupEndpointsRequest {
    const objects = tlvDecodeMap(buffer);
    const address = tlvDecodeMap(objects[SetupEndpointsTypes.CONTROLLER_ADDRESS]);
    const version = address[AddressTypes.ADDRESS_VERSION]?.readUInt8(0) ?? IPAddressVersion.IPV4;
    return {
        sessionId: objects[SetupEndpointsTypes.SESSION_ID],
        addressVersion: version === IPAddressVersion.IPV6 ? 'ipv6' : 'ipv4',
        controllerAddress: address[AddressTypes.ADDRESS].toString('utf8'),
        videoPort: address[AddressTypes.VIDEO_RTP_PORT].readUInt16LE(0),
        audioPort: address[AddressTypes.AUDIO_RTP_PORT].readUInt16LE(0),
        video: parseSrtp(objects[SetupEndpointsTypes.VIDEO_SRTP_PARAMETERS]),
        audio: parseSrtp(objects[SetupEndpointsTypes.AUDIO_SRTP_PARAMETERS]),
    };
}

export interface SetupEndpointsResponse {
    sessionId: Buffer;
    status: number;
    addressVersion: 'ipv4' | 'ipv6';
    accessoryAddress: string;
    videoPort: number;
    audioPort: number;
    video: SrtpParams;
    audio: SrtpParams;
    videoSSRC: number;
    audioSSRC: number;
}

function encodeSrtp(p: SrtpParams): Buffer {
    return tlvEncode(
        SRTPParametersTypes.SRTP_CRYPTO_SUITE, u8(p.cryptoSuite),
        SRTPParametersTypes.MASTER_KEY, p.masterKey,
        SRTPParametersTypes.MASTER_SALT, p.masterSalt,
    );
}

/**
 * Build a failure Setup Endpoints response: session id + status only (the same shape
 * HAP-NodeJS's legacy RTPStreamManagement returns when streaming is disabled/busy).
 */
export function buildSetupEndpointsErrorResponse(sessionId: Buffer, status: number): Buffer {
    return tlvEncode(
        SetupEndpointsResponseTypes.SESSION_ID, sessionId,
        SetupEndpointsResponseTypes.STATUS, u8(status),
    );
}

/** Build the accessory's Setup Endpoints response (returns a Buffer; call `.toString('base64')`). */
export function buildSetupEndpointsResponse(r: SetupEndpointsResponse): Buffer {
    const address = tlvEncode(
        AddressTypes.ADDRESS_VERSION, u8(r.addressVersion === 'ipv6' ? IPAddressVersion.IPV6 : IPAddressVersion.IPV4),
        AddressTypes.ADDRESS, Buffer.from(r.accessoryAddress, 'utf8'),
        AddressTypes.VIDEO_RTP_PORT, u16(r.videoPort),
        AddressTypes.AUDIO_RTP_PORT, u16(r.audioPort),
    );
    return tlvEncode(
        SetupEndpointsResponseTypes.SESSION_ID, r.sessionId,
        SetupEndpointsResponseTypes.STATUS, u8(r.status),
        SetupEndpointsResponseTypes.ACCESSORY_ADDRESS, address,
        SetupEndpointsResponseTypes.VIDEO_SRTP_PARAMETERS, encodeSrtp(r.video),
        SetupEndpointsResponseTypes.AUDIO_SRTP_PARAMETERS, encodeSrtp(r.audio),
        SetupEndpointsResponseTypes.VIDEO_SSRC, u32(r.videoSSRC),
        SetupEndpointsResponseTypes.AUDIO_SSRC, u32(r.audioSSRC),
    );
}

// ---------------------------------------------------------------------------
// RTP Streaming Control (0x00008045) — start/stop a tier within a session
// ---------------------------------------------------------------------------

const RTPStreamingControlTypes = {
    SESSION_ID: 0x01,
    COMMAND: 0x02,
    VIDEO_TIER: 0x03,
    VIDEO_SSRC: 0x04,
    AUDIO_TIER: 0x05,
    AUDIO_SSRC: 0x06,
} as const;

/** Read (write-response) value of RTP Streaming Control (§4.16). */
const RTPStreamingControlResponseTypes = {
    SESSION_ID: 0x01,
    STATUS: 0x02,
} as const;

export const RTPStreamingCommand = { END: 0x01, START: 0x02 } as const;
export type RTPStreamingCommand = typeof RTPStreamingCommand[keyof typeof RTPStreamingCommand];

/**
 * Status of an RTP Streaming Control command (§4.16 read value). "No Such Stream indicates that
 * an End command was attempted for a stream that is not currently started."
 */
export const RTPStreamingStatus = {
    SUCCESS: 0x00,
    UNKNOWN_SESSION_IDENTIFIER: 0x01,
    NO_SUCH_STREAM: 0x02,
    BUSY: 0x03,
    ERROR: 0x04,
} as const;
export type RTPStreamingStatus = typeof RTPStreamingStatus[keyof typeof RTPStreamingStatus];

export interface RTPStreamingControlWrite {
    sessionId: Buffer;
    command: RTPStreamingCommand;
    videoTier?: number;
    videoSSRC?: number;
    audioTier?: number;
    audioSSRC?: number;
}

export class RTPStreamingControlParseError extends Error {
    constructor(message: string, readonly sessionId?: Buffer) { super(message); }
}

/** HAP integers use up to their declared width; leading zero octets may be omitted. */
function readControlUInt(buffer: Buffer | undefined, name: string): number | undefined {
    if (buffer === undefined) return undefined;
    if (buffer.length > 4) throw new Error(`${name} exceeds uint32 width`);
    return buffer.length ? buffer.readUIntLE(0, buffer.length) : 0;
}

/** Parse the controller's RTP Streaming Control write, including compact HAP integers. */
export function parseRTPStreamingControl(buffer: Buffer): RTPStreamingControlWrite {
    const m: Record<number, Buffer> = {};
    try {
        for (let at = 0; at < buffer.length;) {
            if (at + 2 > buffer.length) throw new Error('Truncated streaming control TLV header');
            const type = buffer[at++], length = buffer[at++];
            if (at + length > buffer.length) throw new Error('Truncated streaming control TLV value');
            // Every defined field is scalar and at most 16 bytes, so none needs fragmentation.
            if (type >= 1 && type <= 6) {
                if (m[type] !== undefined) throw new Error(`Duplicate streaming control field ${type}`);
                m[type] = buffer.subarray(at, at + length);
            }
            at += length;
        }
        if (m[1]?.length !== 16) throw new Error('Session Identifier must be 16 bytes');
        if (m[2]?.length !== 1) throw new Error('Command must be one byte');
        const command = m[2][0];
        if (command !== RTPStreamingCommand.START && command !== RTPStreamingCommand.END)
            throw new Error('Unsupported RTP streaming command');
        const out: RTPStreamingControlWrite = { sessionId: m[1], command };
        if (command === RTPStreamingCommand.END) return out;
        out.videoTier = readControlUInt(m[3], 'Video Tier');
        out.videoSSRC = readControlUInt(m[4], 'Video SSRC');
        out.audioTier = readControlUInt(m[5], 'Audio Tier');
        out.audioSSRC = readControlUInt(m[6], 'Audio SSRC');
        if ([out.videoTier, out.videoSSRC, out.audioTier, out.audioSSRC].some(v => v === undefined))
            throw new Error('RTP Start requires video/audio tiers and SSRCs');
        return out;
    }
    catch (e) {
        throw new RTPStreamingControlParseError(e instanceof Error ? e.message : 'Invalid streaming control',
            m[1]?.length === 16 ? m[1] : undefined);
    }
}

/**
 * Build the RTP Streaming Control read value (the Write-Response the controller reads back after
 * writing): Session Identifier (1) + Status (2), per §4.16.
 */
export function buildRTPStreamingControlResponse(sessionId: Buffer, status: RTPStreamingStatus = RTPStreamingStatus.SUCCESS): Buffer {
    return tlvEncode(
        RTPStreamingControlResponseTypes.SESSION_ID, sessionId,
        RTPStreamingControlResponseTypes.STATUS, u8(status),
    );
}

/** Parse an RTP Streaming Control read value (used by tests / diagnostics). */
export function parseRTPStreamingControlResponse(buffer: Buffer): { sessionId: Buffer, status: number } {
    const m = tlvDecodeMap(buffer);
    return {
        sessionId: m[RTPStreamingControlResponseTypes.SESSION_ID],
        status: m[RTPStreamingControlResponseTypes.STATUS]?.readUInt8(0) ?? RTPStreamingStatus.ERROR,
    };
}
