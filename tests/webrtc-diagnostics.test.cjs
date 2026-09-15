const test = require('node:test');
const assert = require('node:assert/strict');
const { environment, base, quiet } = require('./helpers.cjs');
const { rtcEnvironment } = require('./webrtc-helpers.cjs');
const plain = value => JSON.parse(JSON.stringify(value));
const diagnostics = () => environment().load(base + 'hksv-webrtc-diagnostics.ts');

test('SDP summaries preserve codec/RID/ICE facts without addresses, credentials, key material or unknown values', () => {
    const { summarizeWebRTCSdp, summarizeWebRTCCandidates } = diagnostics();
    const lines = [
        'v=0', 'o=private-user 172399 1 IN IP4 198.51.100.23', 's=private-session', 't=0 0',
        'a=group:BUNDLE 0 1', 'a=ice-lite', 'a=sendrecv', 'a=ice-ufrag:private-ufrag', 'a=ice-pwd:private-password',
        'a=fingerprint:sha-256 private-fingerprint', 'a=setup:active',
        'm=video 9 UDP/TLS/RTP/SAVPF 99', 'a=mid:0', 'a=recvonly', 'a=rtcp-mux',
        'a=rtpmap:99 H265/90000', 'a=fmtp:99 profile-id=1;level-id=153;tier-flag=0;tx-mode=SRST;private=private-key',
        'a=rid:1 recv max-width=3840;max-height=2160;max-fps=30;secret=private-rid', 'a=simulcast:recv 1',
        'a=extmap:3 urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id', 'a=extmap:4 https://private-extension.invalid/private-token',
        'a=ssrc:123456789 cname:private-cname', 'a=ssrc:123456789 msid:private-msid',
        'a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:private-crypto',
        'a=candidate:private-foundation 1 udp 100 198.51.100.23 50000 typ host ufrag private-ufrag',
        'a=candidate:private-foundation 1 tcp 100 2001:db8::32 443 typ relay tcptype passive',
        'm=audio 0 UDP/TLS/RTP/SAVPF 110', 'a=mid:1', 'a=inactive', 'a=rtpmap:110 opus/48000/2',
        'a=fmtp:110 minptime=20;stereo=0',
    ];
    const summary = plain(summarizeWebRTCSdp(lines.join('\r\n') + '\r\n'));
    assert.deepEqual(summary.bundle, ['0', '1']);
    assert.equal(summary.iceLite, true);
    const [video, audio] = summary.media;
    assert.equal(video.direction, 'recvonly', 'media direction overrides the session direction');
    assert.equal(video.iceCredentials, true, 'session ICE credentials are inherited');
    assert.equal(video.dtlsSetup, 'active');
    assert.deepEqual(video.fingerprints, ['sha-256']);
    assert.deepEqual(video.codecs, [{ pt:99, codec:'h265', clock:90000, parameters:{ 'profile-id':1, 'level-id':153, 'tier-flag':0, 'tx-mode':'srst' } }]);
    assert.deepEqual(video.rids, [{ id:'1', direction:'recv', limits:{'max-width':'3840','max-height':'2160','max-fps':'30'} }]);
    assert.equal(video.ssrcCount, 1);
    assert.deepEqual(video.candidates, {count:2,groups:{'host/udp/v4':1,'relay/tcp/v6/passive':1}});
    assert.equal(audio.rejected, true);
    assert.equal(audio.direction, 'inactive');
    assert.equal(audio.codecs[0].clock, 48000);
    const output = JSON.stringify(summary);
    for (const secret of ['private-', '198.51.100.23', '2001:db8::32', '123456789', '50000']) assert.equal(output.includes(secret), false, secret);
    assert.deepEqual(plain(summarizeWebRTCCandidates([{candidate:'candidate:x 1 udp 12 private-name.local 123 typ host'}])),
        {count:1,groups:{'host/udp/vhostname':1}});
});

