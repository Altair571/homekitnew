/**
 * camera-hksv27.ts  (Scrypted HomeKit plugin — iOS/tvOS 27 4K + HKSV/CMAF accessory surface)
 *
 * Assembles the complete new-generation camera surface from the HKSV Open Source Compatibility
 * Guide (rev. 2026-06-03) on a Scrypted camera accessory:
 *
 *   §3.1  Camera Capabilities (0x8010)                 — REQUIRED gate: its presence (with
 *         Version "17.99" + the Camera Capabilities TLV) is what tells an iOS/tvOS 27
 *         controller this camera supports the new functionality at all.
 *   §3.2  Camera Global Operating Mode (0x8032)        — HomeKit Camera Active, Streaming
 *         Enabled, Camera Operating Mode Indicator; feeds the §3.6 Status Active gate.
 *   §3.4  Camera Motion Zones (0x8021)                 — activity zone storage (version 2).
 *   §3.5  Camera Buffer Management (0x8000)            — event queue, publishing point,
 *         upload/activity commands; drives the CMAF ingest client (cmaf-ingest.ts).
 *   §3.6  Camera Multi-Tier RTP Stream Management       — via MultiTierStreamManagement
 *         (camera-multitier.ts), gated by the Global Operating Mode state.
 *   §3.9  Camera Key Management (0x8050)               — camera key storage + key id.
 *   §3.10 Camera Client Certificate Management (0x8080) — EC P-256 CSR + certificate store
 *         for CMAF mutual TLS (hksv-csr.ts).
 *   §3.3  Motion Sensor additions                       — Motion Enabled + Contributing
 *         Sensors on the existing HAP motion service, and Motion events into the §4.11
 *         Camera Event Queue.
 *
 * Not implemented: Camera WebRTC Stream Management (0x8033) — the parallel WebRTC path; the
 * RTP path suffices for LAN live view. See docs/implementation-plan.md.
 *
 * All wire formats live in (and are unit-tested by) the hksv-*.ts modules.
 */

import { X509Certificate } from 'crypto';
import { Access, Accessory, CameraStreamingDelegate, Characteristic, DataStreamConnectionEvent, DataStreamServerEvent, Formats, MessageType, Perms, Service } from '../../hap';
import type { RecordingManagement, SnapshotRequest } from '../../hap';
import { HdsSnapshotTransport } from './camera-hds-snapshot';
import {
    CAMERA_CAPABILITIES_VERSION,
    CameraCapabilitiesCharacteristicUUID,
    CameraCapabilitiesServiceUUID,
    CameraGlobalOperatingModeServiceUUID,
    encodeCameraCapabilities,
    buildPrimarySensorConfiguration,
} from './hksv-camera-capabilities';
import { StreamingEnabledUUID } from './hksv-multitier-protocol';
import {
    BufferActivity,
    BufferActivityCommandUUID,
    BufferEventCommandType,
    BufferEventCommandUUID,
    BufferEventSequenceNumberUUID,
    BufferUploadCommandType,
    BufferUploadStopAction,
    BufferUploadCommandUUID,
    buildBufferEventResponse,
    buildBufferUploadResponse,
    buildCameraKeyID,
    buildClientCertificateStatus,
    buildClientCSRResponse,
    CameraBufferEventQueue,
    CameraBufferEventType,
    CameraBufferManagementServiceUUID,
    CameraClientCertificateManagementServiceUUID,
    CameraClientCertificateStatusUUID,
    CameraClientCertificateUUID,
    CameraClientCSRUUID,
    CameraKeyManagementServiceUUID,
    CameraKeyIDUUID,
    CameraKeyUUID,
    CameraMotionZonesServiceUUID,
    CameraRecordingPublishingPointUUID,
    CameraZonesUUID,
    CmafError,
    ContributingSensorsUUID,
    encodeCameraZones,
    encodeClientCertificate,
    encodeContributingSensors,
    MotionEnabledUUID,
    parseBufferActivityCommand,
    parseBufferEventCommand,
    parseBufferUploadCommand,
    parseCameraKey,
    parseCameraZones,
    parseClientCertificate,
    parseClientCSRRequest,
    parseRecordingPublishingPoint,
    RecordingPublishingPoint,
} from './hksv-recording-protocol';
import { buildClientCSR, createClientIdentity, loadClientIdentity, signNonce } from './hksv-csr';
import { HksvRecordingBuffer, RecordingWindow } from './hksv-recording-buffer';
import { RecordingSourceItem } from './camera-cmaf-source';
import { CmafIngestSession } from './cmaf-ingest';
import { deriveSensorUuid, logCharacteristicReads, MinimalStorage, MultiTierStreamManagement, recordBisectSignal, setBisectReadTallyStorage, StreamingGate } from './camera-multitier';
import { WebRTCStreamManagement } from './camera-webrtc';
import { buildSensorVideoTiers, SensorClass, VideoStreamTier } from './hksv-stream-tiers';
import type { HksvMediaSelection } from './hksv-media';

const KEYS = {
    homekitCameraActive: 'hksv27-homekit-camera-active',
    globalStreamingEnabled: 'hksv27-global-streaming-enabled',
    operatingModeIndicator: 'hksv27-operating-mode-indicator',
    motionEnabled: 'hksv27-motion-enabled',
    zonesActive: 'hksv27-zones-active',
    zones: 'hksv27-zones',
    publishingPoint: 'hksv27-publishing-point',
    clientKeyPem: 'hksv27-client-key-pem',
    clientCertificate: 'hksv27-client-certificate',
    clientCa: 'hksv27-client-ca',
    cameraKey: 'hksv27-camera-key',
    cameraKeyNumber: 'hksv27-camera-key-number',
    clipCounter: 'hksv27-clip-counter',
} as const;

/** Milliseconds before notAfter at which the client certificate is reported as needing update. */
const CERTIFICATE_RENEWAL_WINDOW = 30 * 24 * 60 * 60 * 1000;

export interface Hksv27Options {
    takeSnapshot?: (request: SnapshotRequest) => Promise<Buffer>;
    sensorClass: SensorClass;
    /** Native sensor dimensions (largest available stream). */
    sensorWidth: number;
    sensorHeight: number;
    frameRate?: number;
    simultaneous2k?: boolean;
    recordingSource?: (tier: VideoStreamTier, signal: AbortSignal) => AsyncIterable<RecordingSourceItem>;
    isRecordingActive?: () => boolean;
    getWebRTCMedia?: (selection: HksvMediaSelection) => Promise<any>;
    /**
     * Diagnostic bisect: names of services to skip advertising (see camera-mixin's
     * "Disable HKSV-27 Services" setting) to isolate which one a controller objects to.
     */
    disabledServices?: Set<string>;
    /** §4.5 data Version field — the guide does not enumerate values; default 1. */
    capabilitiesDataVersion?: number;
}

