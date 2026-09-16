/**
 * hksv-cmaf-protection.ts  (Scrypted HomeKit plugin — iOS/tvOS 27 HKSV direct upload)
 *
 * MPEG Common Encryption ('cenc', ISO/IEC 23001-7) over the fragmented MP4 the recording
 * buffer produces, keyed by the §4.7 Camera Key.
 *
 * WHY THIS EXISTS. On iOS/tvOS 27 a camera uploads its own HKSV clips straight to Apple's
 * publishing point (§4.13) instead of handing fMP4 to a home hub over HDS. The hub is out of
 * the media path, so the clip has to leave the camera already encrypted for the user — which
 * is what the Camera Key Management service (§3.9), new in this specification, provides a key
 * for. Under the legacy path the Apple TV did that job, and no camera key existed.
 *
 * VALIDATE: the HKSV Open Source Compatibility Guide (rev. 2026-06-03) defines the Camera Key
 * TLV (§4.7: Key + Key Number) and its identifier (§4.8) but never states how the key is
 * applied to the media. Nothing else in the guide describes media protection, and its CMAF
 * Error enumeration (§4.11) has no "cannot decrypt" code to read backwards from. This module
 * implements the reading that fits the boxes the guide does define:
 *
 *   - scheme 'cenc' (AES-128-CTR), because CTR preserves sample sizes, so every trun sample
 *     size, tfhd default and mdat length in the recording stays valid;
 *   - subsample encryption for HEVC, leaving each NAL unit's length prefix and header clear,
 *     as ISO/IEC 23001-7 §9.6.2 requires for video in ISO BMFF;
 *   - full-sample encryption for AAC;
 *   - default_KID = the §4.7 Key Number, big-endian in the low 8 bytes, since Key Number is
 *     the only key identifier the guide gives and §4.8 publishes it back to the controller.
 *
 * If Apple's contract turns out to differ, the difference is confined to this module: the IV
 * size, the KID derivation and the scheme are the only choices it makes.
 */

import { createCipheriv } from 'crypto';

/** §4.7 keys are applied as AES-128, the only key length ISO/IEC 23001-7 defines for 'cenc'. */
export const CENC_KEY_BYTES = 16;
/** tenc default_Per_Sample_IV_Size. An 8-byte IV leaves the low 64 bits as the block counter. */
export const CENC_IV_BYTES = 8;
/** saiz carries per-sample auxiliary sizes in a uint8. */
const MAX_SAMPLE_AUX_BYTES = 255;

const VIDEO_SAMPLE_ENTRIES: Record<string, number> = { hvc1: 2, hev1: 2, avc1: 1, avc3: 1 };
const AUDIO_SAMPLE_ENTRIES = new Set(['mp4a']);
/** SampleEntry payload bytes before the child boxes (ISO/IEC 14496-12 §12.1.3/§12.2.3): the
 *  6 reserved bytes and data_reference_index shared by every sample entry, then the visual or
 *  audio fields. Excludes the 8-byte box header. */
const VISUAL_SAMPLE_ENTRY_PRELUDE = 78;
const AUDIO_SAMPLE_ENTRY_PRELUDE = 28;

export interface Mp4Box { type: string; start: number; headerSize: number; size: number }

export function readBoxes(buf: Buffer, start = 0, end = buf.length): Mp4Box[] {
    const boxes: Mp4Box[] = [];
    for (let at = start; at < end;) {
        if (at + 8 > end) throw new Error('Truncated MP4 box header');
        let size = buf.readUInt32BE(at), headerSize = 8;
        const type = buf.toString('ascii', at + 4, at + 8);
        if (size === 1) {
            if (at + 16 > end) throw new Error('Truncated MP4 box header');
            size = Number(buf.readBigUInt64BE(at + 8)); headerSize = 16;
        }
        else if (size === 0) size = end - at;
        if (size < headerSize || at + size > end) throw new Error(`Invalid MP4 ${type} box length`);
        boxes.push({ type, start: at, headerSize, size });
        at += size;
    }
    return boxes;
}

export function box(type: string, ...parts: Buffer[]): Buffer {
    const payload = parts.length === 1 ? parts[0] : Buffer.concat(parts);
    const header = Buffer.alloc(8);
    header.writeUInt32BE(payload.length + 8, 0);
    header.write(type, 4, 'ascii');
    return Buffer.concat([header, payload]);
}

