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

So r44 implements the [DASH-IF Live Media Ingest Protocol](https://dashif.org/Ingest/),
Interface 1 (CMAF ingest): one HTTP POST per CMAF object over a kept-alive,
mutually-authenticated connection, opening with DASH-IF's empty connectivity probe and closing
with its empty `mfra`. The object *path* under the publishing point is the guessed part:

```
POST {publishing_point_url}                      empty, the connectivity probe
POST {publishing_point_url}{clip}/init.mp4       the CMAF Header
POST {publishing_point_url}{clip}/{n}.m4s        each CMAF fragment, in order
POST {publishing_point_url}{clip}/               an empty mfra closes the clip
```

`{clip}` is the Clip ID the accessory returned in the §4.9 response, which is the only identifier
both ends share for that recording. Every request logs its URL and status, so one real session
shows what Apple's publishing point actually expects.

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

This reading is unverified against Apple. If it is wrong, the difference is confined to
`plugin/src/types/camera/hksv-cmaf-protection.ts`: the scheme, the IV size and the KID derivation
are the only choices it makes.

## What has been tested, and what has not

Tested, in `tests/cmaf-upload.test.cjs`, against a publishing point that requires the client
certificate the plugin was issued and returns 412 for a clip whose header it has not seen:

- the full provisioning sequence through the real HAP characteristics — publishing point, CSR,
  certificate, Camera Key — then a Buffer Upload Command, with the clip arriving at the far end;
- the accessory's own hand-built CSR verifies in OpenSSL and is signed into a working
  mutual-TLS identity;
- the reassembled clip's tracks are `encv`/`enca` with a `cenc` `sinf`, and decrypting it with
  the Camera Key returns the recorder's exact bytes;
- a lost CMAF Header is re-posted and its fragment retried;
- IVs never repeat and NAL headers stay clear.

Not tested: anything against Apple. No publishing point URL, server CA set or client certificate
for one exists outside a real pairing, and there is no anonymous endpoint to try. Whether Apple
accepts the object layout, and whether `cenc` under the Camera Key is the right protection, are
the two questions a real session on a real home hub has to answer.

## Reading a real session

With the setting on, the plugin's console prints, in order:

- `HomeKit CMAF publishing point set: <origin> (N server CA cert(s))` — §4.13 arrived.
- `HomeKit CMAF client CSR issued` then `HomeKit CMAF client certificate provisioned` — §4.25/§4.26.
- `HomeKit camera key N provisioned (K bytes)` — §4.7. **The byte count matters**: `cenc` uses 16,
  and anything else is the first sign that this reading is wrong.
- `HomeKit HEVC recording buffer ready: …` — everything an upload needs is in place. If this does
  not appear, `HomeKit HEVC recording buffer idle: <reason>` names what is missing.
- `CMAF upload session N started: clip C to <origin>/…/C/` — a §4.9 command arrived. **If this
  never appears, the hub is not asking for uploads**, and no amount of upload code will help.
- `CMAF session N: publishing point probe returned HTTP <status>` — the first thing Apple's
  server says about this camera.
- `CMAF session N: HTTP <status> for <path>` — the first object, then one summary line per clip.

Anything the publishing point refuses also becomes a §4.11 CMAF Error in the camera's event
queue, which is what the controller sees.
