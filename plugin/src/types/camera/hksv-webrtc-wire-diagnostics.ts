/** Per-session observations of encrypted UDP sends. No payloads, addresses,
 * identifiers, keys, error messages or packet contents are retained in reports.
 * A socket callback confirms local completion, never remote reception.
 */
export function observeWebRTCWire(session: any) {
    const makeStream = () => ({ rtpCalls: 0, rtpReturnedZero: 0, rtpRejected: 0,
        sendAttempts: 0, sendCompletions: 0, sendErrors: 0, bytesCompleted: 0,
        maxDatagramBytes: 0, unexpectedSsrc: 0, errors: {} as Record<string, number> });
    const stats = { installedUdpTransports: 0, video: makeStream(), audio: makeStream(),
        clientHellos: { beforeNomination: 0, selectedSocketAndPeer: 0,
            otherSocket: 0, sameSocketOtherPeer: 0 } };
    const cleanup: (() => void)[] = [];
    const seenUdp = new Set<any>();
    let disposed = false;
    const kindFor = (pt: number) => pt === 99 ? 'video' : pt === 110 ? 'audio' : undefined;
    const auditKindFor = (pt: number, ssrc: number) => Number.isInteger(ssrc) && ssrc === session.videoTransceiver?.sender?.ssrc ? 'video'
        : Number.isInteger(ssrc) && ssrc === session.audioTransceiver?.sender?.ssrc ? 'audio' : kindFor(pt);
    const errorCode = (error: any) => ['EMSGSIZE', 'ENOBUFS', 'ENETUNREACH', 'EHOSTUNREACH',
        'EACCES', 'EINVAL', 'EBADF', 'ERR_SOCKET_DGRAM_NOT_RUNNING'].includes(error?.code)
        ? error.code : 'other';
    for (const dtls of session.pc.dtlsTransports ?? []) {
        const connection = dtls.iceTransport?.connection;
        try { session.probe?.installTransport(dtls); } catch (_) { }
        if (typeof dtls.sendRtp === 'function') {
            const original = dtls.sendRtp;
            const sendRtp = async function (this: any, payload: Buffer, header: any) {
                const kind = kindFor(header?.payloadType);
                try { const auditKind = auditKindFor(header?.payloadType, header?.ssrc);
                    if (auditKind) { session.contract?.observeRtp(auditKind, payload, header); session.probe?.observeRtp(auditKind, payload, header); } } catch (_) { }
                if (!kind) return original.call(this, payload, header);
                const stream = stats[kind];
                stream.rtpCalls++;
                try {
                    const result = await original.call(this, payload, header);
                    if (result === 0) stream.rtpReturnedZero++;
                    return result;
                } catch (error) { stream.rtpRejected++; throw error; }
            };
            dtls.sendRtp = sendRtp;
            cleanup.push(() => { if (dtls.sendRtp === sendRtp) dtls.sendRtp = original; });
        }
        for (const protocol of connection?.protocols ?? []) {
            const udp = protocol.transport;
            if (udp?.type !== 'udp' || !udp.socket || typeof udp.socket.send !== 'function'
                || typeof udp.send !== 'function' || seenUdp.has(udp)) continue;
            seenUdp.add(udp);
            stats.installedUdpTransports++;
            const originalSend = udp.send;
            const send = function (this: any, data: Buffer, addr?: [string, number]) {
                const kind = Buffer.isBuffer(data) && data.length >= 12 && data[0] >>> 6 === 2
                    ? kindFor(data[1] & 127) : undefined;
                try {
                    if (Buffer.isBuffer(data) && data.length >= 12 && data[0] >>> 6 === 2
                        && !(data[1] >= 192 && data[1] <= 223)) {
                        const auditKind = auditKindFor(data[1] & 127, data.readUInt32BE(8));
                        if (auditKind) { session.contract?.observeUdp(auditKind, data); session.probe?.observeUdp(auditKind, data, dtls); }
                    }
                } catch (_) { }
                // Keep STUN, DTLS, RTCP and unrelated payloads on their original path.
                if (!kind) return originalSend.call(this, data, addr);
                const stream = stats[kind];
                stream.sendAttempts++;
                stream.maxDatagramBytes = Math.max(stream.maxDatagramBytes, data.length);
                if (data.readUInt32BE(8) !== session[`${kind}Transceiver`]?.sender?.ssrc)
                    stream.unexpectedSsrc++;
                const target = addr ?? [this.rinfo?.address, this.rinfo?.port];
                return new Promise<void>((resolve, reject) => {
                    let settled = false;
                    const complete = (error?: any) => {
                        if (settled) return;
                        settled = true;
                        if (error) {
                            stream.sendErrors++;
                            const code = errorCode(error);
                            stream.errors[code] = (stream.errors[code] ?? 0) + 1;
                            reject(error);
                        } else {
                            stream.sendCompletions++;
                            stream.bytesCompleted += data.length;
                            resolve();
                        }
                    };
                    // The original numeric-address path omits this callback,
                    // so awaiting its promise does not confirm socket completion.
                    try { this.socket.send(data, target[1], target[0], complete); }
                    catch (error) { complete(error); }
                });
            };
            udp.send = send;
            cleanup.push(() => { if (udp.send === send) udp.send = originalSend; });
            const originalData = udp.onData;
            if (typeof originalData === 'function') {
                const onData = function (this: any, data: Buffer, addr: [string, number]) {
                    if (Buffer.isBuffer(data) && data.length >= 25 && data[0] === 22
                        && data[1] === 254 && [253, 255].includes(data[2])
                        && data.readUInt16BE(3) === 0 && data[13] === 1) {
                        const pair = connection.nominated;
                        const category = !pair ? 'beforeNomination'
                            : pair.protocol !== protocol ? 'otherSocket'
                            : pair.remoteAddr?.[0] === addr?.[0] && pair.remoteAddr?.[1] === addr?.[1]
                                ? 'selectedSocketAndPeer' : 'sameSocketOtherPeer';
                        stats.clientHellos[category]++;
                    }
                    // Observation only: retain normal ICE reception on all candidates.
                    return originalData.call(this, data, addr);
                };
                udp.onData = onData;
                cleanup.push(() => { if (udp.onData === onData) udp.onData = originalData; });
            }
        }
    }
    return {
        snapshot: () => ({ installedUdpTransports: stats.installedUdpTransports,
            video: { ...stats.video, errors: { ...stats.video.errors },
                pendingSends: stats.video.sendAttempts - stats.video.sendCompletions - stats.video.sendErrors },
            audio: { ...stats.audio, errors: { ...stats.audio.errors },
                pendingSends: stats.audio.sendAttempts - stats.audio.sendCompletions - stats.audio.sendErrors },
            clientHellos: { ...stats.clientHellos } }),
        dispose() {
            if (disposed) return;
            disposed = true;
            for (const restore of cleanup.reverse()) restore();
            cleanup.length = 0;
            seenUdp.clear();
        },
    };
}
