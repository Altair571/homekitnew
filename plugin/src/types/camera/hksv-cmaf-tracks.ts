/**
 * hksv-cmaf-tracks.ts  (Scrypted HomeKit plugin — iOS/tvOS 27 HKSV direct upload)
 *
 * Splits the recorder's muxed fragmented MP4 into CMAF track files, and describes them in the
 * DASH manifest the ingest layout publishes beside them (cmaf-ingest.ts).
 *
 * The recorder writes one fragmented MP4 with the video and audio tracks interleaved: a moov
 * with a trak per track, and per fragment one moof carrying a traf per track over a single mdat
 * that holds both tracks' samples. A CMAF track file holds exactly one track (ISO/IEC 23000-19
 * §7.3.2) and the object layout names its objects per track, so each init segment becomes one
 * CMAF Header per track and each fragment one CMAF fragment per track. Sample bytes are copied,
 * never re-encoded: a track's samples are gathered out of the shared mdat into their own, and
 * the track runs that locate them are re-pointed. Sizes, durations and flags are untouched, so
 * Camera Key protection (hksv-cmaf-protection.ts) applies to the split tracks exactly as it did
 * to the muxed recording.
 */

import { box, Mp4Box, readBoxes } from './hksv-cmaf-protection';

export type TrackKind = 'video' | 'audio';

export interface CmafTrack {
    trackId: number;
    kind: TrackKind;
    /** The track's object name: 'video' or 'audio', the names the Matter reference camera uses. */
    name: string;
    /** The CMAF Header (ftyp + moov) carrying this track alone. */
    header: Buffer;
    timescale: number;
    /** RFC 6381 codecs parameter, e.g. hvc1.1.6.L120.90 or mp4a.40.2. */
    codecs: string;
    width?: number;
    height?: number;
    sampleRate?: number;
    channels?: number;
    /** trex default_sample_duration: the fallback for a run that carries no durations of its own. */
    defaultSampleDuration: number;
}

export interface CmafTrackFragment {
    trackId: number;
    /** moof + mdat holding only this track's samples; a prft that references the track precedes it. */
    data: Buffer;
    /** tfdt baseMediaDecodeTime, in the track's timescale. */
    decodeTime: bigint;
    /** The sum of the fragment's sample durations, in the track's timescale. */
    duration: number;
    samples: number;
}

/** A published segment, as the manifest's SegmentTimeline lists it. */
export interface CmafSegmentEntry { number: number; decodeTime: bigint; duration: number; bytes: number; samples: number }

const slice = (buf: Buffer, b: Mp4Box) => buf.subarray(b.start, b.start + b.size);
const children = (buf: Buffer, b: Mp4Box, skip = 0) => readBoxes(buf, b.start + b.headerSize + skip, b.start + b.size);
const child = (buf: Buffer, b: Mp4Box, type: string, skip = 0) => children(buf, b, skip).find(c => c.type === type);
const fullBoxVersion = (buf: Buffer, b: Mp4Box) => buf[b.start + b.headerSize];

/** Sample entry payload bytes ahead of the child boxes (ISO/IEC 14496-12 §12.1.3 / §12.2.3). */
const VISUAL_SAMPLE_ENTRY_PRELUDE = 78;
const AUDIO_SAMPLE_ENTRY_PRELUDE = 28;

// ---------------------------------------------------------------------------
// CMAF Headers
// ---------------------------------------------------------------------------

