// Shared scaffolding for the CMAF direct-upload tests: a publishing point that behaves like a
// Matter Push AV Stream Transport ingest server, and the recorded media the accessory uploads to it.
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');

/** Splits the committed fragmented-MP4 fixture into the init segment and its moof/mdat pairs. */
function recordedClip(readBoxes) {
  const file = fs.readFileSync(path.join(__dirname, 'fixtures/hevc-aac-fmp4.mp4'));
  const init = [], fragments = [];
  let pending = [];
  for (const b of readBoxes(file)) {
    const buf = file.subarray(b.start, b.start + b.size);
    if (b.type === 'ftyp' || b.type === 'moov') { init.push(buf); continue; }
    pending.push(buf);
    if (b.type === 'mdat') { fragments.push(Buffer.concat(pending)); pending = []; }
  }
  return { init: Buffer.concat(init), fragments };
}

/**
 * A publishing point that speaks the Matter Push AV Stream Transport layout the plugin uploads
 * to — `session_<N>/index.mpd`, `session_<N>/<track>/<track>.init`,
 * `session_<N>/<track>/segment_<S>.m4s` — and enforces what the §4.11 error enumeration implies:
 * it requires the provisioned client certificate, answers 404 for any other path, and rejects a
 * media object for a track whose CMAF Header it has not seen with the 412 that maps to "HTTP
 * Init Missing".
 *
 * Options shape the far end: `sessions` limits which session numbers exist (anything else is
 * 404, the way a point keyed on one identifier looks to a client offering another), `methods`
 * limits the verbs it allows (others get 405 with an Allow header), `failInitOnce` forgets the
 * first header it is given, and `refuse` answers every request with that status and body.
 */
function publishingPoint(pki, { failInitOnce = false, sessions, methods = ['PUT', 'POST'], refuse } = {}) {
  const objects = new Map();
  const requests = [];
  const seenInit = new Set();
  let forgetNextInit = failInitOnce;
  const route = /^\/pp\/session_(\d+)\/(?:(index\.mpd)|([A-Za-z0-9]+)\/(?:\3\.init|segment_(\d+)\.m4s))$/;
  const server = https.createServer({
    key: pki.serverKey, cert: pki.serverCert, ca: pki.caPem,
    requestCert: true, rejectUnauthorized: true,
  }, (req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = req.url;
      const match = route.exec(url);
      const session = match?.[1];
      const track = match?.[3];
      const name = url.split('/').pop();
      const peer = req.socket.getPeerCertificate();
      requests.push({ url, method: req.method, name, session, track, bytes: body.length, subject: peer?.subject?.CN,
        contentType: req.headers['content-type'], userAgent: req.headers['user-agent'] });
      if (refuse) { res.writeHead(refuse.status, refuse.headers ?? {}); res.end(refuse.body ?? ''); return; }
      if (!match || (sessions && !sessions.map(String).includes(session))) { res.writeHead(404); res.end(); return; }
      if (!methods.includes(req.method)) { res.writeHead(405, { Allow: methods.join(', ') }); res.end(); return; }
      if (name.endsWith('.init')) {
        // Accepting a header and then losing it is what a restarted or rebalanced publishing
        // point looks like from the outside: the next media object gets a 412.
        if (forgetNextInit) forgetNextInit = false;
        else seenInit.add(`${session}/${track}`);
      }
      else if (name.endsWith('.m4s') && !seenInit.has(`${session}/${track}`)) {
        res.writeHead(412); res.end(); return;   // the publishing point has no CMAF Header
      }
      objects.set(url, body);
      res.writeHead(name === 'index.mpd' ? 201 : 200); res.end();
    });
  });
  return {
    objects, requests,
    async listen() {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      return `https://localhost:${server.address().port}/pp/`;
    },
    /** A track as the publishing point would reassemble it: header then fragments in order. */
    track(session, name) {
      const prefix = `/pp/session_${session}/${name}/`;
      const init = objects.get(`${prefix}${name}.init`);
      const media = [...objects.entries()]
        .filter(([url]) => url.startsWith(prefix) && url.endsWith('.m4s'))
        .sort((a, b) => parseInt(a[0].split('_').pop()) - parseInt(b[0].split('_').pop()))
        .map(([, body]) => body);
      return { init, media };
    },
    manifest(session) { return objects.get(`/pp/session_${session}/index.mpd`)?.toString('utf8'); },
    close() { return new Promise(resolve => server.close(resolve)); },
  };
}

/**
 * The recording as the plugin splits it: one CMAF Header and one fragment per fragment for each
 * track, keyed by the track's object name, built with the plugin's own module so an upload test
 * compares what arrived against the bytes that were meant to leave.
 */
