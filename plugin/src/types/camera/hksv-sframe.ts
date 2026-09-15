import { createCipheriv, createHmac, hkdfSync, randomBytes } from 'crypto';
import { RtpHeader, RtpPacket } from '@koush/werift-src/packages/rtp/src/index';

const MAX_UINT64 = (1n << 64n) - 1n;
const MAX_FRAME = 8 * 1024 * 1024;

function uint64(value: bigint): Buffer {
    if (value < 0n || value > MAX_UINT64) throw new Error('SFrame integer out of range');
    const b = Buffer.alloc(8); b.writeBigUInt64BE(value); return b;
}

/** RFC 9605 §4.3: the compact KID and counter are independent. */
export function sframeHeader(kid: bigint, counter: bigint): Buffer {
    const compact = (value: bigint) => {
        const full = uint64(value);
        if (value < 8n) return { bits: Number(value), bytes: Buffer.alloc(0) };
        let offset = 0; while (!full[offset]) ++offset;
        const bytes = full.subarray(offset);
        return { bits: 8 | (bytes.length - 1), bytes };
    };
    const k = compact(kid), c = compact(counter);
    return Buffer.concat([Buffer.from([(k.bits << 4) | c.bits]), k.bytes, c.bytes]);
}

/** RFC 9605 + registered AES-256 suites (draft-barnes-sframe-iana-256-06).
 * Apple AVConference uses suite 6 for HEVC and suite 8 for Opus. Its RTP derivation
 * binds each key to the final sender SSRC, before the RFC key/salt derivation.
 */
export class SFrameEncryptor {
    private key: Buffer;
    private salt: Buffer;
    private counter = 0n;
    private closed = false;
    private tagLength: number;

    constructor(baseKey: Buffer, readonly kid: bigint, suite: 6 | 7 | 8 = 6, ssrc?: number) {
        uint64(kid);
        if (baseKey.length < 16 || ![6, 7, 8].includes(suite)) throw new Error('Invalid SFrame key or suite');
        this.tagLength = suite === 6 ? 10 : suite === 7 ? 8 : 4;
        let streamKey = Buffer.from(baseKey);
        if (ssrc !== undefined) {
            if (!Number.isInteger(ssrc) || ssrc < 0 || ssrc > 0xffffffff) throw new Error('Invalid SFrame SSRC');
            const salt = Buffer.alloc(4); salt.writeUInt32BE(ssrc);
            const derived = Buffer.from(hkdfSync('sha512', streamKey, salt, Buffer.from('SFrame 1.0 RTP Stream'), 64));
            streamKey.fill(0); streamKey = derived;
        }
        const context = Buffer.concat([uint64(kid), Buffer.from([0, suite])]);
        try {
            this.key = Buffer.from(hkdfSync('sha512', streamKey, Buffer.alloc(0),
                Buffer.concat([Buffer.from('SFrame 1.0 Secret key '), context]), 96));
            this.salt = Buffer.from(hkdfSync('sha512', streamKey, Buffer.alloc(0),
                Buffer.concat([Buffer.from('SFrame 1.0 Secret salt '), context]), 12));
        }
        finally { streamKey.fill(0); }
    }

    encrypt(plaintext: Buffer, metadata = Buffer.alloc(0)): Buffer {
        if (this.closed || this.counter > MAX_UINT64) throw new Error('SFrame sender closed or counter exhausted');
        if (plaintext.length > MAX_FRAME || metadata.length > 64) throw new Error('SFrame frame too large');
        // Consume before encryption: an error must never allow nonce reuse.
        const counter = this.counter++, header = sframeHeader(this.kid, counter);
        // r43: build the 16-byte counter block in place; its first 12 bytes are the nonce.
        const block = Buffer.alloc(16); this.salt.copy(block); const ctr = uint64(counter);
        for (let i = 0; i < 8; ++i) block[i + 4] ^= ctr[i];
        const nonce = block.subarray(0, 12);
        const cipher = createCipheriv('aes-256-ctr', this.key.subarray(0, 32), block);
        // r43: AES-CTR is a stream cipher, so final() is empty and update() already
        // returned the whole ciphertext. Concatenating copied every frame again.
        const head = cipher.update(plaintext), tail = cipher.final();
        const ciphertext = tail.length ? Buffer.concat([head, tail]) : head;
        const tag = createHmac('sha512', this.key.subarray(32))
            .update(uint64(BigInt(header.length + metadata.length)))
            .update(uint64(BigInt(ciphertext.length)))
            .update(uint64(BigInt(this.tagLength)))
            .update(nonce).update(header).update(metadata).update(ciphertext).digest().subarray(0, this.tagLength);
        return Buffer.concat([header, ciphertext, tag]);
    }

