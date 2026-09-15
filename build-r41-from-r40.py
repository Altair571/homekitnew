#!/usr/bin/env python3
"""Build r41 from the tested r40 ZIP: faster remote WebRTC startup and an opt-in 1080p remote resolution."""
import importlib.util
import json
import re
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('r35builder', ROOT / 'build-r35-from-r34.py')
b = importlib.util.module_from_spec(spec); spec.loader.exec_module(b)
BASE_SHA = 'db4181d3caf06568149260dc593d64d844611ecf62fb66f281e7eb70fda7eda9'
OLD_BUILD = 'hevc-fixes-2026-09-16-r40'
BUILD = 'hevc-fixes-2026-09-16-r41'
FORWARDER = '../webrtc/src/rtp-forwarders.ts'
MIXIN = './src/camera-mixin.ts'


def base_archive():
    for path in (ROOT / 'plugin-hevc-webrtc-r40.zip', Path.home() / 'Desktop' / 'plugin-hevc-webrtc-r40.zip'):
        if path.is_file() and b.digest(path.read_bytes()) == BASE_SHA:
            return path
    raise SystemExit('The checksum-locked r40 ZIP was not found.')


KEYFRAME_SCHEDULE = '''/** r41: keyframe schedule for viewers that join after the stream has started. */
export interface KeyframeSchedule {
    /** Regular keyframe interval in seconds. */
    gopSeconds: number;
    /** Force an IDR this often during the first startupSeconds. */
    startupIntervalSeconds: number;
    startupSeconds: number;
}

export function videoEncoderArguments(codec: CameraVideoCodec, width: number, height: number, fps: number, bitrateKbps: number, keyframes?: KeyframeSchedule): string[] {
    const bitrate = Math.max(64, Math.round(bitrateKbps)) * 1000;
    const gop = Math.max(1, Math.round(fps * (keyframes?.gopSeconds ?? 2)));
'''


def edit_media(s):
    s = b.once(s, "export function videoEncoderArguments(codec: CameraVideoCodec, width: number, height: number, fps: number, bitrateKbps: number): string[] {\n"
                  "    const bitrate = Math.max(64, Math.round(bitrateKbps)) * 1000;\n"
                  "    const gop = Math.max(1, Math.round(fps * 2));\n", KEYFRAME_SCHEDULE)
    return b.once(s, "        '-bf', '0', '-g', String(gop), '-keyint_min', String(gop),\n",
                  "        '-bf', '0', '-g', String(gop), '-keyint_min', String(gop),\n"
                  "        ...(keyframes ? ['-forced-idr', '1', '-force_key_frames', `expr:lte(t,${keyframes.startupSeconds})*gte(t,n_forced*${keyframes.startupIntervalSeconds})`] : []),\n")


STARTUP_LOG = '''    /** r41: one line to compare startup latency between builds and networks. */
    private logStartup(session: HapWebRTCSession): void {
        try {
            if (session.startupLogged) return;
            session.startupLogged = true;
            const probe: any = session.probe?.snapshot();
            const since = (time?: number) => time === undefined ? undefined : time - session.createdAt;
            const at = (ms?: number) => typeof ms === 'number' && Number.isFinite(ms) ? `${Math.round(ms)} ms` : 'not yet';
            this.console.log(`HomeKit WebRTC startup: session ${session.sessionId.toString('hex').slice(0, 8)}…, answer ${at(since(session.answeredAt))}, `
                + `connected ${at(since(session.connectedAt))}, first video ${at(probe?.video?.firstInputAtMs)}, first keyframe ${at(probe?.video?.firstIrapAtMs)}, `
                + `relay video ack ${at(probe?.video?.firstReportAtMs)}, first audio ${at(probe?.audio?.firstInputAtMs)}, keyframes sent ${probe?.video?.sourceIrapFrames ?? 0}`);
        }
        catch (_) { }
    }

    private assertReceiveInactive(session: HapWebRTCSession): void {
'''


