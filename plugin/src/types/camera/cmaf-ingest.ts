/**
 * cmaf-ingest.ts  (Scrypted HomeKit plugin — iOS/tvOS 27 HKSV direct upload)
 *
 * CMAF Ingest publishing client for the iOS/tvOS 27 HKSV recording path.
 *
 * On iOS/tvOS 27 the accessory uploads its own clips. A home hub still commands the upload over
 * HAP — it writes the publishing point (§4.13), provisions a client certificate (§4.25/§4.26)
 * and a Camera Key (§4.7), then sends Buffer Upload Commands (§4.9) — but the media never goes
 * through it. This plugin is the accessory, so Scrypted makes the HTTPS connection to Apple's
 * publishing point and uploads the recording itself.
 *
 * The object layout is the one the Matter Push AV Stream Transport cluster specifies for its
 * CMAF ingest. Apple's iOS 27 HAP surface mirrors that cluster family service for service —
 * WebRTC solicit-offer/provide-answer, client certificate provisioning, buffer upload commands,
 * motion zones — and the reference camera in project-chip/connectedhomeip (examples/camera-app)
 * is the client its ingest servers are validated against:
 *
 *     PUT {publishing_point_url}session_{N}/index.mpd                the DASH manifest, first and last
 *     PUT {publishing_point_url}session_{N}/{track}/{track}.init     one CMAF Header per track
 *     PUT {publishing_point_url}session_{N}/{track}/segment_{S}.m4s  each CMAF fragment, S from 1001
 *
 * with `video/mp4` for headers, `video/iso.segment` for fragments and `application/dash+xml`
 * for the manifest: one object per request over a kept-alive mutually-authenticated connection,
 * the manifest ahead of the media and again, complete, when the clip closes.
 *
 * r44 guessed DASH-IF's `{clip}/init.mp4` and `{clip}/{n}.m4s` instead. A real session against
 * Apple's publishing point (2026-09-16) answered 404 to that and to every other shape probed at
 * the base URL — GET, HEAD, OPTIONS, PUT and POST on the publishing point itself, `init.mp4`,
 * `{clip}/init.mp4`, `Streams({clip})`, `{clip}` and `{session}/init.mp4` — and `session_{N}/…`
 * was not among them.
 *
 * VALIDATE: which identifier N is — the §4.9 Clip ID this accessory assigned, or the Session ID
 * the controller chose — is not stated. Matter's camera assigns its CMAF session number itself,
 * which is what the Clip ID is here, so the manifest is offered under the Clip ID first and, if
 * the publishing point answers 404, under the Session ID; a 405 retries with POST. Every refusal
 * is logged with its status, its headers and the start of its body, so one real session shows
 * what Apple's publishing point expects.
 */

import https from 'https';
import { Agent } from 'https';
import { URL } from 'url';
import { CmafError, cmafErrorForHttpStatus } from './hksv-recording-protocol';
import { box, readBoxes } from './hksv-cmaf-protection';
import { buildManifest, CmafSegmentEntry, CmafTrack, splitFragment, splitInit } from './hksv-cmaf-tracks';

/** DASH-IF asks an ingest source to identify itself by brand, version and build. */
const USER_AGENT = 'DASH-IF-Ingest/1.1 scrypted-homekit';
const REQUEST_TIMEOUT_MS = 30000;
/** The Matter reference numbers a session's segments from 1001. */
export const FIRST_SEGMENT_NUMBER = 1001;
/** How much of a refusal's body a log line shows. */
const BODY_EXCERPT_BYTES = 240;
const BODY_CAPTURE_BYTES = 4096;

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
    /** The default_KID the manifest announces, when the protection has one. */
    readonly kid?: Buffer;
}

export interface CmafIngestCallbacks {
    /** Terminal failure; maps to a Buffer Event of type CMAF Error. */
    onError(error: CmafError, detail?: string): void;
    /** The upload stream ended (gracefully or after an error). */
    onStopped(): void;
}

export interface CmafIngestSummary {
    objects: number; bytes: number; retries: number; method: string; layout?: string;
    firstObjectMs?: number; elapsedMs: number; lastStatus?: number;
}

