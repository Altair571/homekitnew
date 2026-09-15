import type { RtpPacket } from '@koush/werift-src/packages/rtp/src/rtp/rtp';

/** Bound UDP bursts after the reliable local TCP relay. Preserve every packet and
 * timestamp; fail an overloaded session rather than silently dropping HEVC fragments. */
export function createHksvRtpPacer(send: (packet: RtpPacket) => void, fail: (error: Error) => void, options?: {
    now?: () => number;
    schedule?: (fn: () => void, ms: number) => any;
    unschedule?: (timer: any) => void;
    bytesPerSecond?: number;
    burstBytes?: number;
    maxQueueBytes?: number;
}) {
    const now = options?.now ?? (() => Number(process.hrtime.bigint()) / 1e6);
    const schedule = options?.schedule ?? setTimeout;
    const unschedule = options?.unschedule ?? clearTimeout;
    const bytesPerMs = (options?.bytesPerSecond ?? 5_000_000) / 1000; // 40 Mbps, well above the 4K target.
    const burst = options?.burstBytes ?? 32768;
    const limit = options?.maxQueueBytes ?? 8 * 1024 * 1024;
    let queue: Array<{ packet: RtpPacket; bytes: number }> = [], head = 0, queuedBytes = 0;
    let credit = burst, previous = now(), timer: any, closed = false;
    function close() {
        closed = true;
        if (timer !== undefined) unschedule(timer);
        timer = undefined; queue = []; head = 0; queuedBytes = 0;
    }
    function drain() {
        timer = undefined;
        if (closed) return;
        const time = now();
        credit = Math.min(burst, credit + Math.max(0, time - previous) * bytesPerMs);
        previous = time;
        while (head < queue.length && queue[head].bytes <= credit) {
            const next = queue[head++];
            credit -= next.bytes; queuedBytes -= next.bytes;
            try { send(next.packet); } catch (e) { close(); fail(new Error('HomeKit RTP send failed')); return; }
            if (closed) return;
        }
        if (head === queue.length) { queue = []; head = 0; }
        else {
            if (head >= 256) { queue = queue.slice(head); head = 0; }
            timer = schedule(drain, Math.max(1, Math.ceil((queue[head].bytes - credit) / bytesPerMs)));
        }
    }
    return {
        enqueue(packet: RtpPacket) {
            if (closed) return;
            const bytes = packet.payload.length + 64; // Allow RTP/SRTP/UDP/IP overhead.
            if (bytes > burst || queuedBytes + bytes > limit) {
                close(); fail(new Error('HomeKit RTP queue exceeded its limit; source bursts are too large')); return;
            }
            queue.push({ packet, bytes }); queuedBytes += bytes;
            if (timer === undefined) drain();
        },
        close,
    };
}
