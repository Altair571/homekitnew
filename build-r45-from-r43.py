#!/usr/bin/env python3
"""Build r45 from the tested r43 ZIP: the iOS 27 CMAF upload layout Apple's publishing point can route.

r45 builds from r43 rather than r44 because r44 was never published as a release: the r43 ZIP
is the last checksum-locked archive on GitHub. plugin/ carries r44's edits and r45's, so the
build takes both from it; --verify-base checks every module neither release touched still
matches the r43 bundle, which is what the old per-edit assertions gave.
"""
import importlib.util
import json
import re
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def _load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), ROOT / (name + '.py'))
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


b = _load('build-r35-from-r34')
b43 = _load('build-r43-from-r42')
BASE_SHA = 'a439c965f28d7691efddbcda2c4f8f4ab925957d9f7dc196b911474cd503642a'
OLD_BUILD = 'hevc-fixes-2026-09-16-r43'
BUILD = 'hevc-fixes-2026-09-16-r45'

PROTECTION = b.PREFIX + 'hksv-cmaf-protection.ts'
TRACKS = b.PREFIX + 'hksv-cmaf-tracks.ts'

# (module id, path under plugin/, extra dependency requests this release's imports add)
EDITED = [
    (b.PREFIX + 'cmaf-ingest.ts', 'plugin/src/types/camera/cmaf-ingest.ts',
        {'./hksv-cmaf-protection': PROTECTION, './hksv-cmaf-tracks': TRACKS}),
    (b.PREFIX + 'camera-hksv27.ts', 'plugin/src/types/camera/camera-hksv27.ts',
        {'./hksv-cmaf-protection': PROTECTION}),
    ('./src/types/camera.ts', 'plugin/src/types/camera.ts', {}),
    ('./src/camera-mixin.ts', 'plugin/src/camera-mixin.ts', {}),
]
ADDED = [(PROTECTION, 'plugin/src/types/camera/hksv-cmaf-protection.ts', {'crypto': 'crypto'}),
         (TRACKS, 'plugin/src/types/camera/hksv-cmaf-tracks.ts', {'./hksv-cmaf-protection': PROTECTION})]
# Modules that change by the embedded build label alone.
LABEL_ONLY = [b.PREFIX + 'camera-stream-diagnostics.ts']


def base_archive():
    for path in (ROOT / 'plugin-hevc-webrtc-r43.zip', Path.home() / 'Desktop' / 'plugin-hevc-webrtc-r43.zip'):
        if path.is_file() and b.digest(path.read_bytes()) == BASE_SHA:
            return path
    raise SystemExit('The checksum-locked r43 ZIP was not found.')


# The bundle's source map names plugin sources four ways: webpack's own form for modules an
# earlier release added, and three relative forms for the modules the original build compiled.
MIRRORS = [
    ('webpack://homekit/./src/', 'plugin/src/'),
    ('../../../common/src/', 'plugin/common/src/'),
    ('../../webrtc/src/', 'plugin/webrtc/src/'),
    ('../src/', 'plugin/src/'),
]


def mirror_path(source_name):
    """Maps a source map entry onto its path under plugin/, or None if it is not plugin source."""
    for prefix, mirror in MIRRORS:
        if source_name.startswith(prefix):
            return ROOT / (mirror + source_name[len(prefix):])
    return None


def normalize_label(source):
    """plugin/ carries whichever build label was current when it was last synced. The label is
    rewritten across the whole bundle at the end of the build, so compare and compile against the
    base release's label rather than whichever one happens to be checked in."""
    return re.sub(r'hevc-fixes-\d{4}-\d{2}-\d{2}-r\d+', OLD_BUILD, source)