    close(): void { this.closed = true; this.key.fill(0); this.salt.fill(0); }
}

/** RFC 7798 input, complete HEVC access units with 4-byte NAL lengths output.
 * The native AVConference encoder uses this layout before SFrame encryption.
 * FFmpeg's local RTSP/TCP supplies ordered packets; gaps discard the whole AU.
 */
export class HevcAccessUnitAssembler {
    private timestamp?: number;
    private ssrc?: number;
    private nextSequence?: number;
    private nals: Buffer[] = [];
    private fragments?: Buffer[];
    private fragmentHeader?: Buffer;
    private size = 0;
    private damaged = false;

    reset(): void {
        this.timestamp = this.ssrc = this.nextSequence = undefined;
        this.clearFrame();
    }
    private clearFrame(): void {
        this.nals = []; this.fragments = this.fragmentHeader = undefined;
        this.size = 0; this.damaged = false;
    }
    /** r43: `owned` marks a buffer this assembler allocated itself, so a defragmented
     * FU is kept as is instead of being copied a second time. */
    private add(nal: Buffer, owned = false): void {
        if (nal.length < 2 || (nal[0] & 128) || !(nal[1] & 7) || ((nal[0] >> 1) & 63) >= 48)
            throw new Error('Invalid HEVC NAL');
        this.nals.push(owned ? nal : Buffer.from(nal));
    }
    push(packet: RtpPacket): Buffer | undefined {
        const h = packet.header, p = packet.payload;
        const changed = h.timestamp !== this.timestamp || h.ssrc !== this.ssrc;
        if (changed) { this.clearFrame(); this.timestamp = h.timestamp; this.ssrc = h.ssrc; }
        else if (this.nextSequence !== h.sequenceNumber) this.damaged = true;
        this.nextSequence = (h.sequenceNumber + 1) & 65535;
        this.size += p.length + 4;
        if (this.size > MAX_FRAME) this.damaged = true;
        if (!this.damaged) {
            try {
                if (p.length < 2 || (p[0] & 128) || !(p[1] & 7)) throw new Error('Invalid HEVC payload');
                const type = (p[0] >> 1) & 63;
                if (type === 49) {
                    if (p.length < 4 || (p[2] & 0xc0) === 0xc0) throw new Error('Invalid HEVC FU');
                    const header = Buffer.from([(p[0] & 0x81) | ((p[2] & 63) << 1), p[1]]);
                    if (p[2] & 128) {
                        if (this.fragments) throw new Error('Overlapping HEVC FU');
                        this.fragmentHeader = header; this.fragments = [header];
                    }
                    if (!this.fragments || !header.equals(this.fragmentHeader)) throw new Error('Missing HEVC FU');
                    this.fragments.push(Buffer.from(p.subarray(3)));
                    if (p[2] & 64) { this.add(Buffer.concat(this.fragments), true); this.fragments = this.fragmentHeader = undefined; }
                }
                else {
                    if (this.fragments) throw new Error('Incomplete HEVC FU');
                    if (type === 48) {
                        let offset = 2, count = 0;
                        while (offset < p.length) {
                            if (offset + 2 > p.length) throw new Error('Invalid HEVC AP');
                            const length = p.readUInt16BE(offset); offset += 2;
                            if (length < 2 || offset + length > p.length) throw new Error('Invalid HEVC AP');
                            this.add(p.subarray(offset, offset + length)); offset += length; ++count;
                        }
                        if (count < 2) throw new Error('Invalid HEVC AP');
                    }
                    else this.add(p);
                }
            }
            catch { this.damaged = true; }
        }
        if (this.damaged) { this.nals = []; this.fragments = this.fragmentHeader = undefined; }
        if (!h.marker) return;
        let frame: Buffer | undefined;
        if (!this.damaged && !this.fragments && this.nals.length) {
            // r43: size the access unit once and write the 4-byte lengths in place,
            // instead of a length buffer per NAL and a list twice as long as the frame.
            let total = 0;
            for (const nal of this.nals) total += nal.length + 4;
            frame = Buffer.allocUnsafe(total);
            let offset = 0;
            for (const nal of this.nals) {
                frame.writeUInt32BE(nal.length, offset); offset += 4;
                nal.copy(frame, offset); offset += nal.length;
            }
        }
        this.clearFrame();
        // A second packet with the same completed timestamp cannot form a new AU.
        this.damaged = true;
        return frame;
    }
}

