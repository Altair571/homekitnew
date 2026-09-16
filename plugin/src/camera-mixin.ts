import { SettingsMixinDeviceOptions } from "@scrypted/common/src/settings-mixin";
import sdk, { ObjectDetector, Readme, ScryptedDeviceType, ScryptedInterface, Setting, SettingValue, VideoCamera } from "@scrypted/sdk";
import { StorageSettings, StorageSettingsDevice } from "@scrypted/sdk/storage-settings";
import { HomekitMixin } from "./homekit-mixin";
import { getDebugMode } from "./types/camera/camera-debug-mode-storage";

const { systemManager, deviceManager, log } = sdk;

export const defaultObjectDetectionContactSensorTimeout = 60;

export function canCameraMixin(type: ScryptedDeviceType | string, interfaces: string[]) {
    return (type === ScryptedDeviceType.Camera || type === ScryptedDeviceType.Doorbell)
        && interfaces.includes(ScryptedInterface.VideoCamera);
}

const HKSV27_SERVICES = [
    'Camera Capabilities',
    'Global Operating Mode',
    'Multi-Tier RTP',
    'WebRTC',
    'Motion Zones',
    'Buffer Management',
    'Key Management',
    'Client Certificates',
    'Motion Additions',
];

// Build-up bisect plan; labels carry field results. Rounds 5-6: Third Party Camera Active
// must serve 1 — serving 0 caused every demotion since round 1 (controllers reconcile
// "third-party camera inactive" by writing the camera off). Run 9 (all but Buffer) is the
// validated stable configuration: full healthy Global, legacy HKSV recording, 720p legacy
// live view. Run 10 (full surface) keeps the camera healthy but CMAF recording stalls after
// certificate provisioning with BOTH recording surfaces advertised — Run 11 therefore
// presents Apple's documented §3.8 shape (RecordingManagement reduced to Active +
// Recording Audio Active, DataStream removed) alongside the CMAF surface, the only
// previously-untested shape now that the operating-mode poison is fixed.
const HKSV27_BISECT_PLAN: Record<string, { advertised: string[], extraDisabled?: string[] } | undefined> = {
    'Manual (use Disable list)': undefined,
    'Floor: all HKSV-27 services disabled': { advertised: [] },
    'Run 1: Multi-Tier RTP only (WORKS)': { advertised: ['Multi-Tier RTP'] },
    'Run 2: + Camera Capabilities (WORKS; legacy live view maxes at 720p)': { advertised: ['Multi-Tier RTP', 'Camera Capabilities'] },
    'Run 3: + full Global (retest — Third Party now ACTIVE)': { advertised: ['Multi-Tier RTP', 'Camera Capabilities', 'Global Operating Mode'] },
    'Run 4: Run 2 + Motion Additions (WORKS)': { advertised: ['Multi-Tier RTP', 'Camera Capabilities', 'Motion Additions'] },
    'Run 5: + Motion Zones (WORKS)': { advertised: ['Multi-Tier RTP', 'Camera Capabilities', 'Motion Additions', 'Motion Zones'] },
    'Run 6: + WebRTC (WORKS)': { advertised: ['Multi-Tier RTP', 'Camera Capabilities', 'Motion Additions', 'Motion Zones', 'WebRTC'] },
    'Run 7: + Key + Client Certificates (WORKS)': { advertised: ['Multi-Tier RTP', 'Camera Capabilities', 'Motion Additions', 'Motion Zones', 'WebRTC', 'Key Management', 'Client Certificates'] },
    'Run 8: + Buffer, no Global (camera OK; recording unenableable)': { advertised: HKSV27_SERVICES.filter(s => s !== 'Global Operating Mode') },
    'Global A: MT+Cap+Global sans 3.2 optionals (WORKS)': {
        advertised: ['Multi-Tier RTP', 'Camera Capabilities', 'Global Operating Mode'],
        extraDisabled: ['Global: 3.2 Optionals'],
    },
    'Global B: MT+Cap+Global Active-only (WORKS)': {
        advertised: ['Multi-Tier RTP', 'Camera Capabilities', 'Global Operating Mode'],
        extraDisabled: ['Global: 3.2 Optionals', 'Global: Streaming Enabled', 'Global: Indicator'],
    },
    'Run 9: all but Buffer (STABLE — recording works, 720p live)': { advertised: HKSV27_SERVICES.filter(s => s !== 'Buffer Management') },
    'Run 10: FULL surface (camera OK; CMAF stalls after certs)': { advertised: HKSV27_SERVICES },
    'Run 11: full surface, §3.8 shape (strip legacy recording config)': {
        advertised: HKSV27_SERVICES,
        extraDisabled: ['Legacy Recording Config'],
    },
    'Run 12: Run 11 without legacy RTP live view (diagnostic)': {
        advertised: HKSV27_SERVICES,
        extraDisabled: ['Legacy Recording Config', 'Legacy RTP Live View'],
    },
};