test('diagnostics distinguish ICE checks from DTLS and SRTP without serializing vendor objects', () => {
    const { summarizeWebRTCTransport } = diagnostics();
    const candidate = {host:'198.51.100.23',port:54321,type:'srflx',transport:'udp',ufrag:'private-ufrag'};
    const connection = {remoteCandidates:[candidate], checkList:[{state:2},{state:3},{state:4}],
        remotePassword:'private-password',remoteIsLite:true};
    const dtls = {iceTransport:{state:'checking',role:'controlling',localCandidates:[candidate],connection},
        state:'new',role:'client',srtpStarted:false,privateKey:'private-key',packetsSent:0,packetsReceived:0};
    const pc = {connectionState:'connecting',iceConnectionState:'checking',dtlsTransports:[dtls]};
    let summary = plain(summarizeWebRTCTransport(pc));
    assert.equal(summary.transports[0].dtls, 'new');
    assert.deepEqual(summary.transports[0].pairs, {frozen:0,waiting:0,checking:1,succeeded:1,failed:1});
    assert.equal(summary.transports[0].selected, undefined);
    connection.nominated = {localCandidate:candidate,remoteCandidate:candidate};
    dtls.iceTransport.state='completed';dtls.state='connecting';
    summary = plain(summarizeWebRTCTransport(pc));
    assert.equal(summary.transports[0].ice, 'completed');
    assert.equal(summary.transports[0].dtls, 'connecting');
    assert.equal(summary.transports[0].srtp, false);
    dtls.state='connected';dtls.srtpStarted=true;dtls.packetsSent=9;
    summary = plain(summarizeWebRTCTransport(pc));
    assert.equal(summary.transports[0].srtp, true);
    assert.equal(summary.transports[0].packetsSent, 9);
    for (const secret of ['private-', '198.51.100.23', '54321']) assert.equal(JSON.stringify(summary).includes(secret), false, secret);
});

test('diagnostic summaries bound unsupported or malformed SDP without exposing arbitrary content', () => {
    const { summarizeWebRTCSdp } = diagnostics();
    assert.deepEqual(plain(summarizeWebRTCSdp('x'.repeat(65537))), {invalid:true});
    assert.equal(summarizeWebRTCSdp('v=0\r\n').media.length, 0);
    const output = summarizeWebRTCSdp('v=0\nm=video 9 UDP/TLS/RTP/SAVPF 99\na=rtpmap:99 unexpected-secret/90000\na=rid:bad\na=fmtp:99 profile-id=secret\n');
    assert.equal(output.media[0].codecs[0].codec, 'unknown');
    assert.equal(output.media[0].direction, 'sendrecv');
    assert.equal(JSON.stringify(output).includes('secret'), false);
});

test('WebRTC diagnostics observe answer/close and clear the delayed snapshot without changing HAP status', async () => {
    const {Class, opts, proto} = rtcEnvironment();
    const logs=[];
    const logger={...quiet,log(message){if(message.startsWith('HomeKit WebRTC diagnostic:')) logs.push(message);}};
    const management=new Class({addService(){}},logger,opts);
    let session;
    try {
        const offer=proto.parseWebRTCSolicitOfferResponse(Buffer.from(await management.handleSolicitOffer(''),'base64'));
        session=management.sessions.get(offer.sessionId.toString('hex'));
        const response=await management.handleProvideAnswer(proto.encodeWebRTCProvideAnswer({sessionId:offer.sessionId,sdpAnswer:'v=0\r\n',additionalCandidates:[]}));
        assert.equal(proto.parseWebRTCSessionStatusResponse(response).status,0);
        assert.ok(logs.some(line=>line.includes('stage=offer ')));
        assert.ok(logs.some(line=>line.includes('stage=answer-received ')));
        assert.ok(logs.some(line=>line.includes('stage=answer-applied ')));
        assert.equal(session.diagnosticTimer.hasRef(),false);
        // A failing diagnostics sink must not prevent teardown or wipeout.
        management.console={...quiet,log(message){if(message.startsWith('HomeKit WebRTC diagnostic:')) throw Error('diagnostics sink unavailable');}};
        management.closeAllSessions();
        assert.equal(session.closed,true);
        assert.equal(session.diagnosticTimer._destroyed,true);
    } finally {management.console=quiet;management.closeAllSessions();}
});
