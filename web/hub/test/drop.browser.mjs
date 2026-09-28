// Real-browser regression test for desktop file drops.
//
// Synthetic DataTransfer events dispatched from page JavaScript skip the browser's hit testing.
// A real drag over the
// terminal lands in the terminal iframe's own document, and a drag over the Files drawer or the
// sidebar lands on elements that had no drop handler at all.
//
// This test drives real drags through the Chrome DevTools Protocol. Input.dispatchDragEvent carries
// real file paths from this box, and the browser hit tests every event at real viewport coordinates.
// It drops on the empty state with no session open, on the terminal iframe with the drag entering
// straight from the window edge, on the sidebar, and on the open Files drawer, and cancels one drag.
// Every upload is checked by SHA-256 on disk, by its path at Claude's prompt, and by the Files drawer.
//
// It creates one throwaway session from the New session dialog and deletes it from the row menu.
// Run against a configured test host:
//   MCW_URL=https://hub.example.com/ MCW_PROXY=socks5://127.0.0.1:17094 node test/drop.browser.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
const URL_BASE = process.env.MCW_URL;
const required = ['MCW_URL', 'MCW_PASSWORD', 'MCW_FILES_ROOT', 'MCW_STATUS_DIR'];
const missing = required.filter((name) => !process.env[name]);
if (missing.length) { console.log(`SKIP: set ${missing.join(', ')} for the file-drop browser test`); process.exit(0); }
const { chromium } = await import(process.env.MCW_PLAYWRIGHT_MODULE || 'playwright');
const PROXY = process.env.MCW_PROXY || '';
const CHROME = process.env.MCW_CHROME || undefined;
const PASSWORD = process.env.MCW_PASSWORD;
const NAME = process.env.MCW_DROP_NAME || 'fix-b-drop';
const FILES_ROOT = process.env.MCW_FILES_ROOT;
const STATUS_ROOT = process.env.MCW_STATUS_DIR;
const SHOTS = process.env.MCW_SHOTS || '';
const KEEP = process.env.MCW_KEEP_SESSION === '1';
// Real desktop drags offer copy, link and move.
const OPS = 1 | 2 | 16;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const results = [];
function check(label, ok, detail) {
  results.push({ label, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail !== undefined ? ' ' + JSON.stringify(detail) : ''}`);
}

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

// A real 64 by 64 RGB PNG with a random tint, so every run uploads different bytes.
function pngBytes() {
  const [r0, g0, b0] = crypto.randomBytes(3);
  const rows = [];
  for (let y = 0; y < 64; y += 1) {
    const row = Buffer.alloc(1 + 64 * 3);
    for (let x = 0; x < 64; x += 1) {
      row[1 + x * 3] = (r0 + x * 4) & 255;
      row[2 + x * 3] = (g0 + y * 4) & 255;
      row[3 + x * 3] = b0;
    }
    rows.push(row);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(64, 0); ihdr.writeUInt32BE(64, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const src = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-b-drop-src-'));
function source(name) {
  const file = path.join(src, name);
  fs.writeFileSync(file, name.endsWith('.png') ? pngBytes() : `${name} ${crypto.randomUUID()}\n`);
  return file;
}

// Every copy of a dropped file under any session inbox.
function landed(name) {
  const out = [];
  let sessions = [];
  try { sessions = fs.readdirSync(FILES_ROOT); } catch { return out; }
  for (const session of sessions) {
    const inbox = path.join(FILES_ROOT, session, 'in');
    let batches = [];
    try { batches = fs.readdirSync(inbox); } catch { continue; }
    for (const batch of batches) {
      const file = path.join(inbox, batch, name);
      if (fs.existsSync(file)) out.push(file);
    }
  }
  return out;
}

async function waitLanded(name, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const found = landed(name);
    if (found.length) return found;
    await sleep(250);
  }
  return landed(name);
}

let page;
let cdp;
// Chrome opens a dropped file in a new tab when no page handler accepted the drop.
const newTabs = [];

async function login() {
  await page.goto(URL_BASE, { waitUntil: 'domcontentloaded' });
  if (await page.waitForSelector('#login-password', { state: 'visible', timeout: 15000 }).then(() => true, () => false)) {
    await page.fill('#login-password', PASSWORD);
    await page.click('#login-submit');
  }
  await page.waitForSelector('#app:not([hidden])');
  await page.waitForFunction(() => document.querySelector('#agent-dot.st-running'), null, { timeout: 60000 });
}

// A drop the page did not take makes Chrome open the file, which leaves the app.
async function pageState() {
  let url = page.url();
  let frames = [];
  try {
    frames = await page.evaluate(() => [...document.querySelectorAll('.term-frame')].map((f) => {
      try { return f.contentWindow.location.pathname; } catch { return 'cross-origin'; }
    }));
  } catch { frames = ['unreadable']; }
  return { url, frames };
}

async function recover(expectSession) {
  const state = await pageState();
  const home = new URL(URL_BASE);
  const onApp = state.url.startsWith(home.origin) && new URL(state.url).pathname === '/';
  const framesOk = state.frames.every((p) => p === '/' + encodeURIComponent(NAME) || p === '/t/' + encodeURIComponent(NAME));
  if (onApp && framesOk) return;
  console.log(`  recovering from ${JSON.stringify(state)}`);
  await login();
  if (expectSession) await openSession();
}

async function overlay() {
  return page.evaluate(() => {
    const el = document.getElementById('drop-overlay');
    if (!el) return { visible: false, text: '' };
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return {
      visible: !el.hidden && style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0,
      text: el.innerText.replace(/\s+/g, ' ').trim(),
      rect: [Math.round(box.left), Math.round(box.top), Math.round(box.width), Math.round(box.height)],
    };
  }).catch(() => ({ visible: false, text: 'page gone' }));
}

async function waitOverlay(visible, ms) {
  const until = Date.now() + ms;
  let last = await overlay();
  while (last.visible !== visible && Date.now() < until) {
    await sleep(25);
    last = await overlay();
  }
  return last;
}

async function drag(type, point, files) {
  await cdp.send('Input.dispatchDragEvent', {
    type,
    x: point.x,
    y: point.y,
    data: { items: [], files, dragOperationsMask: OPS },
  });
}

async function rectOf(selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  }, selector);
}

const center = (r) => ({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });

// What the browser hit tests at a point, including into a same-origin iframe.
async function hitAt(point) {
  return page.evaluate(({ x, y }) => {
    const top = document.elementFromPoint(x, y);
    const describe = (el) => el ? el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : '') : null;
    return describe(top);
  }, point);
}

async function terminalText() {
  return page.evaluate((n) => {
    const f = [...document.querySelectorAll('.term-frame')].find((x) => x.dataset.name === n);
    try {
      const t = f.contentWindow.term; const b = t.buffer.active;
      const lines = [];
      for (let y = 0; y < t.rows; y += 1) lines.push(b.getLine(b.viewportY + y)?.translateToString(true) || '');
      return lines;
    } catch { return []; }
  }, NAME);
}

// Claude's input box wraps long text, so compare with all whitespace and box edges removed.
const squash = (s) => s.replace(/[\s│┃]/g, '');

async function openSession() {
  await page.locator(`#tree .row[data-name="${NAME}"]:not([data-kind="recent"])`).first().click();
  await page.waitForFunction((n) => {
    const f = [...document.querySelectorAll('.term-frame.active')].find((x) => x.dataset.name === n);
    try {
      const t = f.contentWindow.term; const b = t.buffer.active;
      for (let y = 0; y < t.rows; y += 1) if ((b.getLine(b.viewportY + y)?.translateToString(true) || '').includes('❯')) return true;
    } catch { return false; }
    return false;
  }, NAME, { timeout: 90000 });
  await sleep(1500);
}

async function createFromDialog() {
  await page.click('#new-session-root');
  const dialog = page.locator('form.modal-card[aria-label="New session"]');
  await dialog.waitFor({ state: 'visible' });
  await dialog.locator('input.inp').first().fill(NAME);
  await dialog.locator('button[type="submit"]').click();
  await dialog.waitFor({ state: 'detached', timeout: 90000 });
}

async function deleteFromMenu() {
  // The tree re-renders on every pushed status, so retry until the row menu opens.
  for (let attempt = 0; ; attempt += 1) {
    try {
      const row = page.locator(`#tree .row[data-name="${NAME}"]:not([data-kind="recent"])`).first();
      await row.scrollIntoViewIfNeeded({ timeout: 5000 });
      await row.hover({ timeout: 5000 });
      await row.locator('button[data-act="menu"]').click({ timeout: 5000 });
      await page.getByRole('menuitem', { name: 'Delete session' }).click({ timeout: 5000 });
      break;
    } catch (err) {
      if (attempt >= 5) throw err;
      await page.keyboard.press('Escape').catch(() => {});
      await sleep(500);
    }
  }
  const dialog = page.locator(`form.modal-card[aria-label="Delete session ${NAME}"]`);
  await dialog.waitFor({ state: 'visible' });
  await dialog.locator('button.danger', { hasText: 'Delete session' }).click();
  await dialog.waitFor({ state: 'detached', timeout: 90000 });
}

async function toasts() {
  return page.evaluate(() => [...document.querySelectorAll('#toasts .toast')].map((t) => (t.classList.contains('bad') ? 'bad: ' : 'ok: ') + t.textContent)).catch(() => []);
}

async function shot(name) {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name) }).catch(() => {});
}

