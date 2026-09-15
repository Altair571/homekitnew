/** Bounded, timestamp-indexed fragments. All timestamps are NTP fixed-point seconds. */
export interface TimedFragment { data: Buffer; start: bigint; end: bigint; sequence?: number }
export const NTP_SECOND = 1n << 32n;
export function millisecondsToNtp(ms: number): bigint {
    return (BigInt(Math.trunc(ms)) * NTP_SECOND / 1000n) + 2208988800n * NTP_SECOND;
}

export class HksvRecordingBuffer {
    private fragments: TimedFragment[] = [];
    private init?: Buffer;
    private bytes = 0;
    private sequence = 0;
    private epoch = 0;
    private listeners = new Set<() => void>();
    private activities: { start: bigint; end: bigint; record: boolean }[] = [];
    constructor(private maxSeconds = 60, private maxBytes = 32 * 1024 * 1024) {}
    private changed() { for (const notify of [...this.listeners]) notify(); }
    reset(init?: Buffer, keepActivities = false) {
        ++this.epoch; this.init = init; this.fragments = []; this.bytes = 0; if (!keepActivities) this.activities = [];
        this.changed();
    }
    append(fragment: TimedFragment) {
        if (!this.init || fragment.end <= fragment.start) throw new Error('Invalid recording fragment');
        const last = this.fragments[this.fragments.length - 1];
        if (last && fragment.start < last.end - NTP_SECOND / 1000n)
            throw new Error('Recording timestamps moved backwards');
        const entry = { ...fragment, sequence: ++this.sequence };
        this.fragments.push(entry); this.bytes += entry.data.length;
        const cutoff = entry.end - BigInt(this.maxSeconds) * NTP_SECOND;
        while (this.fragments.length && (this.fragments[0].end <= cutoff || this.bytes > this.maxBytes))
            this.bytes -= this.fragments.shift()!.data.length;
        this.activities = this.activities.filter(a => a.end > cutoff);
        this.changed();
    }
    activity(start: bigint, durationMs: bigint, record: boolean) {
        if (durationMs <= 0n) throw new Error('Activity duration must be positive');
        const end = start + durationMs * NTP_SECOND / 1000n;
        const activities = this.activities.flatMap(a => {
            if (a.end <= start || a.start >= end) return [a];
            return [...(a.start < start ? [{ ...a, end: start }] : []), ...(a.end > end ? [{ ...a, start: end }] : [])];
        });
        activities.push({ start, end, record });
        if (activities.length > 512) throw new Error('Too many pending recording activity windows');
        this.activities = activities;
        this.changed();
    }
    open(start: bigint, stop?: bigint, pause = false): RecordingWindow {
        if (!this.init || !this.fragments.length) throw new Error('Recording buffer is not ready');
        if (start < this.fragments[0].start) throw new Error('Requested recording is older than retained media');
        if (start > this.fragments[this.fragments.length - 1].end + 60n * NTP_SECOND)
            throw new Error('Requested recording start is too far in the future');
        return new RecordingWindow(this, this.epoch, start, stop, pause);
    }
    validate(epoch: number) { if (epoch !== this.epoch) throw new Error('Recording source restarted or was disabled'); }
    initialization(epoch: number) { this.validate(epoch); return this.init!; }
    next(epoch: number, at: bigint, afterSequence?: number): TimedFragment | undefined {
        this.validate(epoch);
        const first = this.fragments[0];
        if (first && at < first.start && (afterSequence === undefined || first.sequence! > afterSequence + 1))
            throw new Error('Recording consumer fell behind retained media');
        return this.fragments.find(f => f.end > at && (afterSequence === undefined || f.sequence! > afterSequence));
    }
    allowed(fragment: TimedFragment): boolean {
        // A fragment cannot be cut at arbitrary samples without remuxing. Conservatively
        // omit the entire fragment if a should-not-record window intersects it.
        return !this.activities.some(a => !a.record && a.start < fragment.end && a.end > fragment.start);
    }
    wait(signal: AbortSignal): Promise<void> {
        if (signal.aborted) return Promise.resolve();
        return new Promise(resolve => {
            const done = () => { clearTimeout(timer); this.listeners.delete(done); signal.removeEventListener('abort', done); resolve(); };
            const timer = setTimeout(done, 1000);
            this.listeners.add(done); signal.addEventListener('abort', done, { once: true });
        });
    }
    wake() { this.changed(); }
}

export class RecordingWindow implements AsyncIterable<Buffer> {
    private stopped = new AbortController();
    private stopAt?: bigint;
    private pauseAtStop: boolean;
    private cursor: bigint;
    private lastSequence?: number;
    private closed = false;
    private yieldedInit = false;
    private lastMedia = Date.now();
    constructor(private buffer: HksvRecordingBuffer, private epoch: number, start: bigint, stop?: bigint, pause = false) {
        this.cursor = start; this.pauseAtStop = pause;
        if (stop !== undefined) this.stop(stop, pause);
    }
    stop(at: bigint, pause: boolean) {
        if (this.closed) throw new Error('Recording window is closed');
        if (at < this.cursor) throw new Error('Stop predates media already uploaded');
        this.stopAt = at; this.pauseAtStop = pause; this.buffer.wake();
    }
    resume(start: bigint, stop?: bigint, pause = false) {
        if (this.closed || this.stopAt === undefined || !this.pauseAtStop)
            throw new Error('Only a paused recording can resume');
        if (start < this.cursor || start < this.stopAt) throw new Error('Resume overlaps previously uploaded media');
        if (stop !== undefined && stop <= start) throw new Error('Invalid recording range');
        this.cursor = start; this.stopAt = stop; this.pauseAtStop = pause;
        this.lastMedia = Date.now(); this.buffer.wake();
    }
    cancel() { this.closed = true; this.stopped.abort(); this.buffer.wake(); }
    async *[Symbol.asyncIterator](): AsyncGenerator<Buffer> {
        try {
            if (!this.yieldedInit) { this.yieldedInit = true; yield this.buffer.initialization(this.epoch); }
            while (!this.closed) {
                this.buffer.validate(this.epoch);
                if (this.stopAt !== undefined && this.cursor >= this.stopAt) {
                    if (!this.pauseAtStop) return;
                    await this.buffer.wait(this.stopped.signal); continue;
                }
                const fragment = this.buffer.next(this.epoch, this.cursor, this.lastSequence);
                if (!fragment) {
                    if (Date.now() - this.lastMedia > 30000) throw new Error('Recording source stalled');
                    await this.buffer.wait(this.stopped.signal); continue;
                }
                if (this.stopAt !== undefined && fragment.start >= this.stopAt) { this.cursor = this.stopAt; continue; }
                this.cursor = fragment.end; this.lastSequence = fragment.sequence; this.lastMedia = Date.now();
                if (this.buffer.allowed(fragment)) yield fragment.data;
            }
        }
        finally { this.cancel(); }
    }
}
