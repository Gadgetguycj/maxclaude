// Hidden terminals parse queued output in small idle-time slices so showing one never replays a backlog.
export const HIDDEN_SLICE_BUDGET_MS = 5;
export const HIDDEN_SLICE_MIN_UNITS = 1024;
export const HIDDEN_SLICE_START_UNITS = 16 * 1024;
export const HIDDEN_SLICE_MAX_UNITS = 256 * 1024;
export const HIDDEN_IDLE_TIMEOUT_MS = 250;
// Above this backlog, slices run on plain timers instead of waiting for idle time.
export const HIDDEN_BACKLOG_UNITS = 256 * 1024;

// Strings count UTF-16 code units and binary payloads count bytes. Both are what xterm parses.
export function payloadUnits(payload) {
    if (typeof payload === "string") return payload.length;
    if (payload instanceof ArrayBuffer) return payload.byteLength;
    if (ArrayBuffer.isView(payload)) return payload.byteLength;
    return 0;
}

export function splitPayload(payload, units) {
    if (typeof payload === "string") {
        let cut = units;
        const code = payload.charCodeAt(cut - 1);
        if (cut > 1 && code >= 0xd800 && code <= 0xdbff) cut -= 1;
        return [payload.slice(0, cut), payload.slice(cut)];
    }
    const bytes = payload instanceof ArrayBuffer
        ? new Uint8Array(payload)
        : new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
    return [bytes.subarray(0, units), bytes.subarray(units)];
}

export function writeWithTerminal(term, payload) {
    return new Promise((resolve) => term.write(payload, resolve));
}

export function browserSliceScheduler(win) {
    return (callback, urgent) => {
        if (!urgent && typeof win.requestIdleCallback === "function") {
            const id = win.requestIdleCallback(callback, { timeout: HIDDEN_IDLE_TIMEOUT_MS });
            return () => win.cancelIdleCallback(id);
        }
        const id = win.setTimeout(callback, urgent ? 0 : 16);
        return () => win.clearTimeout(id);
    };
}

export function warmLimitForPointers(viewportWidth, primaryPointerCoarse, anyPointerCoarse) {
    // any-pointer describes optional hardware. The primary pointer decides touch-first use.
    void anyPointerCoarse;
    return viewportWidth <= 760 || primaryPointerCoarse ? 3 : 15;
}

export function warmLimit(viewportWidth, primaryPointerCoarse) {
    return warmLimitForPointers(viewportWidth, primaryPointerCoarse, false);
}

export class HiddenParseQueue {
    constructor({
        write,
        schedule,
        now = () => performance.now(),
        budgetMs = HIDDEN_SLICE_BUDGET_MS,
        backlogUnits = HIDDEN_BACKLOG_UNITS,
    }) {
        this._write = write;
        this._scheduleSlice = schedule;
        this._now = now;
        this._budgetMs = budgetMs;
        this._backlogUnits = backlogUnits;
        this._items = [];
        this._units = 0;
        this._cancel = null;
        this._scheduledUrgent = false;
        this._inFlight = null;
        this._flushing = false;
        this._sliceUnits = HIDDEN_SLICE_START_UNITS;
        this.stats = { slices: 0, slicedUnits: 0, maxSliceMs: 0, lastSliceMs: 0, flushes: 0, flushedUnits: 0, lastFlushUnits: 0, lastFlushMs: 0 };
    }

    get units() { return this._units; }
    get length() { return this._items.length; }
    get sliceUnits() { return this._sliceUnits; }

    push(payload) {
        const units = payloadUnits(payload);
        this._items.push({ payload, units });
        this._units += units;
        this._schedule();
    }

    _schedule() {
        if (this._flushing || this._inFlight || !this._items.length) return;
        const urgent = this._units >= this._backlogUnits;
        if (this._cancel) {
            if (!urgent || this._scheduledUrgent) return;
            this._cancel();
            this._cancel = null;
        }
        this._scheduledUrgent = urgent;
        this._cancel = this._scheduleSlice(() => {
            this._cancel = null;
            this._runSlice();
        }, urgent);
    }

