#!/usr/bin/env python3
"""Build r43 from the tested r42 ZIP: the same media, with the per-packet work removed from the send path."""
import importlib.util
import json
import re
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('r35builder', ROOT / 'build-r35-from-r34.py')
b = importlib.util.module_from_spec(spec); spec.loader.exec_module(b)
BASE_SHA = '7f339d05453b35390206c4f72f5ff45989687ba2b0b4499a96adae80dad0c660'
OLD_BUILD = 'hevc-fixes-2026-09-16-r42'
BUILD = 'hevc-fixes-2026-09-16-r43'
RTSP = '../../common/src/rtsp-server.ts'


def block_dependencies(block, available):
    """Map a module's import specifiers to bundle module IDs.

    Modules an earlier release already rebuilt carry the map; the rest are still in
    webpack's own form, where each request is named in the comment beside its ID.
    Node built-ins webpack elided as type-only imports resolve to themselves.
    """
    explicit = re.search(r'const dependencies = (\{.*?\});', block)
    if explicit:
        return json.loads(explicit[1])
    deps = {}
    for request, module in re.findall(r'__webpack_require__\(\s*/\*!\s*(.*?)\s*\*/\s*"([^"]+)"\s*\)', block):
        deps.setdefault(request, module)
    for builtin in ['stream', 'dgram', 'buffer', 'os', 'path']:
        if builtin in available:
            deps.setdefault(builtin, builtin)
    return deps


TRANSPILE = """const ts=require('./node_modules/typescript');let s='';process.stdin.setEncoding('utf8');
process.stdin.on('data',v=>s+=v);process.stdin.on('end',()=>{const r=ts.transpileModule(s,{reportDiagnostics:true,
compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}});
if(r.diagnostics.length){console.error(r.diagnostics.map(d=>ts.flattenDiagnosticMessageText(d.messageText,'\\n')).join('\\n'));process.exit(1);}
process.stdout.write(r.outputText);});"""


def compile_module(module_id, source, deps):
    """Like b.compile_module, but labels the block with the module's own ID and keeps
    esModuleInterop on. r43 is the first release to rebuild a module that imports a
    Node built-in by default, and `import net from 'net'` needs the interop helper."""
    js = subprocess.run([b.NODE, '-e', TRANSPILE], cwd=ROOT, input=source, text=True, capture_output=True, check=True).stdout
    imports = re.findall(r'require\("([^"]+)"\)', js)
    assert all(n in deps for n in imports), (module_id, imports, deps)
    return ('/***/ ' + json.dumps(module_id) + ':\n/***/ ((module, exports, __webpack_require__) => {\n'
            + 'const dependencies = ' + json.dumps(deps) + ';\n'
            + 'const require = name => __webpack_require__(dependencies[name]);\n' + js + '\n/***/ }),\n\n\n')


def base_archive():
    for path in (ROOT / 'plugin-hevc-webrtc-r42.zip', Path.home() / 'Desktop' / 'plugin-hevc-webrtc-r42.zip'):
        if path.is_file() and b.digest(path.read_bytes()) == BASE_SHA:
            return path
    raise SystemExit('The checksum-locked r42 ZIP was not found.')


# --- hksv-sframe.ts: the HEVC access unit and its SFrame ciphertext were each copied
# --- more times than the layout needs. Every copy is a full frame.

