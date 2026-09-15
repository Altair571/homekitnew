#!/usr/bin/env python3
"""Build r40 from the tested r39 ZIP: keep Front's WebRTC session through the relay's talkback reoffer."""
import importlib.util
import json
import re
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('r35builder', ROOT / 'build-r35-from-r34.py')
b = importlib.util.module_from_spec(spec); spec.loader.exec_module(b)
BASE_SHA = 'f8f951cc08efc616624a57b8720adb27eb4f0cb35f0c429d7eb912f458401270'
OLD_BUILD = 'hevc-fixes-2026-09-16-r39'
BUILD = 'hevc-fixes-2026-09-16-r40'


def base_archive():
    for path in (ROOT / 'plugin-hevc-webrtc-r39.zip', Path.home() / 'Desktop' / 'plugin-hevc-webrtc-r39.zip'):
        if path.is_file() and b.digest(path.read_bytes()) == BASE_SHA:
            return path
    raise SystemExit('The checksum-locked r39 ZIP was not found.')


RECEIVE_POLICY = '''    private assertReceiveInactive(session: HapWebRTCSession): void {
        // Key provisioning does not enable talkback or a receive transceiver.
        // Inspect every transceiver: a reoffer can introduce additional m-lines.
        for (const transceiver of session.pc.getTransceivers()) {
            // r40: Apple's relay reoffers a talkback section (viewer to camera). It may add an audio
            // receiver that is never played; the camera's own video and audio stay send-only.
            const allowed = this.isRelayTalkback(session, transceiver) ? ['recvonly', 'inactive'] : ['sendonly', 'inactive'];
            if (!allowed.includes(transceiver.direction)
                || (transceiver.currentDirection && !allowed.includes(transceiver.currentDirection)))
                throw new Error('WebRTC receiving media is not supported by this send-only session');
        }
    }

    private isRelayTalkback(session: HapWebRTCSession, transceiver: any): boolean {
        return !!this.opts.acceptRelayTalkback && transceiver.kind === 'audio'
            && transceiver !== session.videoTransceiver && transceiver !== session.audioTransceiver;
    }

    private talkbackReceivers(session: HapWebRTCSession): number {
        return session.pc.getTransceivers().filter((transceiver: any) => this.isRelayTalkback(session, transceiver)
            && transceiver.direction === 'recvonly').length;
    }

    /** r40: what the running media was started for; a reoffer that leaves it unchanged needs no restart. */
    private mediaSignature(session: HapWebRTCSession, selection: HksvMediaSelection): string {
        const { tier } = selection;
        return JSON.stringify([selection.codec, selection.remote, tier.width, tier.height, tier.frameRate, tier.averageBitrateKbps,
            session.videoTransceiver.sender.codec?.payloadType, session.audioTransceiver.sender.codec?.payloadType,
            session.videoTransceiver.sender.ssrc, session.audioTransceiver.sender.ssrc]);
    }
'''


