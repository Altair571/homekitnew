// iOS 27 CMAF direct upload (r44). On iOS/tvOS 27 the accessory posts its own HomeKit Secure
// Video clips to Apple's publishing point with no home hub in the media path, so these tests
// drive the whole §3.5/§3.9/§3.10 provisioning sequence through the real HAP characteristics and
// watch the clip land on a publishing point that demands the certificate the plugin was issued.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { environment, base, storage, quiet } = require('./helpers.cjs');
const pki = require('./cmaf-pki.cjs');
const { recordedClip, publishingPoint, decryptClip } = require('./cmaf-helpers.cjs');

const CAMERA_KEY = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
const KEY_NUMBER = 42n;

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
  const camera = new Hksv27Camera(acc, {}, store, { ...quiet, log: m => logs.push(m), error: m => logs.push(m) }, {
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
async function provision(env, acc, authority, url, { withKey = true } = {}) {
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
    await write(keys, 'Camera Key', tlvEncode(1, CAMERA_KEY, 2, proto.u64(KEY_NUMBER)));
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

async function uploadClip(t, { mode = 'cenc', pointOptions = {} } = {}) {
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
    { withKey: mode === 'cenc' });
  await settle(() => a.logs.some(l => String(l).includes('recording buffer ready')), 'the recorder to start');
  // The buffer refuses to open a window until it holds the init segment and some media.
  await settle(() => { try { a.camera.recordingBuffer.open(first); return true; } catch { return false; } },
    'the recording buffer to fill');
  // A Start-and-Stop upload of the whole buffered window, finalized (§4.9).
  const response = await write(buffers, 'Buffer Upload Command', tlvEncode(
    1, proto.u64(7n), 2, 2, 3, proto.u64(first), 4, proto.u64(last), 5, 2));
  const parsed = env.load(base + 'hksv-multitier-protocol.ts').tlvDecodeMap(response);
  const id = proto.readUIntLE(parsed[1]);
  await settle(() => point.requests.some(r => r.name === '' && r.bytes > 0), 'the clip to be closed');
  return { env, P, point, clip, id, logs: a.logs, camera: a.camera, authority };
}

test('a provisioned accessory uploads an encrypted clip to a publishing point that demands its certificate',
  { skip: pki.available() ? false : 'openssl is unavailable' }, async t => {
    const { P, point, clip, id } = await uploadClip(t);

    const objects = point.requests.filter(r => r.bytes > 0 || r.name === '');
    assert.equal(objects[0].name, '', 'the session opens with the DASH-IF connectivity probe');
    assert.equal(objects[1].name, 'init.mp4', 'the CMAF Header is posted before any media');
    assert.deepEqual(objects.slice(2, -1).map(r => r.name), ['1.m4s', '2.m4s', '3.m4s'],
      'each fragment is one object, numbered in order');
    assert.equal(objects[objects.length - 1].name, '', 'an empty mfra closes the clip');
    for (const request of objects) {
      // The plugin names its CSR after the accessory, so the far end sees which camera uploaded.
      assert.match(request.subject, /^scrypted-[0-9a-f]+$/, 'mutual TLS used the provisioned identity');
      assert.equal(request.contentType, 'video/mp4');
      assert.match(request.userAgent, /^DASH-IF-Ingest\//);
    }

    // The publishing point reassembles a CMAF Header whose tracks are marked protected...
    const uploaded = point.clip(id);
    const stsd = [];
    (function walk(buf, start, end) {
      for (const b of P.readBoxes(buf, start, end)) {
        if (b.type === 'stsd') { stsd.push(b); continue; }
        if (['moov', 'trak', 'mdia', 'minf', 'stbl'].includes(b.type)) walk(buf, b.start + b.headerSize, b.start + b.size);
      }
    })(uploaded.init, 0, uploaded.init.length);
    const formats = stsd.flatMap(s => P.readBoxes(uploaded.init, s.start + s.headerSize + 8, s.start + s.size).map(e => e.type));
    assert.deepEqual(formats, ['encv', 'enca'], 'both tracks are common-encryption sample entries');
    assert(P.readBoxes(uploaded.init)[0].type === 'ftyp');

    // ...and a holder of the Camera Key gets the recorder's exact bytes back.
    const plain = decryptClip(P, CAMERA_KEY, uploaded.media);
    assert.equal(plain.length, clip.fragments.length);
    for (const [i, fragment] of plain.entries()) {
      const original = P.readBoxes(clip.fragments[i]).find(b => b.type === 'mdat');
      assert.deepEqual(fragment.mdat,
        clip.fragments[i].subarray(original.start + original.headerSize, original.start + original.size),
        `fragment ${i + 1} decrypts to the recorded media`);
    }
  });

test('an unprotected upload sends the recorder\'s own bytes, and a key is not required',
  { skip: pki.available() ? false : 'openssl is unavailable' }, async t => {
    const { P, point, clip, id } = await uploadClip(t, { mode: 'clear' });
    const uploaded = point.clip(id);
    for (const [i, fragment] of uploaded.media.entries()) {
      // Only the styp the ingest adds separates the posted object from what the recorder made.
      const boxes = P.readBoxes(fragment);
      assert.equal(boxes[0].type, 'styp', 'each media object is a self-describing CMAF segment');
      assert.deepEqual(fragment.subarray(boxes[0].size), clip.fragments[i], `fragment ${i + 1} is unmodified`);
    }
    assert(!P.readBoxes(uploaded.init).some(b => b.type === 'senc'));
  });

test('a publishing point that lost the CMAF Header gets it again and the fragment is retried',
  { skip: pki.available() ? false : 'openssl is unavailable' }, async t => {
    // The first init POST fails, so the fragments that follow meet a point with no header: the
    // 412 it answers with is the "HTTP Init Missing" the specification enumerates.
    const { point } = await uploadClip(t, { pointOptions: { failInitOnce: true } });
    const names = point.requests.map(r => r.name);
    assert.equal(names.filter(n => n === 'init.mp4').length, 2, 'the header is posted again');
    assert(names.indexOf('1.m4s') < names.lastIndexOf('init.mp4'), 'the re-post follows the rejected fragment');
    assert(names.lastIndexOf('1.m4s') > names.lastIndexOf('init.mp4'), 'and the fragment is retried after it');
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
