const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const dgram = require('node:dgram');
const { spawn, execFileSync } = require('node:child_process');
const { environment, base, quiet, never, storage } = require('./helpers.cjs');
const { rtcEnvironment } = require('./webrtc-helpers.cjs');

const ffmpeg = path.join(__dirname, '../node_modules/ffmpeg-static/ffmpeg');
const bundlePath = process.env.HK_TEST_BUNDLE || path.join(__dirname, '../dist/main.nodejs.js');
const tick = () => new Promise(setImmediate);
const SCHEDULE = { gopSeconds: 1, startupIntervalSeconds: 0.5, startupSeconds: 4 };

function moduleBlock(id) {
    const text = fs.readFileSync(bundlePath, 'utf8');
    const start = text.indexOf('/***/ ' + JSON.stringify(id) + ':');
    assert(start >= 0, id);
    const next = text.indexOf('\n/***/ "', start + 10);
    return text.slice(start, next < 0 ? undefined : next);
}

// Mock peers and forwarders; records the FFmpeg tracks each media start requests.
async function mockSession(values) {
    const tracks = [], logs = [];
    const e = rtcEnvironment({ startForwarder: async (c, input, t) => {
        tracks.push(t);
        queueMicrotask(() => t.video?.onRtp(Buffer.alloc(1), 'h265'));
        return { kill() {}, killPromise: never, videoSection: Promise.resolve({ codec: 'h265' }) };
    } });
    const record = (...a) => logs.push(a.join(' '));
    const rtc = new e.Class({ addService() {} }, { ...quiet, log: record, warn: record, error: record }, {
        ...e.opts, storage: storage(values),
        getMedia: async () => ({ container: 'rtsp', inputArguments: ['-i', 'camera'],
            mediaStreamOptions: { video: { codec: 'h265', width: 640, height: 360, fps: 15 }, audio: null } }),
    });
    const offer = e.proto.parseWebRTCSolicitOfferResponse(Buffer.from(await rtc.handleSolicitOffer(''), 'base64'));
    const session = rtc.sessions.get(offer.sessionId.toString('hex'));
    await e.peers[0].setRemoteDescription({});
    session.answered = true;
    await rtc.startMedia(session);
    await tick();
    return { e, rtc, session, tracks, logs };
}

test('r41 encoder arguments keep the 2 s GOP by default and add the remote keyframe schedule on request', () => {
    const { videoEncoderArguments } = environment().load(base + 'hksv-media.ts');
    const plain = videoEncoderArguments('h265', 640, 360, 15, 180);
    assert.equal(plain[plain.indexOf('-g') + 1], '30');
    assert(!plain.includes('-forced-idr') && !plain.includes('-force_key_frames'));
    const remote = videoEncoderArguments('h265', 640, 360, 15, 180, SCHEDULE);
    assert.equal(remote[remote.indexOf('-g') + 1], '15');
    assert.equal(remote[remote.indexOf('-forced-idr') + 1], '1');
    assert.equal(remote[remote.indexOf('-force_key_frames') + 1], 'expr:lte(t,4)*gte(t,n_forced*0.5)');
    assert.match(remote[remote.indexOf('-x265-params') + 1], /:keyint=15:min-keyint=15:/);
    const h264 = videoEncoderArguments('h264', 1920, 1080, 30, 1700, SCHEDULE);
    assert.equal(h264[h264.indexOf('-g') + 1], '30');
    assert.equal(h264[h264.indexOf('-forced-idr') + 1], '1');
});

test('real FFmpeg: the remote schedule emits IDRs every 0.5 s for 4 s, then every second', { timeout: 60000 }, () => {
    const { videoEncoderArguments } = environment().load(base + 'hksv-media.ts');
    const hevc = execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30', '-t', '7', '-an',
        ...videoEncoderArguments('h265', 640, 360, 15, 180, SCHEDULE), '-f', 'hevc', 'pipe:1'], { maxBuffer: 16 * 1024 * 1024, timeout: 50000 });
    const frames = [];
    for (let i = 0; i + 3 < hevc.length; i++) {
        if (hevc[i] !== 0 || hevc[i + 1] !== 0 || hevc[i + 2] !== 1) continue;
        const type = (hevc[i + 3] >> 1) & 0x3f;
        // Each access unit starts with a delimiter; IDR slices mark it as a keyframe.
        if (type === 35) frames.push(false);
        else if ((type === 19 || type === 20) && frames.length) frames[frames.length - 1] = true;
        i += 3;
    }
    assert.equal(frames.length, 105);
    assert.deepEqual(frames.flatMap((idr, index) => idr ? [index] : []), [0, 8, 15, 23, 30, 38, 45, 53, 60, 75, 90]);
});

