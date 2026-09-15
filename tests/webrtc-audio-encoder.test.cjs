const test = require('node:test');
const assert = require('node:assert/strict');
const {environment, base} = require('./helpers.cjs');
const {ffmpeg} = require('./rtsp-stalled-audio.cjs');
const {Receiver} = require('./sframe-receiver.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Run the production audio starter and real FFmpeg encoder/RTP output. The
// existing stalled-AAC test injects encoded packets and cannot catch CLI errors.
for (const remote of [false, true]) test(`WebRTC ${remote ? 'remote' : 'LAN'} audio encoder produces authenticated Opus RTP`, {timeout: 12000}, async () => {
  const env = environment({mediaManager: {getFFmpegPath: async () => ffmpeg}});
  const original = env.load('../webrtc/src/rtp-forwarders.ts');
  const children = [], packets = [], logs = [];
  const log = {log(...args) {logs.push(args.join(' '));}, warn(...args) {logs.push(args.join(' '));}, error(...args) {logs.push(args.join(' '));}};
  env.mock('../webrtc/src/rtp-forwarders.ts', {async startRtpForwarderProcess(...args) {
    const forwarder = await original.startRtpForwarderProcess(...args);
    children.push(forwarder); return forwarder;
  }});
  const {WebRTCStreamManagement} = env.load(base + 'camera-webrtc.ts');
  const {SFrameRtpSender} = env.load(base + 'hksv-sframe.ts');
  const config = {key: Buffer.alloc(32, 31), kid: 18n};
  const sframe = new SFrameRtpSender(config.key, config.kid, 1234, false);
  const manager = new WebRTCStreamManagement({addService() {}}, log, {
    sensorUuid: Buffer.alloc(16), videoTiers: [], supportedVideoTiersValue: '', supportedAudioTiersValue: '',
    getMedia: async () => ({inputArguments: ['-re', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000'], mediaStreamOptions: {audio: {codec: 'pcm_s16le'}}}),
  });
  const session = {sessionId: Buffer.alloc(16, 9), mediaGeneration: 1, closed: false,
    audioSframe: sframe, atrack: {writeRtp(packet) {packets.push(packet);}}};
  try {
    manager.startAudio(session, {remote}, false, 1, 110);
    const deadline = Date.now() + 6000;
    while (packets.length < 25 && Date.now() < deadline) {
      if (logs.some(line => /Unsupported FEC|audio stopped|audio failed/.test(line))) break;
      await delay(20);
    }
    assert(packets.length >= 25, `Expected actual encoder output, got ${packets.length} packets.\n${logs.join('\n')}`);
    const receiver = new Receiver(config, 8);
    for (let i = 0; i < 25; i++) {
      const packet = packets[i], opus = receiver.push(packet);
      assert(opus && opus.length > 0, 'Independent suite-8 receiver authenticates each encoded packet');
      assert.equal(packet.header.payloadType, 110);
      if (i) assert.equal((packet.header.timestamp - packets[i - 1].header.timestamp) >>> 0, 960);
    }
    assert(!logs.some(line => /Unsupported FEC|Error opening output/.test(line)));
  } finally {
    session.closed = true; clearTimeout(session.audioTimer);
    for (const child of children) {child.kill(); child.cp?.kill('SIGKILL');}
    sframe.close(); manager.closeAllSessions(); await delay(100);
  }
});
