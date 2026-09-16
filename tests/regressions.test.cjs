const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { environment, storage, base, quiet, never, hap } = require('./helpers.cjs');
const accessory = { UUID: '00000000-0000-4000-8000-000000000001', addService() {} };
const rtpBase = '../../external/werift/packages/rtp/src/';

test('tier builder uses actual landscape, portrait, and square dimensions', () => {
    const tiers = environment().load(base + 'hksv-stream-tiers.ts');
    for (const [w,h,highW,highH] of [[3840,2160,3840,2160],[2560,1440,2560,1440],[1920,1080,1920,1080],[2160,3840,2160,3840],[2048,1536,2048,1536],[1440,1440,1440,1440]]) {
        const t = tiers.buildSensorVideoTiers(w,h);
        assert.equal(t.length,3); assert.equal(t[0].width,highW); assert.equal(t[0].height,highH);
        assert(t.every(v => v.width <= w && v.height <= h));
    }
    assert.throws(() => tiers.buildSensorVideoTiers(640,480), /minimum/);
});

test('new Opus clock is 48 kHz, including RTP timestamp wrap and zero', () => {
    const env = environment({fakeTimers:true}), sent = [];
    env.mock(rtpBase+'srtp/srtp.ts', { SrtpSession: class { encrypt(p,h) { sent.push({...h}); return Buffer.alloc(1); } } });
    env.mock(rtpBase+'srtp/srtcp.ts', { SrtcpSession: class { encrypt() {return Buffer.alloc(1);} } });
    env.mock(rtpBase+'rtcp/sr.ts', { RtcpSenderInfo: class {}, RtcpSrPacket: class {serialize(){return Buffer.alloc(1);}} });
    env.mock('../../common/src/rtsp-server.ts', {});
    env.mock(base+'camera-utils.ts', {ntpTime:()=>0n});
    env.mock('./node_modules/lodash/throttle.js', fn=>fn);
    const {createCameraStreamSender} = env.load(base+'camera-streaming-srtp-sender.ts');
    for (const [start,clock,step] of [[0,48000,960],[0xffffff00,48000,960],[9000,undefined,480]]) {
        sent.length=0;
        const sender=createCameraStreamSender(quiet,{}, {send(){}},123,110,1,'::1',0.5,undefined,
            {audioPacketTime:20,audioSampleRate:24,rtpClockRate:clock,framesPerPacket:1});
        for(let i=0;i<3;i++) sender.sendRtp({header:{timestamp:(start+i*960)>>>0,sequenceNumber:i},payload:Buffer.from([0xf8,0xff,0xfe])});
        assert.equal(sent.length,3);
        sent.forEach((p,i)=>assert.equal(p.timestamp,(start+i*step)>>>0));
    }
});

