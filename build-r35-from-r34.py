#!/usr/bin/env python3
"""Build the r35 diagnostic release from the checksum-locked r34 archive."""
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BASE_SHA = '632fd56ca44f2d9289ee3dda17136832ce459ff90fe54fe0092a30fb40cb603b'
OLD_BUILD = 'hevc-fixes-2026-09-14-r34'
BUILD = 'hevc-fixes-2026-09-15-r35'
PREFIX = './src/types/camera/'
NODE = os.environ.get('NODE') or shutil.which('node') or 'node'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def once(s, old, new):
    assert s.count(old) == 1, (old[:100], s.count(old))
    return s.replace(old, new)


def modules(text):
    markers = list(re.finditer(r'^/\*\*\*/ "([^"]+)":', text, re.M))
    return {m[1]: text[m.start():markers[i+1].start() if i+1 < len(markers) else len(text)] for i, m in enumerate(markers)}


def edit_camera(s):
    s = once(s, "import { SFrameRtpSender } from './hksv-sframe';", "import { SFrameRtpSender } from './hksv-sframe';\nimport { createWebRTCMediaProbe } from './hksv-webrtc-probe';")
    s = once(s, "case 200: add('sr'); break;", "case 200:\n                    add('sr');\n                    for (const report of Array.isArray(packet.reports) ? packet.reports : [])\n                        add('sr.' + media(report?.ssrc));\n                    break;")
    s = once(s, '    diagnosticTimer?: ReturnType<typeof setTimeout>;', '    diagnosticTimer?: ReturnType<typeof setTimeout>;\n    probeTimers?: ReturnType<typeof setTimeout>[];\n    probe?: ReturnType<typeof createWebRTCMediaProbe>;')
    s = once(s, '        this.sessions.set(sessionHex, session);', '        session.probe = createWebRTCMediaProbe(session);\n        this.sessions.set(sessionHex, session);')
    s = once(s, '            session.diagnosticTimer.unref?.();', '''            session.diagnosticTimer.unref?.();
            session.probeTimers = [15000, 30000, 60000].map(ms => {
                const timer = setTimeout(() => {
                    if (!session.closed) this.logDiagnostics(session, 'r35-after-' + ms / 1000 + 's');
                }, ms);
                timer.unref?.(); return timer;
            });''')
    s = once(s, 'wire: session.wire?.snapshot(), contract: session.contract?.snapshot()', 'wire: session.wire?.snapshot(), contract: session.contract?.snapshot(), probe: session.probe?.snapshot()')
    s = once(s, 'new SFrameRtpSender(key, kid, videoSsrc, true, selection.remote ? REMOTE_SLICE_BYTES : undefined)', "new SFrameRtpSender(key, kid, videoSsrc, true, selection.remote ? REMOTE_SLICE_BYTES : undefined, (frame, header, encrypted) => session.probe?.sourceFrame('video', frame, header, encrypted))")
    s = once(s, 'new SFrameRtpSender(key, kid, audioSsrc, false)', "new SFrameRtpSender(key, kid, audioSsrc, false, undefined, (frame, header, encrypted) => session.probe?.sourceFrame('audio', frame, header, encrypted))")
    s = once(s, 'packet.header.payloadType = videoPayloadType;', "packet.header.payloadType = videoPayloadType;\n                            session.probe?.observeInput('video', packet);")
    s = once(s, 'packet.header.payloadType = payloadType;', "packet.header.payloadType = payloadType;\n                            session.probe?.observeInput('audio', packet);")
    s = once(s, '        clearTimeout(session.diagnosticTimer);', '        clearTimeout(session.diagnosticTimer);\n        for (const timer of session.probeTimers ?? []) clearTimeout(timer);')
    s = once(s, '        session.wire?.dispose();', '        session.wire?.dispose();\n        session.probe?.dispose();')
    return s


