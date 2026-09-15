/**
 * camera-multitier.ts  (Scrypted HomeKit plugin — iOS/tvOS 27 4K streaming)
 *
 * Implements the "Camera Multi-Tier RTP Stream Management" service (UUID 0x00008031) that iOS/tvOS
 * 27 uses to negotiate 4K / HEVC live streams, per §3.6 of the HKSV Open Source Compatibility
 * Guide (rev. 2026-06-03). Rather than reinventing the media pipeline, this adds the new HAP
 * characteristics to the camera accessory and translates the new negotiation (Setup Endpoints +
 * RTP Streaming Control) into calls on the plugin's EXISTING CameraStreamingDelegate
 * (prepareStream / handleStreamRequest) — so SRTP, UDP, ffmpeg and the rebroadcast adaptive
 * bitrate path are all reused unchanged.
 *
 * §3.6 requirements honored here:
 *   - all eight required characteristics (Streaming Enabled, Status Active, Supported
 *     Video/Audio Stream Tiers, Supported RTP Configuration, Setup Endpoints, RTP Streaming
 *     Control, Sensor UUID);
 *   - Supported RTP Configuration = AES_CM_128_HMAC_SHA1_80;
 *   - Status Active is false whenever this service's Streaming Enabled is false, or the Camera
 *     Global Operating Mode gate (HomeKit Camera Active / Streaming Enabled / Manually Disabled,
 *     see camera-hksv27.ts) reports inactive — and stream setup/start is rejected while false;
 *   - RTP Streaming Control write-responses carry the §4.16 status codes (Unknown Session
 *     Identifier / No Such Stream / Busy / Error).
 *
 * Wire formats live in (and are unit-tested by) hksv-stream-tiers.ts + hksv-multitier-protocol.ts.
 * Points marked "VALIDATE" need confirmation against a real iOS/tvOS 27 device.
 */

import { Accessory, AudioStreamingCodecType, CameraStreamingDelegate, Characteristic, Formats, H264Level, H264Profile, Perms, PrepareStreamRequest, PrepareStreamResponse, ReconfigureStreamRequest, Service, StartStreamRequest, StopStreamRequest, StreamRequestTypes, VideoCodecType } from '../../hap';
import {
    buildHksvOpusAudioTier,
    buildHksvVideoTiers,
    buildSensorVideoTiers,
    encodeSupportedAudioStreamTiers,
    encodeSupportedVideoStreamTiers,
    SensorClass,
    TierAudioCodec,
    TierVideoCodec,
    VideoStreamTier,
} from './hksv-stream-tiers';
import {
    buildRTPStreamingControlResponse,
    buildSetupEndpointsErrorResponse,
    buildSetupEndpointsResponse,
    CameraMultiTierRTPStreamManagementUUID,
    parseRTPStreamingControl,
    parseSetupEndpoints,
    RTPStreamingCommand,
    RTPStreamingControlParseError,
    RTPStreamingControlUUID,
    RTPStreamingStatus,
    SensorUUIDCharacteristicUUID,
    SetupEndpointsStatus,
    SetupEndpointsUUID,
    SRTPCryptoSuite,
    StatusActiveUUID,
    StreamingEnabledUUID,
    SupportedAudioStreamTiersUUID,
    SupportedRTPConfigurationUUID,
    SupportedVideoStreamTiersUUID,
} from './hksv-multitier-protocol';

const VIDEO_PAYLOAD_TYPE = 99;
const AUDIO_PAYLOAD_TYPE = 110;

const STREAMING_ENABLED_KEY = 'hksv27-rtp-streaming-enabled';

/** Classify a sensor from its largest available stream resolution. */
export function pickSensorClass(width: number, height: number): SensorClass {
    const high = buildSensorVideoTiers(width, height)[0];
    if (high.averageBitrateKbps === 4500) return '4k';
    if (high.averageBitrateKbps === 2800) return '2k';
    return '1080p';
}

function dataCharacteristic(uuid: string, name: string, perms: Perms[], format: Formats = Formats.TLV8): Characteristic {
    return new Characteristic(name, uuid, { format, perms });
}

