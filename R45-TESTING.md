# r45: the CMAF upload layout Apple's publishing point can route

r44 let the plugin upload HomeKit Secure Video clips to Apple itself, and the first real session
answered every request with HTTP 404: the hub provisioned a publishing point, a client certificate
and a Camera Key and commanded an upload, and Apple's edge refused the object layout r44 had
guessed, along with every other shape probed at the base URL. r45 changes what is uploaded and
where, and makes the next refusal, if there is one, say why.

Read [CMAF-UPLOAD.md](CMAF-UPLOAD.md) first. Its first section now records what that session
showed and where the new layout comes from.

## What changed from r44

- **The Push AV layout.** The plugin uploads the object layout the Matter Push AV Stream Transport
  cluster specifies for CMAF ingest, which Apple's iOS 27 HAP surface mirrors service for service:
  `PUT session_<N>/index.mpd`, then `session_<N>/<track>/<track>.init` for each track, then
  `session_<N>/<track>/segment_<S>.m4s` from 1001, then the complete manifest — with the reference
  camera's content types (`application/dash+xml`, `video/mp4`, `video/iso.segment`).
- **One CMAF track file per track.** The recorder's muxed fragmented MP4 is split into a `video`
  and an `audio` track before upload, copying sample bytes untouched. Camera Key protection applies
  to the split tracks exactly as it did to the muxed recording, under one key and one IV counter.
- **Two identifiers, then the truth.** The manifest is offered under the Clip ID first
  (`session_<clip>`); a 404 offers it under the Session ID (`session_<session id>`); a 405 switches
  the session to POST. Whichever the publishing point accepts carries the rest of the clip.
- **Refusals explain themselves.** Every non-2xx response is logged with its status, its headers
  (`server`, `content-type`, `x-apple-request-uuid`, `allow`, …) and the first 240 bytes of its body.
  The publishing point's token is abbreviated in every line because it is a credential.
- **The Camera Key length is called out.** The real key was 32 bytes; `cenc` assumes 16. An upload
  under such a key logs that a refusal of the media may be the protection, not the layout.

The setting is the same one, now titled **Experimental: HKSV CMAF Direct Upload (r45)**, with the
same three choices and the same default: `Off (default)` behaves exactly as r43 did.

Live view — at home and away, RTP and WebRTC, SFrame, every r43 send-path change — is untouched.

## Install

Put `plugin-hevc-webrtc-r45.zip` and `Install-Scrypted-Plugin-r45.command` in the same folder,
then:

```bash
python3 Install-Scrypted-Plugin-r45.command --server https://your-scrypted-host:10443
```

The installer checks the ZIP's SHA-256 against the tested build, asks for your Scrypted username
and password (never saved), and uploads the ZIP to the existing HomeKit plugin. To build the same
artifacts yourself instead — the build is deterministic, and the bundle is always
`7fc5e9c92f59a4c0a3a0b7be819ae3689ea7254a83b2993ac79a57a7a53bf6da`:

```bash
npm ci
curl -LO https://github.com/Altair571/homekitnew/releases/download/r43/plugin-hevc-webrtc-r43.zip
python3 build-r45-from-r43.py --verify-base
HK_TEST_BUNDLE=dist-r45/main.nodejs.js node --test --test-concurrency=2 tests/*.test.cjs
```

r45 builds from the r43 ZIP because r44 was never published as a release; `plugin/` carries both
releases' edits.

## Test

The useful question is still **how far down the sequence the hub gets** — and now, when Apple
refuses something, **what it says**.

1. Install r45 and confirm the HomeKit console shows `hevc-fixes-2026-09-16-r45`.
2. Turn on **Experimental: HKSV CMAF Direct Upload (r45)**. Start with `Unencrypted (diagnostic)`
   this time: it asks the one question r45 is about — does Apple route the layout — without the
   32-byte Camera Key question in the way. It uploads a readable clip to Apple over the
   mutually-authenticated connection, so turn it back off afterwards.
3. In the Home app, enable recording for the camera (Stream & Allow Recording), and make sure
   motion detection is on.
4. Walk in front of the camera, then wait a minute or two.
5. Paste every line from the camera's HomeKit console that starts with `HomeKit CMAF`,
   `HomeKit camera key`, `HomeKit HEVC recording buffer` or `CMAF`.

What those lines answer, in order:

| Line | What it settles |
| --- | --- |
| `HomeKit CMAF publishing point set: …` | the hub handed over a real Apple URL |
| `HomeKit camera key N provisioned (K bytes)` | **K is the key length.** The real one was 32; `cenc` assumes 16 |
| `HomeKit HEVC recording buffer ready: …` | everything an upload needs is provisioned |
| `CMAF upload session N started: clip C to …/session_C/…, then session_N/…` | **the hub asked for a clip** |
| `… publishing point accepted the manifest at …/session_C/index.mpd (Clip ID C, PUT)` | **Apple routes the Push AV layout**, keyed on the Clip ID |
| `… HTTP 404 for …/session_C/index.mpd … ; offering the manifest under Session ID N instead` | the Clip ID was refused; the Session ID is being tried |
| `… publishing point accepted the manifest at …/session_N/index.mpd (Session ID N, PUT)` | Apple keys the session on the Session ID |
| `… HTTP 405 … allow: …; switching to POST` | Apple wants POST, and the line names what else it allows |
| `CMAF session N: HTTP 404 for …/session_N/index.mpd (PUT, B bytes) — server: …; body: "…"` | both identifiers refused: the layout is still wrong, and **the body is the clue** |
| `CMAF session N: HTTP <status> for …/video/video.init …` | the manifest was accepted and the media was not: the headers or their content type |
| `CMAF session N uploaded K object(s), … ; PUT under Clip ID C at …` | a clip went up in full |

6. If the clear upload succeeds, switch to `Encrypted with the Camera Key (experimental)` and
   repeat. If the encrypted one is refused where the clear one was accepted, the layout is right
   and the protection reading is wrong — which, with a 32-byte key, is the expected outcome.
7. If no `CMAF upload session` line ever appears, the hub is not commanding uploads and nothing
   in this release applies yet. The `recording buffer idle` reason and the legacy
   `HomeKit iOS 27: controller wrote …` lines are the ones to paste.

## Validation

All 268 automated checks pass on this exact bundle, and packaging is locked to that run. (The two
live FFmpeg/WebRTC fixtures need a UDP receive buffer big enough for their 100-frame burst; on
Linux `sysctl -w net.core.rmem_default=4194304` is what the README prescribes, and without it
they fail on any build.)

Eleven of those checks cover r45's changes: the full provisioning sequence and an encrypted clip
arriving one track at a time in the reference camera's order, each track decrypting back to the
recorder's exact samples; an unencrypted clip whose objects are the split recording byte for byte;
each split track decoding in FFmpeg to the same streams as the muxed recording; the manifest's
template, timeline and KID; and a publishing point keyed on the Session ID, one that only allows
POST, one that forgets a header, and one that refuses everything, each producing the fallback, the
retry or the logged diagnosis the design describes.

Nothing here has run against Apple. See the last two sections of [CMAF-UPLOAD.md](CMAF-UPLOAD.md).

## Rollback

Reinstall r43 or r42, or set **Experimental: HKSV CMAF Direct Upload** back to `Off (default)`,
which restores r43's behaviour exactly without changing builds.
