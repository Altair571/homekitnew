const test = require('node:test');
const assert = require('node:assert/strict');
const { environment, base, quiet } = require('./helpers.cjs');
function clock() {
    let now = 0, nextId = 0; const pending = new Map();
    return { now: () => now, schedule(fn, ms) { const id = ++nextId; pending.set(id, { fn, at: now + ms }); return id; },
        unschedule(id) { pending.delete(id); },
        step() { const next = [...pending].sort((a,b)=>a[1].at-b[1].at)[0]; if (!next) return false;
            pending.delete(next[0]); now = next[1].at; next[1].fn(); return true; },
        pending };
}
const packet = i => ({ header: { sequenceNumber: (65000+i)&65535, timestamp: (0xfffffff0+Math.floor(i/500)*3000)>>>0 }, payload: Buffer.alloc(1136, i&255) });
test('RTP pacer spreads a one-megabyte keyframe burst without changing packet order, payload or timing', () => {
    const { createHksvRtpPacer } = environment().load(base+'hksv-rtp-pacer.ts');
    const time = clock(), sent = [], source = Array.from({length:1000},(_,i)=>packet(i));
    const pacer = createHksvRtpPacer(p=>sent.push({p,at:time.now()}), e=>assert.fail(e.message), time);
    source.forEach(p=>pacer.enqueue(p));
    assert(sent.length>0 && sent.length<30,'initial send is bounded');
    while(time.step()) {}
    assert.equal(sent.length,1000);
    assert(sent.at(-1).at>=200,'large burst is spread across time');
    sent.forEach(({p},i)=>assert.equal(p,source[i]));
    const perTick = new Map(); for(const {at} of sent) perTick.set(at,(perTick.get(at)||0)+1200);
    assert([...perTick.values()].every(bytes=>bytes<=32768)); pacer.close();
});
test('RTP pacing stops queued packets on cancellation and reports overload instead of dropping fragments', () => {
    const { createHksvRtpPacer } = environment().load(base+'hksv-rtp-pacer.ts');
    const time = clock(); let sent=0, failed=0;
    const pacer = createHksvRtpPacer(()=>sent++,()=>failed++,time);
    for(let i=0;i<100;i++)pacer.enqueue(packet(i));
    const before=sent;pacer.close();while(time.step()){};pacer.enqueue(packet(101));
    assert.equal(sent,before);assert.equal(failed,0);assert.equal(time.pending.size,0);
    const limited=createHksvRtpPacer(()=>sent++,()=>failed++,{...time,maxQueueBytes:2400});
    for(let i=0;i<100;i++)limited.enqueue(packet(i));
    assert.equal(failed,1);assert.equal(time.pending.size,0);
});
test('verified frame-rate cache is per camera, expires, and invalidates changed source metadata', () => {
    const { createVideoRateCache } = environment().load(base+'hksv-video-probe.ts'); let now=0;
    const cache=createVideoRateCache(()=>now), other=createVideoRateCache(()=>now);
    const input={mediaStreamOptions:{id:'main',video:{codec:'h265',width:3840,height:2160,fps:25}}};
    cache.remember(input,30);
    assert.equal(cache.apply(input).mediaStreamOptions.video.fps,30);
    assert.equal(other.apply(input),input); assert.equal(input.mediaStreamOptions.video.fps,25);
    for(const changed of [{...input,mediaStreamOptions:{...input.mediaStreamOptions,id:'sub'}},
        {...input,mediaStreamOptions:{...input.mediaStreamOptions,sdp:'changed stream parameter sets'}},
        {...input,mediaStreamOptions:{...input.mediaStreamOptions,video:{...input.mediaStreamOptions.video,fps:24}}}])
        assert.equal(cache.apply(changed),changed);
    now=60000;assert.equal(cache.apply(input),input);
});
test('Scrypted SDP resolves stale video fps without a probe; audio, conflicting rates and dimensions are ignored', () => {
    const {applyScryptedSdpVideoRate}=environment().load(base+'hksv-video-probe.ts');
    const input={mediaStreamOptions:{video:{codec:'h265',width:3840,height:2160,fps:25}}};
    const sdp=['v=0','m=video 0 RTP/AVP 96','a=rtpmap:96 H265/90000','a=x-framerate:30','a=x-dimensions:3840,2160',
        'm=audio 0 RTP/AVP 97','a=rtpmap:97 opus/48000/2','a=framerate:50',''].join('\r\n');
    const withSdp=s=>({...input,mediaStreamOptions:{...input.mediaStreamOptions,sdp:s}});
    assert.equal(applyScryptedSdpVideoRate(withSdp(sdp),30).mediaStreamOptions.video.fps,30);
    assert.equal(input.mediaStreamOptions.video.fps,25);
    for(const invalid of [sdp.replace('x-framerate:30','x-framerate:25'), sdp.replace('3840,2160','1920,1080'),
        sdp.replace('x-framerate:30','x-framerate:30\r\na=framerate:25'),sdp.replace('H265','H264'),
        sdp.replace('a=x-framerate:30\r\n','')]) {
        const source=withSdp(invalid);assert.equal(applyScryptedSdpVideoRate(source,30),source);
    }
});
test('first sender report maps the first transmitted RTP timestamp, not zero', () => {
    const env=environment(),root='../../external/werift/packages/rtp/src/',reports=[],wire=[];
    env.mock(root+'srtp/srtp.ts',{SrtpSession:class{encrypt(){return Buffer.from([1]);}}});
    env.mock(root+'srtp/srtcp.ts',{SrtcpSession:class{encrypt(){return Buffer.from([2]);}}});
    env.mock(root+'rtcp/sr.ts',{RtcpSenderInfo:class{constructor(o){Object.assign(this,o);}},RtcpSrPacket:class{constructor(o){reports.push(o);}serialize(){return Buffer.alloc(1);}}});
    env.mock(base+'camera-utils.ts',{ntpTime:()=>123n});
    const {createCameraStreamSender}=env.load(base+'camera-streaming-srtp-sender.ts');
    const sender=createCameraStreamSender(quiet,{}, {setSendBufferSize(){},send(p){wire.push(p[0]);}},10,99,1,'127.0.0.1',0.5,{codec:'h265'});
    sender.sendRtcp();assert.equal(wire.length,0);
    sender.sendRtp({header:{timestamp:987654321,sequenceNumber:23},payload:Buffer.alloc(100)});
    assert.deepEqual(wire,[1,2]);assert.equal(reports[0].senderInfo.rtpTimestamp,987654321);
    assert.equal(reports[0].senderInfo.packetCount,1);assert.equal(reports[0].senderInfo.octetCount,100);
});