const slice = (buf: Buffer, b: Mp4Box) => buf.subarray(b.start, b.start + b.size);
const children = (buf: Buffer, b: Mp4Box, skip = 0) => readBoxes(buf, b.start + b.headerSize + skip, b.start + b.size);

/** Rebuilds `b`, descending `path` and replacing the box it names. Boxes off the path are copied. */
function rewritePath(buf: Buffer, b: Mp4Box, path: string[], leaf: (child: Mp4Box) => Buffer): Buffer {
    if (!path.length) return leaf(b);
    return box(b.type, ...children(buf, b).map(child =>
        child.type === path[0] ? rewritePath(buf, child, path.slice(1), leaf) : slice(buf, child)));
}

interface ProtectedTrack { kind: 'video' | 'audio'; lengthSize: number; nalHeaderBytes: number }

export interface CmafProtectionSnapshot {
    scheme: string; keyBytes: number; keyNumber: string; kid: string;
    ivSize: number; tracks: { trackId: number; kind: string; format: string }[];
    samplesEncrypted: number; bytesEncrypted: number; clearBytes: number; nextIv: string;
}

export class CmafCencProtection {
    private readonly key: Buffer;
    private readonly keyBytes: number;
    readonly kid: Buffer;
    private readonly tracks = new Map<number, ProtectedTrack>();
    private readonly formats = new Map<number, string>();
    private counter: bigint;
    private samplesEncrypted = 0;
    private bytesEncrypted = 0;
    private clearBytes = 0;

    /**
     * @param key        the §4.7 Camera Key data. Only the first 16 bytes are used; the whole
     *                   length is reported in the snapshot, because the guide does not state it
     *                   and a longer key is the first evidence that this reading is wrong.
     * @param keyNumber  the §4.7 Key Number, which §4.8 publishes back as the Camera Key ID.
     * @param ivCounter  the first per-sample IV to use. A counter never repeats under one key,
     *                   which AES-CTR requires; persist it across clips for a given key number.
     */
    constructor(key: Buffer, readonly keyNumber: bigint, ivCounter = 0n) {
        if (key.length < CENC_KEY_BYTES)
            throw new Error(`Camera Key is ${key.length} bytes; 'cenc' needs at least ${CENC_KEY_BYTES}`);
        this.key = key.subarray(0, CENC_KEY_BYTES);
        this.keyBytes = key.length;
        this.kid = Buffer.alloc(16);
        this.kid.writeBigUInt64BE(BigInt.asUintN(64, keyNumber), 8);
        this.counter = BigInt.asUintN(64, ivCounter);
    }

    /** The next unused IV. Persist it so a later clip under the same key cannot repeat one. */
    get ivCounter(): bigint { return this.counter; }

    snapshot(): CmafProtectionSnapshot {
        return {
            scheme: 'cenc', keyBytes: this.keyBytes, keyNumber: this.keyNumber.toString(),
            kid: this.kid.toString('hex'), ivSize: CENC_IV_BYTES,
            tracks: [...this.tracks].map(([trackId, t]) => ({ trackId, kind: t.kind, format: this.formats.get(trackId)! })),
            samplesEncrypted: this.samplesEncrypted, bytesEncrypted: this.bytesEncrypted,
            clearBytes: this.clearBytes, nextIv: this.counter.toString(),
        };
    }

    // ------------------------------------------------------------------
    // CMAF Header (init segment)
    // ------------------------------------------------------------------

    /** Rewrites the init segment's sample entries as 'encv'/'enca' with a 'cenc' sinf. */
    protectInit(init: Buffer): Buffer {
        this.tracks.clear(); this.formats.clear();
        const out = readBoxes(init).map(top => top.type === 'moov'
            ? box('moov', ...children(init, top).map(child =>
                child.type === 'trak' ? this.protectTrak(init, child) : slice(init, child)))
            : slice(init, top));
        if (!this.tracks.size)
            throw new Error('The recording init segment has no HEVC or AAC track to protect');
        return Buffer.concat(out);
    }

    private protectTrak(buf: Buffer, trak: Mp4Box): Buffer {
        const tkhd = children(buf, trak).find(c => c.type === 'tkhd');
        if (!tkhd) throw new Error('MP4 track has no tkhd');
        const version = buf[tkhd.start + tkhd.headerSize];
        const trackId = buf.readUInt32BE(tkhd.start + tkhd.headerSize + (version ? 20 : 12));
        return rewritePath(buf, trak, ['mdia', 'minf', 'stbl', 'stsd'], stsd => this.protectStsd(buf, stsd, trackId));
    }