/** S/E fragmentation byte, followed by slices of one SFrame ciphertext.
 * Keep this sender across reoffers so counters and output sequences never reset.
 */
export class SFrameRtpSender {
    readonly assembler = new HevcAccessUnitAssembler();
    private encryptor: SFrameEncryptor;
    private sequence = randomBytes(2).readUInt16BE();
    constructor(key: Buffer, kid: bigint, readonly ssrc: number, private video: boolean, private readonly maxSlice = 1100, private readonly observeFrame?: (frame: Buffer, header: RtpHeader, encrypted: Buffer) => void) {
        if (!Number.isInteger(ssrc) || ssrc < 0 || ssrc > 0xffffffff) throw new Error('Invalid SFrame sender SSRC');
        if (!Number.isInteger(maxSlice) || maxSlice < 64 || maxSlice > 1200) throw new Error('Invalid SFrame slice size');
        // iPhone's negotiated media blob specifies SHA512_80 for video and
        // SHA512_32 for audio. The suite enters HKDF as well as the tag length;
        // truncating a suite-6 audio tag cannot produce valid suite-8 media.
        this.encryptor = new SFrameEncryptor(key, kid, video ? 6 : 8, ssrc);
    }
    push(packet: RtpPacket): RtpPacket[] {
        const frame = this.video ? this.assembler.push(packet) : packet.payload;
        if (!frame) return [];
        const encrypted = this.encryptor.encrypt(frame), packets: RtpPacket[] = [];
        try { this.observeFrame?.(frame, packet.header, encrypted); } catch (_) { /* Diagnostics cannot interrupt media. */ }
        // Headroom for SRTP authentication, RTP extensions and IP/UDP headers;
        // remote sessions use a smaller slice for relay and tunnel overhead.
        const limit = this.maxSlice;
        for (let offset = 0; offset < encrypted.length; offset += limit) {
            const end = offset + limit >= encrypted.length;
            // r43: one allocation and one copy per slice.
            const slice = Math.min(limit, encrypted.length - offset);
            const payload = Buffer.allocUnsafe(slice + 1);
            payload[0] = (offset === 0 ? 128 : 0) | (end ? 64 : 0);
            encrypted.copy(payload, 1, offset, offset + slice);
            packets.push(new RtpPacket(new RtpHeader({ version: 2, payloadType: packet.header.payloadType,
                timestamp: packet.header.timestamp, ssrc: this.ssrc, sequenceNumber: this.sequence++ & 65535,
                marker: this.video ? end : packet.header.marker }), payload));
        }
        return packets;
    }
    resetFrame(): void { this.assembler.reset(); }
    close(): void { this.assembler.reset(); this.encryptor.close(); }
}