def edit_camera(s):
    once = b.once
    s = once(s, "    /** r39: offer the shape that plays through Apple's relay in HAP-NodeJS PR 1132 (camera.ui). */\n"
                "    secureVideoOffer?: boolean;\n}\n",
             "    /** r39: offer the shape that plays through Apple's relay in HAP-NodeJS PR 1132 (camera.ui). */\n"
             "    secureVideoOffer?: boolean;\n"
             "    /** r40: answer the relay reoffer that adds a talkback audio section instead of closing the session.\n"
             "     * The added receiver is never played; the camera's own video and audio stay send-only. */\n"
             "    acceptRelayTalkback?: boolean;\n}\n")
    s = once(s, "    contract?: ReturnType<typeof observeWebRTCContract>;\n    createdAt: number;\n}\n",
             "    contract?: ReturnType<typeof observeWebRTCContract>;\n    createdAt: number;\n"
             "    /** r40: the negotiation the running media was started for. */\n"
             "    mediaSignature?: string;\n}\n")
    s = once(s, "    private assertReceiveInactive(session: HapWebRTCSession): void {\n"
                "        // Key provisioning does not enable talkback or a receive transceiver.\n"
                "        // Inspect every transceiver: a reoffer can introduce additional m-lines.\n"
                "        for (const transceiver of session.pc.getTransceivers()) {\n"
                "            if (!['sendonly', 'inactive'].includes(transceiver.direction)\n"
                "                || (transceiver.currentDirection && !['sendonly', 'inactive'].includes(transceiver.currentDirection)))\n"
                "                throw new Error('WebRTC receiving media is not supported by this send-only session');\n"
                "        }\n"
                "    }\n", RECEIVE_POLICY)
    s = once(s, "            const selection = this.mediaSelection(session);\n            const path = session.path!;\n",
             "            const selection = this.mediaSelection(session);\n"
             "            session.mediaSignature = this.mediaSignature(session, selection);\n"
             "            const path = session.path!;\n")
    s = once(s, "    private stopMedia(session: HapWebRTCSession): void {\n        ++session.mediaGeneration;\n        session.starting = false;\n",
             "    private stopMedia(session: HapWebRTCSession): void {\n        ++session.mediaGeneration;\n        session.starting = false;\n"
             "        session.mediaSignature = undefined;\n")
    s = once(s, "        try {\n            this.stopMedia(session);\n            session.answered = false;\n"
                "            session.contract?.setRemote(parsed.sdpOffer, 'offer');\n",
             "        try {\n"
             "            // r40: a reoffer that leaves the send media unchanged (Apple's relay adds talkback) keeps\n"
             "            // the running FFmpeg processes; restarting them froze the viewer and delayed audio.\n"
             "            const keepMedia = !!this.opts.acceptRelayTalkback;\n"
             "            if (!keepMedia) this.stopMedia(session);\n"
             "            session.answered = false;\n"
             "            session.contract?.setRemote(parsed.sdpOffer, 'offer');\n")
    s = once(s, "            this.mediaSelection(session);\n            session.answered = true;\n"
                "            const answerLimits = { ...this.offeredVideoRidLimits(), ...session.videoRidLimits };\n",
             "            const selection = this.mediaSelection(session);\n            session.answered = true;\n"
             "            const answerLimits = { ...this.offeredVideoRidLimits(), ...session.videoRidLimits };\n")
    s = once(s, "            this.logDiagnostics(session, 'reoffer-answer', sdpAnswer);\n"
                "            if (session.pc.connectionState === 'connected') await this.startMedia(session);\n",
             "            this.logDiagnostics(session, 'reoffer-answer', sdpAnswer);\n"
             "            const talkback = this.talkbackReceivers(session);\n"
             "            const accepted = talkback ? `, ${talkback} talkback audio receiver(s) accepted (not played)` : '';\n"
             "            if (keepMedia && session.mediaSignature !== undefined && session.mediaSignature === this.mediaSignature(session, selection)) {\n"
             "                this.console.log(`HomeKit WebRTC reoffer answered: session ${sessionHex.slice(0, 8)}…, running media kept${accepted}`);\n"
             "            }\n"
             "            else {\n"
             "                if (keepMedia) this.stopMedia(session);\n"
             "                this.console.log(`HomeKit WebRTC reoffer answered: session ${sessionHex.slice(0, 8)}…, media restarts for the new negotiation${accepted}`);\n"
             "                if (session.pc.connectionState === 'connected') await this.startMedia(session);\n"
             "            }\n")
    s = once(s, "                + `+${parsed.receiveKeysToAdd.length}/-${parsed.receiveKidsToRemove.length} receive SFrame key(s) retained; receive direction inactive; status=0`);\n",
             "                + `+${parsed.receiveKeysToAdd.length}/-${parsed.receiveKidsToRemove.length} receive SFrame key(s) retained; `\n"
             "                + (this.talkbackReceivers(session) ? `${this.talkbackReceivers(session)} talkback audio receiver(s) accepted (not played)` : 'receive direction inactive')\n"
             "                + '; status=0');\n")
    return s


