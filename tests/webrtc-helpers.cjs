const {environment,base,never}=require('./helpers.cjs');
const rtpBase='../../external/werift/packages/rtp/src/';
function rtcEnvironment({startForwarder}={}){
    const env=environment(), peers=[], media=[];
    class Peer {
        constructor(opts){this.opts=opts;this.transceivers=[];this.onIceCandidate={subscribe(){}};this.connectionStateChange={subscribe:fn=>this.change=fn};peers.push(this);}
        addTransceiver(track,opts){const t={sender:{ssrc:this.transceivers.length+1234},track,direction:opts.direction};this.transceivers.push(t);return t;}
        async createOffer(){return {type:'offer',sdp:'v=0\r\n'};}
        async setLocalDescription(o){this.localDescription=o;}
        getTransceivers(){return this.transceivers;}
        get dtlsTransports(){return [];}
        async setRemoteDescription(o){this.remoteDescription=o;this.transceivers.forEach((t,i)=>{t.currentDirection='sendonly';t.sender.codec=this.opts.codecs[t.track.kind]?.[0] || this.opts.codecs[i?'audio':'video'][0];});}
        async createAnswer(){return {type:'answer',sdp:'v=0\r\n'};}
        async close(){this.closed=true;}
    }
    env.mock('../../external/werift/packages/webrtc/src/index.ts',{RTCPeerConnection:Peer,MediaStreamTrack:class {constructor(o){Object.assign(this,o);}writeRtp(){}},RTCRtpCodecParameters:class{constructor(o){Object.assign(this,o);}},useSdesMid:()=>({uri:'urn:ietf:params:rtp-hdrext:sdes:mid'}),useSdesRTPStreamId:()=>({uri:'urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id'})});
    const rtp=env.load(rtpBase+'index.ts');let seq=0;
    env.mock(rtpBase+'index.ts',{...rtp,RtpPacket:class extends rtp.RtpPacket {static deSerialize(){return new rtp.RtpPacket(new rtp.RtpHeader({sequenceNumber:seq++,timestamp:seq*3000,ssrc:100,marker:true}),Buffer.from([0x26,1,0x80]));}}});
    env.mock('../webrtc/src/rtp-forwarders.ts',{async startRtpForwarderProcess(c,input,tracks,options){media.push({input,tracks});if(startForwarder)return startForwarder(c,input,tracks,options);queueMicrotask(()=>tracks.video?.onRtp(Buffer.alloc(1),'h265'));return {kill(){},killPromise:never,videoSection:Promise.resolve({codec:'h265'})};}});
    const tiers=env.load(base+'hksv-stream-tiers.ts');
    const opts={sensorUuid:Buffer.alloc(16),videoTiers:tiers.buildSensorVideoTiers(1920,1080),supportedVideoTiersValue:'',supportedAudioTiersValue:'',
        getMedia:async selection=>({container:'rtsp',inputArguments:['-i','camera'],mediaStreamOptions:{video:{codec:'h264'},audio:null}})};
    return {env,peers,media,opts,proto:env.load(base+'hksv-webrtc-protocol.ts'),Class:env.load(base+'camera-webrtc.ts').WebRTCStreamManagement};
}

module.exports={rtcEnvironment};
