# homekitnew

A patched build of the [Scrypted](https://github.com/koush/scrypted) HomeKit plugin that streams H.265 (HEVC) cameras to iOS 27 and tvOS 27. It includes live view away from home, up to 4K, through Apple's WebRTC relay.

> Unofficial and experimental. Not affiliated with Apple or Scrypted.

## Status

**r42 is the current known-working release.**

| Scenario | r42 |
| --- | --- |
| Live view at home (Multi-Tier RTP, native HEVC up to 4K) | Works |
| Live view away from home at the default 360p (WebRTC through Apple's relay) | Works, with video and audio |
| 1080p away from home | Works: re-encoded at 4 Mbps |
| 4K away from home | Works: the camera's own 4K HEVC stream, sent without re-encoding |
| 1440p away from home | Untested |
| Talkback from the Home app | Not played on the camera |
| HomeKit Secure Video recording | Not verified |
| iOS 27 CMAF direct upload | Not working |

## Install

1. From [Releases](https://github.com/Altair571/homekitnew/releases), download `plugin-hevc-webrtc-rNN.zip` and `Install-Scrypted-Plugin-rNN.command` from the same release into one folder. [r42](https://github.com/Altair571/homekitnew/releases/tag/r42) is the current release; earlier releases stay available for rollback.
2. Run the installer with your Scrypted server address:

   ```bash
   python3 Install-Scrypted-Plugin-r42.command --server https://your-scrypted-host:10443
   ```

   It checks the ZIP's SHA-256, asks for your Scrypted username and password (never saved), and uploads the ZIP to the existing HomeKit plugin.
3. Confirm the HomeKit plugin console shows the build, for example `hevc-fixes-2026-09-16-r42`.
4. In the camera's HomeKit settings, enable **Experimental: HEVC / 4K Streaming and HKSV (iOS/tvOS 27+)**.
5. Optional: choose the remote quality with **Experimental: WebRTC Remote Resolution (r42)** and **Experimental: WebRTC Remote Video Bitrate (r42)**. 360p is the default.

Each release's `HEVC-TESTING.md` (in this repository: `R40-TESTING.md`, `R41-TESTING.md`, `R42-TESTING.md`) describes what to check after installing.

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

## Repository layout

| Path | Contents |
| --- | --- |
| `plugin/` | Plugin source exactly as shipped in the latest build (r42), taken from the release bundle's source map |
| `tests/` | Node test suite that runs against a built bundle, plus the installer tests |
| `build-r39-from-r38.py` … `build-r42-from-r41.py` | Incremental release builders. Each patches the previous checksum-locked release ZIP. |
| `build-r35-from-r34.py` | Shared helpers the builders import |
| `Install Scrypted Plugin.command` | The installer for the latest build (r42) |
| `R39-TESTING.md` … `R42-TESTING.md` | Release notes and test steps |

## Running the tests

This needs Node.js and Python 3. The tests match the latest build, so download `plugin-hevc-webrtc-r42.zip` from the r42 release into the repository root first.

```bash
npm ci
mkdir -p dist && unzip -o plugin-hevc-webrtc-r42.zip main.nodejs.js main.nodejs.js.map -d dist
HK_TEST_BUNDLE=dist/main.nodejs.js node --test tests/*.test.cjs
python3 tests/test_installer.py
```

## Credits

- The [Scrypted](https://github.com/koush/scrypted) HomeKit plugin is the base of this build. Upstream licenses apply.
- [werift](https://github.com/shinyoshiaki/werift-webrtc) is the WebRTC stack bundled in the plugin.
- camera.ui's work in [HAP-NodeJS PR 1132](https://github.com/homebridge/HAP-NodeJS/pull/1132) is the reference for the offer shape Apple's relay accepts.