function splitTracks(T, clip) {
  const tracks = T.splitInit(clip.init);
  const byId = new Map(tracks.map(t => [t.trackId, t]));
  const out = Object.fromEntries(tracks.map(t => [t.name, { init: t.header, media: [], entries: [] }]));
  for (const fragment of clip.fragments) {
    for (const part of T.splitFragment(fragment, byId)) {
      const track = out[byId.get(part.trackId).name];
      track.media.push(part.data);
      track.entries.push(part);
    }
  }
  return out;
}

/**
 * Decrypts a protected clip with the Camera Key, following its own senc/saiz/saio metadata, and
 * returns the plaintext fragments. A test that gets the original bytes back has shown that a
 * player holding the key can read what was uploaded.
 */
function decryptClip(P, key, fragments) {
  return fragments.map(fragment => {
    const media = Buffer.from(fragment);
    const tops = P.readBoxes(media);
    const moof = tops.find(b => b.type === 'moof');
    const mdat = tops.find(b => b.type === 'mdat');
    const body = media.subarray(mdat.start + mdat.headerSize, mdat.start + mdat.size);
    for (const traf of P.readBoxes(media, moof.start + moof.headerSize, moof.start + moof.size)) {
      if (traf.type !== 'traf') continue;
      const kids = P.readBoxes(media, traf.start + traf.headerSize, traf.start + traf.size);
      const tfhd = kids.find(k => k.type === 'tfhd'), senc = kids.find(k => k.type === 'senc');
      const saio = kids.find(k => k.type === 'saio');
      if (!senc) continue;
      // Trust saio, not the box order: it is what a player uses to find the IVs.
      const auxAt = moof.start + media.readUInt32BE(saio.start + saio.headerSize + 8);
      const flags = media.readUInt32BE(senc.start + senc.headerSize) & 0xffffff;
      const count = media.readUInt32BE(senc.start + senc.headerSize + 4);
      const samples = trunSamples(media, moof, mdat, tfhd, kids);
      let at = auxAt;
      for (let i = 0; i < count; i++) {
        const iv = media.subarray(at, at + 8); at += 8;
        let runs = [{ clear: 0, encrypted: samples[i].size }];
        if (flags & 2) {
          const subsamples = media.readUInt16BE(at); at += 2; runs = [];
          for (let k = 0; k < subsamples; k++) {
            runs.push({ clear: media.readUInt16BE(at), encrypted: media.readUInt32BE(at + 2) }); at += 6;
          }
        }
        const decipher = crypto.createDecipheriv('aes-128-ctr', key, Buffer.concat([iv, Buffer.alloc(8)]));
        let cursor = samples[i].offset;
        for (const run of runs) {
          cursor += run.clear;
          if (run.encrypted) {
            decipher.update(body.subarray(cursor, cursor + run.encrypted)).copy(body, cursor);
            cursor += run.encrypted;
          }
        }
        decipher.final();
      }
    }
    return { media, mdat: body };
  });
}

/** Sample offsets and sizes for one track fragment, as a player would resolve them. */
function trunSamples(buf, moof, mdat, tfhd, kids) {
  const flags = buf.readUInt32BE(tfhd.start + tfhd.headerSize) & 0xffffff;
  let at = tfhd.start + tfhd.headerSize + 8;
  if (flags & 0x000002) at += 4;
  if (flags & 0x000008) at += 4;
  const defaultSize = (flags & 0x000010) ? buf.readUInt32BE(at) : 0;
  const samples = [];
  for (const run of kids.filter(k => k.type === 'trun')) {
    const runFlags = buf.readUInt32BE(run.start + run.headerSize) & 0xffffff;
    const count = buf.readUInt32BE(run.start + run.headerSize + 4);
    let field = run.start + run.headerSize + 8;
    const dataOffset = buf.readInt32BE(field); field += 4;
    if (runFlags & 0x000004) field += 4;
    let cursor = moof.start + dataOffset - (mdat.start + mdat.headerSize);
    for (let i = 0; i < count; i++) {
      if (runFlags & 0x000100) field += 4;
      const size = (runFlags & 0x000200) ? buf.readUInt32BE(field) : defaultSize;
      if (runFlags & 0x000200) field += 4;
      if (runFlags & 0x000400) field += 4;
      if (runFlags & 0x000800) field += 4;
      samples.push({ offset: cursor, size }); cursor += size;
    }
  }
  return samples;
}

module.exports = { recordedClip, publishingPoint, decryptClip, trunSamples, splitTracks };
