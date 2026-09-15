const test = require('node:test');
const assert = require('node:assert/strict');
const { environment } = require('./helpers.cjs');

const iceBase = '../../external/werift/packages/ice/src/';
const deferred = () => {
    let resolve;
    const promise = new Promise(r => resolve = r);
    return { promise, resolve };
};

// Use the bundled ICE connection, candidate states and serialized STUN requests.
// Only the network is replaced: each synthetic path has independently gated
// connectivity and nomination responses. No camera, relay or sockets are used.
function fixture(t, { controlling = true, lite = true } = {}) {
    const env = environment();
    const { Connection } = env.load(iceBase + 'ice.ts');
    const { Candidate } = env.load(iceBase + 'candidate.ts');
    const { CandidatePair, CandidatePairState } = env.load(iceBase + 'iceBase.ts');
    const { Message, parseMessage } = env.load(iceBase + 'stun/message.ts');
    const { classes, methods } = env.load(iceBase + 'stun/const.ts');
    const connection = new Connection(controlling);
    const credentials = { iceLite: lite, usernameFragment: 'fixture-remote', password: 'fixture-only-password' };
    connection.setRemoteParams(credentials);
    t.after(() => connection.close());
    const requests = [], media = [];
    let sequence = 0;
    function path(name) {
        const check = deferred(), nomination = deferred(), nominationStarted = deferred();
        nomination.resolve();
        const number = ++sequence;
        const local = new Candidate(name, 1, 'udp', 2000 + number,
            '192.0.2.1', 40000 + number, 'host', undefined, undefined, undefined, connection.generation);
        const remote = new Candidate('relay', 1, 'udp', 1000,
            '198.51.100.1', 50000, 'host', undefined, undefined, undefined, connection.generation);
        const protocol = {
            type: 'stun', localCandidate: local,
            async request(request, address, integrityKey) {
                request.addMessageIntegrity(integrityKey).addFingerprint();
                const parsed = parseMessage(request.bytes, integrityKey);
                assert.ok(parsed, 'outgoing STUN bytes must parse and authenticate');
                assert.equal(parsed.messageMethod, methods.BINDING);
                assert.equal(parsed.messageClass, classes.REQUEST);
                const nominate = parsed.attributesKeys.includes('USE-CANDIDATE');
                requests.push({ path: name, nominate, generation: connection.generation });
                if (nominate) {
                    nominationStarted.resolve();
                    await protocol.nominationGate;
                } else {
                    await check.promise;
                }
                return [new Message(methods.BINDING, classes.RESPONSE, parsed.transactionId), address];
            },
            nominationGate: nomination.promise,
            async sendData(data, address) {
                assert.deepEqual(Array.from(address), [remote.host, remote.port]);
                media.push({ path: name, data: Buffer.from(data) });
            },
        };
        const pair = new CandidatePair(protocol, remote, controlling);
        connection.checkList.push(pair);
        const start = () => connection.checkStart(pair).awaitable;
        return { name, pair, protocol, check, nominationStarted, start };
    }
    return { connection, credentials, path, requests, media, CandidatePairState };
}

test('ICE-lite: a late successful connectivity check cannot nominate a second media path', { timeout: 3000 }, async t => {
    const f = fixture(t);
    const first = f.path('first'), late = f.path('late');
    const firstDone = first.start(), lateDone = late.start();
    first.check.resolve();
    await firstDone;
    assert.equal(f.connection.nominated, first.pair);
    late.check.resolve();
    await lateDone;
    await f.connection.send(Buffer.from('synthetic-media'));
    assert.equal(f.media[0].path, 'first');
    const nominatedPaths = f.requests.filter(r => r.nominate).map(r => r.path);
    assert.deepEqual(nominatedPaths, ['first'], 'only the selected media path may be nominated');
    assert.equal(late.pair.state, f.CandidatePairState.SUCCEEDED, 'late connectivity success is retained');
    assert.equal(late.pair.nominated, false);
});

test('ICE-lite: concurrent checks during an outstanding nomination produce one nomination', { timeout: 3000 }, async t => {
    const f = fixture(t);
    const first = f.path('first'), concurrent = f.path('concurrent');
    const nomination = deferred();
    first.protocol.nominationGate = nomination.promise;
    const firstDone = first.start(), concurrentDone = concurrent.start();
    first.check.resolve();
    await first.nominationStarted.promise;
    concurrent.check.resolve();
    await concurrentDone;
    assert.equal(f.connection.nominated, undefined);
    nomination.resolve();
    await firstDone;
    assert.equal(f.connection.nominated, first.pair);
    assert.deepEqual(f.requests.filter(r => r.nominate).map(r => r.path), ['first']);
});

test('ICE-lite: three in-flight paths nominate only once in every response order', { timeout: 5000 }, async t => {
    for (const order of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
        const f = fixture(t);
        const paths = ['A', 'B', 'C'].map(f.path);
        const done = paths.map(p => p.start());
        for (const i of order) {
            paths[i].check.resolve();
            await done[i];
        }
        assert.equal(f.connection.nominated, paths[order[0]].pair);
        assert.deepEqual(f.requests.filter(r => r.nominate).map(r => r.path), [paths[order[0]].name]);
    }
});

test('ICE-lite: a completed ICE restart permits nomination of a new path', { timeout: 3000 }, async t => {
    const f = fixture(t);
    const old = f.path('old');
    old.check.resolve();
    await old.start();
    const generation = f.connection.generation;
    await f.connection.restart();
    assert.equal(f.connection.nominated, undefined);
    assert.equal(f.connection.generation, generation + 1);
    f.connection.setRemoteParams(f.credentials);
    const fresh = f.path('fresh');
    fresh.check.resolve();
    await fresh.start();
    await f.connection.send(Buffer.from('new-generation-media'));
    assert.equal(f.connection.nominated, fresh.pair);
    assert.equal(f.media[0].path, 'fresh');
    assert.deepEqual(f.requests.filter(r => r.nominate).map(r => r.path), ['old', 'fresh']);
});

test('full ICE and remotely nominated controlled connections retain their existing behavior', { timeout: 3000 }, async t => {
    const full = fixture(t, { lite: false });
    const outgoing = full.path('full');
    await outgoing.start();
    assert.equal(full.connection.nominated, outgoing.pair);
    assert.equal(full.requests.length, 1);
    assert.equal(full.requests[0].nominate, true);

    const controlled = fixture(t, { controlling: false, lite: false });
    const incoming = controlled.path('controlled');
    incoming.pair.remoteNominated = true;
    incoming.check.resolve();
    await incoming.start();
    assert.equal(controlled.connection.nominated, incoming.pair);
    assert.equal(controlled.requests.length, 1);
    assert.equal(controlled.requests[0].nominate, false);
});