def edit_camera(s):
    once = b.once
    s = once(s, "const REMOTE_OPUS_PACKET_LOSS_PERCENT = 15;\n",
             "const REMOTE_OPUS_PACKET_LOSS_PERCENT = 15;\n"
             "/** r41: remote viewers join after the first IDR. Force one every 0.5 s for 4 s, then send one every second. */\n"
             "const REMOTE_KEYFRAMES = { gopSeconds: 1, startupIntervalSeconds: 0.5, startupSeconds: 4 };\n"
             "const REMOTE_RESOLUTION_KEY = 'hksv27WebRTCRemoteResolution';\n\n"
             "/** r41: the offer carries one tier. 1080p is opt-in because cellular viewers may refuse it. */\n"
             "export function offeredResolution(setting?: string | null): '360p' | '1080p' {\n"
             "    return (setting ?? '').trim().startsWith('1080p') ? '1080p' : '360p';\n"
             "}\n")
    s = once(s, "    /** r40: the negotiation the running media was started for. */\n    mediaSignature?: string;\n",
             "    /** r40: the negotiation the running media was started for. */\n    mediaSignature?: string;\n"
             "    /** r41: startup milestones for the timing summary. */\n"
             "    answeredAt?: number;\n    connectedAt?: number;\n    startupLogged?: boolean;\n")
    s = once(s, "            if (state === 'connected')\n"
                "                this.startMedia(session).catch(e => { this.console.error('WebRTC media start failed', e); this.closeSession(sessionHex); });\n"
                "            else if (state === 'failed' || state === 'closed' || state === 'disconnected')\n",
             "            if (state === 'connected') {\n"
             "                session.connectedAt ??= Date.now();\n"
             "                this.startMedia(session).catch(e => { this.console.error('WebRTC media start failed', e); this.closeSession(sessionHex); });\n"
             "            }\n"
             "            else if (state === 'failed' || state === 'closed' || state === 'disconnected')\n")
    s = once(s, "            session.answered = true;\n            // Keep the setup timeout until a connection actually carries media.\n",
             "            session.answered = true;\n            session.answeredAt ??= Date.now();\n"
             "            // Keep the setup timeout until a connection actually carries media.\n")
    s = once(s, "                if (!session.closed) this.logDiagnostics(session, 'answer-after-5s');\n",
             "                if (!session.closed) this.logDiagnostics(session, 'answer-after-5s');\n"
             "                if (!session.closed) this.logStartup(session);\n")
    s = once(s, "    private assertReceiveInactive(session: HapWebRTCSession): void {\n", STARTUP_LOG)
    s = once(s, "        return lowest;\n    }\n\n    private offeredVideoRidLimits(): VideoRidLimits {\n",
             "        // r41: an explicit 1080p setting offers the camera's medium tier instead.\n"
             "        if (offeredResolution(this.storage?.getItem(REMOTE_RESOLUTION_KEY)) === '1080p')\n"
             "            return this.opts.videoTiers.find(tier => tier.quality === CameraVideoQuality.MEDIUM) ?? lowest;\n"
             "        return lowest;\n    }\n\n    private offeredVideoRidLimits(): VideoRidLimits {\n")
    s = once(s, "            const decision = videoCopyDecision(input, selection.codec, selection.tier, { allowLowerFrameRate: selection.remote });\n",
             "            const nativeDecision = videoCopyDecision(input, selection.codec, selection.tier, { allowLowerFrameRate: selection.remote });\n"
             "            // r41: remote viewers need a bounded bitrate and frequent keyframes, so the camera stream is never passed through.\n"
             "            const decision = selection.remote && nativeDecision.copy\n"
             "                ? { copy: false, reason: `remote viewers get a controlled bitrate and keyframe schedule (source matched: ${nativeDecision.reason})` }\n"
             "                : nativeDecision;\n")
    s = once(s, "                            selection.tier.frameRate, selection.tier.averageBitrateKbps))],\n",
             "                            selection.tier.frameRate, selection.tier.averageBitrateKbps, selection.remote ? REMOTE_KEYFRAMES : undefined))],\n")
    return once(s, "${REMOTE_SLICE_BYTES}-byte slices, Opus FEC`",
                "${REMOTE_SLICE_BYTES}-byte slices, Opus FEC, keyframes every ${REMOTE_KEYFRAMES.startupIntervalSeconds} s for "
                "${REMOTE_KEYFRAMES.startupSeconds} s then every ${REMOTE_KEYFRAMES.gopSeconds} s`")


