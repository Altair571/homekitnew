/**
 * cmaf-ingest.ts  (Scrypted HomeKit plugin — iOS/tvOS 27 HKSV direct upload)
 *
 * CMAF Ingest publishing client for the iOS/tvOS 27 HKSV recording path.
 *
 * On iOS/tvOS 27 the accessory uploads its own clips. A home hub still commands the upload over
 * HAP — it writes the publishing point (§4.13), provisions a client certificate (§4.25/§4.26)
 * and a Camera Key (§4.7), then sends Buffer Upload Commands (§4.9) — but the media never goes
 * through it. This plugin is the accessory, so Scrypted makes the HTTPS connection to Apple's
 * publishing point and posts the recording itself.
 *
 * The transport is the DASH-IF Live Media Ingest Protocol, Interface 1 (CMAF ingest): Apple's
 * §4.13 field is literally named `publishing_point_url` and carries DASH-IF's trailing-slash
 * requirement, and the §4.11 CMAF Error enumeration reads as that protocol's HTTP surface —
 * "HTTP Init Missing" is the 412 a publishing point returns when a media object arrives before
 * the CMAF Header for its track, which only happens when objects are posted separately.
 *
 * So each CMAF object is one HTTP POST over a kept-alive mutually-authenticated connection:
 *
 *     POST {publishing_point_url}{clip}/init.mp4     the CMAF Header, once
 *     POST {publishing_point_url}{clip}/{n}.m4s      each CMAF fragment, in order
 *     POST {publishing_point_url}{clip}/            an empty mfra closes the clip
 *
 * VALIDATE: the path layout under the publishing point is the guessed part — the guide names no
 * verb, path or media type, and DASH-IF leaves the path to the ingest source beyond recommending
 * a $RepresentationID$/$Number$ shape. Every request logs its URL and status, so one real
 * session against Apple's publishing point shows what it actually expects.
 */

import https from 'https';
import { Agent } from 'https';
import { URL } from 'url';
import { CmafError, cmafErrorForHttpStatus } from './hksv-recording-protocol';
import { box, readBoxes } from './hksv-cmaf-protection';

/** DASH-IF asks an ingest source to identify itself by brand, version and build. */
const USER_AGENT = 'DASH-IF-Ingest/1.1 scrypted-homekit';
const REQUEST_TIMEOUT_MS = 30000;

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
    /** The §4.9 Clip ID this upload was assigned; names the objects under the publishing point. */
    clipId: bigint;
    /** Applies Camera Key protection to each object. Absent uploads the recording in the clear. */
    protection?: CmafMediaProtection;
}

/** The subset of hksv-cmaf-protection this client drives, so a test can substitute its own. */
export interface CmafMediaProtection {
    protectInit(init: Buffer): Buffer;
    protectFragment(fragment: Buffer): Buffer;
}

export interface CmafIngestCallbacks {
    /** Terminal failure; maps to a Buffer Event of type CMAF Error. */
    onError(error: CmafError, detail?: string): void;
    /** The upload stream ended (gracefully or after an error). */
    onStopped(): void;
}

export interface CmafIngestSummary {
    objects: number; bytes: number; retries: number; probeStatus?: number;
    firstObjectMs?: number; elapsedMs: number; lastStatus?: number;
}