interface ActiveUpload {
    ingest: CmafIngestSession;
    clipId: bigint;
    window: RecordingWindow;
}

function boolCharacteristic(uuid: string, name: string, extraPerms: Perms[] = [], adminOnlyWrite = false): Characteristic {
    return new Characteristic(name, uuid, {
        format: Formats.BOOL,
        perms: [Perms.PAIRED_READ, Perms.NOTIFY, ...extraPerms],
        ...(adminOnlyWrite ? { adminOnlyAccess: [Access.WRITE] } : {}),
    });
}

export class Hksv27Camera {
    readonly multiTier: MultiTierStreamManagement;
    readonly webrtc?: WebRTCStreamManagement;
    readonly sensorUuid: Buffer;
    private readonly accessory: Accessory;
    private readonly console: Console;
    private readonly storage: MinimalStorage;
    private readonly opts: Hksv27Options;
    private readonly gateListeners: Array<() => void> = [];
    private readonly off: Set<string>;
    private readonly persistedRefreshers: Array<() => void> = [];
    private readonly eventQueue = new CameraBufferEventQueue();
    private readonly uploads = new Map<bigint, ActiveUpload>();
    private sequenceChar?: Characteristic;
    private certificateStatusChar?: Characteristic;
    private globalCameraActiveChar?: Characteristic;
    private syncLegacyCameraActive?: (active: boolean) => void;
    private keyIdChar?: Characteristic;
    private keyIdValue = '';
    private contributingSensorsChar?: Characteristic;
    private contributingSensorsValue = '';
    private motionEnabledChar?: Characteristic;
    private publishingPoint?: RecordingPublishingPoint;
    private publishingPointRaw?: Buffer;
    private readonly recordingBuffer = new HksvRecordingBuffer();
    private recorderAbort?: AbortController;
    private recorderRetry?: ReturnType<typeof setTimeout>;
    private recorderIdleReason?: string;
    private readonly configuredRecordingTransports = new WeakSet<object>();
    private snapshots?: HdsSnapshotTransport;

    constructor(
        accessory: Accessory,
        delegate: CameraStreamingDelegate,
        storage: MinimalStorage,
        console: Console,
        opts: Hksv27Options,
    ) {
        console.log('HomeKit HEVC test build: hevc-fixes-2026-09-16-r41');
        this.accessory = accessory;
        this.console = console;
        this.storage = storage;
        this.opts = opts;
        this.sensorUuid = deriveSensorUuid(accessory);
        setBisectReadTallyStorage(storage);

        const gate: StreamingGate = {
            isActive: () => this.globalActive(),
            onChanged: listener => this.gateListeners.push(listener),
        };

        const off = opts.disabledServices ?? new Set<string>();
        this.off = off;
        if (off.size)
            console.log(`HomeKit iOS 27: bisect — services disabled: ${[...off].join(', ')}`);

        // §3.6 — the Multi-Tier RTP streaming service, gated on the Global Operating Mode state.
        // Always constructed (its tier tables feed Camera Capabilities + WebRTC); the HAP
        // service itself is only attached when not bisected away.
        this.multiTier = new MultiTierStreamManagement(accessory, delegate, console, {
            sensorClass: opts.sensorClass,
            videoTiers: buildSensorVideoTiers(opts.sensorWidth, opts.sensorHeight, opts.frameRate),
            simultaneous2k: opts.simultaneous2k,
            frameRate: opts.frameRate,
            sensorUuid: this.sensorUuid,
            gate,
            storage,
            attach: !off.has('Multi-Tier RTP'),
        });

        // §3.7 — the WebRTC streaming service (werift-based media, see camera-webrtc.ts).
        if (!off.has('WebRTC')) {
            this.webrtc = new WebRTCStreamManagement(accessory, console, {
                sensorUuid: this.sensorUuid,
                gate,
                videoTiers: this.multiTier.videoTiers,
                storage,
                supportedVideoTiersValue: this.multiTier.supportedVideoTiersValue,
                supportedAudioTiersValue: this.multiTier.supportedAudioTiersValue,
                getMedia: opts.getWebRTCMedia,
                // r39: the offer shape that plays through Apple's relay in HAP-NodeJS PR 1132.
                secureVideoOffer: true,
                // r40: keep the session when the relay reoffers talkback audio.
                acceptRelayTalkback: true,
            });
            // Apple's remote stream manager searches the RTP service's linkedServices
            // for a WebRTC service IID. The reverse link alone leaves WebRTC undiscovered
            // and the modern remote path rejects negotiation with HMError code 50.
            // Keep both associations and the shared Sensor UUID for local discovery too.
            if (!off.has('Multi-Tier RTP')) {
                this.multiTier.service.addLinkedService(this.webrtc.service);
                this.webrtc.service.addLinkedService(this.multiTier.service);
                console.log('HomeKit HEVC service discovery: RTP and WebRTC linked in both directions');
            }
        }

        if (!off.has('Camera Capabilities'))
            this.addCameraCapabilitiesService();
        if (!off.has('Global Operating Mode'))
            this.addGlobalOperatingModeService();
        if (!off.has('Motion Zones'))
            this.addMotionZonesService();
        if (!off.has('Buffer Management'))
            this.addBufferManagementService();
        if (!off.has('Key Management'))
            this.addKeyManagementService();
        if (!off.has('Client Certificates'))
            this.addClientCertificateManagementService();

        const restoredPoint = storage.getItem(KEYS.publishingPoint);
        if (restoredPoint) {
            try {
                this.publishingPointRaw = Buffer.from(restoredPoint, 'base64');
                this.publishingPoint = parseRecordingPublishingPoint(this.publishingPointRaw);
            }
            catch (e) {
                console.error('failed to restore CMAF publishing point', e);
            }
        }

        // Surface the state a newly pairing controller will inventory — a persisted "off"
        // here renders the Home app tile as Off from the first read.
        console.log('HomeKit iOS 27: persisted operating state — '
            + `camera active=${this.getBool(KEYS.homekitCameraActive, true)}, `
            + `streaming enabled=${this.getBool(KEYS.globalStreamingEnabled, true)}, `
            + `motion enabled=${this.getBool(KEYS.motionEnabled, true)}`);

        // A removed pairing takes its administrative state with it. HAP-NodeJS factory-resets
        // the LEGACY operating/recording characteristics when the last pairing is removed
        // (RecordingManagement.handleFactoryReset), but this class's persisted state survived —
        // so the next pairing inherited the previous pairing's "camera off" and the legacy
        // mirror pushed the stale value back over HAP-NodeJS's reset at the next publish.
        accessory.on('unpaired', () => this.handleFactoryReset());
        Promise.resolve().then(() => this.updateRecorder());
    }

