const test=require('node:test');
const assert=require('node:assert/strict');
const {environment,base,quiet}=require('./helpers.cjs');
const {decrypt,Receiver,nals}=require('./sframe-receiver.cjs');
const vectors=require('./fixtures/sframe-aes256.json').sframe_aes_256_ctr_hmac;
const env=environment(),{SFrameEncryptor,HevcAccessUnitAssembler,SFrameRtpSender,sframeHeader}=env.load(base+'hksv-sframe.ts');
const {RtpPacket,RtpHeader}=env.load('../../external/werift/packages/rtp/src/index.ts');
const key=Buffer.alloc(32,7),kid=0xfedcba9876543210n,ssrc=0x12345678;
const packet=(payload,sequenceNumber=0,timestamp=1,marker=true)=>new RtpPacket(new RtpHeader({sequenceNumber,timestamp,marker,ssrc:44,payloadType:99}),payload);

// Published by the draft authors, linked by draft-barnes-sframe-iana-256-06 §A.
// https://github.com/bifurcation/sframe-iana-256/blob/main/test-vectors/test-vectors-aes256.json
for(const v of vectors)test('SFrame matches published AES-256 suite '+v.cipher_suite+' vector',()=>{
 const k=Buffer.from(v.base_key,'hex'),e=new SFrameEncryptor(k,BigInt(v.kid),v.cipher_suite);e.counter=BigInt(v.ctr);
 assert.equal(e.key.toString('hex'),v.sframe_key);assert.equal(e.salt.toString('hex'),v.sframe_salt);
 const metadata=Buffer.from(v.metadata,'hex'),p=Buffer.from(v.pt,'hex'),encrypted=e.encrypt(p,metadata);
 assert.equal(encrypted.toString('hex'),v.ct);
 assert.deepEqual(decrypt(encrypted,{key:k,kid:BigInt(v.kid)},undefined,metadata,v.cipher_suite).plaintext,p);e.close();
});
test('SFrame header boundaries, counter exhaustion and erased keys',()=>{
 for(const [k,c,expected] of [[0n,0n,'00'],[7n,7n,'77'],[8n,8n,'880808'],[255n,256n,'89ff0100'],[(1n<<64n)-1n,(1n<<64n)-1n,'ffffffffffffffffffffffffffffffffff']])assert.equal(sframeHeader(k,c).toString('hex'),expected);
 assert.throws(()=>sframeHeader(-1n,0n));assert.throws(()=>sframeHeader(0n,1n<<64n));
 const e=new SFrameEncryptor(key,kid);e.counter=(1n<<64n)-1n;e.encrypt(Buffer.from('last'));assert.throws(()=>e.encrypt(Buffer.alloc(0)),/exhausted/);
 e.close();assert(e.key.every(x=>x===0));assert(e.salt.every(x=>x===0));assert.throws(()=>e.encrypt(Buffer.alloc(0)),/closed/);
});
test('SSRC derivation separates audio/video keys and tampering is rejected',()=>{
 const p=Buffer.from('coded media'),a=new SFrameEncryptor(key,kid,6,ssrc),b=new SFrameEncryptor(key,kid,6,ssrc+1);
 const encrypted=a.encrypt(p);assert.notDeepEqual(encrypted,b.encrypt(p));assert.deepEqual(decrypt(encrypted,{key,kid},ssrc).plaintext,p);
 assert.throws(()=>decrypt(encrypted,{key,kid},ssrc+1));
 for(const index of [0,9,10,encrypted.length-1]){const bad=Buffer.from(encrypted);bad[index]^=1;assert.throws(()=>decrypt(bad,{key,kid},ssrc));}
 a.close();b.close();
});
test('HEVC single, aggregation and FU packets recover native length-prefixed NALs',()=>{
 const a=new HevcAccessUnitAssembler(),vps=Buffer.from([64,1,2]),sps=Buffer.from([66,1,3]),picture=Buffer.from([38,1,4,5,6]);
 const ap=Buffer.concat([Buffer.from([96,1,0,vps.length]),vps,Buffer.from([0,sps.length]),sps]);
 assert.equal(a.push(packet(ap,65534,1,false)),undefined);
 assert.equal(a.push(packet(Buffer.from([98,1,128|19,4]),65535,1,false)),undefined);
 const frame=a.push(packet(Buffer.from([98,1,64|19,5,6]),0,1));
 assert.deepEqual(nals(frame),[vps,sps,picture]);
 assert.equal(a.push(packet(picture,1,1)),undefined,'duplicate timestamp after marker discarded');
 assert.deepEqual(nals(a.push(packet(picture,2,2))),[picture]);
});
test('HEVC drops damaged access units and recovers at the next timestamp',()=>{
 const a=new HevcAccessUnitAssembler(),nal=Buffer.from([38,1,4]);
 a.push(packet(Buffer.from([98,1,128|19,4]),1,1,false));
 assert.equal(a.push(packet(Buffer.from([98,1,64|19,5]),3,1)),undefined,'sequence gap');
 assert.equal(a.push(packet(Buffer.from([98,1,64|19,5]),4,2)),undefined,'orphan FU');
 assert.equal(a.push(packet(Buffer.from([96,1,0,9,38,1]),5,3)),undefined,'bad AP length');
 assert.equal(a.push(packet(Buffer.from([98,1,128|19,5]),6,4)),undefined,'incomplete FU');
 assert.deepEqual(nals(a.push(packet(nal,7,5))),[nal]);
 const big=Buffer.alloc(8*1024*1024+1);big[0]=38;big[1]=1;
 assert.equal(a.push(packet(big,8,6)),undefined,'oversize bounded');a.reset();assert.deepEqual(nals(a.push(packet(nal,1,1))),[nal]);
});
test('encrypted RTP has bounded fragments, authentic audio/video, monotonic counters after restart',()=>{
 const sender=new SFrameRtpSender(key,kid,ssrc,true),receiver=new Receiver({key,kid}),picture=Buffer.alloc(4000,17);picture[0]=38;picture[1]=1;
 const packets=sender.push(packet(picture));assert(packets.length>1);let output;
 for(let i=0;i<packets.length;i++){const p=packets[i];assert(p.payload.length<=1101);assert.equal(p.header.marker,i===packets.length-1);output=receiver.push(p)||output;if(i)assert.equal(p.header.sequenceNumber,(packets[i-1].header.sequenceNumber+1)&65535);}
 assert.deepEqual(nals(output),[picture]);assert.equal(receiver.counter,0n);
 sender.resetFrame();for(const p of sender.push(packet(picture,0,1)))receiver.push(p);assert.equal(receiver.counter,1n);
 const audio=new SFrameRtpSender(key,kid,ssrc+1,false),opus=Buffer.from([0xf8,0xff,0xfe]);
 const a=audio.push(packet(opus));assert.equal(a.length,1);assert.equal(a[0].payload[0],0xc0);assert.deepEqual(new Receiver({key,kid},8).push(a[0]),opus);
 sender.close();audio.close();assert.throws(()=>audio.push(packet(opus)),/closed/);
 assert.throws(()=>new SFrameRtpSender(key,kid,undefined,true),/SSRC/);
});
test('Opus authenticates with the iPhone SHA512_32 suite; suite-6 audio cannot be truncated to match',()=>{
 const opus=Buffer.from([0xf8,0xff,0xfe]),audio=new SFrameRtpSender(key,kid,ssrc,false);
 const old=new SFrameEncryptor(key,kid,6,ssrc),oldFrame=old.encrypt(opus);
 try{
  assert.throws(()=>decrypt(oldFrame,{key,kid},ssrc,Buffer.alloc(0),8),/authentication/);
  assert.throws(()=>decrypt(oldFrame.subarray(0,-6),{key,kid},ssrc,Buffer.alloc(0),8),/authentication/);
  const receiver=new Receiver({key,kid},8);
  for(let i=0;i<3;i++){
   const p=audio.push(packet(opus,i,960*i))[0];
   assert.equal(p.payload.length,1+sframeHeader(kid,BigInt(i)).length+opus.length+4);
   assert.deepEqual(receiver.push(p),opus);assert.equal(receiver.counter,BigInt(i));
   assert.throws(()=>decrypt(p.payload.subarray(1),{key,kid},ssrc),/authentication/);
  }
 }finally{audio.close();old.close();}
});

