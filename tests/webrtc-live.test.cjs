const test=require('node:test');
const assert=require('node:assert/strict');
const {environment,base,quiet}=require('./helpers.cjs');
const {camera,ffmpeg}=require('./rtsp-stalled-audio.cjs');
const {Receiver,nals}=require('./sframe-receiver.cjs');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,ms=6000){const end=Date.now()+ms;while(!fn()){if(Date.now()>end)throw Error('WebRTC fixture timed out');await delay(20);}}

for(const encrypted of [true,false])test('real WebRTC ICE/DTLS/SRTP carries identical HEVC pictures, outgoing SFrame='+encrypted+', despite stalled AAC',{timeout:20000},async()=>{
 const video=await camera({singleClient:true,initialBurstFrames:100}),audio=await camera({singleClient:true});
 const env=environment({mediaManager:{getFFmpegPath:async()=>ffmpeg}}),children=[],logs=[],received=[],receivedAudio=[];
 let audioInputCallback;
 env.mock('os',{...require('node:os'),networkInterfaces:()=>({})});
 const log={log(...a){logs.push(a.join(' '));},warn(...a){logs.push(a.join(' '));},error(...a){logs.push(a.join(' '));}};
 const rtcId='../../external/werift/packages/webrtc/src/index.ts',werift=env.load(rtcId);
 // Use actual bundled peers and crypto, confining ICE discovery to local addresses.
 const ice={iceServers:[],iceUseIpv6:false,iceAdditionalHostAddresses:['127.0.0.1']};
 class LoopbackPeer extends werift.RTCPeerConnection {
  constructor(config){super({...config,...ice});}
  addTransceiver(...args){const t=super.addTransceiver(...args);t.dtlsTransport.iceTransport.connection.stunServer=undefined;return t;}
 }
 env.mock(rtcId,{...werift,RTCPeerConnection:LoopbackPeer});
 const original=env.load('../webrtc/src/rtp-forwarders.ts');
 env.mock('../webrtc/src/rtp-forwarders.ts',{async startRtpForwarderProcess(...args){if(args[2].audio)audioInputCallback=args[2].audio.onRtp;const p=await original.startRtpForwarderProcess(...args);children.push(p);return p;}});
 let requests=0;
 const management=new (env.load(base+'camera-webrtc.ts').WebRTCStreamManagement)({addService(){}},log,{
  sensorUuid:Buffer.alloc(16),videoTiers:[{identifier:1,quality:2,width:320,height:180,frameRate:15,averageBitrateKbps:180}],
  supportedVideoTiersValue:'',supportedAudioTiersValue:'',getMedia:async()=>++requests===1?video.input:audio.input,
 });
 const proto=env.load(base+'hksv-webrtc-protocol.ts');let remote;
 try{
  const offered=proto.parseWebRTCSolicitOfferResponse(Buffer.from(await management.handleSolicitOffer(encrypted?'':proto.encodeWebRTCSolicitOffer({sframeEnabled:false}).toString('base64')),'base64'));
  assert.equal(offered.status,0);assert.equal(!!offered.sframeConfiguration,encrypted);assert(offered.sdpOffer.includes('H265/90000'));assert(!offered.sdpOffer.includes('H264/'));
  assert.equal((offered.sdpOffer.match(/^a=sframe\r?$/mg)||[]).length,encrypted?2:0);
  const videoSdp=offered.sdpOffer.split(/(?=m=)/).find(s=>s.startsWith('m=video'));
  assert.match(videoSdp,/^a=rid:1 send pt=99;max-width=320;max-height=180;max-fps=15\r?$/m,'Apple relay requires a video stream identifier');
  assert.match(videoSdp,/^a=simulcast:send 1\r?$/m);
  assert.match(videoSdp,/^a=extmap:\d+ urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id\r?$/m);
  const session=management.sessions.get(offered.sessionId.toString('hex'));
  const offeredTransports=[...session.pc.dtlsTransports];
  const sdpSummary=s=>s.split('\r\n').filter(l=>/^(m=|a=(candidate:|group:|mid:|setup:|sendonly|recvonly))/.test(l)).join('\n');
  logs.push('Local offer: '+sdpSummary(offered.sdpOffer));
  session.pc.iceConnectionStateChange.subscribe(state=>logs.push('Camera ICE '+state));
  const update=proto.encodeWebRTCUpdateSession({sessionId:offered.sessionId,receiveKeysToAdd:[{key:Buffer.alloc(32,11),kid:0xfedcba9876543210n}],receiveKidsToRemove:[]});
  assert.equal(proto.parseWebRTCSessionStatusResponse(await management.handleUpdateSession(update)).status,0);
  remote=new LoopbackPeer({...ice,headerExtensions:{video:[werift.useSdesMid(),werift.useSdesRTPStreamId()],audio:[werift.useSdesMid()]},codecs:{video:[new werift.RTCRtpCodecParameters({mimeType:'video/H265',clockRate:90000,payloadType:99,parameters:'profile-id=1;tier-flag=0;level-id=153;tx-mode=SRST'})],
   audio:[new werift.RTCRtpCodecParameters({mimeType:'audio/opus',clockRate:48000,channels:2,payloadType:110})]}});
  remote.onTrack.subscribe(track=>track.onReceiveRtp.subscribe(packet=>(track.kind==='video'?received:receivedAudio).push(packet)));
  remote.iceConnectionStateChange.subscribe(state=>logs.push('Controller ICE '+state));
  remote.connectionStateChange.subscribe(state=>logs.push('Controller connection '+state));
  await remote.setRemoteDescription({type:'offer',sdp:offered.sdpOffer});
  await remote.setLocalDescription(await remote.createAnswer());
  logs.push('Remote answer: '+sdpSummary(remote.localDescription.sdp));
  const result=await management.handleProvideAnswer(proto.encodeWebRTCProvideAnswer({sessionId:offered.sessionId,sdpAnswer:remote.localDescription.sdp,additionalCandidates:[]}));
  assert.equal(proto.parseWebRTCSessionStatusResponse(result).status,0,logs.join('\n'));
  await until(()=>logs.some(l=>l.includes('WebRTC media ready'))&&received.length>100);
  assert.equal(remote.connectionState,'connected');assert.equal(session.pc.connectionState,'connected');
  assert(session.pc.getTransceivers().every(t=>t.currentDirection==='sendonly'));
  assert.equal(video.connections,1);assert.equal(audio.connections,1);assert.equal(video.videoSetups,1);assert.equal(audio.audioSetups,1);
  assert.equal(requests,2);assert.equal(session.closed,false);
  // Resume the stalled source with known Opus packets through the production
  // audio callback, then authenticate its output after real DTLS/SRTP.
  const {RtpPacket,RtpHeader}=env.load('../../external/werift/packages/rtp/src/index.ts');
  const opus=Buffer.from([0xf8,0xff,0xfe]);assert(audioInputCallback);
  for(let i=0;i<3;i++)audioInputCallback(new RtpPacket(new RtpHeader({
   sequenceNumber:i,timestamp:i*960,ssrc:44,payloadType:110,marker:i===0,
  }),opus).serialize());
  await until(()=>receivedAudio.length>=3);
  const audioReceiver=encrypted?new Receiver(offered.sframeConfiguration,8):undefined;
  for(let i=0;i<3;i++){
   const p=receivedAudio[i];assert.equal(p.header.payloadType,110);
   assert.equal(p.header.ssrc,session.audioTransceiver.sender.ssrc);
   assert.deepEqual(audioReceiver?audioReceiver.push(p):p.payload,opus);
   if(i)assert.equal((p.header.timestamp-receivedAudio[i-1].header.timestamp)>>>0,960);
  }
  // Independent SFrame authentication/decryption after real DTLS/SRTP.
  const pictures=[],types=new Set();let fragments;
  const complete=nal=>{const type=(nal[0]>>1)&63;types.add(type);if(type<32)pictures.push(nal);};
  const receiver=encrypted?new Receiver(offered.sframeConfiguration):undefined;
  for(const packet of received){
   if(receiver){const frame=receiver.push(packet);if(frame)for(const nal of nals(frame))complete(nal);continue;}
   const p=packet.payload;
   const type=(p[0]>>1)&63;
   if(type===48){for(let off=2;off+2<p.length;){const size=p.readUInt16BE(off);off+=2;complete(p.subarray(off,off+size));off+=size;}}
   else if(type===49){if(p[2]&128)fragments=[Buffer.from([(p[0]&0x81)|((p[2]&63)<<1),p[1]])];fragments?.push(p.subarray(3));if(p[2]&64){if(fragments)complete(Buffer.concat(fragments));fragments=undefined;}}
   else complete(p);
  }
  const bytes=n=>{let end=n.length;while(end&&n[end-1]===0)end--;return n.subarray(0,end).toString('hex');};
  const source=new Set(video.sourceNals.filter(n=>((n[0]>>1)&63)<32).map(bytes));
  if(encrypted){assert(receiver.counter>5n);assert(received.every(p=>p.header.ssrc===session.videoTransceiver.sender.ssrc));}
  assert(pictures.length>5);assert(pictures.every(n=>source.has(bytes(n))),'received pictures equal native source');
  for(const type of [32,33,34])assert(types.has(type));
  const videoAnswer=remote.localDescription.sdp.split(/(?=m=)/).find(s=>s.startsWith('m=video'));
  const ridId=Number(/^a=extmap:(\d+) urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id\r?$/m.exec(videoAnswer)[1]);
  const midId=Number(/^a=extmap:(\d+) urn:ietf:params:rtp-hdrext:sdes:mid\r?$/m.exec(videoAnswer)[1]);
  assert(received.every(p=>p.header.extensions.find(e=>e.id===ridId)?.payload.toString()==='1'),'RID must be carried on actual RTP');
  assert(received.every(p=>p.header.extensions.find(e=>e.id===midId)?.payload.toString()==='0'),'MID identifies bundled video');
  assert(received.every(p=>p.header.payloadType===99&&p.serialize().length+10<=1200),'including RTP extensions and SRTP authentication tag');
  for(let i=1;i<received.length;i++)assert.equal(received[i].header.sequenceNumber,(received[i-1].header.sequenceNumber+1)&65535);
  assert(logs.some(l=>l.includes('WebRTC output: h265 320x180@15, copy')));
  assert(logs.some(l=>l.includes('-c:v copy')));assert(!logs.some(l=>l.includes('libx265')||l.includes('libx264')));
  assert(logs.some(l=>l.includes('-pkt_size 1150')&&l.includes('-f rtsp')));
  const activeTransports=session.pc.dtlsTransports;
  assert.equal(activeTransports.length,1,'controller answer bundles audio and video');
  for(const transport of offeredTransports.filter(t=>!activeTransports.includes(t)))
   assert.equal(transport.iceTransport.state,'closed','unused offered transport must release its socket');
  if (session.probe) {
   if (encrypted) await until(() => !['starting', 'running'].includes(session.probe.snapshot().decoder.status));
   const probe = session.probe.snapshot();
   if (encrypted) assert.equal(probe.decoder.status, 'decoded', JSON.stringify(probe.decoder));
   for (const kind of ['video', 'audio']) {
    assert(probe[kind].inputPackets > 0, kind + ' encoder input is observed');
    assert(probe[kind].srtpVerified > 0, kind + ' actual UDP ciphertext independently authenticates: ' + JSON.stringify(probe));
    assert.equal(probe[kind].srtpAuthFailures, 0);
    assert.equal(probe[kind].srtpPayloadMismatches, 0);
    assert.equal(probe[kind].srtpUnsupported, 0);
    if (encrypted) {
     assert(probe[kind].sframeSourceMatches > 0, kind + ' decrypts back to its original source after real DTLS/SRTP');
     assert.equal(probe[kind].sframeAuthFailures, 0);
     assert.equal(probe[kind].sframeSourceMismatches, 0);
    }
   }
   assert.equal(probe.rtcp.observationErrors, 0);
  }
 }catch(e){e.message+='\n'+logs.filter(l=>!l.includes('-i ')).join('\n');throw e;}
 finally{
  management.closeAllSessions();await remote?.close();
  for(const p of children){p.kill();p.cp?.kill('SIGKILL');}
  await Promise.all([video.close(),audio.close()]);await delay(100);
 }
});
