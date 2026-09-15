/**
 * hksv-camera-capabilities.ts
 *
 * Wire-format encoder for the "Camera Capabilities" service (UUID 0x00008010) and its
 * "Camera Capabilities" characteristic (UUID 0x00008011), per the HomeKit Secure Video
 * Open Source Compatibility Guide (rev. 2026-06-03), §3.1 / §4.5.
 *
 * This service is the linchpin of the whole feature. From the guide:
 *
 *   "The Camera Capabilities Service is specific to this project and is intended as the
 *    primary mechanism by which an accessory will advertise its capabilities over HAP."
 *   "...the presence of this service and characteristic with versions as specified in this
 *    document is required to signify that this camera supports the camera functionality
 *    described in this specification."
 *
 * i.e. without this service an iOS/tvOS 27 controller will not treat the accessory as a
 * new-style (4K / multi-tier / CMAF) camera at all, regardless of which other services exist.
 *
 * The Version characteristic ("11.31 Version" from HAP R17, UUID 0x37) on this service must
 * carry the string "17.99" (per §3.1; "may be updated prior to release").
 *
 * Layout implemented here (§4.5):
 *
 *   Camera Capabilities (tlv8)
 *     1 Version        uint8   — version of the data in this characteristic
 *     2 Camera Sensors tlv8    — Camera Sensors TLV8:
 *         1 (repeated) Sensor Configuration TLV8:
 *             1 Sensor Dimensions tlv8   { 1 Width uint16, 2 Height uint16 }
 *             2 Sensor UUID data
 *             3 Sensor Type enum         (0 Unknown, 1 Primary, 255 Generic)
 *             4 Sensor Intent enum       (0 Unknown, 1 Main, 2 Package, 255 Generic)
 *             5 (repeated) Video Stream Capabilities TLV8:
 *                 1 Identifier data      (UUID identifying this video configuration)
 *                 2 Video Quality enum
 *                 3 Width uint16
 *                 4 Height uint16
 *                 5 Frames Per Second uint8
 *                 6 Average Bit Rate uint32 (kbps)
 *                 7 Peak Bit Rate uint32 (kbps)
 *
 * Validated by hksv-camera-capabilities.test.ts.
 */

import { createHash } from 'node:crypto';
import {
    CameraVideoQuality,
    RECOMMENDED_BITRATES_KBPS,
    tlvEncode,
    u8,
    u16,
    u32,
} from './hksv-stream-tiers';
import type { VideoStreamTier } from './hksv-stream-tiers';

// ---------------------------------------------------------------------------
// UUIDs (Apple base UUID suffix -0000-1000-8000-0026BB765291)
// ---------------------------------------------------------------------------

/** Camera Capabilities service (§3.1). */
export const CameraCapabilitiesServiceUUID = '00008010-0000-1000-8000-0026BB765291';
/** Camera Capabilities characteristic (§4.5). */
export const CameraCapabilitiesCharacteristicUUID = '00008011-0000-1000-8000-0026BB765291';
/** "11.31 Version" characteristic from HAP R17, required on Camera Capabilities + Motion Zones. */
export const VersionCharacteristicUUID = '00000037-0000-1000-8000-0026BB765291';
/** Version string carried by the Version characteristic of Camera Capabilities and Camera
 *  Motion Zones services (§3.1, §3.4: "will contain the value 17.99"). */
export const CAMERA_CAPABILITIES_VERSION = '17.99';

/** Camera Global Operating Mode service (§3.2). */
export const CameraGlobalOperatingModeServiceUUID = '00008032-0000-1000-8000-0026BB765291';
// Existing R17 characteristics required/optional on Camera Global Operating Mode:
export const HomeKitCameraActiveUUID = '0000021B-0000-1000-8000-0026BB765291';
export const CameraOperatingModeIndicatorUUID = '0000021D-0000-1000-8000-0026BB765291';
export const ManuallyDisabledUUID = '00000227-0000-1000-8000-0026BB765291';
export const ThirdPartyCameraActiveUUID = '0000021C-0000-1000-8000-0026BB765291';
export const NightVisionUUID = '0000011B-0000-1000-8000-0026BB765291';

