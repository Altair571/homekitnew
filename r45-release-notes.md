Pre-release. r45 changes what the iOS 27 CMAF direct upload sends and where. The first real session on r44 showed Apple's publishing point answering **HTTP 404 to every request** — the layout r44 had guessed and every other shape probed beside it — so r45 uploads the object layout the Matter Push AV Stream Transport cluster specifies for CMAF ingest, which Apple's iOS 27 HAP surface mirrors service for service, and logs exactly what Apple says to any request it refuses. The setting is still **off by default**; left alone, r45 behaves exactly as r43 does. r42 remains the known-working build.

## What changed

- **The Push AV layout.** `PUT session_<N>/index.mpd`, then `session_<N>/<track>/<track>.init` per track, then `session_<N>/<track>/segment_<S>.m4s` from 1001, then the complete manifest, with the Matter reference camera's content types. The manifest is offered under the Clip ID first and, if that gets a 404, under the Session ID; a 405 switches the session to POST.
- **One CMAF track file per track.** The recorder's muxed fragmented MP4 is split into `video` and `audio` tracks before upload, sample bytes untouched; each split track decodes in FFmpeg to the same streams as the muxed recording. Camera Key protection applies to the split tracks under one key and one IV counter.
- **Refusals explain themselves.** Every non-2xx response is logged with its status, headers (`x-apple-request-uuid` included) and the first 240 bytes of its body. The token in the publishing point's path is abbreviated because it is a credential.
- **The Camera Key length is called out.** The real key was 32 bytes; `cenc` assumes 16. An upload under such a key says so, because a refusal of the media may then be the protection rather than the layout. The recommended first test is therefore `Unencrypted (diagnostic)`, which isolates the layout question.

**[CMAF-UPLOAD.md](https://github.com/Altair571/homekitnew/blob/main/CMAF-UPLOAD.md)** records the real session and where the new layout comes from. **[R45-TESTING.md](https://github.com/Altair571/homekitnew/blob/main/R45-TESTING.md)** says which console line settles which question.

Live view — at home and away, RTP and WebRTC, SFrame, every r43 send-path change — is untouched.

## What has been tested

Against a publishing point that speaks the Push AV layout and requires the provisioned client certificate: the full provisioning sequence and an encrypted clip arriving one track at a time in the reference camera's order, each track decrypting back to the recorder's exact samples; an unencrypted clip whose objects are the split recording byte for byte; the manifest; and a point keyed on the Session ID, one that only allows POST, one that forgets a header and one that refuses everything, each producing the fallback, the retry or the logged diagnosis described above.

Not tested: anything against Apple beyond the r44 session that ruled the old layout out. Whether Apple routes this layout, which identifier it keys on, whether it needs HTTP/2, and what a 32-byte Camera Key means, are what the next real session answers.

## Install

Download both files below into the same folder, then run:

```bash
python3 Install-Scrypted-Plugin-r45.command --server https://your-scrypted-host:10443
```

The HomeKit console then shows `hevc-fixes-2026-09-16-r45`. To roll back, install r43 or r42 the same way, or just set the upload setting back to `Off (default)`. `HEVC-TESTING.md` inside the ZIP lists the test steps and what each console line settles.

## Checksums (SHA-256)

```
91f2b8ac9562ba65904d110b6fd85f8c4490c94f197b1c32ae261ade656fa2d1  plugin-hevc-webrtc-r45.zip
487fb76b023da925062c45c9604ea23aecef1606a767a56048150d4236fe3695  Install-Scrypted-Plugin-r45.command
```

All 268 automated checks passed on this exact bundle. The build is deterministic: rebuilding from the checksum-locked r43 ZIP with `build-r45-from-r43.py` gives the same bundle (`7fc5e9c92f59a4c0a3a0b7be819ae3689ea7254a83b2993ac79a57a7a53bf6da`) and the same archive.
