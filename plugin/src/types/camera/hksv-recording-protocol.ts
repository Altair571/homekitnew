/**
 * hksv-recording-protocol.ts
 *
 * Dependency-free wire-format codecs for the HomeKit Secure Video (iOS/tvOS 27, CMAF-ingest)
 * recording surface, per the HKSV Open Source Compatibility Guide (rev. 2026-06-03):
 *
 *   §3.5  Camera Buffer Management service            (0x00008000)
 *     §4.9   Buffer Upload Command                    (0x00008013)
 *     §4.10  Buffer Activity Command                  (0x00008017)
 *     §4.11  Buffer Event Command                     (0x00008014)
 *     §4.12  Buffer Event Sequence Number             (0x00008015, uint32)
 *     §4.13  Camera Recording Publishing Point        (0x00008016)
 *   §3.9  Camera Key Management service               (0x00008050)
 *     §4.7   Camera Key                               (0x00008051)
 *     §4.8   Camera Key ID                            (0x00008052)
 *   §3.10 Camera Client Certificate Management        (0x00008080)
 *     §4.25  Camera Client CSR                        (0x00008081)
 *     §4.26  Camera Client Certificate                (0x00008082)
 *     §4.27  Camera Client Certificate Status         (0x00008083)
 *   §3.4  Camera Motion Zones service                 (0x00008021)
 *     §4.14  Camera Zones                             (0x00008022, Zone Data version 2)
 *   §3.3  Motion Sensor additions
 *     §4.2   Motion Enabled                           (0x00008087, bool)
 *     §4.6   Contributing Sensors                     (0x00008086)
 *
 * plus a small in-memory Camera Event Queue implementing the Query/Acknowledge semantics of
 * §4.11/§4.12. 64-bit fields (timestamps, session ids, sequence numbers) are bigint — NTP
 * timestamps exceed Number.MAX_SAFE_INTEGER. All codecs are validated by
 * hksv-recording-protocol.test.ts.
 */

import { tlvEncode, tlvDecodeRaw, u8, u32 } from './hksv-stream-tiers';
import { tlvDecodeMap } from './hksv-multitier-protocol';

// ---------------------------------------------------------------------------
// UUIDs (Apple base UUID suffix -0000-1000-8000-0026BB765291)
// ---------------------------------------------------------------------------

export const CameraBufferManagementServiceUUID = '00008000-0000-1000-8000-0026BB765291';
export const BufferUploadCommandUUID = '00008013-0000-1000-8000-0026BB765291';
export const BufferEventCommandUUID = '00008014-0000-1000-8000-0026BB765291';
export const BufferEventSequenceNumberUUID = '00008015-0000-1000-8000-0026BB765291';
export const CameraRecordingPublishingPointUUID = '00008016-0000-1000-8000-0026BB765291';
export const BufferActivityCommandUUID = '00008017-0000-1000-8000-0026BB765291';

export const CameraKeyManagementServiceUUID = '00008050-0000-1000-8000-0026BB765291';
export const CameraKeyUUID = '00008051-0000-1000-8000-0026BB765291';
export const CameraKeyIDUUID = '00008052-0000-1000-8000-0026BB765291';

export const CameraClientCertificateManagementServiceUUID = '00008080-0000-1000-8000-0026BB765291';
export const CameraClientCSRUUID = '00008081-0000-1000-8000-0026BB765291';
export const CameraClientCertificateUUID = '00008082-0000-1000-8000-0026BB765291';
export const CameraClientCertificateStatusUUID = '00008083-0000-1000-8000-0026BB765291';

export const CameraMotionZonesServiceUUID = '00008021-0000-1000-8000-0026BB765291';
export const CameraZonesUUID = '00008022-0000-1000-8000-0026BB765291';

export const MotionEnabledUUID = '00008087-0000-1000-8000-0026BB765291';
export const ContributingSensorsUUID = '00008086-0000-1000-8000-0026BB765291';

/** Camera Recording Management service (§3.8) — same UUID as the R16/R17 service; the new spec
 *  narrows its required characteristics to Active + Recording Audio Active. */
export const CameraRecordingManagementServiceUUID = '00000204-0000-1000-8000-0026BB765291';
/** "11.89 Active" (R17), required on Camera Motion Zones + Camera Recording Management. */
export const ActiveCharacteristicUUID = '000000B0-0000-1000-8000-0026BB765291';

