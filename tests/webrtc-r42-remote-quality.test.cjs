const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { environment, base, quiet, storage } = require('./helpers.cjs');
const { rtcEnvironment } = require('./webrtc-helpers.cjs');

const ffmpeg = path.join(__dirname, '../node_modules/ffmpeg-static/ffmpeg');
const bundlePath = process.env.HK_TEST_BUNDLE || path.join(__dirname, '../dist/main.nodejs.js');
const tick = () => new Promise(setImmediate);
const SCHEDULE = { gopSeconds: 1, startupIntervalSeconds: 0.5, startupSeconds: 4 };
// Objects built inside the bundle's VM context have that context's prototypes.
const plain = value => JSON.parse(JSON.stringify(value));
const STREAMS = [
    { id: 'main', video: { codec: 'h265', width: 3840, height: 2160, fps: 30, bitrate: 8192000 } },
    { id: 'sub', video: { codec: 'h265', width: 1920, height: 1080, fps: 30, bitrate: 2500000 } },
];

function moduleBlock(id) {
    const text = fs.readFileSync(bundlePath, 'utf8');
    const start = text.indexOf('/***/ ' + JSON.stringify(id) + ':');
    assert(start >= 0, id);
    const next = text.indexOf('\n/***/ "', start + 10);
    return text.slice(start, next < 0 ? undefined : next);
}

// A 4K camera with mock peers and forwarders; records the FFmpeg tracks each media start requests.
async function mockSession(values, video, options = {}) {
    const tracks = [], logs = [];
    const e = rtcEnvironment({ startForwarder: async (c, input, t) => {
        tracks.push(t);
        queueMicrotask(() => t.video?.onRtp(Buffer.alloc(1), 'h265'));
        return { kill() {}, killPromise: new Promise(() => {}), videoSection: Promise.resolve({ codec: 'h265' }) };
    } });
    const record = (...a) => logs.push(a.join(' '));
    const { buildSensorVideoTiers } = e.env.load(base + 'hksv-stream-tiers.ts');
    const rtc = new e.Class({ addService() {} }, { ...quiet, log: record, warn: record, error: record }, {
        ...e.opts, videoTiers: buildSensorVideoTiers(3840, 2160), storage: storage(values), ...options,
        getMedia: async () => ({ container: 'rtsp', inputArguments: ['-i', 'camera'], mediaStreamOptions: { video, audio: null } }),
    });
    const offer = e.proto.parseWebRTCSolicitOfferResponse(Buffer.from(await rtc.handleSolicitOffer(''), 'base64'));
    const session = rtc.sessions.get(offer.sessionId.toString('hex'));
    await e.peers[0].setRemoteDescription({});
    session.answered = true;
    await rtc.startMedia(session);
    await tick();
    const args = tracks.find(t => t.video).video.encoderArguments;
    return { e, rtc, session, tracks, logs, args, value: flag => args[args.indexOf(flag) + 1] };
}

test('r42 parses the remote resolution and bitrate settings and keeps earlier values valid', () => {
    const camera = environment().load(base + 'camera-webrtc.ts');
    const cases = [[null, '360p'], ['360p (default)', '360p'], ['1080p (experimental)', '1080p'], ['1440p / 2K (experimental)', '1440p'],
        ['2160p / 4K (experimental)', '2160p'], ['Medium (1080p, recommended)', '360p']];
    for (const [setting, resolution] of cases) assert.equal(camera.offeredResolution(setting), resolution, String(setting));
    const bitrates = [[null, { mode: 'automatic' }], ['Automatic (default)', { mode: 'automatic' }],
        ['Camera stream, no re-encode', { mode: 'camera' }], ['2 Mbps', { mode: 'fixed', kbps: 2000 }],
        ['16 Mbps', { mode: 'fixed', kbps: 16000 }], ['999 Mbps', { mode: 'automatic' }], ['fast', { mode: 'automatic' }]];
    for (const [setting, bitrate] of bitrates) assert.deepEqual(plain(camera.offeredBitrate(setting)), bitrate, String(setting));
});

