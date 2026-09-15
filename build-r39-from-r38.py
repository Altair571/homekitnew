#!/usr/bin/env python3
"""Build r39 from the tested r38 ZIP: the WebRTC offer shape that plays through Apple's relay in HAP-NodeJS PR 1132."""
import importlib.util
import json
import re
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('r35builder', ROOT / 'build-r35-from-r34.py')
b = importlib.util.module_from_spec(spec); spec.loader.exec_module(b)
BASE_SHA = '08c4e8157475701043f77062fdda651d367f8a5bebfaadabed9cad51e7181265'
OLD_BUILD = 'hevc-fixes-2026-09-15-r38'
BUILD = 'hevc-fixes-2026-09-16-r39'


def base_archive():
    for path in (ROOT / 'plugin-hevc-webrtc-r38.zip', Path.home() / 'Desktop' / 'plugin-hevc-webrtc-r38.zip'):
        if path.is_file() and b.digest(path.read_bytes()) == BASE_SHA:
            return path
    raise SystemExit('The checksum-locked r38 ZIP was not found.')


SECURE_VIDEO_OFFER = '''/** r39: the offer shape that plays remotely through Apple's relay in HAP-NodeJS PR 1132
 * (camera.ui). The relay turns the offer into the viewer's media blob; a video stream without
 * a bitrate reaches the viewer as "no valid streams". The RID is declared for the relay's
 * parser only: no RTP header extension is negotiated, so packets carry none and the relay
 * maps them by SSRC. SFrame stays signaled through the HomeKit characteristic alone.
 */
const RTP_STREAM_ID_URI = 'urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id';

/** Apple's recommended peak for a tier's average bitrate (camera.ui advertises the peak). */
export function peakBitrateKbps(averageBitrateKbps: number): number {
    const match = Object.values(RECOMMENDED_BITRATES_KBPS).find(rate => rate.average === averageBitrateKbps);
    return match ? match.maximum : Math.ceil(averageBitrateKbps * 1.06);
}

export function withSecureVideoOffer(sdp: string, limits: VideoRidLimits, peakKbps: number): string {
    const lines = sdp.split(/\\r?\\n/);
    const start = lines.findIndex(line => line.startsWith('m=video '));
    if (start < 0) return sdp;
    let end = lines.findIndex((line, index) => index > start && line.startsWith('m='));
    if (end < 0) end = lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
    if (lines.slice(start, end).some(line => line.startsWith('a=rid:') || line.startsWith('b=AS:'))) return sdp;
    const bitrate = Math.round(peakKbps * 1000);
    const used = new Set(lines.map(line => Number(/^a=extmap:(\\d+)/.exec(line)?.[1])).filter(Number.isInteger));
    let id = 1;
    while (used.has(id) && id < 14) id++;
    lines.splice(end, 0, 'a=extmap:' + id + ' ' + RTP_STREAM_ID_URI,
        'a=rid:' + VIDEO_RID + ' send max-width=' + limits.width + ';max-height=' + limits.height + ';max-fps=' + limits.frameRate + ';max-br=' + bitrate,
        'a=simulcast:send ' + VIDEO_RID);
    const connection = lines.findIndex((line, index) => index > start && index < end && line.startsWith('c='));
    lines.splice(connection < 0 ? start + 1 : connection + 1, 0, 'b=AS:' + Math.round(peakKbps), 'b=TIAS:' + bitrate);
    return lines.join('\\r\\n');
}

const webrtcHevcCodec = new RTCRtpCodecParameters({'''


