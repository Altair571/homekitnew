# homekitnew

A patched build of the [Scrypted](https://github.com/koush/scrypted) HomeKit plugin that streams H.265 (HEVC) cameras to iOS 27 and tvOS 27. It includes live view away from home, up to 4K, through Apple's WebRTC relay.

> Unofficial and experimental. Not affiliated with Apple or Scrypted.

## Status

**r42 is the current known-working release. r43 and r44 are pre-releases under test.**

| Scenario | r42 (known working) | r43 (pre-release) | r44 (pre-release) |
| --- | --- | --- | --- |
| Live view at home (Multi-Tier RTP, native HEVC up to 4K) | Works | Unchanged | Unchanged |
| Live view away from home at the default 360p (WebRTC through Apple's relay) | Works, with video and audio | Unchanged | Unchanged |
| 1080p away from home | Works: re-encoded at 4 Mbps | Unchanged | Unchanged |
| 4K away from home | Works: the camera's own 4K HEVC stream, sent without re-encoding | Unchanged | Unchanged |
| 1440p away from home | Untested | Untested | Untested |
| Talkback from the Home app | Not played on the camera | Not played on the camera | Unchanged |
| HomeKit Secure Video recording | Not verified | Not verified | Not verified |
| iOS 27 CMAF direct upload | Refused | Refused | Implemented, opt-in, unverified against Apple |

r43 sends exactly what r42 sends. It only removes work the plugin was doing per
packet on its own event loop: about half of it at 4K. Nothing about the picture
should change, which is what makes it a pre-release rather than a known-working
build — it has passed its checks but has not yet been watched on a camera. See
[R43-TESTING.md](R43-TESTING.md).

r44 implements the iOS 27 direct upload path: the plugin posts HomeKit Secure Video
clips to Apple's publishing point itself, with no Apple TV or HomePod in the media
path. It is off by default, and the parts of the contract Apple has not published are
marked as inference throughout. See [CMAF-UPLOAD.md](CMAF-UPLOAD.md) for what is
specified and what is not, and [R44-TESTING.md](R44-TESTING.md) for how to test it.

## Install

1. From [Releases](https://github.com/Altair571/homekitnew/releases), download `plugin-hevc-webrtc-rNN.zip` and `Install-Scrypted-Plugin-rNN.command` from the same release into one folder. [r42](https://github.com/Altair571/homekitnew/releases/tag/r42) is known working, and r43 and r44 are pre-releases; earlier releases stay available for rollback.
2. Run the installer with your Scrypted server address:

   ```bash
   python3 Install-Scrypted-Plugin-r44.command --server https://your-scrypted-host:10443
   ```

   It checks the ZIP's SHA-256, asks for your Scrypted username and password (never saved), and uploads the ZIP to the existing HomeKit plugin.
3. Confirm the HomeKit plugin console shows the build, for example `hevc-fixes-2026-09-16-r44`.
4. In the camera's HomeKit settings, enable **Experimental: HEVC / 4K Streaming and HKSV (iOS/tvOS 27+)**.
5. Optional: choose the remote quality with **Experimental: WebRTC Remote Resolution (r42)** and **Experimental: WebRTC Remote Video Bitrate (r42)**. 360p is the default.
6. On r44, optionally turn on **Experimental: HKSV CMAF Direct Upload (r44)** to let the plugin upload HomeKit Secure Video clips to Apple itself. It is off by default; see [R44-TESTING.md](R44-TESTING.md).

Each release's `HEVC-TESTING.md` (in this repository: `R40-TESTING.md` … `R44-TESTING.md`) describes what to check after installing.

## How remote HEVC works

On iOS 27, a camera viewed away from home is streamed over WebRTC through Apple's relay, end-to-end encrypted with SFrame. Two details decide whether video reaches the viewer:

- **Offer shape (r39).** The relay turns the camera's offer into the viewer's stream description.
  - The video section must declare its bitrate: `b=AS`, `b=TIAS`, and `max-br` on the RID line.
  - The RID is declared in SDP only, and packets carry no RTP header extensions.
  - This matches the offer camera.ui uses in [HAP-NodeJS PR 1132](https://github.com/homebridge/HAP-NodeJS/pull/1132).
- **Talkback reoffer (r40).** A second or two into the session, the relay renegotiates to add a talkback audio section (Opus 16 kHz, SFrame).
  - The plugin answers it with a receive-only section and keeps the running media.
  - Earlier builds closed the session there, which froze the picture on its first frame.

r41 shortens startup:
- Remote viewers get a keyframe every 0.5 s for the first 4 seconds, then every second.
- The AAC-to-Opus transcoder skips input probing.
- Each session logs a one-line startup timing summary.

r42 adds remote quality options:
- The remote resolution setting adds 1440p and 4K to 360p and 1080p.
- A new bitrate setting chooses between three modes:
  - Automatic: 1080p at 4 Mbps, 1440p at 6 Mbps, and 4K as the camera's own stream.
  - The camera's stream unchanged, when one matches the resolution.
  - A fixed re-encode from 2 to 16 Mbps.
- Each session logs the frame rate and bitrate actually sent, and the loss the relay reports.

A camera stream sent unchanged starts, and recovers from loss, at the camera's own keyframes. Setting the camera's I-frame interval to 1–2 seconds makes 4K start faster.

r43 changes none of that. It removes per-packet work from the send path:
- The frame-marking probe resolved its negotiated extension IDs once per RTP packet, and each of those reads made werift re-serialize the whole remote SDP. It now resolves them once per frame.
- The media probe independently decrypted and re-hashed every datagram for the life of the session. It now does that for the first 4000 packets of each stream, which is where a fault would show, and keeps its free counters for the whole session.
- SFrame encryption and HEVC assembly drop two full-frame copies, and reading an RTSP packet no longer walks the track list.

Replaying 10 s of HEVC through the real send path, that is 12.3% of one core down to 6.0% at 4K, 5.1% to 3.6% at 1080p, and 2.3% to 2.0% at 360p.

## Repository layout

| Path | Contents |
| --- | --- |
| `plugin/` | Plugin source exactly as the latest build (r44) contains it, apart from the embedded build label. `build-r44-from-r43.py --verify-base` asserts the two match. |
| `tests/` | Node test suite that runs against a built bundle, plus the installer tests |
| `build-r39-from-r38.py` … `build-r44-from-r43.py` | Incremental release builders. Each patches the previous checksum-locked release ZIP. |
| `build-r35-from-r34.py` | Shared helpers the builders import |
| `Install Scrypted Plugin.command` | The installer for the latest packaged release (r44) |
| `R39-TESTING.md` … `R44-TESTING.md` | Release notes and test steps |
| `CMAF-UPLOAD.md` | What Apple's HKSV guide specifies about direct upload, and what it leaves undefined |

## Building and running the tests

Rebuilding a release needs Node.js and Python 3, plus the checksum-locked ZIP of the
release it builds from, in the repository root. Each build is deterministic: r43 is
always `06fc8efce65a8ad03db43c9994eb6832543cb5059158c264f8bab4be1ffbf5d2` and r44 is
always `65e910ad8a71cfe27a98c3feb7564c9ac7d6fddd601c1232ae2b2fc6470a9700`.

```bash
npm ci
curl -LO https://github.com/Altair571/homekitnew/releases/download/r42/plugin-hevc-webrtc-r42.zip
python3 build-r43-from-r42.py                     # writes dist-r43/
curl -LO https://github.com/Altair571/homekitnew/releases/download/r43/plugin-hevc-webrtc-r43.zip
python3 build-r44-from-r43.py --verify-base       # writes dist-r44/
HK_TEST_BUNDLE=dist-r44/main.nodejs.js node --test --test-concurrency=2 tests/*.test.cjs
python3 tests/test_installer.py                   # checks the packaged r44 ZIP
```

`tests/cmaf-upload.test.cjs` covers what r44 changed, driving the whole provisioning
sequence into a publishing point that requires the client certificate the plugin was
issued. `tests/r43-send-path.test.cjs` covers what r43 changed, including a digest of the
bytes the SFrame sender puts on the wire, which r42 produces too. Two tests,
`real WebRTC ICE/DTLS/SRTP carries identical HEVC pictures`, drive a loopback WebRTC
session through real ffmpeg. They send a 100-frame burst, so a host with a small
default UDP receive buffer drops datagrams and fails them whichever build is under
test; on Linux, `sysctl -w net.core.rmem_default=4194304` is enough. Limiting
concurrency keeps the probe's decoder fixture inside its timeout on a small machine.

Packaging is locked to a passing run: `--package` rebuilds the ZIP only if
`diagnostics/r44-tests.json` records this exact bundle, a zero exit code, and the
hash of `diagnostics/r44-tests.log`, and only if that log shows no failed or skipped
test. Record the run, then package:

```bash
mkdir -p diagnostics
HK_TEST_BUNDLE=dist-r44/main.nodejs.js node --test --test-concurrency=2 tests/*.test.cjs > diagnostics/r44-tests.log; code=$?
python3 - "$code" <<'PY'
import hashlib, json, sys
from pathlib import Path
out = {'bundleSha256': hashlib.sha256(Path('dist-r44/main.nodejs.js').read_bytes()).hexdigest(),
       'returnCode': int(sys.argv[1]),
       'logSha256': hashlib.sha256(Path('diagnostics/r44-tests.log').read_bytes()).hexdigest()}
Path('diagnostics/r44-tests.json').write_text(json.dumps(out, indent=2) + '\n')
PY
python3 build-r44-from-r43.py --package
```

The release's other two assets are copies of what the packaging step pinned, so they
are generated rather than committed:

```bash
cp "Install Scrypted Plugin.command" Install-Scrypted-Plugin-r44.command
sha256sum plugin-hevc-webrtc-r44.zip Install-Scrypted-Plugin-r44.command > SHA256SUMS-r44.txt
```

Upload those two and the ZIP to the release, with `r44-release-notes.md` as its
description.

To run the suite against an earlier release instead, unzip its bundle into `dist/`
and point `HK_TEST_BUNDLE` at it.

## Credits

- The [Scrypted](https://github.com/koush/scrypted) HomeKit plugin is the base of this build. Upstream licenses apply.
- [werift](https://github.com/shinyoshiaki/werift-webrtc) is the WebRTC stack bundled in the plugin.
- camera.ui's work in [HAP-NodeJS PR 1132](https://github.com/homebridge/HAP-NodeJS/pull/1132) is the reference for the offer shape Apple's relay accepts.
