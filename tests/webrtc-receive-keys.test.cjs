const test=require('node:test');
const assert=require('node:assert/strict');
const {environment,base,quiet,never}=require('./helpers.cjs');
const {rtcEnvironment}=require('./webrtc-helpers.cjs');
const accessory={addService(){}};
const tick=()=>new Promise(setImmediate);
async function setup(startForwarder){
 const e=rtcEnvironment({startForwarder}),logs=[];
 const rtc=new e.Class(accessory,{...quiet,log(...a){logs.push(a.join(' '));}},e.opts);
 // Exactly the empty Solicit Offer used by the Apple TV in the r14 field log.
 const offer=e.proto.parseWebRTCSolicitOfferResponse(Buffer.from(await rtc.handleSolicitOffer(''),'base64'));
 return {...e,rtc,offer,logs,session:rtc.sessions.get(offer.sessionId.toString('hex'))};
}
const status=(e,r)=>e.proto.parseWebRTCSessionStatusResponse(r).status;
const update=(e,add=[],remove=[])=>e.proto.encodeWebRTCUpdateSession({sessionId:e.offer.sessionId,receiveKeysToAdd:add,receiveKidsToRemove:remove});

test('Apple TV empty offer then 88-character receive-key update proceeds to SDP answer',async()=>{
 const e=await setup();
 try {
  assert.equal(e.offer.status,0);assert.equal(e.offer.sframeConfiguration.key.length,32);
  const key=Buffer.alloc(32,0x7c),write=update(e,[{key,kid:0xf123456789abcdefn}]);
  assert.equal(write.toString('base64').length,88,'matches field request length');
  assert.equal(status(e,await e.rtc.handleUpdateSession(write)),0,'r14 returned Error=3 here');
  assert.equal(e.session.receiveKeys.size,1);assert.equal(e.media.length,0);
  const answer=e.proto.encodeWebRTCProvideAnswer({sessionId:e.offer.sessionId,sdpAnswer:'v=0\r\n',additionalCandidates:[]});
  assert.equal(status(e,await e.rtc.handleProvideAnswer(answer)),0);
  assert.equal(e.session.answered,true);
  assert(e.peers[0].transceivers.every(t=>t.direction==='sendonly'));
  assert(e.logs.some(l=>l.includes('receive direction inactive; status=0')));
  assert(!e.logs.some(l=>l.includes(key.toString('hex'))||l.includes(key.toString('base64'))));
 } finally {e.rtc.closeAllSessions();}
});

test('receive-key rotation is atomic, bounded, and wipes replaced or removed copies',()=>{
 const {WebRTCReceiveKeys}=environment().load(base+'hksv-webrtc-receive-keys.ts'),ring=new WebRTCReceiveKeys();
 const key=Buffer.alloc(32,5);ring.update([{kid:0xffffffffffffffffn,key}],[]);
 const stored=ring.keys.get(0xffffffffffffffffn);key.fill(8);assert(stored.every(b=>b===5));
 ring.update([{kid:0xffffffffffffffffn,key:Buffer.alloc(32,9)}],[]);assert(stored.every(b=>b===0));
 const replaced=ring.keys.get(0xffffffffffffffffn);
 assert.throws(()=>ring.update([{kid:2n,key:Buffer.alloc(0)}],[0xffffffffffffffffn]),/Invalid/);
 assert.equal(ring.size,1);assert(replaced.every(b=>b===9));
 ring.update([], [0xffffffffffffffffn,999n]);assert.equal(ring.size,0);assert(replaced.every(b=>b===0));
 const entries=Array.from({length:32},(_,i)=>({kid:BigInt(i),key:Buffer.alloc(32,i+1)}));ring.update(entries,[]);
 assert.throws(()=>ring.update([{kid:32n,key:Buffer.alloc(32)}],[]),/limit/);assert.equal(ring.size,32);
 ring.update([{kid:32n,key:Buffer.alloc(32,8)}],[0n]);assert.equal(ring.size,32);
 const held=[...ring.keys.values()];ring.clear();assert(held.every(k=>k.every(b=>b===0)));
});