/** Where a clip's objects go, relative to the publishing point. */
export interface CmafObjectLayout {
    label: string;
    manifest: string;
    header(track: string): string;
    segment(track: string, number: number): string;
}

/** The Matter Push AV Stream Transport layout: `session_<N>/<track>/…` under the publishing point. */
export function pushAvLayout(sessionNumber: bigint, label: string): CmafObjectLayout {
    const base = `session_${sessionNumber}/`;
    return {
        label,
        manifest: `${base}index.mpd`,
        header: track => `${base}${track}/${track}.init`,
        segment: (track, number) => `${base}${track}/segment_${number}.m4s`,
    };
}

/** The layouts a clip is offered under, in order: the Clip ID first, then the Session ID. */
export function candidateLayouts(clipId: bigint, sessionId: bigint): CmafObjectLayout[] {
    const layouts = [pushAvLayout(clipId, `Clip ID ${clipId}`)];
    if (sessionId !== clipId) layouts.push(pushAvLayout(sessionId, `Session ID ${sessionId}`));
    return layouts;
}

/** What the Matter reference camera sends for each kind of object, whatever the track holds. */
const CONTENT_TYPES = {
    manifest: 'application/dash+xml',
    header: 'video/mp4',
    segment: 'video/iso.segment',
} as const;
type ObjectKind = keyof typeof CONTENT_TYPES;

