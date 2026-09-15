// Independent test receiver: explicit HKDF extract/expand, no production crypto.
const assert=require('node:assert/strict');
const {createHmac,createDecipheriv,timingSafeEqual}=require('node:crypto');
function hkdf(ikm,salt,info,n){
 const prk=createHmac('sha512',salt).update(ikm).digest();let prev=Buffer.alloc(0);const out=[];
 for(let i=1;Buffer.concat(out).length<n;i++){prev=createHmac('sha512',prk).update(prev).update(info).update(Buffer.from([i])).digest();out.push(prev);}
 return Buffer.concat(out).subarray(0,n);
}
function u64(n){const b=Buffer.alloc(8);b.writeBigUInt64BE(BigInt(n));return b;}
function decrypt(frame,config,ssrc,metadata=Buffer.alloc(0),suite=6){
 let offset=1;
 function field(bits){if(!(bits&8))return BigInt(bits);const n=(bits&7)+1;assert(offset+n<=frame.length);let v=0n;for(let i=0;i<n;i++)v=(v<<8n)|BigInt(frame[offset++]);return v;}
 const kid=field(frame[0]>>4),counter=field(frame[0]&15);assert.equal(kid,config.kid);
 let ikm=config.key;
 if(ssrc!==undefined){const salt=Buffer.alloc(4);salt.writeUInt32BE(ssrc);ikm=hkdf(ikm,salt,Buffer.from('SFrame 1.0 RTP Stream'),64);}
 const context=Buffer.concat([u64(kid),Buffer.from([0,suite])]);
 const key=hkdf(ikm,Buffer.alloc(0),Buffer.concat([Buffer.from('SFrame 1.0 Secret key '),context]),96);
 const nonce=hkdf(ikm,Buffer.alloc(0),Buffer.concat([Buffer.from('SFrame 1.0 Secret salt '),context]),12);
 const ctr=u64(counter);for(let i=0;i<8;i++)nonce[i+4]^=ctr[i];
 const nt=suite===6?10:suite===7?8:4,header=frame.subarray(0,offset),ciphertext=frame.subarray(offset,-nt),tag=frame.subarray(-nt);
 const expected=createHmac('sha512',key.subarray(32)).update(Buffer.concat([u64(header.length+metadata.length),u64(ciphertext.length),u64(nt),nonce,header,metadata,ciphertext])).digest().subarray(0,nt);
 assert(timingSafeEqual(tag,expected),'SFrame authentication failed');
 const cipher=createDecipheriv('aes-256-ctr',key.subarray(0,32),Buffer.concat([nonce,Buffer.alloc(4)]));
 return {counter,plaintext:Buffer.concat([cipher.update(ciphertext),cipher.final()])};
}
class Receiver {
 constructor(config,suite=6){this.config=config;this.suite=suite;this.parts=undefined;this.counter=undefined;}
 push(packet){
  const p=packet.payload,h=packet.header;
  assert.equal(p[0]&63,0);assert(p.length>1);
  if(p[0]&128){this.parts=[];this.ssrc=h.ssrc;this.timestamp=h.timestamp;}
  if(!this.parts)return;
  assert.equal(h.ssrc,this.ssrc);assert.equal(h.timestamp,this.timestamp);
  this.parts.push(p.subarray(1));if(!(p[0]&64))return;
  const result=decrypt(Buffer.concat(this.parts),this.config,h.ssrc,Buffer.alloc(0),this.suite);this.parts=undefined;
  assert(this.counter===undefined||result.counter>this.counter,'SFrame counter must increase');this.counter=result.counter;
  return result.plaintext;
 }
}
function nals(frame){const out=[];for(let o=0;o<frame.length;){assert(o+4<=frame.length);const n=frame.readUInt32BE(o);o+=4;assert(n>=2&&o+n<=frame.length);out.push(frame.subarray(o,o+n));o+=n;}return out;}
module.exports={decrypt,Receiver,nals};