test('r42 plans every remote resolution and bitrate setting on a 4K camera', () => {
    const env = environment();
    const camera = env.load(base + 'camera-webrtc.ts');
    const { buildSensorVideoTiers } = env.load(base + 'hksv-stream-tiers.ts');
    const tiers = buildSensorVideoTiers(3840, 2160);
    const plan = (resolution, bitrate, streams) => {
        const p = camera.remoteVideoPlan(tiers, resolution, camera.offeredBitrate(bitrate), streams);
        return [p.tier.width, p.tier.height, p.tier.frameRate, p.tier.averageBitrateKbps, p.peakKbps, p.cameraStream];
    };
    assert.deepEqual(plan('360p', '16 Mbps', STREAMS), [640, 360, 15, 180, 190, false]);
    assert.equal(camera.remoteVideoPlan(tiers, '360p', { mode: 'automatic' }).tier, tiers[2], '360p keeps the advertised tier object');
    assert.deepEqual(plan('1080p', 'Automatic (default)', STREAMS), [1920, 1080, 30, 4000, 4240, false]);
    assert.deepEqual(plan('1080p', '8 Mbps', STREAMS), [1920, 1080, 30, 8000, 8480, false]);
    assert.deepEqual(plan('1080p', 'Camera stream, no re-encode', STREAMS), [1920, 1080, 30, 2500, 3750, true]);
    assert.deepEqual(plan('1440p', 'Automatic (default)', STREAMS), [2560, 1440, 30, 6000, 6360, false]);
    assert.deepEqual(plan('1440p', 'Camera stream, no re-encode', STREAMS), [2560, 1440, 30, 6000, 6360, false]);
    assert.deepEqual(plan('2160p', 'Automatic (default)', STREAMS), [3840, 2160, 30, 8192, 12288, true]);
    assert.deepEqual(plan('2160p', '12 Mbps', STREAMS), [3840, 2160, 30, 12000, 12720, false]);
    // Without a stream list the camera stream is tried and verified when media starts.
    assert.deepEqual(plan('2160p', 'Automatic (default)', undefined), [3840, 2160, 30, 10000, 15000, true]);
    // An H.264 4K stream cannot be sent unchanged to an HEVC viewer.
    assert.deepEqual(plan('2160p', 'Automatic (default)', [{ video: { ...STREAMS[0].video, codec: 'h264' } }, STREAMS[1]]), [3840, 2160, 30, 10000, 10600, false]);
    assert.match(camera.remoteVideoPlan(tiers, '2160p', { mode: 'automatic' }, STREAMS).label, /^2160p 3840x2160, camera stream sent unchanged \(camera reports 8192 kbps, Automatic\)$/);
    assert.match(camera.remoteVideoPlan(tiers, '1440p', { mode: 'camera' }, STREAMS).label, /re-encoded at 6000 kbps \(no HEVC camera stream is 2560x1440\)$/);
    // Other aspect ratios scale the high tier to the chosen height; a 1080p camera offers its own high tier.
    const fourByThree = camera.remoteVideoPlan(buildSensorVideoTiers(2880, 2160), '1440p', { mode: 'automatic' });
    assert.deepEqual([fourByThree.tier.width, fourByThree.tier.height], [1920, 1440]);
    const hd = buildSensorVideoTiers(1920, 1080);
    for (const resolution of ['1080p', '1440p', '2160p']) {
        const p = camera.remoteVideoPlan(hd, resolution, { mode: 'automatic' });
        assert.deepEqual([p.tier.width, p.tier.height], [1920, 1080], resolution);
    }
});

