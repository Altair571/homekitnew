/** r35 diagnostic observer. Never changes a packet or a signaling decision.
 * Only bounded counters and public RTP/KID identifiers leave this module.
 * Media, keys and SDP credentials are never logged or written to disk.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, timingSafeEqual } from 'crypto';
import { spawn } from 'child_process';
import sdk from '@scrypted/sdk';

type Kind = 'video' | 'audio';
const MAX_FRAME = 1024 * 1024;
const hex = (n: number) => (n >>> 0).toString(16).padStart(8, '0');
const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(n); return b; };
const digest = (b: Buffer) => createHash('sha256').update(b).digest();
const equal = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);

// Independent HKDF extract/expand, not the production SFrame encryptor.
function hkdf(key: Buffer, salt: Buffer, info: Buffer, length: number): Buffer {
    const prk = createHmac('sha512', salt).update(key).digest();
    let last = Buffer.alloc(0); const chunks: Buffer[] = [];
    try {
        for (let i = 1, size = 0; size < length; i++, size += 64) {
            last = createHmac('sha512', prk).update(last).update(info).update(Buffer.from([i])).digest();
            chunks.push(last);
        }
        return Buffer.concat(chunks).subarray(0, length);
    } finally { prk.fill(0); for (const b of chunks) b.fill(0); }
}

/** RFC 3711 AES-CM KDF; independent from werift's SRTP implementation. */
function srtpKey(key: Buffer, salt: Buffer, label: number, length: number): Buffer {
    if (key.length !== 16 || ![12, 14].includes(salt.length)) throw Error('unsupported');
    const iv = Buffer.alloc(16); salt.copy(iv); iv[7] ^= label;
    const c = createCipheriv('aes-128-ctr', key, iv);
    return Buffer.concat([c.update(Buffer.alloc(length)), c.final()]);
}

function sframeHeader(frame: Buffer) {
    if (!frame.length) throw Error('header');
    let offset = 1;
    const field = (bits: number) => {
        if (!(bits & 8)) return BigInt(bits);
        const size = (bits & 7) + 1;
        if (offset + size > frame.length) throw Error('header');
        let value = 0n; for (let i = 0; i < size; i++) value = (value << 8n) | BigInt(frame[offset++]);
        return value;
    };
    const kid = field(frame[0] >>> 4), counter = field(frame[0] & 15);
    return { kid, counter, offset };
}