test('r41 ADTS transcoder skips input probing and emits Opus well within a second of live AAC', { timeout: 30000 }, async () => {
    const block = moduleBlock('../webrtc/src/rtp-forwarders.ts');
    const match = /const ffmpegArgs = \[([\s\S]*?)\.\.\.audio\.encoderArguments/.exec(block);
    assert(match, 'ADTS transcoder arguments');
    const inputArgs = [...match[1].matchAll(/'([^']*)'/g)].map(m => m[1]);
    assert.deepEqual(inputArgs, ['-hide_banner', '-analyzeduration', '0', '-probesize', '512', '-f', 'aac', '-i', 'pipe:3']);

    const socket = dgram.createSocket('udp4');
    await new Promise(resolve => socket.bind(0, '127.0.0.1', resolve));
    const source = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000', '-t', '20',
        '-c:a', 'aac', '-b:a', '40k', '-ac', '1', '-f', 'adts', 'pipe:1'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let transcoder;
    try {
        const first = await new Promise((resolve, reject) => {
            source.stdout.once('data', chunk => { source.stdout.pause(); resolve(chunk); });
            source.once('error', reject);
        });
        const started = Date.now();
        transcoder = spawn(ffmpeg, [...inputArgs.map(arg => arg === 'pipe:3' ? 'pipe:0' : arg), '-loglevel', 'error', '-map', '0:a:0', '-c:a', 'libopus',
            '-application', 'voip', '-frame_duration', '20', '-ar', '24000', '-b:a', '32k', '-ac', '1', '-payload_type', '110',
            '-f', 'rtp', `rtp://127.0.0.1:${socket.address().port}?pkt_size=400`], { stdio: ['pipe', 'ignore', 'ignore'] });
        transcoder.stdin.on('error', () => {});
        transcoder.stdin.write(first);
        source.stdout.pipe(transcoder.stdin);
        const elapsed = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(Error('no Opus RTP within 10 s')), 10000);
            socket.once('message', () => { clearTimeout(timer); resolve(Date.now() - started); });
        });
        assert(elapsed < 1500, `first Opus packet after ${elapsed} ms; default probing takes about 3 s`);
    } finally {
        source.kill('SIGKILL');
        transcoder?.kill('SIGKILL');
        socket.close();
    }
});

test('r41 remote sessions re-encode with the keyframe schedule even when the source could pass through; LAN still copies', async () => {
    const remote = await mockSession({ hksv27WebRTCPathMode: 'Always remote profile' });
    try {
        const video = remote.tracks.find(t => t.video).video.encoderArguments;
        assert.equal(video[video.indexOf('-c:v') + 1], 'libx265');
        assert.equal(video[video.indexOf('-force_key_frames') + 1], 'expr:lte(t,4)*gte(t,n_forced*0.5)');
        assert.equal(video[video.indexOf('-g') + 1], '15');
        assert(remote.logs.some(l => l.includes('keyframes every 0.5 s for 4 s then every 1 s')), remote.logs.join('\n'));
        assert(remote.logs.some(l => l.includes('remote viewers get a controlled bitrate and keyframe schedule')));
    } finally { remote.rtc.closeAllSessions(); }
    const lan = await mockSession({ hksv27WebRTCPathMode: 'Always LAN profile' });
    try {
        const video = lan.tracks.find(t => t.video).video.encoderArguments;
        assert.equal(video[video.indexOf('-c:v') + 1], 'copy');
        assert(!video.includes('-force_key_frames'));
    } finally { lan.rtc.closeAllSessions(); }
});