// ---------------------------------------------------------------------------
// uint64 helpers (little-endian, HAP TLV integer convention)
// ---------------------------------------------------------------------------

export function u64(n: bigint | number): Buffer {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(n) & 0xffffffffffffffffn, 0);
    return b;
}

/** Reads a little-endian unsigned integer of 1..8 bytes as a bigint (controllers may write
 *  minimally-sized integers per the HAP TLV convention). */
export function readUIntLE(buf: Buffer): bigint {
    let v = 0n;
    for (let i = buf.length - 1; i >= 0; i--)
        v = (v << 8n) | BigInt(buf[i]);
    return v;
}

// ---------------------------------------------------------------------------
// §4.9 Buffer Upload Command (0x00008013) — Paired Read, Paired Write, Write Response
// ---------------------------------------------------------------------------

export const BufferUploadCommandType = {
    START: 1,
    START_AND_STOP: 2,
    STOP: 3,
} as const;
export type BufferUploadCommandType = typeof BufferUploadCommandType[keyof typeof BufferUploadCommandType];

export const BufferUploadStopAction = {
    PAUSE: 1,
    FINALIZE: 2,
} as const;
export type BufferUploadStopAction = typeof BufferUploadStopAction[keyof typeof BufferUploadStopAction];

const BufferUploadCommandTypes = {
    SESSION_ID: 0x01, // uint64
    COMMAND: 0x02,
    START: 0x03, // uint64 timestamp
    STOP: 0x04, // uint64 timestamp
    STOP_ACTION: 0x05,
} as const;

const BufferUploadResponseTypes = {
    CLIP_ID: 0x01, // uint64
} as const;

export interface BufferUploadCommand {
    sessionId: bigint;
    command: BufferUploadCommandType;
    /** Timestamp at which the uploaded clip should begin (present for Start/StartAndStop). */
    start?: bigint;
    /** Timestamp at which the uploaded clip should stop (present for StartAndStop/Stop). */
    stop?: bigint;
    stopAction?: BufferUploadStopAction;
}

export function parseBufferUploadCommand(buffer: Buffer): BufferUploadCommand {
    const m = tlvDecodeMap(buffer);
    const out: BufferUploadCommand = {
        sessionId: readUIntLE(m[BufferUploadCommandTypes.SESSION_ID] ?? Buffer.alloc(0)),
        command: Number(readUIntLE(m[BufferUploadCommandTypes.COMMAND] ?? Buffer.alloc(0))) as BufferUploadCommandType,
    };
    if (m[BufferUploadCommandTypes.START]) out.start = readUIntLE(m[BufferUploadCommandTypes.START]);
    if (m[BufferUploadCommandTypes.STOP]) out.stop = readUIntLE(m[BufferUploadCommandTypes.STOP]);
    if (m[BufferUploadCommandTypes.STOP_ACTION]) out.stopAction = Number(readUIntLE(m[BufferUploadCommandTypes.STOP_ACTION])) as BufferUploadStopAction;
    return out;
}

/** Encode a Buffer Upload Command write (used by tests and diagnostics). */
export function encodeBufferUploadCommand(c: BufferUploadCommand): Buffer {
    const parts: Array<number | Buffer> = [
        BufferUploadCommandTypes.SESSION_ID, u64(c.sessionId),
        BufferUploadCommandTypes.COMMAND, u8(c.command),
    ];
    if (c.start !== undefined) parts.push(BufferUploadCommandTypes.START, u64(c.start));
    if (c.stop !== undefined) parts.push(BufferUploadCommandTypes.STOP, u64(c.stop));
    if (c.stopAction !== undefined) parts.push(BufferUploadCommandTypes.STOP_ACTION, u8(c.stopAction));
    return tlvEncode(...parts);
}

/** Build the Buffer Upload Command write-response: the ID of the clip that was uploaded. */
export function buildBufferUploadResponse(clipId: bigint | number): Buffer {
    return tlvEncode(BufferUploadResponseTypes.CLIP_ID, u64(clipId));
}

export function parseBufferUploadResponse(buffer: Buffer): { clipId: bigint } {
    const m = tlvDecodeMap(buffer);
    return { clipId: readUIntLE(m[BufferUploadResponseTypes.CLIP_ID] ?? Buffer.alloc(0)) };
}

// ---------------------------------------------------------------------------
// §4.10 Buffer Activity Command (0x00008017) — Paired Write
// ---------------------------------------------------------------------------