FORWARDER_OLD = "                                            '-hide_banner',\n                                            '-f', 'aac',\n"
FORWARDER_SOURCE = ("                                            '-hide_banner',\n"
                    "                                            // r41: the ADTS frames are already parsed; default probing delayed audio by about 3 s.\n"
                    "                                            '-analyzeduration', '0', '-probesize', '512',\n"
                    "                                            '-f', 'aac',\n")
FORWARDER_BLOCK = ("                                            '-hide_banner',\n"
                   "                                            '-analyzeduration', '0', '-probesize', '512',\n"
                   "                                            '-f', 'aac',\n")
MIXIN_ANCHOR = "        hksv27WebRTCPathMode: {\n            title: 'Experimental: WebRTC Path Detection',\n"
MIXIN_SETTING = ("        hksv27WebRTCRemoteResolution: {\n"
                 "            title: 'Experimental: WebRTC Remote Resolution (r41)',\n"
                 "            type: 'string',\n"
                 "            choices: ['360p (default)', '1080p (experimental)'],\n"
                 "            defaultValue: '360p (default)',\n"
                 "            description: 'Resolution offered to iOS 27 WebRTC viewers. 360p is known to work over cellular. 1080p sends the camera\\'s "
                 "medium tier (1080p at 30 fps, about 1.7 Mbps on 4K cameras); Apple may refuse it for cellular viewers, so try it on remote Wi-Fi first. "
                 "Takes effect on the next live view.',\n"
                 "        },\n")


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
    out = ROOT / 'dist-r41'; out.mkdir(exist_ok=True)

    def source_index(suffix):
        matches = [i for i, n in enumerate(smap['sources']) if n.endswith(suffix)]
        assert len(matches) == 1, (suffix, matches)
        return matches[0]

    output = original
    for name, edit in (('camera-webrtc.ts', edit_camera), ('hksv-media.ts', edit_media)):
        index = source_index('/' + name)
        source = edit(smap['sourcesContent'][index])
        block = before[b.PREFIX + name]
        deps = json.loads(re.search(r'const dependencies = (\{.*?\});', block)[1])
        output = b.once(output, block, b.compile_module(name, source, deps))
        smap['sourcesContent'][index] = source
        (out / name).write_text(source)

    # Text edits keep these modules' existing compiled form; sourcesContent records the same change.
    index = source_index('/webrtc/src/rtp-forwarders.ts')
    smap['sourcesContent'][index] = b.once(smap['sourcesContent'][index], FORWARDER_OLD, FORWARDER_SOURCE)
    output = b.once(output, before[FORWARDER], b.once(before[FORWARDER], FORWARDER_OLD, FORWARDER_BLOCK))
    (out / 'rtp-forwarders.ts').write_text(smap['sourcesContent'][index])

    index = source_index('/src/camera-mixin.ts')
    smap['sourcesContent'][index] = b.once(smap['sourcesContent'][index], MIXIN_ANCHOR, MIXIN_SETTING + MIXIN_ANCHOR)
    output = b.once(output, before[MIXIN], b.once(before[MIXIN], MIXIN_ANCHOR, MIXIN_SETTING + MIXIN_ANCHOR))
    (out / 'camera-mixin.ts').write_text(smap['sourcesContent'][index])

    assert output.count(OLD_BUILD) == 2
    output = output.replace(OLD_BUILD, BUILD)
    smap['sourcesContent'] = [c.replace(OLD_BUILD, BUILD) if c else c for c in smap['sourcesContent']]
    after = b.modules(output)
    changed = [n for n in before if before[n] != after[n]]
    expected = {b.PREFIX + n for n in ['camera-webrtc.ts', 'hksv-media.ts', 'camera-stream-diagnostics.ts', 'camera-hksv27.ts']} | {FORWARDER, MIXIN}
    assert set(changed) == expected, changed
    # camera-hksv27 carries the build label only.
    assert after[b.PREFIX + 'camera-hksv27.ts'] == before[b.PREFIX + 'camera-hksv27.ts'].replace(OLD_BUILD, BUILD)
    assert set(after) == set(before)
    sha = b.digest(output.encode())
    manifest = {'buildId': BUILD, 'baseBuildId': OLD_BUILD, 'previousArchiveSha256': BASE_SHA,
        'originalArchiveSha256': old['originalArchiveSha256'], 'bundleSha256': sha,
        'editedModules': changed, 'addedModules': [],
        'change': 'Faster remote WebRTC startup and an opt-in 1080p remote resolution. Remote sessions always re-encode with an IDR '
                  'every 0.5 s for the first 4 s and then every second (was every 2 s), so a viewer that joins late waits at most half a '
                  'second for a picture. The ADTS audio transcoder no longer probes its input (audio started about 3 s after video). '
                  'A one-line startup timing summary is logged 5 s after the answer. New setting "Experimental: WebRTC Remote Resolution '
                  '(r41)": 360p by default; 1080p offers the camera\'s medium tier.',
        'evidence': 'r40 field log 2026-09-16 05:51 NZST: video 1.46 s and audio 3.8 s after the solicited offer, 2 s keyframe interval. '
                    'Local FFmpeg 6.0: default ADTS probing took 3.1 s to the first Opus packet and 16-318 ms without probing; the '
                    'forced-IDR schedule produced IDRs at 0, 0.53, 1.0 ... 4.0 s and then every second.',
        'limitations': ['Whether 1080p reaches cellular viewers is untested; Apple may cap camera quality on cellular.',
            'The Apple TV sometimes ends the first WebRTC session within a second and starts another; that delay is outside the plugin.',
            'Earlier keyframes cost about a third more bitrate during the first 2 seconds of a remote stream.',
            'The audio probe change applies to every ADTS audio path in the plugin.',
            'Source map offsets are inherited; sourcesContent and dist-r41 contain the exact edited sources.']}
    if '--package' in sys.argv:
        v = json.loads((ROOT / 'diagnostics/r41-tests.json').read_text())
        log = (ROOT / 'diagnostics/r41-tests.log').read_bytes()
        assert v['bundleSha256'] == sha and v['returnCode'] == 0 and v['logSha256'] == b.digest(log)
        total, passed = re.search(rb'tests (\d+)\b', log), re.search(rb'pass (\d+)\b', log)
        assert total and passed and total[1] == passed[1] and int(total[1]) >= 237
        assert re.search(rb'fail 0\b', log) and re.search(rb'skipped 0\b', log)
        manifest['validationChecks'] = int(total[1])
    (out / 'main.nodejs.js').write_text(output)
    (out / 'main.nodejs.js.map').write_text(json.dumps(smap, separators=(',', ':')))
    (out / 'build-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    if '--package' in sys.argv:
        replacements = {n: (out / n).read_bytes() for n in ['main.nodejs.js', 'main.nodejs.js.map', 'build-manifest.json']}
        replacements['HEVC-TESTING.md'] = (ROOT / 'R41-TESTING.md').read_bytes()
        target = ROOT / 'plugin-hevc-webrtc-r41.zip'
        with zipfile.ZipFile(target, 'w') as z:
            for name, (info, data) in entries.items(): z.writestr(info, replacements.get(name, data))
        with zipfile.ZipFile(target) as z: assert z.testzip() is None and z.read('main.nodejs.js') == output.encode()
        result = {'archive': str(target), 'sha256': b.digest(target.read_bytes()), **manifest}
        (ROOT / 'diagnostics/r41-build.json').write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps(result, indent=2))
    else: print(json.dumps({'prepared': BUILD, 'bundleSha256': sha, 'editedModules': changed}))


if __name__ == '__main__': main()
