const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { environment, base, quiet } = require('./helpers.cjs');
const tick = () => new Promise(setImmediate);
const jpeg = length => { const b = Buffer.alloc(length, 0x42); b[0] = 0xff; b[1] = 0xd8; b[length - 2] = 0xff; b[length - 1] = 0xd9; return b; };

function fixture(takeSnapshot = async () => jpeg(64), extra = {}) {
    const env = environment({ realHap: true });
    const hap = env.load('./src/hap.ts');
    const recording = new hap.RecordingManagement({
        prebufferLength: 4000, mediaContainerConfiguration: { type: 0, fragmentLength: 4000 },
        video: { type: 0, parameters: { profiles: [0], levels: [0] }, resolutions: [[1280, 720, 30]] },
        audio: { codecs: { type: 0, audioChannels: 1, samplerate: 2, bitrateMode: 0 } },
    }, { updateRecordingActive() {}, updateRecordingConfiguration() {} }, new Set());
    const logs = [], captures = [];
    let active = true;
    const { HdsSnapshotTransport } = env.load(base + 'camera-hds-snapshot.ts');
    const snapshots = new HdsSnapshotTransport(recording, { width: 3840, height: 2160,
        takeSnapshot: async r => { captures.push(r); return takeSnapshot(r); }, isActive: () => active,
        console: { ...quiet, log: m => logs.push(m) }, ...extra });
    const connections = [];
    const connection = () => {
        const c = new EventEmitter(); c.responses = []; c.events = [];
        c.sendResponse = (protocol, topic, id, status, payload) => c.responses.push({ protocol, topic, id, status, payload });
        c.sendEvent = (protocol, topic, payload) => c.events.push({ protocol, topic, payload });
        connections.push(c); return c;
    };
    const c = connection();
    const dispatch = (conn, topic, message, type = hap.MessageType.REQUEST) =>
        recording.dataStreamManagement.dataStreamServer.handleMessageGlobally(conn, { protocol: 'dataSend', topic, type, id: 1, message });
    const open = (message = {}, conn = c) => dispatch(conn, 'open', { type: 'ipcamera.snapshot', target: 'controller', streamId: 1,
        metadata: { 'image-width': 1280, 'image-height': 720 }, reason: 'periodic', ...message });
    const event = (topic, message, conn = c) => dispatch(conn, topic, message, hap.MessageType.EVENT);
    return { env, hap, recording, snapshots, logs, captures, c, connection, open, event,
        deactivate() { active = false; snapshots.closeAll(); },
        close() { snapshots.closeAll(); for (const conn of connections) conn.emit('closed'); recording.destroy(); } };
}

test('HDS snapshot bypasses legacy recording rejection, sends chunked JPEG, and waits for matching ACK', async () => {
    const image = jpeg(600000), f = fixture(async () => image);
    try {
        f.open(); await tick(); await tick(); await tick();
        assert.equal(f.c.responses.length, 1); assert.equal(f.c.responses[0].status, 0);
        assert.equal(f.captures[0].width, 3840); assert.equal(f.captures[0].height, 2160); assert.equal(f.captures[0].reason, 0);
        const events = f.c.events.filter(e => e.topic === 'data');
        assert.equal(events.length, 3);
        assert.deepEqual(Buffer.concat(events.map(e => e.payload.packets[0].data)), image);
        events.forEach((e, i) => {
            const m = e.payload.packets[0].metadata;
            assert.equal(m.dataChunkSequenceNumber, i + 1); assert.equal(m.dataSequenceNumber, 1);
            assert.equal(m.dataType, 'image'); assert.equal(m.isLastDataChunk, i === 2);
            assert.equal(e.payload.endOfStream, i === 2);
            assert.equal(m.dataTotalSize, i === 0 ? image.length : undefined);
        });
        assert.equal(f.snapshots.transfers.size, 1);
        f.event('ack', { streamId: 2, endOfStream: true });
        assert.equal(f.snapshots.transfers.size, 1);
        f.event('ack', { streamId: 1, endOfStream: true }, f.connection());
        assert.equal(f.snapshots.transfers.size, 1);
        f.event('ack', { streamId: 1, endOfStream: false });
        assert.equal(f.snapshots.transfers.size, 1);
        f.event('ack', { streamId: 1, endOfStream: true });
        assert.equal(f.snapshots.transfers.size, 0);
        assert(f.logs.some(l => l.includes('snapshot acknowledged')));
        assert.equal(f.c.listenerCount('closed'), 0);
    } finally { f.close(); }
});