    /** Reset all persisted new-generation state to spec defaults (last pairing removed). */
    handleFactoryReset(): void {
        this.snapshots?.closeAll();
        for (const key of Object.values(KEYS))
            this.storage.removeItem(key);
        for (const refresh of this.persistedRefreshers)
            refresh();
        this.publishingPoint = undefined;
        this.publishingPointRaw = undefined;
        this.keyIdValue = buildCameraKeyID(0n).toString('base64');
        this.keyIdChar?.updateValue(this.keyIdValue);
        this.certificateStatusChar?.updateValue(
            buildClientCertificateStatus(this.certificateNeedsUpdate()).toString('base64'));
        this.syncLegacyCameraActive?.(true);
        this.webrtc?.handleFactoryReset();
        this.multiTier.handleFactoryReset();
        for (const id of this.uploads.keys()) this.stopUpload(id);
        this.notifyGate();
        this.stopRecorder();
        this.console.log('HomeKit iOS 27: unpaired — persisted operating state and recording material factory-reset');
    }

    // ------------------------------------------------------------------
    // Global operating mode (§3.2) + §3.6 gating
    // ------------------------------------------------------------------

    private getBool(key: string, defaultValue: boolean): boolean {
        const raw = this.storage.getItem(key);
        return raw == null ? defaultValue : raw === 'true';
    }

    private globalActive(): boolean {
        return this.getBool(KEYS.homekitCameraActive, true)
            && this.getBool(KEYS.globalStreamingEnabled, true);
    }

    private notifyGate(): void {
        if (!this.globalActive()) this.snapshots?.closeAll();
        if (!this.globalActive()) for (const id of this.uploads.keys()) this.stopUpload(id);
        this.updateRecorder();
        for (const listener of this.gateListeners)
            listener();
    }


    private stopRecorder(): void {
        clearTimeout(this.recorderRetry); this.recorderRetry = undefined;
        // Keep ownership until the previous producer has exited, including a pending
        // asynchronous FFmpeg startup. A replacement must not overlap that producer.
        this.recorderAbort?.abort();
        this.recordingBuffer.reset();
    }

    private recordingUnavailableReason(): string | undefined {
        if (!this.opts.recordingSource || this.off.has('Buffer Management')) return 'recording source disabled';
        if (!this.globalActive()) return 'camera or streaming disabled';
        if (this.storage.getItem(KEYS.cameraKey)) return 'Camera Key media protection is not implemented; Apple HKSV upload is unavailable';
        if (!this.opts.isRecordingActive?.()) return 'Recording Active is off';
        if (!this.publishingPoint?.url || !this.storage.getItem(KEYS.clientCertificate) || !this.storage.getItem(KEYS.clientKeyPem))
            return 'waiting for recording publishing point and client identity';
    }

    private updateRecorder(): void {
        const reason = this.recordingUnavailableReason();
        if (reason !== this.recorderIdleReason) {
            this.recorderIdleReason = reason;
            if (reason) this.console.log(`HomeKit HEVC recording buffer idle: ${reason}`);
        }
        if (reason) {
            for (const id of this.uploads.keys()) this.stopUpload(id);
            this.stopRecorder(); return;
        }
        if (this.recorderAbort || this.recorderRetry) return;
        const controller = new AbortController(); this.recorderAbort = controller;
        (async () => {
            try {
                for await (const item of this.opts.recordingSource!(this.multiTier.videoTiers[0], controller.signal)) {
                    if (controller.signal.aborted) break;
                    if ('init' in item) this.recordingBuffer.reset(item.init, true);
                    else this.recordingBuffer.append(item);
                }
            }
            catch (e) { if (!controller.signal.aborted) this.console.error('HomeKit HEVC recording buffer failed', e); }
            finally {
                if (this.recorderAbort === controller) {
                    this.recorderAbort = undefined;
                    this.recordingBuffer.reset();
                    if (!this.recordingUnavailableReason()) {
                        if (controller.signal.aborted) queueMicrotask(() => this.updateRecorder());
                        else this.recorderRetry = setTimeout(() => {
                            this.recorderRetry = undefined; this.updateRecorder();
                        }, 5000);
                    }
                }
            }
        })();
    }

    restartRecordingSource(): void {
        for (const id of this.uploads.keys()) this.stopUpload(id);
        this.stopRecorder(); this.updateRecorder();
    }

    attachRecordingManagement(service: Service): void {
        const active = service.getCharacteristic(Characteristic.Active);
        this.opts.isRecordingActive = () => !!active.value;
        active.on('change', () => this.updateRecorder());
        service.getCharacteristic(Characteristic.RecordingAudioActive).on('change', (change: any) => {
            if (!!change.oldValue !== !!change.newValue) this.restartRecordingSource();
        });
        this.updateRecorder();
    }

