/** Relay publication experiments (r37, r38).
 *
 * r36 logs from the iPhone and the Apple TV show Apple's relay listing Front's
 * signalless WebRTC participant with no published streams, so a viewer's
 * subscription to Front's on-demand video is never satisfied. Apple's own web
 * client registers each outgoing stream over WebRTC data channel "0" with a
 * QuickRelayWebProtocolMessage mediaInfoRequest (selfMediaParameters). Front's
 * HAP offer has no data channel. Successive solicited offers rotate through
 * variants so one test sitting compares several registration hypotheses.
 *
 * r37 found that the relay acknowledges Front's video only when the video RID is
 * the relay stream ID (the low 16 bits of the SSRC), yet it still published
 * nothing. r38 keeps that RID in every session and adds data channel
 * registration and published stream IDs on top of it.
 */
import { randomBytes } from 'crypto';

export type RelayVariant = 'dc-register' | 'dc-register-publish' | 'sdp-ssrc-labels' | 'sdp-sim-group' | 'sdp-rid-streamid'
    | 'rid-streamid' | 'rid-dc-register' | 'rid-dc-register-publish';

export const RELAY_REVISION = 38;
export const R37_RELAY_VARIANTS: readonly RelayVariant[] = Object.freeze<RelayVariant>([
    'dc-register', 'dc-register-publish', 'sdp-ssrc-labels', 'sdp-sim-group', 'sdp-rid-streamid',
]);
/** r38: every variant names the video RID after the relay stream ID. */
export const R38_RELAY_VARIANTS: readonly RelayVariant[] = Object.freeze<RelayVariant>([
    'rid-streamid', 'rid-dc-register', 'rid-dc-register-publish',
]);
const KNOWN_VARIANTS: readonly string[] = [...R37_RELAY_VARIANTS, ...R38_RELAY_VARIANTS];
export const RELAY_DATA_CHANNEL_LABEL = '0';

export interface RelayVariantPick { variant: RelayVariant; index: number; count: number }

export function createRelayVariantRotation(order: readonly string[] = R38_RELAY_VARIANTS) {
    const variants = order.filter((v): v is RelayVariant => KNOWN_VARIANTS.includes(v));
    let next = 0;
    return {
        next(): RelayVariantPick | undefined {
            if (!variants.length) return undefined;
            const index = next++ % variants.length;
            return { variant: variants[index], index, count: variants.length };
        },
    };
}

export const usesRelayDataChannel = (variant?: RelayVariant) => variant === 'dc-register' || variant === 'dc-register-publish'
    || variant === 'rid-dc-register' || variant === 'rid-dc-register-publish';
export const usesStreamIdRid = (variant?: RelayVariant) => variant === 'sdp-rid-streamid' || variant === 'rid-streamid'
    || variant === 'rid-dc-register' || variant === 'rid-dc-register-publish';
export const publishesRelayStreams = (variant?: RelayVariant) => variant === 'dc-register-publish' || variant === 'rid-dc-register-publish';

/** Apple's relay-generated blob uses the low 16 bits of each SSRC as its stream ID (r36: cf3827b9 -> 10169). */
export function relayStreamId(ssrc: number): number {
    return (ssrc >>> 0) & 0xffff;
}

export interface RelaySdpIds { videoSsrc: number; audioSsrc: number; videoRid: string }

