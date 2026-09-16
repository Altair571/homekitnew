Pre-release. r44 implements the iOS 27 CMAF direct upload path: the plugin posts HomeKit Secure Video clips to Apple's publishing point itself, with no Apple TV or HomePod in the media path. It is **off by default** — with the setting left alone, r44 behaves exactly as r43 does. All 261 automated checks pass, but nothing in this release has run against Apple's own publishing point, so r42 remains the known-working build.

## What this is

On iOS/tvOS 27 the camera uploads its own clips. A home hub still decides when to record — it writes the destination and the credentials over HAP, then sends upload commands — but it is no longer in the media path. Under the legacy path the hub received fragmented MP4 over the HAP Data Stream and did the uploading. Scrypted is the accessory here, so the plugin has to make that HTTPS connection.

r43 could not: it refused every upload the moment a Camera Key was provisioned, because Apple's [HomeKit Secure Video Open Source Compatibility Guide](https://developer.apple.com/download/files/HomeKit-Secure-Video-Open-Source-Compatibility-Guide.pdf) (rev. 2026-06-03) defines that key and never says how it protects the media.

**[CMAF-UPLOAD.md](https://github.com/Altair571/homekitnew/blob/main/CMAF-UPLOAD.md) sets out exactly which parts of this are specified by Apple and which are inference.** That distinction is the whole story of this release — read it first.

## Changes from r43

- **The ingest client follows DASH-IF Interface-1.** r43 streamed a clip through one chunked POST. r44 posts one CMAF object per request over a kept-alive, mutually-authenticated connection: a connectivity probe, then `init.mp4`, then `1.m4s`, `2.m4s`, …, then an empty `mfra` to close the clip. A publishing point answering 412 — the guide's "HTTP Init Missing" — gets the header again and the fragment is retried. Apple's field is named `publishing_point_url` and its error enumeration reads as that protocol's HTTP surface, which is what points here.
- **Camera Key protection.** A new module applies MPEG Common Encryption (`cenc`, AES-128-CTR) to the init segment and every fragment: HEVC with subsample encryption so each NAL unit's length prefix and header stay clear, AAC whole, the Key Number as the KID, and per-sample IVs from a counter reserved before the clip starts so a power cut cannot reuse one. CTR preserves sample sizes, so the recording is encrypted rather than remuxed.
- **A new setting.** **Experimental: HKSV CMAF Direct Upload (r44)** chooses `Off (default)`, `Encrypted with the Camera Key (experimental)` or `Unencrypted (diagnostic)`.
- **The console names every step**: what the hub provisioned, why the recording buffer is idle or ready, each object's URL and HTTP status, and a per-clip summary.

Live view — at home and away, RTP and WebRTC, SFrame, every r43 send-path change — is untouched.

## What has been tested

Against a publishing point that requires the client certificate the plugin was issued and returns 412 for a clip whose header it lost: the full provisioning sequence through the real HAP characteristics, an encrypted clip that decrypts with the Camera Key back to the recorder's exact bytes, an unencrypted clip that is byte-for-byte what the recorder produced, the header-recovery path, and the IV and NAL-header invariants of the encryption.

Not tested: anything against Apple. No publishing point URL, server CA set or client certificate for one exists outside a real pairing.

## Install

Download both files below into the same folder, then run:

```bash
python3 Install-Scrypted-Plugin-r44.command --server https://your-scrypted-host:10443
```

The HomeKit console then shows `hevc-fixes-2026-09-16-r44`. To roll back, install r43 or r42 the same way, or just set the upload setting back to `Off (default)`. `HEVC-TESTING.md` inside the ZIP lists the test steps and, more importantly, what each console line settles.

## Checksums (SHA-256)

```
84664a7d02adb00815eb63f7bc0ca491bd41da67857e114313c5080b29b66115  plugin-hevc-webrtc-r44.zip
ac601b6dc59a821a6ca20e50967b6b824e7b0aee2fb8e9b977c21e23ae93f912  Install-Scrypted-Plugin-r44.command
```

All 261 automated checks passed on this exact bundle. The build is deterministic: rebuilding from the checksum-locked r43 ZIP with `build-r44-from-r43.py` gives the same bundle and the same archive.
