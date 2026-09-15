/** Controlled RFC 9626 experiment. Payload encryption remains unchanged. */
export const FRAME_MARKING_URI = 'urn:ietf:params:rtp-hdrext:framemarking';
export const frameMarkingExtension = () => ({ uri: FRAME_MARKING_URI });

/** Read only complete, non-scalable HEVC access units; never guess from ciphertext. */
export function independentHevcFrame(frame: Buffer): boolean | undefined {
    let offset = 0, vcl = false, independent = true;
    while (offset < frame.length) {
        if (offset + 4 > frame.length) return;
        const length = frame.readUInt32BE(offset); offset += 4;
        if (length < 2 || offset + length > frame.length) return;
        const a = frame[offset], b = frame[offset + 1], type = (a >> 1) & 63;
        // Short marking has no temporal or spatial scalability fields.
        if ((a & 128) || ((a & 1) << 5 | b >> 3) !== 0 || (b & 7) !== 1 || type >= 48) return;
        if (type < 32) { vcl = true; independent &&= type >= 16 && type <= 23; }
        offset += length;
    }
    return vcl ? independent : undefined;
}

export function createFrameMarkingProbe(session: any) {
    let timestamp: number | undefined, independent: boolean | undefined;
    let cachedSdp: string | undefined, accepted: number[] = [];
    const counts = { sourceFrames: 0, independentFrames: 0, unsupportedFrames: 0,
        markedPackets: 0, markedStarts: 0, markedEnds: 0, markedIndependentPackets: 0,
        unnegotiatedPackets: 0, metadataMissingPackets: 0 };
    const negotiation = () => {
        const sdp = session.pc?.remoteDescription?.sdp ?? '';
        if (sdp === cachedSdp) return accepted;
        cachedSdp = sdp; accepted = [];
        const section = sdp.split(/(?=^m=)/m).find((s: string) => /^m=video [1-9][0-9]* /.test(s));
        if (!section || /^a=(?:inactive|sendonly)\r?$/m.test(section)) return accepted;
        // Consult both the answer and the sender's actual negotiated parameters.
        for (const e of session.videoTransceiver?.sender?.headerExtensions ?? []) {
            if (e.uri !== FRAME_MARKING_URI || !Number.isInteger(e.id) || e.id < 1 || e.id > 14) continue;
            const line = new RegExp('^a=extmap:' + e.id + '(?:/(sendrecv|recvonly|sendonly|inactive))? ' + FRAME_MARKING_URI + '\\r?$', 'm').exec(section);
            if (line && (!line[1] || line[1] === 'sendrecv' || line[1] === 'recvonly')) accepted.push(e.id);
        }
        accepted = [...new Set(accepted)]; return accepted;
    };
    // r43: werift rebuilds the entire remote SDP string on every pc.remoteDescription
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
            if (!ids.length) { counts.unnegotiatedPackets++; return; }
            if (packet.header.timestamp !== timestamp || independent === undefined || !packet.payload.length) {
                counts.metadataMissingPackets++; return;
            }
            const descriptor = packet.payload[0];
            const bits = (descriptor & 0xc0) | (independent ? 0x20 : 0);
            for (const id of ids) {
                packet.header.extensions = (packet.header.extensions ?? []).filter((e: any) => e.id !== id);
                packet.header.extensions.push({ id, payload: Buffer.from([bits]) });
            }
            counts.markedPackets++;
            if (bits & 128) counts.markedStarts++;
            if (bits & 64) counts.markedEnds++;
            if (bits & 32) counts.markedIndependentPackets++;
        },
        snapshot() {
            const ids = refresh();
            return { revision: 36, experiment: 'negotiated-frame-marking',
                negotiated: !!ids.length, extensionIds: [...ids], ...counts };
        },
    };
}