/**
 * Diagnostic read handler: serves the characteristic's value and logs controller reads (the
 * first few, then every 10th), so on-device logs show definitively whether an iOS/tvOS 27
 * controller is discovering the new services — reads are otherwise invisible in the console.
 */
export function logCharacteristicReads(char: Characteristic, console: Console, label: string, value: () => any): Characteristic {
    let count = 0;
    char.on('get', (cb: any) => {
        count++;
        recordBisectSignal(bisectReadTallyStorage, `read: ${label}`);
        try {
            const result = value();
            if (count <= 3 || count % 10 === 0)
                console.log(`HomeKit iOS 27: controller read ${label} (#${count})${typeof result === 'boolean' ? ` = ${result}` : ''}`);
            cb(null, result);
        }
        catch (e) {
            console.error(`HomeKit iOS 27: serving ${label} failed`, e);
            cb(e);
        }
    });
    // Notification subscriptions reveal which state the controller intends to track.
    char.on('subscribe', () => console.log(`HomeKit iOS 27: controller subscribed to ${label}`));
    return char;
}

/** Minimal persistence contract (matches both DOM Storage and Scrypted mixin storage). */
export interface MinimalStorage {
    getItem(key: string): string | null | undefined;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}

/**
 * Bisect signal tally: counts of the decisive controller actions observed since the current
 * bisect run started, surfaced in the camera's HomeKit settings so a field run can be
 * reported without copying raw console logs. Keyed OUTSIDE the `hksv27-` prefix so the
 * unpair factory reset (which fires mid-run, at the remove step) does not erase it; the
 * bisect runner clears it when a new run is selected.
 */
export const BISECT_SIGNALS_KEY = 'hksv27bisect-signals';

/** Once set, every logCharacteristicReads read is tallied as `read: <label>` — comparing
 *  panel deltas around a Home-app action reveals which characteristics the controller
 *  consults for it (e.g. whether a failing recording-mode save re-validates the surface
 *  locally, or never touches the accessory and failed cloud-side). */
let bisectReadTallyStorage: MinimalStorage | undefined;
export function setBisectReadTallyStorage(storage: MinimalStorage | undefined): void {
    bisectReadTallyStorage = storage;
}

export function recordBisectSignal(storage: MinimalStorage | undefined, signal: string): void {
    if (!storage)
        return;
    try {
        const parsed = JSON.parse(storage.getItem(BISECT_SIGNALS_KEY) || '{}');
        parsed[signal] = (parsed[signal] || 0) + 1;
        storage.setItem(BISECT_SIGNALS_KEY, JSON.stringify(parsed));
    }
    catch (e) {
    }
}

/**
 * The §3.6 gate: Status Active must be false when HomeKit Camera Active is false, Streaming
 * Enabled on the Camera Global Operating Mode service is false, or Manually Disabled is true.
 * camera-hksv27.ts supplies this from its Camera Global Operating Mode service; without one the
 * gate defaults to active.
 */
export interface StreamingGate {
    isActive(): boolean;
    onChanged(listener: () => void): void;
}

interface MultiTierOptions {
    videoTiers?: VideoStreamTier[];
    sensorClass: SensorClass;
    /** 4K sensor that can also serve a simultaneous 2K stream (adds the optional "Highest" tier). */
    simultaneous2k?: boolean;
    frameRate?: number;
    /** 16-byte sensor UUID shared with Camera Capabilities / motion services. */
    sensorUuid?: Buffer;
    gate?: StreamingGate;
    storage?: MinimalStorage;
    /** Attach the HAP service to the accessory (default true). False builds only the tier
     *  tables (used when the service is bisected away diagnostically). */
    attach?: boolean;
}

interface TierSession {
    prepared?: PrepareStreamResponse;
    addressVersion: 'ipv4' | 'ipv6';
    started: boolean;
    starting?: boolean;
    setupTimer?: ReturnType<typeof setTimeout>;
    onClose?: () => void;
    connection?: any;
}