export const BufferActivity = {
    SHOULD_RECORD: 1,
    SHOULD_NOT_RECORD: 2,
} as const;
export type BufferActivity = typeof BufferActivity[keyof typeof BufferActivity];

const BufferActivityCommandTypes = {
    START: 0x01, // uint64 NTP timestamp
    DURATION: 0x02, // uint64 milliseconds
    ACTIVITY: 0x03,
} as const;

export interface BufferActivityCommand {
    /** NTP timestamp. */
    start: bigint;
    /** Duration in milliseconds. */
    durationMs: bigint;
    activity: BufferActivity;
}

export function parseBufferActivityCommand(buffer: Buffer): BufferActivityCommand {
    const m = tlvDecodeMap(buffer);
    return {
        start: readUIntLE(m[BufferActivityCommandTypes.START] ?? Buffer.alloc(0)),
        durationMs: readUIntLE(m[BufferActivityCommandTypes.DURATION] ?? Buffer.alloc(0)),
        activity: Number(readUIntLE(m[BufferActivityCommandTypes.ACTIVITY] ?? Buffer.alloc(0))) as BufferActivity,
    };
}

export function encodeBufferActivityCommand(c: BufferActivityCommand): Buffer {
    return tlvEncode(
        BufferActivityCommandTypes.START, u64(c.start),
        BufferActivityCommandTypes.DURATION, u64(c.durationMs),
        BufferActivityCommandTypes.ACTIVITY, u8(c.activity),
    );
}

// ---------------------------------------------------------------------------
// §4.11 Buffer Event Command (0x00008014) + Camera Buffer Event TLVs
// ---------------------------------------------------------------------------

export const BufferEventCommandType = {
    QUERY: 1,
    ACKNOWLEDGE: 2,
} as const;
export type BufferEventCommandType = typeof BufferEventCommandType[keyof typeof BufferEventCommandType];

const BufferEventCommandTypes = {
    COMMAND: 0x01,
    SEQUENCE_NUMBER: 0x02, // uint64
    LIMIT: 0x03, // uint64
} as const;

const BufferEventResponseTypes = {
    EVENTS: 0x01, // repeated Camera Buffer Event TLV8
} as const;

export const CameraBufferEventType = {
    CMAF_SESSION_START: 1,
    CMAF_SESSION_STOP: 2,
    MOTION: 3,
    CMAF_ERROR: 4,
} as const;
export type CameraBufferEventType = typeof CameraBufferEventType[keyof typeof CameraBufferEventType];

const CameraBufferEventTypes = {
    SEQUENCE_NUMBER: 0x01, // uint64
    TYPE: 0x02,
    CMAF_SESSION_START: 0x03,
    CMAF_SESSION_STOP: 0x04,
    MOTION: 0x05,
    CMAF_ERROR: 0x06,
} as const;

const CmafSessionEventTypes = { CMAF_SESSION_ID: 0x01 } as const; // uint64
const MotionEventTypes = { ACTIVE: 0x01 } as const; // boolean
const CmafErrorEventTypes = { CMAF_SESSION_ID: 0x01, CMAF_ERROR: 0x02 } as const;

/** §4.11 CMAF Error enumeration. */
export const CmafError = {
    NONE: 0,
    UNKNOWN: 1,
    CANNOT_FIND_HOST: 2,
    CERT_CONNECTION_FAILURE: 3,
    CANNOT_CERTIFY: 4,
    INVALID_STATE: 5,
    REQUIRES_RETRY: 6,
    NO_RESPONSE: 7,
    MAX_SESSION_TIME_EXCEEDED: 8,
    CANCELED: 9,
    MP4_ERROR: 10,
    CONNECTION_FAILED: 11,
    TIMEOUT: 12,
    OUT_OF_RESOURCES: 13,
    INVALID_DATA: 14,
    HTTP_BAD_REQUEST: 15,
    HTTP_INVALID_TOKEN: 16,
    HTTP_CAMERA_ZONE_DISABLED: 17,
    HTTP_MISMATCHED_TOKEN: 18,
    HTTP_NOT_FOUND: 19,
    HTTP_INIT_MISSING: 20,
    HTTP_UNSUPPORTED_MEDIA_TYPE: 21,
    HTTP_BLOCKED: 22,
    HTTP_CERTIFICATE_EXPIRED: 23,
    HTTP_INTERNAL_SERVER_ERROR: 24,
    HTTP_SERVICE_UNAVAILABLE: 25,
    HTTP_CAMERA_ZONE_DOES_NOT_EXIST: 26,
} as const;
export type CmafError = typeof CmafError[keyof typeof CmafError];