test('HDS retains legacy recording admission and rejects unknown request types exactly once', () => {
    const f = fixture();
    try {
        f.open({ type: 'ipcamera.recording' });
        assert.equal(f.c.responses.length, 1);
        assert.equal(f.c.responses[0].payload.status, 1, 'existing Recording Active gate');
        f.open({ type: 'unknown.media' });
        assert.equal(f.c.responses.length, 2);
        assert.equal(f.c.responses[1].payload.status, 5, 'original unknown-type rejection');
        assert.equal(f.captures.length, 0);
    } finally { f.close(); }
});

test('HDS rejects invalid requests and does not capture while camera is off', async () => {
    const f = fixture();
    try {
        for (const message of [{ target: 'accessory' }, { streamId: -1 }, { streamId: '1' },
            { metadata: { width: 0 } }, { metadata: { height: 9000 } }, { metadata: Buffer.alloc(5) }]) f.open(message);
        assert(f.c.responses.every(r => r.payload.status === 7));
        assert.equal(f.captures.length, 0);
        f.deactivate(); f.open();
        assert.equal(f.c.responses.at(-1).payload.status, 1); assert.equal(f.captures.length, 0);
    } finally { f.close(); }
});

test('HDS capture failure and non-JPEG output close the stream without sending invalid media', async () => {
    for (const source of [async () => { throw -70412; }, async () => Buffer.from('not an image')]) {
        const f = fixture(source);
        try {
            f.open(); await tick();
            assert.equal(f.snapshots.transfers.size, 0);
            assert.equal(f.c.events.filter(e => e.topic === 'data').length, 0);
            assert.equal(f.c.events.at(-1).topic, 'close');
        } finally { f.close(); }
    }
});

test('HDS cancellation, disconnect and privacy changes suppress late capture results', async () => {
    for (const cause of ['close', 'disconnect', 'off']) {
        let resolve;
        const f = fixture(() => new Promise(r => { resolve = r; }));
        try {
            f.open();
            if (cause === 'close') f.event('close', { streamId: 1, reason: 3 });
            else if (cause === 'disconnect') f.c.emit('closed');
            else f.deactivate();
            resolve(jpeg(64)); await tick();
            assert.equal(f.snapshots.transfers.size, 0);
            assert.equal(f.c.events.filter(e => e.topic === 'data').length, 0);
            assert.equal(f.snapshots.pendingCaptures, 0);
        } finally { f.close(); }
    }
});

test('HDS pending capture limits survive timeouts and ACK timeout releases sent media', async () => {
    const resolves = [];
    const f = fixture(() => new Promise(r => resolves.push(r)), { timeoutMs: 10 });
    try {
        f.open(); f.open({ streamId: 2 }); f.open({ streamId: 3 });
        assert.equal(f.captures.length, 2); assert.equal(f.c.responses.at(-1).payload.status, 2);
        await new Promise(r => setTimeout(r, 25));
        assert.equal(f.snapshots.transfers.size, 0);
        f.open({ streamId: 4 }); assert.equal(f.captures.length, 2, 'timed-out captures still occupy bounded work slots');
        resolves.forEach(r => r(jpeg(64))); await tick();
        assert.equal(f.snapshots.pendingCaptures, 0);
        assert.equal(f.c.events.filter(e => e.topic === 'data').length, 0);
    } finally { f.close(); }
    const g = fixture(async () => jpeg(64), { timeoutMs: 10 });
    try {
        g.open(); await tick();
        assert.equal(g.snapshots.transfers.size, 1);
        await new Promise(r => setTimeout(r, 25));
        assert.equal(g.snapshots.transfers.size, 0);
        assert.equal(g.c.events.at(-1).payload.reason, 6);
    } finally { g.close(); }
});
