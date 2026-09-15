# r42: 2K and 4K remote options, and a higher 1080p bitrate

r41 plays Front away from home at 360p and at 1080p. In the r41 console log from 2026-09-16 06:38:

- **360p:** the first video left the plugin 1.6 s after the stream request, and audio 0.9 s after it (r40: 1.5 s and 3.8 s).
- **1080p:** Apple's relay accepted the stream and it played. It was re-encoded at only 1.7 Mbps from the camera's 2.5 Mbps 1080p stream, so it looked soft.

## What changed from r41

- **More resolutions.** **Experimental: WebRTC Remote Resolution (r42)** adds `1440p / 2K (experimental)` and `2160p / 4K (experimental)`. 360p is still the default, and a 1080p choice made in r41 carries over.
- **New bitrate setting.** **Experimental: WebRTC Remote Video Bitrate (r42)** applies to every resolution above 360p:
  - `Automatic (default)` re-encodes 1080p at 4 Mbps (r41: 1.7 Mbps) and 1440p at 6 Mbps. At 4K it sends the camera's own 4K stream unchanged.
  - `Camera stream, no re-encode` sends the camera's stream as it is, when the camera has one at exactly the chosen resolution. For 1080p that is the 2.5 Mbps substream; for 4K it is the main stream. It gives the most detail and uses no CPU, but the picture waits for the camera's next keyframe, so it starts more slowly. The camera has no 1440p stream, so 1440p still re-encodes.
  - `2 Mbps` to `16 Mbps` always re-encode at that bitrate.
- **Where 1080p detail comes from.** 1080p is re-encoded from the camera's 2.5 Mbps 1080p stream. Above about 4 Mbps a re-encode can't look better than that stream, and `Camera stream` shows the stream itself.
- **CPU.** 1440p scales down the 4K stream. Above 1080p, x265 now picks its own thread count instead of using two threads.
- **Throughput line.** 15 seconds after each session is answered, the console prints one line with the frame rate and bitrate actually sent and the loss the relay reports, for example `HomeKit WebRTC throughput: session …, 1080p 1920x1080, re-encoded at 4000 kbps (Automatic); video 30.0 fps, 3980 kbps over 10.0 s, relay loss 0%`. It flags a re-encode that falls below its frame rate.
- **Offer.** Each offer declares the chosen resolution and bitrate. A camera stream is declared at 1.5 times the bitrate the camera reports. 360p is unchanged from r41.

## Test

1. Install `plugin-hevc-webrtc-r42.zip` with `Install Scrypted Plugin r42.command`. Confirm the HomeKit console shows `hevc-fixes-2026-09-16-r42`.
2. Away from home (cellular, or another Wi-Fi network), open Front for about 20 seconds with each combination below. Change the two settings between views:
   1. 1080p, Automatic. Is it sharper than r41's 1080p?
   2. 1080p, Camera stream. Is it sharper still, and how much longer does it take to start?
   3. 4K, Automatic (the camera's own 4K stream). Does a picture appear?
   4. 1440p, Automatic. Does a picture appear, and does the throughput line reach 30 fps?
3. For each view, paste the `HomeKit WebRTC remote video plan:`, `HomeKit WebRTC startup:` and `HomeKit WebRTC throughput:` lines, and say which looked best.

If a resolution never shows a picture, Apple probably refused it. Set the resolution back to 1080p or 360p.

## Validation and rollback

All JavaScript checks pass on this exact bundle; the exact count is recorded in the build manifest. Package generation is locked to the passing bundle and test-log hashes. To roll back, reinstall r41 with its installer.
