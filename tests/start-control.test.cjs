const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { environment, base, quiet } = require('./helpers.cjs');

// Independent controller wire bytes; do not use the plugin's outbound integer encoder.
const field = (type, value) => Buffer.concat([Buffer.from([type, value.length]), value]);
const sid = Buffer.alloc(16, 0x12);
const start = values => Buffer.concat([field(1, sid), field(2, Buffer.from([2])),
    ...values.map((v, i) => field(i + 3, v))]);

test('RTP Start accepts HAP compact uint32 fields from zero through maximum unsigned value', () => {
    const { parseRTPStreamingControl } = environment().load(base + 'hksv-multitier-protocol.ts');
    for (const [bytes, number] of [[[], 0], [[1], 1], [[0xff], 255], [[0, 1], 256],
        [[0x56, 0x34, 0x12], 0x123456], [[0xff, 0xff, 0xff, 0xff], 0xffffffff]]) {
        const parsed = parseRTPStreamingControl(start(Array(4).fill(Buffer.from(bytes))));
        for (const key of ['videoTier', 'videoSSRC', 'audioTier', 'audioSSRC']) assert.equal(parsed[key], number);
    }
});

test('RTP malformed lengths, missing fields, duplicate scalars and invalid commands fail explicitly', () => {
    const { parseRTPStreamingControl } = environment().load(base + 'hksv-multitier-protocol.ts');
    const good = start([Buffer.from([1]), Buffer.from([2]), Buffer.from([1]), Buffer.from([3])]);
    for (const bad of [good.subarray(0, -1), Buffer.concat([good, Buffer.from([7])]),
        Buffer.concat([good, field(3, Buffer.from([1]))]),
        start([Buffer.alloc(5), Buffer.from([2]), Buffer.from([1]), Buffer.from([3])]),
        Buffer.concat([field(1, sid), field(2, Buffer.alloc(0))]),
        Buffer.concat([field(1, sid), field(2, Buffer.from([0]))]),
        Buffer.concat([field(1, Buffer.alloc(15)), field(2, Buffer.from([1]))]),
        Buffer.concat([field(1, sid), field(2, Buffer.from([2]))])]) {
        assert.throws(() => parseRTPStreamingControl(bad), e =>
            e.constructor.name === 'RTPStreamingControlParseError' && !(e instanceof RangeError));
    }
});

function fixture() {
    const env = environment({ realHap: true });
    const protocol = env.load(base + 'hksv-multitier-protocol.ts');
    const { MultiTierStreamManagement } = env.load(base + 'camera-multitier.ts');
    const requests = [];
    const mt = new MultiTierStreamManagement({ addService() {} }, {
        prepareStream(_request, callback) { callback(null, { addressOverride: '127.0.0.1',
            video: { port: 40000, ssrc: 123 }, audio: { port: 40001, ssrc: 456 } }); },
        handleStreamRequest(request, callback) { requests.push(request); callback(); },
    }, quiet, { sensorClass: '4k' });
    const connection = new EventEmitter(); connection.localAddress = '127.0.0.1';
    const setup = async sessionId => {
        const address = Buffer.concat([field(1, Buffer.from([0])), field(2, Buffer.from('127.0.0.1')),
            field(3, Buffer.from([0x40, 0x9c])), field(4, Buffer.from([0x41, 0x9c]))]);
        const crypto = Buffer.concat([field(1, Buffer.from([0])), field(2, Buffer.alloc(16)), field(3, Buffer.alloc(14))]);
        const value = Buffer.concat([field(1, sessionId), field(3, address), field(4, crypto), field(5, crypto)]).toString('base64');
        const response = await new Promise((resolve, reject) => mt.handleSetupEndpoints(value,
            (error, result) => error ? reject(error) : resolve(result), connection));
        assert.equal(protocol.tlvDecodeMap(Buffer.from(response, 'base64'))[2][0], 0);
    };
    const control = bytes => new Promise((resolve, reject) => mt.handleStreamingControl(bytes.toString('base64'),
        (error, result) => error ? reject(error) : resolve(protocol.parseRTPStreamingControlResponse(Buffer.from(result, 'base64')).status)));
    return { mt, requests, setup, control, connection };
}

test('endpoint setup followed by compact Start reaches the HEVC delegate and End releases it', async () => {
    const f = fixture();
    try {
        await f.setup(sid);
        assert.equal(await f.control(start([Buffer.from([1]), Buffer.from([0x56, 0x34, 0x12]), Buffer.from([1]), Buffer.from([3])])), 0);
        const request = f.requests.find(r => r.type === 'start');
        assert.equal(request.video.codec, 1);
        assert.equal(request.video.ssrc, 0x123456);
        assert.equal(request.video.width, 3840);
        assert.equal(request.audio.rtpClockRate, 48000);
        assert.equal(await f.control(Buffer.concat([field(1, sid), field(2, Buffer.from([1]))])), 0);
        assert.equal(f.mt.sessions.size, 0);
        assert.equal(f.connection.listenerCount('closed'), 0);
    } finally { f.mt.closeAllSessions(); }
});

test('failed and cancelled prepared sessions cannot exhaust the eight RTP slots', async () => {
    const f = fixture();
    try {
        for (let i = 0; i < 20; i++) {
            await f.setup(sid);
            const command = i % 2 ? 1 : 2;
            // Start with missing fields or End before Start; both must release prepared sockets.
            assert.equal(await f.control(Buffer.concat([field(1, sid), field(2, Buffer.from([command]))])), command === 1 ? 2 : 4);
            assert.equal(f.mt.sessions.size, 0);
        }
        assert.equal(f.requests.filter(r => r.type === 'stop').length, 20);
        assert.equal(f.connection.listenerCount('closed'), 0);
        await assert.rejects(f.control(Buffer.from([1, 1, 7])), e => e === -70410);
    } finally { f.mt.closeAllSessions(); }
});
