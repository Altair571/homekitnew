const test = require('node:test');
const assert = require('node:assert/strict');
const { environment, storage, base, quiet, never } = require('./helpers.cjs');
const tick = () => new Promise(setImmediate);
function deferred() { let resolve, reject; const promise = new Promise((r,j)=>{resolve=r;reject=j;});return {promise,resolve,reject}; }
function session() {
    const end=deferred();
    return {startRequest:{hksv27:true,video:{codec:1,width:320,height:180,fps:15,max_bit_rate:180,pt:99,mtu:1200,rtcp_interval:0.5},
        audio:{codec:'OPUS',sample_rate:24,packet_time:20,channel:1,pt:110,max_bit_rate:24,rtcp_interval:0.5}},
        prepareRequest:{targetAddress:'127.0.0.1',video:{port:1},audio:{port:2}}, videoReturn:{},audioReturn:{},vconfig:{},aconfig:{},videossrc:1,audiossrc:2,
        killPromise:end.promise,killed:false,kill(){this.killed=true;end.resolve();}};
}
function mockEnvironment(start) {
    const env=environment();
    env.mock('../../external/werift/packages/rtp/src/rtp/rtp.ts',{RtpPacket:{deSerialize:()=>({payload:Buffer.alloc(1),header:{timestamp:0,sequenceNumber:0}})}});
    env.mock(base+'camera-streaming-session.ts',{async waitForFirstVideoRtcp(){}});
    env.mock(base+'camera-streaming-srtp-sender.ts',{createCameraStreamSender(){return {sendRtp(){},sendRtcp(){}};}});
    env.mock('../webrtc/src/rtp-forwarders.ts',{startRtpForwarderProcess:start});return env;
}
const input={container:'rtsp',url:'rtsp://127.0.0.1/camera',inputArguments:['-rtsp_transport','tcp','-i','rtsp://127.0.0.1/camera'],
    mediaStreamOptions:{video:{codec:'h265',width:3840,height:2160,fps:25},audio:{codec:'aac'}}};
test('new-tier Start completes with stalled audio and audio exit cannot kill video',async()=>{
    const calls=[],audioEnd=deferred();
    const env=mockEnvironment(async(c,i,tracks)=>{
        const p={killCount:0,kill(){this.killCount++;},killPromise:tracks.video?never:audioEnd.promise,videoSection:tracks.video?Promise.resolve({codec:'h265'}):never};
        calls.push({input:i,tracks,p});if(tracks.video)queueMicrotask(()=>tracks.video.onRtp(Buffer.alloc(12),'h265'));return p;
    });
    const s=session();
    try {
        await env.load(base+'camera-streaming-ffmpeg.ts').startCameraStreamFfmpeg({},quiet,storage(),input,s,async()=>({...input,url:"rtsp://127.0.0.1/independent-audio"}));
        assert.equal(calls.length,2); assert.notEqual(calls[0].input.url,calls[1].input.url); assert(calls[0].tracks.video); assert(!calls[0].tracks.audio);assert(!calls[1].tracks.video);
        const args=Array.from(calls[0].input.inputArguments);assert(args.indexOf('-an')<args.indexOf('-i'));assert(args.includes('-allowed_media_types'));
        assert(!input.inputArguments.includes('-an'),'source is immutable');
        audioEnd.resolve();await tick();assert.equal(s.killed,false);assert.equal(calls[0].p.killCount,0);
    } finally {s.kill();await tick();}
    assert(calls.every(c=>c.p.killCount>0));
});
test('audio setup rejection is isolated and late audio setup after Stop is released',async()=>{
    for(const rejection of [true,false]) {
        const pending=deferred(),calls=[];
        const env=mockEnvironment(async(c,i,tracks)=>{
            if(!tracks.video){if(rejection)throw Error('audio unavailable');return pending.promise;}
            queueMicrotask(()=>tracks.video.onRtp(Buffer.alloc(12),'h265'));
            return {kill(){},killPromise:never,videoSection:Promise.resolve({codec:'h265'})};
        });
        const s=session();await env.load(base+'camera-streaming-ffmpeg.ts').startCameraStreamFfmpeg({},quiet,storage(),input,s,async()=>({...input,url:"rtsp://127.0.0.1/independent-audio"}));
        assert.equal(s.killed,false);s.kill();let killed=0;
        pending.resolve({kill(){killed++;},killPromise:never});await tick();if(!rejection)assert(killed>0);
    }
});
module.exports={session};

test('Stop while acquiring independent audio source prevents its connection without blocking video',async()=>{
    const pending=deferred();let audioStarted=false,requested=0;
    const env=mockEnvironment(async(c,i,tracks)=>{
        if(tracks.audio)audioStarted=true;
        if(tracks.video)queueMicrotask(()=>tracks.video.onRtp(Buffer.alloc(12),'h265'));
        return {kill(){},killPromise:never,videoSection:Promise.resolve({codec:'h265'})};
    });
    const s=session();
    await env.load(base+'camera-streaming-ffmpeg.ts').startCameraStreamFfmpeg({},quiet,storage(),input,s,()=>{requested++;return pending.promise;});
    assert.equal(requested,1);assert.equal(audioStarted,false);s.kill();pending.resolve(input);await tick();assert.equal(audioStarted,false);
});