def edit_sframe(s):
    s = once(s, 'private readonly maxSlice = 1100)', 'private readonly maxSlice = 1100, private readonly observeFrame?: (frame: Buffer, header: RtpHeader, encrypted: Buffer) => void)')
    return once(s, '        const encrypted = this.encryptor.encrypt(frame), packets: RtpPacket[] = [];', '        const encrypted = this.encryptor.encrypt(frame), packets: RtpPacket[] = [];\n        try { this.observeFrame?.(frame, packet.header, encrypted); } catch (_) { /* Diagnostics cannot interrupt media. */ }')


def edit_wire(s):
    s = once(s, '        const connection = dtls.iceTransport?.connection;', '        const connection = dtls.iceTransport?.connection;\n        try { session.probe?.installTransport(dtls); } catch (_) { }')
    s = once(s, 'if (auditKind) session.contract?.observeRtp(auditKind, payload, header);', 'if (auditKind) { session.contract?.observeRtp(auditKind, payload, header); session.probe?.observeRtp(auditKind, payload, header); }')
    return once(s, 'if (auditKind) session.contract?.observeUdp(auditKind, data);', 'if (auditKind) { session.contract?.observeUdp(auditKind, data); session.probe?.observeUdp(auditKind, data, dtls); }')


def compile_module(name, source, deps):
    script = """const ts=require('./node_modules/typescript');let s='';process.stdin.setEncoding('utf8');
process.stdin.on('data',v=>s+=v);process.stdin.on('end',()=>{const r=ts.transpileModule(s,{reportDiagnostics:true,
compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}});
if(r.diagnostics.length){console.error(r.diagnostics.map(d=>ts.flattenDiagnosticMessageText(d.messageText,'\\n')).join('\\n'));process.exit(1);}
process.stdout.write(r.outputText);});"""
    js = subprocess.run([NODE, '-e', script], cwd=ROOT, input=source, text=True, capture_output=True, check=True).stdout
    imports = re.findall(r'require\("([^"]+)"\)', js)
    assert all(n in deps for n in imports), (name, imports, deps)
    return '/***/ ' + json.dumps(PREFIX + name) + ':\n/***/ ((module, exports, __webpack_require__) => {\nconst dependencies = ' + json.dumps(deps) + ';\nconst require = name => __webpack_require__(dependencies[name]);\n' + js + '\n/***/ }),\n\n\n'


