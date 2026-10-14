// Real-browser regression test for session deletion.
//
// A terminal client may try to reconnect while its session is being deleted. This test verifies
// that reconnecting does not recreate the deleted session or prevent reuse of its name.
//
// This test creates a real session from the New session dialog, keeps its terminal open in a second
// browser, deletes it from the first browser's row menu, confirms for 20 seconds that no zellij session, unit, Claude process or state
// file remains, then creates it again under the same name and deletes it again.
//
// Run against a configured test host:
//   MCW_URL=https://hub.example.com/ MCW_PROXY=socks5://127.0.0.1:1091 node test/delete.browser.mjs
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const URL_BASE = process.env.MCW_URL;
const required = ['MCW_URL', 'MCW_PASSWORD', 'MCW_ZELLIJ', 'MCW_MAXCLAUDE_CFG', 'MCW_STATUS_DIR'];
const missing = required.filter((name) => !process.env[name]);
if (missing.length) { console.log(`SKIP: set ${missing.join(', ')} for the session-delete browser test`); process.exit(0); }
const { chromium } = await import(process.env.MCW_PLAYWRIGHT_MODULE || 'playwright');
const PROXY = process.env.MCW_PROXY || '';
const CHROME = process.env.MCW_CHROME || undefined;
const PASSWORD = process.env.MCW_PASSWORD;
const ZELLIJ = process.env.MCW_ZELLIJ;
const MAXCLAUDE_CFG = process.env.MCW_MAXCLAUDE_CFG;
const STATUS_DIR = process.env.MCW_STATUS_DIR;
const NAME = process.env.MCW_DELETE_NAME || 'fix-a-del';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const zellijEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ZELLIJ')));
const sh = (cmd, args) => { try { return execFileSync(cmd, args, { env: zellijEnv, stdio: ['ignore', 'pipe', 'pipe'] }).toString(); } catch (e) { return (e.stdout || '').toString(); } };
const unit = () => `maxclaude-named@${sh('systemd-escape', [NAME]).trim()}.service`;

