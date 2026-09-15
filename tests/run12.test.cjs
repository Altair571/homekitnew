const test = require('node:test');
const assert = require('node:assert/strict');
const { environment, base, storage, quiet } = require('./helpers.cjs');

// Read the on-wire fields independently of the plugin's encoders/decoders.
// These advertised tier records are shorter than TLV8's 255-byte fragment limit.
function fields(buffer) {
    const result = [];
    for (let at = 0; at < buffer.length;) {
        assert(at + 2 <= buffer.length, 'truncated TLV header');
        const type = buffer[at++], length = buffer[at++];
        assert(at + length <= buffer.length, 'truncated TLV value');
        if (type === 0) assert.equal(length, 0, 'nonempty separator');
        else result.push({ type, value: buffer.subarray(at, at + length) });
        at += length;
    }
    return result;
}
function one(records, type, bytes) {
    const found = records.filter(r => r.type === type);
    assert.equal(found.length, 1, `field ${type} must occur exactly once`);
    if (bytes !== undefined) assert.equal(found[0].value.length, bytes);
    return found[0].value;
}

test('published RTP and WebRTC tiers have one HEVC codec field, three video tiers, and one 48 kHz Opus tier', async () => {
    const env = environment({ realHap: true });
    const { Accessory } = env.load('./src/hap.ts');
    const { Hksv27Camera } = env.load(base + 'camera-hksv27.ts');
    const acc = new Accessory('Run 12 wire format', '00000000-0000-4000-8000-000000000012');
    const camera = new Hksv27Camera(acc, {}, storage(), quiet, { sensorClass: '4k', sensorWidth: 3840, sensorHeight: 2160 });
    try {
        for (const service of [camera.multiTier.service, camera.webrtc.service]) {
            const video = service.characteristics.find(c => /Supported Video Stream Tiers$/.test(c.displayName));
            // Exercise the characteristic read handler, as the controller does in Run 12.
            const advertised = await new Promise((resolve, reject) => video.emit('get', (error, value) => error ? reject(error) : resolve(value)));
            const records = fields(Buffer.from(advertised, 'base64'));
            assert.equal(one(records, 1, 1)[0], 2, 'H.265 enum');
            assert.equal(one(records, 2, 1)[0], 99, 'video payload type');
            const tiers = records.filter(r => r.type === 3).map(r => fields(r.value));
            assert.equal(tiers.length, 3);
            assert.deepEqual(tiers.map(t => [one(t, 1, 4).readUInt32LE(), one(t, 2, 1)[0],
                one(t, 4, 2).readUInt16LE(), one(t, 5, 2).readUInt16LE(), one(t, 6, 1)[0]]),
                [[1, 2, 3840, 2160, 30], [2, 3, 1920, 1080, 30], [3, 4, 640, 360, 15]]);
            const audio = service.characteristics.find(c => /Supported Audio Stream Tiers$/.test(c.displayName));
            const a = fields(Buffer.from(audio.value, 'base64'));
            assert.equal(one(a, 1, 1)[0], 3);
            assert.equal(one(a, 2, 1)[0], 110);
            const tier = fields(one(a, 3));
            assert.equal(one(tier, 3, 1)[0], 4, '48 kHz transmission rate');
            assert.equal(one(tier, 5, 1)[0], 20);
            assert.equal(one(tier, 6, 1)[0], 1);
        }
        assert.equal(camera.multiTier.findVideoTier(101), undefined, 'unadvertised H264 tier cannot be selected');
    } finally { camera.handleFactoryReset(); }
});

test('tier encoders reject duplicate codec groups and unsupported multiple audio tiers', () => {
    const api = environment().load(base + 'hksv-stream-tiers.ts');
    const video = { codec: 2, payloadType: 99, tiers: api.buildSensorVideoTiers(3840, 2160) };
    assert.throws(() => api.encodeSupportedVideoStreamTiers([video, { ...video, codec: 1 }]), /one.*codec/i);
    const audio = { codec: 3, payloadType: 110, tiers: [api.buildHksvOpusAudioTier()] };
    assert.throws(() => api.encodeSupportedAudioStreamTiers([audio, audio]), /one.*codec/i);
    assert.throws(() => api.encodeSupportedAudioStreamTiers([{ ...audio, tiers: [...audio.tiers, ...audio.tiers] }]), /one.*tier/i);
});
