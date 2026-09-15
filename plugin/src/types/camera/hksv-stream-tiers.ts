/**
 * hksv-stream-tiers.ts
 *
 * Dependency-free wire-format encoders/decoders for the HomeKit camera streaming
 * characteristics introduced with iOS/tvOS 27:
 *
 *   - Supported Video Stream Tiers   (UUID 0x00008043)
 *   - Supported Audio Stream Tiers   (UUID 0x00008044)
 *
 * plus helpers that build the standard tier sets from Apple's "HomeKit Secure Video
 * Open Source Compatibility Guide" (revision 2026-06-03), which mandates HEVC and adds
 * the 4K (3840x2160) "High"/"Highest" quality tier.
 *
 * This is the reusable core of a real 4K HomeKit live-streaming implementation, and is
 * validated by hksv-stream-tiers.test.ts (run: `node --experimental-strip-types
 * src/hksv-stream-tiers.test.ts`).
 *
 * IMPORTANT: encoding these characteristics is necessary but NOT sufficient to make 4K
 * work. They are only honored when exposed through the new "Camera Multi-Tier RTP Stream
 * Management" service (UUID 0x00008031), which must be implemented in HAP-NodeJS together
 * with the Setup Endpoints / RTP Streaming Control negotiation. See docs/implementation-plan.md.
 *
 * TLV8 encoding here intentionally mirrors HAP-NodeJS's util/tlv `encode()` semantics
 * (little-endian integers, 0x00 zero-length delimiter between repeated list entries,
 * 255-byte fragmentation) so the output is byte-compatible with the rest of the HAP stack.
 */

// ---------------------------------------------------------------------------
// Enumerations (from the HKSV Open Source Compatibility Guide, 2026-06-03)
// ---------------------------------------------------------------------------

/** Video Codec Type enumeration used by the *tiers* characteristics (NOTE: differs from the
 *  legacy SupportedVideoStreamConfiguration enum, where H.264 = 0). */
export const TierVideoCodec = {
    H264: 1,
    H265: 2, // HEVC - required for 4K
} as const;
export type TierVideoCodec = typeof TierVideoCodec[keyof typeof TierVideoCodec];

/** Audio Codec Type enumeration for the audio tiers characteristic. */
export const TierAudioCodec = {
    OPUS: 3,
} as const;
export type TierAudioCodec = typeof TierAudioCodec[keyof typeof TierAudioCodec];

/** Camera Video Quality enumeration. */
export const CameraVideoQuality = {
    /** Optional. The 4K stream for a camera that simultaneously offers a 2K stream as "High". */
    HIGHEST: 1,
    /** The high quality stream (4K, 2K, or 1080p depending on hardware). */
    HIGH: 2,
    /** The medium quality stream (1080p if High is 2K/4K, otherwise 720p). */
    MEDIUM: 3,
    /** The lowest quality stream (360p 15fps, or 240p 30fps). */
    LOW: 4,
} as const;
export type CameraVideoQuality = typeof CameraVideoQuality[keyof typeof CameraVideoQuality];

/** Audio sample rate enumeration (audio tier). */
export const TierSampleRate = {
    KHZ_16: 1,
    KHZ_24: 2,
    KHZ_32: 3,
    KHZ_48: 4,
} as const;
export type TierSampleRate = typeof TierSampleRate[keyof typeof TierSampleRate];

/** Audio bit depth enumeration (audio tier). */
export const TierBitDepth = {
    BITS_8: 1,
    BITS_16: 2,
    BITS_24: 3,
} as const;
export type TierBitDepth = typeof TierBitDepth[keyof typeof TierBitDepth];

// TLV8 field identifiers ----------------------------------------------------

const SupportedVideoStreamTiersTypes = {
    CODEC: 0x01,
    PAYLOAD_TYPE: 0x02,
    TIERS: 0x03,
} as const;

const VideoStreamTierTypes = {
    IDENTIFIER: 0x01,
    QUALITY: 0x02,
    AVERAGE_BITRATE: 0x03, // kbps
    WIDTH: 0x04,
    HEIGHT: 0x05,
    FRAME_RATE: 0x06,
} as const;

const SupportedAudioStreamTiersTypes = {
    CODEC: 0x01,
    PAYLOAD_TYPE: 0x02,
    TIERS: 0x03,
} as const;