def edit_sframe(s):
    s = b.once(s, """        const counter = this.counter++, header = sframeHeader(this.kid, counter);
        const nonce = Buffer.from(this.salt), ctr = uint64(counter);
        for (let i = 0; i < 8; ++i) nonce[i + 4] ^= ctr[i];
        const cipher = createCipheriv('aes-256-ctr', this.key.subarray(0, 32), Buffer.concat([nonce, Buffer.alloc(4)]));
        const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
""", """        const counter = this.counter++, header = sframeHeader(this.kid, counter);
        // r43: build the 16-byte counter block in place; its first 12 bytes are the nonce.
        const block = Buffer.alloc(16); this.salt.copy(block); const ctr = uint64(counter);
        for (let i = 0; i < 8; ++i) block[i + 4] ^= ctr[i];
        const nonce = block.subarray(0, 12);
        const cipher = createCipheriv('aes-256-ctr', this.key.subarray(0, 32), block);
        // r43: AES-CTR is a stream cipher, so final() is empty and update() already
        // returned the whole ciphertext. Concatenating copied every frame again.
        const head = cipher.update(plaintext), tail = cipher.final();
        const ciphertext = tail.length ? Buffer.concat([head, tail]) : head;
""")
    s = b.once(s, """    private add(nal: Buffer): void {
        if (nal.length < 2 || (nal[0] & 128) || !(nal[1] & 7) || ((nal[0] >> 1) & 63) >= 48)
            throw new Error('Invalid HEVC NAL');
        this.nals.push(Buffer.from(nal));
    }
""", """    /** r43: `owned` marks a buffer this assembler allocated itself, so a defragmented
     * FU is kept as is instead of being copied a second time. */
    private add(nal: Buffer, owned = false): void {
        if (nal.length < 2 || (nal[0] & 128) || !(nal[1] & 7) || ((nal[0] >> 1) & 63) >= 48)
            throw new Error('Invalid HEVC NAL');
        this.nals.push(owned ? nal : Buffer.from(nal));
    }
""")
    s = b.once(s, 'if (p[2] & 64) { this.add(Buffer.concat(this.fragments)); this.fragments',
               'if (p[2] & 64) { this.add(Buffer.concat(this.fragments), true); this.fragments')
    s = b.once(s, """            const chunks: Buffer[] = [];
            for (const nal of this.nals) { const length = Buffer.alloc(4); length.writeUInt32BE(nal.length); chunks.push(length, nal); }
            frame = Buffer.concat(chunks);
""", """            // r43: size the access unit once and write the 4-byte lengths in place,
            // instead of a length buffer per NAL and a list twice as long as the frame.
            let total = 0;
            for (const nal of this.nals) total += nal.length + 4;
            frame = Buffer.allocUnsafe(total);
            let offset = 0;
            for (const nal of this.nals) {
                frame.writeUInt32BE(nal.length, offset); offset += 4;
                nal.copy(frame, offset); offset += nal.length;
            }
""")
    return b.once(s, """            const payload = Buffer.concat([Buffer.from([(offset === 0 ? 128 : 0) | (end ? 64 : 0)]), encrypted.subarray(offset, offset + limit)]);
""", """            // r43: one allocation and one copy per slice.
            const slice = Math.min(limit, encrypted.length - offset);
            const payload = Buffer.allocUnsafe(slice + 1);
            payload[0] = (offset === 0 ? 128 : 0) | (end ? 64 : 0);
            encrypted.copy(payload, 1, offset, offset + slice);
""")


# --- hksv-frame-marking.ts: decorate() read pc.remoteDescription for every outgoing
# --- RTP packet, and that getter re-serializes the whole remote SDP.

def edit_frame_marking(s):
    s = b.once(s, """    return {
        observeFrame(frame: Buffer, header: any) {
            timestamp = header.timestamp; independent = independentHevcFrame(frame);
            counts.sourceFrames++;
            if (independent === undefined) counts.unsupportedFrames++;
            else if (independent) counts.independentFrames++;
        },
        decorate(packet: any) {
            const ids = negotiation();
""", """    // r43: werift rebuilds the entire remote SDP string on every pc.remoteDescription
    // read, so resolving this once per access unit replaces one full SDP serialization
    // per outgoing RTP packet. The extension IDs can only change with a new
    // description, which restarts media and is observed on the next frame.
    let current: number[] | undefined;
    const refresh = () => current = negotiation();
    return {
        observeFrame(frame: Buffer, header: any) {
            timestamp = header.timestamp; independent = independentHevcFrame(frame);
            counts.sourceFrames++;
            if (independent === undefined) counts.unsupportedFrames++;
            else if (independent) counts.independentFrames++;
            refresh();
        },
        decorate(packet: any) {
            const ids = current ?? refresh();
""")
    return b.once(s, """        snapshot() {
            const ids = negotiation();
""", """        snapshot() {
            const ids = refresh();
""")


# --- hksv-webrtc-probe.ts: the independent SRTP and SFrame verification re-decrypted
# --- and re-hashed every datagram for the life of the session.

