import { isIP } from 'net';
import { networkInterfaces } from 'os';
import { summarizeWebRTCDtls } from './hksv-webrtc-dtls';

const choice = (value: unknown, allowed: readonly string[]) =>
    typeof value === 'string' && allowed.includes(value.toLowerCase()) ? value.toLowerCase() : 'unknown';
const integer = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const token = (value: string) => /^[a-zA-Z0-9_-]{1,16}$/.test(value) ? value : '?';

/** Explicit allowlist: never serialize SDP, ICE credentials, addresses, keys or fingerprints. */
export function summarizeWebRTCSdp(sdp: string) {
    if (typeof sdp !== 'string' || sdp.length > 65536) return { invalid: true };
    const sections = sdp.split(/\r?\n(?=m=)/);
    const sessionLines = sections[0].split(/\r?\n/);
    const inherited = (lines: string[], name: string) =>
        lines.find(line => line.startsWith(name)) ?? sessionLines.find(line => line.startsWith(name));
    return {
        iceLite: sessionLines.includes('a=ice-lite'),
        bundle: sessionLines.find(line => line.startsWith('a=group:BUNDLE '))?.slice(15).split(/\s+/).slice(0, 8).map(token) ?? [],
        media: sections.slice(1, 9).map(section => {
            const lines = section.split(/\r?\n/);
            const m = lines[0].slice(2).split(/\s+/);
            const direction = lines.find(line => /^a=(sendrecv|sendonly|recvonly|inactive)$/.test(line))
                ?? sessionLines.find(line => /^a=(sendrecv|sendonly|recvonly|inactive)$/.test(line)) ?? 'a=sendrecv';
            const rtpmap = lines.filter(line => line.startsWith('a=rtpmap:')).slice(0, 16);
            const numericParameters = ['profile-space', 'profile-id', 'tier-flag', 'level-id', 'max-fs', 'max-fr',
                'max-width', 'max-height', 'max-fps', 'max-br', 'max-bitrate', 'minptime', 'useinbandfec', 'stereo',
                'sprop-stereo', 'sprop-maxcapturerate', 'maxplaybackrate', 'packetization-mode', 'level-asymmetry-allowed', 'apt'];
            return {
                kind: choice(m[0], ['video', 'audio', 'application']),
                rejected: m[1] === '0',
                protocol: choice(m[2], ['udp/tls/rtp/savpf', 'rtp/savpf', 'tcp/dtls/rtp/savpf']),
                mid: token(lines.find(line => line.startsWith('a=mid:'))?.slice(6) ?? ''),
                direction: choice(direction.slice(2), ['sendrecv', 'sendonly', 'recvonly', 'inactive']),
                codecs: rtpmap.map(line => {
                    const match = /^a=rtpmap:(\d+) ([^/\s]+)\/(\d+)(?:\/(\d+))?$/.exec(line);
                    if (!match) return { invalid: true };
                    const [, pt, name, clock, channels] = match;
                    const fmtp = lines.find(line => line.startsWith(`a=fmtp:${pt} `))?.split(' ').slice(1).join(' ') ?? '';
                    const parameters: Record<string, number | string> = {};
                    for (const item of fmtp.split(';')) {
                        const [key, value] = item.trim().split('=');
                        if (numericParameters.includes(key) && /^\d{1,10}$/.test(value)) parameters[key] = Number(value);
                        if (key === 'profile-level-id' && /^[a-fA-F0-9]{6}$/.test(value)) parameters[key] = value;
                        if (key === 'tx-mode') parameters[key] = choice(value, ['srst', 'mrst', 'mrmt']);
                    }
                    return { pt: Number(pt), codec: choice(name, ['h265', 'hevc', 'h264', 'opus', 'rtx', 'red', 'ulpfec']),
                        clock: Number(clock), channels: channels ? Number(channels) : undefined, parameters };
                }),
                rids: lines.filter(line => line.startsWith('a=rid:')).slice(0, 8).map(line => {
                    const [, id, direction, restrictions = ''] = /^a=rid:(\S+) (send|recv)(?: (.*))?$/.exec(line) ?? [];
                    const limits: Record<string, string> = {};
                    for (const part of restrictions.split(';')) {
                        const [key, value] = part.trim().split('=');
                        if (['pt', 'max-width', 'max-height', 'max-fps', 'max-fs', 'max-br', 'max-pps', 'max-bpp'].includes(key)
                            && /^[0-9.,]{1,32}$/.test(value)) limits[key] = value;
                    }
                    return { id: token(id ?? ''), direction: choice(direction, ['send', 'recv']), limits };
                }),
                simulcast: lines.some(line => line.startsWith('a=simulcast:')),
                extensions: lines.filter(line => line.startsWith('a=extmap:')).slice(0, 16).map(line => {
                    const match = /^a=extmap:(\d+)(?:\/\w+)? (\S+)/.exec(line);
                    const uri = match?.[2];
                    return { id: match ? Number(match[1]) : undefined,
                        name: uri === 'urn:ietf:params:rtp-hdrext:sdes:mid' ? 'mid'
                            : uri === 'urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id' ? 'rid'
                            : uri === 'urn:ietf:params:rtp-hdrext:sdes:repaired-rtp-stream-id' ? 'repaired-rid' : 'other' };
                }),
                ssrcCount: new Set(lines.filter(line => line.startsWith('a=ssrc:')).map(line => line.split(' ')[0])).size,
                rtcpMux: lines.includes('a=rtcp-mux'),
                iceCredentials: !!inherited(lines, 'a=ice-ufrag:') && !!inherited(lines, 'a=ice-pwd:'),
                dtlsSetup: choice(inherited(lines, 'a=setup:')?.slice(8), ['actpass', 'active', 'passive', 'holdconn']),
                fingerprints: (lines.some(line => line.startsWith('a=fingerprint:')) ? lines : sessionLines)
                    .filter(line => line.startsWith('a=fingerprint:')).slice(0, 4)
                    .map(line => choice(line.slice(14).split(' ')[0], ['sha-256', 'sha-384', 'sha-512', 'sha-1'])),
                candidates: summarizeWebRTCCandidates(lines.filter(line => line.startsWith('a=candidate:')).map(candidate => ({ candidate: candidate.slice(2) }))),
            };
        }),
    };
}

