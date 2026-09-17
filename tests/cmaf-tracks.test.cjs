// r45: the recorder's muxed fragmented MP4 becomes one CMAF track file per track before it is
// uploaded (hksv-cmaf-tracks.ts). These checks hold the split to what a player needs: each track
// alone decodes in FFmpeg to the frames the muxed recording held, the sample bytes are the
// recorder's own, and the manifest describes the objects the ingest layout names.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { environment, base } = require('./helpers.cjs');
const { recordedClip, splitTracks, trunSamples } = require('./cmaf-helpers.cjs');

const ffmpeg = path.join(__dirname, '../node_modules/ffmpeg-static/ffmpeg');

/** FFmpeg's stream report for a file it decodes end to end; a failed decode fails the test. */
function decode(file) {
  const run = spawnSync(ffmpeg, ['-hide_banner', '-nostats', '-v', 'info', '-i', file, '-f', 'null', '-'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
  assert.equal(run.status, 0, `ffmpeg decodes ${path.basename(file)}: ${run.stderr}`);
  return run.stderr;
}

function walk(P, buf, types, start = 0, end = buf.length, found = []) {
  for (const b of P.readBoxes(buf, start, end)) {
    if (types.includes(b.type)) found.push(b);
    if (['moov', 'trak', 'mdia', 'minf', 'stbl', 'mvex', 'moof', 'traf'].includes(b.type))
      walk(P, buf, types, b.start + b.headerSize, b.start + b.size, found);
  }
  return found;
}

test('each split track is a single-track CMAF file that FFmpeg decodes like the muxed recording', t => {
  const env = environment();
  const P = env.load(base + 'hksv-cmaf-protection.ts');
  const T = env.load(base + 'hksv-cmaf-tracks.ts');
  const clip = recordedClip(P.readBoxes);
  const tracks = T.splitInit(clip.init);
  assert.equal(JSON.stringify(tracks.map(x => [x.name, x.kind, x.trackId])), JSON.stringify([['video', 'video', 1], ['audio', 'audio', 2]]));
  const [video, audio] = tracks;
  assert.match(video.codecs, /^hvc1\.1\.6\.L\d+\.90$/, 'the HEVC codecs parameter comes from hvcC');
  assert.deepEqual([video.width, video.height, video.timescale], [320, 180, 15360]);
  assert.deepEqual([audio.codecs, audio.sampleRate, audio.channels, audio.timescale], ['mp4a.40.2', 24000, 1, 24000]);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hksv-tracks-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const split = splitTracks(T, clip);
  for (const track of tracks) {
    // One trak, one trex, and every fragment one traf, all for this track.
    assert.equal(walk(P, track.header, ['trak']).length, 1);
    const trexes = walk(P, track.header, ['trex']);
    assert.equal(trexes.length, 1);
    assert.equal(track.header.readUInt32BE(trexes[0].start + trexes[0].headerSize + 4), track.trackId);
    const media = split[track.name].media;
    assert.equal(media.length, clip.fragments.length, 'every recorder fragment yields one fragment for the track');
    for (const fragment of media) {
      const trafs = walk(P, fragment, ['traf']);
      assert.equal(trafs.length, 1);
      const tops = P.readBoxes(fragment);
      assert.equal(tops.map(b => b.type).filter(x => x !== 'prft').join(','), 'moof,mdat');
      if (track.kind === 'video') assert.equal(tops[0].type, 'prft', 'the wall-clock reference stays with the track it names');
      // The run offsets land exactly on the rebuilt mdat, and cover it entirely.
      const moof = tops.find(b => b.type === 'moof'), mdat = tops.find(b => b.type === 'mdat');
      const kids = P.readBoxes(fragment, trafs[0].start + trafs[0].headerSize, trafs[0].start + trafs[0].size);
      const samples = trunSamples(fragment, moof, mdat, kids.find(k => k.type === 'tfhd'), kids);
      assert.equal(samples[0].offset, 0);
      assert.equal(samples.reduce((n, s) => n + s.size, 0), mdat.size - mdat.headerSize);
    }
    const file = path.join(dir, `${track.name}.mp4`);
    fs.writeFileSync(file, Buffer.concat([track.header, ...media]));
    const log = decode(file);
    assert.doesNotMatch(log, /error|invalid|corrupt|missing/i, `FFmpeg reads the ${track.name} track cleanly`);
    assert.match(log, track.kind === 'video' ? /Video: hevc/ : /Audio: aac/);
  }
  // The same frames as the muxed original: FFmpeg reports identical stream summaries per track.
  const original = path.join(dir, 'muxed.mp4');
  fs.writeFileSync(original, Buffer.concat([clip.init, ...clip.fragments]));
  const muxedLog = decode(original);
  for (const kind of ['Video', 'Audio']) {
    const line = log => log.split('\n').find(l => l.includes(`${kind}:`))?.replace(/#\d+:\d+/, '').trim();
    assert.equal(line(decode(path.join(dir, `${kind.toLowerCase()}.mp4`))), line(muxedLog), `${kind} stream unchanged`);
  }
});

test('the split copies sample bytes and durations exactly', () => {
  const env = environment();
  const P = env.load(base + 'hksv-cmaf-protection.ts');
  const T = env.load(base + 'hksv-cmaf-tracks.ts');
  const clip = recordedClip(P.readBoxes);
  const split = splitTracks(T, clip);
  let totalMuxed = 0, totalSplit = 0;
  for (const [i, fragment] of clip.fragments.entries()) {
    const tops = P.readBoxes(fragment);
    const moof = tops.find(b => b.type === 'moof'), mdat = tops.find(b => b.type === 'mdat');
    const media = fragment.subarray(mdat.start + mdat.headerSize, mdat.start + mdat.size);
    totalMuxed += media.length;
    for (const traf of P.readBoxes(fragment, moof.start + moof.headerSize, moof.start + moof.size)) {
      if (traf.type !== 'traf') continue;
      const kids = P.readBoxes(fragment, traf.start + traf.headerSize, traf.start + traf.size);
      const tfhd = kids.find(k => k.type === 'tfhd');
      const trackId = fragment.readUInt32BE(tfhd.start + tfhd.headerSize + 4);
      const name = trackId === 1 ? 'video' : 'audio';
      const expected = Buffer.concat(trunSamples(fragment, moof, mdat, tfhd, kids).map(s => media.subarray(s.offset, s.offset + s.size)));
      const part = split[name].media[i];
      const parts = P.readBoxes(part);
      const out = parts.find(b => b.type === 'mdat');
      assert.deepEqual(part.subarray(out.start + out.headerSize, out.start + out.size), expected, `${name} fragment ${i + 1} samples`);
      totalSplit += out.size - out.headerSize;
      // The tfdt and the run's sample table are carried over untouched.
      const tfdt = kids.find(k => k.type === 'tfdt');
      assert.equal(split[name].entries[i].decodeTime, fragment[tfdt.start + tfdt.headerSize]
        ? fragment.readBigUInt64BE(tfdt.start + tfdt.headerSize + 4)
        : BigInt(fragment.readUInt32BE(tfdt.start + tfdt.headerSize + 4)));
      assert(split[name].entries[i].duration > 0);
    }
  }
  assert.equal(totalSplit, totalMuxed, 'no sample byte is lost or duplicated');
});

test('the manifest names the objects the layout uploads and lists the segments it has seen', () => {
  const env = environment();
  const P = env.load(base + 'hksv-cmaf-protection.ts');
  const T = env.load(base + 'hksv-cmaf-tracks.ts');
  const clip = recordedClip(P.readBoxes);
  const split = splitTracks(T, clip);
  const tracks = T.splitInit(clip.init);
  const listed = tracks.map(track => ({ track, segments: split[track.name].entries.map((e, i) => ({
    number: 1001 + i, decodeTime: e.decodeTime, duration: e.duration, bytes: split[track.name].media[i].length, samples: e.samples })) }));
  const kid = Buffer.alloc(16); kid.writeBigUInt64BE(42n, 8);
  const mpd = T.buildManifest(listed, {
    initialization: x => `${x.name}/${x.name}.init`, media: x => `${x.name}/segment_$Number$.m4s`, startNumber: 1001, kid });
  assert.match(mpd, /^<\?xml version="1.0" encoding="utf-8"\?>\n<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" xmlns:cenc="urn:mpeg:cenc:2013"/);
  assert.match(mpd, /type="static" mediaPresentationDuration="PT3\.120S"/);
  assert.match(mpd, /<AdaptationSet id="0" contentType="video" mimeType="video\/mp4"/);
  assert.match(mpd, /cenc:default_KID="00000000-0000-0000-0000-00000000002a"/);
  assert.match(mpd, /<Representation id="video" bandwidth="\d+" codecs="hvc1\.1\.6\.L\d+\.90" width="320" height="180" frameRate="15">/);
  assert.match(mpd, /<SegmentTemplate timescale="15360" initialization="video\/video\.init" media="video\/segment_\$Number\$\.m4s" startNumber="1001">/);
  assert.match(mpd, /<Representation id="audio" bandwidth="\d+" codecs="mp4a\.40\.2" audioSamplingRate="24000">/);
  assert.match(mpd, /<AudioChannelConfiguration schemeIdUri="urn:mpeg:dash:23003:3:audio_channel_configuration:2011" value="1"\/>/);
  // The timeline is contiguous: each S starts where the previous one ended.
  for (const name of ['video', 'audio']) {
    const block = mpd.slice(mpd.indexOf(`id="${name}"`), mpd.indexOf('</Representation>', mpd.indexOf(`id="${name}"`)));
    const entries = [...block.matchAll(/<S t="(\d+)" d="(\d+)"(?: r="(\d+)")?\/>/g)].map(m => [BigInt(m[1]), BigInt(m[2]), BigInt(m[3] ?? 0)]);
    assert.equal(entries.length + entries.reduce((n, e) => n + Number(e[2]), 0), clip.fragments.length, `${name} lists every segment`);
    let at = 0n;
    for (const [t, d, r] of entries) { assert.equal(t, at); at += d * (r + 1n); }
  }
  // Without protection there is no ContentProtection and no cenc namespace.
  const clear = T.buildManifest(listed, { initialization: x => x.name, media: x => x.name, startNumber: 1 });
  assert(!clear.includes('cenc'));
});