export function derToPem(der: Buffer, label = 'CERTIFICATE'): string {
    const b64 = der.toString('base64').replace(/(.{64})/g, '$1\n').trimEnd();
    return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

/**
 * Prepends a Segment Type box to a CMAF fragment that has none, so each uploaded object is a
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

/** A path with any long segment — the publishing point's token — cut down for a log line. */
export function abbreviatePath(pathname: string): string {
    return pathname.split('/').map(s => s.length > 32 ? `${s.slice(0, 6)}…(${s.length})` : s).join('/');
}

interface IngestResponse { status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }

/** The headers worth a log line when a publishing point refuses an object. */
const DIAGNOSTIC_HEADERS = ['server', 'content-type', 'x-apple-request-uuid', 'x-apple-edge-response-time',
    'www-authenticate', 'allow', 'location', 'retry-after'];

/** "HTTP 404 — server: …; content-type: …; body: "…"" for a refusal, without the media. */
export function describeResponse(response: IngestResponse): string {
    const parts = DIAGNOSTIC_HEADERS.flatMap(name => {
        const value = response.headers[name];
        return value === undefined ? [] : [`${name}: ${Array.isArray(value) ? value.join(', ') : value}`];
    });
    if (response.body.length) {
        const text = response.body.toString('latin1').replace(/[^\x20-\x7e]/g, '.');
        parts.push(`body${response.body.length > BODY_EXCERPT_BYTES ? ` (${response.body.length} bytes)` : ''}: `
            + `"${text.slice(0, BODY_EXCERPT_BYTES)}"`);
    }
    return parts.length ? ` — ${parts.join('; ')}` : '';
}

class HttpStatusError extends Error {
    constructor(readonly status: number, readonly path: string, detail: string) {
        super(`HTTP ${status} for ${path}${detail}`);
    }
}

class TransportError extends Error {}

class TimeoutError extends Error {}

interface TrackState {
    track: CmafTrack;
    /** The track's CMAF Header as uploaded, so a 412 can have it again. */
    header: Buffer;
    next: number;
    segments: CmafSegmentEntry[];
}

export class CmafIngestSession {
    private stopped = false;
    private agent?: Agent;
    private request?: ReturnType<typeof https.request>;
    private readonly target: CmafIngestTarget;
    private readonly sessionId: bigint;
    private readonly console: Console;
    private readonly callbacks: CmafIngestCallbacks;
    private readonly started = Date.now();
    private readonly candidates: CmafObjectLayout[];
    private readonly tracks = new Map<number, TrackState>();
    private layout?: CmafObjectLayout;
    private method: 'PUT' | 'POST' = 'PUT';
    private releaseStop?: () => void;
    /** Settles like an exhausted source when stop() is called, so a stalled source cannot hold run(). */
    private readonly stopSignal = new Promise<IteratorResult<Buffer>>(resolve => {
        this.releaseStop = () => resolve({ done: true, value: undefined });
    });
    private summary: CmafIngestSummary = { objects: 0, bytes: 0, retries: 0, method: 'PUT', elapsedMs: 0 };

    constructor(target: CmafIngestTarget, sessionId: bigint, console: Console, callbacks: CmafIngestCallbacks) {
        this.target = target;
        this.sessionId = sessionId;
        this.console = console;
        this.callbacks = callbacks;
        this.candidates = candidateLayouts(target.clipId, sessionId);
    }

    /** The layouts this session offers, relative to the publishing point, for the start log line. */
    describeObjects(): string {
        return this.candidates.map(l => l.manifest.replace(/index\.mpd$/, '…')).join(', then ');
    }

    private url(name: string): URL {
        const url = new URL(this.target.publishingPointUrl);
        url.pathname += name;
        return url;
    }

    /** Uploads a clip to the publishing point, one CMAF object per request. */
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

            iterator = source[Symbol.asyncIterator]();
            while (!this.stopped && failure === undefined) {
                const item = await Promise.race([iterator.next(), this.stopSignal]);
                if (item.done) break;
                if (this.stopped || failure !== undefined) break;
                if (!this.tracks.size) { this.prepareHeaders(item.value); continue; }
                const objects = this.prepareSegments(item.value);
                // The first fragment fixes what the manifest can say, so the layout is settled
                // — manifest, then headers — only now.
                if (!this.layout) await this.open();
                for (const object of objects) await this.uploadSegment(object.state, object.number, object.data);
            }
            if (this.stopped || failure !== undefined) return;
            if (!this.layout) {
                this.console.log(`CMAF session ${this.sessionId}: the recording window closed before any media was produced; nothing uploaded`);
                return;
            }
            await this.upload('manifest', this.layout.manifest, Buffer.from(this.manifest(), 'utf8'));
            this.console.log(`CMAF session ${this.sessionId} uploaded ${this.summary.objects} object(s), `
                + `${this.summary.bytes} bytes in ${Date.now() - this.started} ms`
                + (this.summary.retries ? `, ${this.summary.retries} retried` : '')
                + `; ${this.method} under ${this.layout.label} at ${new URL(this.target.publishingPointUrl).origin}`);
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

    /** One CMAF Header per track, protected if the session protects, held until the layout is known. */
    private prepareHeaders(init: Buffer): void {
        for (const track of splitInit(init)) {
            const header = cmafHeader(this.target.protection ? this.target.protection.protectInit(track.header) : track.header);
            this.tracks.set(track.trackId, { track, header, next: FIRST_SEGMENT_NUMBER, segments: [] });
        }
    }

    /** One CMAF fragment per track, numbered and listed for the manifest. */
    private prepareSegments(fragment: Buffer) {
        const tracks = new Map([...this.tracks].map(([id, state]) => [id, state.track]));
        return splitFragment(fragment, tracks).map(part => {
            const state = this.tracks.get(part.trackId)!;
            const data = cmafSegment(this.target.protection ? this.target.protection.protectFragment(part.data) : part.data);
            const number = state.next++;
            state.segments.push({ number, decodeTime: part.decodeTime, duration: part.duration, bytes: data.length, samples: part.samples });
            return { state, number, data };
        });
    }

    private manifest(): string {
        return buildManifest([...this.tracks.values()].map(s => ({ track: s.track, segments: s.segments })), {
            initialization: t => `${t.name}/${t.name}.init`,
            media: t => `${t.name}/segment_$Number$.m4s`,
            startNumber: FIRST_SEGMENT_NUMBER,
            kid: this.target.protection?.kid,
        });
    }

    /**
     * Settles the layout by offering the manifest under each candidate until the publishing point
     * accepts one, then uploads every track's CMAF Header under it.
     */
    private async open(): Promise<void> {
        const manifest = Buffer.from(this.manifest(), 'utf8');
        for (const [i, layout] of this.candidates.entries()) {
            try {
                await this.upload('manifest', layout.manifest, manifest);
            }
            catch (e: any) {
                if (e instanceof HttpStatusError && e.status === 404 && i < this.candidates.length - 1) {
                    this.console.log(`CMAF session ${this.sessionId}: ${e.message}; offering the manifest under `
                        + `${this.candidates[i + 1].label} instead`);
                    continue;
                }
                throw e;
            }
            this.layout = layout;
            this.summary.layout = layout.label;
            this.console.log(`CMAF session ${this.sessionId}: publishing point accepted the manifest at `
                + `${abbreviatePath(this.url(layout.manifest).pathname)} (${layout.label}, ${this.method})`);
            break;
        }
        for (const state of this.tracks.values())
            await this.upload('header', this.layout!.header(state.track.name), state.header);
    }

    /**
     * Uploads one CMAF fragment. A publishing point that reports the header missing (412) has
     * lost the track's CMAF Header — a new upstream instance, or a connection it did not keep —
     * so the header is uploaded again and the fragment retried once.
     */
    private async uploadSegment(state: TrackState, number: number, data: Buffer): Promise<void> {
        const name = this.layout!.segment(state.track.name, number);
        try {
            await this.upload('segment', name, data);
        }
        catch (e: any) {
            if (!(e instanceof HttpStatusError) || e.status !== 412 || this.stopped) throw e;
            this.summary.retries++;
            this.console.log(`CMAF session ${this.sessionId}: ${e.message}; uploading the ${state.track.name} header again`);
            await this.upload('header', this.layout!.header(state.track.name), state.header);
            await this.upload('segment', name, data);
        }
    }

    private async upload(kind: ObjectKind, name: string, body: Buffer): Promise<void> {
        const url = this.url(name);
        const status = await this.send(url, kind, body);
        this.summary.lastStatus = status;
        this.summary.objects++; this.summary.bytes += body.length;
        this.summary.firstObjectMs ??= Date.now() - this.started;
        if (this.summary.objects === 1)
            this.console.log(`CMAF session ${this.sessionId}: HTTP ${status} for ${abbreviatePath(url.pathname)} `
                + `(${this.method}, ${body.length} bytes, ${this.target.protection ? 'Camera Key protected' : 'unprotected'})`);
    }

    /** One request. A 405 to a PUT switches the session to POST and repeats the request. */
    private async send(url: URL, kind: ObjectKind, body: Buffer): Promise<number> {
        let response = await this.exchange(url, kind, body);
        if (response.status === 405 && this.method === 'PUT') {
            this.console.log(`CMAF session ${this.sessionId}: HTTP 405 for ${abbreviatePath(url.pathname)}`
                + `${describeResponse(response)}; switching to POST`);
            this.method = 'POST'; this.summary.method = 'POST';
            response = await this.exchange(url, kind, body);
        }
        if (response.status >= 200 && response.status < 300) return response.status;
        throw new HttpStatusError(response.status, abbreviatePath(url.pathname),
            ` (${this.method}, ${body.length} bytes)${describeResponse(response)}`);
    }

    private exchange(url: URL, kind: ObjectKind, body: Buffer): Promise<IngestResponse> {
        return new Promise<IngestResponse>((resolve, reject) => {
            const request = https.request(url, {
                method: this.method, agent: this.agent, timeout: REQUEST_TIMEOUT_MS,
                headers: {
                    'User-Agent': USER_AGENT,
                    'Content-Type': CONTENT_TYPES[kind],
                    'Content-Length': body.length,
                },
            });
            this.request = request;
            let settled = false;
            const done = (fn: () => void) => { if (!settled) { settled = true; fn(); } };
            request.on('response', response => {
                const chunks: Buffer[] = [];
                let captured = 0;
                response.on('data', (chunk: Buffer) => {
                    if (captured < BODY_CAPTURE_BYTES) chunks.push(chunk.subarray(0, BODY_CAPTURE_BYTES - captured));
                    captured += chunk.length;
                });
                response.on('end', () => done(() => resolve({
                    status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks),
                })));
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
        this.releaseStop?.();
        this.request?.destroy();
        this.agent?.destroy();
    }
}

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