const AudioStreamTierTypes = {
    IDENTIFIER: 0x01,
    AVERAGE_BITRATE: 0x02, // bps
    SAMPLE_RATE: 0x03,
    BIT_DEPTH: 0x04,
    PACKET_TIME: 0x05, // ms, only allowed value is 20
    CHANNELS: 0x06, // only allowed value is 1
} as const;

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export interface VideoStreamTier {
    identifier: number;
    quality: CameraVideoQuality;
    /** Target average bitrate in kbps. */
    averageBitrateKbps: number;
    width: number;
    height: number;
    frameRate: number;
}

export interface VideoStreamTierGroup {
    codec: TierVideoCodec;
    /** RTP payload type (RFC 3551), e.g. 99. */
    payloadType: number;
    tiers: VideoStreamTier[];
}

export interface AudioStreamTier {
    identifier: number;
    /** Target average bitrate in bits per second. */
    averageBitrateBps: number;
    sampleRate: TierSampleRate;
    bitDepth: TierBitDepth;
    /** Packet time in ms. The only allowed value per the spec is 20. */
    packetTimeMs?: number;
    /** Number of channels. The only allowed value per the spec is 1. */
    channels?: number;
}

export interface AudioStreamTierGroup {
    codec: TierAudioCodec;
    payloadType: number;
    tiers: AudioStreamTier[];
}

// ---------------------------------------------------------------------------
// Minimal HAP-compatible TLV8 encoder
// ---------------------------------------------------------------------------

const EMPTY_TLV_TYPE = 0x00; // zero-length tlv used as the delimiter between repeated list entries

export function u8(n: number): Buffer {
    const b = Buffer.alloc(1);
    b.writeUInt8(n & 0xff, 0);
    return b;
}
export function u16(n: number): Buffer {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(n & 0xffff, 0);
    return b;
}
export function u32(n: number): Buffer {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n >>> 0, 0);
    return b;
}

function encodeOne(type: number, data: Buffer): Buffer {
    if (data.length <= 255)
        return Buffer.concat([Buffer.from([type, data.length]), data]);
    // fragment into <=255 byte chunks under the same type
    const parts: Buffer[] = [];
    let off = 0;
    while (off < data.length) {
        const len = Math.min(255, data.length - off);
        parts.push(Buffer.from([type, len]), data.subarray(off, off + len));
        off += len;
    }
    return Buffer.concat(parts);
}

/**
 * Variadic (type, value) TLV8 encoder, mirroring HAP-NodeJS's util/tlv encode().
 * A `Buffer[]` value is treated as a repeated list: each element is encoded under the
 * same type and separated from the next by a zero-length 0x00 delimiter.
 */
export function tlvEncode(...args: Array<number | Buffer | Buffer[]>): Buffer {
    const out: Buffer[] = [];
    for (let i = 0; i < args.length; i += 2) {
        const type = args[i] as number;
        const value = args[i + 1] as number | Buffer | Buffer[];
        if (Array.isArray(value)) {
            if (value.length === 0) {
                out.push(Buffer.from([type, 0]));
            }
            else {
                value.forEach((v, idx) => {
                    if (idx > 0)
                        out.push(Buffer.from([EMPTY_TLV_TYPE, 0]));
                    out.push(encodeOne(type, v));
                });
            }
            continue;
        }
        const buf = typeof value === 'number' ? u8(value) : value;
        out.push(encodeOne(type, buf));
    }
    return Buffer.concat(out);
}

/**
 * Decodes a flat TLV8 buffer into ordered { type, value } records. Zero-length 0x00
 * delimiters are emitted as records (type 0, empty value) so callers can split lists.
 * Sufficient for the small tier structures here (no >255 byte fragmentation).
 */
export function tlvDecodeRaw(buffer: Buffer): Array<{ type: number, value: Buffer }> {
    const out: Array<{ type: number, value: Buffer }> = [];
    let i = 0;
    while (i + 1 < buffer.length || (i < buffer.length && buffer[i] === EMPTY_TLV_TYPE)) {
        const type = buffer[i];
        const len = buffer[i + 1] ?? 0;
        out.push({ type, value: buffer.subarray(i + 2, i + 2 + len) });
        i += 2 + len;
    }
    return out;
}

// ---------------------------------------------------------------------------
// Encoders
// ---------------------------------------------------------------------------

