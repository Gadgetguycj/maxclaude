import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { DeferredSizeUpdate, HIDDEN_BACKLOG_UNITS, HIDDEN_SLICE_BUDGET_MS, HIDDEN_SLICE_MAX_UNITS, HIDDEN_SLICE_MIN_UNITS, HIDDEN_SLICE_START_UNITS, HiddenParseQueue, WarmTerminalLifecycle, splitPayload, warmLimit, warmLimitForPointers, writeWithTerminal } from '../public/assets/warm.js';

test('warm limit keeps fifteen desktop clients and three touch or phone clients', () => {
  assert.equal(warmLimit(1440, false), 15);
  assert.equal(warmLimit(390, false), 3);
  assert.equal(warmLimit(1440, true), 3);
  assert.equal(warmLimitForPointers(1440, false, true), 15, 'a touch-capable mouse-first desktop stays at fifteen');
  assert.equal(warmLimitForPointers(1440, true, true), 3, 'a primary coarse-pointer device keeps three');
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /matchMedia\('\(pointer: coarse\)'\)/);
  assert.doesNotMatch(app, /any-pointer/);
});

test('SetConfig defers its hidden terminal size update until resume', () => {
  const calls = [];
  let suspended = true;
  const sizeUpdate = new DeferredSizeUpdate(
    () => suspended,
    () => calls.push('resize-and-send-size')
  );
  calls.push('apply-non-size-config');
  sizeUpdate.request();
  assert.deepEqual(calls, ['apply-non-size-config']);
  assert.equal(sizeUpdate.pending, true);
  suspended = false;
  calls.push('resume-renderer');
  sizeUpdate.resume();
  assert.deepEqual(calls, ['apply-non-size-config', 'resume-renderer', 'resize-and-send-size']);
  assert.equal(sizeUpdate.pending, false);
});

test('terminal websocket cleanup removes the deferred-resume handler', async () => {
  const previous = {
    WebSocket: globalThis.WebSocket,
    window: globalThis.window,
    document: globalThis.document,
    addEventListener: globalThis.addEventListener,
    requestAnimationFrame: globalThis.requestAnimationFrame,
  };
  const resumeHandlers = new Set();
  class FakeWebSocket {
    constructor(url) { this.url = url; FakeWebSocket.instances.push(this); }
    close() { this.closed = true; }
  }
  FakeWebSocket.instances = [];
  globalThis.WebSocket = FakeWebSocket;
  globalThis.window = {
    location: { origin: 'http://terminal.test', protocol: 'http:' },
    innerWidth: 1140,
    innerHeight: 878,
    __mcwWarm: {
      isSuspended: () => false,
      onResume(callback) { resumeHandlers.add(callback); return () => resumeHandlers.delete(callback); },
    },
  };
  globalThis.document = {
    location: globalThis.window.location,
    querySelector: () => null,
    documentElement: { style: { setProperty() {} } }
  };
  globalThis.addEventListener = () => {};
  globalThis.requestAnimationFrame = (callback) => { callback(); return 1; };
  try {
    const { initWebSockets } = await import('../public/assets/websockets.js');
    const terminal = { rows: 24, cols: 80, options: {}, write() {}, resize() {} };
    const fitAddon = { proposeDimensions: () => ({ rows: 24, cols: 80 }) };
    const client = initWebSockets('client', 'session', terminal, fitAddon, () => {});
    FakeWebSocket.instances[0].onmessage({ data: 'connected' });
    assert.equal(resumeHandlers.size, 1);
    assert.doesNotThrow(() => client.cleanup());
    assert.equal(resumeHandlers.size, 0);
  } finally {
    globalThis.WebSocket = previous.WebSocket;
    globalThis.window = previous.window;
    globalThis.document = previous.document;
    globalThis.addEventListener = previous.addEventListener;
    globalThis.requestAnimationFrame = previous.requestAnimationFrame;
  }
});