function candidateSummary(candidate: any) {
    return { type: choice(candidate?.type, ['host', 'srflx', 'prflx', 'relay']),
        protocol: choice(candidate?.transport ?? candidate?.protocol, ['udp', 'tcp']),
        family: isIP(candidate?.host ?? candidate?.ip ?? '') || 'hostname',
        tcpType: candidate?.tcptype ? choice(candidate.tcptype, ['active', 'passive', 'so']) : undefined };
}

/** Count candidate categories without including any identifying candidate fields. */
export function summarizeWebRTCCandidates(candidates: readonly any[]) {
    const groups: Record<string, number> = {};
    for (const item of candidates.slice(0, 256)) {
        const fields = typeof item?.candidate === 'string' ? item.candidate.split(/\s+/) : undefined;
        const summary = candidateSummary(fields ? { transport: fields[2], host: fields[4], type: fields[7],
            tcptype: fields.includes('tcptype') ? fields[fields.indexOf('tcptype') + 1] : undefined } : item);
        const key = `${summary.type}/${summary.protocol}/v${summary.family}${summary.tcpType ? '/' + summary.tcpType : ''}`;
        groups[key] = (groups[key] ?? 0) + 1;
    }
    return { count: candidates.length, groups };
}

export function summarizeWebRTCTransport(pc: any) {
    const states = ['new', 'checking', 'connecting', 'connected', 'completed', 'disconnected', 'failed', 'closed'];
    return { connection: choice(pc.connectionState, states), ice: choice(pc.iceConnectionState, states),
        transports: pc.dtlsTransports.slice(0, 8).map((dtls: any) => {
            const ice = dtls.iceTransport, connection = ice.connection;
            const pairStates = [0, 0, 0, 0, 0]; // frozen, waiting, checking, succeeded, failed (bundled werift)
            for (const pair of connection.checkList ?? []) if (Number.isInteger(pair.state) && pair.state >= 0 && pair.state < 5) pairStates[pair.state]++;
            const selected = connection.nominated;
            return { ice: choice(ice.state, states), dtls: choice(dtls.state, states),
                iceRole: choice(ice.role, ['controlled', 'controlling']), dtlsRole: choice(dtls.role, ['auto', 'client', 'server']),
                remoteIceLite: !!connection.remoteIsLite, srtp: !!dtls.srtpStarted,
                local: summarizeWebRTCCandidates(ice.localCandidates ?? []), remote: summarizeWebRTCCandidates(connection.remoteCandidates ?? []),
                pairs: { frozen: pairStates[0], waiting: pairStates[1], checking: pairStates[2], succeeded: pairStates[3], failed: pairStates[4] },
                selected: selected ? { local: candidateSummary(selected.localCandidate), remote: candidateSummary(selected.remoteCandidate) } : undefined,
                packetsSent: integer(dtls.packetsSent), packetsReceived: integer(dtls.packetsReceived),
                handshake: summarizeWebRTCDtls(dtls) };
        }) };
}

