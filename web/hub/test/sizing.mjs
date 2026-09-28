// Terminal client sizing rules for warm frames. A frame without a layout must never size zellij.
import assert from 'node:assert/strict';
import test from 'node:test';

function harness({ width = 1140, height = 878, suspended = false } = {}) {
  const listeners = new Map();
  const resumeHandlers = new Set();
  const sockets = [];
  class FakeWebSocket {
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
    send(data) {
      if (this.readyState !== 1) throw new Error('InvalidStateError: still CONNECTING');
      this.sent.push(JSON.parse(data));
    }
    close() { this.readyState = 3; }
  }
  const state = { suspended };
  const win = {
    location: { origin: 'http://terminal.test', protocol: 'http:' },
    innerWidth: width,
    innerHeight: height,
    __mcwWarm: {
      isSuspended: () => state.suspended,
      onResume(callback) { resumeHandlers.add(callback); return () => resumeHandlers.delete(callback); },
    },
  };
  const vars = {};
  const previous = {};
  for (const key of ['WebSocket', 'window', 'document', 'addEventListener', 'removeEventListener', 'requestAnimationFrame']) previous[key] = globalThis[key];
  globalThis.WebSocket = FakeWebSocket;
  globalThis.window = win;
  globalThis.document = {
    location: win.location,
    title: '',
    querySelector: () => ({ style: {} }),
    getElementById: () => ({ style: {} }),
    documentElement: { style: { setProperty(name, value) { vars[name] = value; } } },
  };
  globalThis.addEventListener = (type, fn) => { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); };
  globalThis.removeEventListener = (type, fn) => { listeners.get(type)?.delete(fn); };
  globalThis.requestAnimationFrame = (callback) => { callback(); return 1; };

  // The fit follows the CSS viewport variables, as FitAddon follows #terminal's computed size.
  const fits = [];
  const fitAddon = {
    proposeDimensions() {
      const w = parseInt(vars['--dynamic-vw'] ?? `${win.innerWidth}px`, 10);
      const h = parseInt(vars['--dynamic-vh'] ?? `${win.innerHeight}px`, 10);
      const dims = { cols: Math.max(2, Math.floor(w / 9)), rows: Math.max(1, Math.floor(h / 18)) };
      fits.push({ ...dims, width: w, height: h });
      return dims;
    },
  };
  const term = {
    rows: 24,
    cols: 80,
    options: {},
    resizes: [],
    write() {},
    resize(cols, rows) { this.cols = cols; this.rows = rows; this.resizes.push({ cols, rows }); },
  };
  const fire = (type) => { for (const fn of [...(listeners.get(type) || [])]) fn({ type }); };
  const resume = () => { state.suspended = false; for (const fn of [...resumeHandlers]) fn(); };
  const terminalSocket = () => sockets.find((s) => s.url.includes('/ws/terminal'));
  const controlSocket = () => sockets.find((s) => s.url.endsWith('/ws/control'));
  // zellij's first terminal byte creates the control socket, which then opens.
  const attach = () => {
    terminalSocket().readyState = 1;
    terminalSocket().onmessage({ data: 'hello' });
    controlSocket().readyState = 1;
    controlSocket().onopen({});
  };
  const resizesSent = () => (controlSocket()?.sent || []).filter((m) => m.payload.type === 'TerminalResize').map((m) => m.payload);
  const restore = () => { for (const [key, value] of Object.entries(previous)) globalThis[key] = value; };
  return { win, state, vars, fits, fitAddon, term, sockets, fire, resume, attach, terminalSocket, controlSocket, resizesSent, restore, resumeHandlers };
}

const load = () => import('../public/assets/websockets.js');