test('live RTP uses HEVC encoder for mismatched source and debug, copies exact HEVC tier only', async () => {
    const env=environment(), calls=[];
    env.mock(rtpBase+'rtp/rtp.ts',{RtpPacket:{deSerialize:()=>({payload:Buffer.alloc(1),header:{timestamp:0,sequenceNumber:0}})}});
    env.mock('../../common/src/sdp-utils.ts',{getSpsPps(){}});
    env.mock(base+'camera-streaming-session.ts',{async waitForFirstVideoRtcp(){}});
    env.mock(base+'camera-streaming-srtp-sender.ts',{createCameraStreamSender(){return {sendRtp(){},sendRtcp(){}};}});
    env.mock('../webrtc/src/rtp-forwarders.ts',{async startRtpForwarderProcess(c,input,tracks){
        calls.push({input,tracks}); queueMicrotask(()=>tracks.video?.onRtp(Buffer.alloc(1),'h265'));
        return {kill(){},killPromise:never,videoSection:Promise.resolve({codec:'h265'})};
    }});
    const {startCameraStreamFfmpeg}=env.load(base+'camera-streaming-ffmpeg.ts');
    for(const [sourceCodec,debug,copy] of [['h265',false,true],['h265',true,false],['h264',false,false],['hevc',false,true]]){
        const session={startRequest:{hksv27:true,video:{codec:1,width:640,height:360,fps:15,max_bit_rate:180,pt:99,mtu:1200},
            audio:{codec:'OPUS',sample_rate:24,packet_time:20,channel:1,pt:110,max_bit_rate:32}},
            prepareRequest:{targetAddress:'::1',video:{port:1},audio:{port:2}},videoReturn:{},audioReturn:{},vconfig:{},aconfig:{},videossrc:1,audiossrc:2,killPromise:never,kill(){}};
        await startCameraStreamFfmpeg({},quiet,storage({debugMode:JSON.stringify(debug?['Transcode Video']:[])}),
            {container:'rtsp',inputArguments:['-i','test'],mediaStreamOptions:{video:{codec:sourceCodec,width:640,height:360,fps:15,bitrate:180000},audio:null}},session);
        const {input,tracks}=calls.filter(c=>c.tracks.video).at(-1);
        assert.equal(tracks.video.codecCopy,'transcode');
        assert(tracks.video.encoderArguments.includes(copy?'copy':'libx265'));
        assert(!tracks.video.encoderArguments.includes('libx264'));
        assert(!input.inputArguments.includes('anullsrc=r=24000:cl=mono'));
        assert(calls.at(-1).input.inputArguments.includes('anullsrc=r=24000:cl=mono'));
        assert(!calls.at(-1).tracks.video);
        assert.equal(tracks.video.ssrc,session.videossrc);
    }
});

test('RTP start reports completion only after startup; failure, duplicate and privacy clean up', async () => {
    const env=environment(), tiers=env.load(base+'hksv-stream-tiers.ts'), proto=env.load(base+'hksv-multitier-protocol.ts');
    const {MultiTierStreamManagement}=env.load(base+'camera-multitier.ts');
    let completion, changes, active=true; const requests=[];
    const mt=new MultiTierStreamManagement(accessory,{handleStreamRequest(req,cb){requests.push(req); if(req.type==='start') completion=cb;else cb();}},quiet,
        {sensorClass:'4k',gate:{isActive:()=>active,onChanged:fn=>changes=fn}});
    const sid=Buffer.alloc(16,1), id=sid.toString('hex');
    const write=tiers.tlvEncode(1,sid,2,tiers.u8(2),3,tiers.u32(1),4,tiers.u32(1),5,tiers.u32(1),6,tiers.u32(2)).toString('base64');
    const status=r=>proto.tlvDecodeMap(Buffer.from(r,'base64'))[2][0];
    mt.sessions.set(id,{addressVersion:'ipv4',started:false,prepared:{}});
    let response; mt.handleStreamingControl(write,(e,r)=>{assert.ifError(e);response=r;});
    assert.equal(response,undefined);assert.equal(requests[0].audio.rtpClockRate,48000);
    let duplicate; mt.handleStreamingControl(write,(e,r)=>duplicate=r);assert.equal(status(duplicate),3);
    completion();assert.equal(status(response),0);assert.equal(mt.sessions.get(id).started,true);
    active=false;changes();assert.equal(mt.sessions.size,0);assert.equal(requests.at(-1).type,'stop');
    active=true;mt.sessions.set(id,{addressVersion:'ipv4',started:false,prepared:{}});
    mt.handleStreamingControl(write,(e,r)=>response=r);completion(new Error('encoder unavailable'));
    assert.equal(status(response),4);assert.equal(mt.sessions.size,0);
});

const {rtcEnvironment}=require('./webrtc-helpers.cjs');

