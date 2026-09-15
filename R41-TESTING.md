# r41: faster remote start and an optional 1080p remote stream

r40 plays Front's HEVC away from home, but it was slow to start. In the r40 console log:

- First video left the plugin 1.5 s after the stream request.
- Audio followed 3.8 s after the request.
- Keyframes came only every 2 seconds, so a viewer that joined after the first one could wait up to 2 more seconds for a picture.

## What changed from r40

- **Keyframes sooner.** Remote viewers get a keyframe every 0.5 s for the first 4 seconds, then every second (r40: every 2 seconds). A viewer that joins late waits at most half a second for a picture. This costs about a third more bitrate during the first 2 seconds.
- **Audio starts sooner.** The audio transcoder no longer spends about 3 seconds probing the camera's AAC before encoding. In local tests, the first Opus packet now leaves in well under a second.
- **Startup timing in the console.** Five seconds after each session is answered, the console prints one line, for example `HomeKit WebRTC startup: session …, answer 426 ms, connected 604 ms, first video 1463 ms, …`.
- **Optional 1080p remote stream.** The camera has a new setting, **Experimental: WebRTC Remote Resolution (r41)**.
  - `360p (default)` is what works today.
  - `1080p (experimental)` offers the camera's 1080p tier, at 30 fps and about 1.7 Mbps.
  - Apple may refuse 1080p for viewers on cellular, so try it on another Wi-Fi network first.

Remote streams are now always re-encoded, so their bitrate and keyframes stay under the plugin's control. LAN viewing is unchanged.

## Test

1. Install `plugin-hevc-webrtc-r41.zip` with `Install Scrypted Plugin r41.command`. Confirm the HomeKit console shows `hevc-fixes-2026-09-16-r41`.
2. Leave the new setting at 360p. Turn Wi-Fi off on the iPhone, open Front and watch for 20 seconds, then close it. Do this twice, and compare how long the picture and the sound take with r40.
3. Paste the `HomeKit WebRTC startup:` lines from the console.
4. Optional: set **Experimental: WebRTC Remote Resolution (r41)** to `1080p (experimental)` and repeat step 2 on cellular, and on another Wi-Fi network if you can. If the picture never appears, set it back to 360p.

## Validation and rollback

All JavaScript checks pass on this exact bundle; the exact count is recorded in the build manifest. Package generation is locked to the passing bundle and test-log hashes. To roll back, reinstall r40 with its installer.
