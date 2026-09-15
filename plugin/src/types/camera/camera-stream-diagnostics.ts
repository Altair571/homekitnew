import { isIP } from 'net';
import { Accessory, Characteristic, Service } from '../../hap';
import { CameraMultiTierRTPStreamManagementUUID, RTPStreamingControlUUID } from './hksv-multitier-protocol';
import { CameraWebRTCStreamManagementServiceUUID, WebRTCSolicitOfferUUID, WebRTCProvideAnswerUUID,
    WebRTCStreamingControlUUID, WebRTCReofferUUID, WebRTCUpdateSessionUUID } from './hksv-webrtc-protocol';

const instrumented = new WeakSet<object>();

// Extract only the one-byte status, never log the remaining TLV (SRTP keys/SDP).
function statusByte(value: unknown, tag: number): number | undefined {
    if (typeof value !== 'string' || value.length > 65536) return;
    const bytes = Buffer.from(value, 'base64');
    let result: number | undefined;
    for (let offset = 0; offset < bytes.length;) {
        if (offset + 2 > bytes.length) return;
        const type = bytes[offset++], length = bytes[offset++];
        if (offset + length > bytes.length) return;
        if (type === tag) {
            if (length !== 1 || result !== undefined) return;
            result = bytes[offset];
        }
        offset += length;
    }
    return result;
}

function summary(characteristic: Characteristic, value: unknown, response: boolean): string {
    if (response && characteristic.UUID === Characteristic.StreamingStatus.UUID)
        return `streamStatus=${statusByte(value, 1) ?? 'unknown'} (0=available,1=in-use,2=unavailable)`;
    if (response && characteristic.UUID === Characteristic.SetupEndpoints.UUID)
        return `setupStatus=${statusByte(value, 2) ?? 'unknown'} (0=success,1=busy,2=error)`;
    if (response && characteristic.UUID === RTPStreamingControlUUID)
        return `controlStatus=${statusByte(value, 2) ?? 'unknown'}`;
    if (response && [WebRTCSolicitOfferUUID, WebRTCProvideAnswerUUID, WebRTCStreamingControlUUID,
        WebRTCReofferUUID, WebRTCUpdateSessionUUID].includes(characteristic.UUID)) {
        const tag = characteristic.UUID === WebRTCSolicitOfferUUID ? 4 : characteristic.UUID === WebRTCReofferUUID ? 3 : 2;
        return `webrtcStatus=${statusByte(value, tag) ?? 'unknown'} dataLength=${typeof value === 'string' ? value.length : 0}`;
    }
    if (typeof value === 'boolean' || typeof value === 'number') return `value=${value}`;
    if (typeof value === 'string') return `dataLength=${value.length}`;
    return `valueType=${typeof value}`;
}

function peer(connection: any): string {
    const address = connection?.remoteAddress;
    return typeof address === 'string' && isIP(address) ? address : 'internal/unknown';
}

/** Observe the exact bundled HAP request methods without replacing their handlers,
 * promises, return values or errors. SET listeners alone miss onSet and validation
 * failures. No characteristic values, permissions or service inventories are changed.
 */
export function installCameraStreamDiagnostics(accessory: Accessory, console: Console, hevcEnabled: boolean) {
    const serviceNames = new Map([
        [Service.CameraRTPStreamManagement.UUID, 'legacy RTP'],
        [CameraMultiTierRTPStreamManagementUUID, 'multi-tier RTP'],
        [CameraWebRTCStreamManagementServiceUUID, 'WebRTC'],
    ]);
    const counts = new Map<string, number>();
    const writeLog = (message: string) => {
        // A diagnostics sink must never change HAP completion or rejection behavior.
        try { console.log(message); } catch (_) { }
    };
    for (const service of accessory.services) {
        const name = serviceNames.get(service.UUID);
        if (!name) continue;
        const index = counts.get(name) || 0;
        counts.set(name, index + 1);
        for (const characteristic of service.characteristics) {
            if (instrumented.has(characteristic)) continue;
            instrumented.add(characteristic);
            const label = `${name}[${index}] ${characteristic.displayName}`;
            for (const [method, operation] of [['handleGetRequest', 'READ'], ['handleSetRequest', 'WRITE']] as const) {
                const target = characteristic as any;
                const original = target[method];
                if (typeof original !== 'function') continue;
                let count = 0;
                target[method] = function (...args: any[]) {
                    const number = ++count;
                    const connection = args[operation === 'READ' ? 0 : 1];
                    const logThis = operation === 'WRITE' || number <= 2 || number % 10 === 0;
                    const prefix = `HomeKit stream diagnostic: ${operation} ${label} #${number} peer=${peer(connection)}`;
                    const started = Date.now();
                    if (logThis) writeLog(`${prefix} received${operation === 'WRITE' ? ' ' + summary(characteristic, args[0], false) : ''}`);
                    const pending = operation === 'WRITE' ? setTimeout(() => writeLog(`${prefix} still pending after 5s`), 5000) : undefined;
                    pending?.unref?.();
                    const done = (error: any, value?: unknown) => {
                        clearTimeout(pending);
                        if (error !== undefined) {
                            const status = typeof error === 'number' ? error : error?.hapStatus;
                            writeLog(`${prefix} rejected hapStatus=${typeof status === 'number' ? status : 'unknown'} elapsedMs=${Date.now() - started}`);
                        }
                        else if (logThis) {
                            // Legacy Setup Endpoints returns its reply on a later GET.
                            const result = operation === 'WRITE' && value === undefined ? this.value : value;
                            writeLog(`${prefix} completed ${summary(characteristic, result, true)} elapsedMs=${Date.now() - started}`);
                        }
                    };
                    try {
                        const result = original.apply(this, args);
                        // HAP's methods return promises; preserve that exact promise.
                        void result.then((value: unknown) => done(undefined, value), (error: any) => done(error)).catch(() => {});
                        return result;
                    }
                    catch (error) { done(error); throw error; }
                };
            }
        }
    }
    writeLog(`HomeKit stream diagnostics build: hevc-fixes-2026-09-16-r42; HEVC option=${hevcEnabled}; legacy RTP=${counts.get('legacy RTP') || 0}; multi-tier RTP=${counts.get('multi-tier RTP') || 0}; WebRTC=${counts.get('WebRTC') || 0}`);
}