def verify_base(smap, edited_mirrors):
    """Every module this release leaves alone must already match plugin/."""
    checked = drifted = 0
    for name, content in zip(smap['sources'], smap['sourcesContent']):
        path = mirror_path(name)
        if not path or not path.is_file() or path in edited_mirrors or content is None:
            continue
        checked += 1
        if normalize_label(path.read_text()) != content:
            drifted += 1
            print(f'DRIFT {path.relative_to(ROOT)}')
    print(json.dumps({'verifiedUnchangedModules': checked, 'drifted': drifted}))
    return not drifted


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
    out = ROOT / 'dist-r45'; out.mkdir(exist_ok=True)

    def source_index(module):
        suffix = module[1:] if module.startswith('.') else module
        matches = [i for i, n in enumerate(smap['sources']) if n.endswith(suffix)]
        assert len(matches) == 1, (module, matches)
        return matches[0]

    edited_mirrors = {ROOT / mirror for _, mirror, _ in EDITED}
    if '--verify-base' in sys.argv and not verify_base(smap, edited_mirrors):
        raise SystemExit('plugin/ has drifted from the r43 bundle outside this release\'s edits.')

    output = original
    for module, mirror, extra in EDITED:
        index = source_index(module)
        source = normalize_label((ROOT / mirror).read_text())
        assert source != smap['sourcesContent'][index], f'{mirror} is unchanged from r43'
        deps = b43.block_dependencies(before[module], before) | extra
        output = b.once(output, before[module], b43.compile_module(module, source, deps))
        smap['sourcesContent'][index] = source
        (out / Path(mirror).name).write_text(source)

    for module, mirror, deps in ADDED:
        source = normalize_label((ROOT / mirror).read_text())
        # A new module is placed ahead of its first importer so the bundle stays readable.
        anchor = '/***/ ' + json.dumps(b.PREFIX + 'cmaf-ingest.ts') + ':'
        output = b.once(output, anchor, b43.compile_module(module, source, deps) + anchor)
        smap['sources'].append('webpack://homekit/' + module)
        smap['sourcesContent'].append(source)
        (out / Path(mirror).name).write_text(source)

    assert output.count(OLD_BUILD) == 2
    output = output.replace(OLD_BUILD, BUILD)
    smap['sourcesContent'] = [c.replace(OLD_BUILD, BUILD) if c else c for c in smap['sourcesContent']]
    after = b.modules(output)
    changed = [n for n in before if before[n] != after[n]]
    assert set(changed) == {m for m, _, _ in EDITED} | set(LABEL_ONLY), changed
    for module in LABEL_ONLY:
        assert after[module] == before[module].replace(OLD_BUILD, BUILD), module
    assert set(after) - set(before) == {m for m, _, _ in ADDED}
    sha = b.digest(output.encode())
    manifest = {'buildId': BUILD, 'baseBuildId': OLD_BUILD, 'previousArchiveSha256': BASE_SHA,
        'originalArchiveSha256': old['originalArchiveSha256'], 'bundleSha256': sha,
        'editedModules': changed, 'addedModules': [m for m, _, _ in ADDED],
        'change': 'iOS 27 CMAF direct upload, second layout. A real session on r44 showed Apple\'s publishing '
                  'point answering HTTP 404 to the DASH-IF object layout r44 guessed and to every other shape probed '
                  'at the base URL. r45 uploads the layout the Matter Push AV Stream Transport cluster specifies for '
                  'CMAF ingest, which Apple\'s iOS 27 HAP surface mirrors service for service: PUT '
                  'session_<N>/index.mpd, session_<N>/<track>/<track>.init and '
                  'session_<N>/<track>/segment_<S>.m4s from 1001, with the reference camera\'s content types. The '
                  'manifest is offered under the Clip ID first and under the Session ID if that is refused with 404; '
                  'a 405 switches the session to POST. A new module splits the recorder\'s muxed fragmented MP4 '
                  'into one CMAF track file per track without touching sample bytes, and builds the DASH manifest. '
                  'Every refusal is logged with its status, headers and the start of its body, and a Camera Key '
                  'that is not the 16 bytes the cenc reading assumes is called out when an upload starts. '
                  'r44\'s Camera Key protection, setting and default (off) are unchanged.',
        'evidence': 'A local publishing point speaking the Push AV layout and requiring the provisioned client '
                    'certificate accepted a clip end to end, one track at a time, and each reassembled track '
                    'decrypted with the Camera Key back to the recorder\'s exact samples; each split track decodes '
                    'in FFmpeg to the same streams as the muxed recording; a point keyed on the Session ID, one that '
                    'only allows POST, one that forgets a header, and one that refuses everything each produced the '
                    'fallback, the retry and the logged diagnosis the design describes.',
        'limitations': ['The object layout is inferred from the Matter Push AV Stream Transport specification and '
                        'its reference camera, not from Apple; the one real session so far only ruled out the r44 '
                        'layout and the shapes probed beside it. Whether Apple keys the session on the Clip ID or '
                        'the Session ID is unknown, so both are offered.',
            'The Camera Key media protection contract is not published, and the one real key seen was 32 bytes '
            'where cenc (AES-128-CTR) uses 16. The cenc reading is unchanged and unverified against Apple; the '
            'unencrypted diagnostic mode is what isolates the layout from the protection.',
            'Requests are HTTP/1.1 over TLS 1.3. Apple\'s publishing point negotiates HTTP/2 when offered; whether '
            'it requires it is unknown.',
            'Live view, WebRTC, SFrame and every r43 send-path behaviour are untouched.',
            'Source map offsets are inherited; sourcesContent and dist-r45 contain the exact sources.']}
    if '--package' in sys.argv:
        v = json.loads((ROOT / 'diagnostics/r45-tests.json').read_text())
        log = (ROOT / 'diagnostics/r45-tests.log').read_bytes()
        assert v['bundleSha256'] == sha and v['returnCode'] == 0 and v['logSha256'] == b.digest(log)
        total, passed = re.search(rb'tests (\d+)\b', log), re.search(rb'pass (\d+)\b', log)
        assert total and passed and total[1] == passed[1] and int(total[1]) >= 245
        assert re.search(rb'fail 0\b', log) and re.search(rb'skipped 0\b', log)
        manifest['validationChecks'] = int(total[1])
    (out / 'main.nodejs.js').write_text(output)
    (out / 'main.nodejs.js.map').write_text(json.dumps(smap, separators=(',', ':')))
    (out / 'build-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    if '--package' in sys.argv:
        replacements = {n: (out / n).read_bytes() for n in ['main.nodejs.js', 'main.nodejs.js.map', 'build-manifest.json']}
        replacements['HEVC-TESTING.md'] = (ROOT / 'R45-TESTING.md').read_bytes()
        target = ROOT / 'plugin-hevc-webrtc-r45.zip'
        with zipfile.ZipFile(target, 'w') as z:
            for name, (info, data) in entries.items(): z.writestr(info, replacements.get(name, data))
        with zipfile.ZipFile(target) as z: assert z.testzip() is None and z.read('main.nodejs.js') == output.encode()
        result = {'archive': str(target), 'sha256': b.digest(target.read_bytes()), **manifest}
        (ROOT / 'diagnostics/r45-build.json').write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps(result, indent=2))
    else: print(json.dumps({'prepared': BUILD, 'bundleSha256': sha,
        'editedModules': changed, 'addedModules': [m for m, _, _ in ADDED]}))


if __name__ == '__main__': main()
