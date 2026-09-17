// iOS 27 CMAF direct upload (r44, layout r45). On iOS/tvOS 27 the accessory uploads its own
// HomeKit Secure Video clips to Apple's publishing point with no home hub in the media path, so
// these tests drive the whole §3.5/§3.9/§3.10 provisioning sequence through the real HAP
// characteristics and watch the clip land on a publishing point that demands the certificate
// the plugin was issued and speaks the Matter Push AV Stream Transport layout.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { environment, base, storage, quiet } = require('./helpers.cjs');
const pki = require('./cmaf-pki.cjs');
const { recordedClip, publishingPoint, decryptClip, splitTracks } = require('./cmaf-helpers.cjs');

const CAMERA_KEY = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
const KEY_NUMBER = 42n;
const SESSION_ID = 7n;

function accessory(env, options) {
  const hap = env.load('./src/hap.ts');
  const acc = new hap.Accessory('CMAF upload', '00000000-0000-4000-8000-000000000044');
  const controller = new hap.CameraController({
    cameraStreamCount: 2, delegate: {},
    streamingOptions: { supportedCryptoSuites: [0],
      video: { codec: { profiles: [0, 1, 2], levels: [0, 1, 2] }, resolutions: [[640, 360, 30]] },
      audio: { codecs: [{ type: 'OPUS', samplerate: 24 }] } },
    recording: { delegate: { updateRecordingActive() {}, updateRecordingConfiguration() {} }, options: {
      prebufferLength: 4000, mediaContainerConfiguration: { type: 0, fragmentLength: 4000 },
      video: { type: 0, parameters: { profiles: [0], levels: [0] }, resolutions: [[1280, 720, 30]] },
      audio: { codecs: { type: 0, audioChannels: 1, samplerate: 2, bitrateMode: 0 } },
    } },
  });
  acc.configureController(controller);
  const logs = [];
  const { Hksv27Camera } = env.load(base + 'camera-hksv27.ts');
  const store = storage();
  const camera = new Hksv27Camera(acc, {}, store, { ...quiet, log: m => logs.push(m), warn: m => logs.push(m), error: m => logs.push(m) }, {
    sensorClass: '1080p', sensorWidth: 1920, sensorHeight: 1080,
    disabledServices: new Set(['Legacy Recording Config', 'Legacy RTP Live View']),
    ...options,
  });
  const recording = controller.recordingManagement;
  // Recording Active gates §4.9 uploads; a real controller turns it on when HKSV is enabled.
  recording.recordingManagementService.getCharacteristic(hap.Characteristic.Active).updateValue(1);
  camera.attachRecordingManagement(recording.recordingManagementService);
  return { acc, camera, logs, store, controller,
    close() { camera.handleFactoryReset(); recording.destroy(); } };
}

function service(acc, uuid) {
  const found = acc.services.find(s => s.UUID === uuid);
  assert(found, `service ${uuid} is advertised`);
  return found;
}

function write(svc, name, value) {
  const characteristic = svc.characteristics.find(c => c.displayName === name);
  assert(characteristic, `${name} exists`);
  return new Promise((resolve, reject) => characteristic.emit('set',
    Buffer.isBuffer(value) ? value.toString('base64') : value,
    (e, response) => e ? reject(e) : resolve(response ? Buffer.from(response, 'base64') : undefined)));
}