test('bad TLVs and conflicting key rotations return Error without deleting existing keys',async()=>{
 const e=await setup(),t=e.env.load(base+'hksv-stream-tiers.ts');
 try {
  assert.equal(status(e,await e.rtc.handleUpdateSession(update(e,[{kid:1n,key:Buffer.alloc(32,7)}]))),0);
  const sid=t.tlvEncode(1,e.offer.sessionId),key=Buffer.alloc(32,3);
  const invalid=[
   Buffer.concat([sid,Buffer.from([2,40,1,32])]), // truncated outer record
   t.tlvEncode(1,e.offer.sessionId,2,t.tlvEncode(1,key)), // missing KID
   t.tlvEncode(1,e.offer.sessionId,2,t.tlvEncode(1,key,2,Buffer.alloc(9))),
   t.tlvEncode(1,e.offer.sessionId,3,t.tlvEncode(1,Buffer.alloc(0))),
   update(e,[{kid:1n,key},{kid:1n,key}]),
   update(e,[{kid:1n,key}],[1n]),
   update(e,[{kid:2n,key:Buffer.alloc(1025)}],[1n]),
  ];
  for(const write of invalid){assert.equal(status(e,await e.rtc.handleUpdateSession(write)),3);assert.equal(e.session.receiveKeys.size,1);assert(e.session.receiveKeys.keys.get(1n).every(b=>b===7));}
  const compact=t.tlvEncode(1,e.offer.sessionId,2,t.tlvEncode(1,key,2,Buffer.from([2])));
  assert.equal(status(e,await e.rtc.handleUpdateSession(compact)),0);
 }finally{e.rtc.closeAllSessions();}
});

test('receive keys are isolated and wiped by close, privacy, factory reset and unanswered timeout',async()=>{
 for(const cause of ['close','privacy','reset','timeout']){
  const e=await setup();
  try{
   await e.rtc.handleUpdateSession(update(e,[{kid:4n,key:Buffer.alloc(32,6)}]));
   const stored=e.session.receiveKeys.keys.get(4n);
   const other=e.proto.parseWebRTCSolicitOfferResponse(Buffer.from(await e.rtc.handleSolicitOffer(''),'base64'));
   assert.equal(e.rtc.sessions.get(other.sessionId.toString('hex')).receiveKeys.size,0);
   if(cause==='privacy'){e.rtc.locallyEnabled=false;e.rtc.closeAllSessions();}
   else if(cause==='reset')e.rtc.handleFactoryReset();
   else if(cause==='timeout')e.session.reapTimer._onTimeout();
   else e.rtc.closeSession(e.offer.sessionId.toString('hex'));
   assert(stored.every(b=>b===0));assert.equal(e.session.receiveKeys.size,0);
   assert.equal(status(e,await e.rtc.handleUpdateSession(update(e))),1);
  }finally{e.rtc.closeAllSessions();}
 }
});

test('receive-key provisioning preserves outgoing SFrame keys and never enables incoming media',async()=>{
 const e=await setup();
 try{
  const outgoing=Buffer.from(e.session.sframeConfiguration.key);
  await e.rtc.handleUpdateSession(update(e,[{kid:0n,key:Buffer.alloc(32,1)}]));
  assert.deepEqual(e.session.sframeConfiguration.key,outgoing);
  const offered=e.proto.parseWebRTCSolicitOfferResponse(Buffer.from(await e.rtc.handleSolicitOffer(e.proto.encodeWebRTCSolicitOffer({sframeEnabled:true}).toString('base64')),'base64'));
  assert.equal(offered.status,0);assert.equal(offered.sframeConfiguration.key.length,32);
  e.peers[0].setRemoteDescription=async()=>{e.session.audioTransceiver.currentDirection='sendrecv';};
  const response=await e.rtc.handleProvideAnswer(e.proto.encodeWebRTCProvideAnswer({sessionId:e.offer.sessionId,sdpAnswer:'v=0\r\n',additionalCandidates:[]}));
  assert.equal(status(e,response),3);assert.equal(e.session.closed,true);assert.equal(e.media.length,0);assert.equal(e.session.receiveKeys.size,0);
 }finally{e.rtc.closeAllSessions();}
});