/** Best-effort mapping of a CMAF publishing-point HTTP status to the §4.11 CMAF Error enum. */
export function cmafErrorForHttpStatus(status: number): CmafError {
    switch (status) {
        case 400: return CmafError.HTTP_BAD_REQUEST;
        case 401: return CmafError.HTTP_INVALID_TOKEN;
        case 403: return CmafError.HTTP_BLOCKED;
        case 404: return CmafError.HTTP_NOT_FOUND;
        case 412: return CmafError.HTTP_INIT_MISSING;
        case 415: return CmafError.HTTP_UNSUPPORTED_MEDIA_TYPE;
        case 500: return CmafError.HTTP_INTERNAL_SERVER_ERROR;
        case 503: return CmafError.HTTP_SERVICE_UNAVAILABLE;
        default: return status >= 400 ? CmafError.UNKNOWN : CmafError.NONE;
    }
}

export interface BufferEventCommand {
    command: BufferEventCommandType;
    sequenceNumber?: bigint;
    limit?: bigint;
}

export function parseBufferEventCommand(buffer: Buffer): BufferEventCommand {
    const m = tlvDecodeMap(buffer);
    const out: BufferEventCommand = {
        command: Number(readUIntLE(m[BufferEventCommandTypes.COMMAND] ?? Buffer.alloc(0))) as BufferEventCommandType,
    };
    if (m[BufferEventCommandTypes.SEQUENCE_NUMBER]) out.sequenceNumber = readUIntLE(m[BufferEventCommandTypes.SEQUENCE_NUMBER]);
    if (m[BufferEventCommandTypes.LIMIT]) out.limit = readUIntLE(m[BufferEventCommandTypes.LIMIT]);
    return out;
}

export function encodeBufferEventCommand(c: BufferEventCommand): Buffer {
    const parts: Array<number | Buffer> = [BufferEventCommandTypes.COMMAND, u8(c.command)];
    if (c.sequenceNumber !== undefined) parts.push(BufferEventCommandTypes.SEQUENCE_NUMBER, u64(c.sequenceNumber));
    if (c.limit !== undefined) parts.push(BufferEventCommandTypes.LIMIT, u64(c.limit));
    return tlvEncode(...parts);
}

export type CameraBufferEvent =
    | { sequenceNumber: bigint, type: typeof CameraBufferEventType.CMAF_SESSION_START, cmafSessionId: bigint }
    | { sequenceNumber: bigint, type: typeof CameraBufferEventType.CMAF_SESSION_STOP, cmafSessionId: bigint }
    | { sequenceNumber: bigint, type: typeof CameraBufferEventType.MOTION, active: boolean }
    | { sequenceNumber: bigint, type: typeof CameraBufferEventType.CMAF_ERROR, cmafSessionId: bigint, error: CmafError };

export function encodeCameraBufferEvent(e: CameraBufferEvent): Buffer {
    const head: Array<number | Buffer> = [
        CameraBufferEventTypes.SEQUENCE_NUMBER, u64(e.sequenceNumber),
        CameraBufferEventTypes.TYPE, u8(e.type),
    ];
    switch (e.type) {
        case CameraBufferEventType.CMAF_SESSION_START:
            head.push(CameraBufferEventTypes.CMAF_SESSION_START,
                tlvEncode(CmafSessionEventTypes.CMAF_SESSION_ID, u64(e.cmafSessionId)));
            break;
        case CameraBufferEventType.CMAF_SESSION_STOP:
            head.push(CameraBufferEventTypes.CMAF_SESSION_STOP,
                tlvEncode(CmafSessionEventTypes.CMAF_SESSION_ID, u64(e.cmafSessionId)));
            break;
        case CameraBufferEventType.MOTION:
            head.push(CameraBufferEventTypes.MOTION,
                tlvEncode(MotionEventTypes.ACTIVE, u8(e.active ? 1 : 0)));
            break;
        case CameraBufferEventType.CMAF_ERROR:
            head.push(CameraBufferEventTypes.CMAF_ERROR,
                tlvEncode(
                    CmafErrorEventTypes.CMAF_SESSION_ID, u64(e.cmafSessionId),
                    CmafErrorEventTypes.CMAF_ERROR, u8(e.error),
                ));
            break;
    }
    return tlvEncode(...head);
}