// One file drag: enter at `enter`, move through `moves`, drop at the last point.
// Checks the overlay on the first dragenter alone, before any dragover is sent.
async function dropCase(label, { enter, moves, files, shotName }) {
  const hit = await hitAt(enter);
  await drag('dragEnter', enter, files);
  const afterEnter = await waitOverlay(true, 400);
  check(`${label}: drop overlay shows on the first dragenter over ${hit}`, afterEnter.visible, afterEnter);
  let last = enter;
  for (const point of moves) {
    await drag('dragOver', point, files);
    last = point;
    await sleep(40);
  }
  if (shotName) await shot(shotName);
  const tabsBefore = newTabs.length;
  await drag('drop', last, files);
  await sleep(1200);
  const opened = newTabs.slice(tabsBefore);
  check(`${label}: Chrome opened no file in a new tab`, opened.length === 0, opened);
  return { hit, afterEnter };
}

async function main() {
  const profile = fs.mkdtempSync('/tmp/fix-b-drop-profile-');
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: CHROME,
    headless: true,
    proxy: PROXY ? { server: PROXY } : undefined,
    viewport: { width: 1440, height: 900 },
  });
  page = context.pages()[0] || await context.newPage();
  cdp = await context.newCDPSession(page);
  context.on('page', async (tab) => {
    await tab.waitForLoadState('domcontentloaded').catch(() => {});
    newTabs.push(tab.url());
    await tab.close().catch(() => {});
  });
  const uploads = [];
  let transcriptPath = null;
  try {
    // Cleanup after an interrupted run or an MCW_KEEP_SESSION run: delete the session and its inbox.
    if (process.env.MCW_DELETE_ONLY === '1') {
      await login();
      await deleteFromMenu();
      console.log(`deleted ${NAME}`);
      return;
    }
    if (landed('fix-b-term.txt').length || fs.existsSync(path.join(FILES_ROOT, NAME))) {
      throw new Error(`${FILES_ROOT}/${NAME} or an earlier fix-b upload already exists`);
    }
    await login();
    const version = await page.evaluate(() => fetch('/app.js', { cache: 'no-store' }).then((r) => r.text()).then((t) => t.length));
    console.log(`app.js ${version} bytes at ${URL_BASE}`);

    // (d) No session open. The drop must say so and must not open the file in the browser.
    const empty = await rectOf('#frames');
    const noSession = await page.evaluate(() => !document.getElementById('no-session').hidden);
    check('empty state: no session is open', noSession);
    const emptyFile = source('fix-b-empty.txt');
    const emptyPoint = center(empty);
    const d = await dropCase('empty state', { enter: emptyPoint, moves: [{ x: emptyPoint.x - 30, y: emptyPoint.y }], files: [emptyFile], shotName: 'empty-overlay.png' });
    check('empty state: the overlay says no session is open', /no session/i.test(d.afterEnter.text), d.afterEnter.text);
    await sleep(400);
    const emptyToasts = await toasts();
    const emptyState = await pageState();
    check('empty state: the drop stays in the app', new URL(emptyState.url).pathname === '/' && emptyState.url.startsWith(new URL(URL_BASE).origin), emptyState);
    check('empty state: a toast says no session is open', emptyToasts.some((t) => /no session/i.test(t)), emptyToasts);
    check('empty state: the overlay hides after the drop', !(await waitOverlay(false, 1000)).visible);
    check('empty state: nothing was uploaded', landed('fix-b-empty.txt').length === 0, landed('fix-b-empty.txt'));
    await shot('empty-after-drop.png');
    await recover(false);

    await createFromDialog();
    await openSession();
    const status = fs.readdirSync(path.join(STATUS_ROOT, NAME)).filter((f) => /^\d+\.json$/.test(f)).map((f) => JSON.parse(fs.readFileSync(path.join(STATUS_ROOT, NAME, f), 'utf8')));
    transcriptPath = status.find((s) => s.transcriptPath)?.transcriptPath || null;
    check('the throwaway session is open at Claude\'s prompt', true, { status });

    // (a) A drag that starts outside the window and enters straight over the terminal at the right edge.
    const frame = await rectOf('.term-frame.active');
    const edge = { x: Math.round(frame.left + frame.width - 2), y: Math.round(frame.top + frame.height * 0.6) };
    const inside = center(frame);
    const termTxt = source('fix-b-term.txt');
    const termPng = source('fix-b-term.png');
    const a = await dropCase('terminal', {
      enter: edge,
      moves: [{ x: edge.x - 40, y: edge.y }, { x: edge.x - 200, y: edge.y - 20 }, inside],
      files: [termTxt, termPng],
      shotName: 'terminal-overlay.png',
    });
    check('terminal: the drag entered over the terminal iframe', /^iframe/.test(a.hit), a.hit);
    uploads.push({ label: 'terminal', file: termTxt }, { label: 'terminal', file: termPng });
    await verifyUploads('terminal', [termTxt, termPng]);
    await recover(true);

    // Drags that end without a drop must not leave the overlay up over the page.
    // CDP has no window-leave event. A dragover outside the viewport hit tests nothing, which is
    // what Chrome sees when the pointer leaves the window.
    const vw = await page.evaluate(() => window.innerWidth);
    const outside = { x: vw + 60, y: inside.y };
    const cancelFile = source('fix-b-cancel.txt');
    await drag('dragEnter', inside, [cancelFile]);
    const leaveShown = await waitOverlay(true, 400);
    await drag('dragOver', { x: inside.x + 10, y: inside.y }, [cancelFile]);
    await drag('dragOver', outside, [cancelFile]);
    const leaveHidden = await waitOverlay(false, 1000);
    check('leave: the overlay shows, then hides when the drag leaves the window', leaveShown.visible && !leaveHidden.visible, { shown: leaveShown.visible, after: leaveHidden.visible });
    await drag('dragCancel', outside, [cancelFile]);

    await drag('dragEnter', edge, [cancelFile]);
    const quickShown = await waitOverlay(true, 400);
    await drag('dragOver', outside, [cancelFile]);
    const quickHidden = await waitOverlay(false, 1000);
    check('leave: a drag that enters over the terminal and leaves at once clears the overlay', quickShown.visible && !quickHidden.visible, { shown: quickShown.visible, after: quickHidden.visible });
    await drag('dragCancel', outside, [cancelFile]);

    // Escape cancels a drag without a dragleave. No mouse event fires during a drag, so the next one clears the overlay.
    await drag('dragEnter', inside, [cancelFile]);
    const escShown = await waitOverlay(true, 400);
    await drag('dragOver', { x: inside.x + 10, y: inside.y }, [cancelFile]);
    await drag('dragCancel', { x: inside.x + 10, y: inside.y }, [cancelFile]);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: inside.x + 20, y: inside.y });
    const escHidden = await waitOverlay(false, 1000);
    check('cancel: after a cancelled drag the next mouse move clears the overlay', escShown.visible && !escHidden.visible, { shown: escShown.visible, after: escHidden.visible });
    await sleep(500);
    check('leave and cancel: nothing was uploaded', landed('fix-b-cancel.txt').length === 0);

    // (c) The sidebar.
    const tree = await rectOf('#tree');
    const sidePoint = { x: Math.round(tree.left + tree.width / 2), y: Math.round(tree.top + tree.height * 0.7) };
    const sideTxt = source('fix-b-sidebar.txt');
    await dropCase('sidebar', { enter: sidePoint, moves: [{ x: sidePoint.x + 10, y: sidePoint.y - 30 }], files: [sideTxt], shotName: 'sidebar-overlay.png' });
    uploads.push({ label: 'sidebar', file: sideTxt });
    await verifyUploads('sidebar', [sideTxt]);
    await recover(true);

    // (b) The open Files drawer.
    await page.click('#files-button');
    await page.waitForSelector('#files-drawer:not([hidden])');
    await sleep(500);
    await shot('drawer-open.png');
    const drawer = await rectOf('#files-drawer');
    const drawerPoint = center(drawer);
    const drawerPng = source('fix-b-drawer.png');
    await dropCase('Files drawer', { enter: drawerPoint, moves: [{ x: drawerPoint.x, y: drawerPoint.y + 40 }], files: [drawerPng], shotName: 'drawer-overlay.png' });
    uploads.push({ label: 'Files drawer', file: drawerPng });
    await verifyUploads('Files drawer', [drawerPng]);
    await recover(true);

    // The Files drawer lists every upload.
    if (await page.locator('#files-drawer').isHidden()) await page.click('#files-button');
    await sleep(1500);
    const listed = await page.evaluate(() => document.getElementById('files-list')?.innerText || '');
    // The exact path this run uploaded, so rows left by an earlier run cannot pass it.
    for (const u of uploads) {
      const name = path.basename(u.file);
      check(`Files drawer lists ${name}`, !!u.landed && listed.includes(u.landed), { landed: u.landed || null, rows: listed.split('\n').filter((l) => l.includes(name)) });
    }
    await shot('drawer-final.png');

    // Nothing was submitted: Claude never started a turn and never finished one.
    const records = fs.readdirSync(path.join(STATUS_ROOT, NAME));
    const states = records.filter((f) => /^\d+\.json$/.test(f)).map((f) => JSON.parse(fs.readFileSync(path.join(STATUS_ROOT, NAME, f), 'utf8')).state);
    const responses = records.filter((f) => f.endsWith('.response.json'));
    check('no Enter: Claude stayed idle and never completed a turn', states.every((s) => s === 'idle') && responses.length === 0, { states, responses });
    let submitted = [];
    if (transcriptPath && fs.existsSync(transcriptPath)) {
      submitted = fs.readFileSync(transcriptPath, 'utf8').split('\n').filter((l) => l.includes('"type":"user"') && l.includes('fix-b-'));
    }
    check('no Enter: the transcript holds no user message with a dropped path', submitted.length === 0, { transcriptPath, submitted: submitted.length });

    // Phone keeps the Upload files button, visible and on top at its own center.
    await page.setViewportSize({ width: 390, height: 844 });
    await sleep(600);
    if (await page.locator('#files-drawer').isVisible()) await page.click('#files-close');
    if (await page.locator('#sidebar').isVisible()) await page.click('#hide-sidebar');
    await sleep(300);
    const phoneButton = await page.evaluate(() => {
      const b = document.getElementById('upload-button');
      const r = b.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { display: getComputedStyle(b).display, w: Math.round(r.width), h: Math.round(r.height), label: b.getAttribute('aria-label'), disabled: b.disabled, onTop: !!top && b.contains(top) };
    });
    check('phone: the Upload files button stays', phoneButton.display !== 'none' && phoneButton.w >= 30 && !phoneButton.disabled && phoneButton.onTop, phoneButton);
    await shot('phone.png');
    await page.click('#files-button');
    await sleep(800);
    await shot('phone-files.png');
    await page.click('#files-close');
    await page.setViewportSize({ width: 1440, height: 900 });
    await sleep(400);

    if (!KEEP) {
      await page.keyboard.press('Escape').catch(() => {});
      await deleteFromMenu();
      check('the throwaway session is deleted from the row menu', true);
    }
  } finally {
    await context.close();
    fs.rmSync(profile, { recursive: true, force: true });
    fs.rmSync(src, { recursive: true, force: true });
    if (!KEEP) {
      fs.rmSync(path.join(FILES_ROOT, NAME), { recursive: true, force: true });
      if (transcriptPath && path.basename(path.dirname(transcriptPath)).startsWith('-') && fs.existsSync(transcriptPath)) fs.rmSync(transcriptPath);
    }
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);

  async function verifyUploads(label, files) {
    for (const file of files) {
      const name = path.basename(file);
      const found = await waitLanded(name, 15000);
      const good = found.filter((f) => f.startsWith(path.join(FILES_ROOT, NAME, 'in') + '/') && sha(f) === sha(file));
      check(`${label}: ${name} landed in ${NAME}'s inbox with the same SHA-256`, good.length === 1, { found, sha256: sha(file) });
      const entry = uploads.find((u) => u.file === file);
      if (entry && good.length) entry.landed = good[0];
      if (good.length) {
        await sleep(600);
        const screen = squash((await terminalText()).join(''));
        check(`${label}: ${name}'s path is typed at Claude's prompt`, screen.includes(squash(good[0])), good[0]);
      }
    }
    const state = await pageState();
    check(`${label}: the drop stays in the app`, new URL(state.url).pathname === '/' && state.frames.every((p) => p === '/' + NAME), state);
    const shown = await waitOverlay(false, 1000);
    check(`${label}: the overlay hides after the upload`, !shown.visible, shown);
  }
}

main().catch((err) => { console.error(err); process.exit(2); });