export function encodeVideoStreamTier(tier: VideoStreamTier): Buffer {
    return tlvEncode(
        VideoStreamTierTypes.IDENTIFIER, u32(tier.identifier),
        VideoStreamTierTypes.QUALITY, u8(tier.quality),
        VideoStreamTierTypes.AVERAGE_BITRATE, u32(tier.averageBitrateKbps),
        VideoStreamTierTypes.WIDTH, u16(tier.width),
        VideoStreamTierTypes.HEIGHT, u16(tier.height),
        VideoStreamTierTypes.FRAME_RATE, u8(tier.frameRate),
    );
}

/**
 * Encodes the value of the "Supported Video Stream Tiers" characteristic (0x00008043).
 * §4.3/§4.23 define one Codec and Payload Type; only Tiers is repeated.
 * Concatenating multiple codec groups duplicates scalar fields and is not this schema.
 */
export function encodeSupportedVideoStreamTiers(groups: VideoStreamTierGroup[]): Buffer {
    if (groups.length !== 1) throw new Error('A video tier characteristic must describe exactly one codec');
    const [g] = groups;
    return tlvEncode(
        SupportedVideoStreamTiersTypes.CODEC, u8(g.codec),
        SupportedVideoStreamTiersTypes.PAYLOAD_TYPE, u8(g.payloadType),
        SupportedVideoStreamTiersTypes.TIERS, g.tiers.map(encodeVideoStreamTier),
    );
}

export function encodeAudioStreamTier(tier: AudioStreamTier): Buffer {
    return tlvEncode(
        AudioStreamTierTypes.IDENTIFIER, u32(tier.identifier),
        AudioStreamTierTypes.AVERAGE_BITRATE, u32(tier.averageBitrateBps),
        AudioStreamTierTypes.SAMPLE_RATE, u8(tier.sampleRate),
        AudioStreamTierTypes.BIT_DEPTH, u8(tier.bitDepth),
        AudioStreamTierTypes.PACKET_TIME, u8(tier.packetTimeMs ?? 20),
        AudioStreamTierTypes.CHANNELS, u8(tier.channels ?? 1),
    );
}

/** Encodes the value of the "Supported Audio Stream Tiers" characteristic (0x00008044). */
export function encodeSupportedAudioStreamTiers(groups: AudioStreamTierGroup[]): Buffer {
    if (groups.length !== 1) throw new Error('An audio tier characteristic must describe exactly one codec');
    const [g] = groups;
    if (g.tiers.length !== 1) throw new Error('Exactly one audio tier is supported by this revision');
    return tlvEncode(
        SupportedAudioStreamTiersTypes.CODEC, u8(g.codec),
        SupportedAudioStreamTiersTypes.PAYLOAD_TYPE, u8(g.payloadType),
        SupportedAudioStreamTiersTypes.TIERS, g.tiers.map(encodeAudioStreamTier),
    );
}

// ---------------------------------------------------------------------------
// Tier builders (Section 2 "Minimum Requirements" of the compatibility guide)
// ---------------------------------------------------------------------------

/** Apple HKSV recommended 16:9 target bitrates in kbps: average and maximum (peak). */
export const RECOMMENDED_BITRATES_KBPS = {
    '4k': { average: 4500, maximum: 5000 },
    '2k': { average: 2800, maximum: 3000 },
    '1080p': { average: 1700, maximum: 1800 },
    '720p': { average: 768, maximum: 800 },
    '360p': { average: 180, maximum: 190 },
} as const;

export type SensorClass = '4k' | '2k' | '1080p';

interface BuildOptions {
    sensorWidth?: number;
    sensorHeight?: number;
    /** High frame rate. 4K/2K supports 24 or 30. Defaults to 30. */
    frameRate?: number;
    /** Set for 4K sensors that can ALSO provide a simultaneous 2K stream; adds the optional
     *  "Highest" (4K) tier with 2K as "High". Per the guide, do not use "Highest" otherwise. */
    simultaneous2k?: boolean;
    /** First tier identifier (defaults to 1). Use distinct ranges per codec group so an
     *  RTP Streaming Control "Video Tier" value unambiguously selects codec + encoding. */
    firstIdentifier?: number;
}

/**
 * Builds the standard 16:9 video tier set for a sensor class, per the guide's minimum
 * requirements table (High / Medium / Low, plus optional Highest for dual 4K+2K sensors).
 */
