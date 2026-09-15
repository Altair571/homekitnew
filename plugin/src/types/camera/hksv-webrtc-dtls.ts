import { createHash } from 'crypto';

/** Scoped adapter for DTLS startup and delayed hellos in the shipped werift. */
const MAX_EARLY_BYTES = 16384;
const MAX_EARLY_DATAGRAMS = 8;
const EARLY_LIFETIME_MS = 2000;
const MAX_TRACE_RECORDS = 32;
const MAX_HELLO_OBSERVATIONS = 8;

const recordNames: Record<number, string> = { 20: 'changeCipherSpec', 21: 'alert', 22: 'handshake', 23: 'applicationData' };
const handshakeNames: Record<number, string> = {
    1: 'clientHello', 2: 'serverHello', 3: 'helloVerifyRequest', 11: 'certificate',
    12: 'serverKeyExchange', 13: 'certificateRequest', 14: 'serverHelloDone',
    15: 'certificateVerify', 16: 'clientKeyExchange', 20: 'finished',
};

/** Read only framing and message types. Never retain certificate/key contents. */
function describeDatagram(data: Buffer) {
    if (!Buffer.isBuffer(data) || data.length < 13 || data.length > MAX_EARLY_BYTES
        || data[0] < 20 || data[0] > 63) return;
    const records: string[] = [], handshakes: string[] = [];
    const trace: DtlsRecordTrace[] = [];
    let onlyClientHello = true;
    for (let pos = 0; pos < data.length;) {
        if (pos + 13 > data.length || data[pos + 1] !== 254
            || ![253, 255].includes(data[pos + 2])) return;
        const type = data[pos], epoch = data.readUInt16BE(pos + 3);
        const end = pos + 13 + data.readUInt16BE(pos + 11);
        if (end > data.length) return;
        records.push(recordNames[type] ?? 'other');
        const entry: DtlsRecordTrace = { type: recordNames[type] ?? 'other', epoch,
            sequence: data.readUIntBE(pos + 5, 6), bytes: end - pos - 13, messages: [] };
        if (trace.length < MAX_TRACE_RECORDS) trace.push(entry);
        if (type !== 22 || epoch !== 0 || end === pos + 13) onlyClientHello = false;
        if (type === 22 && epoch === 0) {
            for (let h = pos + 13; h < end;) {
                if (h + 12 > end) return;
                const fragmentEnd = h + 12 + data.readUIntBE(h + 9, 3);
                if (fragmentEnd > end || data.readUIntBE(h + 6, 3) + data.readUIntBE(h + 9, 3) > data.readUIntBE(h + 1, 3)) return;
                handshakes.push(handshakeNames[data[h]] ?? 'other');
                if (entry.messages.length < 8) entry.messages.push({ type: handshakeNames[data[h]] ?? 'other',
                    sequence: data.readUInt16BE(h + 4), offset: data.readUIntBE(h + 6, 3),
                    bytes: data.readUIntBE(h + 9, 3), totalBytes: data.readUIntBE(h + 1, 3) });
                if (data[h] !== 1) onlyClientHello = false;
                h = fragmentEnd;
            }
        }
        pos = end;
    }
    return { records, handshakes, onlyClientHello, trace };
}

interface DtlsRecordTrace {
    type: string;
    epoch: number;
    sequence: number;
    bytes: number;
    messages: { type: string; sequence: number; offset: number; bytes: number; totalBytes: number }[];
}
interface DtlsHelloObservation {
    ms: number;
    flight?: number;
    sequence?: number;
    bytes: number;
    cookieBytes: number;
    sameInitialBody?: boolean;
    sameInitialRandom?: boolean;
    ignored: boolean;
}
interface DtlsCounters {
    inboundDatagrams: number;
    outboundDatagrams: number;
    inboundRecords: Record<string, number>;
    outboundRecords: Record<string, number>;
    inboundHandshakes: Record<string, number>;
    outboundHandshakes: Record<string, number>;
    earlyClientHellos: number;
    replayedClientHellos: number;
    discardedClientHellos: number;
    ignoredStaleClientHellos: number;
    ignoredUnverifiedClientHellos: number;
    handshakeGuardInstalled: boolean;
    handledHandshakes: Record<string, number>;
    decryptFailures: number;
    recordTrace: (DtlsRecordTrace & { direction: 'inbound' | 'outbound'; ms: number; flight?: number })[];
    omittedTraceRecords: number;
    clientHellos: DtlsHelloObservation[];
    omittedClientHellos: number;
}
const counters = new WeakMap<object, DtlsCounters>();
const validFlight = (value: any): number | undefined => Number.isInteger(value) && value >= 0 && value <= 7 ? value : undefined;