export class MultiTierStreamManagement {
    readonly service: Service;
    /** The HEVC tier set; also the canonical encoding list for Camera Capabilities. */
    readonly videoTiers: VideoStreamTier[];
    /** The sensor UUID advertised by this service (shared across the accessory). */
    readonly sensorUuid: Buffer;
    /** Base64 tier advertisements, shared with the WebRTC service (§4.23/§4.24 use the same TLVs). */
    readonly supportedVideoTiersValue: string;
    readonly supportedAudioTiersValue: string;
    private readonly audioTierId = 1;
    private readonly accessory: Accessory;
    private readonly delegate: CameraStreamingDelegate;
    private readonly console: Console;
    private readonly gate?: StreamingGate;
    private readonly storage?: MinimalStorage;
    private locallyEnabled = true;
    private streamingControlResponse = '';
    private lastSetupEndpointsResponse = '';
    // Per-HAP-connection Setup Endpoints response, so concurrent controllers don't clobber
    // each other's read-back (the write-response path is primary; this covers plain reads).
    private readonly setupResponses = new WeakMap<object, string>();
    // sessionHex -> transport/stream state, used to validate §4.16 commands.
    private readonly sessions = new Map<string, TierSession>();
    private statusActiveChar: Characteristic;
    private streamingEnabledChar: Characteristic;