function fakeScheduler() {
  const pending = [];
  const schedule = (callback, urgent) => {
    const entry = { callback, urgent, cancelled: false };
    pending.push(entry);
    return () => { entry.cancelled = true; };
  };
  const live = () => pending.filter((entry) => !entry.cancelled && !entry.ran);
  const runNext = () => {
    const entry = live()[0];
    if (!entry) return false;
    entry.ran = true;
    entry.callback();
    return true;
  };
  return { schedule, pending, live, runNext };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

async function runAllSlices(scheduler) {
  let slices = 0;
  while (scheduler.runNext()) { slices += 1; await settle(); }
  return slices;
}

test('hidden output parses in bounded idle slices before the terminal is shown', async () => {
  const written = [];
  const scheduler = fakeScheduler();
  const queue = new HiddenParseQueue({ write: async (payload) => { written.push(payload); }, schedule: scheduler.schedule });
  const text = 'x'.repeat(100 * 1024);
  queue.push(text);
  assert.equal(scheduler.live().length, 1);
  assert.equal(scheduler.live()[0].urgent, false, 'a small backlog waits for idle time');
  assert.equal(written.length, 0, 'nothing is parsed synchronously on arrival');
  scheduler.runNext();
  await settle();
  assert.equal(written.length, 1);
  assert.ok(written[0].length <= HIDDEN_SLICE_START_UNITS, 'the first slice is bounded');
  await runAllSlices(scheduler);
  assert.equal(written.join(''), text, 'every unit is parsed in order');
  assert.equal(queue.units, 0);
  assert.equal(queue.length, 0);
  await queue.flush();
  assert.equal(queue.stats.lastFlushUnits, 0, 'showing the terminal replays nothing');
});

test('an idle hidden terminal schedules no work', async () => {
  const scheduler = fakeScheduler();
  const queue = new HiddenParseQueue({ write: async () => {}, schedule: scheduler.schedule });
  assert.equal(scheduler.pending.length, 0);
  queue.push('one line\r\n');
  await runAllSlices(scheduler);
  await settle();
  assert.equal(scheduler.live().length, 0, 'no callback stays scheduled once the queue is empty');
  assert.equal(scheduler.pending.length, 1);
});

test('slice size follows the per-slice time budget', async () => {
  let clock = 0;
  let unitsPerMs = 1024;
  const scheduler = fakeScheduler();
  const queue = new HiddenParseQueue({
    write: async (payload) => { clock += payload.length / unitsPerMs; },
    schedule: scheduler.schedule,
    now: () => clock,
  });
  queue.push('s'.repeat(HIDDEN_SLICE_START_UNITS));
  await runAllSlices(scheduler);
  assert.ok(queue.stats.lastSliceMs > HIDDEN_SLICE_BUDGET_MS);
  assert.equal(queue.sliceUnits, HIDDEN_SLICE_START_UNITS / 2, 'a slow slice halves the next slice');
  unitsPerMs = 1024 * 1024;
  for (let round = 0; round < 12; round += 1) {
    queue.push('f'.repeat(queue.sliceUnits));
    await runAllSlices(scheduler);
  }
  assert.equal(queue.sliceUnits, HIDDEN_SLICE_MAX_UNITS, 'fast full slices grow to the cap');
  unitsPerMs = 1;
  for (let round = 0; round < 20; round += 1) {
    queue.push('z'.repeat(queue.sliceUnits));
    await runAllSlices(scheduler);
  }
  assert.equal(queue.sliceUnits, HIDDEN_SLICE_MIN_UNITS, 'slow slices shrink to the floor');
});

test('a large hidden backlog moves from idle callbacks to timers', async () => {
  const scheduler = fakeScheduler();
  const queue = new HiddenParseQueue({ write: async () => {}, schedule: scheduler.schedule });
  queue.push('a'.repeat(1024));
  const idle = scheduler.live()[0];
  assert.equal(idle.urgent, false);
  queue.push('b'.repeat(HIDDEN_BACKLOG_UNITS));
  assert.equal(idle.cancelled, true, 'the idle callback is replaced');
  assert.equal(scheduler.live().length, 1);
  assert.equal(scheduler.live()[0].urgent, true);
});

test('split payloads keep order, surrogate pairs and binary bytes intact', async () => {
  const [head, rest] = splitPayload('ab\u{1F600}cd', 3);
  assert.equal(head, 'ab');
  assert.equal(rest, '\u{1F600}cd');
  const bytes = Uint8Array.from({ length: 50000 }, (_, index) => index % 251);
  const written = [];
  const scheduler = fakeScheduler();
  const queue = new HiddenParseQueue({ write: async (payload) => { written.push(payload); }, schedule: scheduler.schedule });
  queue.push(bytes.buffer);
  queue.push('tail');
  await runAllSlices(scheduler);
  assert.ok(written.length > 2, 'the binary payload was split across slices');
  const binary = written.filter((payload) => payload instanceof Uint8Array);
  const joined = new Uint8Array(binary.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of binary) { joined.set(part, offset); offset += part.byteLength; }
  assert.deepEqual(joined, bytes);
  assert.equal(written[written.length - 1], 'tail');
});

test('queued writes reach xterm through its supported write callback', async () => {
  const payloads = [];
  const term = { write(payload, done) { payloads.push(payload); setImmediate(done); } };
  const scheduler = fakeScheduler();
  const queue = new HiddenParseQueue({ write: (payload) => writeWithTerminal(term, payload), schedule: scheduler.schedule });
  queue.push('ab');
  queue.push('cd');
  queue.push('ef');
  await queue.flush();
  assert.deepEqual(payloads, ['ab', 'cd', 'ef']);
  assert.equal(queue.units, 0);
});

test('resume hands the whole remainder to xterm at once instead of one write per wait', async () => {
  const resolvers = [];
  const writes = [];
  const scheduler = fakeScheduler();
  const lifecycle = new WarmTerminalLifecycle({
    write: (payload) => { writes.push(payload); return new Promise((resolve) => resolvers.push(resolve)); },
    schedule: scheduler.schedule,
    suspendRenderer() {}, resumeRenderer() {}, releaseWebgl() {}, recreateWebgl() {}, setCursorBlink() {}, refresh() {},
  });
  lifecycle.suspend(false);
  lifecycle.write('one');
  lifecycle.write('two');
  lifecycle.write('three');
  const resumed = lifecycle.resume();
  await settle();
  assert.deepEqual(writes, ['one', 'two', 'three'], 'all queued payloads are issued before any callback');
  assert.equal(scheduler.live().length, 0, 'the pending idle slice is cancelled');
  for (const resolve of resolvers) resolve();
  await resumed;
  assert.equal(lifecycle.suspended, false);
  assert.equal(lifecycle.parseStats.lastFlushUnits, 11);
});

test('resume waits for an in-flight hidden slice and output that arrives meanwhile', async () => {
  const resolvers = [];
  const writes = [];
  const calls = [];
  const scheduler = fakeScheduler();
  const lifecycle = new WarmTerminalLifecycle({
    write: (payload) => { writes.push(payload); return new Promise((resolve) => resolvers.push(resolve)); },
    schedule: scheduler.schedule,
    suspendRenderer() {}, resumeRenderer: () => calls.push('resume-renderer'), releaseWebgl() {}, recreateWebgl() {}, setCursorBlink() {},
    refresh: () => calls.push('refresh'),
  });
  lifecycle.suspend(false);
  lifecycle.write('slice');
  scheduler.runNext();
  assert.deepEqual(writes, ['slice']);
  const resumed = lifecycle.resume();
  lifecycle.write('late');
  await settle();
  assert.deepEqual(writes, ['slice'], 'the flush waits for the slice xterm is parsing');
  resolvers.shift()();
  await settle();
  assert.deepEqual(writes, ['slice', 'late']);
  assert.deepEqual(calls, []);
  resolvers.shift()();
  await resumed;
  assert.deepEqual(calls, ['resume-renderer', 'refresh']);
  lifecycle.write('visible');
  assert.deepEqual(writes, ['slice', 'late', 'visible'], 'a shown terminal writes directly');
});

test('resume recreates the renderer, drains the real write stream, then refreshes', async () => {
  const calls = [];
  const scheduler = fakeScheduler();
  const lifecycle = new WarmTerminalLifecycle({
    write: async (payload) => { calls.push('write:' + payload); },
    schedule: scheduler.schedule,
    suspendRenderer: () => calls.push('pause-renderer'),
    resumeRenderer: () => calls.push('resume-renderer'),
    releaseWebgl: () => calls.push('release-webgl'),
    recreateWebgl: () => calls.push('recreate-webgl'),
    setCursorBlink: (value) => calls.push('blink:' + value),
    refresh: () => calls.push('refresh'),
  });
  lifecycle.suspend(true);
  lifecycle.write('first');
  lifecycle.write('second');
  await lifecycle.resume();
  assert.deepEqual(calls, [
    'blink:false', 'pause-renderer', 'release-webgl', 'recreate-webgl', 'blink:true',
    'write:first', 'write:second', 'resume-renderer', 'refresh'
  ]);
});

test('a WebGL recreation failure keeps the write path and completes resume', async () => {
  const calls = [];
  const scheduler = fakeScheduler();
  const lifecycle = new WarmTerminalLifecycle({
    write: async (payload) => { calls.push('write:' + payload); },
    schedule: scheduler.schedule,
    suspendRenderer: () => calls.push('pause-renderer'),
    resumeRenderer: () => calls.push('resume-renderer'),
    releaseWebgl: () => calls.push('release-webgl'),
    recreateWebgl: () => { calls.push('recreate-webgl'); throw new Error('no WebGL'); },
    setCursorBlink: (value) => calls.push('blink:' + value),
    refresh: () => calls.push('refresh'),
  });
  lifecycle.suspend(false);
  lifecycle.write('kept');
  await lifecycle.resume();
  assert.deepEqual(calls.slice(-3), ['write:kept', 'resume-renderer', 'refresh']);
  assert.equal(lifecycle.suspended, false);
});

test('terminal client wires hidden parsing to idle callbacks', () => {
  const terminal = fs.readFileSync(new URL('../public/assets/terminal.js', import.meta.url), 'utf8');
  assert.match(terminal, /schedule: browserSliceScheduler\(window\)/);
});
test('path link resources have a disposer for hidden and evicted frames', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /function disposeTerminalLinks\(frame\)/);
  assert.match(app, /disposeTerminalLinks\(frame\);\n  try \{ frame\.contentWindow\.__mcwWarm\?\.suspend/);
  assert.match(app, /linkProvider\.dispose\(\);/);
  assert.match(app, /renderSubscription\.dispose\(\);/);
  assert.match(app, /scrollSubscription\.dispose\(\);/);
});

test('disposed link requests cannot mutate overlays or call their provider callback', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /const linksLive = function \(\) \{/);
  assert.match(app, /if \(!linksLive\(\)\) return;\n            const links/);
  assert.match(app, /if \(!linksLive\(\)\) return;\n            knownLinks\.delete/);
  assert.match(app, /if \(!linksLive\(\) \|\| generation !== overlayGeneration\) return;/);
});

test('terminal warm lifecycle does not patch xterm private renderer state', () => {
  const terminal = fs.readFileSync(new URL('../public/assets/terminal.js', import.meta.url), 'utf8');
  assert.doesNotMatch(terminal, /_core|refreshRows/);
  assert.match(terminal, /writeWithTerminal\(term, payload\)/);
});
