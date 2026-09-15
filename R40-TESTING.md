# r40: keep the WebRTC session through Apple's talkback reoffer

r39 got Front's HEVC video through Apple's relay for the first time. Your phone sent receiver reports and keyframe requests back, and the Home app showed a frame.

About 1.5 to 3 seconds later, the relay sent a reoffer that adds a talkback audio section (viewer to camera). r39 rejected any receive section and closed the session. That froze the picture on the first frame before audio had started. After a few failures, the Home app fell back to H.264 on the legacy service.

## What changed from r39

- **The talkback reoffer is accepted.** The plugin answers it with the added audio section as receive-only. Talkback audio is not played on the camera. Front's own video and audio stay send-only, and incoming video is still refused.
- **Media keeps running through the reoffer.** A reoffer that leaves the send negotiation unchanged no longer restarts FFmpeg, so the picture does not pause and audio start is not pushed back again.
- **Receive keys for the talkback stream are accepted** after that reoffer.

The r39 offer, SFrame, the 360p remote tier and everything else are unchanged.

## Test

1. Install `plugin-hevc-webrtc-r40.zip` with `Install Scrypted Plugin r40.command`. Confirm the HomeKit console shows `hevc-fixes-2026-09-16-r40`.
2. Turn Wi-Fi off on the iPhone. Open Front in Home and watch for at least 30 seconds, then close it. Try twice.
3. In the Scrypted HomeKit console, look for `HomeKit WebRTC reoffer answered: session …, running media kept, 1 talkback audio receiver(s) accepted (not played)`. There should be no `WebRTC reoffer failed`.
4. Turn Wi-Fi back on and open Front once at home.
5. Report whether video keeps moving and whether sound plays, away and at home. Paste the console from the first `WebRTC Solicit Offer` to about 30 seconds later.

The Home app may offer the microphone button. Talking to the camera is not implemented in this build.

If the picture still freezes after the `reoffer answered` line, the console's `answer-after-5s` and `r35-after-15s` diagnostics show whether the relay still acknowledges Front's video. That decides the next change.

## Validation and rollback

All JavaScript checks pass on this exact bundle; the exact count is recorded in the build manifest. Package generation is locked to the passing bundle and test-log hashes. To roll back, reinstall r39 with its installer.