def edit_probe(s):
    s = b.once(s, "const MAX_FRAME = 1024 * 1024;\n", """const MAX_FRAME = 1024 * 1024;
/** r43: independently authenticating, decrypting and digesting every datagram costs
 * about as much per packet as sending it, and at 4K that is several percent of the
 * event loop for the life of the session. Verification is a startup question, so it
 * runs for a bounded number of packets per stream; the free header, sequence, report
 * and timing counters continue for the whole session. */
const VERIFY_PACKETS = 4000;
""")
    s = b.once(s, 'rtpPackets: 0, udpPackets: 0, srtpVerified: 0, srtpAuthFailures: 0,',
               'rtpPackets: 0, udpPackets: 0, srtpVerified: 0, srtpVerifySkipped: 0, srtpAuthFailures: 0,')
    s = b.once(s, """        const roc = Buffer.alloc(4); roc.writeUInt32BE(Math.floor(index / 65536));
        let plaintext: Buffer;
        if (c.profile === 7) {
            const iv = Buffer.alloc(12); iv.writeUInt32BE(ssrc, 2); iv.writeUInt32BE(Math.floor(index / 65536), 6); iv.writeUInt16BE(seq, 10);
            for (let i = 0; i < 12; i++) iv[i] ^= c.salt[i];
            const d = createDecipheriv('aes-128-gcm', c.enc, iv);
            d.setAAD(data.subarray(0, offset)); d.setAuthTag(data.subarray(-16));
            try { plaintext = Buffer.concat([d.update(data.subarray(offset, -16)), d.final()]); }
            catch (_) { s.srtpAuthFailures++; return; }
        } else {
            const tag = createHmac('sha1', c.auth).update(data.subarray(0, -c.tagLength)).update(roc).digest().subarray(0, c.tagLength);
            if (!equal(tag, data.subarray(-c.tagLength))) { s.srtpAuthFailures++; return; }
            const iv = Buffer.alloc(16); c.salt.copy(iv);
            const xor = Buffer.alloc(16); xor.writeUInt32BE(ssrc, 4); xor.writeUIntBE(index, 8, 6);
            for (let i = 0; i < 16; i++) iv[i] ^= xor[i];
            const d = createDecipheriv('aes-128-ctr', c.enc, iv);
            plaintext = Buffer.concat([d.update(data.subarray(offset, -c.tagLength)), d.final()]);
        }
        c.indexes.set(ssrc, Math.max(last ?? index, index)); s.srtpVerified++;
        try {
            let payload = plaintext;
            if (data[0] & 32) {
                const n = payload[payload.length - 1];
                if (!n || n > payload.length) { s.srtpParseFailures++; return; }
                payload = payload.subarray(0, -n);
            }
            const expected = st.expected.get(seq);
            if (!expected) s.srtpExpectedMissing++;
            else if (equal(expected, digest(payload))) s.srtpPayloadMatches++; else s.srtpPayloadMismatches++;
            st.sequences[seq] = 1;
""", """        // r43: everything above reads the cleartext SRTP header and runs for every
        // packet of the session. The independent authentication, decryption and
        // digests below stop once this stream has verified its startup budget.
        const verify = s.udpPackets <= VERIFY_PACKETS;
        let plaintext: Buffer | undefined;
        if (!verify) s.srtpVerifySkipped++;
        else {
            const roc = Buffer.alloc(4); roc.writeUInt32BE(Math.floor(index / 65536));
            if (c.profile === 7) {
                const iv = Buffer.alloc(12); iv.writeUInt32BE(ssrc, 2); iv.writeUInt32BE(Math.floor(index / 65536), 6); iv.writeUInt16BE(seq, 10);
                for (let i = 0; i < 12; i++) iv[i] ^= c.salt[i];
                const d = createDecipheriv('aes-128-gcm', c.enc, iv);
                d.setAAD(data.subarray(0, offset)); d.setAuthTag(data.subarray(-16));
                try { plaintext = Buffer.concat([d.update(data.subarray(offset, -16)), d.final()]); }
                catch (_) { s.srtpAuthFailures++; return; }
            } else {
                const tag = createHmac('sha1', c.auth).update(data.subarray(0, -c.tagLength)).update(roc).digest().subarray(0, c.tagLength);
                if (!equal(tag, data.subarray(-c.tagLength))) { s.srtpAuthFailures++; return; }
                const iv = Buffer.alloc(16); c.salt.copy(iv);
                const xor = Buffer.alloc(16); xor.writeUInt32BE(ssrc, 4); xor.writeUIntBE(index, 8, 6);
                for (let i = 0; i < 16; i++) iv[i] ^= xor[i];
                const d = createDecipheriv('aes-128-ctr', c.enc, iv);
                plaintext = Buffer.concat([d.update(data.subarray(offset, -c.tagLength)), d.final()]);
            }
        }
        c.indexes.set(ssrc, Math.max(last ?? index, index));
        if (verify) s.srtpVerified++;
        try {
            let payload = plaintext;
            if (payload && (data[0] & 32)) {
                const n = payload[payload.length - 1];
                if (!n || n > payload.length) { s.srtpParseFailures++; return; }
                payload = payload.subarray(0, -n);
            }
            if (payload) {
                const expected = st.expected.get(seq);
                if (!expected) s.srtpExpectedMissing++;
                else if (equal(expected, digest(payload))) s.srtpPayloadMatches++; else s.srtpPayloadMismatches++;
            }
            st.sequences[seq] = 1;
""")
    s = b.once(s, """            sframe(kind, payload, { ssrc, sequenceNumber: seq, timestamp: data.readUInt32BE(4), marker: !!(data[1] & 128) });
        } finally { plaintext.fill(0); }
""", """            if (payload) sframe(kind, payload, { ssrc, sequenceNumber: seq, timestamp: data.readUInt32BE(4), marker: !!(data[1] & 128) });
        } finally { plaintext?.fill(0); }
""")
    s = b.once(s, """                const s = stats[kind]; s.rtpPackets++;
                boundedSet(state[kind].expected, header.sequenceNumber, digest(payload));
""", """                const s = stats[kind]; s.rtpPackets++;
                // r43: the wire side verifies the same budget and always after this
                // call for the same packet, so a small margin keeps every verified
                // datagram's source digest available.
                if (s.rtpPackets <= VERIFY_PACKETS + 64) boundedSet(state[kind].expected, header.sequenceNumber, digest(payload));
""")
    return b.once(s, "                sampling: 'first-12-frames-then-one-per-5s-per-media', maxFrameBytes: MAX_FRAME,\n",
                  "                sampling: 'first-12-frames-then-one-per-5s-per-media', verifiedPacketsPerStream: VERIFY_PACKETS,\n"
                  "                maxFrameBytes: MAX_FRAME,\n")