test('reoffers introducing an incoming transceiver are rejected without activating a receiver',async()=>{
 const e=await setup(),t=e.env.load(base+'hksv-stream-tiers.ts');
 try {
  e.peers[0].setRemoteDescription=async()=>{e.peers[0].transceivers.push({direction:'recvonly'});};
  const response=await e.rtc.handleReoffer(t.tlvEncode(1,e.offer.sessionId,2,Buffer.from('v=0\r\n')));
  assert.equal(e.env.load(base+'hksv-multitier-protocol.ts').tlvDecodeMap(response)[3][0],3);
  assert.equal(e.session.closed,true);assert.equal(e.media.length,0);
 }finally{e.rtc.closeAllSessions();}
});

test('ICE connecting before answer validation cannot start media, then starts after validation',async()=>{
 const e=await setup();
 try {
  const set=e.peers[0].setRemoteDescription.bind(e.peers[0]);
  e.peers[0].setRemoteDescription=async o=>{await set(o);e.peers[0].connectionState='connected';e.peers[0].change('connected');assert.equal(e.media.length,0);};
  assert.equal(status(e,await e.rtc.handleProvideAnswer(e.proto.encodeWebRTCProvideAnswer({sessionId:e.offer.sessionId,sdpAnswer:'v=0\r\n',additionalCandidates:[]}))),0);
  await tick();assert.equal(e.media.filter(m=>m.tracks.video).length,1);
 }finally{e.rtc.closeAllSessions();}
});

test('a late independent audio descriptor cannot start a process after session closure',async()=>{
 const e=await setup();let audio;let calls=0;
 e.rtc.getMedia=async()=>++calls===1?{container:'rtsp',inputArguments:['-i','camera'],mediaStreamOptions:{video:{codec:'h265'},audio:{codec:'aac'}}}:new Promise(r=>audio=r);
 try{
  await e.peers[0].setRemoteDescription({});e.session.answered=true;
  await e.rtc.startMedia(e.session);assert.equal(calls,2);assert.equal(e.media.length,1);
  e.rtc.closeAllSessions();audio({inputArguments:['-i','late']});await tick();
  assert.equal(e.media.length,1);assert.equal(e.session.audioTimer,undefined);assert.equal(e.session.pacer,undefined);
 }finally{e.rtc.closeAllSessions();}
});

test('an audio process failure leaves WebRTC video running until session cleanup',async()=>{
 const processes=[];let endAudio;
 const e=await setup(async(c,input,tracks,options)=>{
  const p={kill(){this.killed=true;},killPromise:tracks.video?never:new Promise(r=>endAudio=r),videoSection:Promise.resolve({codec:'h265'})};
  processes.push({p,input,tracks,options});queueMicrotask(()=>tracks.video?.onRtp(Buffer.alloc(1),'h265'));return p;
 });
 try{
  await e.peers[0].setRemoteDescription({});e.session.answered=true;await e.rtc.startMedia(e.session);
  assert.equal(processes.length,2);assert.equal(processes[0].options.rtspMode,'tcp');assert.equal(processes[1].options.rtspClientForceTcp,true);
  endAudio();await tick();assert.equal(e.session.closed,false);assert.equal(processes[0].p.killed,undefined);
  e.rtc.closeAllSessions();assert.equal(processes[0].p.killed,true);
 }finally{e.rtc.closeAllSessions();}
});
