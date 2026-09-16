import { getNativeHksvVideoStream } from './camera/hksv-media';
import { discoverHksvCameraSource } from './camera/hksv-source-discovery';
import { createHksvRecordingSource } from './camera/camera-cmaf-source';
import { Deferred } from '@scrypted/common/src/deferred';
import sdk, { AudioSensor, Camera, DeviceProvider, FFmpegInput, Intercom, MotionSensor, OnOff, RequestMediaStreamOptions, ScryptedDevice, ScryptedDeviceType, ScryptedInterface, ScryptedMimeTypes, VideoCamera, VideoCameraConfiguration } from '@scrypted/sdk';
import { DummyDevice, addSupportedType, bindCharacteristic } from '../common';
import { AudioRecordingCodec, AudioRecordingCodecType, AudioRecordingSamplerate, AudioStreamingCodec, AudioStreamingCodecType, AudioStreamingSamplerate, CameraController, CameraRecordingConfiguration, CameraRecordingDelegate, CameraRecordingOptions, CameraStreamingOptions, Characteristic, CharacteristicEventTypes, EventTriggerOption, H264Level, H264Profile, MediaContainerType, RecordingPacket, SRTPCryptoSuites, Service, VideoCodecType, WithUUID } from '../hap';
import type { HomeKitPlugin } from '../main';
import { CmafUploadMode, enableHksv27Camera } from './camera/camera-hksv27';
import { pickSensorClass, recordBisectSignal } from './camera/camera-multitier';
import { handleFragmentsRequests, iframeIntervalSeconds } from './camera/camera-recording';
import { createCameraStreamingDelegate } from './camera/camera-streaming';
import { installCameraStreamDiagnostics } from './camera/camera-stream-diagnostics';
import { FORCE_OPUS } from './camera/camera-utils';
import { makeAccessory, mergeOnOffDevicesByType } from './common';

const { deviceManager, mediaManager, systemManager } = sdk;

const numberPrebufferSegments = 1;

