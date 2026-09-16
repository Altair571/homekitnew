// Shared scaffolding for the CMAF direct-upload tests: a publishing point that behaves like a
// DASH-IF Interface-1 server, and the recorded media the accessory uploads to it.
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
 * A publishing point that enforces the two behaviours the §4.11 error enumeration implies: it
 * requires the provisioned client certificate, and it rejects a media object for a clip whose
 * CMAF Header it has not seen with the 412 that maps to "HTTP Init Missing".
 */
function publishingPoint(pki, { failInitOnce = false } = {}) {
  const objects = new Map();
  const requests = [];
  const seenInit = new Set();
  let forgetNextInit = failInitOnce;
  const server = https.createServer({
    key: pki.serverKey, cert: pki.serverCert, ca: pki.caPem,
    requestCert: true, rejectUnauthorized: true,
  }, (req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = req.url;
      const clip = url.split('/').filter(Boolean)[1];
      const name = url.endsWith('/') ? '' : url.split('/').pop();
      const peer = req.socket.getPeerCertificate();
      requests.push({ url, name, bytes: body.length, subject: peer?.subject?.CN,
        contentType: req.headers['content-type'], userAgent: req.headers['user-agent'] });
      if (name === 'init.mp4') {
        // Accepting a header and then losing it is what a restarted or rebalanced publishing
        // point looks like from the outside: the next media object gets a 412.
        if (forgetNextInit) forgetNextInit = false;
        else seenInit.add(clip);
      }
      else if (name.endsWith('.m4s') && !seenInit.has(clip)) {
        res.writeHead(412); res.end(); return;   // the publishing point has no CMAF Header
      }
      objects.set(url, body);
      res.writeHead(name === '' && !body.length ? 202 : 200); res.end();
    });
  });
  return {
    objects, requests,
    async listen() {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      return `https://localhost:${server.address().port}/pp/`;
    },
    /** The clip as the publishing point would reassemble it: header then fragments in order. */
    clip(clipId) {
      const init = objects.get(`/pp/${clipId}/init.mp4`);
      const media = [...objects.entries()]
        .filter(([url]) => url.startsWith(`/pp/${clipId}/`) && url.endsWith('.m4s'))
        .sort((a, b) => parseInt(a[0].split('/').pop()) - parseInt(b[0].split('/').pop()))
        .map(([, body]) => body);
      return { init, media };
    },
    close() { return new Promise(resolve => server.close(resolve)); },
  };
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

module.exports = { recordedClip, publishingPoint, decryptClip, trunSamples };