    private protectStsd(buf: Buffer, stsd: Mp4Box, trackId: number): Buffer {
        // FullBox version/flags + entry_count precede the sample entries.
        const head = buf.subarray(stsd.start + stsd.headerSize, stsd.start + stsd.headerSize + 8);
        const entries = children(buf, stsd, 8).map(entry => {
            const nalHeaderBytes = VIDEO_SAMPLE_ENTRIES[entry.type];
            const audio = AUDIO_SAMPLE_ENTRIES.has(entry.type);
            if (!nalHeaderBytes && !audio) return slice(buf, entry);
            const payload = buf.subarray(entry.start + entry.headerSize, entry.start + entry.size);
            this.tracks.set(trackId, audio
                ? { kind: 'audio', lengthSize: 0, nalHeaderBytes: 0 }
                : { kind: 'video', lengthSize: nalLengthSize(buf, entry), nalHeaderBytes });
            this.formats.set(trackId, entry.type);
            return box(audio ? 'enca' : 'encv', payload, this.sinf(entry.type));
        });
        return box('stsd', head, ...entries);
    }

    /** ISO/IEC 23001-7 §8.1: the original format, the scheme, and the track encryption defaults. */
    private sinf(originalFormat: string): Buffer {
        const schm = Buffer.alloc(12);
        schm.write('cenc', 4, 'ascii');
        schm.writeUInt32BE(0x00010000, 8); // scheme_version 1.0
        const tenc = Buffer.concat([
            Buffer.from([0, 0, 0, 0]),                  // version 0, flags 0
            Buffer.from([0, 0, 1, CENC_IV_BYTES]),      // reserved, reserved, default_isProtected, IV size
            this.kid,
        ]);
        return box('sinf', box('frma', Buffer.from(originalFormat, 'ascii')), box('schm', schm),
            box('schi', box('tenc', tenc)));
    }

    // ------------------------------------------------------------------
    // CMAF fragments
    // ------------------------------------------------------------------

    /**
     * Encrypts one moof/mdat fragment in place and adds its senc/saiz/saio auxiliary
     * information. Sample sizes are unchanged, so only the trun data offsets move — by the
     * number of bytes the new boxes add to the moof.
     */
    protectFragment(fragment: Buffer): Buffer {
        if (!this.tracks.size) throw new Error('protectInit must run before a fragment is protected');
        const tops = readBoxes(fragment);
        const moofIndex = tops.findIndex(b => b.type === 'moof');
        if (moofIndex < 0 || tops[moofIndex + 1]?.type !== 'mdat')
            throw new Error('Recording fragment is not a moof followed by an mdat');
        const moof = tops[moofIndex], mdat = tops[moofIndex + 1];
        if (moof.headerSize !== 8)
            throw new Error('Recording fragment uses a 64-bit moof header');
        const media = Buffer.from(fragment.subarray(mdat.start + mdat.headerSize, mdat.start + mdat.size));

        const moofKids = children(fragment, moof);
        const plans = moofKids.map(kid => kid.type === 'traf' ? this.planTraf(fragment, moof, mdat, kid, media) : undefined);
        const delta = plans.reduce((n, plan) => n + (plan ? plan.added : 0), 0);
        if (!delta) return fragment;

        let offset = 8; // the moof header precedes its first child
        const rebuilt: Buffer[] = [];
        for (const [i, kid] of moofKids.entries()) {
            const plan = plans[i];
            if (!plan) { rebuilt.push(slice(fragment, kid)); offset += kid.size; continue; }
            const kids = this.rebuildTraf(fragment, kid, plan, delta);
            // saio locates the per-sample auxiliary information: the first IV inside senc,
            // measured from the start of the enclosing moof (ISO/IEC 14496-12 §8.7.9).
            let inner = 8;
            for (let n = 0; n < kids.sencIndex; n++) inner += kids.children[n].length;
            plan.saio.writeUInt32BE(offset + inner + 8 + 4 + 4, plan.saio.length - 4);
            const traf = box('traf', ...kids.children);
            rebuilt.push(traf); offset += traf.length;
        }
        const newMoof = box('moof', ...rebuilt);
        if (newMoof.length !== moof.size + delta)
            throw new Error('Protected moof size does not match the adjusted track run offsets');
        // The mdat header is reused so a 64-bit length stays correct; only its bytes changed.
        return Buffer.concat([
            fragment.subarray(0, moof.start), newMoof,
            fragment.subarray(mdat.start, mdat.start + mdat.headerSize), media,
            fragment.subarray(mdat.start + mdat.size),
        ]);
    }

