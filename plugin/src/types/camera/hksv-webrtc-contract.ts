/** Observe the accepted SDP and the final RTP header without retaining SDP,
 * credentials, media, keys, addresses, fingerprints or opaque identifiers.
 * This deliberately does not interpret absent SDP SFrame as rejection: HAP
 * has a separate authenticated SFrame exchange. No observation changes media.
 */
type Kind = 'video' | 'audio';
const MID = 'urn:ietf:params:rtp-hdrext:sdes:mid';
const RID = 'urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id';
const FRAME = 'urn:ietf:params:rtp-hdrext:framemarking';
const OLD_FRAME = 'http://tools.ietf.org/html/draft-ietf-avtext-framemarking-07';
const DD = 'https://aomediacodec.github.io/av1-rtp-spec/#dependency-descriptor-rtp-header-extension';
const directions = ['sendrecv', 'sendonly', 'recvonly', 'inactive'];
const extensionName = (uri: string) => uri === MID ? 'mid' : uri === RID ? 'rid'
    : uri === FRAME || uri === OLD_FRAME ? 'frame-marking' : uri === DD ? 'dependency-descriptor' : 'other';

function parse(sdp: string) {
    if (typeof sdp !== 'string' || sdp.length > 65536) return;
    const sections = sdp.replace(/\r\n/g, '\n').split(/(?=^m=)/m);
    const global = sections[0].startsWith('m=') ? [] : sections.shift()!.split('\n');
    const dir = (lines: string[]) => lines.find(l => directions.some(d => l === 'a=' + d))?.slice(2);
    const readExtensions = (lines: string[]) => lines.filter(l => l.startsWith('a=extmap:')).slice(0, 32).flatMap(line => {
        const m = /^a=extmap:(\d{1,3})(?:\/(sendonly|recvonly|sendrecv|inactive))? (\S+)(?: .*)?$/.exec(line);
        if (!m || +m[1] < 1 || +m[1] > 255) return [];
        return [{ id: +m[1], direction: m[2] ?? 'sendrecv', uri: m[3] }];
    });
    const media = sections.slice(0, 8).flatMap(section => {
        const lines = section.split('\n'), m = /^m=(video|audio) (\d+)(?:\/\d+)? (\S+) (.+)$/.exec(lines[0]);
        if (!m) return [];
        const rids = lines.filter(l => l.startsWith('a=rid:')).slice(0, 16).flatMap(line => {
            const r = /^a=rid:([a-zA-Z0-9]{1,255}) (recv|send)(?: (.*))?$/.exec(line);
            if (!r) return [];
            const pt = /(?:^|;)\s*pt=([0-9,]+)(?:;|$)/.exec(r[3] ?? '');
            return [{ id: r[1], direction: r[2], pts: pt ? pt[1].split(',').map(Number) : undefined }];
        });
        const simulcast = lines.find(l => l.startsWith('a=simulcast:'))?.slice(12);
        const recvList = simulcast && /(?:^| )recv ([a-zA-Z0-9~,;]+)(?: |$)/.exec(simulcast)?.[1];
        const simulcastRecv = recvList?.split(/[;,]/).map(id => ({ id: id.replace(/^~/, ''), paused: id.startsWith('~') }));
        return [{ kind: m[1] as Kind, rejected: +m[2] === 0,
            direction: dir(lines) ?? dir(global) ?? 'sendrecv',
            mid: lines.find(l => l.startsWith('a=mid:'))?.slice(6),
            pts: m[4].split(/\s+/).filter(p => /^\d{1,3}$/.test(p)).map(Number),
            sframe: lines.includes('a=sframe'), sessionSframe: global.includes('a=sframe'),
            rids, simulcast: simulcast !== undefined, simulcastRecv,
            ssrcs: new Set(lines.flatMap(l => /^a=ssrc:(\d+) /.exec(l)?.slice(1).map(Number) ?? [])),
            extensions: readExtensions(lines.some(l => l.startsWith('a=extmap:')) ? lines : global) }];
    });
    return media;
}