def edit_hksv27_source(s):
    return b.once(s, "                // r39: the offer shape that plays through Apple's relay in HAP-NodeJS PR 1132.\n"
                     "                secureVideoOffer: true,\n",
                  "                // r39: the offer shape that plays through Apple's relay in HAP-NodeJS PR 1132.\n"
                  "                secureVideoOffer: true,\n"
                  "                // r40: keep the session when the relay reoffers talkback audio.\n"
                  "                acceptRelayTalkback: true,\n")


def edit_hksv27_block(block):
    return b.once(block, 'secureVideoOffer: true,', 'secureVideoOffer: true,\n                acceptRelayTalkback: true,')


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
    out = ROOT / 'dist-r40'; out.mkdir(exist_ok=True)

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
        'change': 'Answer the reoffer Apple\'s relay sends 1.5-3 s into a remote WebRTC session, which adds a talkback audio '
                  'section (viewer to camera, Opus 16 kHz, SFrame). r39 rejected any receive section and closed the session, '
                  'freezing the first HEVC frame before audio started. The added audio receiver is accepted and never played; '
                  'the camera\'s own tracks stay send-only and incoming video is still refused. A reoffer that leaves the send '
                  'negotiation unchanged keeps the running FFmpeg processes, and receive keys for the talkback stream are accepted.',
        'evidence': 'Scrypted console 2026-09-16 05:06-05:07 NZST: relay receiver reports and FIR for Front video, then '
                    '"WebRTC reoffer failed Error: WebRTC receiving media is not supported by this send-only session" in every session.',
        'limitations': ['Talkback from the Home app is not played on the camera.',
            'Whether the relay keeps forwarding Front video after the answered reoffer requires a live remote test.',
            'The reoffer answer is werift\'s description unchanged, as in r39 and camera.ui.',
            'CMAF direct upload is unchanged: the hub never sent an upload command in the 2026-09-16 logs.',
            'Source map offsets are inherited; sourcesContent and dist-r40 contain the exact edited sources.']}
    if '--package' in sys.argv:
        v = json.loads((ROOT / 'diagnostics/r40-tests.json').read_text())
        log = (ROOT / 'diagnostics/r40-tests.log').read_bytes()
        assert v['bundleSha256'] == sha and v['returnCode'] == 0 and v['logSha256'] == b.digest(log)
        total, passed = re.search(rb'tests (\d+)\b', log), re.search(rb'pass (\d+)\b', log)
        assert total and passed and total[1] == passed[1] and int(total[1]) >= 230
        assert re.search(rb'fail 0\b', log) and re.search(rb'skipped 0\b', log)
        manifest['validationChecks'] = int(total[1])
    (out / 'main.nodejs.js').write_text(output)
    (out / 'main.nodejs.js.map').write_text(json.dumps(smap, separators=(',', ':')))
    (out / 'build-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    if '--package' in sys.argv:
        replacements = {n: (out / n).read_bytes() for n in ['main.nodejs.js', 'main.nodejs.js.map', 'build-manifest.json']}
        replacements['HEVC-TESTING.md'] = (ROOT / 'R40-TESTING.md').read_bytes()
        target = ROOT / 'plugin-hevc-webrtc-r40.zip'
        with zipfile.ZipFile(target, 'w') as z:
            for name, (info, data) in entries.items(): z.writestr(info, replacements.get(name, data))
        with zipfile.ZipFile(target) as z: assert z.testzip() is None and z.read('main.nodejs.js') == output.encode()
        result = {'archive': str(target), 'sha256': b.digest(target.read_bytes()), **manifest}
        (ROOT / 'diagnostics/r40-build.json').write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps(result, indent=2))
    else: print(json.dumps({'prepared': BUILD, 'bundleSha256': sha, 'editedModules': changed}))


if __name__ == '__main__': main()