test('WebRTC advertises HEVC and SFrame, rejects global off, closes existing sessions',async()=>{
    const {Class,opts,proto,peers}=rtcEnvironment(); let active=true,changed;
    opts.gate={isActive:()=>active,onChanged:fn=>changed=fn};
    const rtc=new Class(accessory,quiet,opts);
    const offer=async sframe=>proto.parseWebRTCSolicitOfferResponse(Buffer.from(await rtc.handleSolicitOffer(proto.encodeWebRTCSolicitOffer({sframeEnabled:sframe}).toString('base64')),'base64'));
    assert.equal((await offer(true)).status,0);assert.equal(peers.length,1);
    assert.equal((await offer(false)).status,0);assert.equal(peers[0].opts.codecs.video[0].mimeType,'video/H265');
    assert.equal(peers[0].opts.codecs.video.length,1);
    assert.equal(peers[0].opts.codecs.audio[0].clockRate,48000);
    active=false;changed();assert(peers.every(p=>p.closed));assert.equal(rtc.sessions.size,0);
    assert.notEqual((await offer(false)).status,0);
});

test('WebRTC HEVC selection requests HEVC and invokes libx265 for H264 sources',async()=>{
    const {Class,opts,proto,peers,media}=rtcEnvironment(); let selected;
    const get=opts.getMedia;opts.getMedia=async selection=>{selected=selection;return get(selection);};
    const rtc=new Class(accessory,quiet,opts);
    await rtc.handleSolicitOffer(proto.encodeWebRTCSolicitOffer({sframeEnabled:false}).toString('base64'));
    const session=[...rtc.sessions.values()][0];
    session.videoTransceiver.sender.codec=peers[0].opts.codecs.video[0];session.audioTransceiver.sender.codec=peers[0].opts.codecs.audio[0];
    session.answered=true;
    await rtc.startMedia(session);
    // r32 offers and sends the lowest advertised tier to Apple's relay.
    assert.equal(selected.codec,'h265');assert.equal(selected.tier.width,640);assert.equal(selected.tier.height,360);
    assert(media[0].tracks.video.encoderArguments.includes('libx265'));assert.equal(media[1].tracks.audio.encoderArguments.at(-1),'1');assert.equal(media[0].tracks.audio,undefined);
    rtc.closeAllSessions();
});

test('recording reads timestamp ranges, honors exclusion windows, and fails after eviction',async()=>{
    const {HksvRecordingBuffer,NTP_SECOND}=environment().load(base+'hksv-recording-buffer.ts');
    const ring=new HksvRecordingBuffer(60,1000), second=NTP_SECOND;
    ring.reset(Buffer.from('init'));
    for(let i=0;i<4;i++)ring.append({data:Buffer.from(`f${i}`),start:BigInt(i)*second,end:BigInt(i+1)*second});
    ring.activity(second,1000n,false);
    const window=ring.open(second,3n*second,false), out=[];
    for await(const chunk of window)out.push(chunk.toString());
    assert.deepEqual(out,['init','f2']);
    assert.throws(()=>ring.open(-second),/older/);
    const stale=ring.open(0n);ring.reset(Buffer.from('next'));await assert.rejects(stale[Symbol.asyncIterator]().next(),/restarted/);
});

test('recording pause preserves the same iterator and resumes at the requested timestamp',async()=>{
    const {HksvRecordingBuffer,NTP_SECOND:S}=environment().load(base+'hksv-recording-buffer.ts');
    const ring=new HksvRecordingBuffer();ring.reset(Buffer.from('init'));
    for(let i=0;i<4;i++)ring.append({data:Buffer.from(`f${i}`),start:BigInt(i)*S,end:BigInt(i+1)*S});
    const w=ring.open(0n,S,true),it=w[Symbol.asyncIterator]();
    assert.equal((await it.next()).value.toString(),'init');assert.equal((await it.next()).value.toString(),'f0');
    const pending=it.next();w.resume(2n*S,3n*S,false);
    assert.equal((await pending).value.toString(),'f2');assert.equal((await it.next()).done,true);
});