    constructor(
        accessory: Accessory,
        delegate: CameraStreamingDelegate,
        console: Console,
        opts: MultiTierOptions,
    ) {
        this.accessory = accessory;
        this.delegate = delegate;
        this.console = console;
        this.gate = opts.gate;
        this.storage = opts.storage;
        this.locallyEnabled = this.storage?.getItem(STREAMING_ENABLED_KEY) !== 'false';

        this.videoTiers = opts.videoTiers ?? buildHksvVideoTiers(opts.sensorClass, {
            simultaneous2k: opts.simultaneous2k,
            frameRate: opts.frameRate,
        });
        // §4.3 describes a single codec per characteristic, with repeating tiers.
        // Legacy H.264 remains available through CameraController's separate services.
        const supportedVideo = encodeSupportedVideoStreamTiers([
            { codec: TierVideoCodec.H265, payloadType: VIDEO_PAYLOAD_TYPE, tiers: this.videoTiers },
        ]).toString('base64');

        const supportedAudio = encodeSupportedAudioStreamTiers([
            { codec: TierAudioCodec.OPUS, payloadType: AUDIO_PAYLOAD_TYPE, tiers: [buildHksvOpusAudioTier(this.audioTierId)] },
        ]).toString('base64');
        this.supportedVideoTiersValue = supportedVideo;
        this.supportedAudioTiersValue = supportedAudio;

        this.service = new Service('HomeKit 4K Streaming', CameraMultiTierRTPStreamManagementUUID, 'multitier');

        // --- Supported tiers (Paired Read, Notify) ---
        const videoTiersChar = dataCharacteristic(SupportedVideoStreamTiersUUID, 'Supported Video Stream Tiers', [Perms.PAIRED_READ, Perms.NOTIFY]);
        videoTiersChar.updateValue(supportedVideo);
        logCharacteristicReads(videoTiersChar, console, 'Supported Video Stream Tiers', () => supportedVideo);
        this.service.addCharacteristic(videoTiersChar);

        const audioTiersChar = dataCharacteristic(SupportedAudioStreamTiersUUID, 'Supported Audio Stream Tiers', [Perms.PAIRED_READ, Perms.NOTIFY]);
        audioTiersChar.updateValue(supportedAudio);
        logCharacteristicReads(audioTiersChar, console, 'Supported Audio Stream Tiers', () => supportedAudio);
        this.service.addCharacteristic(audioTiersChar);

        // --- Supported RTP Configuration: AES_CM_128_HMAC_SHA1_80 (required by §3.6) ---
        const supportedRtp = encodeSupportedRTPConfiguration();
        const rtpConfigChar = dataCharacteristic(SupportedRTPConfigurationUUID, 'Supported RTP Configuration', [Perms.PAIRED_READ, Perms.NOTIFY]);
        rtpConfigChar.updateValue(supportedRtp);
        logCharacteristicReads(rtpConfigChar, console, 'Supported RTP Configuration (multi-tier)', () => supportedRtp);
        this.service.addCharacteristic(rtpConfigChar);

        // --- Status Active (§3.6 gate) / Streaming Enabled ---
        this.statusActiveChar = new Characteristic('Status Active', StatusActiveUUID, { format: Formats.BOOL, perms: [Perms.PAIRED_READ, Perms.NOTIFY] });
        this.statusActiveChar.updateValue(this.isActive());
        logCharacteristicReads(this.statusActiveChar, console, 'Status Active (multi-tier)', () => this.isActive());
        this.service.addCharacteristic(this.statusActiveChar);

        this.streamingEnabledChar = new Characteristic('Streaming Enabled', StreamingEnabledUUID, {
            format: Formats.BOOL,
            perms: [Perms.PAIRED_READ, Perms.PAIRED_WRITE, Perms.NOTIFY, Perms.TIMED_WRITE],
        });
        this.streamingEnabledChar.updateValue(this.streamingEnabled);
        this.streamingEnabledChar.on('set', (value: any, cb: any) => {
            recordBisectSignal(this.storage, `Streaming Enabled (multi-tier) = ${!!value}`);
            this.storage?.setItem(STREAMING_ENABLED_KEY, (!!value).toString());
            this.locallyEnabled = !!value;
            cb(null);
            this.updateStatusActive();
        });
        this.service.addCharacteristic(this.streamingEnabledChar);
        this.gate?.onChanged(() => this.updateStatusActive());

        // --- Sensor UUID (stable per accessory) ---
        this.sensorUuid = opts.sensorUuid ?? deriveSensorUuid(accessory);
        const sensorUuid = dataCharacteristic(SensorUUIDCharacteristicUUID, 'Sensor UUID', [Perms.PAIRED_READ], Formats.DATA);
        const sensorUuidValue = this.sensorUuid.toString('base64');
        sensorUuid.updateValue(sensorUuidValue);
        logCharacteristicReads(sensorUuid, console, 'Sensor UUID (multi-tier)', () => sensorUuidValue);
        this.service.addCharacteristic(sensorUuid);

        // --- Setup Endpoints (reused 0x118): establishes SRTP transport for a session ---
        const setupEndpoints = dataCharacteristic(SetupEndpointsUUID, 'Setup Endpoints', [Perms.PAIRED_READ, Perms.PAIRED_WRITE, Perms.WRITE_RESPONSE]);
        setupEndpoints
            .on('get', (cb: any, _ctx: any, connection: any) =>
                cb(null, (connection && this.setupResponses.get(connection)) ?? this.lastSetupEndpointsResponse))
            .on('set', (value: any, cb: any, _ctx: any, connection: any) => {
                recordBisectSignal(this.storage, 'Multi-Tier Setup Endpoints written');
                this.handleSetupEndpoints(value, cb, connection);
            });
        this.service.addCharacteristic(setupEndpoints);

        // --- RTP Streaming Control (0x8045): start/stop a tier within a session ---
        const streamingControl = dataCharacteristic(RTPStreamingControlUUID, 'RTP Streaming Control', [Perms.PAIRED_READ, Perms.PAIRED_WRITE, Perms.WRITE_RESPONSE]);
        streamingControl
            .on('get', (cb: any) => cb(null, this.streamingControlResponse))
            .on('set', (value: any, cb: any) => {
                recordBisectSignal(this.storage, 'Multi-Tier RTP Streaming Control written');
                this.handleStreamingControl(value, cb);
            });
        this.service.addCharacteristic(streamingControl);

        if (opts.attach !== false)
            accessory.addService(this.service);
    }

    private get streamingEnabled(): boolean {
        // default enabled; unset storage (or no storage) reads as enabled.
        return this.locallyEnabled;
    }

    /** §3.6: active iff this service's Streaming Enabled is true AND the global gate allows it. */
    isActive(): boolean {
        return this.streamingEnabled && (this.gate?.isActive() ?? true);
    }

    updateStatusActive(): void {
        this.statusActiveChar.updateValue(this.isActive());
        if (!this.isActive()) this.closeAllSessions();
    }

    handleFactoryReset(): void {
        this.closeAllSessions();
        this.storage?.removeItem(STREAMING_ENABLED_KEY);
        this.locallyEnabled = true;
        this.streamingEnabledChar.updateValue(true);
        this.updateStatusActive();
    }

