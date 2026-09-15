// Local RTSP fixture: real HEVC pictures, AAC advertised but no audio packets.
const net=require('node:net');
const {execFileSync}=require('node:child_process');
const {once}=require('node:events');
const path=require('node:path');
const ffmpeg=path.join(__dirname,'../node_modules/ffmpeg-static/ffmpeg');
async function camera({singleClient=false,fps=15,initialBurstFrames=0}={}) {
 const raw=execFileSync(ffmpeg,['-hide_banner','-loglevel','error','-f','lavfi','-i',`testsrc2=size=320x180:rate=${fps}`,'-t','2',
  '-c:v','libx265','-preset','ultrafast','-tune','zerolatency','-x265-params',`aud=1:repeat-headers=1:keyint=${fps}:pools=1:frame-threads=1:log-level=error`,'-f','hevc','pipe:1'],{timeout:15000,maxBuffer:2**20});
 const starts=[...raw.toString('latin1').matchAll(/\x00\x00\x00?\x01/g)];
 const nals=starts.map((m,i)=>raw.subarray(m.index+m[0].length,starts[i+1]?.index??raw.length));
 const param=t=>nals.find(n=>((n[0]>>1)&63)===t).toString('base64');
 const frames=[];let frame=[];
 for(const n of nals){if(((n[0]>>1)&63)===35&&frame.length){frames.push(frame);frame=[];}frame.push(n);}if(frame.length)frames.push(frame);
 const sdp=['v=0','o=- 1 1 IN IP4 127.0.0.1','s=Stalled AAC test','c=IN IP4 127.0.0.1','t=0 0','a=control:*',
  'm=video 0 RTP/AVP 96','a=rtpmap:96 H265/90000','a=control:trackID=0',
  `a=fmtp:96 sprop-vps=${param(32)};sprop-sps=${param(33)};sprop-pps=${param(34)}`,
  'm=audio 0 RTP/AVP 97','a=rtpmap:97 MPEG4-GENERIC/16000/1','a=fmtp:97 config=1408','a=control:trackID=1',''].join('\r\n');
 const sockets=new Set();let videoSetups=0,audioSetups=0,connections=0,videoBytes=0;
 const server=net.createServer(socket=>{
  connections++;if(singleClient&&connections>1){socket.destroy();return;}
  sockets.add(socket);let pending=Buffer.alloc(0),channel,playing=false,index=0,seq=0,timestamp=0,burstSent=false;
  const emitFrame=()=>{if(!playing||channel===undefined)return;
   const payloads=[];for(const n of frames[index++%frames.length]){
    if(n.length<=1000)payloads.push(n);
    else for(let off=2;off<n.length;off+=997){const last=off+997>=n.length;
     payloads.push(Buffer.concat([Buffer.from([(n[0]&0x81)|(49<<1),n[1],((n[0]>>1)&63)|(off===2?128:0)|(last?64:0)]),n.subarray(off,off+997)]));}
   }
   payloads.forEach((payload,i)=>{const rtp=Buffer.alloc(12);rtp[0]=128;rtp[1]=96|(i===payloads.length-1?128:0);rtp.writeUInt16BE(seq++&65535,2);rtp.writeUInt32BE(timestamp>>>0,4);rtp.writeUInt32BE(77,8);
    const h=Buffer.from([36,channel,0,0]);h.writeUInt16BE(rtp.length+payload.length,2);socket.write(Buffer.concat([h,rtp,payload]));videoBytes+=payload.length;});timestamp+=90000/fps;
  };
  const timer=setInterval(emitFrame,1000/fps);
  socket.on('error',()=>{});socket.on('close',()=>{clearInterval(timer);sockets.delete(socket);});
  socket.on('data',data=>{pending=Buffer.concat([pending,data]);while(pending.length){
   if(pending[0]===36){if(pending.length<4||pending.length<4+pending.readUInt16BE(2))return;pending=pending.subarray(4+pending.readUInt16BE(2));continue;}
   const end=pending.indexOf('\r\n\r\n');if(end<0)return;const head=pending.subarray(0,end).toString();const length=Number(head.match(/Content-Length:\s*(\d+)/i)?.[1]||0);if(pending.length<end+4+length)return;pending=pending.subarray(end+4+length);
   const [method,url]=head.split(' '),cseq=head.match(/CSeq:\s*(\d+)/i)?.[1];let body='',headers='';
   if(method==='DESCRIBE'){body=sdp;headers=`Content-Type: application/sdp\r\nContent-Base: rtsp://127.0.0.1:${server.address().port}/camera/\r\n`;}
   if(method==='OPTIONS')headers='Public: OPTIONS, DESCRIBE, SETUP, PLAY, TEARDOWN, GET_PARAMETER\r\n';
   if(method==='SETUP') {const transport=head.match(/Transport:\s*([^\r\n]+)/i)?.[1];if(!transport?.includes('interleaved')){socket.write(`RTSP/1.0 461 Unsupported Transport\r\nCSeq: ${cseq}\r\n\r\n`);continue;}
    const ch=Number(transport.match(/interleaved=(\d+)/)[1]);if(url.includes('trackID=0')){channel=ch;videoSetups++;}else audioSetups++;headers=`Transport: ${transport}\r\n`;}
   socket.write(`RTSP/1.0 200 OK\r\nCSeq: ${cseq}\r\nSession: fixture\r\n${headers}Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
   if(method==='PLAY'){playing=true;if(!burstSent){burstSent=true;for(let i=0;i<initialBurstFrames;i++)emitFrame();}}if(method==='TEARDOWN')socket.end();
  }});
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const url=`rtsp://127.0.0.1:${server.address().port}/camera`;
 return {sourceNals:nals,input:{url,container:'rtsp',inputArguments:['-analyzeduration','0','-probesize','100000','-rtsp_transport','tcp','-i',url],mediaStreamOptions:{id:'main',video:{codec:'h265',width:320,height:180,fps},audio:{codec:'aac'}}},
  get connections(){return connections;}, get videoSetups(){return videoSetups;}, get videoBytes(){return videoBytes;}, get audioSetups(){return audioSetups;},async close(){for(const s of sockets)s.destroy();await new Promise(r=>server.close(r));}};
}
module.exports={camera,ffmpeg};
