/**
 * cmaf-ingest.ts  (Scrypted HomeKit plugin — iOS/tvOS 27 HKSV recording upload)
 *
 * Minimal CMAF Ingest publishing client for the iOS/tvOS 27 HKSV recording path. The controller
 * provisions the accessory with:
 *   - a publishing point URL + server CA certificates (Camera Recording Publishing Point, §4.13),
 *   - a client certificate for mutual TLS (Camera Client CSR/Certificate, §4.25/§4.26),
 * after which recordings are uploaded as fragmented-MP4 (CMAF) media over HTTPS.
 *
 * This client:
 *   - pins the controller-provided CA set and presents the provisioned client certificate,
 *   - streams an fMP4 source (init segment + moof/mdat fragments) to the publishing point as a
 *     single long-lived chunked POST,
 *   - maps transport/HTTP failures onto the §4.11 CMAF Error enumeration for the camera's
 *     Buffer Event queue.
 *
 * VALIDATE: the guide specifies provisioning and error reporting but not the HTTP verb/path
 * scheme of the ingest itself. This retains the original experimental single-request POST to the publishing point URL; capture a real session to confirm the exact
 * path/token layout Apple's home hubs expect, and adjust `ingestUrl()` accordingly.
 */

import { once } from 'events';
import https from 'https';
import { URL } from 'url';
import { CmafError, cmafErrorForHttpStatus } from './hksv-recording-protocol';

export interface CmafIngestTarget {
    /** The publishing_point_url from §4.13 (must end in a trailing slash). */
    publishingPointUrl: string;
    /** Server CA certificates (DER) that anchor the publishing point's TLS certificate. */
    serverCaCertificatesDer: Buffer[];
    /** Provisioned client certificate (DER) for mutual TLS. */
    clientCertificateDer?: Buffer;
    /** CA of the client certificate (DER), sent with the chain when present. */
    clientCaDer?: Buffer;
    /** PKCS#8 PEM of the private key backing the client certificate. */
    clientPrivateKeyPem?: string;
}

export interface CmafIngestCallbacks {
    /** Terminal failure; maps to a Buffer Event of type CMAF Error. */
    onError(error: CmafError, detail?: string): void;
    /** The upload stream ended (gracefully or after an error). */
    onStopped(): void;
}

export function derToPem(der: Buffer, label = 'CERTIFICATE'): string {
    const b64 = der.toString('base64').replace(/(.{64})/g, '$1\n').trimEnd();
    return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

export class CmafIngestSession {
    private stopped = false;
    private request?: ReturnType<typeof https.request>;
    private readonly target: CmafIngestTarget;
    private readonly sessionId: bigint;
    private readonly console: Console;
    private readonly callbacks: CmafIngestCallbacks;

    constructor(target: CmafIngestTarget, sessionId: bigint, console: Console, callbacks: CmafIngestCallbacks) {
        this.target = target;
        this.sessionId = sessionId;
        this.console = console;
        this.callbacks = callbacks;
    }

    private ingestUrl(): URL {
        // VALIDATE: session naming under the publishing point. The trailing-slash requirement of
        // §4.13 implies path components are appended; a per-session media name keeps concurrent
        // sessions distinct.
        const base = new URL(this.target.publishingPointUrl);
        base.pathname += `${this.sessionId}.mp4`;
        return base;
    }

    /** Streams a clip and waits for the publishing point's terminal HTTP response. */
    async run(source: AsyncIterable<Buffer>): Promise<void> {
        let iterator: AsyncIterator<Buffer>;
        let finish: () => void;
        const interrupted = new Promise<void>(resolve => finish = resolve);
        this.interrupt = finish;
        let failure: CmafError | undefined;
        const fail = (error: CmafError, detail: string) => {
            if (failure !== undefined || this.stopped) return;
            failure = error;
            this.console.error(`CMAF session ${this.sessionId}: ${detail}`);
            this.callbacks.onError(error, detail);
            this.request?.destroy(); finish();
        };
        let responseComplete = false;
        try {
            const base = new URL(this.target.publishingPointUrl);
            if (base.protocol !== 'https:' || !base.pathname.endsWith('/') || !this.target.serverCaCertificatesDer.length
                || !this.target.clientCertificateDer || !this.target.clientPrivateKeyPem)
                throw new Error('CMAF requires an HTTPS publishing point, server CA and provisioned client identity');
            if (this.stopped) return;
            const request = https.request(this.ingestUrl(), {
                method: 'POST', ca: this.target.serverCaCertificatesDer.map(der => derToPem(der)),
                cert: derToPem(this.target.clientCertificateDer) + (this.target.clientCaDer ? derToPem(this.target.clientCaDer) : ''),
                key: this.target.clientPrivateKeyPem, rejectUnauthorized: true,
                headers: { 'Content-Type': 'video/mp4', 'Transfer-Encoding': 'chunked' },
                timeout: 30000,
            });
            this.request = request;
            request.on('response', response => {
                const status = response.statusCode ?? 0;
                if (status < 200 || status >= 300) {
                    fail(cmafErrorForHttpStatus(status) || CmafError.UNKNOWN, `HTTP ${status}`);
                }
                response.on('error', () => fail(CmafError.CONNECTION_FAILED, 'Response interrupted'));
                response.on('aborted', () => fail(CmafError.CONNECTION_FAILED, 'Response aborted'));
                response.on('end', () => { responseComplete = true; finish(); });
                response.resume();
            });
            request.on('timeout', () => fail(CmafError.TIMEOUT, 'Publishing point timed out'));
            request.on('error', (error: NodeJS.ErrnoException) => {
                const code = error.code || '';
                const kind = ['ENOTFOUND', 'EAI_AGAIN'].includes(code) ? CmafError.CANNOT_FIND_HOST
                    : /TLS|CERT|VERIFY/.test(code) ? CmafError.CERT_CONNECTION_FAILURE : CmafError.CONNECTION_FAILED;
                fail(kind, code || 'Connection failed');
            });
            request.on('close', () => { if (!responseComplete) fail(CmafError.CONNECTION_FAILED, 'Connection closed before response completed'); });
            iterator = source[Symbol.asyncIterator]();
            while (!this.stopped && failure === undefined) {
                const item = await Promise.race([iterator.next(), interrupted.then(() => undefined)]);
                if (!item || item.done) break;
                if (!request.write(item.value)) {
                    // once rejects on error; close/stop also releases the wait.
                    const controller = new AbortController();
                    try { await Promise.race([once(request, 'drain', { signal: controller.signal }), interrupted]); }
                    finally { controller.abort(); }
                }
                if (responseComplete) throw new Error('Publishing point ended the response before the clip completed');
            }
            if (!this.stopped && failure === undefined) {
                request.end();
                await interrupted;
            }
        }
        catch (e: any) { fail(CmafError.MP4_ERROR, e?.message || 'Recording source failed'); }
        finally {
            this.request?.destroy();
            this.interrupt = undefined;
            this.callbacks.onStopped();
            // onStopped cancels the source window, which also releases a pending next().
            if (iterator?.return) Promise.resolve(iterator.return()).catch(() => undefined);
        }
    }

    private interrupt?: () => void;
    stop(): void {
        this.stopped = true;
        this.interrupt?.();
        this.request?.destroy();
    }
}