// ---------------------------------------------------------------------------
// Enumerations (§4.5)
// ---------------------------------------------------------------------------

export const SensorType = {
    UNKNOWN: 0,
    PRIMARY: 1,
    GENERIC: 255,
} as const;
export type SensorType = typeof SensorType[keyof typeof SensorType];

export const SensorIntent = {
    UNKNOWN: 0,
    MAIN: 1,
    PACKAGE: 2,
    GENERIC: 255,
} as const;
export type SensorIntent = typeof SensorIntent[keyof typeof SensorIntent];

// TLV8 field identifiers ----------------------------------------------------

const CameraCapabilitiesTypes = {
    VERSION: 0x01,
    CAMERA_SENSORS: 0x02,
} as const;

const CameraSensorsTypes = {
    SENSOR_CONFIGURATION: 0x01, // repeated
} as const;

const SensorConfigurationTypes = {
    SENSOR_DIMENSIONS: 0x01,
    SENSOR_UUID: 0x02,
    SENSOR_TYPE: 0x03,
    SENSOR_INTENT: 0x04,
    VIDEO_STREAM_CAPABILITIES: 0x05, // repeated
} as const;

const SensorDimensionsTypes = {
    WIDTH: 0x01,
    HEIGHT: 0x02,
} as const;

const VideoStreamCapabilitiesTypes = {
    IDENTIFIER: 0x01, // data (UUID)
    VIDEO_QUALITY: 0x02,
    WIDTH: 0x03,
    HEIGHT: 0x04,
    FRAMES_PER_SECOND: 0x05,
    AVERAGE_BIT_RATE: 0x06, // kbps
    PEAK_BIT_RATE: 0x07, // kbps
} as const;

/** Version of the Camera Capabilities *data* (field 1 of the characteristic). The guide does
 *  not enumerate values; 1 is the initial data version. VALIDATE against a real controller. */
export const CAMERA_CAPABILITIES_DATA_VERSION = 1;

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export interface VideoStreamCapability {
    /** 16-byte UUID identifying this video configuration. */
    identifier: Buffer;
    quality: CameraVideoQuality;
    width: number;
    height: number;
    frameRate: number;
    averageBitrateKbps: number;
    peakBitrateKbps: number;
}

export interface SensorConfiguration {
    /** Native sensor dimensions in pixels. */
    sensorWidth: number;
    sensorHeight: number;
    /** 16-byte sensor UUID; must match the Sensor UUID characteristic (0x805B) of the
     *  streaming/motion services representing this sensor. */
    sensorUuid: Buffer;
    sensorType: SensorType;
    sensorIntent: SensorIntent;
    videoStreamCapabilities: VideoStreamCapability[];
}

// ---------------------------------------------------------------------------
// Encoders
// ---------------------------------------------------------------------------

function encodeVideoStreamCapability(c: VideoStreamCapability): Buffer {
    return tlvEncode(
        VideoStreamCapabilitiesTypes.IDENTIFIER, c.identifier,
        VideoStreamCapabilitiesTypes.VIDEO_QUALITY, u8(c.quality),
        VideoStreamCapabilitiesTypes.WIDTH, u16(c.width),
        VideoStreamCapabilitiesTypes.HEIGHT, u16(c.height),
        VideoStreamCapabilitiesTypes.FRAMES_PER_SECOND, u8(c.frameRate),
        VideoStreamCapabilitiesTypes.AVERAGE_BIT_RATE, u32(c.averageBitrateKbps),
        VideoStreamCapabilitiesTypes.PEAK_BIT_RATE, u32(c.peakBitrateKbps),
    );
}

