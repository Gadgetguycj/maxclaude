// Real-browser regression test for hidden warm terminals affecting terminal size.
//
// Two browser profiles open the same zellij session, as the operator's desktop and phone do.
// The viewer keeps it on screen. The holder keeps it as a hidden warm frame and puts that frame
// through each way a warm terminal can load or change while hidden. zellij draws a session at the
// smallest size any attached client reported, so a hidden frame that reports its 0x0 viewport
// squeezes the viewer's session into a strip a few columns wide.
//
// Run against a configured test host, where zellij runs:
//   MCW_URL=https://hub.example.com/ MCW_PROXY=socks5://127.0.0.1:1091 node test/thin-strip.browser.mjs
// It creates throwaway sessions fix-a-rt-1 and fix-a-rt-2 and deletes them afterwards.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const URL_BASE = process.env.MCW_URL;
const required = ['MCW_URL', 'MCW_PASSWORD', 'MCW_ZELLIJ'];
const missing = required.filter((name) => !process.env[name]);
if (missing.length) { console.log(`SKIP: set ${missing.join(', ')} for the terminal-sizing browser test`); process.exit(0); }
const { chromium } = await import(process.env.MCW_PLAYWRIGHT_MODULE || 'playwright');
const PROXY = process.env.MCW_PROXY || '';
const CHROME = process.env.MCW_CHROME || undefined;
const PASSWORD = process.env.MCW_PASSWORD;
const ZELLIJ = process.env.MCW_ZELLIJ;
const S = 'fix-a-rt-1';
const O = 'fix-a-rt-2';
const STRIP_COLS = 20;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// zellij commands must not inherit a surrounding zellij session, or they act on it.
const zellijEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ZELLIJ')));
const zellij = (...args) => execFileSync(ZELLIJ, args, { env: zellijEnv, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcw-sizing-'));
fs.writeFileSync(`${scriptDir}/show.sh`, '#!/bin/bash\nwhile true; do printf "\\033[2J\\033[H FIX-A %s size=%s\\n" "$ZELLIJ_SESSION_NAME" "$(stty size)"; sleep 2; done\n', { mode: 0o755 });
fs.writeFileSync(`${scriptDir}/show.kdl`, `layout {\n    pane command="bash" {\n        args "${scriptDir}/show.sh"\n    }\n}\n`);

function createSessions() {
  const live = zellij('list-sessions', '-n', '-s').split('\n');
  for (const name of [S, O]) if (!live.includes(name)) zellij('--layout', `${scriptDir}/show.kdl`, 'attach', '--create-background', name);
}
function deleteSessions() {
  for (const name of [S, O]) { try { zellij('delete-session', '--force', name); } catch { /* already gone */ } }
  fs.rmSync(scriptDir, { recursive: true, force: true });
}

// Runs in every terminal iframe: records each TerminalResize with the frame's viewport at that moment.
const FRAME_PROBE = () => {
  if (window === window.top) return;
  window.__rt = { sent: [] };
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) {
    if (typeof data === 'string' && data.includes('"TerminalResize"')) {
      const msg = JSON.parse(data);
      let hidden = null;
      try { hidden = window.frameElement.classList.contains('warm-hidden'); } catch { /* detached */ }
      window.__rt.sent.push({ rows: msg.payload.rows, cols: msg.payload.cols, inner: [innerWidth, innerHeight], hidden });
    }
    return send.call(this, data);
  };
};

const INSPECT = (name) => {
  const f = [...document.querySelectorAll('.term-frame')].find((x) => x.dataset.name === name);
  if (!f) return null;
  const out = { visible: f.classList.contains('active') && !f.classList.contains('warm-hidden') };
  const r = f.getBoundingClientRect();
  out.frame = [Math.round(r.width), Math.round(r.height)];
  try {
    const w = f.contentWindow;
    out.sent = w.__rt ? w.__rt.sent : [];
    const t = w.term;
    if (t) {
      out.cols = t.cols; out.rows = t.rows;
      const screen = w.document.querySelector('.xterm-screen').getBoundingClientRect();
      out.screen = [Math.round(screen.width), Math.round(screen.height)];
      const b = t.buffer.active;
      let drawn = 0;
      for (let y = 0; y < t.rows; y += 1) {
        const line = b.getLine(b.viewportY + y);
        const s = line ? line.translateToString(true) : '';
        if (s.length > drawn) drawn = s.length;
      }
      out.drawnCols = drawn;
    }
  } catch (e) { out.err = String(e); }
  return out;
};

async function open(profile, viewport) {
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: CHROME,
    headless: process.env.HEADFUL !== '1',
    proxy: PROXY ? { server: PROXY } : undefined,
    viewport,
  });
  await context.addInitScript(FRAME_PROBE);
  const page = context.pages()[0] || await context.newPage();
  await page.goto(URL_BASE, { waitUntil: 'domcontentloaded' });
  if (await page.waitForSelector('#login-password', { state: 'visible', timeout: 15000 }).then(() => true, () => false)) {
    await page.fill('#login-password', PASSWORD);
    await page.click('#login-submit');
  }
  await rowsReady(page);
  return { context, page };
}
async function rowsReady(page) {
  await page.waitForSelector('#app:not([hidden])', { timeout: 30000 });
  await page.waitForFunction((names) => names.every((n) => [...document.querySelectorAll('.row[data-name]')].some((r) => r.dataset.name === n)), [S, O], { timeout: 30000 });
}
async function click(page, name) {
  await page.evaluate((n) => {
    const row = [...document.querySelectorAll('.row[data-name]')].find((r) => r.dataset.name === n && r.dataset.kind !== 'recent');
    row.scrollIntoView({ block: 'center' });
    row.click();
  }, name);
}
const inspect = (page, name) => page.evaluate(INSPECT, name);
const results = [];
function check(label, ok, detail) {
  results.push({ label, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ' ' + JSON.stringify(detail) : ''}`);
}

// The session as the viewer sees it must never be squeezed by the holder's hidden frame.
async function viewerNotSqueezed(viewer, label) {
  const v = await inspect(viewer, S);
  check(`${label}: viewer still sees the whole session`, !!v && v.visible && v.drawnCols >= v.cols - 1, v && { cols: v.cols, drawnCols: v.drawnCols });
}
// No TerminalResize may be computed from a viewport the frame never had, or be strip sized.
function noBogusSize(h, label) {
  const bad = (h?.sent || []).filter((m) => m.inner[0] === 0 || m.inner[1] === 0 || m.cols < STRIP_COLS);
  check(`${label}: holder frame sent no size from a 0x0 viewport`, bad.length === 0, { bad, sent: h?.sent });
}
// zellij draws the session at the smaller of the two visible clients, so the holder's drawing is
// as wide as the narrower of the holder and the viewer.
async function holderFills(holder, viewer, label) {
  const h = await inspect(holder, S);
  const v = await inspect(viewer, S);
  const expected = Math.min(h?.cols ?? 0, v?.cols ?? 0);
  const ok = !!h && h.visible && h.cols >= STRIP_COLS && h.screen[0] >= h.frame[0] - 20 && h.drawnCols >= expected - 1;
  check(`${label}: shown holder frame fills its area`, ok, h && { cols: h.cols, rows: h.rows, frame: h.frame, screen: h.screen, drawnCols: h.drawnCols, viewerCols: v?.cols });
  return h;
}

// Makes the holder's S frame load while hidden: shown, then its document reloads after O is shown.
async function reloadWhileHidden(holder) {
  await click(holder, S); await sleep(2500);
  await click(holder, O); await sleep(1500);
  await holder.evaluate((n) => {
    const f = [...document.querySelectorAll('.term-frame')].find((x) => x.dataset.name === n);
    f.contentWindow.location.reload();
  }, S);
  await sleep(6000);
}

async function main() {
  createSessions();
  const profiles = fs.mkdtempSync('/tmp/fix-a-rt-profiles-');
  const viewer = await open(`${profiles}/viewer`, { width: 1440, height: 900 });
  const holder = await open(`${profiles}/holder`, { width: 1440, height: 900 });
  try {
    await click(viewer.page, S); await sleep(3000);
    await viewerNotSqueezed(viewer.page, 'baseline');

    // 1. A warm terminal first loaded while hidden: S and O are clicked in one task, so S's
    // iframe is hidden before its document exists.
    await holder.page.evaluate(([a, b]) => {
      for (const n of [a, b]) [...document.querySelectorAll('.row[data-name]')].find((r) => r.dataset.name === n && r.dataset.kind !== 'recent').click();
    }, [S, O]);
    await sleep(6000);
    let h = await inspect(holder.page, S);
    check('first load while hidden: the frame loaded hidden', !!h && !h.visible, h && { visible: h.visible });
    noBogusSize(h, 'first load while hidden');
    await viewerNotSqueezed(viewer.page, 'first load while hidden');
    await click(holder.page, S); await sleep(2500);
    await holderFills(holder.page, viewer.page, 'first load while hidden');
    await viewerNotSqueezed(viewer.page, 'first load while hidden, after show');

    // 2. The sidebar collapsed while the frame is hidden and loaded hidden.
    await reloadWhileHidden(holder.page);
    await holder.page.click('#hide-sidebar');
    await sleep(1500);
    h = await inspect(holder.page, S);
    noBogusSize(h, 'sidebar collapsed while hidden');
    await viewerNotSqueezed(viewer.page, 'sidebar collapsed while hidden');
    await click(holder.page, S); await sleep(2500);
    h = await holderFills(holder.page, viewer.page, 'sidebar collapsed while hidden');
    check('sidebar collapsed while hidden: frame took the collapsed width', !!h && h.frame[0] >= 1400, h && { frame: h.frame });
    await holder.page.click('#show-sidebar');
    await sleep(1000);

    // 3. A window resize while the frame is hidden and loaded hidden.
    await reloadWhileHidden(holder.page);
    await holder.page.setViewportSize({ width: 1100, height: 760 });
    await sleep(1500);
    h = await inspect(holder.page, S);
    noBogusSize(h, 'window resize while hidden');
    await viewerNotSqueezed(viewer.page, 'window resize while hidden');
    await click(holder.page, S); await sleep(2500);
    h = await holderFills(holder.page, viewer.page, 'window resize while hidden');
    check('window resize while hidden: frame took the new window size', !!h && h.frame[0] < 1000 && h.frame[1] < 760, h && { frame: h.frame });
    await holder.page.setViewportSize({ width: 1440, height: 900 });
    await sleep(1000);

    // 4. A page reload that restores S, with O clicked before S's client starts.
    await click(holder.page, S); await sleep(2000);
    await holder.page.reload({ waitUntil: 'domcontentloaded' });
    await rowsReady(holder.page);
    await click(holder.page, O);
    await sleep(6000);
    h = await inspect(holder.page, S);
    if (h && !h.visible) {
      noBogusSize(h, 'reload');
    } else {
      check('reload: S frame loaded hidden', false, h && { visible: h.visible });
    }
    await viewerNotSqueezed(viewer.page, 'reload');
    await click(holder.page, S); await sleep(2500);
    await holderFills(holder.page, viewer.page, 'reload');
    await viewerNotSqueezed(viewer.page, 'reload, after show');

    await viewer.page.screenshot({ path: process.env.MCW_SHOT || `${profiles}/viewer-final.png` });
  } finally {
    await viewer.context.close();
    await holder.context.close();
    fs.rmSync(profiles, { recursive: true, force: true });
    deleteSessions();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => { console.error(err); try { deleteSessions(); } catch { /* best effort */ } process.exit(2); });