    /** Remove legacy recording negotiation independently of the shared HDS transport. */
    configureRecordingTransport(recording: RecordingManagement): void {
        const rms = recording.recordingManagementService;
        if (this.off.has('Legacy Recording Config')) {
            for (const type of [
                Characteristic.SelectedCameraRecordingConfiguration,
                Characteristic.SupportedCameraRecordingConfiguration,
                Characteristic.SupportedVideoRecordingConfiguration,
                Characteristic.SupportedAudioRecordingConfiguration,
            ]) {
                const characteristic = rms.characteristics.find(c => c.UUID === type.UUID);
                if (characteristic) rms.removeCharacteristic(characteristic);
            }
            this.console.log('HomeKit iOS 27: bisect — legacy recording configuration stripped; shared HDS transport retained');
        }

        // The RC uses HDS BulkSend for snapshots. Removing this service with the legacy
        // recording TLVs left Home waiting for a transport that could never become ready.
        const transport = recording.dataStreamManagement;
        const service = transport.getService();
        if (!this.accessory.services.includes(service)) this.accessory.addService(service);
        rms.addLinkedService(service);
        if (!this.off.has('Multi-Tier RTP')) this.multiTier.service.addLinkedService(service);
        this.webrtc?.service.addLinkedService(service);

        if (this.configuredRecordingTransports.has(transport)) return;
        this.configuredRecordingTransports.add(transport);
        if (this.opts.takeSnapshot) this.snapshots = new HdsSnapshotTransport(recording, {
            width: this.multiTier.videoTiers[0].width, height: this.multiTier.videoTiers[0].height,
            isActive: () => this.globalActive(), takeSnapshot: this.opts.takeSnapshot,
            console: this.console,
        });
        // Observe request routing without logging image or cryptographic payloads.
        // Record routing and field names, never payloads, salts, keys or JPEG bytes.
        transport.onServerEvent(DataStreamServerEvent.CONNECTION_OPENED, connection => {
            this.console.log('HomeKit HDS connection opened');
            let requests = 0;
            const label = (value: unknown) => typeof value === 'string'
                ? value.replace(/[^a-zA-Z0-9_.-]/g, '?').slice(0, 64) : '?';
            const observe = (message: any) => {
                if (message.type !== MessageType.REQUEST) return;
                if (++requests > 10 && requests % 10 !== 0) return;
                const body = message.message;
                const fields = body && typeof body === 'object' && !Buffer.isBuffer(body)
                    ? Object.keys(body).slice(0, 24).map(label).join(',') : '?';
                const metadataFields = body?.metadata && typeof body.metadata === 'object' && !Buffer.isBuffer(body.metadata)
                    ? Object.keys(body.metadata).slice(0, 24).map(label).join(',') : '';
                this.console.log(`HomeKit HDS request ${label(message.protocol)}/${label(message.topic)} (#${requests}); type=${label(body?.type)}, target=${label(body?.target)}, fields=[${fields}], metadata=[${metadataFields}]`);
            };
            connection.on(DataStreamConnectionEvent.HANDLE_MESSAGE_GLOBALLY, observe);
            connection.once(DataStreamConnectionEvent.CLOSED, () => {
                connection.removeListener(DataStreamConnectionEvent.HANDLE_MESSAGE_GLOBALLY, observe);
                this.console.log('HomeKit HDS connection closed');
            });
        });
    }

    /** Optional bisect: remove only legacy live-view services, keeping the tier tables intact. */
    useMultiTierLiveViewOnly(legacyServices: Service[]): void {
        if (this.off.has('Multi-Tier RTP')) throw new Error('Multi-Tier RTP must be enabled before removing legacy RTP live view');
        for (const service of legacyServices) this.accessory.removeService(service);
        this.multiTier.service.setPrimaryService(true);
        this.console.log('HomeKit iOS 27: diagnostic — legacy RTP live-view services removed; waiting for Multi-Tier Setup Endpoints or WebRTC Solicit Offer');
    }

    private persistedToggle(char: Characteristic, key: string, defaultValue: boolean,
        opts?: { numeric?: boolean, onChanged?: () => void, label?: string }): Characteristic {
        // Serve constrained-UINT8 characteristics (e.g. HomeKit Camera Active) as 0/1 — writing
        // a boolean into them violates their HAP definition.
        const current = () => {
            const v = this.getBool(key, defaultValue);
            return opts?.numeric ? (v ? 1 : 0) : v;
        };
        char.updateValue(current());
        this.persistedRefreshers.push(() => char.updateValue(current()));
        if (opts?.label)
            logCharacteristicReads(char, this.console, opts.label, current);
        char.on('set', (value: any, cb: any) => {
            this.console.log(`HomeKit iOS 27: controller wrote ${opts?.label ?? char.displayName} = ${value}`);
            recordBisectSignal(this.storage, `${opts?.label ?? char.displayName} = ${!!value}`);
            this.storage.setItem(key, (!!value).toString());
            cb(null);
            char.updateValue(current());
            opts?.onChanged?.();
        });
        return char;
    }

    private addGlobalOperatingModeService(): void {
        const service = new Service('Camera Operating Mode', CameraGlobalOperatingModeServiceUUID, 'hksv27-global');

        // Use HAP-NodeJS's predefined classes for the R17 characteristics so formats and
        // constraints exactly match Apple's definitions — HomeKit Camera Active is a constrained
        // UINT8, not a bool, and a format mismatch on a well-known UUID can make a controller
        // reject the accessory during setup.
        this.globalCameraActiveChar = this.persistedToggle(new Characteristic.HomeKitCameraActive(),
            KEYS.homekitCameraActive, true,
            {
                numeric: true,
                onChanged: () => {
                    this.notifyGate();
                    this.syncLegacyCameraActive?.(this.getBool(KEYS.homekitCameraActive, true));
                },
                label: 'HomeKit Camera Active (global)',
            });
        service.addCharacteristic(this.globalCameraActiveChar);

        // Characteristic-level bisect of this service ('Global: …' names in the Disable
        // list): Run 3 identified the service's presence as what flips the hub off the
        // legacy recording path — these carve it down to find whether a specific
        // characteristic (rather than the bare service) is the trigger.
        if (!this.off.has('Global: Streaming Enabled'))
            service.addCharacteristic(this.persistedToggle(
                boolCharacteristic(StreamingEnabledUUID, 'Streaming Enabled', [Perms.PAIRED_WRITE, Perms.TIMED_WRITE], true),
                KEYS.globalStreamingEnabled, true,
                { onChanged: () => this.notifyGate(), label: 'Streaming Enabled (global)' }));

        if (!this.off.has('Global: Indicator'))
            service.addCharacteristic(this.persistedToggle(new Characteristic.CameraOperatingModeIndicator(),
                KEYS.operatingModeIndicator, true,
                { label: 'Camera Operating Mode Indicator' }));

        // §3.2 optional characteristics — read-only, but a strict controller may require their
        // presence before enabling streaming/recording features.
        if (!this.off.has('Global: 3.2 Optionals')) {
            const manuallyDisabled = new Characteristic.ManuallyDisabled();
            manuallyDisabled.updateValue(false);
            logCharacteristicReads(manuallyDisabled, this.console, 'Manually Disabled', () => false);
            service.addCharacteristic(manuallyDisabled);

            // Serve ACTIVE (1): field bisect showed that advertising 0 here reads to
            // controllers as "this third-party camera is inactive" — every controller then
            // reconciled by writing the camera off (the off-storms that demoted the tile).
            const thirdParty = new Characteristic.ThirdPartyCameraActive();
            thirdParty.updateValue(1);
            logCharacteristicReads(thirdParty, this.console, 'Third Party Camera Active', () => 1);
            service.addCharacteristic(thirdParty);
        }

        this.accessory.addService(service);
    }

    // ------------------------------------------------------------------
    // Camera Capabilities (§3.1/§4.5) — the discovery gate
    // ------------------------------------------------------------------