export function derToPem(der: Buffer, label = 'CERTIFICATE'): string {
    const b64 = der.toString('base64').replace(/(.{64})/g, '$1\n').trimEnd();
    return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

/**
 * Prepends a Segment Type box to a CMAF fragment that has none, so each posted object is a
 * self-describing CMAF segment rather than a bare moof/mdat pair. The recorder's muxer omits it
 * because its output is one continuous file.
 */
export function cmafSegment(fragment: Buffer): Buffer {
    if (readBoxes(fragment)[0]?.type === 'styp') return fragment;
    const brands = Buffer.alloc(12);
    brands.write('msdh', 0, 'ascii');            // major_brand: a media segment
    brands.writeUInt32BE(0, 4);                  // minor_version
    brands.write('msdh', 8, 'ascii');            // compatible_brands
    return Buffer.concat([box('styp', brands), fragment]);
}

/** Adds the CMAF Header brand to the init segment's ftyp, leaving the existing brands in place. */
export function cmafHeader(init: Buffer): Buffer {
    const boxes = readBoxes(init);
    const ftyp = boxes[0];
    if (ftyp?.type !== 'ftyp') return init;
    const payload = init.subarray(ftyp.start + ftyp.headerSize, ftyp.start + ftyp.size);
    if (payload.includes('cmfc', 8, 'ascii')) return init;
    return Buffer.concat([box('ftyp', payload, Buffer.from('cmfc', 'ascii')),
        init.subarray(ftyp.start + ftyp.size)]);
}

/** DASH-IF signals the end of an ingest stream with an empty Movie Fragment Random Access box. */
export function endOfStreamObject(): Buffer {
    // mfro's size field counts the whole mfra: its own 8-byte header plus this 16-byte mfro.
    return box('mfra', box('mfro', Buffer.from([0, 0, 0, 0, 0, 0, 0, 24])));
}

class HttpStatusError extends Error {
    constructor(readonly status: number, url: string) { super(`HTTP ${status} from ${url}`); }
}

class TransportError extends Error {}

export class CmafIngestSession {
    private stopped = false;
    private agent?: Agent;
    private request?: ReturnType<typeof https.request>;
    private readonly target: CmafIngestTarget;
    private readonly sessionId: bigint;
    private readonly console: Console;
    private readonly callbacks: CmafIngestCallbacks;
    private readonly started = Date.now();
    private init?: Buffer;
    private summary: CmafIngestSummary = { objects: 0, bytes: 0, retries: 0, elapsedMs: 0 };

    constructor(target: CmafIngestTarget, sessionId: bigint, console: Console, callbacks: CmafIngestCallbacks) {
        this.target = target;
        this.sessionId = sessionId;
        this.console = console;
        this.callbacks = callbacks;
    }

    /** The object names this session posts, relative to the publishing point. */
    objectPath(name: string): string {
        return `${this.target.clipId}/${name}`;
    }

    private url(name: string): URL {
        const url = new URL(this.target.publishingPointUrl);
        url.pathname += this.objectPath(name);
        return url;
    }

    /** Streams a clip to the publishing point, one CMAF object per request. */
    async run(source: AsyncIterable<Buffer>): Promise<void> {
        let iterator: AsyncIterator<Buffer> | undefined;
        let failure: CmafError | undefined;
        const fail = (error: CmafError, detail: string) => {
            if (failure !== undefined || this.stopped) return;
            failure = error;
            this.console.error(`CMAF session ${this.sessionId}: ${detail}`);
            this.callbacks.onError(error, detail);
            this.request?.destroy();
        };
        try {
            const base = new URL(this.target.publishingPointUrl);
            if (base.protocol !== 'https:' || !base.pathname.endsWith('/') || !this.target.serverCaCertificatesDer.length
                || !this.target.clientCertificateDer || !this.target.clientPrivateKeyPem)
                throw new Error('CMAF requires an HTTPS publishing point, server CA and provisioned client identity');
            // One kept-alive connection carries the whole clip: DASH-IF expects persistent
            // connections rather than a TLS handshake per object.
            this.agent = new Agent({
                keepAlive: true, maxSockets: 1,
                ca: this.target.serverCaCertificatesDer.map(der => derToPem(der)),
                cert: derToPem(this.target.clientCertificateDer)
                    + (this.target.clientCaDer ? derToPem(this.target.clientCaDer) : ''),
                key: this.target.clientPrivateKeyPem, rejectUnauthorized: true,
            });
            if (this.stopped) return;

            // DASH-IF opens with an empty request, which reports whether the publishing point is
            // valid and what it requires before any media is spent on it. Its answer is
            // diagnostic only: publishing points legitimately refuse a bodiless POST.
            this.summary.probeStatus = await this.probe();

            let number = 0;
            iterator = source[Symbol.asyncIterator]();
            while (!this.stopped && failure === undefined) {
                const item = await iterator.next();
                if (item.done) break;
                if (this.stopped || failure !== undefined) break;
                if (!this.init) {
                    this.init = cmafHeader(this.target.protection
                        ? this.target.protection.protectInit(item.value) : item.value);
                    await this.post('init.mp4', this.init);
                    continue;
                }
                const fragment = cmafSegment(this.target.protection
                    ? this.target.protection.protectFragment(item.value) : item.value);
                await this.post(`${++number}.m4s`, fragment);
            }
            if (!this.stopped && failure === undefined && this.init) {
                await this.post('', endOfStreamObject());
                this.console.log(`CMAF session ${this.sessionId} uploaded ${this.summary.objects} object(s), `
                    + `${this.summary.bytes} bytes in ${Date.now() - this.started} ms`
                    + (this.summary.retries ? `, ${this.summary.retries} retried` : '')
                    + `; publishing point ${new URL(this.target.publishingPointUrl).origin}`);
            }
        }
        catch (e: any) {
            // A redirect maps to CMAF Error "None", which would report success; anything the
            // enumeration has no code for is Unknown.
            fail(e instanceof HttpStatusError ? cmafErrorForHttpStatus(e.status) || CmafError.UNKNOWN
                : errorForException(e), e?.message || 'Recording upload failed');
        }
        finally {
            this.summary.elapsedMs = Date.now() - this.started;
            this.request?.destroy();
            this.agent?.destroy();
            this.callbacks.onStopped();
            // onStopped cancels the source window, which also releases a pending next().
            if (iterator?.return) Promise.resolve(iterator.return()).catch(() => undefined);
        }
    }

    snapshot(): CmafIngestSummary {
        return { ...this.summary, elapsedMs: this.summary.elapsedMs || Date.now() - this.started };
    }

    private async probe(): Promise<number | undefined> {
        try {
            const status = await this.send(new URL(this.target.publishingPointUrl), Buffer.alloc(0));
            this.console.log(`CMAF session ${this.sessionId}: publishing point probe returned HTTP ${status}`);
            return status;
        }
        catch (e: any) {
            if (e instanceof HttpStatusError) {
                this.console.log(`CMAF session ${this.sessionId}: publishing point probe returned HTTP ${e.status}`);
                return e.status;
            }
            throw e;
        }
    }

    /**
     * Posts one CMAF object. A publishing point that reports the init segment missing (412) has
     * lost the track's CMAF Header — a new upstream instance, or a connection it did not keep —
     * so the header is posted again and the object retried once.
     */
    private async post(name: string, body: Buffer, retried = false): Promise<void> {
        const url = this.url(name);
        try {
            const status = await this.send(url, body);
            this.summary.lastStatus = status;
            this.summary.objects++; this.summary.bytes += body.length;
            this.summary.firstObjectMs ??= Date.now() - this.started;
            if (this.summary.objects === 1)
                this.console.log(`CMAF session ${this.sessionId}: HTTP ${status} for ${url.pathname} `
                    + `(${body.length} bytes, ${this.target.protection ? 'Camera Key protected' : 'unprotected'})`);
        }
        catch (e: any) {
            const status = e instanceof HttpStatusError ? e.status : undefined;
            this.console.error(`CMAF session ${this.sessionId}: ${e?.message} for ${url.pathname}`);
            if (this.stopped) return;
            if (status === 412 && !retried && this.init && name !== 'init.mp4') {
                this.summary.retries++;
                await this.post('init.mp4', this.init, true);
                await this.post(name, body, true);
                return;
            }
            throw e;
        }
    }

    private send(url: URL, body: Buffer): Promise<number> {
        return new Promise<number>((resolve, reject) => {
            const request = https.request(url, {
                method: 'POST', agent: this.agent, timeout: REQUEST_TIMEOUT_MS,
                headers: {
                    'User-Agent': USER_AGENT,
                    'Content-Type': 'video/mp4',
                    'Content-Length': body.length,
                },
            });
            this.request = request;
            let settled = false;
            const done = (fn: () => void) => { if (!settled) { settled = true; fn(); } };
            request.on('response', response => {
                const status = response.statusCode ?? 0;
                response.resume();
                response.on('end', () => done(() => status >= 200 && status < 300
                    ? resolve(status) : reject(new HttpStatusError(status, url.pathname))));
                response.on('error', () => done(() => reject(new TransportError('Response interrupted'))));
                response.on('aborted', () => done(() => reject(new TransportError('Response aborted'))));
            });
            request.on('timeout', () => { request.destroy(new TimeoutError('Publishing point timed out')); });
            request.on('error', error => done(() => reject(error)));
            request.on('close', () => done(() => reject(new TransportError('Connection closed before the response completed'))));
            request.end(body);
        });
    }

    stop(): void {
        this.stopped = true;
        this.request?.destroy();
        this.agent?.destroy();
    }
}

class TimeoutError extends Error {}

/** Maps a transport failure onto the §4.11 CMAF Error enumeration. Anything that is not a
 *  transport fault reached this client from the recording source or the protection layer, which
 *  the enumeration only has MP4 Error for. */
export function errorForException(e: NodeJS.ErrnoException): CmafError {
    if (e instanceof TimeoutError) return CmafError.TIMEOUT;
    if (e instanceof TransportError) return CmafError.CONNECTION_FAILED;
    const code = e?.code || '';
    if (['ENOTFOUND', 'EAI_AGAIN'].includes(code)) return CmafError.CANNOT_FIND_HOST;
    if (/TLS|CERT|VERIFY/.test(code)) return CmafError.CERT_CONNECTION_FAILURE;
    if (code) return CmafError.CONNECTION_FAILED;
    return CmafError.MP4_ERROR;
}