    closeAllSessions(): void {
        for (const id of [...this.sessions.keys()]) this.closeSession(id);
    }

    private closeSession(id: string): void {
        const session = this.sessions.get(id);
        if (!session) return;
        this.sessions.delete(id);
        clearTimeout(session.setupTimer);
        if (session.onClose) session.connection?.removeListener?.('closed', session.onClose);
        try {
            Promise.resolve(this.delegate.handleStreamRequest({ sessionID: id, type: StreamRequestTypes.STOP }, () => undefined))
                .catch(e => this.console.warn('Stream cleanup failed', e));
        } catch (e) { this.console.warn('Stream cleanup failed', e); }
    }

    private findVideoTier(identifier: number | undefined): { tier: VideoStreamTier, codec: TierVideoCodec } | undefined {
        if (identifier === undefined)
            return undefined;
        const hevc = this.videoTiers.find(t => t.identifier === identifier);
        if (hevc)
            return { tier: hevc, codec: TierVideoCodec.H265 };
        return undefined;
    }

    private async handleSetupEndpoints(value: string, callback: any, connection: any): Promise<void> {
        let sessionId: Buffer | undefined;
        try {
            const req = parseSetupEndpoints(Buffer.from(value, 'base64'));
            sessionId = req.sessionId;
            const sessionHex = req.sessionId.toString('hex');
            this.console.log(`HomeKit iOS 27: Setup Endpoints write (multi-tier) from ${req.controllerAddress}, session ${sessionHex.slice(0, 8)}…`);

            // §3.6: reject stream setup while Status Active is false.
            if (!this.isActive()) {
                const rejected = buildSetupEndpointsErrorResponse(req.sessionId, SetupEndpointsStatus.ERROR).toString('base64');
                this.rememberSetupResponse(connection, rejected);
                callback(null, rejected);
                return;
            }

            if (this.sessions.has(sessionHex) || this.sessions.size >= 8) {
                const busy = buildSetupEndpointsErrorResponse(req.sessionId, SetupEndpointsStatus.BUSY).toString('base64');
                this.rememberSetupResponse(connection, busy);
                callback(null, busy);
                return;
            }
            const pending: TierSession = { addressVersion: req.addressVersion, started: false, connection };
            pending.setupTimer = setTimeout(() => this.closeSession(sessionHex), 30000);
            pending.onClose = () => this.closeSession(sessionHex);
            connection?.once?.('closed', pending.onClose);
            this.sessions.set(sessionHex, pending);

            const prepareRequest: PrepareStreamRequest = {
                sessionID: sessionHex,
                sourceAddress: connection?.localAddress,
                targetAddress: req.controllerAddress,
                addressVersion: req.addressVersion,
                video: {
                    port: req.videoPort,
                    srtpCryptoSuite: req.video.cryptoSuite,
                    srtp_key: req.video.masterKey,
                    srtp_salt: req.video.masterSalt,
                },
                audio: {
                    port: req.audioPort,
                    srtpCryptoSuite: req.audio.cryptoSuite,
                    srtp_key: req.audio.masterKey,
                    srtp_salt: req.audio.masterSalt,
                },
            };

            const response = await new Promise<PrepareStreamResponse>((resolve, reject) => {
                Promise.resolve(this.delegate.prepareStream(prepareRequest, (error?: Error, res?: PrepareStreamResponse) =>
                    error || !res ? reject(error || new Error('prepareStream returned no response')) : resolve(res))).catch(reject);
            });

            if (this.sessions.get(sessionHex) !== pending || !this.isActive()) {
                this.delegate.handleStreamRequest({ sessionID: sessionHex, type: StreamRequestTypes.STOP }, () => undefined);
                throw new Error('Session was closed during endpoint setup');
            }
            pending.prepared = response;

            const accessoryAddress = response.addressOverride || connection?.localAddress;
            const v: any = response.video;
            const a: any = response.audio || {};
            const encoded = buildSetupEndpointsResponse({
                sessionId: req.sessionId,
                status: SetupEndpointsStatus.SUCCESS,
                addressVersion: req.addressVersion,
                accessoryAddress,
                videoPort: v.port,
                audioPort: a.port ?? v.port,
                // The plugin echoes the controller's SRTP keys back.
                video: { cryptoSuite: req.video.cryptoSuite, masterKey: v.srtp_key ?? req.video.masterKey, masterSalt: v.srtp_salt ?? req.video.masterSalt },
                audio: { cryptoSuite: req.audio.cryptoSuite, masterKey: a.srtp_key ?? req.audio.masterKey, masterSalt: a.srtp_salt ?? req.audio.masterSalt },
                videoSSRC: v.ssrc >>> 0,
                audioSSRC: (a.ssrc ?? 0) >>> 0,
            }).toString('base64');

            this.rememberSetupResponse(connection, encoded);
            // Setup Endpoints is a write-response characteristic; return the response and cache it for GET.
            callback(null, encoded);
        }
        catch (e) {
            this.console.error('multi-tier setup endpoints failed', e);
            if (sessionId) {
                this.closeSession(sessionId.toString('hex'));
                const errored = buildSetupEndpointsErrorResponse(sessionId, SetupEndpointsStatus.ERROR).toString('base64');
                this.rememberSetupResponse(connection, errored);
                callback(null, errored);
            }
            else {
                callback(e);
            }
        }
    }