export function buildHksvVideoTiers(sensor: SensorClass, opts: BuildOptions = {}): VideoStreamTier[] {
    const fps = opts.frameRate === 24 && sensor !== '1080p' ? 24 : 30;
    let id = opts.firstIdentifier ?? 1;
    const tier = (quality: CameraVideoQuality, w: number, h: number,
        rateKey: keyof typeof RECOMMENDED_BITRATES_KBPS, frameRate: number): VideoStreamTier => ({
            identifier: id++,
            quality,
            width: w,
            height: h,
            frameRate,
            averageBitrateKbps: RECOMMENDED_BITRATES_KBPS[rateKey].average,
        });

    const low = () => tier(CameraVideoQuality.LOW, 640, 360, '360p', 15);

    if (sensor === '4k') {
        if (opts.simultaneous2k) {
            return [
                tier(CameraVideoQuality.HIGHEST, 3840, 2160, '4k', fps),
                tier(CameraVideoQuality.HIGH, 2560, 1440, '2k', fps),
                tier(CameraVideoQuality.MEDIUM, 1920, 1080, '1080p', 30),
                low(),
            ];
        }
        return [
            tier(CameraVideoQuality.HIGH, 3840, 2160, '4k', fps),
            tier(CameraVideoQuality.MEDIUM, 1920, 1080, '1080p', 30),
            low(),
        ];
    }
    if (sensor === '2k') {
        return [
            tier(CameraVideoQuality.HIGH, 2560, 1440, '2k', fps),
            tier(CameraVideoQuality.MEDIUM, 1920, 1080, '1080p', 30),
            low(),
        ];
    }
    // 1080p
    return [
        tier(CameraVideoQuality.HIGH, 1920, 1080, '1080p', fps),
        tier(CameraVideoQuality.MEDIUM, 1280, 720, '720p', fps),
        low(),
    ];
}

/** Select the aspect-ratio family and encodings that fit the source sensor. Smaller tiers
 * are provisioned by the media encoder if the camera has no matching native output. */
export function buildSensorVideoTiers(width: number, height: number, nativeFrameRate?: number): VideoStreamTier[] {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 2 || height < 2)
        throw new Error('Camera dimensions are required before advertising HEVC tiers');
    const families = [
        { ratio: 16 / 9, high: [[3840,2160], [2560,1440], [1920,1080]], medium: [[1920,1080], [1920,1080], [1280,720]], low: [640,360] },
        { ratio: 9 / 16, high: [[2160,3840], [1440,2560], [1080,1920]], medium: [[1080,1920], [1080,1920], [720,1280]], low: [360,640] },
        { ratio: 4 / 3, high: [[2880,2160], [2048,1536], [1600,1200]], medium: [[1600,1200], [1600,1200], [1440,1080]], low: [640,480] },
        { ratio: 3 / 4, high: [[2400,3200], [1536,2048], [1200,1600]], medium: [[1200,1600], [1200,1600], [960,1280]], low: [480,640] },
        { ratio: 1, high: [[2880,2880], [1920,1920], [1440,1440]], medium: [[1440,1440], [1440,1440], [1080,1080]], low: [480,480] },
    ];
    const family = families.reduce((a,b) => Math.abs(a.ratio - width / height) < Math.abs(b.ratio - width / height) ? a : b);
    const index = family.high.findIndex(([w,h]) => w <= width && h <= height);
    if (index < 0) throw new Error(`Source ${width}x${height} cannot supply the minimum new HomeKit high tier`);
    const rate = [RECOMMENDED_BITRATES_KBPS['4k'], RECOMMENDED_BITRATES_KBPS['2k'], RECOMMENDED_BITRATES_KBPS['1080p']][index];
    const make = (identifier: number, quality: CameraVideoQuality, size: number[], frameRate: number, averageBitrateKbps: number): VideoStreamTier => ({ identifier, quality, width: size[0], height: size[1], frameRate, averageBitrateKbps });
    return [
        make(1, CameraVideoQuality.HIGH, family.high[index], index < 2 && nativeFrameRate === 24 ? 24 : 30, rate.average),
        make(2, CameraVideoQuality.MEDIUM, family.medium[index], 30, index === 2 ? 768 : 1700),
        make(3, CameraVideoQuality.LOW, family.low, 15, 180),
    ];
}

/** The mandatory Opus audio tier (16 kHz capture; 48 kHz reported per the guide). */
export function buildHksvOpusAudioTier(identifier = 1): AudioStreamTier {
    return {
        identifier,
        averageBitrateBps: 24000,
        sampleRate: TierSampleRate.KHZ_48,
        bitDepth: TierBitDepth.BITS_16,
        packetTimeMs: 20,
        channels: 1,
    };
}