/** Build the Buffer Event Command write-response: a delimited list of Camera Buffer Events. */
export function buildBufferEventResponse(events: CameraBufferEvent[]): Buffer {
    return tlvEncode(BufferEventResponseTypes.EVENTS, events.map(encodeCameraBufferEvent));
}

export function parseCameraBufferEvent(buf: Buffer): CameraBufferEvent {
    const m = tlvDecodeMap(buf);
    const sequenceNumber = readUIntLE(m[CameraBufferEventTypes.SEQUENCE_NUMBER] ?? Buffer.alloc(0));
    const type = Number(readUIntLE(m[CameraBufferEventTypes.TYPE] ?? Buffer.alloc(0))) as CameraBufferEventType;
    switch (type) {
        case CameraBufferEventType.CMAF_SESSION_START: {
            const p = tlvDecodeMap(m[CameraBufferEventTypes.CMAF_SESSION_START] ?? Buffer.alloc(0));
            return { sequenceNumber, type, cmafSessionId: readUIntLE(p[CmafSessionEventTypes.CMAF_SESSION_ID] ?? Buffer.alloc(0)) };
        }
        case CameraBufferEventType.CMAF_SESSION_STOP: {
            const p = tlvDecodeMap(m[CameraBufferEventTypes.CMAF_SESSION_STOP] ?? Buffer.alloc(0));
            return { sequenceNumber, type, cmafSessionId: readUIntLE(p[CmafSessionEventTypes.CMAF_SESSION_ID] ?? Buffer.alloc(0)) };
        }
        case CameraBufferEventType.MOTION: {
            const p = tlvDecodeMap(m[CameraBufferEventTypes.MOTION] ?? Buffer.alloc(0));
            return { sequenceNumber, type, active: (p[MotionEventTypes.ACTIVE]?.readUInt8(0) ?? 0) !== 0 };
        }
        default: {
            const p = tlvDecodeMap(m[CameraBufferEventTypes.CMAF_ERROR] ?? Buffer.alloc(0));
            return {
                sequenceNumber,
                type: CameraBufferEventType.CMAF_ERROR,
                cmafSessionId: readUIntLE(p[CmafErrorEventTypes.CMAF_SESSION_ID] ?? Buffer.alloc(0)),
                error: Number(readUIntLE(p[CmafErrorEventTypes.CMAF_ERROR] ?? Buffer.alloc(0))) as CmafError,
            };
        }
    }
}

/** Split + parse the events of a Buffer Event Command response (tests/diagnostics). */
export function parseBufferEventResponse(buffer: Buffer): CameraBufferEvent[] {
    const entries: Buffer[] = [];
    let current: Buffer | undefined;
    let lastType = -1;
    for (const r of tlvDecodeRaw(buffer)) {
        if (r.type === BufferEventResponseTypes.EVENTS) {
            if (lastType === BufferEventResponseTypes.EVENTS && current)
                current = Buffer.concat([current, r.value]); // >255-byte fragment continuation
            else {
                if (current) entries.push(current);
                current = r.value;
            }
        }
        lastType = r.type;
    }
    if (current) entries.push(current);
    return entries.map(parseCameraBufferEvent);
}

// ---------------------------------------------------------------------------
// Camera Event Queue (§4.11 Query/Acknowledge + §4.12 sequence number semantics)
// ---------------------------------------------------------------------------

/**
 * In-memory Camera Event Queue. The accessory appends events (each assigned the next sequence
 * number), notifies the uint32 "Buffer Event Sequence Number" characteristic, and controllers
 * Query events (optionally from a sequence number, up to a limit) then Acknowledge to prune.
 */
export class CameraBufferEventQueue {
    private events: CameraBufferEvent[] = [];
    private nextSequence = 1n;
    private readonly maxQueued: number;
    /** maxQueued bounds the queue so an absent controller cannot leak memory indefinitely. */
    constructor(maxQueued = 256) {
        this.maxQueued = maxQueued;
    }

    /** Highest sequence number assigned so far (0 when none). Exposed via 0x8015 (uint32). */
    get lastSequenceNumber(): bigint {
        return this.nextSequence - 1n;
    }