    private rememberSetupResponse(connection: any, encoded: string): void {
        this.lastSetupEndpointsResponse = encoded;
        if (connection && typeof connection === 'object')
            this.setupResponses.set(connection, encoded);
    }

    private handleStreamingControl(value: string, callback: any): void {
        try {
            const control = parseRTPStreamingControl(Buffer.from(value, 'base64'));
            const sessionHex = control.sessionId.toString('hex');
            const session = this.sessions.get(sessionHex);
            this.console.log(`HomeKit iOS 27: RTP Streaming Control write, command ${control.command}`
                + ` (video tier ${control.videoTier ?? '-'}), session ${sessionHex.slice(0, 8)}…`);

            const respond = (status: RTPStreamingStatus) => {
                this.streamingControlResponse = buildRTPStreamingControlResponse(control.sessionId, status).toString('base64');
                callback(null, this.streamingControlResponse);
            };

            // §4.16: the Session Identifier must match a UUID written to Setup Endpoints.
            if (!session) {
                respond(RTPStreamingStatus.UNKNOWN_SESSION_IDENTIFIER);
                return;
            }

            if (control.command === RTPStreamingCommand.END) {
                // §4.16: "No Such Stream indicates that an End command was attempted for a
                // stream that is not currently started."
                if (!session.started && !session.starting) {
                    this.closeSession(sessionHex);
                    respond(RTPStreamingStatus.NO_SUCH_STREAM);
                    return;
                }
                respond(RTPStreamingStatus.SUCCESS);
                this.closeSession(sessionHex);
                return;
            }

            if (control.command !== RTPStreamingCommand.START) {
                respond(RTPStreamingStatus.ERROR);
                return;
            }

            // §3.6: "The accessory must reject any request to start a stream if Status Active
            // is set to false."
            if (!this.isActive()) {
                this.closeSession(sessionHex);
                respond(RTPStreamingStatus.ERROR);
                return;
            }

            // §4.16: the Video Tier must match some advertised tier identifier.
            const selected = this.findVideoTier(control.videoTier);
            if (!selected) {
                if (!session.started && !session.starting) this.closeSession(sessionHex);
                respond(RTPStreamingStatus.ERROR);
                return;
            }
            const { tier, codec } = selected;
            if (control.audioTier !== undefined && control.audioTier !== this.audioTierId) {
                if (!session.started && !session.starting) this.closeSession(sessionHex);
                respond(RTPStreamingStatus.ERROR);
                return;
            }

            if (session.started || session.starting || !session.prepared) {
                // START is not a bitrate-only reconfigure command. A new stream needs a
                // fresh endpoint session so codec, resolution, timing and SSRC stay coherent.
                respond(RTPStreamingStatus.BUSY);
                return;
            }
            if (control.videoSSRC === undefined || control.audioSSRC === undefined || control.audioTier === undefined) {
                respond(RTPStreamingStatus.ERROR);
                return;
            }
            session.starting = true;
            clearTimeout(session.setupTimer);

            // Synthesize a StartStreamRequest for the delegate from the selected tier.
            const start: StartStreamRequest = {
                sessionID: sessionHex,
                type: StreamRequestTypes.START,
                hksv27: true,
                onStreamClosed: () => {
                    if (this.sessions.get(sessionHex) === session) this.closeSession(sessionHex);
                },
                video: {
                    // The delegate keys the rebroadcast codec off this (h265 for HEVC tiers).
                    codec: codec === TierVideoCodec.H265 ? VideoCodecType.H265 : VideoCodecType.H264,
                    profile: H264Profile.HIGH,   // informational for H.264; unused for HEVC
                    level: H264Level.LEVEL4_0,
                    packetizationMode: 0 as any,
                    width: tier.width,
                    height: tier.height,
                    fps: tier.frameRate,
                    pt: VIDEO_PAYLOAD_TYPE,
                    ssrc: (control.videoSSRC ?? 0) >>> 0,   // VALIDATE: controller-assigned SSRC
                    max_bit_rate: tier.averageBitrateKbps,  // kbps; delegate multiplies by 1000
                    rtcp_interval: 0.5,
                    mtu: 1200,
                },
                audio: {
                    codec: AudioStreamingCodecType.OPUS,
                    channel: 1,
                    bit_rate: 24,
                    sample_rate: 24 as any,
                    rtpClockRate: 48000,
                    packet_time: 20,
                    pt: AUDIO_PAYLOAD_TYPE,
                    ssrc: (control.audioSSRC ?? 0) >>> 0,
                    max_bit_rate: 24,
                    rtcp_interval: 0.5,
                    comfort_pt: 13,
                    comfortNoiseEnabled: false,
                },
            } as StartStreamRequest;
            this.console.log(`HomeKit multi-tier START: ${tier.width}x${tier.height}@${tier.frameRate} ${codec === TierVideoCodec.H265 ? 'HEVC' : 'H.264'} (tier ${tier.identifier})`);
            const timeout = setTimeout(() => {
                this.closeSession(sessionHex);
                finish(new Error('Media startup timed out'));
            }, 7000); // Respond before HAP's write timeout, including source/encoder startup.
            let finished = false;
            const finish = (error?: Error) => {
                if (finished) return;
                finished = true;
                clearTimeout(timeout);
                session.starting = false;
                if (error || this.sessions.get(sessionHex) !== session || !this.isActive()) {
                    if (error) this.console.error('multi-tier stream start error', error);
                    this.closeSession(sessionHex);
                    respond(RTPStreamingStatus.ERROR);
                    return;
                }
                session.started = true;
                respond(RTPStreamingStatus.SUCCESS);
            };
            try { Promise.resolve(this.delegate.handleStreamRequest(start, finish)).catch(finish); }
            catch (e) { finish(e instanceof Error ? e : new Error(String(e))); }
        }
        catch (e) {
            this.console.error('multi-tier streaming control failed', e);
            if (e instanceof RTPStreamingControlParseError && e.sessionId) {
                const id = e.sessionId.toString('hex');
                const session = this.sessions.get(id);
                if (session && !session.started && !session.starting) this.closeSession(id);
                this.streamingControlResponse = buildRTPStreamingControlResponse(e.sessionId, RTPStreamingStatus.ERROR).toString('base64');
                callback(null, this.streamingControlResponse);
            }
            else callback(-70410); // HAP INVALID_VALUE_IN_REQUEST, not a generic unreachable error.
        }
    }
}

/** SupportedRTPConfiguration TLV: type 0x02 (SRTP crypto suite) = AES_CM_128_HMAC_SHA1_80. */
function encodeSupportedRTPConfiguration(): string {
    return Buffer.from([0x02, 0x01, SRTPCryptoSuite.AES_CM_128_HMAC_SHA1_80]).toString('base64');
}

/** Derive a stable 16-byte sensor UUID from the accessory's UUID. */
export function deriveSensorUuid(accessory: Accessory): Buffer {
    const hex = (accessory.UUID || '').replace(/[^0-9a-f]/gi, '').padEnd(32, '0').slice(0, 32);
    return Buffer.from(hex, 'hex');
}
