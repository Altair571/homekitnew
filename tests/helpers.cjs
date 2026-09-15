const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const bundle = fs.readFileSync(process.env.HK_TEST_BUNDLE || path.join(__dirname, '../dist/main.nodejs.js'), 'utf8');
const marker = 'var __webpack_exports__ = {};\n// This entry needs';
if (!bundle.includes(marker)) throw new Error('Webpack bootstrap marker missing');
const bootstrap = bundle.slice(0, bundle.indexOf(marker)) +
 'globalThis.review = { load: __webpack_require__, mock: (id, value) => { __webpack_module_cache__[id] = { exports: value }; } };\n})();';
const quiet = { log() {}, warn() {}, error() {} };
const never = new Promise(() => {});
class Characteristic extends EventEmitter {
  constructor(name, uuid, props) { super(); this.displayName = name; this.UUID = uuid; this.props = props; }
  updateValue(value) { this.value = value; return this; }
}
class Service {
  constructor(name, uuid) { this.UUID = uuid; this.characteristics = []; }
  addCharacteristic(c) { this.characteristics.push(c); return c; }
}
const hap = {
  Characteristic, Service,
  Formats: { TLV8: 'tlv8', DATA: 'data', BOOL: 'bool', UINT8: 'uint8' },
  Perms: { PAIRED_READ: 'pr', PAIRED_WRITE: 'pw', NOTIFY: 'ev', TIMED_WRITE: 'tw', WRITE_RESPONSE: 'wr' },
  VideoCodecType: { H264: 0, H265: 1 },
  H264Profile: { HIGH: 2, BASELINE: 0 }, H264Level: { LEVEL4_0: 2 },
  AudioStreamingCodecType: { OPUS: 'OPUS', AAC_ELD: 'AAC-eld' },
  AudioStreamingSamplerate: { KHZ_16: 16, KHZ_24: 24 },
  SRTPCryptoSuites: { AES_CM_128_HMAC_SHA1_80: 0 },
  StreamRequestTypes: { START: 'start', STOP: 'stop', RECONFIGURE: 'reconfigure' },
};

function environment({ fakeTimers = false, realHap = false, mediaManager = {} } = {}) {
  const sdk = { mediaManager, deviceManager: {}, log: quiet, ScryptedDeviceBase: class {} };
  const context = vm.createContext({
    Buffer, Uint8Array, ArrayBuffer, DataView, console: quiet, URL, URLSearchParams, AbortController, AbortSignal, TextEncoder, TextDecoder,
    process, performance, queueMicrotask, setImmediate, clearImmediate,
    setTimeout: fakeTimers ? () => ({}) : setTimeout, clearTimeout: fakeTimers ? () => {} : clearTimeout,
    setInterval, clearInterval,
    require(id) { if (id === 'source-map-support/register') return {}; if (id === '@scrypted/sdk') return sdk; return require(id); },
  });
  vm.runInContext(bootstrap, context, { timeout: 3000 });
  if (!realHap) context.review.mock('./src/hap.ts', hap);
  Object.assign(context.review.load('../../sdk/dist/src/index.js').default, sdk);
  return context.review;
}
function storage(values = {}) {
  const m = new Map(Object.entries(values));
  return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: k => m.delete(k) };
}
const base = './src/types/camera/';
module.exports = { environment, storage, base, quiet, never, hap };