export function createCameraStorageSettings(device: StorageSettingsDevice) {
    return new StorageSettings(device, {
        hasWarnedBridgedCamera: {
            description: 'Setting to warn user that bridged cameras are bad.',
            type: 'boolean',
            hide: true,
        },
        doorbellAutomationButton: {
            title: 'Doorbell Automation Button',
            type: 'boolean',
            description: 'Add an unconfigured doorbell button to HomeKit that can be used to create automations.',
            hide: true,
        },
        streamHevc4k: {
            title: 'Experimental: HEVC / 4K Streaming and HKSV (iOS/tvOS 27+)',
            type: 'boolean',
            defaultValue: false,
            description: 'Advertise the iOS/tvOS 27 camera services: Camera Capabilities, Multi-Tier RTP Stream Management (HEVC video tiers up to 4K), and the CMAF-based HomeKit Secure Video recording surface (buffer/key/certificate management). Pre-27 controllers are unaffected and keep using the legacy H.264 services. Re-pair the camera (Accessory Mode) after changing this. Leave disabled unless testing.',
        },
        nonceSignatureP1363: {
            title: 'Experimental: HKSV Raw (P1363) Nonce Signature',
            type: 'boolean',
            defaultValue: true,
            description: 'Sign the HKSV client-certificate provisioning nonce with a raw 64-byte (IEEE P1363) ECDSA signature instead of DER/X9.62. Field-validated: Apple only accepts P1363 (leave enabled).',
        },
        hksv27CmafUploadMode: {
            title: 'Experimental: HKSV CMAF Direct Upload (r45)',
            type: 'string',
            choices: [
                'Off (default)',
                'Encrypted with the Camera Key (experimental)',
                'Unencrypted (diagnostic)',
            ],
            defaultValue: 'Off (default)',
            description: 'On iOS/tvOS 27 a camera uploads its own HomeKit Secure Video clips straight to Apple, with no Apple TV or HomePod in the media path — so Scrypted makes that HTTPS connection itself. Apple\'s open-source guide defines the provisioning (publishing point, client certificate, Camera Key) but never says how the Camera Key protects the media. "Encrypted with the Camera Key" applies MPEG Common Encryption (cenc, AES-128-CTR) using the key the controller provisioned, which is the reading that fits the specification; it is unconfirmed against Apple. "Unencrypted" uploads the clip protected only by the mutually-authenticated TLS connection, which isolates the transport from the encryption while testing — the clip is readable at the far end, so leave it off unless you are diagnosing an upload. Off refuses uploads and reports Invalid State, as earlier releases did.',
        },
        hksv27DisabledServices: {
            title: 'Experimental: Disable HKSV-27 Services (bisect)',
            type: 'string',
            multiple: true,
            choices: [
                'Legacy RTP Live View',
                'Camera Capabilities',
                'Global Operating Mode',
                'Multi-Tier RTP',
                'WebRTC',
                'Motion Zones',
                'Buffer Management',
                'Key Management',
                'Client Certificates',
                'Motion Additions',
                'Legacy Recording Config',
                'Global: 3.2 Optionals',
                'Global: Streaming Enabled',
                'Global: Indicator',
            ],
            defaultValue: [],
            description: 'Diagnostic: skip advertising the selected iOS 27 services (or strip the legacy recording configuration to the §3.8 shape) to isolate which one the Home app objects to. Reload the plugin and re-pair the camera after changing.',
        },
        hksv27CapabilitiesDataVersion: {
            title: 'Experimental: Capabilities Data Version',
            type: 'string',
            choices: ['1', '2', '17'],
            defaultValue: '1',
            description: 'The §4.5 Camera Capabilities data Version field — the guide does not enumerate values (1 is the working default). The only spec-unconstrained value left; change only as a diagnostic. Reload the plugin and re-pair after changing.',
        },
        hksv27WebRTCRemoteQuality: {
            title: 'Experimental: WebRTC Remote Stream Quality',
            type: 'string',
            choices: ['Medium (1080p, recommended)', 'High (native tier)', 'Low (360p)'],
            defaultValue: 'Medium (1080p, recommended)',
            description: 'Highest HEVC tier sent to an iOS 27 WebRTC viewer that connects from outside the LAN (cellular or Apple relay). Those sessions also use this camera\'s Remote Stream in Scrypted, are paced near the tier bitrate, and add Opus loss recovery. LAN viewers are unaffected. Takes effect on the next live view.',
        },
        hksv27WebRTCRemoteResolution: {
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
        hksv27WebRTCPathMode: {
            title: 'Experimental: WebRTC Path Detection',
            type: 'string',
            choices: ['Automatic', 'Always remote profile', 'Always LAN profile'],
            defaultValue: 'Automatic',
            description: 'Automatic classifies each WebRTC session from its nominated ICE pair: a relay, a reflexive local candidate or an off-LAN peer address selects the remote profile. Force the remote profile to verify it on Wi-Fi before cellular testing, or force the LAN profile to reproduce r25. Takes effect on the next live view.',
        },
        hksv27ResetState: {
            title: 'Experimental: Reset HKSV-27 State',
            type: 'button',
            noStore: true,
            description: 'Clear all persisted iOS 27 state (operating mode, publishing point, camera key, client certificate). This happens automatically when the camera is unpaired; use it manually if the console reports "persisted operating state — camera active=false" at publish while the camera is not paired. Reload the plugin afterwards.',
            onPut: () => {
                const storage = device.storage;
                for (let i = storage.length - 1; i >= 0; i--) {
                    const key = storage.key(i);
                    if (key?.startsWith('hksv27-'))
                        storage.removeItem(key);
                }
                (device as any).console?.log?.('HomeKit iOS 27: persisted state manually reset — reload the plugin.');
            },
        },
        hksv27BisectRunner: {
            title: 'Experimental: HKSV-27 Bisect Runner',
            type: 'string',
            choices: Object.keys(HKSV27_BISECT_PLAN),
            defaultValue: 'Manual (use Disable list)',
            description: 'Automates a bisect step: selecting a run writes the Disable list for it, factory-resets the persisted HKSV-27 state, clears the signal tally, and restarts the HomeKit plugin. After the reload: remove the camera from Home, re-pair, test in the Home app, then read the "HKSV-27 Bisect Signals" panel and advance to the next run.',
            onPut: (_oldValue: any, newValue: any) => {
                const run = HKSV27_BISECT_PLAN[newValue as string];
                const mixinConsole = (device as any).console as Console | undefined;
                if (!run) {
                    mixinConsole?.log?.('HomeKit iOS 27 bisect runner: manual mode — the Disable list is authoritative.');
                    return;
                }
                const advertised = run.advertised;
                const disabled = HKSV27_SERVICES.filter(s => !advertised.includes(s)).concat(run.extraDisabled ?? []);
                device.storage.setItem('hksv27DisabledServices', JSON.stringify(disabled));
                for (let i = device.storage.length - 1; i >= 0; i--) {
                    const key = device.storage.key(i);
                    if (key?.startsWith('hksv27-'))
                        device.storage.removeItem(key);
                }
                device.storage.removeItem('hksv27bisect-signals');
                mixinConsole?.log?.(`HomeKit iOS 27 bisect runner: ${newValue} — advertising [${advertised.join(', ') || 'none'}]. `
                    + 'Restarting the HomeKit plugin; after it reloads, remove the camera from Home, re-pair, and test.');
                log.a(`HKSV-27 bisect: ${newValue}. The HomeKit plugin will restart — then remove + re-pair the camera and test.`);
                deviceManager.requestRestart();
            },
        },
    });
}

export class CameraMixin extends HomekitMixin<Readme & VideoCamera> implements Readme {
    cameraStorageSettings = createCameraStorageSettings(this);

    constructor(options: SettingsMixinDeviceOptions<Readme & VideoCamera>) {
        super(options);

        this.storageSettings.settings.standalone.persistedDefaultValue = true;
        this.cameraStorageSettings.settings.doorbellAutomationButton.hide = this.type !== ScryptedDeviceType.Doorbell;

        if (!this.cameraStorageSettings.values.hasWarnedBridgedCamera && !this.storageSettings.values.standalone) {
            this.cameraStorageSettings.values.hasWarnedBridgedCamera = true;
            log.a(`${this.name} is paired in Bridge Mode. Using Accessory Mode is recommended for cameras for optimal performance.`)
        }
    }

    async getReadmeMarkdown(): Promise<string> {
        let readme = this.mixinDeviceInterfaces.includes(ScryptedInterface.Readme) ? await this.mixinDevice.getReadmeMarkdown() + '\n\n' : '';

        if (!this.storageSettings.values.standalone) {
            readme += `
## <span style="color:red">HomeKit Performance Warning</span>

HomeKit Cameras should be paired to HomeKit in Accessory Mode for optimal performance. iOS 15.5+ will always route bridged camera video through the active HomeHub, which may result in severe performance degradation.

Enable Standalone Accessory Mode in the HomeKit settings for this camera and reload the HomeKit plugin. This camera can then be individually paired with the Home app. The pairing QR code can be seen in this camera\'s console.

More details can be found [here](https://github.com/koush/scrypted/blob/main/plugins/homekit/notes/iOS-15.5.md).
`;
        }

        const id = deviceManager.getDeviceState(this.mixinProviderNativeId).id;
        readme += `
## HomeKit Codec Settings

The recommended codec settings for cameras in HomeKit can be viewed in the [HomeKit plugin](#/device/${id}).

## HomeKit Troubleshooting

The latest troubleshooting guide for all known streaming or recording issues can be viewed in the [HomeKit plugin](#/device/${id}).`;

        if (this.storageSettings.values.standalone) {
            readme += `

## HomeKit Pairing

${this.storageSettings.values.pincode}
${this.storageSettings.values.qrCode}
            `
        }

        return readme;
    }

    getBisectSignals(): string {
        try {
            const parsed = JSON.parse(this.storage.getItem('hksv27bisect-signals') || '{}');
            const entries = Object.entries(parsed);
            if (!entries.length)
                return 'No controller writes recorded in the current bisect run yet.';
            return entries.map(([k, v]) => `${v}×  ${k}`).join('\n');
        }
        catch (e) {
            return 'Signals unavailable.';
        }
    }

    getStreamStatus(): string {
        const raw = this.storage.getItem('lastStreamInfo');
        if (!raw)
            return 'No HomeKit live stream observed yet. Start a live view in the Home app, then reload these settings.';
        try {
            const info = JSON.parse(raw);
            const ageSec = Math.max(0, Math.round((Date.now() - info.timestamp) / 1000));
            const age = ageSec < 90 ? `${ageSec}s ago`
                : ageSec < 5400 ? `${Math.round(ageSec / 60)}m ago`
                    : ageSec < 129600 ? `${Math.round(ageSec / 3600)}h ago`
                        : `${Math.round(ageSec / 86400)}d ago`;
            // 4K is ~3840x2160; allow either dimension to account for portrait sensors.
            const is4k = info.width >= 3840 || info.height >= 2160;
            const codec = info.hevcRequested ? 'HEVC' : 'H.264';
            const mp = (info.width * info.height / 1e6).toFixed(1);
            const kbps = info.maxBitrate ? `, up to ${info.maxBitrate} kbps` : '';
            return `${is4k ? '✅ 4K active' : '❌ not 4K'} — last requested ${info.width}×${info.height}`
                + `${info.fps ? `@${info.fps}` : ''} (${mp} MP, ${codec}${kbps}; ${age})`;
        }
        catch (e) {
            return 'Stream status unavailable.';
        }
    }

    async getMixinSettings(): Promise<Setting[]> {
        const settings: Setting[] = [];

        settings.push({
            title: 'HomeKit Streaming Status',
            key: 'streamStatusInfo',
            readonly: true,
            value: this.getStreamStatus(),
            description: 'The resolution and codec a HomeKit client most recently requested for live viewing. HomeKit advertises many configurations but negotiates exactly one when a stream starts, so this reflects what is actually in use. Open this camera\'s live view in the Home app, then reload these settings to refresh. 4K live streaming requires iOS/tvOS 27+ and the Experimental HEVC / 4K option.',
        });

        settings.push({
            title: 'HKSV-27 Bisect Signals',
            key: 'hksv27BisectSignals',
            readonly: true,
            value: this.getBisectSignals(),
            description: 'Tally of the decisive controller actions (mode writes, recording-configuration writes, key/certificate provisioning, stream attempts) since the current bisect run was selected. Reload the settings to refresh; paste this with the run result.',
        });

        // settings.push({
        //     title: 'H265 Streams',
        //     key: 'h265Support',
        //     description: 'Camera outputs h265 codec streams.',
        //     value: (this.storage.getItem('h265Support') === 'true').toString(),
        //     type: 'boolean',
        // });

        settings.push({
            title: 'RTP Sender',
            subgroup: 'Debug',
            key: 'rtpSender',
            description: 'The RTP Sender used by Scrypted. FFMpeg is stable. Scrypted is experimental and much faster.',
            choices: [
                'Default',
                'Scrypted',
                'FFmpeg',
            ],
            value: this.storage.getItem('rtpSender') || 'Default',
        });

        let debugMode = getDebugMode(this.storage);

        settings.push({
            title: 'Debug Mode',
            subgroup: 'Debug',
            key: 'debugMode',
            description: 'Force transcoding on this camera for streaming and recording. This setting can be used to diagnose errors with HomeKit functionality. Enable the Rebroadcast plugin for more robust transcoding options.',
            choices: [
                'Transcode Video',
                'Transcode Audio',
                'Save Recordings',
            ],
            multiple: true,
            value: debugMode.value,
        });

        if (this.interfaces.includes(ScryptedInterface.OnOff)) {
            settings.push({
                title: 'Camera Status Indicator',
                description: 'Allow HomeKit to control the camera status indicator light.',
                key: 'statusIndicator',
                value: this.storage.getItem('statusIndicator') === 'true',
                type: 'boolean',
            });
        }

        return [...await super.getMixinSettings(), ...settings, ...await this.cameraStorageSettings.getSettings()];
    }

    async putMixinSetting(key: string, value: SettingValue) {
        if (this.storageSettings.settings[key]) {
            return super.putMixinSetting(key, value);
        }

        // cameraStorageSettings entries (e.g. the multi-select bisect list) must be persisted
        // through StorageSettings: the raw toString() fallback below flattens arrays to 'A,B',
        // which the JSON.parse read path rejects, silently reverting the setting to its default.
        if (this.cameraStorageSettings.settings[key]) {
            return this.cameraStorageSettings.putSetting(key, value);
        }

        if (key === 'debugMode') {
            this.storage.setItem(key, JSON.stringify(value));
        }
        else {
            this.storage.setItem(key, value?.toString() || '');
        }

        deviceManager.onMixinEvent(this.id, this, ScryptedInterface.Settings, undefined);
    }
}
