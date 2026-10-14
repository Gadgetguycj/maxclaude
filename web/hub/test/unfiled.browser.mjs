// Real-browser regression test for the Unfiled order.
//
// A session outside every folder is unfiled. It either has no tree leaf, or it has a root leaf,
// which New session at the top level and moving a session to the root both create. Root leaves
// used to render at the end of Folders in tree position order, oldest first, directly above the
// "Unfiled, newest first" heading.
//
// Run against a configured test host, where zellij runs:
//   MCW_URL=https://hub.example.com/ MCW_PROXY=socks5://127.0.0.1:1091 node test/unfiled.browser.mjs
// It creates throwaway sessions fix-a-u1, fix-a-u2 and fix-a-u3 and deletes them afterwards.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const URL_BASE = process.env.MCW_URL;
const required = ['MCW_URL', 'MCW_PASSWORD', 'MCW_ZELLIJ'];
const missing = required.filter((name) => !process.env[name]);
if (missing.length) { console.log(`SKIP: set ${missing.join(', ')} for the Unfiled browser test`); process.exit(0); }
const { chromium } = await import(process.env.MCW_PLAYWRIGHT_MODULE || 'playwright');
const PROXY = process.env.MCW_PROXY || '';
const CHROME = process.env.MCW_CHROME || undefined;
const PASSWORD = process.env.MCW_PASSWORD;
const ZELLIJ = process.env.MCW_ZELLIJ;
const NAMES = ['fix-a-u1', 'fix-a-u2', 'fix-a-u3'];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const zellijEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ZELLIJ')));
const zellij = (...args) => execFileSync(ZELLIJ, args, { env: zellijEnv, stdio: ['ignore', 'pipe', 'pipe'] }).toString();

const results = [];
function check(label, ok, detail) {
  results.push({ label, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ' ' + JSON.stringify(detail) : ''}`);
}

const TREE = () => {
  const rows = [...document.querySelectorAll('#tree .row')];
  const at = (id) => rows.findIndex((r) => r.dataset.kind === 'section' && r.dataset.id === id);
  const folders = at('__folders__');
  const unfiled = at('__unfiled__');
  const label = (r) => ({ kind: r.dataset.kind, id: r.dataset.id || null, name: r.dataset.name || r.querySelector('.name')?.textContent || '' });
  return {
    inFolders: rows.slice(folders + 1, unfiled).filter((r) => r.dataset.kind !== 'folder').map(label),
    unfiled: rows.slice(unfiled + 1).map(label),
  };
};

async function main() {
  const live = zellij('list-sessions', '-n', '-s').split('\n');
  for (const name of NAMES) {
    if (!live.includes(name)) zellij('attach', '--create-background', name);
    await sleep(2200);
  }
  const profile = fs.mkdtempSync('/tmp/fix-a-u-profile-');
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: CHROME,
    headless: true,
    proxy: PROXY ? { server: PROXY } : undefined,
    viewport: { width: 1440, height: 900 },
  });
  const page = context.pages()[0] || await context.newPage();
  const api = (method, path, body) => page.evaluate(async ([m, p, b]) => {
    const res = await fetch(p, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  }, [method, path, body]);
  const leafIds = [];
  try {
    await page.goto(URL_BASE, { waitUntil: 'domcontentloaded' });
    if (await page.waitForSelector('#login-password', { state: 'visible', timeout: 15000 }).then(() => true, () => false)) {
      await page.fill('#login-password', PASSWORD);
      await page.click('#login-submit');
    }
    const rowsFor = () => page.waitForFunction((names) => names.every((n) => document.querySelector(`#tree .row[data-name="${n}"]`)), NAMES, { timeout: 30000 });
    await rowsFor();

    // u1 and u3 get root leaves in creation order, as New session at the top level does. u2 keeps none.
    for (const name of ['fix-a-u1', 'fix-a-u3']) {
      const res = await api('POST', '/api/adopt', { session_name: name, parent_id: null });
      check(`${name} filed at the root`, res.status === 200 && res.body?.node?.parent_id === null, { status: res.status });
      if (res.body?.node?.id) leafIds.push(res.body.node.id);
    }
    await page.reload({ waitUntil: 'domcontentloaded' });
    await rowsFor();
    await sleep(500);

    const state = (await api('GET', '/api/state')).body;
    const created = new Map(state.sessions.map((s) => [s.name, Number(s.originalCreatedAt || s.createdAt || 0)]));
    const tree = await page.evaluate(TREE);
    const unfiledNames = tree.unfiled.map((r) => r.name);

    for (const name of NAMES) {
      check(`${name} is listed under Unfiled`, unfiledNames.includes(name), { unfiled: unfiledNames });
    }
    const rootLeafIds = new Set(state.tree.filter((n) => n.kind === 'session' && !n.parent_id).map((n) => n.id));
    const strayRoot = tree.inFolders.filter((r) => rootLeafIds.has(r.id));
    check('no root session is drawn inside Folders', strayRoot.length === 0, { strayRoot: strayRoot.map((r) => r.name) });

    const ours = unfiledNames.filter((n) => NAMES.includes(n));
    check('throwaways are newest first', JSON.stringify(ours) === JSON.stringify(['fix-a-u3', 'fix-a-u2', 'fix-a-u1']), { ours });

    // Machine check of the whole section against the original creation times the hub reports.
    const times = unfiledNames.map((n) => created.get(n) || 0);
    const descending = times.every((t, i) => i === 0 || times[i - 1] >= t);
    check('every Unfiled row is in descending original creation time', descending, { rows: unfiledNames.map((n, i) => `${n}:${times[i]}`) });
    await page.screenshot({ path: process.env.MCW_SHOT || `${profile}/unfiled.png` });
  } finally {
    for (const id of leafIds) {
      const res = await api('DELETE', `/api/sessions/${encodeURIComponent(id)}`).catch((e) => ({ status: String(e) }));
      if (res.status !== 200) console.log('leaf delete', id, JSON.stringify(res));
    }
    await context.close();
    fs.rmSync(profile, { recursive: true, force: true });
    for (const name of NAMES) { try { zellij('delete-session', '--force', name); } catch { /* already gone */ } }
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(2); });
