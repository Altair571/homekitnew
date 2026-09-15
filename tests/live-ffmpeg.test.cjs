const test=require('node:test');
const assert=require('node:assert/strict');
const {environment,storage,base,quiet}=require('./helpers.cjs');
const {camera,ffmpeg}=require('./rtsp-stalled-audio.cjs');
function within(p,ms){let t;return Promise.race([p,new Promise((_,r)=>t=setTimeout(()=>r(Error('test timeout')),ms))]).finally(()=>clearTimeout(t));}
const delay=ms=>new Promise(r=>setTimeout(r,ms));
test('real RTSP/FFmpeg: absent AAC stalls combined output; separate URLs pass through identical HEVC pictures', {timeout:20000}, async()=>{
 const fixture=await camera(),videoFixture=await camera({singleClient:true,initialBurstFrames:1000}),audioFixture=await camera({singleClient:true}),env=environment({mediaManager:{getFFmpegPath:async()=>ffmpeg}}),children=[];
 // Keep real sockets, parser and encoder; observe plaintext before the tested SRTP sender.
 const sent=[],logs=[];const log={...quiet,log(...a){logs.push(a.join(' '));}};
 env.mock(base+'camera-streaming-srtp-sender.ts',{createCameraStreamSender(c,config,socket,ssrc,pt){return {sendRtcp(){},sendRtp(packet){if(pt===99)sent.push(packet);}};}});
 env.mock(base+'camera-streaming-session.ts',{async waitForFirstVideoRtcp(){}});
 const original=env.load('../webrtc/src/rtp-forwarders.ts');
 env.mock('../webrtc/src/rtp-forwarders.ts',{async startRtpForwarderProcess(...args){const p=await original.startRtpForwarderProcess(...args);children.push(p);return p;}});
 const {videoEncoderArguments}=env.load(base+'hksv-media.ts');let end;const s={
  startRequest:{hksv27:true,video:{codec:1,width:320,height:180,fps:15,max_bit_rate:180,pt:99,mtu:1200,rtcp_interval:0.5},audio:{codec:'OPUS',sample_rate:24,packet_time:20,channel:1,pt:110,max_bit_rate:24,rtcp_interval:0.5}},
  prepareRequest:{targetAddress:'127.0.0.1',video:{port:1},audio:{port:2}},videossrc:10,audiossrc:11,videoReturn:{},audioReturn:{},vconfig:{},aconfig:{},
  killPromise:new Promise(r=>end=r),kill(){this.killed=true;end();}};
 try {
  let baselinePackets=0,videoHeader;const header=new Promise(r=>videoHeader=r);
  const baseline=await original.startRtpForwarderProcess({...quiet,log(...a){if(a.join(' ').includes('Output #0'))videoHeader();}},fixture.input,{
   video:{codecCopy:'transcode',encoderArguments:['-map','0:v:0',...videoEncoderArguments('h265',320,180,15,180)],payloadType:99,onRtp(){baselinePackets++;}},
   audio:{codecCopy:'transcode',encoderArguments:['-map','0:a:0','-c:a','libopus','-ar','24000'],payloadType:110,onRtp(){}}
  });children.push(baseline);
  // Header logging is intentionally suppressed by the bundled logger, so wait a
  // bounded second after the camera has actually been SETUP instead.
  await delay(1800);assert(fixture.videoSetups>0);assert.equal(baselinePackets,0);
  baseline.kill();
  await within(env.load(base+'camera-streaming-ffmpeg.ts').startCameraStreamFfmpeg({},log,storage(),videoFixture.input,s,async()=>audioFixture.input),6000);
  const burstBytes=videoFixture.videoBytes;
  assert(burstBytes>1_000_000,'fixture supplies a large startup prebuffer burst');
  const until=Date.now()+3000;
  while(sent.reduce((n,p)=>n+p.payload.length,0)<burstBytes*0.98&&Date.now()<until)await delay(20);
  assert(sent.reduce((n,p)=>n+p.payload.length,0)>=burstBytes*0.98,'large prebuffer reaches the paced sender');
  assert(sent.length>5,'video packets delivered despite zero audio packets');
  assert.equal(videoFixture.connections,1,'only FFmpeg may consume the video descriptor');
  assert.equal(videoFixture.videoSetups,1);
  assert.equal(audioFixture.connections,1,'audio uses its independent descriptor');
  assert.equal(audioFixture.audioSetups,1);
  const nals=new Set(),pictures=[];let fragments;
  const complete=nal=>{const type=(nal[0]>>1)&63;nals.add(type);if(type<32)pictures.push(nal);};
  for(const {payload:p} of sent) {
   const type=(p[0]>>1)&63;
   if(type===48) {for(let off=2;off+2<p.length;){const size=p.readUInt16BE(off);off+=2;complete(p.subarray(off,off+size));off+=size;}}
   else if(type===49) {
    if(p[2]&128)fragments=[Buffer.from([(p[0]&0x81)|((p[2]&63)<<1),p[1]])];
    fragments?.push(p.subarray(3));
    if(p[2]&64){if(fragments)complete(Buffer.concat(fragments));fragments=undefined;}
   } else complete(p);
  }
  for(const type of [32,33,34])assert(nals.has(type),`missing parameter set ${type}`);
  assert([...nals].some(n=>n<32),'coded pictures forwarded');
  // Annex-B start-code scanning can retain a trailing zero byte at a NAL boundary.
  // Compare coded bytes after removing only trailing zero padding on both sides.
  const codedBytes=n=>{let end=n.length;while(end&&n[end-1]===0)end--;return n.subarray(0,end).toString('hex');};
  const sourcePictures=new Set(videoFixture.sourceNals.filter(n=>((n[0]>>1)&63)<32).map(codedBytes));
  assert(pictures.length>0);
  assert(pictures.every(n=>sourcePictures.has(codedBytes(n))),'coded picture bytes must survive without re-encoding');
  assert(sent.every(p=>p.payload.length+12<=1200));
  assert(logs.some(l=>l.includes('HomeKit first h265 RTP packet')));
  assert(logs.some(l=>l.includes('HomeKit output: h265 320x180@15, copy')));
  assert(logs.some(l=>l.includes('-c:v copy')));
  assert(logs.some(l=>l.includes('-pkt_size 1178')&&l.includes('-f rtsp')),'local video hop uses bounded-size RTP over RTSP');
  for(let i=1;i<sent.length;i++)assert.equal(sent[i].header.sequenceNumber,(sent[i-1].header.sequenceNumber+1)&65535,'no local RTP sequence gaps');
  assert(!logs.some(l=>l.includes('libx265')),'no video encoder is started for a matching source');
  assert.equal(s.killed,undefined,'audio absence did not stop video');
 } finally {
  s.kill();for(const p of children){p.kill();p.cp?.kill('SIGKILL');}
  await Promise.all([fixture.close(),videoFixture.close(),audioFixture.close()]);await delay(100);
 }
});