    private addCameraCapabilitiesService(): void {
        const service = new Service('Camera Capabilities', CameraCapabilitiesServiceUUID, 'hksv27-capabilities');

        const version = new Characteristic.Version();
        version.updateValue(CAMERA_CAPABILITIES_VERSION);
        logCharacteristicReads(version, this.console, 'Camera Capabilities Version', () => CAMERA_CAPABILITIES_VERSION);
        service.addCharacteristic(version);

        const capabilitiesValue = encodeCameraCapabilities([
            buildPrimarySensorConfiguration(
                this.sensorUuid,
                this.opts.sensorWidth,
                this.opts.sensorHeight,
                this.multiTier.videoTiers,
            ),
        ], this.opts.capabilitiesDataVersion ?? undefined).toString('base64');
        const capabilities = new Characteristic('Camera Capabilities', CameraCapabilitiesCharacteristicUUID, {
            format: Formats.TLV8,
            perms: [Perms.PAIRED_READ],
        });
        capabilities.updateValue(capabilitiesValue);
        logCharacteristicReads(capabilities, this.console, 'Camera Capabilities', () => capabilitiesValue);
        service.addCharacteristic(capabilities);

        this.accessory.addService(service);
    }

    // ------------------------------------------------------------------
    // Camera Motion Zones (§3.4/§4.14)
    // ------------------------------------------------------------------

    private addMotionZonesService(): void {
        const service = new Service('Camera Motion Zones', CameraMotionZonesServiceUUID, 'hksv27-zones');

        const version = new Characteristic.Version();
        version.updateValue(CAMERA_CAPABILITIES_VERSION);
        logCharacteristicReads(version, this.console, 'Camera Motion Zones Version', () => CAMERA_CAPABILITIES_VERSION);
        service.addCharacteristic(version);

        service.addCharacteristic(this.persistedToggle(new Characteristic.Active(),
            KEYS.zonesActive, true,
            { numeric: true, label: 'Camera Motion Zones Active' }));

        const zones = new Characteristic('Camera Zones', CameraZonesUUID, {
            format: Formats.TLV8,
            perms: [Perms.PAIRED_READ, Perms.PAIRED_WRITE],
        });
        logCharacteristicReads(zones, this.console, 'Camera Zones',
            () => this.storage.getItem(KEYS.zones) ?? encodeCameraZones([]).toString('base64'));
        zones.on('set', (value: any, cb: any) => {
            try {
                const parsed = parseCameraZones(Buffer.from(value, 'base64'));
                this.storage.setItem(KEYS.zones, value);
                this.console.log(`HomeKit camera zones updated: version ${parsed.version}, ${parsed.zones.length} zone(s), `
                    + `${parsed.zones.reduce((n, z) => n + z.polygons.length, 0)} polygon(s)`);
                // Zones are stored + echoed; motion analysis in Scrypted happens in the
                // detector plugins. Surfacing these regions to them is a future integration.
                cb(null);
            }
            catch (e) {
                this.console.error('camera zones write failed', e);
                cb(e);
            }
        });
        service.addCharacteristic(zones);

        this.accessory.addService(service);
    }

    // ------------------------------------------------------------------
    // Camera Buffer Management (§3.5) + Camera Event Queue (§4.11/§4.12)
    // ------------------------------------------------------------------

    private appendEvent(event: Parameters<CameraBufferEventQueue['append']>[0]): void {
        this.eventQueue.append(event);
        // Notify controllers that new events are queued (they follow up with a Query).
        // (sequenceChar is absent when Buffer Management is bisected away.)
        this.sequenceChar?.updateValue(this.eventQueue.lastSequenceNumberU32);
    }

    private addBufferManagementService(): void {
        const service = new Service('Camera Buffer Management', CameraBufferManagementServiceUUID, 'hksv27-buffer');

        // --- Buffer Event Sequence Number (uint32, PR + Notify) ---
        this.sequenceChar = new Characteristic('Buffer Event Sequence Number', BufferEventSequenceNumberUUID, {
            format: Formats.UINT32,
            perms: [Perms.PAIRED_READ, Perms.NOTIFY],
        });
        this.sequenceChar.updateValue(0);
        logCharacteristicReads(this.sequenceChar, this.console, 'Buffer Event Sequence Number',
            () => this.eventQueue.lastSequenceNumberU32);
        service.addCharacteristic(this.sequenceChar);

        // --- Buffer Event Command (PR/PW/WR): Query/Acknowledge the event queue ---
        const eventCommand = new Characteristic('Buffer Event Command', BufferEventCommandUUID, {
            format: Formats.TLV8,
            perms: [Perms.PAIRED_READ, Perms.PAIRED_WRITE, Perms.WRITE_RESPONSE],
        });
        let lastEventResponse = buildBufferEventResponse([]).toString('base64');
        logCharacteristicReads(eventCommand, this.console, 'Buffer Event Command', () => lastEventResponse);
        eventCommand.on('set', (value: any, cb: any) => {
            try {
                const command = parseBufferEventCommand(Buffer.from(value, 'base64'));
                if (command.command === BufferEventCommandType.ACKNOWLEDGE) {
                    if (command.sequenceNumber !== undefined)
                        this.eventQueue.acknowledge(command.sequenceNumber);
                    lastEventResponse = buildBufferEventResponse([]).toString('base64');
                }
                else {
                    const events = this.eventQueue.query(command.sequenceNumber, command.limit);
                    lastEventResponse = buildBufferEventResponse(events).toString('base64');
                }
                cb(null, lastEventResponse);
            }
            catch (e) {
                this.console.error('buffer event command failed', e);
                cb(e);
            }
        });
        service.addCharacteristic(eventCommand);

        // --- Buffer Activity Command (PW): controller declares should-record windows ---
        const activityCommand = new Characteristic('Buffer Activity Command', BufferActivityCommandUUID, {
            format: Formats.TLV8,
            perms: [Perms.PAIRED_WRITE],
        });
        activityCommand.on('set', (value: any, cb: any) => {
            try {
                const command = parseBufferActivityCommand(Buffer.from(value, 'base64'));
                if (![BufferActivity.SHOULD_RECORD, BufferActivity.SHOULD_NOT_RECORD].includes(command.activity))
                    throw new Error('Unknown buffer activity');
                this.recordingBuffer.activity(command.start, command.durationMs, command.activity === BufferActivity.SHOULD_RECORD);
                cb(null);
            }
            catch (e) {
                this.console.error('buffer activity command failed', e);
                cb(e);
            }
        });
        service.addCharacteristic(activityCommand);

        // --- Buffer Upload Command (PR/PW/WR): start/stop CMAF clip uploads ---
        const uploadCommand = new Characteristic('Buffer Upload Command', BufferUploadCommandUUID, {
            format: Formats.TLV8,
            perms: [Perms.PAIRED_READ, Perms.PAIRED_WRITE, Perms.WRITE_RESPONSE],
        });
        let lastUploadResponse = buildBufferUploadResponse(0n).toString('base64');
        logCharacteristicReads(uploadCommand, this.console, 'Buffer Upload Command', () => lastUploadResponse);
        uploadCommand.on('set', (value: any, cb: any) => {
            try {
                const command = parseBufferUploadCommand(Buffer.from(value, 'base64'));
                const clipId = this.handleUploadCommand(command.sessionId, command.command, command.start, command.stop, command.stopAction);
                lastUploadResponse = buildBufferUploadResponse(clipId).toString('base64');
                cb(null, lastUploadResponse);
            }
            catch (e) {
                this.console.error('buffer upload command failed', e);
                cb(e);
            }
        });
        service.addCharacteristic(uploadCommand);

        // --- Camera Recording Publishing Point (PR/PW) ---
        const publishingPoint = new Characteristic('Camera Recording Publishing Point', CameraRecordingPublishingPointUUID, {
            format: Formats.TLV8,
            perms: [Perms.PAIRED_READ, Perms.PAIRED_WRITE],
        });
        logCharacteristicReads(publishingPoint, this.console, 'Camera Recording Publishing Point',
            () => this.publishingPointRaw?.toString('base64') ?? '');
        publishingPoint.on('set', (value: any, cb: any) => {
            try {
                const raw = Buffer.from(value, 'base64');
                const parsed = parseRecordingPublishingPoint(raw);
                // Home clears this characteristic during provisioning/reset.
                if (!parsed.url && !parsed.serverCaCertificates.length) {
                    this.publishingPointRaw = undefined;
                    this.publishingPoint = undefined;
                    this.storage.removeItem(KEYS.publishingPoint);
                    this.restartRecordingSource();
                    recordBisectSignal(this.storage, 'Publishing Point cleared');
                    this.console.log('HomeKit CMAF publishing point cleared');
                    cb(null);
                    return;
                }
                const url = new URL(parsed.url);
                if (url.protocol !== 'https:' || !url.pathname.endsWith('/') || !parsed.serverCaCertificates.length)
                    throw new Error('Publishing point requires HTTPS, a trailing slash, and server certificates');
                const changed = !this.publishingPointRaw?.equals(raw);
                this.publishingPointRaw = raw;
                this.publishingPoint = parsed;
                this.storage.setItem(KEYS.publishingPoint, raw.toString('base64'));
                recordBisectSignal(this.storage, 'Publishing Point written');
                this.console.log(`HomeKit CMAF publishing point set: ${new URL(parsed.url).origin} `
                    + `(${parsed.serverCaCertificates.length} server CA cert(s))`);
                if (changed) this.restartRecordingSource();
                cb(null);
            }
            catch (e) {
                this.console.error('publishing point write failed', e);
                cb(e);
            }
        });
        service.addCharacteristic(publishingPoint);

        this.accessory.addService(service);
    }