test('r42 offers declare the plan resolution and bitrate, and only camera-stream plans read the stream list', { timeout: 60000 }, async () => {
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
    const { buildSensorVideoTiers } = env.load(base + 'hksv-stream-tiers.ts');
    const camera = env.load(base + 'camera-webrtc.ts');
    const refuse = async () => { throw Error('this plan must not read the stream list'); };
    const cases = [
        ['default', {}, refuse, 'max-width=640;max-height=360;max-fps=15;max-br=190000', 190, 0],
        ['1080p Automatic', { hksv27WebRTCRemoteResolution: '1080p (experimental)' }, refuse, 'max-width=1920;max-height=1080;max-fps=30;max-br=4240000', 4240, 0],
        ['1080p 2 Mbps', { hksv27WebRTCRemoteResolution: '1080p (experimental)', hksv27WebRTCRemoteBitrate: '2 Mbps' }, refuse, 'max-width=1920;max-height=1080;max-fps=30;max-br=2120000', 2120, 0],
        ['1440p Automatic', { hksv27WebRTCRemoteResolution: '1440p / 2K (experimental)' }, refuse, 'max-width=2560;max-height=1440;max-fps=30;max-br=6360000', 6360, 0],
        ['4K Automatic', { hksv27WebRTCRemoteResolution: '2160p / 4K (experimental)' }, async () => STREAMS, 'max-width=3840;max-height=2160;max-fps=30;max-br=12288000', 12288, 1],
        ['4K with a stalled stream list', { hksv27WebRTCRemoteResolution: '2160p / 4K (experimental)' }, () => new Promise(() => {}), 'max-width=3840;max-height=2160;max-fps=30;max-br=15000000', 15000, 1],
    ];
    for (const [name, values, list, rid, bandwidth, reads] of cases) {
        let calls = 0;
        const management = new camera.WebRTCStreamManagement({ addService() {} }, quiet, {
            sensorUuid: Buffer.alloc(16), supportedVideoTiersValue: '', supportedAudioTiersValue: '', secureVideoOffer: true,
            videoTiers: buildSensorVideoTiers(3840, 2160), storage: storage(values),
            getSourceStreams: () => { calls++; return list(); },
            getMedia: async () => { throw Error('Offer test must not open a camera'); },
        });
        management.startMedia = async () => {};
        try {
            const started = Date.now();
            const offered = proto.parseWebRTCSolicitOfferResponse(Buffer.from(await management.handleSolicitOffer(''), 'base64'));
            assert.equal(offered.status, 0, name);
            assert(Date.now() - started < 10000, name);
            const lines = offered.sdpOffer.split(/(?=^m=)/m).find(section => section.startsWith('m=video')).split(/\r?\n/);
            assert(lines.includes('a=rid:1 send ' + rid), name + '\n' + lines.join('\n'));
            assert(lines.includes('b=AS:' + bandwidth) && lines.includes('b=TIAS:' + bandwidth * 1000), name);
            assert.equal(calls, reads, name);
            assert.equal(management.sessions.get(offered.sessionId.toString('hex')).videoPlan.cameraStream, reads > 0, name);
        } finally { management.closeAllSessions(); }
    }
});

test('r42 remote media: 1080p re-encodes at 4 Mbps, 1440p scales the 4K stream on x265 threads, 4K sends the camera stream', async () => {
    const remote = { hksv27WebRTCPathMode: 'Always remote profile' };
    const hd = await mockSession({ ...remote, hksv27WebRTCRemoteResolution: '1080p (experimental)' }, { ...STREAMS[1].video });
    try {
        assert.equal(hd.value('-c:v'), 'libx265');
        assert.equal(hd.value('-b:v'), '4000000');
        assert.equal(hd.value('-force_key_frames'), 'expr:lte(t,4)*gte(t,n_forced*0.5)');
        assert.match(hd.value('-x265-params'), /:pools=2:frame-threads=2:/);
        assert(hd.logs.some(l => l.includes('remote viewers get a controlled bitrate and keyframe schedule')), hd.logs.join('\n'));
        assert(hd.logs.some(l => l.includes('keyframes every 0.5 s for 4 s then every 1 s; plan 1080p 1920x1080, re-encoded at 4000 kbps (Automatic)')), hd.logs.join('\n'));
    } finally { hd.rtc.closeAllSessions(); }

    const qhd = await mockSession({ ...remote, hksv27WebRTCRemoteResolution: '1440p / 2K (experimental)' }, { ...STREAMS[0].video });
    try {
        assert.equal(qhd.value('-b:v'), '6000000');
        assert.match(qhd.value('-vf'), /^scale=2560:1440:/);
        assert.doesNotMatch(qhd.value('-x265-params'), /pools|frame-threads/);
        assert(qhd.logs.some(l => l.includes('source dimensions 3840x2160 do not match 2560x1440')), qhd.logs.join('\n'));
    } finally { qhd.rtc.closeAllSessions(); }

    const uhd = await mockSession({ ...remote, hksv27WebRTCRemoteResolution: '2160p / 4K (experimental)' }, { ...STREAMS[0].video },
        { getSourceStreams: async () => STREAMS });
    try {
        assert.deepEqual(plain(uhd.args), ['-map', '0:v:0', '-c:v', 'copy', '-bsf:v', 'dump_extra']);
        assert(uhd.logs.some(l => l.includes('video passthrough reason: camera stream setting: 3840x2160@30 H265, camera reports 8192 kbps, sent without re-encoding')), uhd.logs.join('\n'));
        assert(uhd.logs.some(l => l.includes('Opus FEC, camera stream requested, keyframes from the camera; plan 2160p 3840x2160, camera stream sent unchanged')), uhd.logs.join('\n'));
        assert(uhd.logs.some(l => l.startsWith('HomeKit WebRTC remote video plan: session ') && l.endsWith('offer declares 3840x2160@30 up to 12288 kbps')), uhd.logs.join('\n'));
    } finally { uhd.rtc.closeAllSessions(); }
});