# --- hksv-webrtc-contract.ts: the same two descriptions were rescanned, and the
# --- compared MID/RID buffers reallocated, for every packet and every datagram.

def edit_contract(s):
    s = b.once(s, "const directions = ['sendrecv', 'sendonly', 'recvonly', 'inactive'];\n",
               "const directions = ['sendrecv', 'sendonly', 'recvonly', 'inactive'];\nconst RECEIVES = ['recvonly', 'sendrecv'];\n")
    s = b.once(s, """    const checkHeader = (kind: Kind, header: any, s = stats[kind]) => {
        const m = section(kind), own = local?.find(m => m.kind === kind);
        if (!m) { s.noRemoteDescription++; return; }
        if (m.rejected) s.rejectedMedia++;
        if (!['recvonly', 'sendrecv'].includes(m.direction)) s.directionMismatch++;
""", """    // r43: every RTP packet and every datagram is checked against the same two
    // descriptions, so resolve the sections and the compared values once per
    // description instead of rescanning and re-allocating them per packet.
    let resolved: Record<string, any> = {};
    const invalidate = () => resolved = {};
    const resolve = (kind: Kind) => resolved[kind] ??= (() => {
        const m = section(kind);
        const recvRids = (m?.rids ?? []).filter(r => r.direction === 'recv').map(r => ({ ...r, key: Buffer.from(r.id) }));
        return { m, own: local?.find(x => x.kind === kind), mid: Buffer.from(m?.mid ?? ''), recvRids,
            simulcastRecv: m?.simulcastRecv?.map(r => ({ ...r, key: Buffer.from(r.id) })),
            recvExtensions: (m?.extensions ?? []).filter(e => RECEIVES.includes(e.direction)) };
    })();
    const checkHeader = (kind: Kind, header: any, s = stats[kind]) => {
        const { m, own, mid, recvRids, simulcastRecv, recvExtensions } = resolve(kind);
        if (!m) { s.noRemoteDescription++; return; }
        if (m.rejected) s.rejectedMedia++;
        if (!RECEIVES.includes(m.direction)) s.directionMismatch++;
""")
    s = b.once(s, """            if (!['recvonly', 'sendrecv'].includes(accepted.direction)) s.extensionDirectionMismatch++;
            const value = Buffer.isBuffer(e.payload) ? e.payload : Buffer.from(e.payload ?? []);
            if (accepted.uri === MID && !value.equals(Buffer.from(m.mid ?? ''))) s.midMismatch++;
            if (accepted.uri === RID) {
                const candidates = m.rids.filter(r => r.direction === 'recv');
                const rid = candidates.find(r => value.equals(Buffer.from(r.id)));
                if (!candidates.length) s.ridWithoutReceiveDeclaration++;
                else if (!rid) s.ridMismatch++;
                if (rid?.pts && !rid.pts.includes(header.payloadType)) s.ridPayloadMismatch++;
                if (m.simulcastRecv) {
                    const stream = m.simulcastRecv.find(r => value.equals(Buffer.from(r.id)));
""", """            if (!RECEIVES.includes(accepted.direction)) s.extensionDirectionMismatch++;
            const value = Buffer.isBuffer(e.payload) ? e.payload : Buffer.from(e.payload ?? []);
            if (accepted.uri === MID && !value.equals(mid)) s.midMismatch++;
            if (accepted.uri === RID) {
                const rid = recvRids.find(r => value.equals(r.key));
                if (!recvRids.length) s.ridWithoutReceiveDeclaration++;
                else if (!rid) s.ridMismatch++;
                if (rid?.pts && !rid.pts.includes(header.payloadType)) s.ridPayloadMismatch++;
                if (simulcastRecv) {
                    const stream = simulcastRecv.find(r => value.equals(r.key));
""")
    s = b.once(s, """        for (const e of m.extensions.filter(e => ['recvonly', 'sendrecv'].includes(e.direction))) {
            if (e.uri === MID && !seen.has(e.id)) s.missingMid++;
            if (e.uri === RID && m.rids.some(r => r.direction === 'recv') && !seen.has(e.id)) s.missingRid++;
""", """        for (const e of recvExtensions) {
            if (e.uri === MID && !seen.has(e.id)) s.missingMid++;
            if (e.uri === RID && recvRids.length && !seen.has(e.id)) s.missingRid++;
""")
    return b.once(s, """        setRemote(sdp: string, type: 'answer' | 'offer') { remote = parse(sdp); role = type; revision++; },
        setLocal(sdp: string) { local = parse(sdp); },
""", """        setRemote(sdp: string, type: 'answer' | 'offer') { remote = parse(sdp); role = type; revision++; invalidate(); },
        setLocal(sdp: string) { local = parse(sdp); invalidate(); },
""")