/** One CMAF Header per video or audio track in the recorder's init segment. */
export function splitInit(init: Buffer): CmafTrack[] {
    const tops = readBoxes(init);
    const ftyp = tops.find(b => b.type === 'ftyp');
    const moov = tops.find(b => b.type === 'moov');
    if (!moov) throw new Error('Recording init segment has no moov');
    const kids = children(init, moov);
    const mvex = kids.find(k => k.type === 'mvex');
    const trexes = mvex ? children(init, mvex).filter(k => k.type === 'trex') : [];
    const tracks: CmafTrack[] = [];
    for (const trak of kids.filter(k => k.type === 'trak')) {
        const info = describeTrak(init, trak);
        if (!info) continue;
        const trex = trexes.find(t => init.readUInt32BE(t.start + t.headerSize + 4) === info.trackId);
        // The movie box keeps everything but the other tracks and their fragment defaults.
        const parts = kids.flatMap(k => {
            if (k.type === 'trak') return k === trak ? [slice(init, k)] : [];
            if (k.type !== 'mvex') return [slice(init, k)];
            return [box('mvex', ...children(init, k).flatMap(m =>
                m.type === 'trex' && m.start !== trex?.start ? [] : [slice(init, m)]))];
        });
        tracks.push({
            ...info,
            header: Buffer.concat([ftyp ? slice(init, ftyp) : Buffer.alloc(0), box('moov', ...parts)]),
            defaultSampleDuration: trex ? init.readUInt32BE(trex.start + trex.headerSize + 12) : 0,
        });
    }
    if (!tracks.length) throw new Error('Recording init segment has no video or audio track');
    for (const kind of ['video', 'audio'] as TrackKind[]) {
        const same = tracks.filter(t => t.kind === kind);
        same.forEach((t, i) => { t.name = same.length > 1 ? `${kind}${i + 1}` : kind; });
    }
    return tracks;
}

type TrackInfo = Omit<CmafTrack, 'header' | 'defaultSampleDuration'>;

function describeTrak(buf: Buffer, trak: Mp4Box): TrackInfo | undefined {
    const tkhd = child(buf, trak, 'tkhd');
    const mdia = child(buf, trak, 'mdia');
    if (!tkhd || !mdia) throw new Error('MP4 track lacks tkhd or mdia');
    const trackId = buf.readUInt32BE(tkhd.start + tkhd.headerSize + (fullBoxVersion(buf, tkhd) ? 20 : 12));
    const mdhd = child(buf, mdia, 'mdhd');
    const hdlr = child(buf, mdia, 'hdlr');
    const minf = child(buf, mdia, 'minf');
    const stbl = minf && child(buf, minf, 'stbl');
    const stsd = stbl && child(buf, stbl, 'stsd');
    if (!mdhd || !hdlr || !stsd) throw new Error('MP4 track lacks mdhd, hdlr or stsd');
    const timescale = buf.readUInt32BE(mdhd.start + mdhd.headerSize + (fullBoxVersion(buf, mdhd) ? 20 : 12));
    const handler = buf.toString('ascii', hdlr.start + hdlr.headerSize + 8, hdlr.start + hdlr.headerSize + 12);
    const entry = children(buf, stsd, 8)[0];
    if (!entry) throw new Error('MP4 track has no sample entry');
    const payload = entry.start + entry.headerSize;
    if (handler === 'vide') {
        return { trackId, kind: 'video', name: 'video', timescale, codecs: videoCodecs(buf, entry),
            width: buf.readUInt16BE(payload + 24), height: buf.readUInt16BE(payload + 26) };
    }
    if (handler === 'soun') {
        return { trackId, kind: 'audio', name: 'audio', timescale, codecs: audioCodecs(buf, entry),
            channels: buf.readUInt16BE(payload + 16), sampleRate: buf.readUInt32BE(payload + 24) >>> 16 };
    }
    return undefined;
}

/** ISO/IEC 14496-15 Annex E: the codecs parameter for an HEVC or AVC sample entry. */
function videoCodecs(buf: Buffer, entry: Mp4Box): string {
    for (const config of children(buf, entry, VISUAL_SAMPLE_ENTRY_PRELUDE)) {
        const c = buf.subarray(config.start + config.headerSize, config.start + config.size);
        if (config.type === 'hvcC') {
            const profileSpace = c[1] >> 6, tier = (c[1] >> 5) & 1, profileIdc = c[1] & 0x1f;
            // general_profile_compatibility_flags are listed in reverse bit order.
            let compat = 0;
            for (let i = 0; i < 32; i++) if (c.readUInt32BE(2) & (1 << i)) compat |= 1 << (31 - i);
            let constraints = c.subarray(6, 12);
            while (constraints.length && constraints[constraints.length - 1] === 0)
                constraints = constraints.subarray(0, constraints.length - 1);
            return [`${entry.type}.${['', 'A', 'B', 'C'][profileSpace]}${profileIdc}`,
                (compat >>> 0).toString(16).toUpperCase(), `${tier ? 'H' : 'L'}${c[12]}`,
                ...[...constraints].map(b => b.toString(16).toUpperCase().padStart(2, '0'))].join('.');
        }
        if (config.type === 'avcC')
            return `${entry.type}.${c.toString('hex', 1, 4).toUpperCase()}`;
    }
    throw new Error('Video sample entry has no hvcC or avcC configuration');
}