test('r42 camera-stream plans re-encode on the remote schedule when the opened stream does not match; LAN is unchanged', async () => {
    const remote = { hksv27WebRTCPathMode: 'Always remote profile' };
    const h264 = await mockSession({ ...remote, hksv27WebRTCRemoteResolution: '2160p / 4K (experimental)' }, { ...STREAMS[0].video, codec: 'h264' });
    try {
        assert.equal(h264.value('-c:v'), 'libx265');
        assert.equal(h264.value('-b:v'), '10000000');
        assert.equal(h264.value('-force_key_frames'), 'expr:lte(t,4)*gte(t,n_forced*0.5)');
        assert.doesNotMatch(h264.value('-x265-params'), /pools/);
        assert(h264.logs.some(l => l.includes('re-encode reason: camera stream codec h264 is not h265; re-encoding instead')), h264.logs.join('\n'));
    } finally { h264.rtc.closeAllSessions(); }
    const cameraSetting = { ...remote, hksv27WebRTCRemoteResolution: '1080p (experimental)', hksv27WebRTCRemoteBitrate: 'Camera stream, no re-encode' };
    const sub = await mockSession(cameraSetting, { ...STREAMS[1].video, fps: 25 }, { getSourceStreams: async () => STREAMS });
    try {
        assert.equal(sub.value('-c:v'), 'copy');
        assert(!sub.args.includes('-force_key_frames'));
    } finally { sub.rtc.closeAllSessions(); }
    const fast = await mockSession(cameraSetting, { ...STREAMS[1].video, fps: 60 }, { getSourceStreams: async () => STREAMS });
    try {
        assert.equal(fast.value('-c:v'), 'libx265');
        assert(fast.logs.some(l => l.includes('camera stream 60 fps exceeds 30 fps; re-encoding instead')), fast.logs.join('\n'));
    } finally { fast.rtc.closeAllSessions(); }
    const lan = await mockSession({ hksv27WebRTCPathMode: 'Always LAN profile', hksv27WebRTCRemoteResolution: '2160p / 4K (experimental)' },
        { ...STREAMS[0].video }, { getSourceStreams: async () => STREAMS });
    try {
        assert.equal(lan.value('-c:v'), 'copy');
        assert(lan.logs.some(l => l.includes('LAN profile unchanged from r25')));
    } finally { lan.rtc.closeAllSessions(); }
});

test('r42 pacer bursts grow with the pacing rate so a 15 ms timer can still carry 4K bitrates', () => {
    const camera = environment().load(base + 'camera-webrtc.ts');
    const pacing = kbps => plain(camera.remotePacing({ averageBitrateKbps: kbps }));
    assert.deepEqual(pacing(180), { bytesPerSecond: 250000, burstBytes: 16384 });
    assert.deepEqual(pacing(1700), { bytesPerSecond: 850000, burstBytes: 16384 });
    assert.deepEqual(pacing(4000), { bytesPerSecond: 2000000, burstBytes: 31250 });
    assert.deepEqual(pacing(10000), { bytesPerSecond: 5000000, burstBytes: 78125 });
    for (const kbps of [4000, 8192, 16000]) {
        // One wake-up every 16 ms must carry more than the stream's own bitrate.
        assert(pacing(kbps).burstBytes / 0.016 > kbps * 1000 / 8, String(kbps));
    }
});

test('real FFmpeg: a 1440p remote encode from a 4K source runs with x265 choosing its threads', { timeout: 120000 }, () => {
    const { videoEncoderArguments } = environment().load(base + 'hksv-media.ts');
    const x265 = args => args[args.indexOf('-x265-params') + 1];
    const args = videoEncoderArguments('h265', 2560, 1440, 30, 6000, SCHEDULE, { threads: 'auto' });
    assert.doesNotMatch(x265(args), /pools|frame-threads/);
    assert.match(x265(videoEncoderArguments('h265', 1920, 1080, 30, 4000, SCHEDULE)), /:pools=2:frame-threads=2:/);
    const hevc = execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=3840x2160:rate=30', '-t', '2', '-an',
        ...args, '-f', 'hevc', 'pipe:1'], { maxBuffer: 64 * 1024 * 1024, timeout: 110000 });
    let units = 0, idr = 0;
    for (let i = 0; i + 3 < hevc.length; i++) {
        if (hevc[i] !== 0 || hevc[i + 1] !== 0 || hevc[i + 2] !== 1) continue;
        const type = (hevc[i + 3] >> 1) & 0x3f;
        if (type === 35) units++;
        if (type === 19 || type === 20) idr++;
        i += 3;
    }
    assert.equal(units, 60);
    assert(idr >= 4, `IDR slices ${idr}`);
});