/** Decorate only what a variant tests; data channel setup itself is left to werift. */
export function withRelaySdpVariant(sdp: string, variant: RelayVariant | undefined, ids: RelaySdpIds, defaultRid = '1'): string {
    const labels = variant === 'sdp-ssrc-labels', sim = variant === 'sdp-sim-group', renameRid = usesStreamIdRid(variant);
    if (!(labels || sim || renameRid) || typeof sdp !== 'string') return sdp;
    const newline = sdp.includes('\r\n') ? '\r\n' : '\n';
    const rid = String(ids.videoRid ?? '').replace(/[^A-Za-z0-9]/g, '');
    return sdp.split(/(?=^m=)/m).map(section => {
        const kind = /^m=(audio|video) [1-9]\d*(?:\/\d+)? /.exec(section)?.[1];
        if (!kind) return section;
        const ssrc = (kind === 'video' ? ids.videoSsrc : ids.audioSsrc) >>> 0;
        if (labels) {
            if (new RegExp('^a=ssrc:' + ssrc + ' msid:', 'm').test(section)) return section;
            const msid = /^a=msid:(\S+) (\S+?)\r?$/m.exec(section);
            const cname = new RegExp('^a=ssrc:' + ssrc + ' cname:[^\\r\\n]*(?:\\r?\\n|$)', 'm').exec(section);
            if (!msid || !cname) return section;
            const at = cname.index + cname[0].length;
            const prefix = cname[0].endsWith('\n') ? '' : newline;
            const lines = ['a=ssrc:' + ssrc + ' msid:' + msid[1] + ' ' + msid[2],
                'a=ssrc:' + ssrc + ' mslabel:' + msid[1], 'a=ssrc:' + ssrc + ' label:' + msid[2]];
            return section.slice(0, at) + prefix + lines.join(newline) + newline + section.slice(at);
        }
        if (kind !== 'video') return section;
        if (sim) {
            if (/^a=ssrc-group:SIM /m.test(section)) return section;
            const first = new RegExp('^a=ssrc:' + ssrc + ' ', 'm').exec(section);
            if (!first) return section;
            return section.slice(0, first.index) + 'a=ssrc-group:SIM ' + ssrc + newline + section.slice(first.index);
        }
        if (!rid || rid === defaultRid) return section;
        return section.replace(new RegExp('^a=rid:' + defaultRid + ' (send|recv)', 'm'), 'a=rid:' + rid + ' $1')
            .replace(new RegExp('^a=simulcast:(send|recv) ' + defaultRid + '(\\r?)$', 'm'), 'a=simulcast:$1 ' + rid + '$2');
    }).join('');
}

// --- Minimal protobuf for the few QuickRelayWebProtocolMessage fields used here ---

function varint(value: number | bigint): Buffer {
    let v = BigInt(value);
    if (v < 0n || v > 0xffffffffffffffffn) throw new RangeError('protobuf varint out of range');
    const bytes: number[] = [];
    do {
        let byte = Number(v & 0x7fn);
        v >>= 7n;
        if (v) byte |= 0x80;
        bytes.push(byte);
    } while (v);
    return Buffer.from(bytes);
}
const tag = (field: number, wire: number) => varint(field * 8 + wire);
const varintField = (field: number, value: number | bigint) => Buffer.concat([tag(field, 0), varint(value)]);
const bytesField = (field: number, value: Buffer) => Buffer.concat([tag(field, 2), varint(value.length), value]);
const stringField = (field: number, value: string) => bytesField(field, Buffer.from(value, 'utf8'));

export function ntpTimestamp(ms = Date.now()): bigint {
    const whole = Math.floor(ms / 1000);
    const fraction = Math.min(0xffffffff, Math.floor((ms - whole * 1000) / 1000 * 0x100000000));
    return ((BigInt(whole) + 2208988800n) << 32n) | BigInt(fraction);
}

export interface RelayStream { kind: 'video' | 'audio'; ssrc: number; mid?: string; rid?: string }

/** QuickRelayWebProtocolMessage{uuid=1, mediaInfoRequest=30{selfMediaParameters=2{mediaConfigs=1, ntpTimestamp=2}}}.
 * MediaConfig: qrStreamId=1, ssrc=2, mid=3, rid=4, mediaType=10 (Audio 0, Video 1). */