export type WebRTCPathKind = 'lan' | 'remote' | 'unknown';
export type WebRTCPathReason = 'relay' | 'reflexive' | 'loopback' | 'link-local' | 'private' | 'on-link' | 'public' | 'no-pair' | 'invalid';
export interface WebRTCPathSummary {
    kind: WebRTCPathKind;
    /** Why the pair was classified; never an address. */
    reason: WebRTCPathReason;
    /** Candidate types of the nominated pair. */
    local: string;
    remote: string;
    family: 4 | 6 | 'unknown';
}

/** Numeric value of an IPv4/IPv6 literal (zone IDs and ::ffff: mapping handled). */
export function addressToBigInt(address: string): { value: bigint; family: 4 | 6 } | undefined {
    const bare = String(address ?? '').split('%')[0];
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(bare);
    const text = mapped ? mapped[1] : bare;
    const family = isIP(text);
    if (family === 4) {
        const parts = text.split('.').map(Number);
        return { value: (BigInt(parts[0]) << 24n) | (BigInt(parts[1]) << 16n) | (BigInt(parts[2]) << 8n) | BigInt(parts[3]), family: 4 };
    }
    if (family !== 6) return;
    let v6 = text;
    const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
    if (dotted) {
        const [a, b, c, d] = dotted[2].split('.').map(Number);
        v6 = dotted[1] + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16);
    }
    const halves = v6.split('::');
    if (halves.length > 2) return;
    const head = halves[0] ? halves[0].split(':') : [];
    const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
    const missing = 8 - head.length - tail.length;
    if (missing < 0 || (halves.length === 1 && missing !== 0)) return;
    let value = 0n;
    for (const group of [...head, ...Array(missing).fill('0'), ...tail]) {
        if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return;
        value = (value << 16n) | BigInt(parseInt(group, 16));
    }
    return { value, family: 6 };
}

/** Where a peer address sits relative to this host: loopback, link-local, private
 * (RFC 1918 / ULA), on-link for one of our interface prefixes, or public. */
export function classifyPeerAddress(address: string, interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): WebRTCPathReason {
    const parsed = addressToBigInt(address);
    if (!parsed) return 'invalid';
    if (parsed.family === 4) {
        const a = Number(parsed.value >> 24n), b = Number((parsed.value >> 16n) & 255n);
        if (a === 127) return 'loopback';
        if (a === 169 && b === 254) return 'link-local';
        if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'private';
    }
    else {
        const top = Number(parsed.value >> 112n);
        if (parsed.value === 1n) return 'loopback';
        if ((top & 0xffc0) === 0xfe80) return 'link-local';
        if ((top & 0xfe00) === 0xfc00) return 'private';
    }
    for (const infos of Object.values(interfaces ?? {})) {
        for (const info of infos ?? []) {
            const cidr = (info as any)?.cidr;
            if (typeof cidr !== 'string' || !cidr.includes('/')) continue;
            const [ifAddress, prefixText] = cidr.split('/');
            const prefix = Number(prefixText), local = addressToBigInt(ifAddress);
            const bits = parsed.family === 4 ? 32 : 128;
            if (!local || local.family !== parsed.family || !Number.isInteger(prefix) || prefix < 0 || prefix > bits) continue;
            const shift = BigInt(bits - prefix);
            if ((local.value >> shift) === (parsed.value >> shift)) return 'on-link';
        }
    }
    return 'public';
}

/** Classify the nominated ICE pair of the bundled transport. A relay on either
 * side, a reflexive local candidate, or a public peer address means the viewer
 * is off the LAN (cellular or Apple's relay); on-link and private peers are LAN.
 * Nothing identifying is returned: only candidate types and the reason. */
export function classifyWebRTCPath(pc: any, interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): WebRTCPathSummary {
    const types = ['host', 'srflx', 'prflx', 'relay'];
    let pair: any;
    let localType = 'unknown', remoteType = 'unknown', host = '';
    try {
        pair = pc?.dtlsTransports?.[0]?.iceTransport?.connection?.nominated;
        localType = choice(pair?.localCandidate?.type, types);
        remoteType = choice(pair?.remoteCandidate?.type, types);
        host = String(pair?.remoteCandidate?.host ?? '');
    }
    catch (_) { }
    if (!pair) return { kind: 'unknown', reason: 'no-pair', local: localType, remote: remoteType, family: 'unknown' };
    const parsed = addressToBigInt(host);
    const family = parsed?.family ?? 'unknown';
    if (remoteType === 'relay' || localType === 'relay') return { kind: 'remote', reason: 'relay', local: localType, remote: remoteType, family };
    if (localType === 'srflx') return { kind: 'remote', reason: 'reflexive', local: localType, remote: remoteType, family };
    const reason = classifyPeerAddress(host, interfaces);
    const kind: WebRTCPathKind = reason === 'invalid' ? 'unknown' : reason === 'public' ? 'remote' : 'lan';
    return { kind, reason, local: localType, remote: remoteType, family };
}