    private planTraf(fragment: Buffer, moof: Mp4Box, mdat: Mp4Box, traf: Mp4Box, media: Buffer) {
        const kids = children(fragment, traf);
        const tfhd = kids.find(c => c.type === 'tfhd');
        if (!tfhd) throw new Error('Track fragment has no tfhd');
        const flags = fragment.readUInt32BE(tfhd.start + tfhd.headerSize) & 0xffffff;
        const trackId = fragment.readUInt32BE(tfhd.start + tfhd.headerSize + 4);
        const track = this.tracks.get(trackId);
        if (!track) return undefined;
        // The recorder muxes with default_base_moof, so every run offset is moof-relative and
        // adding the auxiliary boxes moves them all by the same amount. An absolute
        // base_data_offset would instead be a file position this fragment does not have.
        if (flags & 0x000001) throw new Error('Track fragment uses an absolute base data offset');
        if (!(flags & 0x020000)) throw new Error('Track fragment is not based at the movie fragment');
        let at = tfhd.start + tfhd.headerSize + 8;
        if (flags & 0x000002) at += 4;
        if (flags & 0x000008) at += 4;
        const defaultSampleSize = (flags & 0x000010) ? fragment.readUInt32BE(at) : 0;

        const samples: { offset: number; size: number }[] = [];
        for (const run of kids.filter(c => c.type === 'trun')) {
            const runFlags = fragment.readUInt32BE(run.start + run.headerSize) & 0xffffff;
            const count = fragment.readUInt32BE(run.start + run.headerSize + 4);
            if (!(runFlags & 0x000001)) throw new Error('Track run has no data offset');
            let field = run.start + run.headerSize + 8;
            const dataOffset = fragment.readInt32BE(field); field += 4;
            if (runFlags & 0x000004) field += 4;
            let cursor = moof.start + dataOffset - (mdat.start + mdat.headerSize);
            for (let i = 0; i < count; i++) {
                if (runFlags & 0x000100) field += 4;
                const size = (runFlags & 0x000200) ? fragment.readUInt32BE(field) : defaultSampleSize;
                if (runFlags & 0x000200) field += 4;
                if (runFlags & 0x000400) field += 4;
                if (runFlags & 0x000800) field += 4;
                if (!size) throw new Error('Recording fragment sample has no size');
                if (cursor < 0 || cursor + size > media.length) throw new Error('Track run points outside the mdat');
                samples.push({ offset: cursor, size });
                cursor += size;
            }
        }
        if (!samples.length) return undefined;

        const ivs: Buffer[] = [], subsamples: { clear: number; encrypted: number }[][] = [];
        for (const sample of samples) {
            const iv = Buffer.alloc(CENC_IV_BYTES);
            iv.writeBigUInt64BE(this.counter);
            this.counter = BigInt.asUintN(64, this.counter + 1n);
            const parts = track.kind === 'video'
                ? nalSubsamples(media, sample.offset, sample.size, track.lengthSize, track.nalHeaderBytes)
                : [{ clear: 0, encrypted: sample.size }];
            // One cipher per sample: 'cenc' runs a single key stream across the sample's
            // protected ranges, skipping the clear ones, with the block counter starting at zero.
            const cipher = createCipheriv('aes-128-ctr', this.key,
                Buffer.concat([iv, Buffer.alloc(16 - CENC_IV_BYTES)]));
            let cursor = sample.offset;
            for (const part of parts) {
                this.clearBytes += part.clear;
                cursor += part.clear;
                if (part.encrypted) {
                    cipher.update(media.subarray(cursor, cursor + part.encrypted)).copy(media, cursor);
                    this.bytesEncrypted += part.encrypted;
                    cursor += part.encrypted;
                }
            }
            cipher.final();
            ivs.push(iv); subsamples.push(parts);
            ++this.samplesEncrypted;
        }

        const subsampled = track.kind === 'video';
        const senc = buildSenc(ivs, subsampled ? subsamples : undefined);
        const saiz = buildSaiz(ivs.length, subsampled ? subsamples.map(s => CENC_IV_BYTES + 2 + s.length * 6) : undefined);
        const saio = buildSaio();
        return { senc, saiz, saio, added: senc.length + saiz.length + saio.length };
    }