    /** The §4.12 characteristic is uint32; expose the sequence number wrapped accordingly. */
    get lastSequenceNumberU32(): number {
        return Number(this.lastSequenceNumber & 0xffffffffn);
    }

    append(event: Omit<CameraBufferEvent, 'sequenceNumber'>): CameraBufferEvent {
        const complete = { ...event, sequenceNumber: this.nextSequence++ } as CameraBufferEvent;
        this.events.push(complete);
        if (this.events.length > this.maxQueued)
            this.events.splice(0, this.events.length - this.maxQueued);
        return complete;
    }

    /** Query events with sequence number >= from (default: all), capped at limit. */
    query(from?: bigint, limit?: bigint): CameraBufferEvent[] {
        let out = from === undefined ? this.events.slice() : this.events.filter(e => e.sequenceNumber >= from);
        if (limit !== undefined && limit > 0n && out.length > Number(limit))
            out = out.slice(0, Number(limit));
        return out;
    }

    /** Acknowledge (drop) all events with sequence number <= seq. */
    acknowledge(seq: bigint): void {
        this.events = this.events.filter(e => e.sequenceNumber > seq);
    }

    get size(): number {
        return this.events.length;
    }
}

// ---------------------------------------------------------------------------
// §4.13 Camera Recording Publishing Point (0x00008016) — Paired Read, Paired Write
// ---------------------------------------------------------------------------

const PublishingPointTypes = {
    URL: 0x01, // string; must end in a trailing slash
    SERVER_CA_CERTIFICATES: 0x02, // repeated Certificate TLV8
} as const;

const CertificateTypes = { CERTIFICATE: 0x01 } as const; // DER

export interface RecordingPublishingPoint {
    /** The CMAF publishing_point_url; must end in a trailing slash. */
    url: string;
    /** Server CA certificates, DER format. */
    serverCaCertificates: Buffer[];
}

export function parseRecordingPublishingPoint(buffer: Buffer): RecordingPublishingPoint {
    let url = '';
    const serverCaCertificates: Buffer[] = [];
    // Certificates repeat under type 2 (delimited); parse positionally.
    let currentCert: Buffer | undefined;
    let lastType = -1;
    for (const r of tlvDecodeRaw(buffer)) {
        if (r.type === PublishingPointTypes.URL) {
            url = lastType === PublishingPointTypes.URL
                ? url + r.value.toString('utf8') // >255-byte URL fragment
                : r.value.toString('utf8');
        }
        else if (r.type === PublishingPointTypes.SERVER_CA_CERTIFICATES) {
            if (lastType === PublishingPointTypes.SERVER_CA_CERTIFICATES && currentCert)
                currentCert = Buffer.concat([currentCert, r.value]);
            else {
                if (currentCert) serverCaCertificates.push(unwrapCertificate(currentCert));
                currentCert = r.value;
            }
        }
        lastType = r.type;
    }
    if (currentCert) serverCaCertificates.push(unwrapCertificate(currentCert));
    return { url, serverCaCertificates };
}

function unwrapCertificate(entry: Buffer): Buffer {
    const m = tlvDecodeMap(entry);
    return m[CertificateTypes.CERTIFICATE] ?? entry;
}

export function encodeRecordingPublishingPoint(p: RecordingPublishingPoint): Buffer {
    return tlvEncode(
        PublishingPointTypes.URL, Buffer.from(p.url, 'utf8'),
        PublishingPointTypes.SERVER_CA_CERTIFICATES,
        p.serverCaCertificates.map(cert => tlvEncode(CertificateTypes.CERTIFICATE, cert)),
    );
}

// ---------------------------------------------------------------------------
// §4.7 Camera Key (0x00008051) / §4.8 Camera Key ID (0x00008052)
// ---------------------------------------------------------------------------

const CameraKeyTypes = {
    KEY: 0x01, // data
    KEY_NUMBER: 0x02, // uint64
} as const;

const CameraKeyIDTypes = { KEY_ID: 0x01 } as const; // uint64

export interface CameraKeyWrite {
    key: Buffer;
    keyNumber: bigint;
}

export function parseCameraKey(buffer: Buffer): CameraKeyWrite {
    const m = tlvDecodeMap(buffer);
    return {
        key: m[CameraKeyTypes.KEY] ?? Buffer.alloc(0),
        keyNumber: readUIntLE(m[CameraKeyTypes.KEY_NUMBER] ?? Buffer.alloc(0)),
    };
}