test('a frame that loads while display:none does not attach to zellij until it is shown', async () => {
  const h = harness({ width: 0, height: 0 });
  try {
    const { initWebSockets } = await load();
    const client = initWebSockets('client', 'session', h.term, h.fitAddon, () => {});
    assert.equal(h.sockets.length, 0, 'no zellij client exists for a frame that was never laid out');
    assert.equal(h.fits.length, 0, 'nothing is measured from a 0x0 viewport');
    assert.deepEqual(h.term.resizes, []);
    assert.deepEqual(h.vars, {}, 'no 0px viewport variables are written');

    // The parent resumes the frame while it is still display:none, then shows it.
    h.resume();
    assert.equal(h.sockets.length, 0, 'resume alone does not attach while the frame still has no layout');
    h.win.innerWidth = 1140;
    h.win.innerHeight = 878;
    h.fire('resize');
    assert.equal(h.sockets.length, 1, 'the frame attaches on its first real size');
    assert.deepEqual(h.term.resizes, [{ cols: 126, rows: 48 }]);
    h.attach();
    assert.deepEqual(h.resizesSent(), [{ type: 'TerminalResize', rows: 48, cols: 126 }]);
    client.cleanup();
  } finally { h.restore(); }
});

test('no fit or TerminalResize is ever computed from a 0x0 viewport', async () => {
  const h = harness();
  try {
    const { initWebSockets } = await load();
    const client = initWebSockets('client', 'session', h.term, h.fitAddon, () => {});
    h.attach();
    const sentBefore = h.resizesSent().length;
    const fitsBefore = h.fits.length;
    h.win.innerWidth = 0;
    h.win.innerHeight = 0;
    h.fire('resize');
    h.controlSocket().onmessage({ data: JSON.stringify({ type: 'QueryTerminalSize' }) });
    assert.equal(h.fits.length, fitsBefore);
    assert.equal(h.resizesSent().length, sentBefore);
    assert.equal(h.term.cols, 126);
    assert.equal(h.vars['--dynamic-vw'], '1140px', 'the last real size is kept');
    h.win.innerWidth = 1410;
    h.win.innerHeight = 878;
    h.fire('resize');
    assert.deepEqual(h.resizesSent().at(-1), { type: 'TerminalResize', rows: 48, cols: 156 }, 'the owed size is sent once the frame has a layout');
    client.cleanup();
  } finally { h.restore(); }
});

test('a control socket that opens after the frame was hidden registers the grid it had while shown', async () => {
  const h = harness();
  try {
    const { initWebSockets } = await load();
    const client = initWebSockets('client', 'session', h.term, h.fitAddon, () => {});
    assert.deepEqual(h.term.resizes, [{ cols: 126, rows: 48 }]);
    h.state.suspended = true;
    const fitsWhileHidden = h.fits.length;
    h.attach();
    assert.equal(h.fits.length, fitsWhileHidden, 'the hidden frame does not measure');
    assert.deepEqual(h.resizesSent(), [{ type: 'TerminalResize', rows: 48, cols: 126 }], 'zellij gets the shown size, not its 80x24 default');
    h.controlSocket().onmessage({ data: JSON.stringify({ type: 'QueryTerminalSize' }) });
    assert.equal(h.resizesSent().length, 1, 'a size request while hidden waits');
    h.resume();
    assert.deepEqual(h.resizesSent().at(-1), { type: 'TerminalResize', rows: 48, cols: 126 }, 'the request is answered on resume');
    client.cleanup();
  } finally { h.restore(); }
});

test('a resize before the control socket opens is sent when it opens instead of throwing', async () => {
  const h = harness();
  try {
    const { initWebSockets } = await load();
    const client = initWebSockets('client', 'session', h.term, h.fitAddon, () => {});
    h.terminalSocket().readyState = 1;
    h.terminalSocket().onmessage({ data: 'hello' });
    h.win.innerWidth = 1000;
    assert.doesNotThrow(() => h.fire('resize'));
    assert.equal(h.term.cols, 111);
    h.controlSocket().readyState = 1;
    h.controlSocket().onopen({});
    assert.deepEqual(h.resizesSent(), [{ type: 'TerminalResize', rows: 48, cols: 111 }]);
    client.cleanup();
    assert.equal(h.resumeHandlers.size, 0);
  } finally { h.restore(); }
});