def edit_camera(s):
    once = b.once
    s = once(s, "import { CameraVideoQuality, VideoStreamTier } from './hksv-stream-tiers';",
             "import { CameraVideoQuality, RECOMMENDED_BITRATES_KBPS, VideoStreamTier } from './hksv-stream-tiers';")
    s = once(s, "    relayVariants?: readonly RelayVariant[];\n}\n\ninterface HapWebRTCSession {",
             "    relayVariants?: readonly RelayVariant[];\n"
             "    /** r39: offer the shape that plays through Apple's relay in HAP-NodeJS PR 1132 (camera.ui). */\n"
             "    secureVideoOffer?: boolean;\n}\n\ninterface HapWebRTCSession {")
    s = once(s, "const webrtcHevcCodec = new RTCRtpCodecParameters({", SECURE_VIDEO_OFFER)
    s = once(s, "        const pc = new RTCPeerConnection({\n"
                "            codecs: {\n"
                "                video: [webrtcHevcCodec],\n"
                "                audio: [webrtcAudioCodec],\n"
                "            },\n"
                "            headerExtensions: {\n"
                "                video: [useSdesMid(), useSdesRTPStreamId(), frameMarkingExtension()],\n"
                "                audio: [useSdesMid()],\n"
                "            },\n"
                "        });",
             "        const secureVideoOffer = !!this.opts.secureVideoOffer;\n"
             "        const pc = new RTCPeerConnection({\n"
             "            codecs: {\n"
             "                video: [webrtcHevcCodec],\n"
             "                audio: [webrtcAudioCodec],\n"
             "            },\n"
             "            // r39: like camera.ui, negotiate no RTP header extensions and gather IPv4 only.\n"
             "            headerExtensions: secureVideoOffer ? { video: [], audio: [] } : {\n"
             "                video: [useSdesMid(), useSdesRTPStreamId(), frameMarkingExtension()],\n"
             "                audio: [useSdesMid()],\n"
             "            },\n"
             "            ...(secureVideoOffer ? { iceUseIpv6: false } : {}),\n"
             "        });")
    s = once(s, "        const videoTransceiver = pc.addTransceiver(vtrack, {\n"
                "            direction: 'sendonly', simulcast: [{ rid: VIDEO_RID, direction: 'send' }],\n"
                "        });",
             "        const videoTransceiver = pc.addTransceiver(vtrack, secureVideoOffer ? { direction: 'sendonly' } : {\n"
             "            direction: 'sendonly', simulcast: [{ rid: VIDEO_RID, direction: 'send' }],\n"
             "        });")
    s = once(s, "            const sdp = withRelaySdpVariant(withSFramePacketization(withExplicitVideoRidPayload(pc.localDescription?.sdp ?? offer.sdp, this.offeredVideoRidLimits()), !!session.sframeConfiguration),\n"
                "                session.relayVariant, { videoSsrc: videoTransceiver.sender.ssrc, audioSsrc: audioTransceiver.sender.ssrc, videoRid: session.videoRid }, VIDEO_RID);",
             "            const sdp = secureVideoOffer\n"
             "                ? withSecureVideoOffer(pc.localDescription?.sdp ?? offer.sdp, this.offeredVideoRidLimits(),\n"
             "                    peakBitrateKbps(this.offeredVideoTier()?.averageBitrateKbps ?? 180))\n"
             "                : withRelaySdpVariant(withSFramePacketization(withExplicitVideoRidPayload(pc.localDescription?.sdp ?? offer.sdp, this.offeredVideoRidLimits()), !!session.sframeConfiguration),\n"
             "                    session.relayVariant, { videoSsrc: videoTransceiver.sender.ssrc, audioSsrc: audioTransceiver.sender.ssrc, videoRid: session.videoRid }, VIDEO_RID);")
    s = once(s, "video RID=${session.videoRid}, outgoing SFrame=",
             "video RID=${session.videoRid}${secureVideoOffer ? ' (secure video offer)' : ''}, outgoing SFrame=")
    s = once(s, "            // The sender emits it only if the RID extension was negotiated.\n"
                "            session.videoTransceiver.sender.rtpStreamId = session.videoRid;",
             "            // The sender emits it only if the RID extension was negotiated.\n"
             "            // r39: the secure video offer negotiates no extension, so packets carry no RID.\n"
             "            if (!this.opts.secureVideoOffer) session.videoTransceiver.sender.rtpStreamId = session.videoRid;")
    s = once(s, "            await session.pc.setRemoteDescription({ type: 'offer', sdp: parsed.sdpOffer } as any);\n"
                "            session.videoTransceiver.sender.rtpStreamId = session.videoRid;",
             "            await session.pc.setRemoteDescription({ type: 'offer', sdp: parsed.sdpOffer } as any);\n"
             "            if (!this.opts.secureVideoOffer) session.videoTransceiver.sender.rtpStreamId = session.videoRid;")
    s = once(s, "            const sdpAnswer = withRelaySdpVariant(withSFramePacketization(withExplicitVideoRidPayload(withExplicitVideoRidPayload((session.pc.localDescription as any)?.sdp ?? (answer as any).sdp,\n"
                "                answerLimits), answerLimits, session.videoRid), !!session.sframeConfiguration),\n"
                "                session.relayVariant, { videoSsrc: session.videoTransceiver.sender.ssrc, audioSsrc: session.audioTransceiver.sender.ssrc, videoRid: session.videoRid }, VIDEO_RID);",
             "            const localAnswer = (session.pc.localDescription as any)?.sdp ?? (answer as any).sdp;\n"
             "            // r39: like camera.ui, answer a relay reoffer with werift's description unchanged.\n"
             "            const sdpAnswer = this.opts.secureVideoOffer ? localAnswer\n"
             "                : withRelaySdpVariant(withSFramePacketization(withExplicitVideoRidPayload(withExplicitVideoRidPayload(localAnswer,\n"
             "                    answerLimits), answerLimits, session.videoRid), !!session.sframeConfiguration),\n"
             "                    session.relayVariant, { videoSsrc: session.videoTransceiver.sender.ssrc, audioSsrc: session.audioTransceiver.sender.ssrc, videoRid: session.videoRid }, VIDEO_RID);")
    return s


