const test = require('node:test');
const assert = require('node:assert/strict');
const { environment, base, quiet } = require('./helpers.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Real bundled DTLS and SRTP over an in-memory datagram link. The ICE gate
// controls nomination ordering: a remote client may send its first hello
// before the local ICE start promise has resumed. No private keys leave this
// fixture, and no UDP sockets or real camera are opened.
async function fixture(earlyHello, t, options = {}) {
    const env = environment();
    const id = '../../external/werift/packages/webrtc/src/index.ts';
    const werift = env.load(id);
    let nominate;
    const nominated = new Promise(resolve => nominate = resolve);
    class Peer extends werift.RTCPeerConnection {
        addTransceiver(...args) {
            const t = super.addTransceiver(...args);
            const ice = t.dtlsTransport.iceTransport;
            ice.connection.gatherCandidates = async () => {};
            ice.start = async () => {
                await nominated;
                const candidate = { type: 'host', host: '127.0.0.1', transport: 'udp' };
                ice.connection.nominated = { localCandidate: candidate, remoteCandidate: candidate };
                ice.setState('connected');
            };
            return t;
        }
    }
    env.mock(id, { ...werift, RTCPeerConnection: Peer });
    const proto = env.load(base + 'hksv-webrtc-protocol.ts');
    const management = new (env.load(base + 'camera-webrtc.ts').WebRTCStreamManagement)({ addService() {} }, quiet, {
        sensorUuid: Buffer.alloc(16), supportedVideoTiersValue: '', supportedAudioTiersValue: '',
        videoTiers: [{ identifier: 1, width: 320, height: 180, frameRate: 15, averageBitrateKbps: 180 }],
        getMedia: async () => { throw Error('DTLS fixture must not open a camera'); },
    });
    management.startMedia = async () => {};
    let remote, client, session;
    const timers = new Set();
    const deliver = fn => { const timer = setImmediate(() => { timers.delete(timer); fn(); }); timers.add(timer); };
    let clientConnect;
    try {
        const offered = proto.parseWebRTCSolicitOfferResponse(Buffer.from(await management.handleSolicitOffer(''), 'base64'));
        assert.equal(offered.status, 0);
        session = management.sessions.get(offered.sessionId.toString('hex'));
        const transport = session.videoTransceiver.dtlsTransport;
        const ice = transport.iceTransport;
        remote = new Peer({ codecs: session.pc.config.codecs, headerExtensions: session.pc.config.headerExtensions });
        await remote.setRemoteDescription({ type: 'offer', sdp: offered.sdpOffer });
        const answer = await remote.createAnswer();
        assert.match(answer.sdp, /a=setup:active/);
        const { DtlsClient } = env.load('../../external/werift/packages/dtls/src/index.ts');
        const certificate = transport.localCertificate;
        let firstHello;
        const helloReceived = new Promise(resolve => firstHello = resolve);
        let initialHello, duplicateInjected = false, cookieHellos = 0, droppedVerify = false, droppedServer = false;
        const link = { type: 'memory', address: {}, onData() {}, close() {},
            send: async data => deliver(() => {
                if (!initialHello) initialHello = Buffer.from(data);
                if (data[0] === 22 && data[13] === 1 && data[60 + data[59]] > 0) cookieHellos++;
                if ((options.lateInitialHello || options.changedLateInitialHello) && data[0] === 22 && data[13] === 16 && !duplicateInjected) {
                    duplicateInjected = true;
                    assert.equal(transport.dtls.dtls.flight, 4);
                    const retransmit = Buffer.from(initialHello);
                    retransmit.writeUIntBE(20, 5, 6); // Retransmission uses a new record sequence.
                    if (options.changedLateInitialHello) {
                        retransmit[27] ^= 1; // Different random and record sequence zero, as in the r21 field trace.
                        retransmit.writeUIntBE(0, 5, 6);
                    }
                    ice.connection.onData.execute(retransmit);
                }
                ice.connection.onData.execute(data);
                firstHello();
            }) };
        let sentBeforeNomination = 0;
        ice.connection.send = async data => {
            if (!ice.connection.nominated) sentBeforeNomination++;
            if (options.dropVerify && data[0] === 22 && data[13] === 3 && !droppedVerify) {
                droppedVerify = true;
                return;
            }
            if (options.dropServerFlight && data[0] === 22 && [2, 11, 12, 14].includes(data[13]) && cookieHellos < 2) {
                droppedServer = true;
                return;
            }
            deliver(() => link.onData(data));
        };
        client = new DtlsClient({ cert: certificate.certPem, key: certificate.privateKey,
            signatureHash: certificate.signatureHash, transport: link, srtpProfiles: transport.srtpProfiles,
            extendedMasterSecret: true });
        // Catch on the original promise immediately, so fixture cancellation
        // cannot create an unhandled rejection during vendor retransmission.
        const errors = [];
        client.onError.subscribe(error => errors.push(error));
        if (earlyHello) {
            clientConnect = client.connect().catch(error => errors.push(error));
            await helloReceived;
            assert.equal(transport.dtls, undefined, 'first hello precedes DTLS receiver creation');
        }
        const response = await management.handleProvideAnswer(proto.encodeWebRTCProvideAnswer({
            sessionId: offered.sessionId, sdpAnswer: answer.sdp, additionalCandidates: [],
        }));
        assert.equal(proto.parseWebRTCSessionStatusResponse(response).status, 0);
        assert.equal(transport.state, 'new', 'no handshake before ICE nomination');
        const nominatedAt = performance.now();
        nominate();
        await delay(0);
        if (!earlyHello) clientConnect = client.connect().catch(error => errors.push(error));
        // First DTLS retransmit is 500ms in the bundled client. Waiting for it
        // would hide the lost ClientHello that this regression reproduces.
        const deadline = Date.now() + (options.dropVerify || options.dropServerFlight ? 1800 : 300);
        while ((!client.connected || !transport.srtpStarted) && Date.now() < deadline) await delay(5);
        assert.equal(sentBeforeNomination, 0);
        assert.equal(errors.length, 0);
        if (options.lateInitialHello) assert.equal(duplicateInjected, true);
        const stats = env.load(base + 'hksv-webrtc-dtls.ts').summarizeWebRTCDtls(transport);
        assert.equal(stats.handshakeGuardInstalled, true);
        if (options.changedLateInitialHello) {
            assert.equal(duplicateInjected, true);
            assert.equal(transport.srtpStarted, true, 'a different unverified hello must not reset the active key exchange');
            assert.equal(transport.dtls.dtls.flight, 6);
            assert.equal(stats.ignoredStaleClientHellos, 0);
            assert.equal(stats.ignoredUnverifiedClientHellos, 1);
            assert.equal(stats.decryptFailures, 0);
            const late = stats.clientHellos.find(hello => hello.flight === 4 && hello.cookieBytes === 0);
            assert.equal(late.sameInitialBody, false);
            assert.equal(late.sameInitialRandom, false);
            assert.equal(late.ignored, true);
            assert.ok(stats.recordTrace.some(record => record.direction === 'inbound' && record.epoch === 1));
        }
        assert.equal(stats.decryptFailures, 0);
        assert.ok(stats.clientHellos.some(hello => hello.cookieBytes > 0 && hello.sameInitialRandom));
        t.diagnostic(`server flight at verification: ${transport.dtls.dtls.flight}`);
        assert.equal(transport.srtpStarted, true, 'DTLS must finish without waiting for a ClientHello retransmission');
        assert.equal(client.connected, true);
        if (options.dropVerify) assert.equal(droppedVerify, true);
        if (options.dropServerFlight) {
            assert.equal(droppedServer, true);
            assert.ok(cookieHellos >= 2, 'cookie-bearing retry recovers the lost server flight');
        }
        if (options.duplicateAfterConnect || options.changedAfterConnect) {
            const server = transport.dtls;
            const keyPair = server.cipher.localKeyPair;
            const delayed = Buffer.from(initialHello);
            if (options.changedAfterConnect) delayed[27] ^= 1;
            ice.connection.onData.execute(delayed);
            await delay(0);
            assert.equal(server.connected, true, 'delayed initial hello cannot trigger renegotiation');
            assert.equal(server.dtls.flight, 6);
            assert.equal(server.cipher.localKeyPair, keyPair);
        }
        if (options.lateInitialHello || options.duplicateAfterConnect) {
            const stats = env.load(base + 'hksv-webrtc-dtls.ts').summarizeWebRTCDtls(transport);
            assert.equal(stats.ignoredStaleClientHellos, 1);
            assert.equal(stats.ignoredUnverifiedClientHellos, 1);
        }
        if (options.changedAfterConnect) {
            const stats = env.load(base + 'hksv-webrtc-dtls.ts').summarizeWebRTCDtls(transport);
            assert.equal(stats.ignoredStaleClientHellos, 0);
            assert.equal(stats.ignoredUnverifiedClientHellos, 1);
        }
        t.diagnostic(`DTLS/SRTP ready ${Math.round(performance.now() - nominatedAt)}ms after releasing ICE nomination`);
        const { SrtpSession, RtpHeader, RtpPacket, keyLength, saltLength } = env.load('../../external/werift/packages/rtp/src/index.ts');
        const keys = client.extractSessionKeys(keyLength(client.srtp.srtpProfile), saltLength(client.srtp.srtpProfile));
        const receiver = new SrtpSession({ profile: client.srtp.srtpProfile, keys: {
            localMasterKey: keys.localKey, localMasterSalt: keys.localSalt,
            remoteMasterKey: keys.remoteKey, remoteMasterSalt: keys.remoteSalt,
        } });
        let media;
        ice.connection.send = async packet => media = packet;
        const payload = Buffer.from([38, 1, 128, 42]);
        await transport.sendRtp(payload, new RtpHeader({ ssrc: 123, payloadType: 99, sequenceNumber: 1, timestamp: 90000 }));
        assert.deepEqual(RtpPacket.deSerialize(receiver.decrypt(media)).payload, payload, 'negotiated SRTP keys protect the original video payload');
    } finally {
        // End fixture flights to release the vendor's 500ms retry waits.
        if (client) client.dtls.flight = 99;
        if (session?.videoTransceiver.dtlsTransport.dtls) session.videoTransceiver.dtlsTransport.dtls.dtls.flight = 99;
        management.closeAllSessions();
        await remote?.close();
        for (const timer of timers) clearImmediate(timer);
        await clientConnect;
    }
}

test('DTLS completes when ClientHello arrives after ICE nomination', { timeout: 5000 }, t => fixture(false, t));
test('an early DTLS ClientHello survives ICE nomination without a retransmission delay', { timeout: 5000 }, t => fixture(true, t));
test('a delayed initial ClientHello cannot reset the server after key agreement starts', { timeout: 5000 }, t => fixture(true, t, { lateInitialHello: true }));
test('a delayed initial ClientHello cannot reset an established session', { timeout: 5000 }, t => fixture(true, t, { duplicateAfterConnect: true }));
test('a different late ClientHello preserves the active DTLS exchange and usable SRTP keys', { timeout: 5000 }, t => fixture(true, t, { changedLateInitialHello: true }));
test('a different unverified ClientHello preserves an established HomeKit DTLS association', { timeout: 5000 }, t => fixture(true, t, { changedAfterConnect: true }));
test('a cookie retry and different late ClientHello preserve loss recovery and usable SRTP keys', { timeout: 5000 }, t => fixture(true, t, { dropServerFlight: true, changedLateInitialHello: true }));
test('a lost HelloVerifyRequest still recovers on the client retransmission', { timeout: 5000 }, t => fixture(true, t, { dropVerify: true }));
test('a cookie-bearing ClientHello retransmission still recovers a lost server flight', { timeout: 5000 }, t => fixture(true, t, { dropServerFlight: true }));

function hookFixture() {
    const env = environment();
    const helper = env.load(base + 'hksv-webrtc-dtls.ts');
    const { Event } = env.load('../../external/werift/packages/common/src/index.ts');
    const received = [];
    const sendResult = Promise.resolve();
    const startResult = Promise.resolve();
    const connection = { onData: new Event(), send: () => sendResult };
    const transport = { iceTransport: { connection }, onStateChange: new Event(), state: 'new', role: 'server',
        start() { this.state = 'connecting'; this.dtls = { transport: { socket: { onData: data => received.push(data) } } }; return startResult; } };
    const originalSend = connection.send, originalStart = transport.start;
    const dispose = helper.protectWebRTCDtlsStartup(transport);
    const snapshot = () => JSON.parse(JSON.stringify(helper.summarizeWebRTCDtls(transport)));
    return { connection, transport, received, dispose, snapshot, originalStart, originalSend, sendResult, startResult };
}

function hello(payload = Buffer.from('private-client-random-and-cookie')) {
    const record = Buffer.alloc(25 + payload.length);
    record[0] = 22; record[1] = 254; record[2] = 253;
    record.writeUInt16BE(12 + payload.length, 11);
    record[13] = 1;
    record.writeUIntBE(payload.length, 14, 3);
    record.writeUIntBE(payload.length, 22, 3);
    payload.copy(record, 25);
    return record;
}

test('early hello retention is bounded, deduplicated and excluded from diagnostics', () => {
    const f = hookFixture();
    try {
        const packet = hello();
        f.connection.onData.execute(packet);
        f.connection.onData.execute(packet);
        for (let n = 0; n < 100; n++) f.connection.onData.execute(hello(Buffer.alloc(4000, n)));
        const malformed = hello(); malformed.writeUInt16BE(65535, 11);
        f.connection.onData.execute(malformed);
        f.connection.onData.execute(Buffer.from([128, 99, 0, 0])); // RTP is never retained.
        assert.equal(f.received.length, 0, 'pre-nomination input must not reach DTLS');
        f.connection.nominated = {};
        assert.equal(f.transport.start(), f.startResult);
        assert.ok(f.received.reduce((total, data) => total + data.length, 0) <= 16384);
        assert.ok(f.received.length <= 8);
        assert.equal(f.received.filter(data => data.equals(packet)).length, 1);
        const snapshot = f.snapshot();
        assert.equal(snapshot.earlyClientHellos, 102);
        assert.equal(snapshot.inboundDatagrams, 102);
        assert.equal(snapshot.replayedClientHellos + snapshot.discardedClientHellos, 102);
        assert.equal(JSON.stringify(snapshot).includes('private'), false);
        snapshot.inboundHandshakes.clientHello = 0;
        assert.equal(f.snapshot().inboundHandshakes.clientHello, 102);
        assert.equal(f.connection.send(packet), f.sendResult, 'send promise identity is preserved');
        assert.equal(f.snapshot().outboundHandshakes.clientHello, 1);
    } finally { f.dispose(); }
    assert.equal(f.connection.onData.length, 0);
    assert.equal(f.transport.onStateChange.length, 0);
    assert.equal(f.connection.send, f.originalSend);
    assert.equal(f.transport.start, f.originalStart);
});

test('expired, canceled or client-role startup discards early datagrams', { timeout: 4000 }, async () => {
    for (const reason of ['expired', 'canceled', 'client']) {
        const f = hookFixture();
        try {
            f.connection.onData.execute(hello());
            if (reason === 'expired') await delay(2050);
            if (reason === 'canceled') f.dispose();
            if (reason === 'client') f.transport.role = 'client';
            f.connection.nominated = {};
            f.transport.start();
            assert.equal(f.received.length, 0, reason);
            assert.equal(f.snapshot().discardedClientHellos, 1, reason);
        } finally { f.dispose(); }
    }
});

test('completed DTLS releases startup observers and normal packets are not replayed', () => {
    const f = hookFixture();
    try {
        f.connection.nominated = {};
        f.transport.start();
        f.connection.onData.execute(hello());
        assert.equal(f.snapshot().earlyClientHellos, 0, 'a live receiver owns all subsequent input');
        assert.equal(f.snapshot().replayedClientHellos, 0);
        f.transport.onStateChange.execute('connected');
        assert.equal(f.connection.onData.length, 0);
        assert.equal(f.connection.send, f.originalSend);
        assert.equal(f.transport.start, f.originalStart);
        assert.equal(f.snapshot().inboundHandshakes.clientHello, 1, 'counters survive hook cleanup');
    } finally { f.dispose(); }
});

test('DTLS record trace is bounded, detached from snapshots and contains framing only', () => {
    const f = hookFixture();
    try {
        f.connection.nominated = {};
        f.transport.start();
        for (let n = 0; n < 40; n++) {
            const packet = hello(Buffer.from('private-secret-cookie-and-certificate'));
            packet.writeUIntBE(n, 5, 6);
            packet.writeUInt16BE(n, 17);
            f.connection.onData.execute(packet);
        }
        const snapshot = f.snapshot();
        assert.equal(snapshot.recordTrace.length, 32);
        assert.equal(snapshot.omittedTraceRecords, 8);
        assert.equal(snapshot.recordTrace[3].sequence, 3);
        assert.equal(snapshot.recordTrace[3].messages[0].sequence, 3);
        assert.equal(JSON.stringify(snapshot).includes('private-secret'), false);
        assert.equal(snapshot.handshakeGuardInstalled, false, 'missing callback is visible');
        snapshot.recordTrace[0].messages[0].type = 'mutated';
        assert.equal(f.snapshot().recordTrace[0].messages[0].type, 'clientHello');
        const bad = hello(); bad.writeUIntBE(65535, 22, 3);
        f.connection.onData.execute(bad);
        assert.equal(f.snapshot().inboundDatagrams, 40, 'malformed datagram omitted as a whole');
    } finally { f.dispose(); }
});

test('hello observations omit raw values and decryption observer preserves result, thrown error and cleanup', async () => {
    const env = environment();
    const helper = env.load(base + 'hksv-webrtc-dtls.ts');
    const { Event } = env.load('../../external/werift/packages/common/src/index.ts');
    const failure = new Error('private record error');
    const cipher = { decryptPacket(value) { assert.equal(this, cipher); if (value === failure) throw failure; return value; } };
    const originalDecrypt = cipher.decryptPacket;
    const server = { cipher, dtls: { flight: 2 }, onHandleHandshakes: async () => {}, transport: { socket: { onData() {} } } };
    const originalHandle = server.onHandleHandshakes;
    const connection = { nominated: {}, onData: new Event(), send: async () => {} };
    const transport = { role: 'server', state: 'new', iceTransport: { connection }, onStateChange: new Event(),
        start() { this.dtls = server; this.state = 'connecting'; } };
    const dispose = helper.protectWebRTCDtlsStartup(transport);
    try {
        transport.start();
        const body = Buffer.alloc(80); body[0] = 254; body[1] = 253;
        Buffer.from('private-client-random').copy(body, 2);
        const first = { msg_type: 1, message_seq: 0, fragment: body };
        await server.onHandleHandshakes([first]);
        const cookie = Buffer.from(body); cookie[35] = 20;
        Buffer.from('private-cookie-value').copy(cookie, 36);
        await server.onHandleHandshakes([{ ...first, message_seq: 1, fragment: cookie }]);
        const changedExtensions = Buffer.from(body); changedExtensions[79]++;
        server.dtls.flight = 4;
        for (let n = 0; n < 12; n++) await server.onHandleHandshakes([{ ...first, fragment: changedExtensions }]);
        const result = Buffer.from('private plaintext');
        assert.equal(cipher.decryptPacket(result), result);
        assert.throws(() => cipher.decryptPacket(failure), error => error === failure);
        const snapshot = JSON.parse(JSON.stringify(helper.summarizeWebRTCDtls(transport)));
        assert.equal(snapshot.decryptFailures, 1);
        assert.equal(snapshot.handledHandshakes.clientHello, 14);
        assert.equal(snapshot.clientHellos.length, 8);
        assert.equal(snapshot.omittedClientHellos, 6);
        assert.equal(snapshot.clientHellos[1].sequence, 1);
        assert.equal(snapshot.clientHellos[1].cookieBytes, 20);
        assert.equal(snapshot.clientHellos[1].sameInitialRandom, true);
        assert.equal(snapshot.clientHellos[2].sameInitialBody, false);
        assert.equal(snapshot.clientHellos[2].sameInitialRandom, true);
        assert.equal(snapshot.clientHellos[2].ignored, true);
        assert.equal(snapshot.ignoredUnverifiedClientHellos, 12);
        assert.equal(snapshot.ignoredStaleClientHellos, 0);
        assert.equal(/private|digest|Buffer|plaintext/.test(JSON.stringify(snapshot)), false);
        snapshot.clientHellos[1].cookieBytes = 999;
        assert.equal(helper.summarizeWebRTCDtls(transport).clientHellos[1].cookieBytes, 20);
    } finally { dispose(); }
    assert.equal(cipher.decryptPacket, originalDecrypt);
    assert.equal(server.onHandleHandshakes, originalHandle);
});

test('unverified hello guard preserves opening hellos, cookie retries and other handshakes until disposal', async () => {
    const env = environment();
    const helper = env.load(base + 'hksv-webrtc-dtls.ts');
    const { Event } = env.load('../../external/werift/packages/common/src/index.ts');
    const received = [];
    const originalHandle = async function (messages) {
        assert.equal(this, server);
        received.push(...messages);
    };
    const server = { dtls: { flight: 0 }, onHandleHandshakes: originalHandle,
        transport: { socket: { onData() {} } } };
    const connection = { nominated: {}, onData: new Event(), send: async () => {} };
    const transport = { role: 'server', state: 'new', iceTransport: { connection }, onStateChange: new Event(),
        start() { this.dtls = server; this.state = 'connecting'; } };
    const dispose = helper.protectWebRTCDtlsStartup(transport);
    try {
        transport.start();
        const body = Buffer.alloc(40); body[0] = 254; body[1] = 253; body.fill(42, 2, 34);
        const initial = { msg_type: 1, fragment: body };
        await server.onHandleHandshakes([initial]);
        server.dtls.flight = 2;
        await server.onHandleHandshakes([initial]); // Opening retries still recover a lost HelloVerifyRequest.
        server.dtls.flight = 4;
        const keyExchange = { msg_type: 16, fragment: Buffer.from('private-key-exchange') };
        await server.onHandleHandshakes([initial, keyExchange]);
        const changed = { msg_type: 1, fragment: Buffer.from(body) }; changed.fragment[2]++;
        const cookie = { msg_type: 1, fragment: Buffer.from(body) }; cookie.fragment[35] = 1;
        const malformed = { msg_type: 1, fragment: Buffer.from(body) }; malformed.fragment[34] = 255;
        await server.onHandleHandshakes([changed, cookie, malformed]);
        assert.deepEqual(received, [initial, initial, keyExchange, cookie, malformed]);
        transport.onStateChange.execute('connected');
        server.dtls.flight = 6;
        await server.onHandleHandshakes([initial]);
        assert.equal(received.length, 5);
        const snapshot = JSON.stringify(helper.summarizeWebRTCDtls(transport));
        assert.equal(JSON.parse(snapshot).ignoredStaleClientHellos, 2);
        assert.equal(JSON.parse(snapshot).ignoredUnverifiedClientHellos, 3);
        assert.equal(snapshot.includes('private'), false);
        assert.equal(connection.onData.length, 0);
        assert.notEqual(server.onHandleHandshakes, originalHandle, 'guard remains until session closure');
    } finally { dispose(); }
    assert.equal(server.onHandleHandshakes, originalHandle);
    assert.equal(transport.onStateChange.length, 0);
});