    private nextClipId(): bigint {
        const next = BigInt(this.storage.getItem(KEYS.clipCounter) || '0') + 1n;
        this.storage.setItem(KEYS.clipCounter, next.toString());
        return next;
    }

    private handleUploadCommand(sessionId: bigint, command: BufferUploadCommandType, start?: bigint, stop?: bigint,
        stopAction?: BufferUploadStopAction): bigint {
        if (!this.globalActive()) throw new Error('Camera is disabled');
        if (![1, 2, 3].includes(command)) throw new Error('Unknown buffer upload command');
        if (command !== BufferUploadCommandType.START && (stop === undefined || ![1, 2].includes(stopAction)))
            throw new Error('Stop timestamp and action are required');
        const existing = this.uploads.get(sessionId);
        if (command === BufferUploadCommandType.STOP) {
            if (!existing) throw new Error('Unknown recording upload session');
            existing.window.stop(stop!, stopAction === BufferUploadStopAction.PAUSE);
            return existing.clipId;
        }
        if (start === undefined || (stop !== undefined && stop <= start)) throw new Error('Invalid recording interval');
        if (existing) {
            existing.window.resume(start, stop, stopAction === BufferUploadStopAction.PAUSE);
            return existing.clipId;
        }
        if (this.uploads.size >= 6) throw new Error('Recording upload session limit reached');
        if (!this.publishingPoint?.url || !this.opts.recordingSource) throw new Error('Recording publishing point or source is unavailable');
        // The public guide does not define how Camera Key encrypts/authenticates CMAF media.
        // Never upload unprotected media while acknowledging a provisioned key.
        if (this.storage.getItem(KEYS.cameraKey)) {
            this.appendEvent({ type: CameraBufferEventType.CMAF_ERROR, cmafSessionId: sessionId, error: CmafError.INVALID_STATE } as any);
            throw new Error('Camera Key was provisioned, but the Apple CMAF media protection contract is unavailable in the public guide');
        }
        if (!this.opts.isRecordingActive?.()) throw new Error('Recording Active is off');
        if (!this.storage.getItem(KEYS.clientCertificate) || !this.storage.getItem(KEYS.clientKeyPem))
            throw new Error('Recording client identity has not been provisioned');
        const window = this.recordingBuffer.open(start, stop, stopAction === BufferUploadStopAction.PAUSE);
        const clipId = this.nextClipId();
        const clientKeyPem = this.storage.getItem(KEYS.clientKeyPem) ?? undefined;
        const clientCertificate = this.storage.getItem(KEYS.clientCertificate);
        const clientCa = this.storage.getItem(KEYS.clientCa);

        const ingest = new CmafIngestSession({
            publishingPointUrl: this.publishingPoint.url,
            serverCaCertificatesDer: this.publishingPoint.serverCaCertificates,
            clientCertificateDer: clientCertificate ? Buffer.from(clientCertificate, 'base64') : undefined,
            clientCaDer: clientCa ? Buffer.from(clientCa, 'base64') : undefined,
            clientPrivateKeyPem: clientKeyPem,
        }, sessionId, this.console, {
            onError: error => this.appendEvent({ type: CameraBufferEventType.CMAF_ERROR, cmafSessionId: sessionId, error } as any),
            onStopped: () => {
                window.cancel();
                if (this.uploads.delete(sessionId))
                    this.appendEvent({ type: CameraBufferEventType.CMAF_SESSION_STOP, cmafSessionId: sessionId } as any);
            },
        });

        const upload: ActiveUpload = { ingest, clipId, window };
        this.uploads.set(sessionId, upload);

        this.appendEvent({ type: CameraBufferEventType.CMAF_SESSION_START, cmafSessionId: sessionId } as any);
        this.console.log(`CMAF upload session ${sessionId} started (clip ${clipId})`);
        ingest.run(window).catch(e => this.console.error('CMAF ingest run failed', e));
        return clipId;
    }

