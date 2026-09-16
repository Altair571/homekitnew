# r44: iOS 27 CMAF direct upload

On iOS/tvOS 27 a HomeKit Secure Video camera uploads its own clips straight to Apple. The home
hub still writes the destination and sends the upload commands over HAP, but it is no longer in
the media path — so Scrypted, which is the accessory, makes that HTTPS connection itself.

r43 could not: it refused every upload the moment a Camera Key was provisioned, because Apple's
open-source guide defines the key but never says how it protects the media. r44 implements the
reading that fits, behind a setting that is off by default.

Read [CMAF-UPLOAD.md](CMAF-UPLOAD.md) first. It sets out exactly which parts of this are
specified by Apple and which are inference — that distinction is the whole story of this release.

## What changed from r43

- **The ingest client follows DASH-IF Interface-1.** r43 streamed the whole clip through one
  chunked POST. r44 posts one CMAF object per request over a kept-alive, mutually-authenticated
  connection: a connectivity probe, then `init.mp4`, then `1.m4s`, `2.m4s`, …, then an empty
  `mfra` to close the clip. A publishing point that answers 412 (the guide's "HTTP Init Missing")
  gets the header again and the fragment is retried.
- **Camera Key protection.** A new module applies MPEG Common Encryption (`cenc`, AES-128-CTR) to
  the init segment and every fragment: HEVC with subsample encryption so each NAL unit's length
  prefix and header stay clear, AAC whole, the Key Number as the KID, and per-sample IVs from a
  counter reserved before the clip starts so a power cut cannot reuse one.
- **A new setting, off by default.** **Experimental: HKSV CMAF Direct Upload (r44)** chooses
  between `Off (default)`, `Encrypted with the Camera Key (experimental)` and
  `Unencrypted (diagnostic)`. Off behaves exactly as r43 did.
- **The console names what is missing.** The recording buffer logs why it is idle and when it
  becomes ready, and every upload logs its URL, its HTTP status and a per-clip summary.

Live view — at home and away, RTP and WebRTC, SFrame, every r43 send-path change — is untouched.

## Install

Put `plugin-hevc-webrtc-r44.zip` and `Install-Scrypted-Plugin-r44.command` in the same folder,
then:

```bash
python3 Install-Scrypted-Plugin-r44.command --server https://your-scrypted-host:10443
```

The installer checks the ZIP's SHA-256 against the tested build, asks for your Scrypted username
and password (never saved), and uploads the ZIP to the existing HomeKit plugin. To build the same
artifacts yourself instead — the build is deterministic, and the bundle is always
`65e910ad8a71cfe27a98c3feb7564c9ac7d6fddd601c1232ae2b2fc6470a9700`:

```bash
npm ci
curl -LO https://github.com/Altair571/homekitnew/releases/download/r43/plugin-hevc-webrtc-r43.zip
python3 build-r44-from-r43.py --verify-base
HK_TEST_BUNDLE=dist-r44/main.nodejs.js node --test --test-concurrency=2 tests/*.test.cjs
```

## Test

The useful question is not "does a clip appear in the Home app" — it probably will not on the
first try. It is **how far down the sequence the hub gets**, because that is what nobody outside
Apple knows.

1. Install r44 and confirm the HomeKit console shows `hevc-fixes-2026-09-16-r44`.
2. Turn on **Experimental: HKSV CMAF Direct Upload (r44)**. Start with
   `Encrypted with the Camera Key (experimental)`.
3. In the Home app, enable recording for the camera (Stream & Allow Recording), and make sure
   motion detection is on.
4. Walk in front of the camera, then wait a minute or two.
5. Paste every line from the camera's HomeKit console that starts with `HomeKit CMAF`,
   `HomeKit camera key`, `HomeKit HEVC recording buffer` or `CMAF`.

What those lines answer, in order:

| Line | What it settles |
| --- | --- |
| `HomeKit CMAF publishing point set: …` | the hub handed over a real Apple URL |
| `HomeKit camera key N provisioned (K bytes)` | **K is the key length.** `cenc` assumes 16; anything else means the protection guess is wrong |
| `HomeKit HEVC recording buffer ready: …` | everything an upload needs is provisioned |
| `HomeKit HEVC recording buffer idle: <reason>` | what is still missing, if it never became ready |
| `CMAF upload session N started: …` | **the hub actually asked for a clip.** In the r40 logs it never did |
| `… publishing point probe returned HTTP <status>` | the first thing Apple's server says to this camera |
| `CMAF session N: HTTP <status> for <path>` | whether Apple accepts the object layout |
| `CMAF session N uploaded N object(s), … bytes` | a clip went up in full |

6. If the upload fails with a 4xx, switch the setting to `Unencrypted (diagnostic)` and repeat.
   That separates the two guesses: if the clear upload is accepted and the encrypted one is not,
   the object layout is right and the protection is wrong. It uploads a readable clip to Apple
   over the mutually-authenticated connection, so turn it back off afterwards.
7. If no `CMAF upload session` line ever appears, the hub is not commanding uploads and nothing
   in this release applies yet. The `recording buffer idle` reason and the legacy
   `HomeKit iOS 27: controller wrote …` lines are the ones to paste.

## Validation

All 261 automated checks pass on this exact bundle, and packaging is locked to that run. (The two
live FFmpeg/WebRTC fixtures need a UDP receive buffer big enough for their 100-frame burst; on
Linux `sysctl -w net.core.rmem_default=4194304` is what the README prescribes, and without it
they fail on any build.)

Five of those checks are new and cover the upload end to end against a publishing point
that requires the client certificate the plugin was issued: the full provisioning sequence
through the real HAP characteristics, an encrypted clip that decrypts back to the recorder's
exact bytes, an unencrypted clip that is byte-for-byte what the recorder produced, the 412
header-recovery path, and the IV and NAL-header invariants of the encryption.

Nothing here has run against Apple. See the last section of [CMAF-UPLOAD.md](CMAF-UPLOAD.md).

## Rollback

Reinstall r43, or set **Experimental: HKSV CMAF Direct Upload** back to `Off (default)`, which
restores r43's behaviour exactly without changing builds.