/** Runs the §4.13/§4.25/§4.26/§4.7 provisioning a controller performs before it asks for a clip. */
async function provision(env, acc, authority, url, { withKey = true, key = CAMERA_KEY } = {}) {
  const proto = env.load(base + 'hksv-recording-protocol.ts');
  const { tlvEncode } = env.load(base + 'hksv-stream-tiers.ts');
  const buffers = service(acc, proto.CameraBufferManagementServiceUUID);
  const certificates = service(acc, proto.CameraClientCertificateManagementServiceUUID);
  const keys = service(acc, proto.CameraKeyManagementServiceUUID);

  await write(buffers, 'Camera Recording Publishing Point', tlvEncode(
    1, Buffer.from(url, 'utf8'),
    2, tlvEncode(1, authority.caDer)));

  // §4.25: the controller nonces the accessory, which answers with a CSR and a signature over it.
  const nonce = crypto.randomBytes(32);
  const response = await write(certificates, 'Camera Client CSR', tlvEncode(1, nonce));
  const { tlvDecodeMap } = env.load(base + 'hksv-multitier-protocol.ts');
  const csr = tlvDecodeMap(response);
  assert(csr[1]?.length, 'the CSR response carries a certificate signing request');
  const clientCertificateDer = authority.signCsr(csr[1]);
  await write(certificates, 'Camera Client Certificate', tlvEncode(
    1, clientCertificateDer, 2, authority.caDer));

  if (withKey)
    await write(keys, 'Camera Key', tlvEncode(1, key, 2, proto.u64(KEY_NUMBER)));
  return { buffers, certificates, keys, proto, tlvEncode };
}

/** Feeds the committed recording into the accessory's buffer as if FFmpeg were producing it. */
function recordingSource(env, clip) {
  const { NTP_SECOND, millisecondsToNtp } = env.load(base + 'hksv-recording-buffer.ts');
  const first = millisecondsToNtp(Date.now() - 60000);
  const timed = clip.fragments.map((data, i) => ({
    data, start: first + BigInt(i) * NTP_SECOND, end: first + BigInt(i + 1) * NTP_SECOND,
  }));
  const source = async function* (tier, signal) {
    yield { init: clip.init };
    for (const fragment of timed) { if (signal.aborted) return; yield fragment; }
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
  };
  return { source, timed, first, last: timed[timed.length - 1].end };
}

async function settle(predicate, why, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(`timed out waiting for ${why}`);
}

/**
 * Provisions an accessory, asks it for a Start-and-Stop upload of the whole buffered window,
 * and waits until the clip is closed (its final manifest arrived) or the upload session ended.
 */
async function uploadClip(t, { mode = 'cenc', pointOptions = {}, key = CAMERA_KEY } = {}) {
  const env = environment({ realHap: true });
  const P = env.load(base + 'hksv-cmaf-protection.ts');
  const clip = recordedClip(P.readBoxes);
  const authority = pki.authority();
  const point = publishingPoint(authority, pointOptions);
  const url = await point.listen();
  const { source, first, last } = recordingSource(env, clip);
  const a = accessory(env, { cmafUploadMode: mode, recordingSource: source });
  t.after(async () => { a.close(); await point.close(); authority.close(); });

  const { buffers, proto, tlvEncode } = await provision(env, a.acc, authority, url,
    { withKey: mode === 'cenc', key });
  await settle(() => a.logs.some(l => String(l).includes('recording buffer ready')), 'the recorder to start');
  // The buffer refuses to open a window until it holds the init segment and some media.
  await settle(() => { try { a.camera.recordingBuffer.open(first); return true; } catch { return false; } },
    'the recording buffer to fill');
  // A Start-and-Stop upload of the whole buffered window, finalized (§4.9).
  const response = await write(buffers, 'Buffer Upload Command', tlvEncode(
    1, proto.u64(SESSION_ID), 2, 2, 3, proto.u64(first), 4, proto.u64(last), 5, 2));
  const parsed = env.load(base + 'hksv-multitier-protocol.ts').tlvDecodeMap(response);
  const id = proto.readUIntLE(parsed[1]);
  await settle(() => point.requests.filter(r => r.name === 'index.mpd' && r.session !== undefined
      && point.objects.has(r.url)).length >= 2
    || a.logs.some(l => /CMAF session \d+: HTTP \d+ for .*(bytes\)|nothing uploaded)/.test(String(l))
      && !/HTTP 2\d\d/.test(String(l))),
    'the clip to be closed or refused');
  return { env, P, point, clip, id, logs: a.logs, camera: a.camera, authority };
}