addSupportedType({
    type: ScryptedDeviceType.Camera,
    probe(device: DummyDevice) {
        return device.interfaces.includes(ScryptedInterface.VideoCamera);
    },
    async getAccessory(device: ScryptedDevice & VideoCamera & VideoCameraConfiguration & Camera & MotionSensor & AudioSensor & Intercom & OnOff, homekitPlugin: HomeKitPlugin) {
        const console = deviceManager.getMixinConsole(device.id, undefined);
        const storage = deviceManager.getMixinStorage(device.id, undefined);
        const twoWayAudio = device.interfaces?.includes(ScryptedInterface.Intercom);

        const forceOpus = FORCE_OPUS;

        // Opt-in iOS/tvOS 27 4K + HKSV surface (HEVC multi-tier streaming, Camera Capabilities,
        // CMAF recording services). Pre-27 controllers keep negotiating the legacy services.
        const streamHevc4k = storage.getItem('streamHevc4k') === 'true';

        const codecs: AudioStreamingCodec[] = [];
        // homekit seems to prefer AAC_ELD if it is offered.
        // so forcing opus must be done by not offering AAC_ELD.
        const enabledStreamingCodecTypes = [
            AudioStreamingCodecType.OPUS,
        ];
        if (!forceOpus) {
            enabledStreamingCodecTypes.push(AudioStreamingCodecType.AAC_ELD);
        }
        for (const type of enabledStreamingCodecTypes) {
            for (const samplerate of [
                // required by watch
                AudioStreamingSamplerate.KHZ_8,
                // never seen this requested
                AudioStreamingSamplerate.KHZ_16,
                // requested (required?) by ios/mac.
                AudioStreamingSamplerate.KHZ_24
            ]) {
                codecs.push({
                    type,
                    samplerate,
                    // AudioBitrate.VARIABLE
                    bitrate: 0,
                    audioChannels: 1,
                });
                codecs.push({
                    type,
                    samplerate,
                    // AudioBitrate.CONSTANT
                    bitrate: 1,
                    audioChannels: 1,
                });
            }
        }

        const streamingOptions: CameraStreamingOptions = {
            video: {
                codec: {
                    levels: [H264Level.LEVEL3_1, H264Level.LEVEL3_2, H264Level.LEVEL4_0],
                    profiles: [H264Profile.MAIN],
                },

                // HomeKit will request a resolution from this list, but it seems to do it
                // stupidly. For example, local network macOS on a 6k monitor requests the 480p stream?
                // so using the resolution for device fingerprinting can't be trusted.
                resolutions: [
                    // 3840x2160@30 (4k).
                    [3840, 2160, 30],
                    // 3K
                    [2880, 1620, 30],
                    // 2MP
                    [2560, 1440, 30],
                    // 1920x1080@30 (1080p).
                    [1920, 1080, 30],
                    // 1280x720@30 (720p).
                    [1280, 720, 30],
                    [960, 540, 30],
                    [640, 360, 30],
                    // 320x240@15 (Apple Watch).
                    [320, 240, 15],
                ]
            },
            audio: {
                codecs,
                twoWayAudio,
            },
            supportedCryptoSuites: [
                // not supported by ffmpeg
                // SRTPCryptoSuites.AES_CM_256_HMAC_SHA1_80,
                SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80,
                SRTPCryptoSuites.NONE,
            ]
        }

        let recordingDelegate: CameraRecordingDelegate | undefined;
        let recordingOptions: CameraRecordingOptions | undefined;

        const accessory = makeAccessory(device, homekitPlugin);

        const isRecordingEnabled = device.interfaces.includes(ScryptedInterface.MotionSensor);

        let configuration: CameraRecordingConfiguration;
        const openRecordingStreams = new Map<number, AsyncGenerator<RecordingPacket>>();
        if (isRecordingEnabled) {
            recordingDelegate = {
                updateRecordingConfiguration(newConfiguration: CameraRecordingConfiguration) {
                    configuration = newConfiguration;
                },
                handleRecordingStreamRequest(streamId: number): AsyncGenerator<RecordingPacket> {
                    const ret = handleFragmentsRequests(streamId, device, configuration, console, homekitPlugin, 
                        () => openRecordingStreams.has(streamId));
                    openRecordingStreams.set(streamId, ret);
                    return ret;
                },
                closeRecordingStream(streamId, reason) {
                    const r = openRecordingStreams.get(streamId);
                    console.log(`motion recording closed ${reason > 0 ? `(error code: ${reason})` : ''}`);
                    openRecordingStreams.delete(streamId);
                },
                updateRecordingActive(active) {
                },
            };

            const recordingCodecs: AudioRecordingCodec[] = [];
            const samplerate: AudioRecordingSamplerate[] = [];
            for (const sr of [
                // i believe more options may be causing issues with recordings
                // (see other half of change).
                // AudioRecordingSamplerate.KHZ_8,
                // AudioRecordingSamplerate.KHZ_16,
                // AudioRecordingSamplerate.KHZ_24,
                AudioRecordingSamplerate.KHZ_32,
                // AudioRecordingSamplerate.KHZ_44_1,
                // AudioRecordingSamplerate.KHZ_48,
            ]) {
                samplerate.push(sr);
            }

            // homekit seems to prefer AAC_ELD if it is offered.
            // so forcing AAC_LC must be done by not offering AAC_ELD.
            const enabledRecordingCodecTypes = [
                AudioRecordingCodecType.AAC_LC,
            ];
            if (!forceOpus) {
                enabledRecordingCodecTypes.push(AudioRecordingCodecType.AAC_ELD);
            }
            for (const type of enabledRecordingCodecTypes) {
                const entry: AudioRecordingCodec = {
                    type,
                    bitrateMode: 0,
                    samplerate,
                    audioChannels: 1,
                }
                recordingCodecs.push(entry);
            }

            // const recordingResolutions = [...nativeResolutions];
            // ensureHasWidthResolution(recordingResolutions, 1280, 720);
            // ensureHasWidthResolution(recordingResolutions, 1920, 1080);

            recordingOptions = {
                prebufferLength: numberPrebufferSegments * iframeIntervalSeconds * 1000,
                mediaContainerConfiguration: [
                    {
                        type: MediaContainerType.FRAGMENTED_MP4,
                        fragmentLength: iframeIntervalSeconds * 1000,
                    }
                ],
                video: {
                    type: VideoCodecType.H264,
                    parameters: {
                        levels: [H264Level.LEVEL3_1, H264Level.LEVEL3_2, H264Level.LEVEL4_0],
                        profiles: [H264Profile.BASELINE, H264Profile.MAIN, H264Profile.HIGH],
                    },
                    resolutions: [
                        [1280, 720, 30],
                        [1920, 1080, 30],
                    ],
                },
                audio: {
                    codecs: recordingCodecs,
                },
            };
        }

        const delegate = createCameraStreamingDelegate(device, console, storage, homekitPlugin);

        const controller = new CameraController({
            cameraStreamCount: 8,
            delegate,
            streamingOptions,
            recording: !isRecordingEnabled ? undefined : {
                options: recordingOptions,
                delegate: recordingDelegate,
            },
            sensors: {
                motion: isRecordingEnabled,
            },
        });

        accessory.configureController(controller);

        // iOS/tvOS 27 4K + HKSV (CMAF) camera surface: Camera Capabilities (the §3.1 discovery
        // gate), Camera Global Operating Mode, Multi-Tier RTP streaming (HEVC up to 4K), Motion
        // Zones, and the Buffer/Key/Client Certificate Management recording services. These are
        // advertised alongside the legacy CameraController services, which continue to serve
        // pre-27 controllers (the legacy video config stays H.264 — HEVC is only negotiated
        // through the new multi-tier service).
        let hksv27: ReturnType<typeof enableHksv27Camera> | undefined;
        // Diagnostic bisect set: iOS 27 service names to skip advertising.
        let hksv27Disabled = new Set<string>();
        try {
            hksv27Disabled = new Set(JSON.parse(storage.getItem('hksv27DisabledServices') || '[]'));
        }
        catch (e) {
        }
        if (streamHevc4k) {
            try {
                const { width: maxWidth, height: maxHeight, fps: nativeFrameRate } = await discoverHksvCameraSource(device, console);
                const sensorClass = pickSensorClass(maxWidth, maxHeight);

                const capabilitiesDataVersion = parseInt(storage.getItem('hksv27CapabilitiesDataVersion') || '1') || 1;
                // r44: what a §4.9 upload does with the media. See camera-mixin's
                // "Experimental: HKSV CMAF Direct Upload" setting.
                const cmafUploadMode: CmafUploadMode =
                    storage.getItem('hksv27CmafUploadMode') === 'Encrypted with the Camera Key (experimental)' ? 'cenc'
                        : storage.getItem('hksv27CmafUploadMode') === 'Unencrypted (diagnostic)' ? 'clear' : 'off';
                hksv27 = enableHksv27Camera(accessory, delegate, storage, console, {
                    sensorClass,
                    sensorWidth: maxWidth,
                    sensorHeight: maxHeight,
                    frameRate: nativeFrameRate,
                    capabilitiesDataVersion,
                    cmafUploadMode,
                    // Reuse CameraController's snapshot privacy gates and the existing
                    // Scrypted JPEG delegate for the experimental HDS snapshot transfer.
                    takeSnapshot: request => (controller as any).handleSnapshotRequest(
                        request.height, request.width, accessory.displayName, request.reason),
                    // WebRTC live view reuses the same rebroadcast pipeline the legacy
                    // streaming delegate drives, with the negotiated codec and exact tier.
                    getWebRTCMedia: async ({ codec, tier, remote }) => {
                        const mediaObject = await getNativeHksvVideoStream(device, {
                            // Off-LAN sessions use the camera's Remote Stream so a lower
                            // bitrate substream can be configured for cellular viewers.
                            destination: remote ? 'remote' : 'local',
                            destinationId: device.id,
                            destinationType: '@scrypted/homekit',
                            adaptive: false,
                            container: 'rtsp',
                            video: {
                                codec,
                                bitrate: tier.averageBitrateKbps * 1000,
                                width: tier.width, height: tier.height, fps: tier.frameRate,
                                clientWidth: tier.width,
                                clientHeight: tier.height,
                            },
                            audio: {
                                codec: 'opus',
                            },
                        } as RequestMediaStreamOptions);
                        return mediaManager.convertMediaObjectToJSON<FFmpegInput>(mediaObject, ScryptedMimeTypes.FFmpegInput);
                    },
                    // r42: WebRTC checks at offer time whether a camera stream already matches a remote tier.
                    getWebRTCSourceStreams: () => device.getVideoStreamOptions(),
                    disabledServices: hksv27Disabled,
                    recordingSource: !isRecordingEnabled ? undefined : (tier, signal) =>
                        createHksvRecordingSource(device, console, tier, signal, () =>
                            !!controller?.recordingManagement?.recordingManagementService
                                .getCharacteristic(Characteristic.RecordingAudioActive).value),
                });
                console.log(`HomeKit iOS 27 4K/HKSV services enabled; sensor class '${sensorClass}' from ${maxWidth}x${maxHeight}.`);
            }
            catch (e) {
                console.error('failed to set up HomeKit iOS 27 4K/HKSV services', e);
            }

            // Recording enable/disable flows through the LEGACY recording + operating-mode
            // services (handled inside hap-nodejs, invisible in this console). While the
            // iOS 27 recording flow is being validated, surface those writes too.
            try {
                // The recording-mode transaction verdict lives in these writes: Selected
                // Camera Recording Configuration and RecordingManagement Active decide
                // whether the hub committed recording; Setup Endpoints / Selected RTP
                // Stream Configuration reveal a legacy live-view attempt.
                const bisectSignalCharacteristics = [
                    'Active',
                    'Selected Camera Recording Configuration',
                    'Setup Endpoints',
                    'Selected RTP Stream Configuration',
                ];
                const logWrites = (service: Service | undefined, label: string) => {
                    if (!service)
                        return;
                    for (const characteristic of service.characteristics) {
                        characteristic.on(CharacteristicEventTypes.CHANGE, (change: any) => {
                            if (change?.reason !== 'write')
                                return;
                            const renderedWrite = typeof change.newValue === 'string'
                                ? `(data, ${change.newValue.length} characters)` : JSON.stringify(change.newValue);
                            console.log(`HomeKit iOS 27: controller wrote ${label} '${characteristic.displayName}' = ${renderedWrite}`);
                            if (bisectSignalCharacteristics.includes(characteristic.displayName)) {
                                const rendered = typeof change.newValue === 'string' && change.newValue.length > 24
                                    ? '(data)' : JSON.stringify(change.newValue);
                                recordBisectSignal(storage, `${label} ${characteristic.displayName} = ${rendered}`);
                            }
                        });
                    }
                };
                const { recordingManagement } = controller;
                logWrites(recordingManagement?.recordingManagementService, 'legacy RecordingManagement');
                logWrites(recordingManagement?.operatingModeService, 'legacy OperatingMode');
                logWrites(recordingManagement?.dataStreamManagement?.getService?.(), 'shared HDS');
                // Legacy live view: Setup Endpoints / Selected RTP Stream Configuration writes are
                // the controller's first action when it requests a stream — their absence at
                // tile-tap time distinguishes "app never attempted a stream" from a failed start.
                for (const [i, sm] of (controller.streamManagements || []).entries())
                    logWrites(sm?.getService?.(), `legacy RTPStreamManagement[${i}]`);
                if (hksv27Disabled.has('Legacy RTP Live View'))
                    hksv27?.useMultiTierLiveViewOnly(controller.streamManagements.map(sm => sm.getService()));
                // Keep the legacy and §3.2 HomeKit Camera Active characteristics in lockstep;
                // controllers reading disagreeing camera-active states can demote the camera UI.
                if (hksv27 && recordingManagement?.recordingManagementService) {
                    hksv27.attachRecordingManagement(recordingManagement.recordingManagementService);
                }
                if (hksv27 && recordingManagement?.operatingModeService)
                    hksv27.attachLegacyOperatingMode(recordingManagement.operatingModeService);

                // HDS is shared with new-camera snapshots, even when the bisect removes
                // the four legacy recording configuration characteristics (§3.8).
                if (recordingManagement)
                    hksv27?.configureRecordingTransport(recordingManagement);
            }
            catch (e) {
                console.error('failed to attach legacy recording diagnostics', e);
            }
        }

        if (controller.motionService) {
            const motionDevice = device;
            if (!motionDevice) {
                return;
            }

            const motionDetected = () => !!motionDevice.motionDetected;

            const { motionService } = controller;
            bindCharacteristic(motionDevice,
                ScryptedInterface.MotionSensor,
                motionService,
                Characteristic.MotionDetected,
                () => motionDetected(), true)

            // §3.3 additions (Motion Enabled, Contributing Sensors) + Camera Event Queue
            // motion events for iOS 27 HKSV.
            if (hksv27 && !hksv27Disabled.has('Motion Additions')) {
                try {
                    hksv27.attachMotionService(motionService);
                    const hksv27Motion = hksv27;
                    motionDevice.listen(ScryptedInterface.MotionSensor,
                        () => hksv27Motion.updateMotion(motionDetected()));
                }
                catch (e) {
                    console.error('failed to attach iOS 27 motion additions', e);
                }
            }

            const { recordingManagement } = controller;

            const persistBooleanCharacteristic = (service: Service, characteristic: WithUUID<{ new(): Characteristic }>) => {
                const property = `characteristic-v2-${characteristic.UUID}`
                service.getCharacteristic(characteristic)
                    .on(CharacteristicEventTypes.GET, callback => callback(null, storage.getItem(property) === 'true' ? 1 : 0))
                    .removeOnSet()
                    .on(CharacteristicEventTypes.SET, (value, callback) => {
                        callback();
                        storage.setItem(property, (!!value).toString());
                    });
            }

            if (!device.interfaces.includes(ScryptedInterface.OnOff)) {
                persistBooleanCharacteristic(recordingManagement.operatingModeService, Characteristic.CameraOperatingModeIndicator);
            }
            else {
                const indicator = recordingManagement.operatingModeService.getCharacteristic(Characteristic.CameraOperatingModeIndicator);
                const linkStatusIndicator = storage.getItem('statusIndicator') === 'true';
                const property = `characteristic-v2-${Characteristic.CameraOperatingModeIndicator.UUID}`
                bindCharacteristic(device, ScryptedInterface.OnOff, recordingManagement.operatingModeService, Characteristic.CameraOperatingModeIndicator, () => {
                    if (!linkStatusIndicator)
                        return storage.getItem(property) === 'true' ? 1 : 0;

                    return device.on ? 1 : 0;
                });
                indicator.on(CharacteristicEventTypes.SET, (value, callback) => {
                    callback();
                    if (!linkStatusIndicator)
                        return storage.setItem(property, (!!value).toString());

                    if (value)
                        device.turnOn();
                    else
                        device.turnOff();
                });
            }
        }

        // if the camera is a device provider, merge in child devices and 
        // ensure the devices are skipped by the rest of homekit by
        // reporting that they've been merged
        if (device.interfaces.includes(ScryptedInterface.DeviceProvider)) {
            // merge in lights
            mergeOnOffDevicesByType(device as ScryptedDevice as ScryptedDevice & DeviceProvider, accessory, ScryptedDeviceType.Light).devices.forEach(device => {
                homekitPlugin.mergedDevices.add(device.id)
            });

            // merge in sirens
            mergeOnOffDevicesByType(device as ScryptedDevice as ScryptedDevice & DeviceProvider, accessory, ScryptedDeviceType.Siren).devices.forEach(device => {
                homekitPlugin.mergedDevices.add(device.id)
            });
        }

        // Install for legacy cameras too, after any bisect service removals.
        installCameraStreamDiagnostics(accessory, console, streamHevc4k);
        return accessory;
    }
});