    _take(limit) {
        const payloads = [];
        let units = 0;
        while (this._items.length && units < limit) {
            const head = this._items[0];
            const room = limit - units;
            if (head.units <= room) {
                this._items.shift();
                payloads.push(head.payload);
                units += head.units;
                continue;
            }
            const [first, rest] = splitPayload(head.payload, room);
            const firstUnits = payloadUnits(first);
            if (firstUnits === 0) break;
            head.payload = rest;
            head.units -= firstUnits;
            payloads.push(first);
            units += firstUnits;
        }
        this._units -= units;
        return { payloads, units };
    }

    _writeBatch(payloads) {
        // xterm parses queued writes in order, so the last callback means the whole batch is parsed.
        let last = null;
        for (const payload of payloads) last = this._write(payload);
        return Promise.resolve(last);
    }

    _runSlice() {
        if (this._flushing || this._inFlight || !this._items.length) return;
        const limit = this._sliceUnits;
        const { payloads, units } = this._take(limit);
        const started = this._now();
        this._inFlight = this._writeBatch(payloads).then(() => {
            const elapsed = this._now() - started;
            this.stats.slices += 1;
            this.stats.slicedUnits += units;
            this.stats.lastSliceMs = elapsed;
            if (elapsed > this.stats.maxSliceMs) this.stats.maxSliceMs = elapsed;
            if (elapsed > this._budgetMs) {
                this._sliceUnits = Math.max(HIDDEN_SLICE_MIN_UNITS, Math.floor(this._sliceUnits / 2));
            } else if (units >= limit && elapsed < this._budgetMs / 2) {
                this._sliceUnits = Math.min(HIDDEN_SLICE_MAX_UNITS, this._sliceUnits * 2);
            }
        }).finally(() => {
            this._inFlight = null;
            this._schedule();
        });
    }

    async flush() {
        this._flushing = true;
        if (this._cancel) {
            this._cancel();
            this._cancel = null;
        }
        const started = this._now();
        let flushed = 0;
        try {
            while (this._inFlight || this._items.length) {
                if (this._inFlight) {
                    await this._inFlight;
                    continue;
                }
                const { payloads, units } = this._take(Infinity);
                flushed += units;
                await this._writeBatch(payloads);
            }
        } finally {
            this._flushing = false;
            this.stats.flushes += 1;
            this.stats.flushedUnits += flushed;
            this.stats.lastFlushUnits = flushed;
            this.stats.lastFlushMs = this._now() - started;
        }
    }
}

export class DeferredSizeUpdate {
    constructor(isSuspended, apply) {
        this._isSuspended = isSuspended;
        this._apply = apply;
        this._pending = false;
    }

    get pending() { return this._pending; }

    request() {
        if (this._isSuspended()) {
            this._pending = true;
            return;
        }
        this._apply();
    }

    resume() {
        if (!this._pending) return;
        this._pending = false;
        this._apply();
    }
}

export class WarmTerminalLifecycle {
    constructor({ write, schedule, now, suspendRenderer, resumeRenderer, releaseWebgl, recreateWebgl, setCursorBlink, refresh }) {
        this._write = write;
        this._suspendRenderer = suspendRenderer;
        this._resumeRenderer = resumeRenderer;
        this._releaseWebgl = releaseWebgl;
        this._recreateWebgl = recreateWebgl;
        this._setCursorBlink = setCursorBlink;
        this._refresh = refresh;
        this._queue = new HiddenParseQueue({ write, schedule, now });
        this._suspended = false;
        this._savedCursorBlink = false;
    }

    get queuedUnits() { return this._queue.units; }
    get suspended() { return this._suspended; }
    get parseStats() { return { ...this._queue.stats, queuedUnits: this._queue.units, sliceUnits: this._queue.sliceUnits }; }

    write(payload) {
        if (this._suspended) {
            this._queue.push(payload);
            return;
        }
        void this._write(payload);
    }

    suspend(cursorBlink) {
        if (this._suspended) return;
        this._suspended = true;
        this._savedCursorBlink = !!cursorBlink;
        this._setCursorBlink(false);
        this._suspendRenderer();
        this._releaseWebgl();
    }

    async resume() {
        if (!this._suspended) return;
        try {
            this._recreateWebgl();
        } catch (_) {
            // WebGL is optional. xterm keeps its DOM renderer when recreation fails.
        }
        this._setCursorBlink(this._savedCursorBlink);
        await this._queue.flush();
        this._resumeRenderer();
        this._refresh();
        this._suspended = false;
    }
}