# --- hksv-rtp-pacer.ts: the default clock allocated a BigInt for every packet.

def edit_pacer(s):
    return b.once(s, "    const now = options?.now ?? (() => Number(process.hrtime.bigint()) / 1e6);\n",
                  "    // r43: the same monotonic clock without a BigInt allocation on every packet.\n"
                  "    const now = options?.now ?? (() => performance.now());\n")


# --- rtsp-server.ts: reading one interleaved packet walked the whole track list.

def edit_rtsp(s):
    s = b.once(s, """    setupTracks: {
        [trackId: string]: RtspTrack;
    } = {};
""", """    setupTracks: {
        [trackId: string]: RtspTrack;
    } = {};
    // r43: interleaved channel -> track, so reading a packet does not walk the
    // track list. Rebuilt on a miss and cleared by SETUP, so a track added or
    // replaced later is still found.
    private interleavedTracks: Map<number, RtspTrack> | undefined;

    private trackForDestination(destination: number) {
        const cached = this.interleavedTracks?.get(destination);
        if (cached)
            return cached;
        this.interleavedTracks = new Map(Object.values(this.setupTracks).map(track => [track.destination, track]));
        return this.interleavedTracks.get(destination);
    }
""")
    s = b.once(s, '            const track = Object.values(this.setupTracks).find(track => track.destination === destination);\n',
               '            const track = this.trackForDestination(destination);\n')
    s = b.once(s, """            destination: low,
            codec: msection.codec,
        }
    }
""", """            destination: low,
            codec: msection.codec,
        }
        this.interleavedTracks = undefined;
    }
""")
    return b.once(s, """                rtp: rtpServer.server,
                rtcp: rtcpServer.server,
            }
            transport = transport.replace(""", """                rtp: rtpServer.server,
                rtcp: rtcpServer.server,
            }
            this.interleavedTracks = undefined;
            transport = transport.replace(""")