export function encodeCameraKey(k: CameraKeyWrite): Buffer {
    return tlvEncode(
        CameraKeyTypes.KEY, k.key,
        CameraKeyTypes.KEY_NUMBER, u64(k.keyNumber),
    );
}

export function buildCameraKeyID(keyId: bigint | number): Buffer {
    return tlvEncode(CameraKeyIDTypes.KEY_ID, u64(keyId));
}

export function parseCameraKeyID(buffer: Buffer): { keyId: bigint } {
    const m = tlvDecodeMap(buffer);
    return { keyId: readUIntLE(m[CameraKeyIDTypes.KEY_ID] ?? Buffer.alloc(0)) };
}

// ---------------------------------------------------------------------------
// §4.14 Camera Zones (0x00008022) — Zone Data version 2
// ---------------------------------------------------------------------------

export const ZONE_DATA_VERSION = 2;

export const ZoneApplicationMethod = {
    /** Union of the interiors of the zones forms the region of interest. */
    NORMAL: 1,
    /** Intersection of the exteriors of the zones forms the region of interest. */
    INVERTED: 2,
} as const;
export type ZoneApplicationMethod = typeof ZoneApplicationMethod[keyof typeof ZoneApplicationMethod];

const CameraZonesTypes = {
    ZONE_DATA_VERSION: 0x01,
    ZONE_DATA: 0x02,
} as const;

// NOTE: the spec numbers these 1 and 3 (2 unassigned) — both here and in Polygon.
const ZoneDataTypes = {
    METHOD: 0x01,
    POLYGONS: 0x03,
} as const;

const PolygonTypes = {
    IDENTIFIER: 0x01, // data (UUID)
    VERTICES: 0x03, // pairs of uint16 LE (X, Y)
} as const;

export interface ZonePolygon {
    /** UUID identifying this zone. */
    identifier: Buffer;
    /** Vertices of a non-self-intersecting polygon, sensor coordinates, origin top-left. */
    vertices: Array<[number, number]>;
}

export interface CameraZone {
    method: ZoneApplicationMethod;
    polygons: ZonePolygon[];
}

function encodePolygon(p: ZonePolygon): Buffer {
    const vertices = Buffer.alloc(p.vertices.length * 4);
    p.vertices.forEach(([x, y], i) => {
        vertices.writeUInt16LE(x & 0xffff, i * 4);
        vertices.writeUInt16LE(y & 0xffff, i * 4 + 2);
    });
    return tlvEncode(
        PolygonTypes.IDENTIFIER, p.identifier,
        PolygonTypes.VERTICES, vertices,
    );
}

function encodeZone(zone: CameraZone): Buffer {
    return tlvEncode(
        ZoneDataTypes.METHOD, u8(zone.method),
        ZoneDataTypes.POLYGONS, zone.polygons.map(encodePolygon),
    );
}

/** Encode the Camera Zones characteristic value (Zone Data version 2). */
export function encodeCameraZones(zones: CameraZone[]): Buffer {
    const zoneBufs = zones.map(encodeZone);
    const joined: Buffer[] = [];
    zoneBufs.forEach((b, i) => {
        if (i > 0) joined.push(Buffer.from([0x00, 0x00]));
        joined.push(b);
    });
    return tlvEncode(
        CameraZonesTypes.ZONE_DATA_VERSION, u8(ZONE_DATA_VERSION),
        CameraZonesTypes.ZONE_DATA, Buffer.concat(joined),
    );
}

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

function parsePolygon(buf: Buffer): ZonePolygon {
    const m = tlvDecodeMap(buf);
    const raw = m[PolygonTypes.VERTICES] ?? Buffer.alloc(0);
    const vertices: Array<[number, number]> = [];
    for (let i = 0; i + 3 < raw.length; i += 4)
        vertices.push([raw.readUInt16LE(i), raw.readUInt16LE(i + 2)]);
    return { identifier: m[PolygonTypes.IDENTIFIER] ?? Buffer.alloc(0), vertices };
}