test('r41 1080p remote resolution is opt-in and offers the medium tier', { timeout: 30000 }, async () => {
    const env = environment();
    env.mock('os', { ...require('node:os'), networkInterfaces: () => ({}) });
    const id = '../../external/werift/packages/webrtc/src/index.ts';
    const werift = env.load(id);
    class LocalPeer extends werift.RTCPeerConnection {
        constructor(config) {
            super({ ...config, iceServers: [], iceUseIpv6: false, iceAdditionalHostAddresses: ['127.0.0.1'] });
        }
        addTransceiver(...args) {
            const t = super.addTransceiver(...args);
            t.dtlsTransport.iceTransport.connection.stunServer = undefined;
            return t;
        }
    }
    env.mock(id, { ...werift, RTCPeerConnection: LocalPeer });
    const proto = env.load(base + 'hksv-webrtc-protocol.ts');
    const { buildSensorVideoTiers, CameraVideoQuality } = env.load(base + 'hksv-stream-tiers.ts');
    const camera = env.load(base + 'camera-webrtc.ts');
    assert.equal(camera.offeredResolution(null), '360p');
    assert.equal(camera.offeredResolution('1080p (experimental)'), '1080p');
    assert.equal(camera.offeredResolution('Medium (1080p, recommended)'), '360p');
    const cases = [
        [{}, 'max-width=640;max-height=360;max-fps=15;max-br=190000', 190, CameraVideoQuality.LOW],
        [{ hksv27WebRTCRemoteQuality: 'Medium (1080p, recommended)' }, 'max-width=640;max-height=360;max-fps=15;max-br=190000', 190, CameraVideoQuality.LOW],
        // r42: Automatic re-encodes 1080p at 4 Mbps (r41 offered the tier's 1.7 Mbps).
        [{ hksv27WebRTCRemoteResolution: '1080p (experimental)' }, 'max-width=1920;max-height=1080;max-fps=30;max-br=4240000', 4240, CameraVideoQuality.MEDIUM],
    ];
    for (const [values, rid, bandwidth, quality] of cases) {
        const management = new camera.WebRTCStreamManagement({ addService() {} }, quiet, {
            sensorUuid: Buffer.alloc(16), supportedVideoTiersValue: '', supportedAudioTiersValue: '', secureVideoOffer: true,
            videoTiers: buildSensorVideoTiers(3840, 2160), storage: storage(values),
            getMedia: async () => { throw Error('Offer test must not open a camera'); },
        });
        management.startMedia = async () => {};
        try {
            const offered = proto.parseWebRTCSolicitOfferResponse(Buffer.from(await management.handleSolicitOffer(''), 'base64'));
            assert.equal(offered.status, 0);
            const video = offered.sdpOffer.split(/(?=^m=)/m).find(section => section.startsWith('m=video'));
            assert(video.split(/\r?\n/).includes('a=rid:1 send ' + rid), JSON.stringify(values) + '\n' + video);
            assert(video.split(/\r?\n/).includes('b=AS:' + bandwidth), JSON.stringify(values));
            const selection = management.mediaSelection({ remote: true, videoRidLimits: {},
                videoTransceiver: { sender: { codec: { mimeType: 'video/H265', parameters: 'level-id=153' } } },
                audioTransceiver: { sender: { codec: { mimeType: 'audio/opus', clockRate: 48000 } } } });
            assert.equal(selection.tier.quality, quality, JSON.stringify(values));
        } finally { management.closeAllSessions(); }
    }
});

test('r41 logs one startup timing line per session', async () => {
    const m = await mockSession({ hksv27WebRTCPathMode: 'Always remote profile' });
    try {
        m.session.answeredAt = m.session.createdAt + 400;
        m.session.connectedAt = m.session.createdAt + 600;
        m.rtc.logStartup(m.session);
        m.rtc.logStartup(m.session);
        const lines = m.logs.filter(l => l.startsWith('HomeKit WebRTC startup: session '));
        assert.equal(lines.length, 1);
        assert.match(lines[0], /answer 400 ms, connected 600 ms, first video \d+ ms, first keyframe (?:\d+ ms|not yet), relay video ack not yet, first audio (?:\d+ ms|not yet), keyframes sent \d+$/);
    } finally { m.rtc.closeAllSessions(); }
});

test('production settings offer the r41 remote resolution with 360p as the default', () => {
    const block = moduleBlock('./src/camera-mixin.ts');
    const setting = /hksv27WebRTCRemoteResolution: \{([\s\S]*?)\n        \},/.exec(block);
    assert(setting, 'setting present');
    // r42 appends 1440p and 4K choices.
    assert.match(setting[1], /choices: \['360p \(default\)', '1080p \(experimental\)'[,\]]/);
    assert.match(setting[1], /defaultValue: '360p \(default\)'/);
    assert(block.indexOf('hksv27WebRTCRemoteResolution') < block.indexOf('hksv27WebRTCPathMode'));
});