def main():
    base = (ROOT / 'plugin-hevc-webrtc-r34.zip').read_bytes()
    assert digest(base) == BASE_SHA
    with zipfile.ZipFile(ROOT / 'plugin-hevc-webrtc-r34.zip') as z:
        assert z.testzip() is None
        entries = {i.filename: (i, z.read(i)) for i in z.infolist()}
    original = entries['main.nodejs.js'][1].decode()
    old = json.loads(entries['build-manifest.json'][1])
    assert old['buildId'] == OLD_BUILD and digest(original.encode()) == old['bundleSha256']
    before = modules(original)
    smap = json.loads(entries['main.nodejs.js.map'][1])
    out = ROOT / 'dist-r35'; out.mkdir(exist_ok=True)
    edits = {'camera-webrtc.ts': edit_camera, 'hksv-sframe.ts': edit_sframe, 'hksv-webrtc-wire-diagnostics.ts': edit_wire}
    output = original
    for name, edit in edits.items():
        matches = [i for i, n in enumerate(smap['sources']) if n.endswith('/' + name)]
        assert len(matches) == 1
        index = matches[0]; source = edit(smap['sourcesContent'][index]); smap['sourcesContent'][index] = source
        block = before[PREFIX + name]
        dep_match = re.search(r'const dependencies = (\{.*?\});', block)
        deps = json.loads(dep_match[1]) if dep_match else {}
        if name == 'camera-webrtc.ts': deps['./hksv-webrtc-probe'] = PREFIX + 'hksv-webrtc-probe.ts'
        output = once(output, block, compile_module(name, source, deps))
        (out / name).write_text(source)
    name = 'hksv-webrtc-probe.ts'; source = (ROOT / 'patches-r35' / name).read_text()
    extra = compile_module(name, source, {'crypto': 'crypto', 'child_process': 'child_process', '@scrypted/sdk': '../../sdk/dist/src/index.js'})
    anchor = '/***/ ' + json.dumps(PREFIX + 'camera-webrtc.ts') + ':'
    output = once(output, anchor, extra + anchor)
    smap['sources'].append('webpack://homekit/./src/types/camera/' + name); smap['sourcesContent'].append(source)
    (out / name).write_text(source)
    assert output.count(OLD_BUILD) == 2; output = output.replace(OLD_BUILD, BUILD)
    smap['sourcesContent'] = [c.replace(OLD_BUILD, BUILD) if c else c for c in smap['sourcesContent']]
    after = modules(output)
    changed = [n for n in before if before[n] != after[n]]
    assert set(changed) == {PREFIX + n for n in [*edits, 'camera-hksv27.ts', 'camera-stream-diagnostics.ts']}, changed
    assert set(after) - set(before) == {PREFIX + name}
    sha = digest(output.encode())
    manifest = {'buildId': BUILD, 'baseBuildId': OLD_BUILD, 'previousArchiveSha256': BASE_SHA,
        'originalArchiveSha256': old['originalArchiveSha256'], 'bundleSha256': sha,
        'editedModules': changed, 'addedModules': [PREFIX + name],
        'change': 'Bounded diagnostics for all RTCP reception-report blocks, independent SRTP/SFrame authentication and media continuity through the actual UDP send path.',
        'limitations': ['The build diagnoses local processing and peer reception evidence; it cannot guarantee access to Apple relay internal errors.',
            'SRTP independent verifier supports negotiated profiles 1 and 7; other profiles are explicitly reported as unsupported.',
            'SFrame checks sample the first 12 frames then one per five seconds per media; one outgoing HEVC keyframe is independently decoded through FFmpeg in memory with an eight-second timeout.',
            'Existing SDP, video quality, codec, encryption and packetization behavior is retained.',
            'Inherited source-map offsets remain imperfect; sourcesContent and dist-r35 contain the edited sources.']}
    if '--package' in sys.argv:
        v = json.loads((ROOT / 'diagnostics/r35-tests.json').read_text()); log = (ROOT / 'diagnostics/r35-tests.log').read_bytes()
        assert v['bundleSha256'] == sha and v['returnCode'] == 0 and v['logSha256'] == digest(log)
        total, passed = re.search(rb'tests (\d+)\b', log), re.search(rb'pass (\d+)\b', log)
        assert total and passed and total[1] == passed[1] and int(total[1]) >= 179
        assert re.search(rb'fail 0\b', log) and re.search(rb'skipped 0\b', log)
        manifest['validationChecks'] = int(total[1])
    (out / 'main.nodejs.js').write_text(output)
    (out / 'main.nodejs.js.map').write_text(json.dumps(smap, separators=(',', ':')))
    (out / 'build-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    if '--package' in sys.argv:
        replacements = {n: (out / n).read_bytes() for n in ['main.nodejs.js', 'main.nodejs.js.map', 'build-manifest.json']}
        replacements['HEVC-TESTING.md'] = (ROOT / 'R35-TESTING.md').read_bytes()
        target = ROOT / 'plugin-hevc-webrtc-r35.zip'
        with zipfile.ZipFile(target, 'w') as z:
            for name, (info, data) in entries.items(): z.writestr(info, replacements.get(name, data))
        with zipfile.ZipFile(target) as z: assert z.testzip() is None and z.read('main.nodejs.js') == output.encode()
        result = {'archive': str(target), 'sha256': digest(target.read_bytes()), **manifest}
        (ROOT / 'diagnostics/r35-build.json').write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps(result, indent=2))
    else: print(json.dumps({'prepared': BUILD, 'bundleSha256': sha, 'editedModules': changed}))


if __name__ == '__main__': main()