/** RFC 6381 §3.3: mp4a.<objectTypeIndication>.<audioObjectType>, read from the esds descriptors. */
function audioCodecs(buf: Buffer, entry: Mp4Box): string {
    const esds = child(buf, entry, 'esds', AUDIO_SAMPLE_ENTRY_PRELUDE);
    if (!esds) return entry.type;
    let at = esds.start + esds.headerSize + 4;
    const descriptor = () => {
        const tag = buf[at++];
        let size = 0, b: number;
        do { b = buf[at++]; size = (size << 7) | (b & 0x7f); } while (b & 0x80);
        return { tag, size, start: at };
    };
    const es = descriptor();
    if (es.tag !== 0x03) return entry.type;
    at = es.start + 2;
    const flags = buf[at++];
    if (flags & 0x80) at += 2;
    if (flags & 0x40) at += buf[at] + 1;
    if (flags & 0x20) at += 2;
    const decoder = descriptor();
    if (decoder.tag !== 0x04) return entry.type;
    const objectType = buf[decoder.start].toString(16).toUpperCase();
    at = decoder.start + 13;
    if (at < decoder.start + decoder.size) {
        const specific = descriptor();
        if (specific.tag === 0x05 && specific.size) {
            let audioObjectType = buf[specific.start] >> 3;
            if (audioObjectType === 31)
                audioObjectType = 32 + (((buf[specific.start] & 7) << 3) | (buf[specific.start + 1] >> 5));
            return `${entry.type}.${objectType}.${audioObjectType}`;
        }
    }
    return `${entry.type}.${objectType}`;
}

// ---------------------------------------------------------------------------
// CMAF fragments
// ---------------------------------------------------------------------------

interface SampleRun { dataOffsetField: number; samples: { offset: number; size: number; duration: number }[] }

/**
 * One CMAF fragment per track in a recorder fragment. A track whose traf carries no samples
 * yields nothing for this fragment, and its segment numbering simply does not advance.
 */
export function splitFragment(fragment: Buffer, tracks: Map<number, CmafTrack>): CmafTrackFragment[] {
    const tops = readBoxes(fragment);
    const moofIndex = tops.findIndex(b => b.type === 'moof');
    if (moofIndex < 0 || tops[moofIndex + 1]?.type !== 'mdat')
        throw new Error('Recording fragment is not a moof followed by an mdat');
    const moof = tops[moofIndex], mdat = tops[moofIndex + 1];
    if (moof.headerSize !== 8) throw new Error('Recording fragment uses a 64-bit moof header');
    const media = fragment.subarray(mdat.start + mdat.headerSize, mdat.start + mdat.size);
    const prft = tops.slice(0, moofIndex).find(b => b.type === 'prft');
    const prftTrack = prft ? fragment.readUInt32BE(prft.start + prft.headerSize + 4) : undefined;
    const kids = children(fragment, moof);
    const mfhd = kids.find(k => k.type === 'mfhd');
    if (!mfhd) throw new Error('Recording fragment has no mfhd');

    const out: CmafTrackFragment[] = [];
    for (const traf of kids.filter(k => k.type === 'traf')) {
        const tfhd = child(fragment, traf, 'tfhd');
        if (!tfhd) throw new Error('Track fragment has no tfhd');
        const trackId = fragment.readUInt32BE(tfhd.start + tfhd.headerSize + 4);
        const track = tracks.get(trackId);
        if (!track) continue;
        const runs = trackRuns(fragment, moof, mdat, traf, tfhd, track, media.length);
        const samples = runs.flatMap(r => r.samples);
        if (!samples.length) continue;
        const tfdt = child(fragment, traf, 'tfdt');
        const decodeTime = !tfdt ? 0n : fullBoxVersion(fragment, tfdt)
            ? fragment.readBigUInt64BE(tfdt.start + tfdt.headerSize + 4)
            : BigInt(fragment.readUInt32BE(tfdt.start + tfdt.headerSize + 4));

        // The traf is copied whole: only each run's data_offset changes, to point past the
        // rebuilt moof and mdat header at where its samples now sit.
        const trafOut = Buffer.from(slice(fragment, traf));
        const moofSize = 8 + mfhd.size + traf.size;
        let dataOffset = moofSize + 8;
        const parts: Buffer[] = [];
        for (const run of runs) {
            trafOut.writeInt32BE(dataOffset, run.dataOffsetField - traf.start);
            for (const s of run.samples) { parts.push(media.subarray(s.offset, s.offset + s.size)); dataOffset += s.size; }
        }
        const moofOut = box('moof', slice(fragment, mfhd), trafOut);
        if (moofOut.length !== moofSize) throw new Error('Split moof size does not match its run offsets');
        out.push({
            trackId, decodeTime, samples: samples.length,
            duration: samples.reduce((n, s) => n + s.duration, 0),
            data: Buffer.concat([...(prft && prftTrack === trackId ? [slice(fragment, prft)] : []), moofOut, box('mdat', ...parts)]),
        });
    }
    return out;
}