test('WebRTC reserves pending offers and enforces six sessions, with receive-key removal',async()=>{
    const {Class,opts,proto}=rtcEnvironment();const rtc=new Class(accessory,quiet,opts);
    const value=proto.encodeWebRTCSolicitOffer({sframeEnabled:false}).toString('base64');
    const results=await Promise.all(Array.from({length:7},()=>rtc.handleSolicitOffer(value)));
    assert.equal(results.map(r=>proto.parseWebRTCSolicitOfferResponse(Buffer.from(r,'base64'))).filter(r=>r.status===0).length,6);
    const id=[...rtc.sessions.values()][0].sessionId;
    const update=await rtc.handleUpdateSession(proto.encodeWebRTCUpdateSession({sessionId:id,receiveKeysToAdd:[],receiveKidsToRemove:[1n]}));
    assert.equal(proto.parseWebRTCSessionStatusResponse(update).status,0);
    rtc.closeAllSessions();
});

test('recording activity updates replace overlapping earlier exclusions',async()=>{
    const {HksvRecordingBuffer,NTP_SECOND:S}=environment().load(base+'hksv-recording-buffer.ts');
    const ring=new HksvRecordingBuffer();ring.reset(Buffer.from('init'));
    for(let i=0;i<3;i++)ring.append({data:Buffer.from(`f${i}`),start:BigInt(i)*S,end:BigInt(i+1)*S});
    ring.activity(0n,3000n,false);ring.activity(S,1000n,true);
    const chunks=[];for await(const chunk of ring.open(0n,3n*S))chunks.push(chunk.toString());
    assert.deepEqual(chunks,['init','f1']);
});

// r44 posts one CMAF object per request instead of streaming a clip through a single POST.
function ingestMock(env){
    const requests=[];
    env.mock('https',{Agent:class{destroy(){}},request(url,opts){
        const req=new EventEmitter();requests.push(req);req.url=url;req.opts=opts;
        req.end=body=>{req.body=body;req.ended=true;};
        req.destroy=()=>queueMicrotask(()=>req.emit('close'));return req;}});
    const respond=(req,statusCode=200)=>{
        const response=new EventEmitter();response.statusCode=statusCode;response.resume=()=>{};
        req.emit('response',response);queueMicrotask(()=>response.emit('end'));};
    return {requests,respond};
}
const tickOnce=()=>new Promise(setImmediate);
// Each object is posted after its predecessor's response resolves, several awaits deep.
async function nthRequest(requests,n){
    for(let i=0;i<200&&requests.length<n;i++)await tickOnce();
    assert.equal(requests.length,n,`request ${n} was issued`);
    return requests[n-1];
}
const ingestTarget={publishingPointUrl:'https://camera.invalid/path/?token=example',serverCaCertificatesDer:[Buffer.from('ca')],
    clientCertificateDer:Buffer.from('cert'),clientPrivateKeyPem:'key',clipId:9n};
// r44 reads the init segment to brand it as a CMAF Header, so the source has to be real boxes.
const emptyFtyp=Buffer.concat([Buffer.from([0,0,0,8]),Buffer.from('ftyp')]);