    private stopUpload(sessionId: bigint): void {
        const active = this.uploads.get(sessionId);
        if (!active)
            return;
        active.window.cancel();
        active.ingest.stop();
    }

    // ------------------------------------------------------------------
    // Camera Key Management (§3.9)
    // ------------------------------------------------------------------

    private addKeyManagementService(): void {
        const service = new Service('Camera Key Management', CameraKeyManagementServiceUUID, 'hksv27-keys');

        const keyIdChar = new Characteristic('Camera Key ID', CameraKeyIDUUID, {
            format: Formats.TLV8,
            perms: [Perms.PAIRED_READ, Perms.NOTIFY],
        });
        this.keyIdChar = keyIdChar;
        const storedNumber = this.storage.getItem(KEYS.cameraKeyNumber);
        this.keyIdValue = buildCameraKeyID(storedNumber ? BigInt(storedNumber) : 0n).toString('base64');
        keyIdChar.updateValue(this.keyIdValue);
        logCharacteristicReads(keyIdChar, this.console, 'Camera Key ID', () => this.keyIdValue);

        const key = new Characteristic('Camera Key', CameraKeyUUID, {
            format: Formats.TLV8,
            perms: [Perms.PAIRED_WRITE, Perms.TIMED_WRITE],
        });
        key.on('set', (value: any, cb: any) => {
            try {
                const parsed = parseCameraKey(Buffer.from(value, 'base64'));
                if (!parsed.key.length) throw new Error('Camera Key is empty');
                for (const id of this.uploads.keys()) this.stopUpload(id);
                this.storage.setItem(KEYS.cameraKey, parsed.key.toString('base64'));
                this.storage.setItem(KEYS.cameraKeyNumber, parsed.keyNumber.toString());
                this.updateRecorder();
                this.keyIdValue = buildCameraKeyID(parsed.keyNumber).toString('base64');
                keyIdChar.updateValue(this.keyIdValue);
                recordBisectSignal(this.storage, 'Camera Key written');
                this.console.log(`HomeKit camera key ${parsed.keyNumber} provisioned (${parsed.key.length} bytes)`);
                cb(null);
            }
            catch (e) {
                this.console.error('camera key write failed', e);
                cb(e);
            }
        });

        service.addCharacteristic(key);
        service.addCharacteristic(keyIdChar);
        this.accessory.addService(service);
    }

    // ------------------------------------------------------------------
    // Camera Client Certificate Management (§3.10)
    // ------------------------------------------------------------------

    private clientIdentity() {
        const pem = this.storage.getItem(KEYS.clientKeyPem);
        if (pem)
            return loadClientIdentity(pem);
        const identity = createClientIdentity();
        this.storage.setItem(KEYS.clientKeyPem, identity.privateKeyPem);
        return identity;
    }

    private certificateNeedsUpdate(): boolean {
        const stored = this.storage.getItem(KEYS.clientCertificate);
        if (!stored)
            return true;
        try {
            const cert = new X509Certificate(Buffer.from(stored, 'base64'));
            const notBefore = Date.parse(cert.validFrom);
            const notAfter = Date.parse(cert.validTo);
            if (!Number.isFinite(notAfter))
                return true;
            // Scale the renewal window to the certificate's actual lifetime: Apple issues
            // short-lived client certificates, and reporting "needs update" for a
            // freshly-issued cert makes the controller loop CSR→certificate provisioning
            // until it aborts the whole recording-enable flow (observed on-device).
            const lifetime = Number.isFinite(notBefore) ? Math.max(0, notAfter - notBefore) : 0;
            const renewalWindow = lifetime > 0
                ? Math.min(CERTIFICATE_RENEWAL_WINDOW, lifetime / 4)
                : CERTIFICATE_RENEWAL_WINDOW;
            return notAfter - Date.now() < renewalWindow;
        }
        catch {
            return true;
        }
    }

