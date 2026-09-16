# iOS 27 CMAF direct upload: what is specified, and what is not

On iOS/tvOS 27 a HomeKit Secure Video camera uploads its own clips. A home hub still decides
*when* to record — it writes the destination and the credentials over HAP, then sends upload
commands — but the media goes straight from the accessory to Apple, with no Apple TV or HomePod
in the path. Under the legacy path the hub received fragmented MP4 from the camera over the HAP
Data Stream and did the uploading itself.

Scrypted is the accessory here, so this plugin makes that HTTPS connection.

## The source

Apple published the [HomeKit Secure Video Open Source Compatibility
Guide](https://developer.apple.com/download/files/HomeKit-Secure-Video-Open-Source-Compatibility-Guide.pdf)
(Developer Preview, version 1.0, 2026-06-03) — 37 pages, and the only public description of this
surface. It is what every section reference in the plugin's source points at.

## What the guide specifies

| § | Characteristic | What it gives |
| --- | --- | --- |
| 4.13 | Camera Recording Publishing Point | `publishing_point_url` (must end in a trailing slash) and the server CA certificates that anchor its TLS certificate |
| 4.25 | Camera Client CSR | the controller writes a 32-byte nonce; the accessory answers with a DER CSR and an EC signature over the nonce |
| 4.26 | Camera Client Certificate | the issued client certificate and its CA, both DER |
| 4.27 | Camera Client Certificate Status | a Needs Update flag |
| 4.7 | Camera Key | `Key` (data) and `Key Number` (uint64) |
| 4.8 | Camera Key ID | the key's identifier, published back to the controller |
| 4.9 | Buffer Upload Command | Session ID, Start/StartAndStop/Stop, start and stop timestamps, Pause or Finalize; the response carries a Clip ID |
| 4.10 | Buffer Activity Command | should-record windows |
| 4.11 | Buffer Event Command | the event queue, including CMAF Session Start/Stop and a 27-value CMAF Error enumeration |

That is enough to build the whole provisioning handshake, and this plugin implements all of it.

## What the guide does not specify

Two things, both of which the upload cannot happen without.

**1. How the media reaches the publishing point.** The guide names no HTTP verb, no path layout
under the publishing point, and no media type. It never mentions fragmented MP4, segment naming
or how a clip is closed.

What it does do is borrow DASH-IF's vocabulary. The field is called `publishing_point_url`, the
trailing-slash requirement is DASH-IF's, and the §4.11 error list reads as that protocol's HTTP
surface — `HTTP Init Missing` is the 412 a publishing point returns when a media object arrives
before the CMAF Header for its track, which can only happen when objects are posted separately
rather than streamed through one request. `HTTP Invalid Token`, `HTTP Mismatched Token`,
`HTTP Camera Zone Disabled` and `HTTP Camera Zone Does Not Exist` all suggest the URL the
controller hands over already carries a token and a camera identifier.

r44 implemented the [DASH-IF Live Media Ingest Protocol](https://dashif.org/Ingest/) Interface 1
with a guessed object path: `POST {publishing_point_url}{clip}/init.mp4`, then `{clip}/{n}.m4s`,
then an empty `mfra`. **The first real session (2026-09-16) ruled that out.** The hub provisioned
everything — a publishing point of the form
`https://video-ingest-mr.icloud-content.com/v1/<719-character token>/` with two DigiCert roots, a
60-day client certificate, and a Camera Key — and commanded an upload, and Apple's edge answered
**HTTP 404 to every request**: GET, HEAD, OPTIONS, PUT and POST on the publishing point itself,
and PUT or POST of a CMAF Header at `init.mp4`, `{clip}/init.mp4`, `{clip}`, `Streams({clip})`
and `{session}/init.mp4`. The base path is not itself a resource, and none of those guesses is
the sub-path Apple routes.

r45 uploads the one object layout that a published camera specification defines for CMAF ingest:
the **Matter Push AV Stream Transport** cluster's. Apple's iOS 27 HAP surface is that cluster
family carried over to HAP service for service — the WebRTC solicit-offer / provide-answer flow,
the client-certificate CSR and provisioning characteristics, the buffer upload and activity
commands, the motion zones — and the reference camera in
[project-chip/connectedhomeip](https://github.com/project-chip/connectedhomeip/tree/master/examples/camera-app/linux)
is the client any Push AV ingest server, Apple's included if it takes Matter cameras, is
validated against. That camera uploads, over mutual TLS and one object per request:

```
PUT {publishing_point_url}session_{N}/index.mpd                 application/dash+xml, first and last
PUT {publishing_point_url}session_{N}/{track}/{track}.init      video/mp4, one CMAF Header per track
PUT {publishing_point_url}session_{N}/{track}/segment_{S}.m4s   video/iso.segment, S from 1001
```

Tracks are named `video` and `audio`; the manifest is a static DASH MPD with a SegmentTemplate
naming those objects and a SegmentTimeline of the segments uploaded so far. r45 follows that
exactly, including the reference camera's content types and its order (manifest, headers,
segments, complete manifest). To do so it splits the recorder's muxed fragmented MP4 into one
CMAF track file per track — a CMAF track holds one track by definition, and the layout names
objects per track — copying sample bytes untouched and re-pointing the track runs
(`plugin/src/types/camera/hksv-cmaf-tracks.ts`).

What that layout leaves open is which identifier `N` is. Matter's camera assigns its CMAF
session number itself, which is what the §4.9 Clip ID is here; the Session ID is the
controller's. So the manifest is offered under `session_{clip}` first and, if the publishing
point answers 404, under `session_{session id}`; a 405 switches the session to POST. Every
refusal is logged with its status, its headers (`x-apple-request-uuid` included) and the start
of its body, so the next real session shows what Apple's publishing point expects even if this
layout is refused too.

**2. How the Camera Key protects the media.** This is the larger gap. The guide defines the key
and its identifier, and says both services exist "as a part of the CMAF Ingest provisioning
process" — and then never refers to either again. Nothing describes encryption, and the CMAF
Error enumeration has no decryption failure to reason backwards from.

That a key exists at all is the strongest evidence for what it is for. The legacy path had no
camera key, because the Apple TV encrypted the clip for iCloud. Direct upload removes the Apple
TV, so the clip has to leave the accessory already encrypted for the user, and the Camera Key is
the only key the accessory is given.

r44 reads that as MPEG Common Encryption (ISO/IEC 23001-7):

- **scheme `cenc`** (AES-128-CTR). CTR preserves sample sizes, so every `trun` sample size, `tfhd`
  default and `mdat` length in the recording stays valid — the recording only has to be
  encrypted, not remuxed. A CBC scheme would not have that property.
- **subsample encryption for HEVC**, leaving each NAL unit's 4-byte length prefix and 2-byte
  header clear, which §9.6.2 requires for video in ISO BMFF. AAC is encrypted whole.
- **`default_KID` = the Key Number**, big-endian in the low 8 bytes of the 16-byte KID. The Key
  Number is the only key identifier the guide gives, and §4.8 exists to publish it back to the
  controller — which is what a player needs to ask for the right key.
- **8-byte per-sample IVs from a counter** that is reserved before a clip starts and never
  handed back, so a host that loses power mid-clip cannot resume on an IV it already spent.

This reading is unverified against Apple, and the first real session gave it its first
evidence: **the Camera Key the hub provisioned was 32 bytes**, where `cenc` is defined for 16
(AES-128). r44's module uses the first 16 and reports the length; r45 leaves that unchanged but
says so in the console when an upload starts, because a refusal of the media under a 32-byte key
may be the protection rather than the layout. What a 32-byte key means is open — AES-256 in
Apple's own clip format (its security guide describes HKSV clips as AES-256-GCM), or a key from
which per-clip keys are derived — and none of those can be built without the guide saying so.
The unencrypted diagnostic mode is what separates the two questions: if the clear upload is
accepted and the encrypted one is not, the layout is right and the protection is wrong. If the
reading is wrong, the difference stays confined to
`plugin/src/types/camera/hksv-cmaf-protection.ts`: the scheme, the IV size and the KID derivation
are the only choices it makes.

## What has been tested, and what has not

Tested, in `tests/cmaf-upload.test.cjs` and `tests/cmaf-tracks.test.cjs`, against a publishing
point that speaks the Push AV layout, requires the client certificate the plugin was issued, and
returns 412 for a track whose header it has not seen:

- the full provisioning sequence through the real HAP characteristics — publishing point, CSR,
  certificate, Camera Key — then a Buffer Upload Command, with the clip arriving at the far end
  one track at a time, in the reference camera's order and with its content types;
- the accessory's own hand-built CSR verifies in OpenSSL and is signed into a working
  mutual-TLS identity;
- each reassembled track is an `encv` or `enca` CMAF Header with a `cenc` `sinf`, and decrypting
  it with the Camera Key returns the recorder's exact samples; the manifest names the objects and
  announces the KID;
- each split track decodes in FFmpeg to the same streams as the muxed recording, with no sample
  byte lost or duplicated;
- a publishing point keyed on the Session ID is found after the Clip ID is refused; one that
  only allows POST gets it after a 405; one that lost a header gets it again and the fragment is
  retried; one that refuses everything ends the session with a CMAF Error of HTTP Not Found and
  its headers and body in the console;
- IVs never repeat and NAL headers stay clear.

Not tested: anything against Apple beyond the one r44 session that ruled the DASH-IF layout
out. Whether Apple's publishing point routes the Push AV layout, which identifier it keys the
session on, whether it needs HTTP/2 (it negotiates `h2` when offered; r45 speaks HTTP/1.1), and
whether `cenc` under a 32-byte Camera Key is the right protection, are what the next real
session answers.

## Reading a real session

With the setting on, the plugin's console prints, in order:

- `HomeKit CMAF publishing point set: <origin> (N server CA cert(s))` — §4.13 arrived.
- `HomeKit CMAF client CSR issued` then `HomeKit CMAF client certificate provisioned` — §4.25/§4.26.
- `HomeKit camera key N provisioned (K bytes)` — §4.7. **The byte count matters**: `cenc` uses 16;
  the one real key so far was 32.
- `HomeKit HEVC recording buffer ready: …` — everything an upload needs is in place. If this does
  not appear, `HomeKit HEVC recording buffer idle: <reason>` names what is missing.
- `CMAF upload session N started: clip C to <origin>/…/session_C/…, then session_N/…` — a §4.9
  command arrived. **If this never appears, the hub is not asking for uploads**, and no amount of
  upload code will help. A Camera Key that is not 16 bytes is called out right after it.
- `CMAF session N: publishing point accepted the manifest at /v1/…/session_C/index.mpd (Clip ID C, PUT)`
  — the layout is routed. Or `CMAF session N: HTTP 404 for …/session_C/index.mpd (PUT, B bytes) — server: …;
  x-apple-request-uuid: …; body: "…"; offering the manifest under Session ID N instead` — the
  first identifier was refused and the second is being tried.
- `CMAF session N: HTTP <status> for <path> (PUT, B bytes, Camera Key protected)` — the first
  object, then one summary line per clip: `CMAF session N uploaded K object(s), B bytes in T ms;
  PUT under Clip ID C at <origin>`.

A refusal is one line: `CMAF session N: HTTP <status> for <path> (<method>, <bytes>) — <the
diagnostic headers>; body: "<its first 240 bytes>"`. The token in the publishing point's path is
abbreviated in every line, as `CpQEQV…(719)`, because it is a credential.

Anything the publishing point refuses also becomes a §4.11 CMAF Error in the camera's event
queue, which is what the controller sees.