test('a provisioned accessory uploads an encrypted clip, one CMAF track at a time, to a publishing point that demands its certificate',
  { skip: pki.available() ? false : 'openssl is unavailable' }, async t => {
    const { env, P, point, clip, id, logs } = await uploadClip(t);
    const T = env.load(base + 'hksv-cmaf-tracks.ts');

    // The Matter Push AV layout, in the reference camera's order: manifest, headers, segments, manifest.
    const names = point.requests.map(r => r.name);
    assert.equal(names[0], 'index.mpd', 'the manifest goes first, under the Clip ID');
    assert.equal(point.requests[0].session, String(id));
    assert.deepEqual(names.slice(1, 3), ['video.init', 'audio.init'], 'one CMAF Header per track follows');
    assert.deepEqual(names.slice(3, -1),
      ['segment_1001.m4s', 'segment_1001.m4s', 'segment_1002.m4s', 'segment_1002.m4s', 'segment_1003.m4s', 'segment_1003.m4s'],
      'each fragment becomes one object per track, numbered from 1001');
    assert.equal(names[names.length - 1], 'index.mpd', 'the complete manifest closes the clip');
    for (const request of point.requests) {
      assert.equal(request.method, 'PUT');
      assert.equal(request.session, String(id), 'every object sits under the clip\'s session');
      // The plugin names its CSR after the accessory, so the far end sees which camera uploaded.
      assert.match(request.subject, /^scrypted-[0-9a-f]+$/, 'mutual TLS used the provisioned identity');
      assert.equal(request.contentType, request.name === 'index.mpd' ? 'application/dash+xml'
        : request.name.endsWith('.init') ? 'video/mp4' : 'video/iso.segment');
      assert.match(request.userAgent, /^DASH-IF-Ingest\//);
    }
    assert(logs.some(l => /accepted the manifest at \/pp\/session_\d+\/index\.mpd \(Clip ID \d+, PUT\)/.test(String(l))));

    // Each track reassembles into a CMAF Header marked protected plus its own media...
    for (const name of ['video', 'audio']) {
      const uploaded = point.track(id, name);
      const stsd = [];
      (function walk(buf, start, end) {
        for (const b of P.readBoxes(buf, start, end)) {
          if (b.type === 'stsd') { stsd.push(b); continue; }
          if (['moov', 'trak', 'mdia', 'minf', 'stbl'].includes(b.type)) walk(buf, b.start + b.headerSize, b.start + b.size);
        }
      })(uploaded.init, 0, uploaded.init.length);
      const formats = stsd.flatMap(s => P.readBoxes(uploaded.init, s.start + s.headerSize + 8, s.start + s.size).map(e => e.type));
      assert.deepEqual(formats, [name === 'video' ? 'encv' : 'enca'], `${name} is a single common-encryption track`);
      assert(P.readBoxes(uploaded.init)[0].type === 'ftyp');
      assert.equal(uploaded.media.length, clip.fragments.length);
      // ...and a holder of the Camera Key gets the recorder's exact samples back.
      const plain = decryptClip(P, CAMERA_KEY, uploaded.media);
      const expected = splitTracks(T, clip)[name];
      for (const [i, fragment] of plain.entries()) {
        const original = P.readBoxes(expected.media[i]).find(b => b.type === 'mdat');
        assert.deepEqual(fragment.mdat,
          expected.media[i].subarray(original.start + original.headerSize, original.start + original.size),
          `${name} fragment ${i + 1} decrypts to the recorded media`);
      }
    }
    // The manifest announces the protection and the objects' names.
    const manifest = point.manifest(id);
    assert.match(manifest, /cenc:default_KID="00000000-0000-0000-0000-00000000002a"/);
    assert.match(manifest, /initialization="video\/video\.init" media="video\/segment_\$Number\$\.m4s" startNumber="1001"/);
    assert.match(manifest, /initialization="audio\/audio\.init" media="audio\/segment_\$Number\$\.m4s" startNumber="1001"/);
    assert.match(manifest, /codecs="hvc1\./);
    assert.match(manifest, /codecs="mp4a\.40\.2"/);
  });

test('an unprotected upload sends the recorder\'s own samples per track, and a key is not required',
  { skip: pki.available() ? false : 'openssl is unavailable' }, async t => {
    const { env, P, point, clip, id } = await uploadClip(t, { mode: 'clear' });
    const expected = splitTracks(env.load(base + 'hksv-cmaf-tracks.ts'), clip);
    for (const name of ['video', 'audio']) {
      const uploaded = point.track(id, name);
      assert(!P.readBoxes(uploaded.init).some(b => b.type === 'senc'));
      for (const [i, fragment] of uploaded.media.entries()) {
        // Only the styp the ingest adds separates the object from the split recording.
        const boxes = P.readBoxes(fragment);
        assert.equal(boxes[0].type, 'styp', 'each media object is a self-describing CMAF segment');
        assert.deepEqual(fragment.subarray(boxes[0].size), expected[name].media[i], `${name} fragment ${i + 1} is unmodified`);
      }
    }
    assert(!point.manifest(id).includes('ContentProtection'));
  });

test('a publishing point that lost a CMAF Header gets it again and the fragment is retried',
  { skip: pki.available() ? false : 'openssl is unavailable' }, async t => {
    // The first header the point is given is forgotten, so the first video fragment meets a
    // point with no header for its track: the 412 it answers with is the "HTTP Init Missing"
    // the specification enumerates.
    const { point } = await uploadClip(t, { pointOptions: { failInitOnce: true } });
    const video = point.requests.filter(r => r.track === 'video').map(r => r.name);
    assert.equal(video.filter(n => n === 'video.init').length, 2, 'the header is uploaded again');
    assert(video.indexOf('segment_1001.m4s') < video.lastIndexOf('video.init'), 'the re-upload follows the rejected fragment');
    assert(video.lastIndexOf('segment_1001.m4s') > video.lastIndexOf('video.init'), 'and the fragment is retried after it');
    assert.equal(point.requests.filter(r => r.name === 'audio.init').length, 1, 'the other track is left alone');
  });

test('a publishing point keyed on the Session ID is found after the Clip ID is refused',
  { skip: pki.available() ? false : 'openssl is unavailable' }, async t => {
    const { point, id, logs } = await uploadClip(t, { mode: 'clear', pointOptions: { sessions: [SESSION_ID] } });
    assert.notEqual(String(id), String(SESSION_ID));
    const [first, second] = point.requests;
    assert.deepEqual([first.name, first.session], ['index.mpd', String(id)], 'the manifest is offered under the Clip ID first');
    assert.deepEqual([second.name, second.session], ['index.mpd', String(SESSION_ID)], 'then under the Session ID');
    assert(point.requests.slice(1).every(r => r.session === String(SESSION_ID)), 'everything else follows the accepted layout');
    assert(point.manifest(SESSION_ID)?.includes('<SegmentTimeline>'));
    assert(logs.some(l => /HTTP 404 for \/pp\/session_\d+\/index\.mpd \(PUT, \d+ bytes\); offering the manifest under Session ID 7 instead/.test(String(l))),
      'the refusal and the fallback are both logged');
  });

test('a publishing point that only allows POST gets it after a 405, and every refusal is logged with its body',
  { skip: pki.available() ? false : 'openssl is unavailable' }, async t => {
    const { point, logs } = await uploadClip(t, { mode: 'clear', pointOptions: { methods: ['POST'] } });
    assert.equal(point.requests[0].method, 'PUT');
    assert(point.requests.slice(1).every(r => r.method === 'POST'), 'the session stays on POST once the point asked for it');
    assert(logs.some(l => /HTTP 405 for \/pp\/session_\d+\/index\.mpd — allow: POST; switching to POST/.test(String(l))));
  });

test('a publishing point that refuses every layout ends the session with HTTP Not Found and shows what it said',
  { skip: pki.available() ? false : 'openssl is unavailable' }, async t => {
    const { point, logs, camera, env } = await uploadClip(t, { mode: 'clear', pointOptions: {
      refuse: { status: 404, headers: { 'content-type': 'application/json', 'x-apple-request-uuid': 'b70d84e3' },
        body: '{"reason":"no such zone"}' } } });
    assert.deepEqual(point.requests.map(r => r.name), ['index.mpd', 'index.mpd'], 'both layouts are offered, then nothing more');
    const failure = logs.map(String).find(l => /^CMAF session 7: HTTP 404 for \/pp\/session_7\/index\.mpd/.test(l));
    assert(failure, 'the terminal refusal is logged');
    assert.match(failure, /content-type: application\/json; x-apple-request-uuid: b70d84e3; body: "\{"reason":"no such zone"\}"/);
    const proto = env.load(base + 'hksv-recording-protocol.ts');
    // The controller sees the §4.11 error: a CMAF Error event naming "HTTP Not Found" for the session.
    const events = camera.eventQueue.query();
    assert(events.some(e => e.type === proto.CameraBufferEventType.CMAF_ERROR && e.cmafSessionId === SESSION_ID
      && e.error === proto.CmafError.HTTP_NOT_FOUND), `a CMAF Error event names HTTP Not Found: ${JSON.stringify(events,
      (k, v) => typeof v === 'bigint' ? v.toString() : v)}`);
  });

test('with upload off the accessory refuses the command and queues a CMAF Error', async t => {
  const env = environment({ realHap: true });
  const P = env.load(base + 'hksv-cmaf-protection.ts');
  const clip = recordedClip(P.readBoxes);
  const { source, first, last } = recordingSource(env, clip);
  const a = accessory(env, { recordingSource: source });   // cmafUploadMode defaults to off
  t.after(() => a.close());
  const proto = env.load(base + 'hksv-recording-protocol.ts');
  const { tlvEncode } = env.load(base + 'hksv-stream-tiers.ts');
  const buffers = service(a.acc, proto.CameraBufferManagementServiceUUID);
  await assert.rejects(write(buffers, 'Buffer Upload Command', tlvEncode(
    1, proto.u64(7n), 2, 2, 3, proto.u64(first), 4, proto.u64(last), 5, 2)));
  assert(a.logs.some(l => String(l).includes('CMAF direct upload is off')),
    'the reason names the setting that turns it on');
});

test('a Camera Key that is not 16 bytes is called out when the upload starts',
  { skip: pki.available() ? false : 'openssl is unavailable' }, async t => {
    const { logs } = await uploadClip(t, { key: Buffer.alloc(32, 7) });
    assert(logs.some(l => /the Camera Key is 32 bytes and the cenc reading assumes 16/.test(String(l))));
  });

test('cenc leaves every NAL header clear and never repeats an IV under one key', () => {
  const env = environment();
  const P = env.load(base + 'hksv-cmaf-protection.ts');
  const clip = recordedClip(P.readBoxes);
  const protection = new P.CmafCencProtection(CAMERA_KEY, KEY_NUMBER, 0n);
  protection.protectInit(clip.init);
  const ivs = new Set();
  for (const fragment of clip.fragments) {
    const protectedFragment = protection.protectFragment(fragment);
    const tops = P.readBoxes(protectedFragment);
    const moof = tops.find(b => b.type === 'moof');
    for (const traf of P.readBoxes(protectedFragment, moof.start + moof.headerSize, moof.start + moof.size)) {
      if (traf.type !== 'traf') continue;
      const senc = P.readBoxes(protectedFragment, traf.start + traf.headerSize, traf.start + traf.size)
        .find(k => k.type === 'senc');
      const flags = protectedFragment.readUInt32BE(senc.start + senc.headerSize) & 0xffffff;
      const count = protectedFragment.readUInt32BE(senc.start + senc.headerSize + 4);
      let at = senc.start + senc.headerSize + 8;
      for (let i = 0; i < count; i++) {
        const iv = protectedFragment.toString('hex', at, at + 8); at += 8;
        assert(!ivs.has(iv), 'an IV is never reused under one key');
        ivs.add(iv);
        if (!(flags & 2)) continue;
        const subsamples = protectedFragment.readUInt16BE(at); at += 2;
        for (let k = 0; k < subsamples; k++) {
          // 4-byte NAL length prefix plus the 2-byte HEVC NAL header stay readable.
          assert.equal(protectedFragment.readUInt16BE(at), 6, 'the NAL length and header are clear');
          at += 6;
        }
      }
    }
  }
  assert.equal(ivs.size, protection.snapshot().samplesEncrypted);
  assert.equal(protection.snapshot().kid, '0000000000000000000000000000002a', 'the KID carries the key number');
});
