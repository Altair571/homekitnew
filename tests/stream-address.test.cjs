const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const { once } = require('node:events');
const { environment, base, storage, quiet } = require('./helpers.cjs');
const v4 = '127.0.0.1', v6 = 'fd93:39fa:3489:1dca:7fb0:4e44:5b99:e193';
const interfaces = { Ethernet: [{ address: v4, family: 'IPv4' }, { address: v6, family: 'IPv6' }] };

function selector() { return environment().load(base + 'camera-streaming-address.ts').selectCameraStreamAddress; }

test('IPv6 control with IPv4 RTP selects the assigned configured IPv4 address', async () => {
    assert.equal(await selector()('udp4', v6, '192.168.1.102', 50000, [v6, v4], interfaces), v4);
});

test('family mismatch recovers on the same adapter with absent, wrong-family or stale settings', async () => {
    for (const configured of [undefined, [], [v6], ['192.168.1.99']])
        assert.equal(await selector()('udp4', v6, '192.168.1.102', 50000, configured, interfaces), v4);
});

test('same-family and IPv4-mapped control addresses preserve working endpoints', async () => {
    for (const source of [v4, '::ffff:127.0.0.1', '::FFFF:127.0.0.1'])
        assert.equal(await selector()('udp4', source, v4, 50000, [], interfaces), v4);
    assert.equal(await selector()('udp6', v6, 'fd93:39fa:3489:1dca::2', 50000, [v6], interfaces), v6);
});

test('explicit local override takes precedence and stale overrides never become endpoints', async () => {
    const nics = { ...interfaces, Wired: [{ address: '192.168.1.10', family: 'IPv4' }] };
    assert.equal(await selector()('udp4', v4, '192.168.1.102', 50000, ['192.168.1.10'], nics), '192.168.1.10');
    assert.equal(await selector()('udp4', v4, '192.168.1.102', 50000, ['192.168.1.99'], nics), v4);
});

test('IPv4 control with IPv6 RTP and canonical IPv6 addresses select the correct adapter', async () => {
    const select = selector();
    assert.equal(await select('udp6', v4, 'fd93:39fa:3489:1dca::2', 50000, [], interfaces), v6);
    const nics = { Ethernet: [{ address: 'fd00:0:0:0:0:0:0:10' }, { address: v4 }] };
    assert.equal(await select('udp4', 'fd00::10', v4, 50000, [], nics), v4);
    await assert.rejects(select('udp4', v6, '::1', 50000, [], interfaces), /family does not match/);
});

test('IPv6 link-local addresses retain the interface scope needed for UDP binding', async () => {
    const select = selector();
    const nics = { Ethernet: [{ address: v4 }, { address: 'fe80::10', scopeid: 7 }] };
    assert.equal(await select('udp6', v4, 'fe80::2%7', 50000, [], nics), 'fe80::10%7');
    assert.equal(await select('udp6', 'fe80::10%7', 'fe80::2%7', 50000, [], nics), 'fe80::10%7');
    assert.equal(await select('udp4', 'fe80::10%7', v4, 50000, [], nics), v4);
});

test('ambiguous adapter fallback uses an OS route without sending application packets', async () => {
    const receiver = dgram.createSocket('udp4');
    receiver.bind(0, v4); await once(receiver, 'listening');
    let packets = 0; receiver.on('message', () => packets++);
    try {
        const address = await selector()('udp4', 'fd00::dead', v4, receiver.address().port, [], { Loopback: [{ address: v4 }] });
        assert.equal(address, v4);
        await new Promise(r => setImmediate(r));
        assert.equal(packets, 0);
    } finally { receiver.close(); }
});

test('routing errors and timeouts close the temporary socket', async () => {
    const { EventEmitter } = require('node:events');
    for (const outcome of ['error', 'timeout']) {
        const env = environment(); let closed = false;
        const socket = new EventEmitter();
        socket.connect = () => { if (outcome === 'error') queueMicrotask(() => socket.emit('error', Error('no route'))); };
        socket.close = () => { closed = true; };
        env.mock('dgram', { createSocket: () => socket });
        // Keep the test process alive while the implementation's timeout is unref'ed.
        const keepAlive = setTimeout(() => {}, 3000);
        try {
            await assert.rejects(env.load(base + 'camera-streaming-address.ts').selectCameraStreamAddress(
                'udp4', v6, v4, 50000, [], {}), outcome === 'error' ? /no route/ : /timed out/);
            assert.equal(closed, true);
        } finally { clearTimeout(keepAlive); }
    }
});

test('real HAP legacy setup over IPv6 returns valid IPv4 media endpoints and releases sockets', async () => {
    const env = environment({ realHap: true });
    env.mock('os', { networkInterfaces: () => interfaces });
    env.mock('./src/address-override.ts', { getScryptedServerAddresses: async () => [v6, v4] });
    env.mock(base + 'camera-snapshot.ts', { createSnapshotHandler: () => () => {} });
    const hap = env.load('./src/hap.ts');
    const delegate = env.load(base + 'camera-streaming.ts').createCameraStreamingDelegate({ interfaces: [] }, quiet, storage(), {});
    const acc = new hap.Accessory('Dual stack', '00000000-0000-4000-8000-000000001113');
    const controller = new hap.CameraController({ cameraStreamCount: 1,
        streamingOptions: { supportedCryptoSuites: [0], video: { codec: { profiles: [1], levels: [2] }, resolutions: [[640,360,30]] },
            audio: { codecs: [{ type: 'OPUS', samplerate: 24 }] } }, delegate });
    acc.configureController(controller);
    const { EventEmitter } = require('node:events');
    const connection = Object.assign(new EventEmitter(), { remoteAddress: 'fd00::2', localAddress: v6 });
    const tlv = env.load(base + 'hksv-stream-tiers.ts');
    const decode = env.load(base + 'hksv-multitier-protocol.ts').tlvDecodeMap;
    const sid = Buffer.alloc(16, 0x34), key = Buffer.alloc(16, 0xab), salt = Buffer.alloc(14, 0xcd);
    const crypto = tlv.tlvEncode(1, Buffer.from([0]), 2, key, 3, salt);
    const value = tlv.tlvEncode(1, sid, 3, tlv.tlvEncode(1, Buffer.from([0]), 2, Buffer.from(v4),
        3, Buffer.from([0x40, 0x9c]), 4, Buffer.from([0x41, 0x9c])), 4, crypto, 5, crypto).toString('base64');
    const setup = controller.streamManagements[0].getService().getCharacteristic(hap.Characteristic.SetupEndpoints);
    let ports;
    try {
        await setup.handleSetRequest(value, connection);
        const response = decode(Buffer.from(await setup.handleGetRequest(connection), 'base64'));
        assert.equal(response[2][0], 0, 'HAP setup succeeds rather than -70402');
        const address = decode(response[3]);
        assert.equal(address[1][0], 0); assert.equal(address[2].toString(), v4);
        assert.deepEqual(decode(response[4])[2], key); assert.deepEqual(decode(response[4])[3], salt);
        ports = [address[3].readUInt16LE(), address[4].readUInt16LE()];
        assert(ports.every(port => port > 0)); assert.notEqual(ports[0], ports[1]);
    } finally {
        connection.emit('closed'); controller.handleControllerRemoved();
        await new Promise(r => setImmediate(r));
    }
    for (const port of ports) {
        const socket = dgram.createSocket('udp4');
        try { socket.bind(port, v4); await once(socket, 'listening'); }
        finally { socket.close(); }
    }
});