export function encodeRelayMediaRegistration(streams: readonly RelayStream[], uuid: Buffer = randomBytes(16), ntp: bigint = ntpTimestamp()): Buffer {
    const configs = streams.map(stream => {
        const parts = [varintField(1, relayStreamId(stream.ssrc)), varintField(2, stream.ssrc >>> 0)];
        if (stream.mid) parts.push(stringField(3, stream.mid));
        if (stream.rid) parts.push(stringField(4, stream.rid));
        parts.push(varintField(10, stream.kind === 'video' ? 1 : 0));
        return bytesField(1, Buffer.concat(parts));
    });
    const parameters = Buffer.concat([...configs, varintField(2, ntp)]);
    return Buffer.concat([bytesField(1, uuid), bytesField(30, bytesField(2, parameters))]);
}

/** QuickRelayWebProtocolMessage{uuid=1, sessionInfoRequest=40{requestId=1, publishedStreams=2 packed}}. */
export function encodeRelayPublishedStreams(streamIds: readonly number[], requestId: number, uuid: Buffer = randomBytes(16)): Buffer {
    const packed = Buffer.concat(streamIds.map(id => varint(id >>> 0)));
    return Buffer.concat([bytesField(1, uuid), bytesField(40, Buffer.concat([varintField(1, requestId >>> 0), bytesField(2, packed)]))]);
}

export interface ProtobufField { field: number; wire: number; value: bigint | Buffer }

function readVarint(buffer: Buffer, offset: number): [bigint, number] {
    let result = 0n;
    for (let i = 0, shift = 0n; i < 10; i++, shift += 7n) {
        if (offset >= buffer.length) throw new RangeError('truncated protobuf varint');
        const byte = buffer[offset++];
        result |= BigInt(byte & 0x7f) << shift;
        if (!(byte & 0x80)) return [result, offset];
    }
    throw new RangeError('protobuf varint too long');
}

export function readProtobufFields(buffer: Buffer, limit = 256): ProtobufField[] {
    const fields: ProtobufField[] = [];
    for (let offset = 0; offset < buffer.length;) {
        if (fields.length >= limit) throw new RangeError('too many protobuf fields');
        const [key, next] = readVarint(buffer, offset);
        offset = next;
        const field = Number(key >> 3n), wire = Number(key & 7n);
        if (field < 1) throw new RangeError('invalid protobuf field');
        if (wire === 0) {
            const [value, end] = readVarint(buffer, offset);
            offset = end;
            fields.push({ field, wire, value });
        }
        else if (wire === 2) {
            const [length, start] = readVarint(buffer, offset);
            if (length > BigInt(buffer.length - start)) throw new RangeError('truncated protobuf field');
            const end = start + Number(length);
            fields.push({ field, wire, value: buffer.subarray(start, end) });
            offset = end;
        }
        else if (wire === 1 || wire === 5) {
            const size = wire === 1 ? 8 : 4;
            if (offset + size > buffer.length) throw new RangeError('truncated protobuf fixed field');
            fields.push({ field, wire, value: buffer.subarray(offset, offset + size) });
            offset += size;
        }
        else throw new RangeError('unsupported protobuf wire type');
    }
    return fields;
}

export const RELAY_MESSAGE_NAMES: Readonly<Record<number, string>> = Object.freeze({
    2: 'error', 10: 'participantAllocateRequest', 11: 'participantAllocateResponse',
    12: 'unallocbindRequest', 13: 'unallocbindResponse', 20: 'infoRequest', 21: 'infoResponse',
    24: 'putmaterialRequest', 25: 'putmaterialResponse', 26: 'putmaterialIndication',
    27: 'getmaterialRequest', 28: 'getmaterialResponse', 30: 'mediaInfoRequest', 31: 'mediaInfoResponse',
    40: 'sessionInfoRequest', 41: 'sessionInfoResponse', 42: 'sessionInfoUpdate', 50: 'dataMessage',
    60: 'streamCompoundRequest', 61: 'streamCompoundResponse', 70: 'goAwayIndication',
    81: 'participantUpdateRequest', 82: 'participantUpdateResponse', 83: 'participantUpdateUpdate',
});

function packedVarints(field: ProtobufField, into: number[], max: number): void {
    if (field.wire === 0) {
        if (into.length < max) into.push(Number(field.value as bigint));
        return;
    }
    if (field.wire !== 2) return;
    const buffer = field.value as Buffer;
    for (let offset = 0; offset < buffer.length && into.length < max;) {
        const [value, next] = readVarint(buffer, offset);
        offset = next;
        into.push(Number(value));
    }
}