def edit_hksv27_source(s):
    s = b.once(s, "import { R38_RELAY_VARIANTS } from './hksv-relay-publish';\n", "")
    return b.once(s, "                relayVariants: R38_RELAY_VARIANTS,",
                  "                // r39: the offer shape that plays through Apple's relay in HAP-NodeJS PR 1132.\n"
                  "                secureVideoOffer: true,")


def edit_hksv27_block(block):
    block = b.once(block, '\nconst hksv_relay_publish_1 = require("./hksv-relay-publish");', '')
    return b.once(block, 'relayVariants: hksv_relay_publish_1.R38_RELAY_VARIANTS,', 'secureVideoOffer: true,')


def main():
    archive = base_archive()
    with zipfile.ZipFile(archive) as z:
        assert z.testzip() is None
        entries = {i.filename: (i, z.read(i)) for i in z.infolist()}
    original = entries['main.nodejs.js'][1].decode()
    old = json.loads(entries['build-manifest.json'][1])
    assert old['buildId'] == OLD_BUILD and b.digest(original.encode()) == old['bundleSha256']
    before = b.modules(original)
    smap = json.loads(entries['main.nodejs.js.map'][1])
    out = ROOT / 'dist-r39'; out.mkdir(exist_ok=True)

    def source_index(name):
        matches = [i for i, n in enumerate(smap['sources']) if n.endswith('/' + name)]
        assert len(matches) == 1, (name, matches)
        return matches[0]

    name = 'camera-webrtc.ts'; index = source_index(name)
    source = edit_camera(smap['sourcesContent'][index])
    block = before[b.PREFIX + name]
    deps = json.loads(re.search(r'const dependencies = (\{.*?\});', block)[1])
    output = b.once(original, block, b.compile_module(name, source, deps))
    smap['sourcesContent'][index] = source
    (out / name).write_text(source)

    name = 'camera-hksv27.ts'; index = source_index(name)
    source = edit_hksv27_source(smap['sourcesContent'][index])
    block = before[b.PREFIX + name]
    output = b.once(output, block, edit_hksv27_block(block))
    smap['sourcesContent'][index] = source
    (out / name).write_text(source)

    assert output.count(OLD_BUILD) == 2
    output = output.replace(OLD_BUILD, BUILD)
    smap['sourcesContent'] = [c.replace(OLD_BUILD, BUILD) if c else c for c in smap['sourcesContent']]
    after = b.modules(output)
    changed = [n for n in before if before[n] != after[n]]
    assert set(changed) == {b.PREFIX + n for n in ['camera-webrtc.ts', 'camera-hksv27.ts', 'camera-stream-diagnostics.ts']}, changed
    assert set(after) == set(before)
    sha = b.digest(output.encode())
    manifest = {'buildId': BUILD, 'baseBuildId': OLD_BUILD, 'previousArchiveSha256': BASE_SHA,
        'originalArchiveSha256': old['originalArchiveSha256'], 'bundleSha256': sha,
        'editedModules': changed, 'addedModules': [],
        'change': 'Adopt the WebRTC offer shape that plays remotely through Apple\'s relay in HAP-NodeJS PR 1132 (camera.ui): '
                  'video bitrate as b=AS/b=TIAS and max-br in the RID line, no RTP header extensions (RID declared in SDP only), '
                  'no pt restriction, no a=sframe lines, IPv4 ICE. The r37/r38 relay experiments are off.',
        'reference': 'https://github.com/homebridge/HAP-NodeJS/pull/1132 and cameraui/plugins camera-ui-homekit/src/camera/webrtcSessions.ts',
        'limitations': ['Whether this offer plays through Apple\'s relay for Front requires a live remote test.',
            'The new offer applies to every WebRTC session, including LAN viewing.',
            'The legacy RTP service stays on the accessory; PR 1132 uses one service family per accessory.',
            'SFrame, frame layout, packetization and the 360p remote tier are unchanged; they already match camera.ui.',
            'Source map offsets are inherited; sourcesContent and dist-r39 contain the exact edited sources.']}
    if '--package' in sys.argv:
        v = json.loads((ROOT / 'diagnostics/r39-tests.json').read_text())
        log = (ROOT / 'diagnostics/r39-tests.log').read_bytes()
        assert v['bundleSha256'] == sha and v['returnCode'] == 0 and v['logSha256'] == b.digest(log)
        total, passed = re.search(rb'tests (\d+)\b', log), re.search(rb'pass (\d+)\b', log)
        assert total and passed and total[1] == passed[1] and int(total[1]) >= 224
        assert re.search(rb'fail 0\b', log) and re.search(rb'skipped 0\b', log)
        manifest['validationChecks'] = int(total[1])
    (out / 'main.nodejs.js').write_text(output)
    (out / 'main.nodejs.js.map').write_text(json.dumps(smap, separators=(',', ':')))
    (out / 'build-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    if '--package' in sys.argv:
        replacements = {n: (out / n).read_bytes() for n in ['main.nodejs.js', 'main.nodejs.js.map', 'build-manifest.json']}
        replacements['HEVC-TESTING.md'] = (ROOT / 'R39-TESTING.md').read_bytes()
        target = ROOT / 'plugin-hevc-webrtc-r39.zip'
        with zipfile.ZipFile(target, 'w') as z:
            for name, (info, data) in entries.items(): z.writestr(info, replacements.get(name, data))
        with zipfile.ZipFile(target) as z: assert z.testzip() is None and z.read('main.nodejs.js') == output.encode()
        result = {'archive': str(target), 'sha256': b.digest(target.read_bytes()), **manifest}
        (ROOT / 'diagnostics/r39-build.json').write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps(result, indent=2))
    else: print(json.dumps({'prepared': BUILD, 'bundleSha256': sha, 'editedModules': changed}))


if __name__ == '__main__': main()
