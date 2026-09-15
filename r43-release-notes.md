Pre-release. r43 sends exactly what r42 sends — no media, signaling, setting or default changes — and removes work the plugin was doing per packet on its own event loop. It has passed all 256 automated checks but has not yet been watched on a camera, so r42 remains the known-working build.

## Changes from r42

- **Frame marking** resolved its negotiated extension IDs once per outgoing RTP packet, and each of those reads made werift re-serialize the whole remote SDP. It now resolves them once per access unit.
- **The media probe** independently authenticated, decrypted and digested every datagram for the life of the session. It now verifies the first 4000 packets of each stream, where a fault shows, and reports `verifiedPacketsPerStream` and `srtpVerifySkipped`. Its header, sequence, reception-report and timing counters are unchanged, so the startup line, the r42 throughput line and the relay evidence read as before.
- **SFrame encryption and HEVC assembly** drop two full-frame copies per frame, and each slice is one allocation and one copy.
- **The contract observer** resolves its SDP sections once per description, the remote pacer reads a monotonic clock without allocating a BigInt per packet, and the RTSP server maps an interleaved channel to its track instead of walking the track list — that last one is on every path, at home and away.

## Measured

Replaying 10 s of HEVC through SFrame, frame marking, the contract observer, real werift SRTP and the probe, on the r42 and r43 bundles in turn (Node 22, 4-core Linux):

| Stream | r42 | r43 |
| --- | --- | --- |
| 360p, ~0.8 Mbps | 2.3% of one core | 2.0% |
| 1080p, ~4 Mbps | 5.1% | 3.6% |
| 4K, ~12 Mbps | 12.3% | **6.0%** |

This is the plugin's own per-packet work, not the x265 encode, and it was measured on an idle machine rather than a Scrypted host. If your host's CPU was the limit, a re-encoded 1440p or 4K stream may now hold a higher frame rate; otherwise nothing should look different.

## Install

Download both files below into the same folder, then run:

```bash
python3 Install-Scrypted-Plugin-r43.command --server https://your-scrypted-host:10443
```

The HomeKit console then shows `hevc-fixes-2026-09-16-r43`. To roll back, install r42 the same way. `HEVC-TESTING.md` inside the ZIP lists the test steps.

## Checksums (SHA-256)

```
a439c965f28d7691efddbcda2c4f8f4ab925957d9f7dc196b911474cd503642a  plugin-hevc-webrtc-r43.zip
cc41cf15fc2d3573d3feaa63fba33d01a53f509e9dea58f91e822d7cee2857b7  Install-Scrypted-Plugin-r43.command
```

All 256 automated checks passed on this exact bundle. The build is deterministic: rebuilding from the checksum-locked r42 ZIP with `build-r43-from-r42.py` gives the same bundle and the same archive.