/** Parse a Camera Zones write. Returns the zones and the version the controller declared. */
export function parseCameraZones(buffer: Buffer): { version: number, zones: CameraZone[] } {
    const m = tlvDecodeMap(buffer);
    const version = m[CameraZonesTypes.ZONE_DATA_VERSION]?.readUInt8(0) ?? 0;
    const zoneData = m[CameraZonesTypes.ZONE_DATA] ?? Buffer.alloc(0);
    // Zones are TLV structs separated by 0x00 delimiters; a zone starts at each METHOD field.
    const zones: CameraZone[] = [];
    let start = 0;
    const raw = tlvDecodeRaw(zoneData);
    const boundaries: number[] = [];
    let offset = 0;
    let sawFields = false;
    for (const r of raw) {
        if (r.type === ZoneDataTypes.METHOD && sawFields)
            boundaries.push(offset);
        if (r.type !== 0)
            sawFields = true;
        offset += 2 + r.value.length;
    }
    boundaries.push(zoneData.length);
    for (const end of boundaries) {
        const slice = zoneData.subarray(start, end);
        if (slice.length) {
            const zm = tlvDecodeMap(slice);
            zones.push({
                method: (zm[ZoneDataTypes.METHOD]?.readUInt8(0) ?? ZoneApplicationMethod.NORMAL) as ZoneApplicationMethod,
                polygons: splitOnType(slice, ZoneDataTypes.POLYGONS).map(parsePolygon),
            });
        }
        start = end;
    }
    return { version, zones };
}

// ---------------------------------------------------------------------------
// §4.25 Camera Client CSR / §4.26 Camera Client Certificate / §4.27 Certificate Status
// ---------------------------------------------------------------------------

const ClientCSRTypes = {
    NONCE: 0x01, // 32-byte random string (write)
    CSR: 0x01, // DER (response)
    NONCE_SIGNATURE: 0x02, // EC signature over the nonce, max 128 bytes (response)
} as const;

export function parseClientCSRRequest(buffer: Buffer): { nonce: Buffer } {
    const m = tlvDecodeMap(buffer);
    return { nonce: m[ClientCSRTypes.NONCE] ?? Buffer.alloc(0) };
}

export function buildClientCSRResponse(csrDer: Buffer, nonceSignature: Buffer): Buffer {
    return tlvEncode(
        ClientCSRTypes.CSR, csrDer,
        ClientCSRTypes.NONCE_SIGNATURE, nonceSignature,
    );
}

export function parseClientCSRResponse(buffer: Buffer): { csr: Buffer, nonceSignature: Buffer } {
    const m = tlvDecodeMap(buffer);
    return {
        csr: m[ClientCSRTypes.CSR] ?? Buffer.alloc(0),
        nonceSignature: m[ClientCSRTypes.NONCE_SIGNATURE] ?? Buffer.alloc(0),
    };
}

const ClientCertificateTypes = {
    CLIENT_CERTIFICATE: 0x01, // DER
    CA: 0x02, // DER
} as const;

export interface ClientCertificateWrite {
    clientCertificate: Buffer;
    ca: Buffer;
}

export function parseClientCertificate(buffer: Buffer): ClientCertificateWrite {
    const m = tlvDecodeMap(buffer);
    return {
        clientCertificate: m[ClientCertificateTypes.CLIENT_CERTIFICATE] ?? Buffer.alloc(0),
        ca: m[ClientCertificateTypes.CA] ?? Buffer.alloc(0),
    };
}

export function encodeClientCertificate(c: ClientCertificateWrite): Buffer {
    return tlvEncode(
        ClientCertificateTypes.CLIENT_CERTIFICATE, c.clientCertificate,
        ClientCertificateTypes.CA, c.ca,
    );
}

const ClientCertificateStatusTypes = { NEEDS_UPDATE: 0x01 } as const;

export function buildClientCertificateStatus(needsUpdate: boolean): Buffer {
    return tlvEncode(ClientCertificateStatusTypes.NEEDS_UPDATE, u8(needsUpdate ? 1 : 0));
}

// ---------------------------------------------------------------------------
// §4.6 Contributing Sensors (0x00008086)
// ---------------------------------------------------------------------------

const ContributingSensorsTypes = { SENSOR_LIST: 0x01 } as const;
const ContributingSensorTypes = { SENSOR_UUID: 0x01 } as const;

export function encodeContributingSensors(sensorUuids: Buffer[]): Buffer {
    return tlvEncode(
        ContributingSensorsTypes.SENSOR_LIST,
        sensorUuids.map(uuid => tlvEncode(ContributingSensorTypes.SENSOR_UUID, uuid)),
    );
}

// re-export for consumers that only import this module
export { u32 as encodeU32 };