export function encodeSensorConfiguration(s: SensorConfiguration): Buffer {
    const dimensions = tlvEncode(
        SensorDimensionsTypes.WIDTH, u16(s.sensorWidth),
        SensorDimensionsTypes.HEIGHT, u16(s.sensorHeight),
    );
    return tlvEncode(
        SensorConfigurationTypes.SENSOR_DIMENSIONS, dimensions,
        SensorConfigurationTypes.SENSOR_UUID, s.sensorUuid,
        SensorConfigurationTypes.SENSOR_TYPE, u8(s.sensorType),
        SensorConfigurationTypes.SENSOR_INTENT, u8(s.sensorIntent),
        SensorConfigurationTypes.VIDEO_STREAM_CAPABILITIES, s.videoStreamCapabilities.map(encodeVideoStreamCapability),
    );
}

/**
 * Encodes the value of the "Camera Capabilities" characteristic (0x00008011).
 * Returns a Buffer (call `.toString('base64')` for HAP).
 */
export function encodeCameraCapabilities(sensors: SensorConfiguration[], dataVersion = CAMERA_CAPABILITIES_DATA_VERSION): Buffer {
    const cameraSensors = tlvEncode(
        CameraSensorsTypes.SENSOR_CONFIGURATION, sensors.map(encodeSensorConfiguration),
    );
    return tlvEncode(
        CameraCapabilitiesTypes.VERSION, u8(dataVersion),
        CameraCapabilitiesTypes.CAMERA_SENSORS, cameraSensors,
    );
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/**
 * Derives a stable 16-byte RFC-4122-shaped UUID for a video configuration from the sensor UUID
 * and the tier identifier, so the capability advertisement stays consistent across restarts.
 */
export function deriveVideoConfigurationUuid(sensorUuid: Buffer, tierIdentifier: number): Buffer {
    const digest = createHash('sha256')
        .update(sensorUuid)
        .update('hksv-video-configuration')
        .update(String(tierIdentifier))
        .digest()
        .subarray(0, 16);
    // Stamp RFC 4122 version (5-style: name-based) + variant bits so the value is a plausible UUID.
    digest[6] = (digest[6] & 0x0f) | 0x50;
    digest[8] = (digest[8] & 0x3f) | 0x80;
    return digest;
}

/** Look up the guide's *peak* bitrate (§2 target-bitrates table) for a tier's resolution/quality. */
export function peakBitrateKbpsForTier(tier: VideoStreamTier): number {
    // Dimension thresholds misclassify portrait, square and 4:3 tiers. The builder
    // uses the guide's target bitrates regardless of sensor aspect ratio.
    if (tier.averageBitrateKbps > 2800) return RECOMMENDED_BITRATES_KBPS['4k'].maximum;
    if (tier.averageBitrateKbps > 1700) return RECOMMENDED_BITRATES_KBPS['2k'].maximum;
    if (tier.averageBitrateKbps > 768) return RECOMMENDED_BITRATES_KBPS['1080p'].maximum;
    if (tier.averageBitrateKbps > 180) return RECOMMENDED_BITRATES_KBPS['720p'].maximum;
    return RECOMMENDED_BITRATES_KBPS['360p'].maximum;
}

/**
 * Builds the Video Stream Capabilities list for a sensor from the same tier set advertised in
 * "Supported Video Stream Tiers", so both characteristics describe identical configurations.
 */
export function buildVideoStreamCapabilities(sensorUuid: Buffer, tiers: VideoStreamTier[]): VideoStreamCapability[] {
    return tiers.map(tier => ({
        identifier: deriveVideoConfigurationUuid(sensorUuid, tier.identifier),
        quality: tier.quality,
        width: tier.width,
        height: tier.height,
        frameRate: tier.frameRate,
        averageBitrateKbps: tier.averageBitrateKbps,
        peakBitrateKbps: peakBitrateKbpsForTier(tier),
    }));
}

/** Builds the single-(primary,main)-sensor configuration used by a typical one-sensor camera. */
export function buildPrimarySensorConfiguration(
    sensorUuid: Buffer,
    sensorWidth: number,
    sensorHeight: number,
    tiers: VideoStreamTier[],
): SensorConfiguration {
    return {
        sensorWidth,
        sensorHeight,
        sensorUuid,
        sensorType: SensorType.PRIMARY,
        sensorIntent: SensorIntent.MAIN,
        videoStreamCapabilities: buildVideoStreamCapabilities(sensorUuid, tiers),
    };
}
