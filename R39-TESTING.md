# r39: camera.ui's secure video offer

[HAP-NodeJS PR 1132](https://github.com/homebridge/HAP-NodeJS/pull/1132) reports remote HEVC live view working through Apple's relay. Its WebRTC side lives in camera.ui's HomeKit plugin.

That plugin's SFrame encryption, frame layout and packetization already match this one exactly. The differences are all in the WebRTC offer and the RTP header extensions, so r39 adopts camera.ui's offer. It is still a test build, not a confirmed fix.

## What changed from r38

- **Video bitrate in the offer.** The offer now carries `b=AS:190`, `b=TIAS:190000` and `max-br=190000`. camera.ui's code notes that the relay turns the offer into the viewer's media description, and a video stream without a bitrate arrives there as "no valid streams".
- **No RTP header extensions.** MID, RID and frame marking are no longer negotiated, so packets carry no extensions. The RID is still declared in the SDP (`a=extmap`, `a=rid:1 send max-width=640;max-height=360;max-fps=15;max-br=190000`, `a=simulcast:send 1`), exactly as camera.ui writes it.
- **No `a=sframe` lines.** SFrame keys still travel through the HomeKit characteristic, as in camera.ui.
- **IPv4 ICE only.**
- **The r37/r38 relay experiments are off.** There is no data channel and no variant rotation.

The 360p remote tier, camera input, pacing, SFrame, audio, and everything outside the WebRTC offer are unchanged.

## Test

1. Install `plugin-hevc-webrtc-r39.zip` with `Install Scrypted Plugin r39.command`. Confirm the HomeKit console shows `hevc-fixes-2026-09-16-r39`.
2. Turn Wi-Fi off on the iPhone. Open Front in Home and watch for about 20 seconds, then close it. Try twice, because every session now uses the same offer.
3. Turn Wi-Fi back on and open Front once at home. The new offer applies to local viewing too, so this confirms local viewing still works.
4. Report whether video and sound appeared, both away and at home.

If remote video still fails, the remaining difference from camera.ui is the service layout. camera.ui does not keep the legacy RTP streaming service on an HEVC camera.

## Validation and rollback

All JavaScript checks pass on this exact bundle; the exact count is recorded in the build manifest. Package generation is locked to the passing bundle and test-log hashes. To roll back, reinstall r36 with its installer.