test('CMAF stop interrupts a stalled session, and a clip completes only when the last object does',async()=>{
    const env=environment();const {requests,respond}=ingestMock(env);
    const {CmafIngestSession}=env.load(base+'cmaf-ingest.ts');
    let stopped=0,errors=0;const callbacks={onError(){errors++;},onStopped(){stopped++;}};
    const session=new CmafIngestSession(ingestTarget,1n,quiet,callbacks);
    const blocked={async *[Symbol.asyncIterator](){await never;yield Buffer.alloc(1);}};
    const running=session.run(blocked);await tickOnce();session.stop();await running;
    assert.equal(stopped,1);assert.equal(errors,0);
    assert.equal(requests.length,1,'the stalled session got no further than its probe');

    requests.length=0;
    const session2=new CmafIngestSession(ingestTarget,2n,quiet,callbacks);
    let complete=false;
    const finished=session2.run((async function*(){yield emptyFtyp;})()).then(()=>complete=true);
    const probe=await nthRequest(requests,1);
    assert.equal(probe.url.pathname,'/path/','the session opens with the connectivity probe');
    assert.equal(probe.url.search,'?token=example','the publishing point query survives');
    respond(probe);
    const header=await nthRequest(requests,2);
    assert.equal(header.url.pathname,'/path/9/init.mp4','the CMAF Header is named under the clip');
    assert.equal(header.opts.headers['Content-Type'],'video/mp4');
    assert.equal(complete,false);
    respond(header,201);
    const end=await nthRequest(requests,3);
    assert.equal(end.url.pathname,'/path/9/','an empty mfra closes the clip');
    assert.equal(complete,false,'the clip is not finished until its last object is acknowledged');
    respond(end);await finished;
    assert.equal(stopped,2);assert.equal(errors,0);
});

test('CMAF premature connection closure reports exactly one error',async()=>{
    const env=environment();const {requests}=ingestMock(env);
    const {CmafIngestSession}=env.load(base+'cmaf-ingest.ts');
    const {CmafError}=env.load(base+'hksv-recording-protocol.ts');
    let stopped=0;const reported=[];
    const session=new CmafIngestSession(ingestTarget,1n,quiet,
        {onError(error){reported.push(error);},onStopped(){stopped++;}});
    const finished=session.run((async function*(){yield emptyFtyp;})());
    await tickOnce();requests[0].emit('close');await finished;
    assert.equal(stopped,1);
    assert.deepEqual(reported,[CmafError.CONNECTION_FAILED]);
});

test('full new HAP service inventory constructs against the actual bundled HAP library',()=>{
    const env=environment({realHap:true});
    const {Accessory}=env.load('./src/hap.ts');
    const {Hksv27Camera}=env.load(base+'camera-hksv27.ts');
    const acc=new Accessory('HEVC regression camera',accessory.UUID);
    const camera=new Hksv27Camera(acc,{handleStreamRequest(req,cb){cb();}},storage(),quiet,{sensorClass:'1080p',sensorWidth:1920,sensorHeight:1080});
    assert.equal(camera.multiTier.videoTiers[0].width,1920);
    assert(camera.webrtc.service.characteristics.length>5);
    camera.handleFactoryReset();
});

test('camera plugins that reject HEVC constraints can provide a native stream for conversion',async()=>{
    const {getHksvVideoStream,canCopyVideo}=environment().load(base+'hksv-media.ts');
    let count=0,relaxed;
    const result=await getHksvVideoStream({async getVideoStreamOptions(){return [];},async getVideoStream(options){if(++count===1)throw new Error('unsupported codec');relaxed=options;return 'native';}},
        {container:'rtsp',video:{codec:'h265',width:1920,height:1080,fps:30,clientWidth:1920},audio:{codec:'opus'}});
    assert.equal(result,'native');assert.equal(relaxed.video.codec,undefined);assert.equal(relaxed.video.clientWidth,undefined);
    assert.equal(relaxed.adaptive,false);
    const tier={width:640,height:360,frameRate:15,averageBitrateKbps:180};
    assert.equal(canCopyVideo({mediaStreamOptions:{video:{codec:'h265',width:640,height:360,fps:15,bitrate:2000000}}},'h265',tier),false);
});

test('non-widescreen high tiers never advertise a peak bitrate below their average',()=>{
    const env=environment(),{buildSensorVideoTiers}=env.load(base+'hksv-stream-tiers.ts');
    const {peakBitrateKbpsForTier}=env.load(base+'hksv-camera-capabilities.ts');
    for(const [w,h] of [[2880,2160],[2048,1536],[1440,1440],[2880,2880]])
        for(const tier of buildSensorVideoTiers(w,h))assert(peakBitrateKbpsForTier(tier)>=tier.averageBitrateKbps);
});
