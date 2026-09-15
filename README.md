# homekitnew

A patched build of the [Scrypted](https://github.com/koush/scrypted) HomeKit plugin that streams H.265 (HEVC) cameras to iOS 27 and tvOS 27. It includes live view away from home through Apple's WebRTC relay.

> Unofficial and experimental. Not affiliated with Apple or Scrypted.

## Status

**r40 is the current known-working release. r41 is a pre-release under test.**

| Scenario | r40 (known working) | r41 (pre-release) |
| --- | --- | --- |
| Live view at home (Multi-Tier RTP, native HEVC up to 4K) | Works | Unchanged |
| Live view away from home (WebRTC through Apple's relay, HEVC) | Works: video and audio, tested on cellular. 640×360 at 15 fps, slow to start. | Same stream with a faster start: early keyframes, audio without the probing delay |
| 1080p live view away from home | Not available | Opt-in setting; untested, and Apple may refuse it on cellular |
| Talkback from the Home app | Not played on the camera | Not played on the camera |
| HomeKit Secure Video recording | Not verified | Not verified |
| iOS 27 CMAF direct upload | Not working | Not working |

## Install

1. From [Releases](https://github.com/Altair571/homekitnew/releases), download `plugin-hevc-webrtc-rNN.zip` and `Install-Scrypted-Plugin-rNN.command` from the same release into one folder. [r40](https://github.com/Altair571/homekitnew/releases/tag/r40) is known working, and [r41](https://github.com/Altair571/homekitnew/releases/tag/r41) is the pre-release.
2. Run the installer with your Scrypted server address:

   ```bash
   python3 Install-Scrypted-Plugin-r40.command --server https://your-scrypted-host:10443
   ```

   It checks the ZIP's SHA-256, asks for your Scrypted username and password (never saved), and uploads the ZIP to the existing HomeKit plugin.
3. Confirm the HomeKit plugin console shows the build, for example `hevc-fixes-2026-09-16-r40`.
4. In the camera's HomeKit settings, enable **Experimental: HEVC / 4K Streaming and HKSV (iOS/tvOS 27+)**.

Each release's `HEVC-TESTING.md` (in this repository: `R40-TESTING.md`, `R41-TESTING.md`) describes what to check after installing.

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

## Repository layout

| Path | Contents |
| --- | --- |
| `plugin/` | Plugin source exactly as shipped in the latest build (r41), taken from the release bundle's source map |
| `tests/` | Node test suite that runs against a built bundle, plus the installer tests |
| `build-r39-from-r38.py`, `build-r40-from-r39.py`, `build-r41-from-r40.py` | Incremental release builders. Each patches the previous checksum-locked release ZIP. |
| `build-r35-from-r34.py` | Shared helpers the builders import |
| `Install Scrypted Plugin.command` | The installer for the latest build (r41) |
| `R39-TESTING.md`, `R40-TESTING.md`, `R41-TESTING.md` | Release notes and test steps |

## Running the tests

This needs Node.js and Python 3. The tests match the latest build, so download `plugin-hevc-webrtc-r41.zip` from the r41 release into the repository root first.

```bash
npm ci
mkdir -p dist && unzip -o plugin-hevc-webrtc-r41.zip main.nodejs.js main.nodejs.js.map -d dist
HK_TEST_BUNDLE=dist/main.nodejs.js node --test tests/*.test.cjs
python3 tests/test_installer.py
```

## Credits

- The [Scrypted](https://github.com/koush/scrypted) HomeKit plugin is the base of this build. Upstream licenses apply.
- [werift](https://github.com/shinyoshiaki/werift-webrtc) is the WebRTC stack bundled in the plugin.
- camera.ui's work in [HAP-NodeJS PR 1132](https://github.com/homebridge/HAP-NodeJS/pull/1132) is the reference for the offer shape Apple's relay accepts.