    private rebuildTraf(fragment: Buffer, traf: Mp4Box, plan: { senc: Buffer; saiz: Buffer; saio: Buffer }, delta: number) {
        const out: Buffer[] = [];
        let sencIndex = -1;
        for (const kid of children(fragment, traf)) {
            if (sencIndex < 0 && kid.type === 'trun') {
                out.push(plan.saiz, plan.saio); sencIndex = out.length; out.push(plan.senc);
            }
            if (kid.type !== 'trun') { out.push(slice(fragment, kid)); continue; }
            // Every sample moved by the bytes the auxiliary boxes added to the movie fragment.
            const run = Buffer.from(slice(fragment, kid));
            run.writeInt32BE(run.readInt32BE(kid.headerSize + 8) + delta, kid.headerSize + 8);
            out.push(run);
        }
        if (sencIndex < 0) { out.push(plan.saiz, plan.saio); sencIndex = out.length; out.push(plan.senc); }
        return { children: out, sencIndex };
    }
}

/** ISO/IEC 23001-7 §9.6.2: video keeps each NAL unit's length prefix and header in the clear. */
export function nalSubsamples(media: Buffer, offset: number, size: number, lengthSize: number, nalHeaderBytes: number) {
    const parts: { clear: number; encrypted: number }[] = [];
    for (let at = offset; at < offset + size;) {
        if (at + lengthSize > offset + size) throw new Error('Truncated NAL unit length');
        let length = 0;
        for (let i = 0; i < lengthSize; i++) length = (length * 256) + media[at + i];
        const unit = lengthSize + length;
        if (!length || at + unit > offset + size) throw new Error('NAL unit runs past its sample');
        const clear = Math.min(unit, lengthSize + nalHeaderBytes);
        parts.push({ clear, encrypted: unit - clear });
        at += unit;
    }
    if (!parts.length) throw new Error('Video sample has no NAL units');
    return parts;
}

export function buildSenc(ivs: Buffer[], subsamples?: { clear: number; encrypted: number }[][]): Buffer {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(subsamples ? 0x000002 : 0, 0); // version 0; flags bit 1 = subsample encryption
    head.writeUInt32BE(ivs.length, 4);
    const parts = [head];
    for (const [i, iv] of ivs.entries()) {
        parts.push(iv);
        if (!subsamples) continue;
        const runs = subsamples[i];
        const entry = Buffer.alloc(2 + runs.length * 6);
        entry.writeUInt16BE(runs.length, 0);
        for (const [n, run] of runs.entries()) {
            if (run.clear > 0xffff) throw new Error('Subsample clear run exceeds 16 bits');
            entry.writeUInt16BE(run.clear, 2 + n * 6);
            entry.writeUInt32BE(run.encrypted, 4 + n * 6);
        }
        parts.push(entry);
    }
    return box('senc', ...parts);
}

export function buildSaiz(sampleCount: number, sizes?: number[]): Buffer {
    if (!sizes) {
        const fixed = Buffer.alloc(9);
        fixed.writeUInt8(CENC_IV_BYTES, 4);
        fixed.writeUInt32BE(sampleCount, 5);
        return box('saiz', fixed);
    }
    const oversize = sizes.find(size => size > MAX_SAMPLE_AUX_BYTES);
    if (oversize !== undefined)
        throw new Error(`A sample needs ${oversize} bytes of encryption metadata; saiz allows ${MAX_SAMPLE_AUX_BYTES}`);
    const payload = Buffer.alloc(9 + sizes.length);
    payload.writeUInt32BE(sampleCount, 5);           // default_sample_info_size stays 0
    for (const [i, size] of sizes.entries()) payload.writeUInt8(size, 9 + i);
    return box('saiz', payload);
}

export function buildSaio(): Buffer {
    const payload = Buffer.alloc(12);
    payload.writeUInt32BE(1, 4);                     // one entry; the offset is patched after layout
    return box('saio', payload);
}

function nalLengthSize(buf: Buffer, entry: Mp4Box): number {
    for (const child of children(buf, entry, VISUAL_SAMPLE_ENTRY_PRELUDE)) {
        // hvcC: lengthSizeMinusOne is in the low bits of byte 21. avcC: byte 4.
        if (child.type === 'hvcC') return (buf[child.start + child.headerSize + 21] & 3) + 1;
        if (child.type === 'avcC') return (buf[child.start + child.headerSize + 4] & 3) + 1;
    }
    throw new Error('Video sample entry has no hvcC or avcC configuration');
}

export const SAMPLE_ENTRY_PRELUDES = { visual: VISUAL_SAMPLE_ENTRY_PRELUDE, audio: AUDIO_SAMPLE_ENTRY_PRELUDE };
