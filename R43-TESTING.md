# r43: the same picture, with less work per packet

r43 changes no media, no signaling, no setting and no default. Every offer, every
answer, every encrypted frame and every byte on the wire is what r42 sent. What
changed is how much the plugin does on its own event loop to put those bytes there.

At 4K the send path was spending more than half its time on diagnostics, on the same
thread that encrypts and sends the video.

## What changed from r42

- **Frame marking no longer rebuilds the SDP per packet.** The r36 frame-marking
  probe asked werift for the remote description once for every outgoing RTP packet,
  and werift's `remoteDescription` getter re-serializes the whole session description
  each time it is read. r43 resolves the negotiated extension IDs once per access
  unit and reuses them for that frame's packets. A renegotiation still takes effect
  on the next frame, because new extension IDs arrive with a new description, which
  restarts media.
- **The media probe verifies a startup budget, not the whole session.** The r35 probe
  independently authenticated, decrypted and digested every datagram the plugin sent,
  for as long as the session lasted — about as much work again per packet as sending
  it. r43 does that for the first 4000 packets of each stream and then stops. Its
  header, sequence, reception-report and timing counters are unchanged and still cover
  the whole session, so `firstInputAtMs`, `firstIrapAtMs`, the startup line and the
  r42 throughput line all read exactly as before. The diagnostic JSON now reports
  `verifiedPacketsPerStream` and counts what it skipped in `srtpVerifySkipped`.
- **Two fewer copies of every frame.** SFrame encryption concatenated the cipher
  output with an always-empty final block, copying the whole frame again, and HEVC
  access unit assembly copied a defragmented NAL a second time. Each slice is now one
  allocation and one copy instead of a concatenation of two.
- **Smaller per-packet costs.** The contract observer resolves its SDP sections and
  the MID/RID values it compares once per description instead of once per packet. The
  remote pacer reads a monotonic clock without allocating a BigInt for every packet.
  The RTSP server maps an interleaved channel to its track instead of walking the
  track list for every packet it reads — that one is on every path, at home and away.

## Measured

Node 22 on a 4-core Linux container, replaying 10 s of HEVC through SFrame, frame
marking, the contract observer, real werift SRTP and the media probe, against the
r42 and r43 bundles in turn:

| Stream | r42 | r43 |
| --- | --- | --- |
| 360p, ~0.8 Mbps | 2.3% of one core | 2.0% |
| 1080p, ~4 Mbps | 5.1% of one core | 3.6% |
| 4K, ~12 Mbps | 12.3% of one core | 6.0% |

Low bitrates gain least: at 360p a 10 s session never reaches the verification
budget, so its saving is the frame-marking and copy work alone. The saving grows
with bitrate, which is where it was needed.

This is the plugin's own per-packet work. It is not the x265 encode, which still
dominates any re-encoded remote stream, and it was measured on an idle container
rather than on a Scrypted host.

## Test

1. Install `plugin-hevc-webrtc-r43.zip` with `Install Scrypted Plugin r43.command`.
   Confirm the HomeKit console shows `hevc-fixes-2026-09-16-r43`.
2. At home, open the camera. The picture should appear as it did on r42.
3. Away from home, open the camera at your usual remote resolution for about 20
   seconds, then at 1080p or 4K if you use them. Paste the
   `HomeKit WebRTC remote video plan:`, `HomeKit WebRTC startup:` and
   `HomeKit WebRTC throughput:` lines.
4. Compare those three lines with the r42 lines for the same settings. Startup times
   and the reported frame rate and bitrate should match r42; relay loss should be the
   same or lower. If your host's CPU was the limit before, the frame rate on a
   re-encoded 1440p or 4K stream may now be closer to 30 fps.
5. If you look at the diagnostic JSON: `srtpVerified` stops at 4000 per stream and
   `srtpVerifySkipped` counts the rest. That is the change, not a fault.

Anything that looks different in the picture, the startup times or the relay loss is
a regression — r43 is meant to be indistinguishable except for host CPU.

## Validation and rollback

All JavaScript checks pass on this exact bundle; the exact count is recorded in the
build manifest. Package generation is locked to the passing bundle and test-log
hashes. To roll back, reinstall r42 with its installer.