function errorSummary(buffer: Buffer): { code?: number; message?: string } {
    const out: { code?: number; message?: string } = {};
    for (const f of readProtobufFields(buffer, 32)) {
        if (f.wire === 0 && out.code === undefined) out.code = Number(f.value as bigint);
        else if (f.wire === 2 && out.message === undefined) {
            const text = (f.value as Buffer).toString('utf8');
            if (/^[\x20-\x7e]{1,200}$/.test(text)) out.message = text;
        }
    }
    return out;
}

/** SessionInfo.Response: generationCounter=1, peerPublishedStreams=2{peerParticipantId=2, peerStreamIds=3}, peerSubscribedStreams=3, error=4. */
function sessionInfoSummary(buffer: Buffer) {
    const out: { generationCounter?: number; peerPublished: { participant?: string; streams: number[] }[];
        peerSubscribed: number[]; error?: { code?: number; message?: string } } = { peerPublished: [], peerSubscribed: [] };
    for (const f of readProtobufFields(buffer)) {
        if (f.field === 1 && f.wire === 0) out.generationCounter = Number(f.value as bigint);
        else if (f.field === 2 && f.wire === 2 && out.peerPublished.length < 16) {
            const peer: { participant?: string; streams: number[] } = { streams: [] };
            for (const p of readProtobufFields(f.value as Buffer, 128)) {
                if (p.field === 2 && p.wire === 0) peer.participant = (p.value as bigint).toString();
                else if (p.field === 3) packedVarints(p, peer.streams, 32);
            }
            out.peerPublished.push(peer);
        }
        else if (f.field === 3) packedVarints(f, out.peerSubscribed, 32);
        else if (f.field === 4 && f.wire === 2) out.error = errorSummary(f.value as Buffer);
    }
    return out;
}

/** Bounded, JSON-safe summary of one relay data channel message; never throws. */
export function decodeRelayMessage(data: Buffer | string): Record<string, any> {
    if (typeof data === 'string') return { bytes: Buffer.byteLength(data), text: true };
    const summary: Record<string, any> = { bytes: data.length };
    try {
        const fields = readProtobufFields(data, 64);
        const uuid = fields.find(f => f.field === 1 && f.wire === 2)?.value as Buffer | undefined;
        if (uuid?.length === 16) summary.uuid = uuid.toString('hex').slice(0, 8);
        summary.kinds = fields.filter(f => f.field !== 1).slice(0, 8).map(f => RELAY_MESSAGE_NAMES[f.field] ?? 'field' + f.field);
        for (const f of fields) {
            if (f.wire !== 2 || f.field === 1) continue;
            const body = f.value as Buffer;
            if (f.field === 2) summary.error = errorSummary(body);
            else if (f.field === 31) {
                const error = readProtobufFields(body, 32).find(x => x.field === 2 && x.wire === 2);
                summary.mediaInfoResponse = error ? { error: errorSummary(error.value as Buffer) } : { ok: true };
            }
            else if (f.field === 41 || f.field === 42) summary[RELAY_MESSAGE_NAMES[f.field]] = sessionInfoSummary(body);
            else summary[RELAY_MESSAGE_NAMES[f.field] ?? 'field' + f.field] = { fields: readProtobufFields(body, 64).slice(0, 16).map(x => x.field) };
        }
    }
    catch (_) {
        summary.malformed = true;
    }
    return summary;
}

export type RelayDataChannelAnswer = 'accepted' | 'declined' | 'absent';

/** The bundled werift throws for a data channel section without an SCTP port, so a
 * declined section is removed before werift applies the answer. */