function trackRuns(fragment: Buffer, moof: Mp4Box, mdat: Mp4Box, traf: Mp4Box, tfhd: Mp4Box, track: CmafTrack,
    mediaLength: number): SampleRun[] {
    const flags = fragment.readUInt32BE(tfhd.start + tfhd.headerSize) & 0xffffff;
    // The recorder muxes with default_base_moof, so run offsets are moof-relative and survive
    // the moof being rebuilt. An absolute base_data_offset would be a file position this
    // fragment does not have.
    if (flags & 0x000001) throw new Error('Track fragment uses an absolute base data offset');
    if (!(flags & 0x020000)) throw new Error('Track fragment is not based at the movie fragment');
    let at = tfhd.start + tfhd.headerSize + 8;
    if (flags & 0x000002) at += 4;
    const defaultDuration = (flags & 0x000008) ? fragment.readUInt32BE(at) : track.defaultSampleDuration;
    if (flags & 0x000008) at += 4;
    const defaultSize = (flags & 0x000010) ? fragment.readUInt32BE(at) : 0;
    const runs: SampleRun[] = [];
    for (const run of children(fragment, traf).filter(c => c.type === 'trun')) {
        const runFlags = fragment.readUInt32BE(run.start + run.headerSize) & 0xffffff;
        const count = fragment.readUInt32BE(run.start + run.headerSize + 4);
        if (!(runFlags & 0x000001)) throw new Error('Track run has no data offset');
        let field = run.start + run.headerSize + 8;
        const dataOffsetField = field;
        const dataOffset = fragment.readInt32BE(field); field += 4;
        if (runFlags & 0x000004) field += 4;
        let cursor = moof.start + dataOffset - (mdat.start + mdat.headerSize);
        const samples: SampleRun['samples'] = [];
        for (let i = 0; i < count; i++) {
            const duration = (runFlags & 0x000100) ? fragment.readUInt32BE(field) : defaultDuration;
            if (runFlags & 0x000100) field += 4;
            const size = (runFlags & 0x000200) ? fragment.readUInt32BE(field) : defaultSize;
            if (runFlags & 0x000200) field += 4;
            if (runFlags & 0x000400) field += 4;
            if (runFlags & 0x000800) field += 4;
            if (!size) throw new Error('Recording fragment sample has no size');
            if (cursor < 0 || cursor + size > mediaLength) throw new Error('Track run points outside the mdat');
            samples.push({ offset: cursor, size, duration });
            cursor += size;
        }
        runs.push({ dataOffsetField, samples });
    }
    return runs;
}

// ---------------------------------------------------------------------------
// DASH manifest
// ---------------------------------------------------------------------------

export interface ManifestTrack { track: CmafTrack; segments: CmafSegmentEntry[] }

export interface ManifestOptions {
    /** Paths relative to the manifest: the Matter reference writes `{track}/{track}.init`. */
    initialization(track: CmafTrack): string;
    media(track: CmafTrack): string;
    startNumber: number;
    /** The default_KID of a common-encryption protected clip, announced as ContentProtection. */
    kid?: Buffer;
}

