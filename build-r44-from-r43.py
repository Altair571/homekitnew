#!/usr/bin/env python3
"""Build r44 from the tested r43 ZIP: iOS 27 CMAF direct upload.

r44 is the first release whose edits are taken straight from plugin/ rather than reconstructed
by string patches over the previous release's embedded sources. plugin/ has tracked the shipped
build exactly since r40, so it is the authoritative copy; --verify-base checks every module the
release does not touch still matches it, which is the property the old per-edit assertions gave.
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
BUILD = 'hevc-fixes-2026-09-16-r44'

PROTECTION = b.PREFIX + 'hksv-cmaf-protection.ts'

# (module id, path under plugin/, extra dependency requests this release's imports add)
EDITED = [
    (b.PREFIX + 'cmaf-ingest.ts', 'plugin/src/types/camera/cmaf-ingest.ts',
        {'./hksv-cmaf-protection': PROTECTION}),
    (b.PREFIX + 'camera-hksv27.ts', 'plugin/src/types/camera/camera-hksv27.ts',
        {'./hksv-cmaf-protection': PROTECTION}),
    ('./src/types/camera.ts', 'plugin/src/types/camera.ts', {}),
    ('./src/camera-mixin.ts', 'plugin/src/camera-mixin.ts', {}),
]
ADDED = [(PROTECTION, 'plugin/src/types/camera/hksv-cmaf-protection.ts', {'crypto': 'crypto'})]
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
    out = ROOT / 'dist-r44'; out.mkdir(exist_ok=True)

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
        'change': 'iOS 27 CMAF direct upload: the accessory posts its own HomeKit Secure Video clips to Apple\'s '
                  'publishing point, with no home hub in the media path. The CMAF ingest client is rewritten onto '
                  'the DASH-IF Live Media Ingest Interface-1 shape the specification\'s publishing_point_url and '
                  'HTTP error enumeration imply: one POST per CMAF object over a kept-alive mutually-authenticated '
                  'connection, an opening connectivity probe, init re-post and retry on HTTP 412, and an empty mfra '
                  'to close the clip. A new module applies MPEG Common Encryption (cenc, AES-128-CTR) to the init '
                  'segment and each fragment under the Camera Key the controller provisions, with subsample '
                  'encryption for HEVC and full-sample for AAC. A new setting selects the upload mode; the default '
                  'is off, which behaves exactly as r43 did.',
        'evidence': 'A local publishing point requiring the provisioned client certificate accepted a clip end to '
                    'end: the plugin\'s own CSR and certificate provisioning path produced the mutual-TLS identity, '
                    'the objects arrived in order, and the reassembled clip decrypted with the Camera Key back to '
                    'the exact bytes the recorder produced and decoded in FFmpeg.',
        'limitations': ['The Camera Key media protection contract is not published. Apple\'s guide (rev. 2026-06-03) '
                        'defines the key and its identifier but never states how either applies to the media; cenc '
                        'with the Key Number as the default_KID is the reading that fits, and it is unverified '
                        'against Apple.',
            'The object path layout under the publishing point is likewise unspecified and is a guess; every '
            'request logs its URL and status so a real session shows what Apple expects.',
            'The recording is uploaded as one muxed CMAF track rather than separate video and audio tracks, '
            'matching the fragmented MP4 the legacy HKSV path sent.',
            'Nothing here has been run against Apple\'s publishing point: no URL, server CA set or client '
            'certificate for it exists outside a real pairing.',
            'Live view, WebRTC, SFrame and every r43 send-path behaviour are untouched.',
            'Source map offsets are inherited; sourcesContent and dist-r44 contain the exact sources.']}
    if '--package' in sys.argv:
        v = json.loads((ROOT / 'diagnostics/r44-tests.json').read_text())
        log = (ROOT / 'diagnostics/r44-tests.log').read_bytes()
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
        replacements['HEVC-TESTING.md'] = (ROOT / 'R44-TESTING.md').read_bytes()
        target = ROOT / 'plugin-hevc-webrtc-r44.zip'
        with zipfile.ZipFile(target, 'w') as z:
            for name, (info, data) in entries.items(): z.writestr(info, replacements.get(name, data))
        with zipfile.ZipFile(target) as z: assert z.testzip() is None and z.read('main.nodejs.js') == output.encode()
        result = {'archive': str(target), 'sha256': b.digest(target.read_bytes()), **manifest}
        (ROOT / 'diagnostics/r44-build.json').write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps(result, indent=2))
    else: print(json.dumps({'prepared': BUILD, 'bundleSha256': sha,
        'editedModules': changed, 'addedModules': [m for m, _, _ in ADDED]}))


if __name__ == '__main__': main()