test('r42 throughput line reports frame rate, bitrate and relay loss, and flags a re-encode below its frame rate', async () => {
    const m = await mockSession({ hksv27WebRTCPathMode: 'Always remote profile', hksv27WebRTCRemoteResolution: '1080p (experimental)' }, { ...STREAMS[1].video });
    try {
        let video = { lastInputAtMs: 5000, sourceFrames: 150, sourceBytes: 500000 };
        m.session.probe = { snapshot: () => ({ video }), dispose() {} };
        m.rtc.markThroughput(m.session);
        m.session.feedback.fractionLostPercent = 0;
        video = { lastInputAtMs: 15000, sourceFrames: 450, sourceBytes: 5500000 };
        m.rtc.logThroughput(m.session);
        video = { lastInputAtMs: 15000, sourceFrames: 350, sourceBytes: 5500000 };
        m.rtc.logThroughput(m.session);
        const lines = m.logs.filter(l => l.startsWith('HomeKit WebRTC throughput: session '));
        assert.equal(lines.length, 2);
        assert.match(lines[0], /…, 1080p 1920x1080, re-encoded at 4000 kbps \(Automatic\); video 30\.0 fps, 4000 kbps over 10\.0 s, relay loss 0%$/);
        assert.match(lines[1], /; video 20\.0 fps, 4000 kbps over 10\.0 s, relay loss 0%; below 30 fps, so this server may not re-encode 1080p in real time$/);
    } finally { m.rtc.closeAllSessions(); }
});

test('production settings and wiring expose the r42 remote resolution and bitrate options', () => {
    const block = moduleBlock('./src/camera-mixin.ts');
    const setting = key => new RegExp(key + ': \\{([\\s\\S]*?)\\n        \\},').exec(block)?.[1];
    const resolution = setting('hksv27WebRTCRemoteResolution'), bitrate = setting('hksv27WebRTCRemoteBitrate');
    assert(resolution && bitrate, 'settings present');
    assert.match(resolution, /title: 'Experimental: WebRTC Remote Resolution \(r42\)'/);
    assert.match(resolution, /defaultValue: '360p \(default\)'/);
    assert.match(bitrate, /title: 'Experimental: WebRTC Remote Video Bitrate \(r42\)'/);
    assert.match(bitrate, /defaultValue: 'Automatic \(default\)'/);
    assert(block.indexOf('hksv27WebRTCRemoteResolution:') < block.indexOf('hksv27WebRTCRemoteBitrate:')
        && block.indexOf('hksv27WebRTCRemoteBitrate:') < block.indexOf('hksv27WebRTCPathMode:'));
    const choices = text => /choices: \[([^\]]*)\]/.exec(text)[1].match(/'[^']*'/g).map(choice => choice.slice(1, -1));
    const camera = environment().load(base + 'camera-webrtc.ts');
    assert.deepEqual(choices(resolution).map(choice => camera.offeredResolution(choice)), ['360p', '1080p', '1440p', '2160p']);
    assert.deepEqual(choices(bitrate), ['Automatic (default)', 'Camera stream, no re-encode', '2 Mbps', '4 Mbps', '6 Mbps', '8 Mbps', '12 Mbps', '16 Mbps']);
    assert.deepEqual(choices(bitrate).map(choice => camera.offeredBitrate(choice).mode), ['automatic', 'camera', 'fixed', 'fixed', 'fixed', 'fixed', 'fixed', 'fixed']);
    assert.match(moduleBlock('./src/types/camera.ts'), /getWebRTCSourceStreams: \(\) => device\.getVideoStreamOptions\(\),\n\s+disabledServices: hksv27Disabled,/);
    assert.match(moduleBlock('./src/types/camera/camera-hksv27.ts'), /getMedia: opts\.getWebRTCMedia,\n\s+getSourceStreams: opts\.getWebRTCSourceStreams,/);
});