export function createWebRTCMediaProbe(session: any, now: () => number = () => performance.now()) {
    const started = now(), elapsed = () => Math.max(0, Math.round(now() - started));
    let closed = false;
    const cleanups: (() => void)[] = [];
    const secrets: Buffer[] = [];
    const seenCrypto = new WeakSet<object>();
    const contexts = new Map<any, any>();
    const make = () => ({ inputPackets: 0, inputMarkers: 0, inputSequenceDiscontinuities: 0,
        sourceFrames: 0, sourceBytes: 0, sourceInvalidNalFrames: 0,
        sourceIrapFrames: 0, sourceVpsFrames: 0, sourceSpsFrames: 0, sourcePpsFrames: 0,
        rtpPackets: 0, udpPackets: 0, srtpVerified: 0, srtpAuthFailures: 0,
        srtpPayloadMatches: 0, srtpPayloadMismatches: 0, srtpExpectedMissing: 0,
        srtpUnsupported: 0, srtpParseFailures: 0, sequenceDiscontinuities: 0,
        duplicateOrLatePackets: 0, sframeFrames: 0, sframeSampled: 0,
        sframeVerified: 0, sframeAuthFailures: 0, sframeKidMismatches: 0,
        sframeCounterRegressions: 0, sframeMalformed: 0, sframeUnsupportedOrigin: 0,
        sframeIncomplete: 0, sframeOversizeSkipped: 0, sframeSourceMatches: 0,
        sframeSourceMismatches: 0, sframeSourceMissing: 0, markerMismatches: 0,
        reportBlocks: 0, rrBlocks: 0, srBlocks: 0, reportSequenceMatches: 0,
        reportSequenceUnknown: 0, outgoingSr: 0, diagnosticsErrors: 0 } as Record<string, any>);
    const stats = { video: make(), audio: make() };
    const raw = { inboundDatagrams: 0, inboundDecryptCompleted: 0, inboundDecryptErrors: 0,
        inboundAuthVerified: 0, inboundAuthFailures: 0, inboundAuthUnsupported: 0,
        inboundPlaintextMatches: 0, inboundPlaintextMismatches: 0,
        compoundPackets: 0, malformed: 0, sr: 0, rr: 0, sdes: 0, bye: 0,
        feedback: 0, other: 0, emptyReportPackets: 0, unknownReportBlocks: 0,
        outgoingDatagrams: 0, outgoingEncryptCompleted: 0, outgoingEncryptErrors: 0,
        installedCryptoContexts: 0, observationErrors: 0 };
    const state: Record<Kind, any> = {
        video: { expected: new Map(), source: new Map(), sequences: new Uint8Array(65536), lastSample: -Infinity },
        audio: { expected: new Map(), source: new Map(), sequences: new Uint8Array(65536), lastSample: -Infinity },
    };
    const reports: any[] = [], unknownReports: any[] = [];
    const decoder: any = { status: 'waiting-for-keyframe', attempts: 0, decodedFrames: 0,
        inputBytes: 0, stderrBytes: 0, errors: {} };
    let decoderProcess: any, decoderTimer: any, decoderInput: Buffer | undefined;
    const parameters = new Map<number, Buffer>();
    const kindFor = (ssrc: number): Kind | undefined => ssrc === session.videoTransceiver?.sender?.ssrc ? 'video'
        : ssrc === session.audioTransceiver?.sender?.ssrc ? 'audio' : undefined;
    const safely = (fn: () => void) => { if (!closed) try { fn(); } catch (_) { raw.observationErrors++; } };
    const boundedSet = (map: Map<any, Buffer>, key: number | string, value: Buffer) => {
        map.get(key)?.fill(0); map.delete(key); map.set(key, value);
        if (map.size > 256) { const first = map.keys().next().value; map.get(first)?.fill(0); map.delete(first); }
    };

    function reportBlock(b: Buffer, offset: number, origin: number, type: number) {
        const target = b.readUInt32BE(offset), kind = kindFor(target), highest = b.readUInt32BE(offset + 8);
        const row = { atMs: elapsed(), type, originSsrc: hex(origin), targetSsrc: hex(target), kind: kind ?? 'other',
            highestSequence: highest, fractionLost: b[offset + 4], packetsLost: b.readIntBE(offset + 5, 3),
            jitter: b.readUInt32BE(offset + 12), lsr: b.readUInt32BE(offset + 16), dlsr: b.readUInt32BE(offset + 20) };
        if (!kind) {
            raw.unknownReportBlocks++;
            if (unknownReports.length < 8) unknownReports.push(row);
            return;
        }
        const s = stats[kind]; s.reportBlocks++; s[type === 200 ? 'srBlocks' : 'rrBlocks']++;
        if (state[kind].sequences[highest & 65535]) s.reportSequenceMatches++; else s.reportSequenceUnknown++;
        s.firstReportAtMs ??= row.atMs; s.lastReport = row;
        // First six plus most recent six report blocks, across both streams.
        if (reports.length === 12) reports.splice(6, 1);
        reports.push(row);
    }

    function rtcp(data: Buffer, incoming: boolean) {
        let offset = 0;
        while (offset < data.length) {
            if (data.length - offset < 4 || data[offset] >>> 6 !== 2) { raw.malformed++; return; }
            const bytes = (data.readUInt16BE(offset + 2) + 1) * 4;
            if (offset + bytes > data.length) { raw.malformed++; return; }
            const b = data.subarray(offset, offset + bytes), count = b[0] & 31, type = b[1];
            let length = b.length;
            if (b[0] & 32) {
                const padding = b[b.length - 1];
                if (!padding || padding > b.length - 4 || offset + bytes !== data.length) { raw.malformed++; return; }
                length -= padding;
            }
            if (type === 200 || type === 201) {
                const base = type === 200 ? 28 : 8;
                if (length < base + count * 24) { raw.malformed++; return; }
                const origin = b.readUInt32BE(4);
                if (incoming) {
                    raw.compoundPackets++; raw[type === 200 ? 'sr' : 'rr']++;
                    if (!count) raw.emptyReportPackets++;
                    for (let i = 0; i < count; i++) reportBlock(b, base + i * 24, origin, type);
                } else if (type === 200) {
                    const kind = kindFor(origin);
                    if (kind) {
                        stats[kind].outgoingSr++;
                        stats[kind].lastOutgoingSr = { atMs: elapsed(), ssrc: hex(origin),
                            rtpTimestamp: b.readUInt32BE(16), packetCount: b.readUInt32BE(20), octetCount: b.readUInt32BE(24) };
                    }
                }
            } else if (incoming) {
                raw.compoundPackets++;
                if (type === 202) raw.sdes++; else if (type === 203) raw.bye++;
                else if (type === 205 || type === 206) raw.feedback++; else raw.other++;
            }
            offset += bytes;
        }
    }

    function cryptoContext(dtls: any) {
        const config = dtls.srtp?.config;
        if (!config || ![1, 7].includes(config.profile)) return;
        if (contexts.has(config)) return contexts.get(config);
        // Bound retained key schedules even if a peer repeatedly rekeys.
        if (contexts.size >= 8) return;
        const keys = config.keys;
        const c = { enc: srtpKey(keys.localMasterKey, keys.localMasterSalt, 0, 16),
            auth: srtpKey(keys.localMasterKey, keys.localMasterSalt, 1, 20),
            salt: srtpKey(keys.localMasterKey, keys.localMasterSalt, 2, 14),
            rtcpAuth: srtpKey(keys.remoteMasterKey, keys.remoteMasterSalt, 4, 20),
            rtcpEnc: srtpKey(keys.remoteMasterKey, keys.remoteMasterSalt, 3, 16),
            rtcpSalt: srtpKey(keys.remoteMasterKey, keys.remoteMasterSalt, 5, 14),
            profile: config.profile, tagLength: config.profile === 7 ? 16 : 10, indexes: new Map<number, number>() };
        secrets.push(c.enc, c.auth, c.salt, c.rtcpAuth, c.rtcpEnc, c.rtcpSalt); contexts.set(config, c);
        return c;
    }

    function verifyRtcp(data: Buffer, c: any): Buffer {
        if (data.length < 8 + 4 + c.tagLength) throw Error('short');
        const wordOffset = data.length - (c.profile === 7 ? 4 : 14);
        const word = data.readUInt32BE(wordOffset), index = word & 0x7fffffff, encrypted = !!(word & 0x80000000);
        if (c.profile === 7) {
            const iv = Buffer.alloc(12); iv.writeUInt32BE(data.readUInt32BE(4), 2); iv.writeUInt32BE(index, 8);
            for (let i = 0; i < 12; i++) iv[i] ^= c.rtcpSalt[i];
            const d = createDecipheriv('aes-128-gcm', c.rtcpEnc, iv);
            d.setAAD(Buffer.concat([data.subarray(0, encrypted ? 8 : -20), data.subarray(-4)]));
            d.setAuthTag(data.subarray(-20, -4));
            const body = Buffer.concat([d.update(encrypted ? data.subarray(8, -20) : Buffer.alloc(0)), d.final()]);
            return encrypted ? Buffer.concat([data.subarray(0, 8), body]) : Buffer.from(data.subarray(0, -20));
        }
        if (!equal(createHmac('sha1', c.rtcpAuth).update(data.subarray(0, -10)).digest().subarray(0, 10), data.subarray(-10))) throw Error('tag');
        if (!encrypted) return Buffer.from(data.subarray(0, -14));
        const iv = Buffer.alloc(16); c.rtcpSalt.copy(iv);
        const xor = Buffer.alloc(16); xor.writeUInt32BE(data.readUInt32BE(4), 4); xor.writeUIntBE(index, 8, 6);
        for (let i = 0; i < 16; i++) iv[i] ^= xor[i];
        const d = createDecipheriv('aes-128-ctr', c.rtcpEnc, iv);
        return Buffer.concat([data.subarray(0, 8), d.update(data.subarray(8, -14)), d.final()]);
    }

    // One small, memory-only decode per session. A failure cannot stop camera media.
    // No camera URL or media file is passed to the child: only Annex-B over stdin.
    function decodeSample(frame: Buffer, types: Set<number>) {
        if (decoder.attempts || closed) return;
        const nals: Buffer[] = [];
        for (let offset = 0; offset < frame.length;) {
            const size = frame.readUInt32BE(offset); offset += 4;
            const nal = frame.subarray(offset, offset + size); offset += size;
            const type = (nal[0] >>> 1) & 63;
            if ([32, 33, 34].includes(type) && nal.length <= 16384) {
                parameters.get(type)?.fill(0); parameters.set(type, Buffer.from(nal));
            }
            nals.push(nal);
        }
        if (![...types].some(t => t >= 16 && t <= 23)) return;
        if (![32, 33, 34].every(type => parameters.has(type))) { decoder.status = 'waiting-for-parameter-sets'; return; }
        if (frame.length > MAX_FRAME) { decoder.status = 'sample-too-large'; return; }
        decoder.attempts++; decoder.status = 'starting';
        const parts: Buffer[] = [];
        for (const nal of [...parameters.values(), ...nals]) parts.push(Buffer.from([0, 0, 0, 1]), nal);
        decoderInput = Buffer.concat(parts); decoder.inputBytes = decoderInput.length;
        const release = () => { decoderInput?.fill(0); decoderInput = undefined; };
        decoderTimer = setTimeout(() => {
            if (!closed && ['starting', 'running'].includes(decoder.status)) decoder.status = 'timeout';
            decoderProcess?.kill('SIGKILL'); release();
        }, 8000); decoderTimer.unref?.();
        void (async () => {
            try {
                const ffmpeg = await sdk.mediaManager.getFFmpegPath();
                if (closed || !decoderInput || decoder.status !== 'starting') return;
                const input = decoderInput;
                const child = decoderProcess = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostats', '-xerror',
                    '-threads', '1', '-f', 'hevc', '-i', 'pipe:0', '-map', '0:v:0', '-frames:v', '1',
                    '-progress', 'pipe:1', '-f', 'null', '-'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
                decoder.status = 'running'; let pending = '';
                child.stdout.on('data', (data: Buffer) => {
                    if (closed) return;
                    pending = (pending + data.toString()).slice(-8192);
                    const lines = pending.split('\n'); pending = lines.pop() ?? '';
                    for (const line of lines) {
                        const m = /^frame=\s*(\d{1,6})\s*$/.exec(line);
                        if (m) decoder.decodedFrames = Math.max(decoder.decodedFrames, +m[1]);
                    }
                });
                child.stderr.on('data', (data: Buffer) => {
                    if (closed) return;
                    decoder.stderrBytes += data.length;
                    const message = data.toString().toLowerCase();
                    for (const [needle, label] of [['invalid data', 'invalid-data'], ['error while decoding', 'decode-error'],
                        ['could not find ref', 'missing-reference'], ['no frame', 'no-frame'], ['missing picture', 'missing-picture'],
                        ['invalid nal', 'invalid-nal']] as const)
                        if (message.includes(needle)) decoder.errors[label] = (decoder.errors[label] ?? 0) + 1;
                });
                child.stdin.on('error', () => { /* Process completion determines the result. */ });
                child.once('error', () => { if (!closed) decoder.status = 'process-error'; release(); clearTimeout(decoderTimer); });
                child.once('close', (code: number | null) => {
                    clearTimeout(decoderTimer); release(); decoderProcess = undefined;
                    if (closed || ['timeout', 'process-error'].includes(decoder.status)) return;
                    decoder.exitCode = code;
                    decoder.status = code === 0 && decoder.decodedFrames > 0 ? 'decoded' : 'decode-failed';
                });
                child.stdin.end(input, release);
            } catch (_) {
                clearTimeout(decoderTimer); release(); if (!closed) decoder.status = 'unavailable';
            }
        })();
    }

    function sframe(kind: Kind, payload: Buffer, h: any) {
        if (!session.sframeConfiguration) return;
        const s = stats[kind], st = state[kind];
        if (payload.length < 2 || (payload[0] & 31)) { s.sframeMalformed++; return; }
        const start = !!(payload[0] & 128), end = !!(payload[0] & 64), origin = payload[0] & 32;
        if (start) {
            if (st.frame) s.sframeIncomplete++;
            s.sframeFrames++;
            const sample = s.sframeSampled < 12 || now() - st.lastSample >= 5000;
            if (sample) { st.lastSample = now(); s.sframeSampled++; }
            st.frame = { timestamp: h.timestamp, next: h.sequenceNumber, origin, size: 0, parts: sample ? [] : undefined };
        }
        const f = st.frame;
        if (!f) return;
        if (f.timestamp !== h.timestamp || f.next !== h.sequenceNumber || f.origin !== origin) {
            s.sframeIncomplete++; st.frame = undefined; return;
        }
        f.next = (h.sequenceNumber + 1) & 65535; f.size += payload.length - 1;
        if (f.size > MAX_FRAME) { s.sframeOversizeSkipped++; st.frame = undefined; return; }
        f.parts?.push(Buffer.from(payload.subarray(1)));
        if (kind === 'video' && h.marker !== end) s.markerMismatches++;
        if (!end) return;
        st.frame = undefined;
        if (!f.parts) return;
        const frame = Buffer.concat(f.parts);
        for (const part of f.parts) part.fill(0);
        let key: Buffer | undefined, salt: Buffer | undefined, stream: Buffer | undefined, plaintext: Buffer | undefined;
        try {
            const { kid, counter, offset: pos } = sframeHeader(frame), config = session.sframeConfiguration;
            if (kid !== config.kid) { s.sframeKidMismatches++; return; }
            const suite = kind === 'video' ? 6 : 8, tagLength = kind === 'video' ? 10 : 4;
            if (frame.length < pos + tagLength) { s.sframeMalformed++; return; }
            const ss = Buffer.alloc(4); ss.writeUInt32BE(h.ssrc);
            stream = hkdf(config.key, ss, Buffer.from('SFrame 1.0 RTP Stream'), 64);
            const context = Buffer.concat([u64(kid), Buffer.from([0, suite])]);
            key = hkdf(stream, Buffer.alloc(0), Buffer.concat([Buffer.from('SFrame 1.0 Secret key '), context]), 96);
            salt = hkdf(stream, Buffer.alloc(0), Buffer.concat([Buffer.from('SFrame 1.0 Secret salt '), context]), 12);
            const ctr = u64(counter); for (let i = 0; i < 8; i++) salt[i + 4] ^= ctr[i];
            const header = frame.subarray(0, pos), ciphertext = frame.subarray(pos, -tagLength);
            const tag = createHmac('sha512', key.subarray(32)).update(u64(BigInt(pos)))
                .update(u64(BigInt(ciphertext.length))).update(u64(BigInt(tagLength)))
                .update(salt).update(header).update(ciphertext).digest().subarray(0, tagLength);
            if (!equal(tag, frame.subarray(-tagLength))) { s.sframeAuthFailures++; return; }
            s.sframeVerified++;
            if (st.counter !== undefined && counter <= st.counter) s.sframeCounterRegressions++;
            st.counter = counter; s.lastSframeCounter = counter.toString();
            if (origin) { s.sframeUnsupportedOrigin++; return; }
            const d = createDecipheriv('aes-256-ctr', key.subarray(0, 32), Buffer.concat([salt, Buffer.alloc(4)]));
            plaintext = Buffer.concat([d.update(ciphertext), d.final()]);
            // Werift offsets RTP timestamps. The authenticated SFrame counter
            // survives that rewrite and identifies the source frame exactly.
            const expected = st.source.get(counter.toString());
            if (!expected) s.sframeSourceMissing++;
            else if (equal(digest(plaintext), expected)) s.sframeSourceMatches++; else s.sframeSourceMismatches++;
        } catch (_) { s.sframeMalformed++; }
        finally { frame.fill(0); key?.fill(0); salt?.fill(0); stream?.fill(0); plaintext?.fill(0); }
    }

    function udp(kind: Kind, data: Buffer, dtls: any) {
        const s = stats[kind], st = state[kind]; s.udpPackets++;
        const c = cryptoContext(dtls);
        if (!c) { s.srtpUnsupported++; return; }
        s.srtpProfile = c.profile;
        if (data.length < 12 + c.tagLength || data[0] >>> 6 !== 2) { s.srtpParseFailures++; return; }
        const seq = data.readUInt16BE(2), ssrc = data.readUInt32BE(8);
        let offset = 12 + (data[0] & 15) * 4;
        if (data[0] & 16) {
            if (offset + 4 > data.length - c.tagLength) { s.srtpParseFailures++; return; }
            offset += 4 + data.readUInt16BE(offset + 2) * 4;
        }
        if (offset > data.length - c.tagLength) { s.srtpParseFailures++; return; }
        const last = c.indexes.get(ssrc);
        let index = last === undefined ? seq : Math.floor(last / 65536) * 65536 + seq;
        if (last !== undefined && index - last > 32768) index -= 65536;
        else if (last !== undefined && last - index > 32768) index += 65536;
        if (index < 0) { s.srtpParseFailures++; return; }
        const roc = Buffer.alloc(4); roc.writeUInt32BE(Math.floor(index / 65536));
        let plaintext: Buffer;
        if (c.profile === 7) {
            const iv = Buffer.alloc(12); iv.writeUInt32BE(ssrc, 2); iv.writeUInt32BE(Math.floor(index / 65536), 6); iv.writeUInt16BE(seq, 10);
            for (let i = 0; i < 12; i++) iv[i] ^= c.salt[i];
            const d = createDecipheriv('aes-128-gcm', c.enc, iv);
            d.setAAD(data.subarray(0, offset)); d.setAuthTag(data.subarray(-16));
            try { plaintext = Buffer.concat([d.update(data.subarray(offset, -16)), d.final()]); }
            catch (_) { s.srtpAuthFailures++; return; }
        } else {
            const tag = createHmac('sha1', c.auth).update(data.subarray(0, -c.tagLength)).update(roc).digest().subarray(0, c.tagLength);
            if (!equal(tag, data.subarray(-c.tagLength))) { s.srtpAuthFailures++; return; }
            const iv = Buffer.alloc(16); c.salt.copy(iv);
            const xor = Buffer.alloc(16); xor.writeUInt32BE(ssrc, 4); xor.writeUIntBE(index, 8, 6);
            for (let i = 0; i < 16; i++) iv[i] ^= xor[i];
            const d = createDecipheriv('aes-128-ctr', c.enc, iv);
            plaintext = Buffer.concat([d.update(data.subarray(offset, -c.tagLength)), d.final()]);
        }
        c.indexes.set(ssrc, Math.max(last ?? index, index)); s.srtpVerified++;
        try {
            let payload = plaintext;
            if (data[0] & 32) {
                const n = payload[payload.length - 1];
                if (!n || n > payload.length) { s.srtpParseFailures++; return; }
                payload = payload.subarray(0, -n);
            }
            const expected = st.expected.get(seq);
            if (!expected) s.srtpExpectedMissing++;
            else if (equal(expected, digest(payload))) s.srtpPayloadMatches++; else s.srtpPayloadMismatches++;
            st.sequences[seq] = 1;
            if (st.lastIndex !== undefined) {
                if (index <= st.lastIndex) s.duplicateOrLatePackets++;
                else if (index !== st.lastIndex + 1) s.sequenceDiscontinuities++;
            }
            if (st.lastIndex !== undefined && index <= st.lastIndex) return; // Retransmission is not a second SFrame.
            st.lastIndex = index;
            s.firstSequence ??= seq; s.lastSequence = seq; s.firstUdpAtMs ??= elapsed(); s.lastUdpAtMs = elapsed();
            sframe(kind, payload, { ssrc, sequenceNumber: seq, timestamp: data.readUInt32BE(4), marker: !!(data[1] & 128) });
        } finally { plaintext.fill(0); }
    }

    function attachCrypto(dtls: any) {
        const crypto = dtls.srtcp;
        if (!crypto || seenCrypto.has(crypto)) return;
        seenCrypto.add(crypto); raw.installedCryptoContexts++;
        for (const direction of ['decrypt', 'encrypt'] as const) {
            const original = crypto[direction]; if (typeof original !== 'function') continue;
            const hook = function (this: any, data: Buffer) {
                const incoming = direction === 'decrypt';
                let verifiedPlaintext: Buffer | undefined;
                safely(() => {
                    if (incoming) {
                        raw.inboundDatagrams++;
                        const c = cryptoContext(dtls);
                        if (!c) raw.inboundAuthUnsupported++;
                        else {
                            try { verifiedPlaintext = verifyRtcp(data, c); raw.inboundAuthVerified++; }
                            catch (_) { raw.inboundAuthFailures++; }
                        }
                    } else { raw.outgoingDatagrams++; rtcp(data, false); }
                });
                try {
                    const result = original.call(this, data);
                    safely(() => {
                        if (incoming) {
                            raw.inboundDecryptCompleted++;
                            if (verifiedPlaintext) {
                                if (equal(verifiedPlaintext, result)) raw.inboundPlaintextMatches++; else raw.inboundPlaintextMismatches++;
                            }
                            rtcp(verifiedPlaintext ?? result, true);
                        }
                        else raw.outgoingEncryptCompleted++;
                    });
                    return result;
                } catch (error) {
                    if (!closed) raw[incoming ? 'inboundDecryptErrors' : 'outgoingEncryptErrors']++;
                    throw error;
                } finally { verifiedPlaintext?.fill(0); }
            };
            crypto[direction] = hook;
            cleanups.push(() => { if (crypto[direction] === hook) crypto[direction] = original; });
        }
    }

    const api = {
        observeInput(kind: Kind, packet: any) {
            safely(() => {
                const s = stats[kind], st = state[kind], h = packet.header;
                s.inputPackets++; if (h.marker) s.inputMarkers++;
                if (st.inputSequence !== undefined && h.sequenceNumber !== ((st.inputSequence + 1) & 65535)) s.inputSequenceDiscontinuities++;
                st.inputSequence = h.sequenceNumber;
                s.firstInputAtMs ??= elapsed(); s.lastInputAtMs = elapsed();
            });
        },
        installTransport(dtls: any) {
            safely(() => {
                const original = dtls.updateSrtpSession;
                if (typeof original === 'function') {
                    const hook = function (this: any, ...args: any[]) {
                        const result = original.apply(this, args); safely(() => attachCrypto(this)); return result;
                    };
                    dtls.updateSrtpSession = hook;
                    cleanups.push(() => { if (dtls.updateSrtpSession === hook) dtls.updateSrtpSession = original; });
                }
                attachCrypto(dtls);
            });
        },
        sourceFrame(kind: Kind, frame: Buffer, header: any, encrypted?: Buffer) {
            safely(() => {
                const s = stats[kind]; s.sourceFrames++; s.sourceBytes += frame.length;
                if (encrypted) boundedSet(state[kind].source, sframeHeader(encrypted).counter.toString(), digest(frame));
                if (kind !== 'video') return;
                let offset = 0; const types = new Set<number>();
                while (offset < frame.length) {
                    if (offset + 4 > frame.length) { s.sourceInvalidNalFrames++; return; }
                    const size = frame.readUInt32BE(offset); offset += 4;
                    if (size < 2 || offset + size > frame.length || (frame[offset] & 128) || !(frame[offset + 1] & 7)) { s.sourceInvalidNalFrames++; return; }
                    const type = (frame[offset] >>> 1) & 63;
                    if (type >= 48) { s.sourceInvalidNalFrames++; return; }
                    types.add(type); offset += size;
                }
                if ([...types].some(t => t >= 16 && t <= 23)) { s.sourceIrapFrames++; s.firstIrapAtMs ??= elapsed(); s.lastIrapAtMs = elapsed(); }
                for (const [n, field] of [[32, 'sourceVpsFrames'], [33, 'sourceSpsFrames'], [34, 'sourcePpsFrames']] as const) if (types.has(n)) s[field]++;
                decodeSample(frame, types);
            });
        },
        observeRtp(kind: Kind, payload: Buffer, header: any) {
            safely(() => {
                const s = stats[kind]; s.rtpPackets++;
                boundedSet(state[kind].expected, header.sequenceNumber, digest(payload));
                const identity = { ssrc: hex(header.ssrc), payloadType: header.payloadType,
                    timestamp: header.timestamp >>> 0, sequence: header.sequenceNumber,
                    marker: !!header.marker, extensionIds: (header.extensions ?? []).slice(0, 8).map((e: any) => e.id) };
                s.firstRtp ??= identity; s.lastRtp = identity;
            });
        },
        observeUdp(kind: Kind, data: Buffer, dtls: any) { safely(() => udp(kind, data, dtls)); },
        snapshot() {
            const copy = (x: any) => JSON.parse(JSON.stringify(x));
            const video = stats.video, audio = stats.audio;
            const evidence = !video.inputPackets ? 'no-video-input-observed'
                : session.sframeConfiguration && video.inputMarkers && !video.sourceFrames ? 'hevc-assembly-produced-no-frames'
                : !video.rtpPackets ? 'no-video-at-rtp-sender'
                : video.srtpAuthFailures || video.srtpPayloadMismatches ? 'local-srtp-check-failed'
                : video.sframeAuthFailures || video.sframeKidMismatches || video.sframeSourceMismatches || video.sframeCounterRegressions ? 'local-sframe-check-failed'
                : decoder.status === 'decode-failed' ? 'local-hevc-decode-check-failed'
                : raw.inboundAuthFailures ? 'peer-feedback-auth-check-failed'
                : video.reportBlocks ? 'peer-reports-video-reception'
                : audio.reportBlocks ? 'peer-reports-audio-only'
                : 'no-peer-reception-reports-observed';
            return { revision: 35, elapsedMs: elapsed(), utc: new Date().toISOString(), evidence,
                sampling: 'first-12-frames-then-one-per-5s-per-media', maxFrameBytes: MAX_FRAME,
                srtpVerifier: 'independent-aes128-cm-sha1-and-aes128-gcm',
                sframeKeyId: session.sframeConfiguration?.kid?.toString(16).padStart(16, '0'),
                video: copy(video), audio: copy(audio), decoder: copy(decoder), rtcp: copy(raw), reportSamples: copy(reports), unknownReportSamples: copy(unknownReports) };
        },
        dispose() {
            if (closed) return; closed = true;
            clearTimeout(decoderTimer); decoderProcess?.kill('SIGKILL');
            decoderInput?.fill(0); decoderInput = undefined;
            for (const b of parameters.values()) b.fill(0); parameters.clear();
            for (const restore of cleanups.reverse()) try { restore(); } catch (_) { }
            for (const b of secrets) b.fill(0); secrets.length = 0; contexts.clear();
            for (const st of Object.values(state)) {
                for (const map of [st.source, st.expected]) { for (const b of map.values()) b.fill(0); map.clear(); }
                for (const b of st.frame?.parts ?? []) b.fill(0);
                st.frame = undefined; st.sequences.fill(0);
            }
        },
    };
    return api;
}