export function classifyRelayDataChannelAnswer(sdp: string): { state: RelayDataChannelAnswer; sdp: string } {
    const sections = String(sdp ?? '').split(/(?=^m=)/m);
    const index = sections.findIndex(section => section.startsWith('m=application '));
    if (index < 1) return { state: 'absent', sdp };
    const section = sections[index];
    const port = /^m=application (\d+)/.exec(section)?.[1];
    const sctpPort = /^a=sctp-port:\d+\r?$/m.test(section) || /^m=application \d+(?:\/\d+)? (?:UDP\/)?DTLS\/SCTP \d+/.test(section);
    if (port !== '0' && sctpPort) return { state: 'accepted', sdp };
    sections.splice(index, 1);
    return { state: 'declined', sdp: sections.join('') };
}

type Log = (message: string) => void;

/** Owns one session's experiment: data channel, registration, reply decoding and bounded diagnostics. */
export function createRelayPublisher(session: any, pick: RelayVariantPick, log: Log) {
    const dc = usesRelayDataChannel(pick.variant);
    const name = () => 'HomeKit WebRTC r' + RELAY_REVISION + ' relay: session ' + String(session?.sessionId?.toString?.('hex') ?? '').slice(0, 8) + '…';
    const state = {
        revision: RELAY_REVISION, variant: pick.variant, index: pick.index + 1, count: pick.count,
        dataChannel: (dc ? 'pending' : 'not-applicable') as string,
        answer: (dc ? 'pending' : 'not-applicable') as string,
        sctp: (dc ? 'not-started' : 'not-applicable') as string,
        opens: 0, closes: 0, remoteChannels: 0, sent: [] as string[], sendErrors: 0,
        received: 0, receivedBytes: 0, replies: [] as Record<string, any>[], registrationReplied: false,
    };
    const disposers: Array<() => void> = [];
    let channel: any, registrationUuid: string | undefined, publishTimer: ReturnType<typeof setTimeout> | undefined, requestId = 0;
    const streams = (): RelayStream[] => [
        { kind: 'video', ssrc: session.videoTransceiver?.sender?.ssrc, mid: session.videoTransceiver?.mid ?? undefined, rid: session.videoRid },
        { kind: 'audio', ssrc: session.audioTransceiver?.sender?.ssrc, mid: session.audioTransceiver?.mid ?? undefined },
    ];
    const describe = (list: RelayStream[]) => list.map(s => s.kind + ' stream ' + relayStreamId(s.ssrc) + ' ssrc '
        + (s.ssrc >>> 0).toString(16).padStart(8, '0') + ' mid ' + (s.mid ?? '-') + (s.rid ? ' rid ' + s.rid : '')).join('; ');
    const send = (label: string, bytes: Buffer) => {
        try {
            if (channel?.readyState !== 'open') throw new Error('data channel is ' + channel?.readyState);
            channel.send(bytes);
            if (state.sent.length < 8) state.sent.push(label);
            log(name() + ' sent ' + label + ' (' + bytes.length + ' B)');
        }
        catch (e) {
            state.sendErrors++;
            log(name() + ' could not send ' + label + ': ' + ((e as Error)?.message ?? e));
        }
    };
    const publish = () => {
        if (publishTimer) clearTimeout(publishTimer);
        publishTimer = undefined;
        if (!publishesRelayStreams(pick.variant) || state.sent.some(s => s.startsWith('sessionInfoRequest'))) return;
        const ids = streams().map(s => relayStreamId(s.ssrc));
        send('sessionInfoRequest published=[' + ids.join(',') + ']', encodeRelayPublishedStreams(ids, ++requestId));
    };
    const opened = () => {
        if (++state.opens > 1) return;
        const list = streams();
        if (!list.every(s => Number.isInteger(s.ssrc))) {
            log(name() + ' has no sender SSRC to register');
            return;
        }
        const uuid = randomBytes(16);
        registrationUuid = uuid.toString('hex').slice(0, 8);
        send('mediaInfoRequest ' + describe(list), encodeRelayMediaRegistration(list, uuid));
        if (publishesRelayStreams(pick.variant)) {
            publishTimer = setTimeout(publish, 2000);
            (publishTimer as any).unref?.();
        }
    };
    const received = (data: Buffer | string) => {
        state.received++;
        state.receivedBytes += typeof data === 'string' ? Buffer.byteLength(data) : data.length;
        const summary = decodeRelayMessage(data);
        if (state.replies.length < 24) {
            state.replies.push(summary);
            log(name() + ' received ' + JSON.stringify(summary));
        }
        if (registrationUuid && summary.uuid === registrationUuid) {
            state.registrationReplied = true;
            publish();
        }
    };
    const observe = (target: any, remote: boolean) => {
        const subscriptions = [
            target?.stateChanged?.subscribe?.((value: string) => {
                if (value === 'closed') state.closes++;
                log(name() + ' data channel ' + (remote ? 'remote ' : '') + JSON.stringify(String(target?.label ?? '')) + ' ' + value);
                if (value === 'open' && !remote) opened();
            }),
            target?.onMessage?.subscribe?.((data: Buffer | string) => received(data)),
        ];
        for (const s of subscriptions) if (typeof s?.unSubscribe === 'function') disposers.push(() => s.unSubscribe());
    };
    return {
        /** Before createOffer: add data channel "0" for a data channel variant. */
        attach(pc: any) {
            if (!dc) return;
            const manager = pc?.sctpManager;
            if (typeof pc?.createDataChannel !== 'function' || typeof manager?.connectSctp !== 'function') {
                state.dataChannel = 'unavailable';
                log(name() + ' cannot guard this werift SCTP startup; no data channel offered');
                return;
            }
            // The bundled werift reports "connected", which starts HomeKit media, only after
            // SCTP associates. A relay that accepts but never associates must not hold video.
            const connectSctp = manager.connectSctp;
            manager.connectSctp = function (this: any, ...args: any[]) {
                if (state.answer !== 'accepted') {
                    state.sctp = 'skipped';
                    return Promise.resolve();
                }
                state.sctp = 'connecting';
                Promise.resolve().then(() => connectSctp.apply(this, args)).then(() => {
                    state.sctp = 'connected';
                    log(name() + ' SCTP associated');
                }, (e: any) => {
                    state.sctp = 'failed';
                    log(name() + ' SCTP association failed: ' + (e?.message ?? e));
                });
                return Promise.resolve();
            };
            channel = pc.createDataChannel(RELAY_DATA_CHANNEL_LABEL);
            state.dataChannel = 'offered';
            observe(channel, false);
            const remote = pc.onDataChannel?.subscribe?.((incoming: any) => {
                if (incoming === channel) return;
                state.remoteChannels++;
                observe(incoming, true);
            });
            if (typeof remote?.unSubscribe === 'function') disposers.push(() => remote.unSubscribe());
        },
        /** Before werift applies the answer: returns the description werift should apply. */
        prepareAnswer(sdp: string): string {
            if (state.dataChannel !== 'offered') return sdp;
            const result = classifyRelayDataChannelAnswer(sdp);
            state.answer = result.state;
            if (result.state !== 'accepted') {
                // Park the never-started SCTP transport on the first media transport, so the
                // unanswered data channel transport is released with the other unused ones.
                const sctp = session.pc?.sctpManager?.sctpTransport;
                const media = session.pc?.getTransceivers?.()?.[0]?.dtlsTransport;
                if (sctp && media && sctp.dtlsTransport !== media) {
                    const receiver = media.dataReceiver;
                    sctp.setDtlsTransport(media);
                    if (typeof receiver === 'function') media.dataReceiver = receiver;
                }
            }
            log(name() + ' answer ' + (result.state === 'absent' ? 'omitted' : result.state) + ' the data channel');
            return result.sdp;
        },
        snapshot() {
            return { ...state, sent: [...state.sent], replies: state.replies.slice(0, 6) };
        },
        dispose() {
            if (publishTimer) clearTimeout(publishTimer);
            publishTimer = undefined;
            for (const dispose of disposers.splice(0)) {
                try { dispose(); } catch (_) { }
            }
        },
    };
}