/**
 * A static MPD listing what has been published so far: one AdaptationSet per track, a
 * SegmentTemplate naming the objects, and a SegmentTimeline of the segments' exact durations.
 * The Matter reference camera publishes the same shape, first ahead of the media and again,
 * complete, once the clip closes.
 */
export function buildManifest(tracks: ManifestTrack[], options: ManifestOptions): string {
    const seconds = (t: ManifestTrack) => t.segments.reduce((n, s) => n + s.duration, 0) / t.track.timescale;
    const duration = Math.max(0, ...tracks.map(seconds));
    const lines = [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"' + (options.kid ? ' xmlns:cenc="urn:mpeg:cenc:2013"' : '')
            + ' profiles="urn:mpeg:dash:profile:isoff-live:2011" type="static"'
            + ` mediaPresentationDuration="${isoDuration(duration)}" minBufferTime="PT2S">`,
        '  <Period id="0" start="PT0S">',
    ];
    tracks.forEach(({ track, segments }, index) => {
        const bytes = segments.reduce((n, s) => n + s.bytes, 0);
        const bandwidth = Math.max(1, Math.round(bytes * 8 / Math.max(seconds({ track, segments }), 0.001)));
        const attributes = track.kind === 'video'
            ? ` width="${track.width}" height="${track.height}"` + frameRate(track, segments)
            : ` audioSamplingRate="${track.sampleRate}"`;
        lines.push(`    <AdaptationSet id="${index}" contentType="${track.kind}" mimeType="${track.kind}/mp4"`
            + ' segmentAlignment="true" startWithSAP="1">');
        if (options.kid)
            lines.push('      <ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc"'
                + ` cenc:default_KID="${uuid(options.kid)}"/>`);
        lines.push(`      <Representation id="${track.name}" bandwidth="${bandwidth}" codecs="${track.codecs}"${attributes}>`);
        if (track.kind === 'audio')
            lines.push('        <AudioChannelConfiguration'
                + ` schemeIdUri="urn:mpeg:dash:23003:3:audio_channel_configuration:2011" value="${track.channels}"/>`);
        lines.push(`        <SegmentTemplate timescale="${track.timescale}" initialization="${options.initialization(track)}"`
            + ` media="${options.media(track)}" startNumber="${options.startNumber}">`);
        lines.push('          <SegmentTimeline>');
        for (const entry of timeline(segments)) {
            lines.push(`            <S t="${entry.t}" d="${entry.d}"${entry.r ? ` r="${entry.r}"` : ''}/>`);
        }
        lines.push('          </SegmentTimeline>', '        </SegmentTemplate>', '      </Representation>', '    </AdaptationSet>');
    });
    lines.push('  </Period>', '</MPD>', '');
    return lines.join('\n');
}

function timeline(segments: CmafSegmentEntry[]): { t: bigint; d: number; r: number }[] {
    const out: { t: bigint; d: number; r: number }[] = [];
    for (const s of segments) {
        const last = out[out.length - 1];
        if (last && last.d === s.duration && last.t + BigInt(last.d) * BigInt(last.r + 1) === s.decodeTime) last.r++;
        else out.push({ t: s.decodeTime, d: s.duration, r: 0 });
    }
    return out;
}

function frameRate(track: CmafTrack, segments: CmafSegmentEntry[]): string {
    const first = segments[0];
    if (!first?.duration || !first.samples) return '';
    // DASH allows "F" or "F/D"; the sample duration is what the recorder fixed the rate at.
    const sample = Math.round(first.duration / first.samples);
    if (!sample) return '';
    const divisor = gcd(track.timescale, sample);
    const n = track.timescale / divisor, d = sample / divisor;
    return ` frameRate="${d === 1 ? n : `${n}/${d}`}"`;
}

function gcd(a: number, b: number): number { return b ? gcd(b, a % b) : a; }

function isoDuration(seconds: number): string {
    return `PT${(Math.round(seconds * 1000) / 1000).toFixed(3)}S`;
}

function uuid(kid: Buffer): string {
    const hex = kid.toString('hex').padStart(32, '0');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