EDITS = [
    ('hksv-sframe.ts', b.PREFIX + 'hksv-sframe.ts', 'plugin/src/types/camera/hksv-sframe.ts', edit_sframe),
    ('hksv-frame-marking.ts', b.PREFIX + 'hksv-frame-marking.ts', 'plugin/src/types/camera/hksv-frame-marking.ts', edit_frame_marking),
    ('hksv-webrtc-probe.ts', b.PREFIX + 'hksv-webrtc-probe.ts', 'plugin/src/types/camera/hksv-webrtc-probe.ts', edit_probe),
    ('hksv-webrtc-contract.ts', b.PREFIX + 'hksv-webrtc-contract.ts', 'plugin/src/types/camera/hksv-webrtc-contract.ts', edit_contract),
    ('hksv-rtp-pacer.ts', b.PREFIX + 'hksv-rtp-pacer.ts', 'plugin/src/types/camera/hksv-rtp-pacer.ts', edit_pacer),
    ('rtsp-server.ts', RTSP, 'plugin/common/src/rtsp-server.ts', edit_rtsp),
]


def main():
    archive = base_archive()
    with zipfile.ZipFile(archive) as z:
        assert z.testzip() is None
        entries = {i.filename: (i, z.read(i)) for i in z.infolist()}
    original = entries['main.nodejs.js'][1].decode()
    old = json.loads(entries['build-manifest.json'][1])
    assert old['buildId'] == OLD_BUILD and b.digest(original.encode()) == old['bundleSha256']
    before = b.modules(original)
    smap = json.loads(entries['main.nodejs.js.map'][1])
    out = ROOT / 'dist-r43'; out.mkdir(exist_ok=True)

    def source_index(suffix):
        matches = [i for i, n in enumerate(smap['sources']) if n.endswith(suffix)]
        assert len(matches) == 1, (suffix, matches)
        return matches[0]

    output = original
    for name, module, mirror, edit in EDITS:
        index = source_index('/' + name)
        source = edit(smap['sourcesContent'][index])
        # plugin/ is the source of the shipped build; the two must not drift.
        assert source == (ROOT / mirror).read_text(), mirror
        block = before[module]
        deps = block_dependencies(block, before)
        output = b.once(output, block, compile_module(module, source, deps))
        smap['sourcesContent'][index] = source
        (out / name).write_text(source)

    assert output.count(OLD_BUILD) == 2
    output = output.replace(OLD_BUILD, BUILD)
    smap['sourcesContent'] = [c.replace(OLD_BUILD, BUILD) if c else c for c in smap['sourcesContent']]
    after = b.modules(output)
    changed = [n for n in before if before[n] != after[n]]
    expected = {module for _, module, _, _ in EDITS} | {b.PREFIX + 'camera-hksv27.ts', b.PREFIX + 'camera-stream-diagnostics.ts'}
    assert set(changed) == expected, changed
    # The two build-label modules change by the label alone; no behaviour moves with them.
    for name in ['camera-hksv27.ts', 'camera-stream-diagnostics.ts']:
        assert after[b.PREFIX + name] == before[b.PREFIX + name].replace(OLD_BUILD, BUILD), name
    assert set(after) == set(before)
    sha = b.digest(output.encode())
    manifest = {'buildId': BUILD, 'baseBuildId': OLD_BUILD, 'previousArchiveSha256': BASE_SHA,
        'originalArchiveSha256': old['originalArchiveSha256'], 'bundleSha256': sha,
        'editedModules': changed, 'addedModules': [],
        'change': 'Send-path performance only; no media, signaling, setting or default changes. The r36 frame-marking probe '
                  'resolved its negotiated extension IDs once per access unit instead of once per RTP packet, where each read of '
                  "werift's pc.remoteDescription re-serialized the whole remote SDP. The r35 media probe now authenticates, "
                  'decrypts and digests a bounded startup budget of 4000 packets per stream instead of every datagram for the life '
                  'of the session; its header, sequence, report and timing counters are unchanged, and a new srtpVerifySkipped '
                  'counter and verifiedPacketsPerStream field record the budget. SFrame encryption and HEVC access unit assembly '
                  'drop two full-frame copies per frame and one allocation per slice. The contract observer resolves its SDP '
                  'sections once per description. The remote pacer reads a monotonic clock without allocating a BigInt per packet. '
                  'The RTSP server maps an interleaved channel to its track instead of walking the track list per packet.',
        'evidence': 'Node 22 on a 4-core Linux container, replaying 10 s of HEVC through SFrame, frame marking, the contract '
                    'observer, real werift SRTP and the media probe, measured on the r42 and r43 bundles in turn: 360p ~0.8 Mbps '
                    '2.3% -> 2.0% of one core, 1080p ~4 Mbps 5.1% -> 3.6%, 4K ~12 Mbps 12.3% -> 6.0% (92 -> 44 us per packet). '
                    'Component measurements on the same host: each pc.remoteDescription read cost 8.8 us, and the probe\'s '
                    'per-packet HMAC-SHA1, AES-128-CTR and two SHA-256 passes cost 28.4 us.',
        'limitations': ['Startup timing, the r42 throughput line and the relay reception reports are unchanged; the probe\'s '
                        'srtpVerified, srtpPayloadMatches, sframeVerified and sframeSourceMatches counters now stop after the '
                        'budget, so a corruption that begins late in a long session is no longer independently verified.',
            'No change to picture quality, bitrate, resolution, keyframe schedule or any setting. A remote view should look '
            'exactly like r42, with more headroom on the host.',
            'Measured on an idle container, not on the user\'s Scrypted host.',
            'Source map offsets are inherited; sourcesContent and dist-r43 contain the exact edited sources.']}
    if '--package' in sys.argv:
        v = json.loads((ROOT / 'diagnostics/r43-tests.json').read_text())
        log = (ROOT / 'diagnostics/r43-tests.log').read_bytes()
        assert v['bundleSha256'] == sha and v['returnCode'] == 0 and v['logSha256'] == b.digest(log)
        total, passed = re.search(rb'tests (\d+)\b', log), re.search(rb'pass (\d+)\b', log)
        assert total and passed and total[1] == passed[1] and int(total[1]) >= 245
        assert re.search(rb'fail 0\b', log) and re.search(rb'skipped 0\b', log)
        manifest['validationChecks'] = int(total[1])
    (out / 'main.nodejs.js').write_text(output)
    (out / 'main.nodejs.js.map').write_text(json.dumps(smap, separators=(',', ':')))
    (out / 'build-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    if '--package' in sys.argv:
        replacements = {n: (out / n).read_bytes() for n in ['main.nodejs.js', 'main.nodejs.js.map', 'build-manifest.json']}
        replacements['HEVC-TESTING.md'] = (ROOT / 'R43-TESTING.md').read_bytes()
        target = ROOT / 'plugin-hevc-webrtc-r43.zip'
        with zipfile.ZipFile(target, 'w') as z:
            for name, (info, data) in entries.items(): z.writestr(info, replacements.get(name, data))
        with zipfile.ZipFile(target) as z: assert z.testzip() is None and z.read('main.nodejs.js') == output.encode()
        result = {'archive': str(target), 'sha256': b.digest(target.read_bytes()), **manifest}
        (ROOT / 'diagnostics/r43-build.json').write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps(result, indent=2))
    else: print(json.dumps({'prepared': BUILD, 'bundleSha256': sha, 'editedModules': changed}))


if __name__ == '__main__': main()