    private addClientCertificateManagementService(): void {
        const service = new Service('Camera Client Certificate Management', CameraClientCertificateManagementServiceUUID, 'hksv27-certs');

        const certificateStatusChar = new Characteristic('Camera Client Certificate Status', CameraClientCertificateStatusUUID, {
            format: Formats.TLV8,
            perms: [Perms.PAIRED_READ, Perms.NOTIFY],
        });
        this.certificateStatusChar = certificateStatusChar;
        certificateStatusChar.updateValue(buildClientCertificateStatus(this.certificateNeedsUpdate()).toString('base64'));
        logCharacteristicReads(certificateStatusChar, this.console, 'Camera Client Certificate Status',
            () => buildClientCertificateStatus(this.certificateNeedsUpdate()).toString('base64'));

        const csr = new Characteristic('Camera Client CSR', CameraClientCSRUUID, {
            format: Formats.TLV8,
            perms: [Perms.PAIRED_READ, Perms.PAIRED_WRITE, Perms.WRITE_RESPONSE],
        });
        let lastCsrResponse = '';
        logCharacteristicReads(csr, this.console, 'Camera Client CSR', () => lastCsrResponse);
        csr.on('set', (value: any, cb: any) => {
            try {
                const { nonce } = parseClientCSRRequest(Buffer.from(value, 'base64'));
                const identity = this.clientIdentity();
                const csrDer = buildClientCSR(identity, `scrypted-${this.sensorUuid.toString('hex')}`);
                // FIELD-VALIDATED: Apple only accepts a raw 64-byte IEEE P1363 (r||s) nonce
                // signature — with DER the controller silently abandons provisioning after
                // reading the CSR; with P1363 it issues the client certificate. Default to
                // P1363; the setting remains for A/B against future OS behavior.
                const p1363 = this.storage.getItem('nonceSignatureP1363') !== 'false';
                const signature = signNonce(identity, nonce, p1363 ? 'ieee-p1363' : 'der');
                lastCsrResponse = buildClientCSRResponse(csrDer, signature).toString('base64');
                recordBisectSignal(this.storage, 'Client CSR issued');
                this.console.log(`HomeKit CMAF client CSR issued (${csrDer.length} bytes, nonce ${nonce.length} bytes, `
                    + `${p1363 ? 'P1363' : 'DER'} signature ${signature.length} bytes)`);
                cb(null, lastCsrResponse);
            }
            catch (e) {
                this.console.error('client CSR failed', e);
                cb(e);
            }
        });

        const certificate = new Characteristic('Camera Client Certificate', CameraClientCertificateUUID, {
            format: Formats.TLV8,
            perms: [Perms.PAIRED_READ, Perms.PAIRED_WRITE, Perms.TIMED_WRITE],
        });
        logCharacteristicReads(certificate, this.console, 'Camera Client Certificate', () => {
            const stored = this.storage.getItem(KEYS.clientCertificate);
            const ca = this.storage.getItem(KEYS.clientCa);
            if (!stored)
                return '';
            return encodeClientCertificate({
                clientCertificate: Buffer.from(stored, 'base64'),
                ca: ca ? Buffer.from(ca, 'base64') : Buffer.alloc(0),
            }).toString('base64');
        });
        certificate.on('set', (value: any, cb: any) => {
            try {
                const parsed = parseClientCertificate(Buffer.from(value, 'base64'));
                if (!parsed.clientCertificate.length) {
                    this.storage.removeItem(KEYS.clientCertificate);
                    this.storage.removeItem(KEYS.clientCa);
                    certificateStatusChar.updateValue(buildClientCertificateStatus(true).toString('base64'));
                    this.restartRecordingSource();
                    recordBisectSignal(this.storage, 'Client Certificate cleared');
                    this.console.log('HomeKit CMAF client certificate cleared; awaiting provisioning');
                    cb(null);
                    return;
                }
                // Validate before replacing the working identity.
                new X509Certificate(parsed.clientCertificate);
                const changed = this.storage.getItem(KEYS.clientCertificate) !== parsed.clientCertificate.toString('base64')
                    || this.storage.getItem(KEYS.clientCa) !== parsed.ca.toString('base64');
                this.storage.setItem(KEYS.clientCertificate, parsed.clientCertificate.toString('base64'));
                this.storage.setItem(KEYS.clientCa, parsed.ca.toString('base64'));
                const needsUpdate = this.certificateNeedsUpdate();
                certificateStatusChar.updateValue(buildClientCertificateStatus(needsUpdate).toString('base64'));
                let validity = '';
                try {
                    const cert = new X509Certificate(parsed.clientCertificate);
                    validity = `, valid ${cert.validFrom} → ${cert.validTo}, subject ${cert.subject?.replace(/\n/g, ' ')}`;
                }
                catch (e) {
                }
                recordBisectSignal(this.storage, 'Client Certificate provisioned');
                this.console.log(`HomeKit CMAF client certificate provisioned (${parsed.clientCertificate.length} bytes${validity}) `
                    + `— status now reports needsUpdate=${needsUpdate}`);
                if (changed) this.restartRecordingSource();
                cb(null);
            }
            catch (e) {
                this.console.error('client certificate write failed', e);
                cb(e);
            }
        });

        service.addCharacteristic(csr);
        service.addCharacteristic(certificate);
        service.addCharacteristic(certificateStatusChar);
        this.accessory.addService(service);
    }

    // ------------------------------------------------------------------
    // Motion Sensor additions (§3.3): Motion Enabled + Contributing Sensors + queue events
    // ------------------------------------------------------------------

    /**
     * Keep the legacy CameraOperatingMode (0x21A) and the §3.2 Camera Global Operating Mode
     * HomeKit Camera Active characteristics in lockstep. Controllers now write camera-active
     * through the new service; a reader of the legacy one seeing a disagreeing value can demote
     * the accessory's camera UI entirely (observed on-device as "shows as motion sensor only").
     */
    attachLegacyOperatingMode(legacyOperatingMode: Service): void {
        const legacy = legacyOperatingMode.characteristics.find(
            c => c.UUID === Characteristic.HomeKitCameraActive.UUID);
        if (!legacy)
            return;
        const current = () => this.getBool(KEYS.homekitCameraActive, true);
        legacy.updateValue(current() ? 1 : 0);
        this.syncLegacyCameraActive = active => legacy.updateValue(active ? 1 : 0);
        legacy.on('change', (change: any) => {
            if (change?.reason !== 'write')
                return;
            const active = !!change.newValue;
            if (current() === active)
                return;
            this.console.log(`HomeKit iOS 27: syncing legacy HomeKit Camera Active write (${active}) into global operating mode`);
            this.storage.setItem(KEYS.homekitCameraActive, active.toString());
            this.globalCameraActiveChar?.updateValue(active ? 1 : 0);
            this.notifyGate();
        });
    }

    /** Adds the §3.3 optional characteristics to the accessory's existing motion service. */
    attachMotionService(motionService: Service): void {
        this.motionEnabledChar = this.persistedToggle(
            boolCharacteristic(MotionEnabledUUID, 'Motion Enabled', [Perms.PAIRED_WRITE, Perms.TIMED_WRITE], true),
            KEYS.motionEnabled, true, { label: 'Motion Enabled' });
        motionService.addCharacteristic(this.motionEnabledChar);

        this.contributingSensorsChar = new Characteristic('Contributing Sensors', ContributingSensorsUUID, {
            format: Formats.TLV8,
            perms: [Perms.PAIRED_READ, Perms.NOTIFY],
        });
        this.contributingSensorsValue = encodeContributingSensors([]).toString('base64');
        this.contributingSensorsChar.updateValue(this.contributingSensorsValue);
        logCharacteristicReads(this.contributingSensorsChar, this.console, 'Contributing Sensors',
            () => this.contributingSensorsValue);
        motionService.addCharacteristic(this.contributingSensorsChar);
    }

    get motionEnabled(): boolean {
        return this.getBool(KEYS.motionEnabled, true);
    }

    /**
     * Feed motion transitions into the §4.11 Camera Event Queue (and Contributing Sensors).
     * Call from the plugin's existing motion binding.
     */
    updateMotion(active: boolean): void {
        if (!this.motionEnabled)
            return;
        this.contributingSensorsValue = encodeContributingSensors(active ? [this.sensorUuid] : []).toString('base64');
        this.contributingSensorsChar?.updateValue(this.contributingSensorsValue);
        this.appendEvent({ type: CameraBufferEventType.MOTION, active } as any);
        this.console.log(`HomeKit iOS 27: motion ${active ? 'started' : 'ended'} → buffer event #${this.eventQueue.lastSequenceNumberU32}`);
    }
}

/** Convenience factory mirroring the plugin's style. */
export function enableHksv27Camera(
    accessory: Accessory,
    delegate: CameraStreamingDelegate,
    storage: MinimalStorage,
    console: Console,
    opts: Hksv27Options,
): Hksv27Camera {
    return new Hksv27Camera(accessory, delegate, storage, console, opts);
}