/** Numeric/type allowlist only; never serialize a transport, packet or certificate. */
export function summarizeWebRTCDtls(dtls: any) {
    const stats = counters.get(dtls);
    if (!stats) return;
    const flight = dtls.dtls?.dtls?.flight;
    return { ...stats,
        inboundRecords: { ...stats.inboundRecords }, outboundRecords: { ...stats.outboundRecords },
        inboundHandshakes: { ...stats.inboundHandshakes }, outboundHandshakes: { ...stats.outboundHandshakes },
        handledHandshakes: { ...stats.handledHandshakes }, clientHellos: stats.clientHellos.map(hello => ({ ...hello })),
        recordTrace: stats.recordTrace.map(record => ({ ...record, messages: record.messages.map(message => ({ ...message })) })),
        flight: validFlight(flight) };
}

/**
 * ICE can deliver ClientHello before pc.connect resumes after nomination. The
 * bundled RTCDtlsTransport creates its ICE data listener only inside start(),
 * so that first hello otherwise disappears. Retain a small, short-lived set
 * of hello datagrams and deliver them once to that receiver after normal ICE
 * startup. Never start DTLS, send a response, or feed media before nomination.
 * All hooks belong to this HomeKit transport; vendor modules are unchanged.
 */
export function protectWebRTCDtlsStartup(dtls: any): () => void {
    const connection = dtls.iceTransport?.connection;
    if (!connection?.onData?.subscribe || typeof connection.send !== 'function'
        || typeof dtls.start !== 'function') return () => {};
    const stats: DtlsCounters = { inboundDatagrams: 0, outboundDatagrams: 0,
        inboundRecords: {}, outboundRecords: {}, inboundHandshakes: {}, outboundHandshakes: {},
        earlyClientHellos: 0, replayedClientHellos: 0, discardedClientHellos: 0,
        ignoredStaleClientHellos: 0, ignoredUnverifiedClientHellos: 0,
        handshakeGuardInstalled: false, handledHandshakes: {}, decryptFailures: 0,
        recordTrace: [], omittedTraceRecords: 0, clientHellos: [], omittedClientHellos: 0 };
    counters.set(dtls, stats);
    const createdAt = Date.now();
    let pending: Buffer[] = [], pendingBytes = 0, disposed = false, accepting = true;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    const originalStart = dtls.start, originalSend = connection.send;
    let stopHandshakeGuard: (() => void) | undefined;
    const count = (direction: 'inbound' | 'outbound', description: ReturnType<typeof describeDatagram>) => {
        if (!description) return;
        stats[`${direction}Datagrams`]++;
        for (const name of description.records) stats[`${direction}Records`][name] = (stats[`${direction}Records`][name] ?? 0) + 1;
        for (const name of description.handshakes) stats[`${direction}Handshakes`][name] = (stats[`${direction}Handshakes`][name] ?? 0) + 1;
        const remaining = MAX_TRACE_RECORDS - stats.recordTrace.length;
        stats.recordTrace.push(...description.trace.slice(0, remaining).map(record => ({ ...record, direction,
            ms: Math.max(0, Date.now() - createdAt), flight: validFlight(dtls.dtls?.dtls?.flight) })));
        stats.omittedTraceRecords += description.records.length - Math.min(remaining, description.trace.length);
    };
    const discard = () => {
        clearTimeout(expiry);
        stats.discardedClientHellos += pending.length;
        pending = [];
        pendingBytes = 0;
    };
    const incoming = connection.onData.subscribe((data: Buffer) => {
        const description = describeDatagram(data);
        count('inbound', description);
        if (!accepting || dtls.dtls || !description?.onlyClientHello) return;
        stats.earlyClientHellos++;
        if (pending.some(packet => packet.equals(data)) || pending.length >= MAX_EARLY_DATAGRAMS
            || pendingBytes + data.length > MAX_EARLY_BYTES) {
            stats.discardedClientHellos++;
            return;
        }
        pending.push(Buffer.from(data));
        pendingBytes += data.length;
        if (!expiry) {
            expiry = setTimeout(() => { accepting = false; discard(); }, EARLY_LIFETIME_MS);
            expiry.unref?.();
        }
    });
    const send = function (this: any, data: Buffer, ...args: any[]) {
        // Counts are send attempts through ICE, not an acknowledgement by the
        // peer. Return the original value/promise and preserve send failures.
        count('outbound', describeDatagram(data));
        return originalSend.call(this, data, ...args);
    };
    const start = function (this: any, ...args: any[]) {
        const result = originalStart.apply(this, args);
        accepting = false;
        const socket = this.dtls?.transport?.socket;
        if (!disposed && this.role === 'server' && this.state === 'connecting'
            && connection.nominated && typeof socket?.onData === 'function') {
            if (!stopHandshakeGuard) {
                const server = this.dtls;
                const originalHandle = server.onHandleHandshakes;
                if (typeof originalHandle === 'function') {
                    stats.handshakeGuardInstalled = true;
                    // Keep digests only to classify hellos in diagnostics.
                    // A different opening random is not permission to replace
                    // the keys of this already-negotiated HomeKit transport.
                    let initialHelloDigest: string | undefined;
                    let initialRandomDigest: string | undefined;
                    const handle = function (this: any, assembled: any[]) {
                        const accepted = assembled.filter(handshake => {
                            const name = handshakeNames[handshake.msg_type] ?? 'other';
                            stats.handledHandshakes[name] = (stats.handledHandshakes[name] ?? 0) + 1;
                            const body = handshake.fragment;
                            if (handshake.msg_type !== 1 || !Buffer.isBuffer(body)
                                || body.length < 36 || body.length > MAX_EARLY_BYTES) return true;
                            const cookieOffset = 35 + body[34];
                            if (cookieOffset >= body.length || cookieOffset + 1 + body[cookieOffset] > body.length) return true;
                            const digest = createHash('sha256').update(body).digest('hex');
                            const randomDigest = createHash('sha256').update(body.subarray(2, 34)).digest('hex');
                            const flight = validFlight(server.dtls.flight);
                            const ignored = body[cookieOffset] === 0 && flight !== undefined && flight >= 4;
                            // Record comparisons only: no random, cookie, digest,
                            // certificate or key material is included in logs.
                            if (stats.clientHellos.length < MAX_HELLO_OBSERVATIONS) stats.clientHellos.push({
                                ms: Math.max(0, Date.now() - createdAt), flight: validFlight(server.dtls.flight),
                                sequence: Number.isInteger(handshake.message_seq) && handshake.message_seq >= 0 && handshake.message_seq <= 65535
                                    ? handshake.message_seq : undefined,
                                bytes: body.length, cookieBytes: body[cookieOffset],
                                sameInitialBody: initialHelloDigest === undefined ? undefined : digest === initialHelloDigest,
                                sameInitialRandom: initialRandomDigest === undefined ? undefined : randomDigest === initialRandomDigest,
                                ignored,
                            }); else stats.omittedClientHellos++;
                            if (ignored) {
                                // The bundled flight2 replaces ECDHE keys and
                                // randoms even while flight4 awaits Finished.
                                // Do not let an unverified opening hello reset
                                // this association (RFC 6347 section 4.2.8).
                                // This is scoped to one HomeKit DTLS transport;
                                // unsignaled replacement handshakes are ignored.
                                // Cookie-bearing retries still reach werift and
                                // can retransmit a lost server flight normally.
                                stats.ignoredUnverifiedClientHellos++;
                                if (digest === initialHelloDigest) stats.ignoredStaleClientHellos++;
                                return false;
                            }
                            if (body[cookieOffset] === 0 && server.dtls.flight < 4) {
                                initialHelloDigest = digest;
                                initialRandomDigest = randomDigest;
                            }
                            return true;
                        });
                        return accepted.length ? originalHandle.call(this, accepted) : Promise.resolve();
                    };
                    server.onHandleHandshakes = handle;
                    const cipher = server.cipher;
                    const originalDecrypt = cipher?.decryptPacket;
                    const decrypt = function (this: any, ...values: any[]) {
                        try { return originalDecrypt.apply(this, values); }
                        catch (error) { stats.decryptFailures++; throw error; }
                    };
                    if (typeof originalDecrypt === 'function') cipher.decryptPacket = decrypt;
                    stopHandshakeGuard = () => {
                        initialHelloDigest = undefined;
                        initialRandomDigest = undefined;
                        if (server.onHandleHandshakes === handle) server.onHandleHandshakes = originalHandle;
                        if (cipher?.decryptPacket === decrypt) cipher.decryptPacket = originalDecrypt;
                    };
                }
            }
            const replay = pending;
            pending = [];
            pendingBytes = 0;
            clearTimeout(expiry);
            for (const packet of replay) {
                stats.replayedClientHellos++;
                // Direct receiver delivery avoids duplicating the ICE event
                // or counting the replay as another network datagram.
                socket.onData(packet);
            }
        } else discard();
        return result;
    };
    connection.send = send;
    dtls.start = start;
    const state = dtls.onStateChange?.subscribe((value: string) => {
        if (value === 'connected') stopStartupObservations();
        if (['closed', 'failed'].includes(value)) dispose();
    });
    function stopStartupObservations() {
        accepting = false;
        discard();
        incoming.unSubscribe();
        if (connection.send === send) connection.send = originalSend;
        if (dtls.start === start) dtls.start = originalStart;
    }
    function dispose() {
        if (disposed) return;
        disposed = true;
        stopStartupObservations();
        state?.unSubscribe();
        stopHandshakeGuard?.();
        stopHandshakeGuard = undefined;
    }
    return dispose;
}