const {rtcEnvironment}=require('./webrtc-helpers.cjs');
test('empty/true offers include independent keys; explicit false omits SFrame',async()=>{
 const e=rtcEnvironment(),rtc=new e.Class({addService(){}},quiet,e.opts),offers=[];
 try{
  for(const sframeEnabled of [undefined,true,false])offers.push(e.proto.parseWebRTCSolicitOfferResponse(Buffer.from(await rtc.handleSolicitOffer(e.proto.encodeWebRTCSolicitOffer({sframeEnabled}).toString('base64')),'base64')));
  assert(offers.every(o=>o.status===0));assert.equal(offers[0].sframeConfiguration.key.length,32);assert.equal(offers[1].sframeConfiguration.key.length,32);
  assert.notDeepEqual(offers[0].sframeConfiguration.key,offers[1].sframeConfiguration.key);assert.equal(offers[2].sframeConfiguration,undefined);
 }finally{rtc.closeAllSessions();}
});
test('SFrame reoffer keeps key, counters and RTP sequence; rejects encryption downgrade',async()=>{
 const e=rtcEnvironment(),rtc=new e.Class({addService(){}},quiet,e.opts),tlv=e.env.load(base+'hksv-multitier-protocol.ts'),tiers=e.env.load(base+'hksv-stream-tiers.ts');
 try{
  const o=e.proto.parseWebRTCSolicitOfferResponse(Buffer.from(await rtc.handleSolicitOffer(''),'base64')),s=rtc.sessions.get(o.sessionId.toString('hex'));
  await s.pc.setRemoteDescription({});s.answered=true;await rtc.startMedia(s);
  const video=s.videoSframe,audio=s.audioSframe,config=Buffer.from(s.sframeConfiguration.key),counter=video.encryptor.counter,seq=video.sequence;
  const request=tiers.tlvEncode(1,o.sessionId,2,Buffer.from('v=0\r\n'));
  const response=tlv.tlvDecodeMap(await rtc.handleReoffer(request));assert.equal(response[3][0],0);
  assert(response[4],'reoffer returns SFrame configuration');assert.deepEqual(s.sframeConfiguration.key,config);
  assert.equal(s.videoSframe,video);assert.equal(s.audioSframe,audio);assert.equal(video.encryptor.counter,counter);
  await rtc.startMedia(s);assert(video.encryptor.counter>counter);assert(video.sequence>seq);
  // Options is type 3, nested SFrame Enabled type 1. Never silently downgrade.
  const rejected=tlv.tlvDecodeMap(await rtc.handleReoffer(Buffer.concat([request,tiers.tlvEncode(3,tiers.tlvEncode(1,Buffer.from([0])))])));
  assert.equal(rejected[3][0],3);assert.equal(s.closed,false);
 }finally{rtc.closeAllSessions();}
});
test('privacy closes encrypted media, erases owned keys and prevents late packets',async()=>{
 const e=rtcEnvironment(),rtc=new e.Class({addService(){}},quiet,e.opts);
 try{
  const o=e.proto.parseWebRTCSolicitOfferResponse(Buffer.from(await rtc.handleSolicitOffer(''),'base64')),s=rtc.sessions.get(o.sessionId.toString('hex'));
  await s.pc.setRemoteDescription({});s.answered=true;await rtc.startMedia(s);
  const held=[s.sframeConfiguration.key,s.videoSframe.encryptor.key,s.audioSframe.encryptor.key];
  let sent=0;s.vtrack.writeRtp=()=>sent++;s.atrack.writeRtp=()=>sent++;
  rtc.locallyEnabled=false;rtc.closeAllSessions();assert(held.every(k=>k.every(x=>x===0)));
  for(const m of e.media){m.tracks.video?.onRtp(Buffer.alloc(1),'h265');m.tracks.audio?.onRtp(Buffer.alloc(1));}
  assert.equal(sent,0);assert.equal(s.closed,true);assert.equal(s.pacer,undefined);
 }finally{rtc.closeAllSessions();}
});
test('sender SSRC replacement fails closed instead of restarting a cipher counter',async()=>{
 const e=rtcEnvironment(),rtc=new e.Class({addService(){}},quiet,e.opts);
 try{
  const o=e.proto.parseWebRTCSolicitOfferResponse(Buffer.from(await rtc.handleSolicitOffer(''),'base64')),s=rtc.sessions.get(o.sessionId.toString('hex'));
  await s.pc.setRemoteDescription({});s.answered=true;await rtc.startMedia(s);rtc.stopMedia(s);s.videoTransceiver.sender.ssrc++;
  await assert.rejects(rtc.startMedia(s),/SSRC changed/);assert.equal(s.closed,true);
 }finally{rtc.closeAllSessions();}
});