/** Supplemental bounded SDP fields used alongside the existing codec summary. */
export function summarizeWebRTCContractSdp(sdp: string) {
    const media = parse(sdp);
    if (!media?.length) return { invalid: true };
    return { media: media.map(m => ({ kind: m.kind, rejected: m.rejected, direction: m.direction,
        payloadTypes: m.pts, sframe: m.sframe, sessionSframe: m.sessionSframe,
        simulcast: m.simulcast, receiveRidCount: m.rids.filter(r => r.direction === 'recv').length,
        simulcastReceiveCount: m.simulcastRecv?.length ?? 0,
        pausedReceiveCount: m.simulcastRecv?.filter(r => r.paused).length ?? 0,
        extensions: m.extensions.map(e => ({ id: e.id, name: extensionName(e.uri), direction: e.direction })) })) };
}

export function observeWebRTCContract(session: any, localSdp: string, now: () => number = () => performance.now()) {
    let local = parse(localSdp), remote: ReturnType<typeof parse>, revision = 0;
    let role: 'answer' | 'offer' | 'none' = 'none';
    const makeStats = () => ({ checkedRtp: 0, udpHeaderChecks: 0, noRemoteDescription: 0,
        rejectedMedia: 0, directionMismatch: 0, payloadTypeMismatch: 0, ssrcMismatch: 0,
        ssrcNotInLocalSdp: 0, unnegotiatedExtension: 0, duplicateExtension: 0,
        midMismatch: 0, missingMid: 0, ridMismatch: 0, ridPayloadMismatch: 0,
        ridWithoutReceiveDeclaration: 0, ridPaused: 0, missingRid: 0,
        extensionDirectionMismatch: 0, malformedHeader: 0, malformedSFrameDescriptor: 0,
        sframeRawPackets: 0, sframePacketizedPackets: 0, sframeStarts: 0, sframeEnds: 0,
        sframeMarkerMismatch: 0, maxPayloadBytes: 0, maxDatagramBytes: 0,
        maxBytesPer10ms: 0, maxBytesPer100ms: 0, maxBytesPer1s: 0 });
    const stats = { video: makeStats(), audio: makeStats() };
    const udpMismatches = { video: makeStats(), audio: makeStats() };
    const windows = { video: [10, 100, 1000].map(ms => ({ ms, at: -1, bytes: 0 })),
        audio: [10, 100, 1000].map(ms => ({ ms, at: -1, bytes: 0 })) };
    const section = (kind: Kind) => {
        const own = local?.find(m => m.kind === kind);
        return remote?.find(m => m.kind === kind && own?.mid !== undefined && m.mid === own.mid)
            ?? remote?.find(m => m.kind === kind);
    };
    const checkHeader = (kind: Kind, header: any, s = stats[kind]) => {
        const m = section(kind), own = local?.find(m => m.kind === kind);
        if (!m) { s.noRemoteDescription++; return; }
        if (m.rejected) s.rejectedMedia++;
        if (!['recvonly', 'sendrecv'].includes(m.direction)) s.directionMismatch++;
        if (!m.pts.includes(header.payloadType)) s.payloadTypeMismatch++;
        if (header.ssrc !== session[kind + 'Transceiver']?.sender?.ssrc) s.ssrcMismatch++;
        if (own?.ssrcs.size && !own.ssrcs.has(header.ssrc)) s.ssrcNotInLocalSdp++;
        const seen = new Set<number>();
        const extensions = Array.isArray(header.extensions) ? header.extensions : [];
        for (const e of extensions) {
            if (seen.has(e.id)) s.duplicateExtension++;
            seen.add(e.id);
            const accepted = m.extensions.find(x => x.id === e.id);
            if (!accepted) { s.unnegotiatedExtension++; continue; }
            if (!['recvonly', 'sendrecv'].includes(accepted.direction)) s.extensionDirectionMismatch++;
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
                    if (!stream) s.ridMismatch++;
                    else if (stream.paused) s.ridPaused++;
                }
            }
        }
        // These are presence observations, not claims every RTP packet must
        // repeat MID/RID: receivers can learn the SSRC association earlier.
        for (const e of m.extensions.filter(e => ['recvonly', 'sendrecv'].includes(e.direction))) {
            if (e.uri === MID && !seen.has(e.id)) s.missingMid++;
            if (e.uri === RID && m.rids.some(r => r.direction === 'recv') && !seen.has(e.id)) s.missingRid++;
        }
    };
    return {
        setRemote(sdp: string, type: 'answer' | 'offer') { remote = parse(sdp); role = type; revision++; },
        setLocal(sdp: string) { local = parse(sdp); },
        observeRtp(kind: Kind, payload: Buffer, header: any) {
            try {
                const s = stats[kind]; s.checkedRtp++;
                checkHeader(kind, header);
                s.maxPayloadBytes = Math.max(s.maxPayloadBytes, payload.length);
                if (!session.sframeConfiguration) return;
                if (!payload.length || (payload[0] & 31)) { s.malformedSFrameDescriptor++; return; }
                if (payload[0] & 32) s.sframePacketizedPackets++; else s.sframeRawPackets++;
                if (payload[0] & 128) s.sframeStarts++;
                if (payload[0] & 64) s.sframeEnds++;
                if (header.marker && !(payload[0] & 64)) s.sframeMarkerMismatch++;
            } catch (_) { stats[kind].malformedHeader++; }
        },
        observeUdp(kind: Kind, data: Buffer) {
            try {
                const s = stats[kind]; s.udpHeaderChecks++;
                s.maxDatagramBytes = Math.max(s.maxDatagramBytes, data.length);
                const time = now();
                for (const [i, w] of windows[kind].entries()) {
                    const at = Math.floor(time / w.ms);
                    if (at !== w.at) { w.at = at; w.bytes = 0; }
                    w.bytes += data.length;
                    const field = ['maxBytesPer10ms', 'maxBytesPer100ms', 'maxBytesPer1s'][i] as keyof typeof s;
                    s[field] = Math.max(s[field], w.bytes);
                }
                // Read the unencrypted SRTP header only. Never touch ciphertext
                // or authentication tags, and never retain the datagram.
                if (data.length < 12 || data[0] >>> 6 !== 2) { s.malformedHeader++; return; }
                let offset = 12 + (data[0] & 15) * 4;
                if (offset > data.length) { s.malformedHeader++; return; }
                const extensions: { id: number; payload: Uint8Array }[] = [];
                if (data[0] & 16) {
                if (offset + 4 > data.length) { s.malformedHeader++; return; }
                const profile = data.readUInt16BE(offset), end = offset + 4 + data.readUInt16BE(offset + 2) * 4;
                offset += 4;
                if (end > data.length) { s.malformedHeader++; return; }
                if (profile === 0xbede) {
                    while (offset < end) {
                        const b = data[offset++]; if (!b) continue;
                        const id = b >>> 4, length = (b & 15) + 1;
                        if (id === 15) break;
                        if (offset + length > end) { s.malformedHeader++; return; }
                        extensions.push({ id, payload: data.subarray(offset, offset + length) }); offset += length;
                    }
                } else if ((profile & 0xfff0) === 0x1000) {
                    while (offset < end) {
                        const id = data[offset++]; if (!id) continue;
                        if (offset >= end) { s.malformedHeader++; return; }
                        const length = data[offset++];
                        if (offset + length > end) { s.malformedHeader++; return; }
                        extensions.push({ id, payload: data.subarray(offset, offset + length) }); offset += length;
                    }
                } else { s.malformedHeader++; return; }
                }
                checkHeader(kind, { payloadType: data[1] & 127, ssrc: data.readUInt32BE(8), extensions }, udpMismatches[kind]);
            } catch (_) { stats[kind].malformedHeader++; }
        },
        snapshot() {
            return { revision, countersScope: 'session', burstWindows: 'fixed-monotonic-buckets', remoteDescriptionType: role, remoteDescriptionValid: !!remote?.length,
                video: describe('video'), audio: describe('audio') };
        },
    };
    function describe(kind: Kind) {
        const m = section(kind), hap = !!session.sframeConfiguration;
        const sender = session[kind + 'Transceiver']?.sender;
        return { accepted: m ? { rejected: m.rejected, direction: m.direction, payloadTypes: [...m.pts],
            sframe: m.sframe ? hap ? 'explicit' : 'remote-only' : hap ? 'hap-only' : 'none',
            sessionSframe: m.sessionSframe, receiveRidCount: m.rids.filter(r => r.direction === 'recv').length,
            simulcast: m.simulcast, simulcastReceiveCount: m.simulcastRecv?.length ?? 0,
            pausedReceiveCount: m.simulcastRecv?.filter(r => r.paused).length ?? 0,
            extensions: m.extensions.map(e => ({ id: e.id, name: extensionName(e.uri), direction: e.direction })) } : undefined,
            sender: { payloadType: sender?.codec?.payloadType, clockRate: sender?.codec?.clockRate,
                hasRid: !!sender?.rtpStreamId }, counters: { ...stats[kind] },
            udpMismatches: Object.fromEntries(Object.entries(udpMismatches[kind]).filter(([, count]) => count)) };
    }
}
