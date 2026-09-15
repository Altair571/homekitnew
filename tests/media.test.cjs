const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {environment,base}=require('./helpers.cjs');
const ffmpeg=path.join(__dirname,'../node_modules/ffmpeg-static/ffmpeg');

test('real FFmpeg emits HEVC hvc1 fragments with indexed NTP timing',()=>{
    const env=environment();
    // Only use the parser exports here, not camera access or process startup in the source factory.
    env.mock('../../common/src/ffmpeg-mp4-parser-session.ts',{});
    env.mock('../../common/src/media-helpers.ts',{});
    const {videoEncoderArguments}=env.load(base+'hksv-media.ts');
    const {mp4Boxes,videoTiming,fragmentTiming}=env.load(base+'camera-cmaf-source.ts');
    const args=['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=320x180:rate=15',
        '-f','lavfi','-i','anullsrc=r=24000:cl=mono','-t','6',
        ...videoEncoderArguments('h265',640,360,15,180).map(a=>a.replace('repeat-headers=1','repeat-headers=0')), '-flags', '+global_header','-c:a','aac','-ar','24000','-ac','1','-b:a','32k',
        '-tag:v','hvc1','-write_prft','wallclock','-movflags','frag_keyframe+empty_moov+default_base_moof+skip_sidx+skip_trailer','-f','mp4','pipe:1'];
    const mp4=execFileSync(ffmpeg,args,{maxBuffer:8*1024*1024,timeout:30000});
    fs.writeFileSync(path.join(__dirname,'../sample-hevc.mp4'),mp4);
    assert(mp4.includes(Buffer.from('hvc1')));assert(!mp4.includes(Buffer.from('avc1')));
    const boxes=mp4Boxes(mp4),timing=videoTiming(boxes.find(b=>b.type==='moov').data);
    let prft,fragments=[];
    for(const b of boxes){if(b.type==='prft')prft??=b.data;else if(b.type==='moof')fragments.push(fragmentTiming(b.data,prft,timing));}
    assert.equal(fragments.length,3);
    for(const f of fragments)assert(Math.abs(Number(f.end-f.start)/2**32-2)<0.05);
    for(let i=1;i<fragments.length;i++)assert.equal(fragments[i].start,fragments[i-1].end);
    const {HksvRecordingBuffer}=env.load(base+'hksv-recording-buffer.ts');
    const ring=new HksvRecordingBuffer();ring.reset(Buffer.from('init'));
    for(const f of fragments)ring.append({...f,data:Buffer.from('fragment')});
    assert(fragments[0].start>3900000000n*(1n<<32n));
    // Non-realtime lavfi generation tests PRFT indexing, not wall-clock pacing.
    const output=execFileSync(ffmpeg,['-hide_banner','-i',path.join(__dirname,'../sample-hevc.mp4'),'-f','null','-'],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30000});
});

test('actual bundled werift generates an offer containing HEVC and 48 kHz Opus',async()=>{
    const env=environment();
    const {RTCPeerConnection,RTCRtpCodecParameters,MediaStreamTrack}=env.load('../../external/werift/packages/webrtc/src/index.ts');
    const pc=new RTCPeerConnection({codecs:{video:[new RTCRtpCodecParameters({mimeType:'video/H265',clockRate:90000,payloadType:99,parameters:'profile-id=1;tier-flag=0;level-id=153;tx-mode=SRST'})],
        audio:[new RTCRtpCodecParameters({mimeType:'audio/opus',clockRate:48000,payloadType:110,channels:2})]}});
    try {
        pc.addTransceiver(new MediaStreamTrack({kind:'video'}),{direction:'sendonly'});
        pc.addTransceiver(new MediaStreamTrack({kind:'audio'}),{direction:'sendonly'});
        const offer=await pc.createOffer();
        assert.match(offer.sdp,/a=rtpmap:99 H265\/90000/i);
        assert.match(offer.sdp,/a=rtpmap:110 opus\/48000\/2/i);
    }finally{await pc.close();}
});