const results = [];
function check(label, ok, detail) {
  results.push({ label, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ' ' + JSON.stringify(detail) : ''}`);
}

// Everything a session leaves on the box.
function remains() {
  const zellij = sh(ZELLIJ, ['list-sessions', '-n']).split('\n').filter((l) => l.trim().split(/\s/)[0] === NAME).map((l) => l.trim());
  const unitState = sh('systemctl', ['--user', 'is-active', unit()]).trim();
  const claude = [];
  for (const pid of fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p))) {
    try {
      if (fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim() !== 'claude') continue;
      if (fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(`ZELLIJ_SESSION_NAME=${NAME}`)) claude.push(pid);
    } catch { /* exited */ }
  }
  const files = [
    path.join(MAXCLAUDE_CFG, 'sessions', `${NAME}.env`),
    path.join(MAXCLAUDE_CFG, `${NAME}.panes`),
    path.join(STATUS_DIR, NAME),
  ].filter((f) => fs.existsSync(f));
  return { zellij, unit: unitState, claude, files };
}
const nothing = (r) => r.zellij.length === 0 && r.unit !== 'active' && r.claude.length === 0 && r.files.length === 0;

async function createFromDialog(page) {
  await page.click('#new-session-root');
  const dialog = page.locator('form.modal-card[aria-label="New session"]');
  await dialog.waitFor({ state: 'visible' });
  await dialog.locator('input.inp').first().fill(NAME);
  await dialog.locator('button[type="submit"]').click();
  const outcome = await Promise.race([
    dialog.waitFor({ state: 'detached', timeout: 60000 }).then(() => 'created'),
    dialog.locator('.form-error:not([hidden])').waitFor({ state: 'visible', timeout: 60000 }).then(() => 'error'),
  ]);
  const error = outcome === 'error' ? await dialog.locator('.form-error').textContent() : null;
  if (error) await dialog.locator('button', { hasText: 'Cancel' }).click();
  return { outcome, error };
}

async function deleteFromMenu(page) {
  const row = page.locator(`#tree .row[data-name="${NAME}"]:not([data-kind="recent"])`).first();
  await row.scrollIntoViewIfNeeded();
  await row.hover();
  await row.locator('button[data-act="menu"]').click();
  await page.getByRole('menuitem', { name: 'Delete session' }).click();
  const dialog = page.locator(`form.modal-card[aria-label="Delete session ${NAME}"]`);
  await dialog.waitFor({ state: 'visible' });
  await dialog.locator('button.danger', { hasText: 'Delete session' }).click();
  await dialog.waitFor({ state: 'detached', timeout: 90000 });
}

// The terminal must be open and attached, which is what lets a reconnect recreate the session.
async function openAndAttach(page) {
  await page.locator(`#tree .row[data-name="${NAME}"]:not([data-kind="recent"])`).first().click();
  await page.waitForFunction((n) => {
    const f = [...document.querySelectorAll('.term-frame')].find((x) => x.dataset.name === n);
    try {
      const t = f.contentWindow.term; const b = t.buffer.active;
      for (let y = 0; y < t.rows; y += 1) if ((b.getLine(b.viewportY + y)?.translateToString(true) || '').includes('Claude')) return true;
    } catch { return false; }
    return false;
  }, NAME, { timeout: 60000 });
}

// zellij, unit and files must be gone at every poll. Claude gets 5 s to exit after its pty closes.
async function watchNothingRemains(label, seconds) {
  let first = null;
  for (let i = 0; i < seconds; i += 1) {
    const r = remains();
    const bad = r.zellij.length > 0 || r.unit === 'active' || r.files.length > 0 || (i >= 5 && r.claude.length > 0);
    if (bad) { first = { second: i, ...r }; break; }
    await sleep(1000);
  }
  check(`${label}: nothing of ${NAME} remains for ${seconds} s after delete`, first === null, first || undefined);
}

// The other browser drops the deleted session's terminal instead of reconnecting to it forever.
let holderPage = null;
async function holderClosed(label) {
  const state = await holderPage.evaluate((n) => ({
    frames: [...document.querySelectorAll('.term-frame')].filter((f) => f.dataset.name === n).length,
    empty: !document.getElementById('no-session')?.hidden,
  }), NAME);
  check(`${label}: the other browser closed the deleted terminal`, state.frames === 0 && state.empty, state);
}

async function main() {
  const start = remains();
  if (!nothing(start)) throw new Error(`${NAME} already exists: ${JSON.stringify(start)}`);
  const profile = fs.mkdtempSync('/tmp/fix-a-del-profile-');
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: CHROME,
    headless: true,
    proxy: PROXY ? { server: PROXY } : undefined,
    viewport: { width: 1440, height: 900 },
  });
  const page = context.pages()[0] || await context.newPage();
  // A second browser holds the terminal open, as the operator's other tab or phone does.
  const holderProfile = fs.mkdtempSync('/tmp/fix-a-del-holder-');
  const holderContext = await chromium.launchPersistentContext(holderProfile, {
    executablePath: CHROME,
    headless: true,
    proxy: PROXY ? { server: PROXY } : undefined,
    viewport: { width: 1440, height: 900 },
  });
  const holder = holderContext.pages()[0] || await holderContext.newPage();
  holderPage = holder;
  try {
    await holder.goto(URL_BASE, { waitUntil: 'domcontentloaded' });
    if (await holder.waitForSelector('#login-password', { state: 'visible', timeout: 15000 }).then(() => true, () => false)) {
      await holder.fill('#login-password', PASSWORD);
      await holder.click('#login-submit');
    }
    await holder.waitForSelector('#app:not([hidden])');
    await page.goto(URL_BASE, { waitUntil: 'domcontentloaded' });
    if (await page.waitForSelector('#login-password', { state: 'visible', timeout: 15000 }).then(() => true, () => false)) {
      await page.fill('#login-password', PASSWORD);
      await page.click('#login-submit');
    }
    await page.waitForSelector('#app:not([hidden])');
    await page.waitForFunction(() => document.querySelector('#agent-dot.st-running'), null, { timeout: 60000 });

    let made = await createFromDialog(page);
    check('create from the New session dialog', made.outcome === 'created', made);
    await openAndAttach(page);
    await holder.waitForSelector(`#tree .row[data-name="${NAME}"]`, { timeout: 30000 });
    await openAndAttach(holder);
    const live = remains();
    check('the session runs Claude under its unit', live.zellij.length === 1 && live.unit === 'active' && live.claude.length > 0, live);

    await deleteFromMenu(page);
    await watchNothingRemains('first delete', 20);
    await holderClosed('first delete');

    made = await createFromDialog(page);
    check('the same name is reusable right away', made.outcome === 'created', made);
    await openAndAttach(page);
    await holder.waitForSelector(`#tree .row[data-name="${NAME}"]`, { timeout: 30000 });
    await openAndAttach(holder);
    const again = remains();
    check('the recreated session runs Claude under its unit', again.zellij.length === 1 && again.unit === 'active' && again.claude.length > 0, again);

    await deleteFromMenu(page);
    await watchNothingRemains('second delete', 20);
    await holderClosed('second delete');
    await page.screenshot({ path: process.env.MCW_SHOT || `${profile}/delete.png` });
  } finally {
    await context.close();
    await holderContext.close();
    fs.rmSync(profile, { recursive: true, force: true });
    fs.rmSync(holderProfile, { recursive: true, force: true });
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(2); });
