'use strict';
(function () {

/* ---------- dom helpers ---------- */

function $(sel, root) { return (root || document).querySelector(sel); }

function add(node, kid) {
  if (kid === null || kid === undefined || kid === false) return;
  if (Array.isArray(kid)) { for (var i = 0; i < kid.length; i++) add(node, kid[i]); return; }
  node.append(kid && kid.nodeType ? kid : document.createTextNode(String(kid)));
}

function h(tag, props) {
  const n = document.createElement(tag);
  if (props) {
    for (const k in props) {
      const v = props[k];
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'dataset') { for (const d in v) if (v[d] !== null && v[d] !== undefined) n.dataset[d] = v[d]; }
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else if (v === true) n.setAttribute(k, '');
      else n.setAttribute(k, v);
    }
  }
  for (let i = 2; i < arguments.length; i++) add(n, arguments[i]);
  return n;
}

function sh(tag, props) {
  const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
  if (props) for (const k in props) {
    const v = props[k];
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') n.setAttribute('class', v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (let i = 2; i < arguments.length; i++) add(n, arguments[i]);
  return n;
}

function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

const LS = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); }
    catch (e) { return fallback; }
  },
  set(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* storage off */ } }
};

/* ---------- formatting ---------- */

function fmtSecs(input) {
  const s = Math.max(0, Math.round(Number(input) || 0));
  if (s < 60) return s + (s === 1 ? ' second' : ' seconds');
  const m = Math.floor(s / 60), rs = s % 60;
  if (m < 60) return m + (m === 1 ? ' minute' : ' minutes') + (rs ? ' ' + rs + 's' : '');
  const hr = Math.floor(m / 60), rm = m % 60;
  return hr + (hr === 1 ? ' hour' : ' hours') + (rm ? ' ' + rm + 'm' : '');
}

function fmtAge(ms) {
  const n = Number(ms);
  if (!isFinite(n) || n <= 0) return '';
  const s = Math.floor((Date.now() - n) / 1000);
  if (s < 0) return 'just now';
  if (s < 60) return s + 's ago';
  const m = Math.floor(s / 60); if (m < 60) return m + 'm ago';
  const hr = Math.floor(m / 60); if (hr < 48) return hr + 'h ago';
  return Math.floor(hr / 24) + 'd ago';
}

function fmtShortAge(ms) {
  const n = Number(ms);
  if (!isFinite(n) || n <= 0) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - n) / 1000));
  if (seconds < 60) return '<1m';
  const minutes = Math.floor(seconds / 60); if (minutes < 60) return minutes + 'm';
  const hours = Math.floor(minutes / 60); if (hours < 48) return hours + 'h';
  return Math.floor(hours / 24) + 'd';
}

function fmtBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KiB';
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0) + ' MiB';
  return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GiB';
}

/* ---------- api ---------- */

class ApiError extends Error {
  constructor(status, body) {
    super((body && (body.message || body.error)) || ('HTTP ' + status));
    this.status = status;
    this.code = (body && body.error) || null;
    this.body = body || {};
  }
}

const CODE_TEXT = {
  invalid_credentials: 'Incorrect password.',
  agent_disconnected: 'The agent on the session host is disconnected.',
  network_error: 'Cannot reach the server.',
  unauthorized: 'Not logged in.',
  not_found: 'Not found.',
  conflict: 'That name is already taken.',
  bad_request: 'The server rejected that request.',
  upstream_unavailable: 'zellij on the session host is not answering.',
  internal: 'The server hit an internal error.',
  timeout: 'The host took too long to answer.'
};

function errText(e) {
  if (!(e instanceof ApiError)) return String((e && e.message) || e);
  if (e.body && e.body.message) return e.body.message;
  if (e.code === 'locked_out') return 'Locked out. Try again in ' + fmtSecs(e.body.retry_after_s) + '.';
  if (e.code === 'rate_limited') return 'Too many attempts. Try again in ' + fmtSecs(e.body.retry_after_s) + '.';
  return CODE_TEXT[e.code] || e.code || ('HTTP ' + e.status);
}

async function api(method, path, body, opts) {
  const init = { method: method, credentials: 'same-origin', headers: { accept: 'application/json' } };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res;
  try { res = await fetch(path, init); }
  catch (e) { throw new ApiError(0, { error: 'network_error' }); }

  let data = null;
  if ((res.headers.get('content-type') || '').indexOf('json') >= 0) {
    try { data = await res.json(); } catch (e) { data = null; }
  }
  if (res.status === 401 && !(opts && opts.rawAuth)) {
    toLogin('Session expired. Log in again.');
    throw new ApiError(401, data || { error: 'unauthorized' });
  }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

/* ---------- state ---------- */

const S = {
  authed: false,
  agent: { connected: false },
  nodes: [],
  sessions: null,
  sessionStatus: {},
  recents: [],
  recentLimit: 5,
  stateError: null,
  sig: '',
  collapsed: new Set(LS.get('mcw.collapsed', []) || []),
  active: LS.get('mcw.active', null),
  sidebarWidth: 300,
  sidebarCollapsed: false,
  waking: new Set(),
  pollTimer: null,
  fetching: false
};

const UNFILED_KEY = '__unfiled__';
const RECENTS_KEY = '__recents__';
const FOLDERS_KEY = '__folders__';
const STATE_TEXT = { busy: 'working', background: 'working in background', idle: 'waiting for input', sleeping: 'sleeping', waking: 'waking', absent: 'no Claude process', running: 'running', exited: 'exited', missing: 'not created', unknown: 'unknown' };
let eventSource = null;

function startEvents() {
  if (eventSource) eventSource.close();
  eventSource = new EventSource('/api/events');
  const update = function (ev) {
    try {
      const payload = JSON.parse(ev.data);
      S.sessionStatus = payload.session_status || payload || {};
      render();
    } catch (e) { /* malformed server event is ignored */ }
  };
  eventSource.addEventListener('state', update);
  eventSource.addEventListener('sessions.status', update);
  eventSource.addEventListener('agent', function () { refreshState(true); });
}

function canMutate() { return S.agent.connected === true; }

function persistView() {
  LS.set('mcw.collapsed', Array.from(S.collapsed));
  LS.set('mcw.active', S.active);
}

function nodeById(id) {
  for (const n of S.nodes) if (n.id === id) return n;
  return null;
}

function cmpNode(a, b) {
  const pa = Number(a.position), pb = Number(b.position);
  const da = isFinite(pa) ? pa : 0, db = isFinite(pb) ? pb : 0;
  if (da !== db) return da - db;
  return String(a.name || '').localeCompare(String(b.name || ''));
}

function childrenOf(pid) {
  const want = pid || null;
  return S.nodes.filter(function (n) { return (n.parent_id || null) === want; }).sort(cmpNode);
}

function descendantIds(id) {
  const out = new Set();
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop();
    for (const n of S.nodes) {
      if ((n.parent_id || null) === cur && !out.has(n.id)) { out.add(n.id); stack.push(n.id); }
    }
  }
  return out;
}

function pathOf(pid) {
  if (!pid) return 'Root';
  const parts = [];
  let cur = nodeById(pid);
  let guard = 0;
  while (cur && guard++ < 64) { parts.unshift(cur.name); cur = cur.parent_id ? nodeById(cur.parent_id) : null; }
  return parts.join(' / ') || 'Root';
}

function leafBySession(name) {
  for (const n of S.nodes) if (n.kind === 'session' && n.session_name === name) return n;
  return null;
}

function liveState(sessionName) {
  if (S.waking.has(sessionName)) return 'waking';
  if (!Array.isArray(S.sessions)) return 'unknown';
  for (const s of S.sessions) {
    if (s.name !== sessionName) continue;
    if (s.exited) return 'exited';
    const activity = S.sessionStatus[sessionName]?.state || s.activity;
    if (s.sleeping) return 'sleeping';
    if (activity === 'busy' || activity === 'background' || activity === 'idle' || activity === 'sleeping' || activity === 'absent' || activity === 'unknown') return activity;
    return 'unknown';
  }
  return 'missing';
}

function sortNewestFirst(a, b) {
  const aa = Number(a.originalCreatedAt || a.original_created_at || a.createdAt || a.created_at || 0);
  const bb = Number(b.originalCreatedAt || b.original_created_at || b.createdAt || b.created_at || 0);
  if (aa !== bb) return bb - aa;
  return String(a.name || '').localeCompare(String(b.name || ''));
}

function computeUnfiled() {
  if (!Array.isArray(S.sessions)) return null;
  const known = new Set();
  for (const n of S.nodes) if (n.kind === 'session' && n.session_name) known.add(n.session_name);
  return S.sessions.filter(function (s) { return s && s.name && !known.has(s.name); });
}

function endPosition(pid) {
  const kids = childrenOf(pid);
  if (!kids.length) return 1000;
  const last = Number(kids[kids.length - 1].position);
  return (isFinite(last) ? last : 0) + 1000;
}

function positionAt(sibs, index) {
  const before = sibs[index - 1], after = sibs[index];
  if (!before && !after) return 1000;
  if (!before) return Number(after.position) - 1000;
  if (!after) return Number(before.position) + 1000;
  const a = Number(before.position), b = Number(after.position);
  const mid = (a + b) / 2;
  return (Math.abs(b - a) > 1) ? Math.round(mid) : mid;
}

/* ---------- toasts ---------- */

function toast(msg, bad) {
  const t = h('div', { class: 'toast' + (bad ? ' bad' : '') }, msg);
  $('#toasts').append(t);
  setTimeout(function () { t.remove(); }, bad ? 7000 : 3500);
}

/* ---------- auth ---------- */

function loginError(msg) {
  const el = $('#login-error');
  el.textContent = msg || '';
  el.hidden = !msg;
}

let lockTimer = null;

function startLockout(prefix, secs) {
  let left = Math.round(Number(secs) || 0);
  if (left <= 0) return;
  const btn = $('#login-submit');
  clearInterval(lockTimer);
  btn.disabled = true;
  const tick = function () {
    if (left <= 0) { clearInterval(lockTimer); lockTimer = null; btn.disabled = false; loginError(''); return; }
    loginError(prefix + ' Try again in ' + fmtSecs(left) + '.');
    left -= 1;
  };
  tick();
  lockTimer = setInterval(tick, 1000);
}

function showLogin(msg) {
  $('#boot').hidden = true;
  $('#app').hidden = true;
  $('#login').hidden = false;
  loginError(msg || '');
  const pw = $('#login-password');
  pw.value = '';
  setTimeout(function () { try { pw.focus(); } catch (e) { /* not focusable yet */ } }, 20);
}

function toLogin(msg) {
  S.authed = false;
  stopPoll();
  if (eventSource) { eventSource.close(); eventSource = null; }
  closeMenu();
  closeAllModals();
  for (const frame of $('#frames').querySelectorAll('.term-frame')) disposeFrame(frame);
  clear($('#frames'));
  $('#frames').append(h('p', { id: 'no-session', class: 'empty' }, 'No session open.'));
  document.body.classList.remove('sidebar-collapsed');
  S.sig = '';
  showLogin(msg);
}

function enterApp() {
  S.authed = true;
  clearInterval(lockTimer);
  lockTimer = null;
  $('#login').hidden = true;
  $('#boot').hidden = true;
  $('#app').hidden = false;
  loadSidebarState();
  syncFrames();
  refreshState(true);
  startPoll();
  startEvents();
}

$('#login-form').addEventListener('submit', async function (ev) {
  ev.preventDefault();
  const pw = $('#login-password').value;
  const btn = $('#login-submit');
  if (!pw) { loginError('Enter the password.'); return; }
  btn.disabled = true;
  try {
    await api('POST', '/api/login', { password: pw }, { rawAuth: true });
    $('#login-password').value = '';
    loginError('');
    btn.disabled = false;
    enterApp();
  } catch (e) {
    btn.disabled = false;
    if (e.code === 'locked_out') startLockout('Locked out.', e.body.retry_after_s);
    else if (e.code === 'rate_limited') startLockout('Too many attempts.', e.body.retry_after_s);
    else loginError(errText(e));
  }
});

$('#logout').addEventListener('click', async function () {
  try { await api('POST', '/api/logout', {}); } catch (e) { /* the cookie is gone either way */ }
  toLogin('');
});

/* ---------- polling ---------- */

function startPoll() {
  stopPoll();
  S.pollTimer = setTimeout(pollTick, 4000);
}

function stopPoll() {
  if (S.pollTimer) clearTimeout(S.pollTimer);
  S.pollTimer = null;
}

async function pollTick() {
  S.pollTimer = null;
  if (!S.authed) return;
  if (!document.hidden) await refreshState(false);
  if (S.authed && !S.pollTimer) S.pollTimer = setTimeout(pollTick, 4000);
}

async function refreshState(force) {
  if (!S.authed) return;
  if (S.fetching && !force) return;
  S.fetching = true;
  try {
    const d = await api('GET', '/api/state');
    S.agent = (d && d.agent) || { connected: false };
    S.nodes = (d && Array.isArray(d.tree)) ? d.tree : [];
    S.sessions = (d && Array.isArray(d.sessions)) ? d.sessions : null;
    S.sessionStatus = (d && d.session_status && typeof d.session_status === 'object') ? d.session_status : {};
    S.recents = (d && Array.isArray(d.recents)) ? d.recents : [];
    S.recentLimit = [0, 3, 5, 10, 15].includes(Number(d && d.recent_limit)) ? Number(d.recent_limit) : 5;
    S.stateError = null;
    // A session deleted from another browser closes here too. Its terminal would only retry a
    // socket the agent refuses, because the name no longer exists on the host.
    if (S.active && S.sessions && S.sessions.length && !S.sessions.some(function (s) { return s.name === S.active; })) {
      S.active = null;
      persistView();
    }
  } catch (e) {
    if (e.status === 401) { S.fetching = false; return; }
    S.stateError = errText(e);
    S.agent = { connected: false };
    S.sessions = null;
  }
  S.fetching = false;
  render();
}

document.addEventListener('visibilitychange', function () {
  document.body.classList.toggle('document-hidden', document.hidden);
  if (!document.hidden && S.authed) { refreshState(true); startPoll(); }
});
document.body.classList.toggle('document-hidden', document.hidden);

/* ---------- render ---------- */

function stateSig() {
  const sessions = Array.isArray(S.sessions) ? S.sessions.map(function (session) {
    return [session.name, session.exited, session.originalCreatedAt, session.createdAt];
  }) : S.sessions;
  return JSON.stringify([
    S.agent.connected === true,
    S.stateError,
    S.nodes,
    sessions,
    Array.isArray(S.sessions) ? null : S.recents,
    S.recentLimit,
    S.active
  ]);
}

function render() {
  updateChrome();
  const sig = stateSig();
  const blocked = interactionOpen();
  if (sig !== S.sig && !blocked) {
    S.sig = sig;
    renderTree();
  }
  syncActivityViews();
  syncFrames();
}

function interactionOpen() {
  const active = document.activeElement;
  const editing = active && active.closest && active.closest('#app input, #app select, #app textarea, #app [contenteditable="true"]');
  return drag.active || menuOpen() || modals.length > 0 || !!editing;
}

function updateChrome() {
  const down = !canMutate();
  document.body.classList.toggle('agent-down', down);

  const dot = $('#agent-dot');
  dot.className = 'dot ' + (S.agent.connected ? 'st-running' : 'st-missing');
  dot.title = S.agent.connected
    ? ('Agent connected ' + fmtAge(S.agent.since)).trim()
    : 'Agent disconnected';

  const banner = $('#banner');
  if (S.stateError) {
    banner.className = 'banner error';
    banner.textContent = 'Cannot read the state from the server. ' + S.stateError;
    banner.hidden = false;
  } else if (!S.agent.connected) {
    banner.className = 'banner';
    banner.textContent = 'The agent on the session host is disconnected. The tree is read-only and live session state is unknown.';
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }

  $('#new-folder-root').disabled = down;
  $('#new-session-root').disabled = down;
  $('#hibernate-idle').disabled = down;
  $('#upload-button').disabled = down || !S.active;
  $('#files-button').disabled = !S.active;
}

/* ---------- tree ---------- */

function renderTree() {
  const tree = $('#tree');
  const keepScroll = tree.scrollTop;
  clear(tree);

  const frag = document.createDocumentFragment();
  frag.append(renderRecents());
  // A session outside every folder is unfiled, whether or not it has a tree leaf.
  // Root leaves come from New session at the top level and from moving a session to the root.
  const roots = childrenOf(null);
  const foldersOpen = !S.collapsed.has(FOLDERS_KEY);
  frag.append(sectionRow(FOLDERS_KEY, 'Folders', foldersOpen));
  if (foldersOpen) renderNodes(roots.filter(function (n) { return n.kind === 'folder'; }), 0, [], frag);

  frag.append(renderUnfiled(computeUnfiled() || [], roots.filter(function (n) { return n.kind !== 'folder'; })));

  tree.append(frag);
  tree.scrollTop = keepScroll;
}

function geometry() {
  return window.matchMedia('(max-width: 760px)').matches
    ? { row: 40, step: 20, base: 18 }
    : { row: 22, step: 16, base: 14 };
}

function cx(depth) {
  const g = geometry();
  return g.base + depth * g.step;
}

function icon(kind, className) {
  const svg = sh('svg', { class: className || '', viewBox: '0 0 16 16', 'aria-hidden': 'true' });
  const paths = {
    chevron: ['M6 4l4 4-4 4'],
    folder: ['M1.5 4v8.5h13v-7H7.5L6 4z']
  };
  for (const d of paths[kind] || []) svg.append(sh('path', { d: d }));
  return svg;
}

function statusSlot(st) {
  return h('span', { class: 'slot' }, h('span', { class: 'dot st-' + st, title: STATE_TEXT[st] || st }));
}

function sectionRow(key, label, open, extra) {
  return h('div', {
    class: 'row section' + (open ? ' open' : ''),
    role: 'treeitem', tabindex: '0',
    'aria-expanded': open ? 'true' : 'false', 'aria-label': label,
    dataset: { kind: 'section', id: key }
  }, h('span', { class: 'section-main' }, icon('chevron', 'section-chevron'), h('span', { class: 'name' }, label)), extra || null);
}

function folderSessionCount(id) {
  let total = 0;
  const stack = [id];
  while (stack.length) {
    const parent = stack.pop();
    for (const n of childrenOf(parent)) {
      if (n.kind === 'session') total += 1;
      else stack.push(n.id);
    }
  }
  return total;
}

function sessionAge(name, fallback) {
  if (Array.isArray(S.sessions)) for (const s of S.sessions) {
    if (s.name !== name) continue;
    const at = Number(s.originalCreatedAt || s.original_created_at || s.createdAt || s.created_at || 0);
    return at ? fmtAge(at) : (s.created || '');
  }
  return fallback ? fmtAge(fallback) : '';
}

function recentPath(name) {
  const leaf = leafBySession(name);
  return leaf ? pathOf(leaf.parent_id) : 'Unfiled';
}

function recentRows() {
  if (!Array.isArray(S.sessions)) return S.recents.slice(0, S.recentLimit).map(function (recent) {
    return {
      session_name: recent.session_name,
      last_activity_at: Number(recent.last_activity_at || recent.last_response_at) || 0,
      state: 'idle'
    };
  });
  return S.sessions
    .filter(function (session) { return session && session.name && !session.exited; })
    .map(function (session) {
      const status = S.sessionStatus[session.name] || {};
      const statusActivity = Object.prototype.hasOwnProperty.call(status, 'lastActivityAt')
        ? Number(status.lastActivityAt) || 0
        : (Number(status.updatedAt) || Number(status.lastResponseAt) || 0);
      const sessionActivity = Object.prototype.hasOwnProperty.call(session, 'lastActivityAt')
        ? Number(session.lastActivityAt) || 0
        : (Number(session.activityUpdatedAt) || Number(session.lastResponseAt) || 0);
      const lastActivityAt = Object.prototype.hasOwnProperty.call(S.sessionStatus, session.name)
        ? Math.max(0, statusActivity)
        : Math.max(0, sessionActivity);
      return {
        session_name: session.name,
        last_activity_at: lastActivityAt,
        state: liveState(session.name)
      };
    })
    .sort(function (left, right) {
      return right.last_activity_at - left.last_activity_at
        || left.session_name.localeCompare(right.session_name);
    })
    .slice(0, S.recentLimit);
}

function recentRow(recent) {
  const row = h('div', {
    class: 'row recent', role: 'treeitem', tabindex: '0',
    dataset: { kind: 'recent', name: recent.session_name }
  }, statusSlot('unknown'),
    h('span', { class: 'name' }),
    h('span', { class: 'age' }),
    h('button', { class: 'act', type: 'button', dataset: { act: 'menu' } }, '…'));
  setDepth(row, 0);
  updateRecentRow(row, recent);
  return row;
}

function updateStatusRow(row, state, label) {
  row.classList.toggle('selected', S.active === row.dataset.name);
  row.setAttribute('aria-label', label);
  const dot = row.querySelector('.slot .dot');
  if (dot) {
    dot.className = 'dot st-' + state;
    dot.title = STATE_TEXT[state] || state;
  }
}

function updateRecentRow(row, recent) {
  const name = recent.session_name;
  const state = liveState(name);
  row.dataset.name = name;
  row.dataset.activityAt = String(recent.last_activity_at || 0);
  row.dataset.state = recent.state || state;
  updateStatusRow(row, state, name + ', ' + (STATE_TEXT[state] || state) + ', recent');
  const nameEl = row.querySelector('.name');
  nameEl.textContent = name;
  nameEl.title = name;
  const age = row.querySelector('.age');
  age.textContent = fmtShortAge(recent.last_activity_at);
  age.title = recentPath(name) + (recent.last_activity_at ? ' · ' + new Date(recent.last_activity_at).toLocaleString() : '');
  const action = row.querySelector('button.act');
  action.setAttribute('aria-label', 'Actions for ' + name);
}

function syncRecentRows() {
  const tree = $('#tree');
  const section = tree.querySelector('.row.section[data-id="' + RECENTS_KEY + '"]');
  if (!section) return;
  const desired = section.getAttribute('aria-expanded') === 'true' ? recentRows() : [];
  const existing = new Map(Array.from(tree.querySelectorAll('.row[data-kind="recent"]')).map(function (row) {
    return [row.dataset.name, row];
  }));
  const focused = document.activeElement;
  let cursor = section.nextSibling;
  for (const recent of desired) {
    let row = existing.get(recent.session_name);
    if (row) existing.delete(recent.session_name);
    else row = recentRow(recent);
    updateRecentRow(row, recent);
    if (row !== cursor) tree.insertBefore(row, cursor);
    cursor = row.nextSibling;
  }
  for (const row of existing.values()) row.remove();
  if (focused && focused.isConnected && document.activeElement !== focused) {
    try { focused.focus({ preventScroll: true }); } catch (e) { focused.focus(); }
  }
}

function syncActivityViews() {
  if (!S.authed) return;
  syncRecentRows();
  for (const row of document.querySelectorAll('#tree .row[data-name]:not([data-kind="recent"])')) {
    const name = row.dataset.name;
    const state = liveState(name);
    const labelName = row.querySelector('.name')?.textContent || name;
    const suffix = row.dataset.kind === 'unfiled' ? ', unfiled' : '';
    updateStatusRow(row, state, labelName + ', ' + (STATE_TEXT[state] || state) + suffix);
    const age = row.querySelector('.age');
    if (age) age.textContent = sessionAge(name, 0);
  }
}

setInterval(function () {
  if (!document.hidden) syncActivityViews();
}, 1000);

function addGuides(row, depth, continuations, last, ownStem) {
  const g = geometry();
  const mid = Math.floor(g.row / 2);
  for (let i = 0; i < continuations.length; i++) {
    if (!continuations[i]) continue;
    const rail = h('span', { class: 'guide' });
    rail.style.cssText = 'left:' + cx(i) + 'px;top:0;bottom:0;width:1px';
    row.append(rail);
  }
  if (depth > 0) {
    const parentX = cx(depth - 1);
    const vertical = h('span', { class: 'guide' });
    vertical.style.cssText = 'left:' + parentX + 'px;top:0;height:' + (last ? (mid + 1) : g.row) + 'px;width:1px';
    const horizontal = h('span', { class: 'guide' });
    horizontal.style.cssText = 'left:' + parentX + 'px;top:' + mid + 'px;height:1px;width:' + (g.step - 8) + 'px';
    row.append(vertical, horizontal);
  }
  if (ownStem) {
    const stem = h('span', { class: 'guide' });
    stem.style.cssText = 'left:' + cx(depth) + 'px;top:' + mid + 'px;bottom:0;width:1px';
    row.append(stem);
  }
}

function renderNodes(nodes, depth, continuations, out) {
  nodes.forEach(function (n, index) {
    renderNode(n, depth, continuations, index === nodes.length - 1, out);
  });
}

function renderNode(n, depth, continuations, last, out) {
  if (n.kind === 'folder') {
    const open = !S.collapsed.has(n.id);
    const kids = childrenOf(n.id);
    out.append(folderRow(n, depth, open, continuations, last, kids.length > 0));
    if (open && kids.length) {
      const next = depth > 0 ? continuations.concat(!last) : continuations;
      renderNodes(kids, depth + 1, next, out);
    }
  } else {
    out.append(leafRow(n, depth, continuations, last));
  }
}

function setDepth(row, depth) { row.style.paddingLeft = (cx(depth) - 8) + 'px'; }

function folderRow(n, depth, open, continuations, last, hasKids) {
  const row = h('div', {
    class: 'row folder' + (open ? ' open' : ''),
    role: 'treeitem', tabindex: '0',
    'aria-expanded': open ? 'true' : 'false',
    'aria-label': 'Folder ' + n.name,
    dataset: { id: n.id, kind: 'folder', drag: canMutate() ? '1' : '0' }
  },
    h('span', { class: 'slot' }, icon('folder', 'folder-icon')),
    h('span', { class: 'name', title: n.name }, n.name),
    h('span', { class: 'count', title: 'Sessions inside' }, String(folderSessionCount(n.id))),
    icon('chevron', 'folder-chevron'),
    h('button', { class: 'act', type: 'button', 'aria-label': 'Actions for ' + n.name, dataset: { act: 'menu' } }, '…')
  );
  setDepth(row, depth);
  addGuides(row, depth, continuations, last, open && hasKids);
  return row;
}

function leafTitle(n) {
  const bits = [n.session_name];
  if (n.workdir) bits.push(n.workdir);
  bits.push(n.panes ? (n.panes + (Number(n.panes) === 1 ? ' pane' : ' panes')) : '');
  if (n.resume_sid) bits.push('resume ' + n.resume_sid);
  return bits.filter(Boolean).join('\n');
}

function leafRow(n, depth, continuations, last) {
  const st = liveState(n.session_name);
  const row = h('div', {
    class: 'row leaf' + (S.active === n.session_name ? ' selected' : ''),
    role: 'treeitem', tabindex: '0',
    'aria-label': n.name + ', ' + STATE_TEXT[st],
    dataset: { id: n.id, kind: 'leaf', name: n.session_name || '', drag: canMutate() ? '1' : '0' }
  },
    statusSlot(st),
    h('span', { class: 'name', title: leafTitle(n) }, n.name),
    st === 'missing' ? h('button', { class: 'act wide', type: 'button', disabled: !canMutate(), 'aria-label': 'Create session ' + n.session_name, dataset: { act: 'create' } }, 'Create') : null,
    h('span', { class: 'age' }, sessionAge(n.session_name, n.created_at)),
    h('button', { class: 'act', type: 'button', 'aria-label': 'Actions for ' + n.name, dataset: { act: 'menu' } }, '…')
  );
  setDepth(row, depth);
  addGuides(row, depth, continuations, last, false);
  return row;
}

function sessionByName(name) {
  if (Array.isArray(S.sessions)) for (const s of S.sessions) if (s.name === name) return s;
  return null;
}

// Leafless sessions and root leaves in one list, newest first by original creation time.
function unfiledEntries(list, rootLeaves) {
  const entries = list.map(function (s) { return { session: s, leaf: null, name: s.name }; });
  for (const n of rootLeaves) {
    const s = sessionByName(n.session_name) || {};
    entries.push({ session: { name: n.session_name, originalCreatedAt: s.originalCreatedAt, createdAt: s.createdAt }, leaf: n, name: n.session_name || n.name });
  }
  return entries.sort(function (a, b) { return sortNewestFirst(a.session, b.session); });
}

function renderUnfiled(list, rootLeaves) {
  const open = !S.collapsed.has(UNFILED_KEY);
  const frag = document.createDocumentFragment();
  frag.append(sectionRow(UNFILED_KEY, 'Unfiled, newest first', open));

  if (open) {
    const entries = unfiledEntries(list, rootLeaves || []);
    entries.forEach(function (entry, index) {
      if (entry.leaf) {
        frag.append(leafRow(entry.leaf, 0, [], index === entries.length - 1));
        return;
      }
      const s = entry.session;
      const st = s.exited ? 'exited' : liveState(s.name);
      const row = h('div', {
        class: 'row unfiled' + (S.active === s.name ? ' selected' : ''),
        role: 'treeitem', tabindex: '0',
        'aria-label': s.name + ', ' + st + ', unfiled',
        dataset: { kind: 'unfiled', name: s.name, drag: canMutate() ? '1' : '0' }
      },
        statusSlot(st),
        h('span', { class: 'name', title: s.name }, s.name),
        h('span', { class: 'age' }, sessionAge(s.name, s.createdAt || s.created_at)),
        h('button', { class: 'act', type: 'button', 'aria-label': 'Actions for ' + s.name, dataset: { act: 'menu' } }, '…')
      );
      setDepth(row, 0);
      frag.append(row);
    });
  }
  return frag;
}

function renderRecents() {
  const open = !S.collapsed.has(RECENTS_KEY);
  const frag = document.createDocumentFragment();
  const select = h('select', {
    class: 'recent-limit', 'aria-label': 'Recent sessions count',
    onclick: function (ev) { ev.stopPropagation(); },
    onchange: async function (ev) {
      const value = Number(ev.target.value);
      try {
        const result = await api('PUT', '/api/preferences/recent-limit', { recent_limit: value });
        S.recentLimit = result.recent_limit;
        S.recents = result.recents || [];
        ev.target.blur();
        S.sig = '';
        renderTree();
      } catch (e) { toast(errText(e), true); }
    }
  });
  [[3, '3'], [5, '5'], [10, '10'], [15, '15'], [0, 'Off']].forEach(function (option) {
    select.append(h('option', { value: String(option[0]), selected: option[0] === S.recentLimit }, option[1]));
  });
  const controls = h('span', { class: 'recent-controls' }, h('span', null, 'Show'), select);
  frag.append(sectionRow(RECENTS_KEY, 'Recent', open, controls));
  if (open) for (const recent of recentRows()) frag.append(recentRow(recent));
  return frag;
}

function toggleCollapse(key) {
  if (S.collapsed.has(key)) S.collapsed.delete(key); else S.collapsed.add(key);
  persistView();
  S.sig = stateSig();
  renderTree();
}

/* ---------- tree interaction ---------- */

$('#tree').addEventListener('click', function (ev) {
  if (drag.suppressClick) { drag.suppressClick = false; return; }
  const row = ev.target.closest('.row');
  if (!row) return;
  const btn = ev.target.closest('button.act');
  if (btn) { rowAction(btn.dataset.act, row, btn); return; }

  const kind = row.dataset.kind;
  if (kind === 'folder' || kind === 'section') toggleCollapse(row.dataset.id);
  else if (kind === 'leaf') activateLeaf(row);
  else if (kind === 'unfiled' || kind === 'recent') openSession(row.dataset.name);
});

$('#tree').addEventListener('keydown', function (ev) {
  const row = ev.target.closest ? ev.target.closest('.row') : null;
  if (!row) return;
  if ((ev.key === 'ContextMenu' || (ev.shiftKey && ev.key === 'F10')) && ev.target === row) {
    ev.preventDefault();
    openRowMenu(row, row);
    return;
  }
  if ((ev.key !== 'Enter' && ev.key !== ' ') || ev.target !== row) return;
  ev.preventDefault();
  row.click();
});

$('#tree').addEventListener('contextmenu', function (ev) {
  const row = ev.target.closest ? ev.target.closest('.row') : null;
  if (!row || row.dataset.kind === 'section') return;
  ev.preventDefault();
  openRowMenu(row, row);
});

function activateLeaf(row) {
  const n = nodeById(row.dataset.id);
  if (!n) return;
  const st = liveState(n.session_name);
  if (st === 'missing') {
    if (canMutate()) dlgRecreate(n);
    else toast('Session ' + n.session_name + ' is not created on the host.', true);
    return;
  }
  openSession(n.session_name);
}

function rowAction(act, row, btn) {
  const kind = row.dataset.kind;
  if (act === 'create') { const n = nodeById(row.dataset.id); if (n) dlgRecreate(n); return; }
  if (act !== 'menu') return;

  openRowMenu(row, btn);
}

function openRowMenu(row, anchor) {
  const kind = row.dataset.kind;
  if (kind === 'folder') menuFolder(anchor, nodeById(row.dataset.id));
  else if (kind === 'leaf') menuLeaf(anchor, nodeById(row.dataset.id));
  else if (kind === 'unfiled') menuUnfiled(anchor, row.dataset.name);
  else if (kind === 'recent') {
    const leaf = leafBySession(row.dataset.name);
    if (leaf) menuLeaf(anchor, leaf); else menuUnfiled(anchor, row.dataset.name);
  }
}

/* ---------- terminal frame ---------- */

async function openSession(name) {
  if (!name) return;
  const target = sessionByName(name);
  if (target?.sleeping) {
    S.waking.add(name);
    render();
  }
  try {
    const result = await api('POST', '/api/sessions/' + encodeURIComponent(name) + '/open', {});
    if (result?.wake?.wakeMs) toast('Woke ' + name + ' in ' + fmtSecs(result.wake.wakeMs / 1000) + '.');
  } catch (e) {
    toast(errText(e), true);
    return;
  } finally {
    S.waking.delete(name);
  }
  $('#files-drawer').hidden = true;
  freezeFrame(S.active);
  S.active = name;
  touchWarm(name);
  persistView();
  S.sig = '';
  render();
  syncFrames();
  if (isPhone()) setSidebarCollapsed(true);
  await refreshState(true);
}

function closeSession(name) {
  if (S.active !== name) return;
  S.active = null;
  persistView();
  S.sig = '';
  render();
  syncFrames();
}

let protectedControl = null;
let protectedSelection = null;

document.addEventListener('focusin', function (ev) {
  const target = ev.target;
  if (target.matches && target.matches('#app input, #app select, #app textarea, #app [contenteditable="true"]')) {
    protectedControl = target;
    protectedSelection = typeof target.selectionStart === 'number' ? [target.selectionStart, target.selectionEnd] : null;
  } else if (!(target instanceof HTMLIFrameElement)) {
    protectedControl = null;
    protectedSelection = null;
  }
});

document.addEventListener('selectionchange', function () {
  if (protectedControl && document.activeElement === protectedControl && typeof protectedControl.selectionStart === 'number') {
    protectedSelection = [protectedControl.selectionStart, protectedControl.selectionEnd];
  }
});

function restoreProtectedFocus() {
  if (modals.length && modals[modals.length - 1].restoreFocus) {
    modals[modals.length - 1].restoreFocus();
    return;
  }
  if (currentMenu) {
    const target = currentMenu.querySelector('.menu-item[data-menu-focus="true"]') || currentMenu.querySelector('.menu-item:not([disabled])');
    if (target) try { target.focus({ preventScroll: true }); } catch (e) { target.focus(); }
    return;
  }
  if (protectedControl && protectedControl.isConnected) {
    try { protectedControl.focus({ preventScroll: true }); } catch (e) { protectedControl.focus(); }
    if (protectedSelection && protectedControl.setSelectionRange) {
      try { protectedControl.setSelectionRange(protectedSelection[0], protectedSelection[1]); } catch (e) { /* non-text control */ }
    }
  }
}

function scheduleProtectedFocus() {
  [0, 60, 250].forEach(function (delay) { setTimeout(restoreProtectedFocus, delay); });
}

let refitFrame = 0;
function refitTerminals() {
  cancelAnimationFrame(refitFrame);
  refitFrame = requestAnimationFrame(function () {
    const frame = document.querySelector('.term-frame.active');
    if (frame) try { frame.contentWindow.dispatchEvent(new Event('resize')); } catch (e) { /* frame may still be loading */ }
  });
}

const warmOrder = [];
const WARM_COARSE_QUERY = window.matchMedia('(pointer: coarse)');

function warmLimit() {
  return window.innerWidth <= 760 || WARM_COARSE_QUERY.matches ? 3 : 15;
}

function touchWarm(name) {
  const old = warmOrder.indexOf(name);
  if (old >= 0) warmOrder.splice(old, 1);
  warmOrder.push(name);
}

function freezeFrame(name) {
  if (!name) return;
  const frame = Array.from(document.querySelectorAll('.term-frame')).find(function (item) { return item.dataset.name === name; });
  if (!frame || frame.classList.contains('warm-hidden')) return;
  disposeTerminalLinks(frame);
  try { frame.contentWindow.__mcwWarm?.suspend(); } catch (e) { /* client may still be loading */ }
  const rect = frame.getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0) {
    frame.style.width = Math.round(rect.width) + 'px';
    frame.style.height = Math.round(rect.height) + 'px';
  }
  frame.classList.remove('active');
  frame.classList.add('warm-hidden');
  frame.setAttribute('aria-hidden', 'true');
}

function showFrame(frame) {
  frame.removeAttribute('aria-hidden');
  if (frame.classList.contains('active') && !frame.classList.contains('warm-hidden')) {
    installTerminalLinks(frame, frame.dataset.name);
    return;
  }
  if (frame._mcwShowPromise) return;
  let resume;
  try { resume = frame.contentWindow.__mcwWarm?.resume(); } catch (e) { resume = null; }
  frame._mcwShowPromise = Promise.resolve(resume).catch(function () {
    // xterm retains its canvas renderer if WebGL recreation fails.
  }).then(function () {
    if (!frame.isConnected || frame.dataset.name !== S.active) {
      try { frame.contentWindow.__mcwWarm?.suspend(); } catch (e) { /* client may already be gone */ }
      return;
    }
    frame.classList.remove('warm-hidden');
    frame.classList.add('active');
    frame.style.width = '';
    frame.style.height = '';
    installTerminalLinks(frame, frame.dataset.name);
    refitTerminals();
  }).finally(function () {
    frame._mcwShowPromise = null;
    if (frame.isConnected && frame.dataset.name === S.active && frame.classList.contains('warm-hidden')) showFrame(frame);
  });
}

function disposeTerminalLinks(frame) {
  if (frame && frame._mcwLinkDisposer) frame._mcwLinkDisposer();
}

function disposeFrame(frame) {
  disposeTerminalLinks(frame);
  try { frame.contentWindow.__mcwWarm?.suspend(); } catch (e) { /* client may already be gone */ }
  frame.remove();
}

function syncFrames() {
  const box = $('#frames');
  const existing = new Map();
  for (const f of box.querySelectorAll('iframe')) existing.set(f.dataset.name, f);

  if (!S.authed) {
    for (const f of existing.values()) disposeFrame(f);
    return;
  }
  const live = new Set(Array.isArray(S.sessions) ? S.sessions.filter(function (s) { return !s.exited; }).map(function (s) { return s.name; }) : []);
  for (let index = warmOrder.length - 1; index >= 0; index -= 1) {
    if (live.size && !live.has(warmOrder[index])) warmOrder.splice(index, 1);
  }
  if (S.active && !warmOrder.includes(S.active)) touchWarm(S.active);
  while (warmOrder.length > warmLimit()) {
    const evicted = warmOrder.shift();
    const frame = existing.get(evicted);
    if (frame) { disposeFrame(frame); existing.delete(evicted); }
  }
  for (const [name, frame] of existing) {
    if (!warmOrder.includes(name)) { disposeFrame(frame); existing.delete(name); continue; }
    if (name === S.active) showFrame(frame); else freezeFrame(name);
  }

  if (S.active && !existing.has(S.active)) {
    const sessionName = S.active;
    const f = h('iframe', {
      class: 'term-frame warm-hidden',
      title: 'Terminal for ' + sessionName,
      src: '/t/' + encodeURIComponent(sessionName),
      allow: 'clipboard-read; clipboard-write',
      dataset: { name: sessionName }
    });
    f.addEventListener('load', function () {
      watchFrameDrags(f);
      scheduleProtectedFocus();
      if (sessionName === S.active) showFrame(f);
    });
    box.append(f);
    existing.set(S.active, f);
  }

  const activeFrame = S.active ? existing.get(S.active) : null;
  if (activeFrame) showFrame(activeFrame);

  const empty = $('#no-session');
  if (empty) empty.hidden = !!S.active;
}

/* ---------- file transfer ---------- */

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const HTTP_UPLOAD_CHUNK = 8 * 1024 * 1024;
const pathCache = new Map();

function quotePath(filePath) {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(filePath)) return filePath;
  return "'" + filePath.replace(/'/g, "'\\''") + "'";
}

function activeTerminal() {
  const frame = document.querySelector('.term-frame.active');
  if (!frame || frame.dataset.name !== S.active) return null;
  try { return frame.contentWindow.term || null; } catch (e) { return null; }
}

function insertUploadedPaths(paths) {
  const term = activeTerminal();
  if (!term || typeof term.input !== 'function') {
    throw new Error('The terminal is not ready for inserted paths.');
  }
  let prefix = '';
  try {
    const buffer = term.buffer.active;
    const line = buffer.getLine(buffer.baseY + buffer.cursorY);
    const previous = buffer.cursorX > 0 ? line?.getCell(buffer.cursorX - 1)?.getChars() : '';
    if (previous && !/\s/.test(previous)) prefix = ' ';
  } catch (e) { /* xterm buffer may be replacing the active line */ }
  term.input(prefix + paths.map(quotePath).join(' '), true);
  term.focus();
}

function uploadChunk(session, batch, uploadId, item, offset, blob, final, progress) {
  return new Promise(function (resolve, reject) {
    const query = new URLSearchParams({
      batch: batch,
      upload_id: uploadId,
      path: item.relativePath,
      size: String(item.file.size),
      chunk_size: String(blob.size),
      offset: String(offset),
      final: final ? '1' : '0'
    });
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/sessions/' + encodeURIComponent(session) + '/uploads?' + query.toString());
    xhr.responseType = 'json';
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.upload.onprogress = function (ev) { progress(offset + ev.loaded); };
    xhr.onerror = function () { reject(new ApiError(0, { error: 'network_error' })); };
    xhr.onload = function () {
      if (xhr.status === 401) toLogin('Session expired. Log in again.');
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new ApiError(xhr.status, xhr.response || { error: 'upload_failed' }));
        return;
      }
      resolve(xhr.response);
    };
    xhr.send(blob);
  });
}

async function uploadRequest(session, batch, uploadId, item, progress) {
  let offset = 0;
  let result = null;
  do {
    const end = Math.min(item.file.size, offset + HTTP_UPLOAD_CHUNK);
    const final = end === item.file.size;
    const blob = item.file.slice(offset, end);
    result = await uploadChunk(session, batch, uploadId, item, offset, blob, final, progress);
    offset = end;
  } while (offset < item.file.size);
  return result;
}

function showUploadOverlay(title, detail, progress) {
  $('#upload-title').textContent = title;
  $('#upload-detail').textContent = detail || '';
  const bar = $('#upload-progress');
  bar.hidden = progress === null;
  if (progress !== null) bar.value = Math.max(0, Math.min(1, progress));
  $('#upload-overlay').hidden = false;
}

function hideUploadOverlay() {
  $('#upload-overlay').hidden = true;
  $('#upload-progress').hidden = true;
}

async function uploadItems(items) {
  if (!S.active) throw new Error('Open a session before uploading.');
  if (!canMutate()) throw new Error('The agent on the session host is disconnected.');
  if (!items.length) return;
  for (const item of items) {
    if (item.file.size > MAX_UPLOAD_BYTES) throw new Error(item.file.name + ' exceeds the 2 GB upload limit.');
  }
  const session = S.active;
  const batch = crypto.randomUUID().replace(/-/g, '');
  const total = items.reduce(function (sum, item) { return sum + item.file.size; }, 0);
  let completed = 0;
  const results = [];
  showUploadOverlay('Uploading to ' + session, 'Preparing ' + items.length + (items.length === 1 ? ' item' : ' items'), 0);
  try {
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const result = await uploadRequest(session, batch, batch + '_' + index, item, function (loaded) {
        const sent = completed + loaded;
        showUploadOverlay(
          'Uploading ' + item.relativePath,
          fmtBytes(sent) + ' of ' + fmtBytes(total),
          total ? sent / total : (index + 1) / items.length
        );
      });
      completed += item.file.size;
      results.push({ item: item, result: result });
    }
    const inserted = [];
    for (const entry of results) {
      const requested = entry.item.insertRelative
        ? entry.result.batch_root + '/' + entry.item.insertRelative
        : entry.result.path;
      if (!inserted.includes(requested)) inserted.push(requested);
    }
    insertUploadedPaths(inserted);
    toast((items.length === 1 ? 'Uploaded 1 item.' : 'Uploaded ' + items.length + ' items.') + ' Paths inserted without submitting.');
    if (!$('#files-drawer').hidden) await openFilesDrawer();
  } finally {
    hideUploadOverlay();
  }
}

function readDirectoryEntries(reader) {
  return new Promise(function (resolve, reject) {
    const all = [];
    const next = function () {
      reader.readEntries(function (entries) {
        if (!entries.length) { resolve(all); return; }
        all.push.apply(all, entries);
        next();
      }, reject);
    };
    next();
  });
}

async function walkEntry(entry, prefix, insertRelative, out) {
  const relative = prefix ? prefix + '/' + entry.name : entry.name;
  if (entry.isFile) {
    const file = await new Promise(function (resolve, reject) { entry.file(resolve, reject); });
    out.push({ file: file, relativePath: relative, insertRelative: insertRelative });
    return;
  }
  if (!entry.isDirectory) return;
  const children = await readDirectoryEntries(entry.createReader());
  for (const child of children) await walkEntry(child, relative, insertRelative || entry.name, out);
}

// A DataTransfer is readable only while its drop event is dispatched. Every item's file and entry
// are taken synchronously here; directories are walked afterwards through their entries.
function captureDrop(dataTransfer) {
  const captured = [];
  for (const item of Array.from(dataTransfer.items || [])) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile ? item.getAsFile() : null;
    const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
    captured.push({ file: file, entry: entry });
  }
  return { captured: captured, files: Array.from(dataTransfer.files || []) };
}

async function droppedItems(drop) {
  const out = [];
  let usedEntries = false;
  for (const item of drop.captured) {
    const directFile = item.file;
    if (directFile?.webkitRelativePath) {
      const relative = directFile.webkitRelativePath;
      const slash = relative.indexOf('/');
      out.push({ file: directFile, relativePath: relative, insertRelative: slash > 0 ? relative.slice(0, slash) : null });
      usedEntries = true;
      continue;
    }
    const entry = item.entry;
    if (!entry) continue;
    usedEntries = true;
    await walkEntry(entry, '', entry.isDirectory ? entry.name : null, out);
  }
  if (usedEntries) return out;
  for (const file of drop.files) {
    const relative = file.webkitRelativePath || file.name;
    const slash = relative.indexOf('/');
    out.push({ file: file, relativePath: relative, insertRelative: slash > 0 ? relative.slice(0, slash) : null });
  }
  return out;
}

function pickedItems(files) {
  return Array.from(files || []).map(function (file) {
    const relative = file.webkitRelativePath || file.name;
    const slash = relative.indexOf('/');
    return { file: file, relativePath: relative, insertRelative: slash > 0 ? relative.slice(0, slash) : null };
  });
}

/* ---------- file drags from the desktop ----------
 * A real drag over the terminal is hit tested into the terminal iframe's own document, so the
 * parent page never sees it. Both documents listen. The first file dragenter in either one shows
 * a full-page overlay in this document, and from then on the browser hit tests every dragover and
 * the drop onto that overlay. A file drag is always accepted here, so Chrome never opens the file
 * in a tab; a drop that cannot upload says why. */

const fileDrag = { shown: false, lastDoc: null };

function hasFiles(ev) {
  return Array.from(ev.dataTransfer?.types || []).includes('Files');
}

function dropBlocker() {
  if (!S.authed) return { title: 'Log in to upload', detail: 'Files can be dropped after you log in.' };
  if (!S.active) return { title: 'No session is open', detail: 'Open a session in the sidebar, then drop the files on the page.' };
  if (!canMutate()) return { title: 'The agent on the session host is disconnected', detail: 'Uploads need the agent. Drop the files again when it reconnects.' };
  return null;
}

function showDropOverlay() {
  const blocked = dropBlocker();
  const el = $('#drop-overlay');
  el.dataset.state = blocked ? 'blocked' : 'ready';
  $('#drop-title').textContent = blocked ? blocked.title : 'Drop to upload to ' + S.active;
  $('#drop-detail').textContent = blocked
    ? blocked.detail
    : 'Files and folders go to this session\'s upload folder on the session host. Their paths are typed at the prompt without Enter.';
  el.hidden = false;
  document.body.classList.add('file-dragging');
  fileDrag.shown = true;
}

function hideDropOverlay() {
  fileDrag.shown = false;
  fileDrag.lastDoc = null;
  $('#drop-overlay').hidden = true;
  document.body.classList.remove('file-dragging');
}

// dragenter and dragover in either document. Accepting them is what stops Chrome opening the file.
function acceptFileDrag(doc) {
  return function (ev) {
    if (!hasFiles(ev)) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'copy';
    fileDrag.lastDoc = doc;
    if (!fileDrag.shown) showDropOverlay();
  };
}

async function onFileDrop(ev) {
  if (!hasFiles(ev)) return;
  ev.preventDefault();
  const drop = captureDrop(ev.dataTransfer);
  hideDropOverlay();
  const blocked = dropBlocker();
  if (blocked) { toast(blocked.title + '. Nothing was uploaded. ' + blocked.detail, true); return; }
  try { await uploadItems(await droppedItems(drop)); }
  catch (e) { hideUploadOverlay(); toast(errText(e), true); }
}

// Top document. Once the overlay is up it is the only element a drag can enter, and it leaves
// it for no other element, so a dragleave from the overlay with no related target means the drag
// left the window.
window.addEventListener('dragenter', acceptFileDrag('top'));
window.addEventListener('dragover', acceptFileDrag('top'));
window.addEventListener('dragleave', function (ev) {
  if (!hasFiles(ev)) return;
  if (ev.target === $('#drop-overlay') && !ev.relatedTarget) hideDropOverlay();
});
window.addEventListener('drop', onFileDrop);

// No mouse event is dispatched while a drag is in progress, so one means the drag is over.
for (const type of ['mousemove', 'mousedown']) {
  window.addEventListener(type, function () { if (fileDrag.shown) hideDropOverlay(); }, true);
}

// Terminal iframe document. Its drag events never reach this document.
function watchFrameDrags(frame) {
  let win = null;
  try { win = frame.contentWindow; } catch (e) { return; }
  if (!win || win.__mcwFileDrags) return;
  win.__mcwFileDrags = true;
  win.addEventListener('dragenter', acceptFileDrag('frame'), true);
  win.addEventListener('dragover', acceptFileDrag('frame'), true);
  // Chrome fires dragenter on the overlay before the frame hears anything more, so a frame
  // dragleave with no related target after that is not a window exit. Without it, it is.
  win.addEventListener('dragleave', function (ev) {
    if (!hasFiles(ev)) return;
    if (!ev.relatedTarget && fileDrag.lastDoc === 'frame') hideDropOverlay();
  }, true);
  win.addEventListener('drop', onFileDrop, true);
}

function chooseUpload(anchor) {
  openMenu(anchor, 'Upload to ' + S.active, [
    { label: 'Choose files', run: function () { $('#upload-files').click(); } },
    { label: 'Choose a folder', run: function () { $('#upload-folder').click(); } }
  ]);
}

$('#upload-button').addEventListener('click', function () { if (S.active) chooseUpload($('#upload-button')); });
$('#files-choose').addEventListener('click', function () { if (S.active) chooseUpload($('#files-choose')); });
for (const input of [$('#upload-files'), $('#upload-folder')]) {
  input.addEventListener('change', async function () {
    try { await uploadItems(pickedItems(input.files)); }
    catch (e) { hideUploadOverlay(); toast(errText(e), true); }
    input.value = '';
  });
}

function startDownload(session, filePath) {
  let sink = $('#mcw-download-sink');
  if (!sink) {
    sink = h('iframe', { id: 'mcw-download-sink', title: 'File download', hidden: true });
    document.body.append(sink);
  }
  sink.src = '/api/files/download?' + new URLSearchParams({ session: session, path: filePath }).toString();
}

function pathCandidates(text) {
  const found = [];
  const quoted = /(['"])(\/[^\r\n]*?)\1/g;
  let match;
  while ((match = quoted.exec(text)) !== null) {
    if (!match[2] || /\x1b/.test(match[2])) continue;
    found.push({ path: match[2], start: match.index + 1, length: match[2].length });
  }
  const plain = /(^|[\s(=\[])(\/[A-Za-z0-9._~!$&+,%:@;=-]+(?:\/[A-Za-z0-9._~!$&+,%:@;=-]+)*)/g;
  while ((match = plain.exec(text)) !== null) {
    const value = match[2].replace(/[.,;:!?]+$/, '');
    if (!value || found.some(function (entry) { return entry.start === match.index + match[1].length; })) continue;
    found.push({ path: value, start: match.index + match[1].length, length: value.length });
  }
  return found;
}

async function existingPaths(session, paths) {
  const now = Date.now();
  const missing = paths.filter(function (filePath) {
    const cached = pathCache.get(filePath);
    return !cached || now - cached.at > 5000;
  });
  if (missing.length) {
    const result = await api('POST', '/api/files/stat', { session: session, paths: missing });
    for (const item of (result.paths || [])) pathCache.set(item.path, { at: now, value: item });
  }
  return paths.map(function (filePath) { return pathCache.get(filePath)?.value; });
}

function installTerminalLinks(frame, session) {
  if (!frame || frame.dataset.name !== S.active || frame._mcwLinkDisposer) return;
  let disposed = false;
  let retryTimer = 0;
  let teardown = null;
  frame._mcwLinkDisposer = function () {
    if (disposed) return;
    disposed = true;
    clearTimeout(retryTimer);
    if (teardown) teardown();
    frame._mcwLinkDisposer = null;
  };
  let attempts = 0;
  const attach = function () {
    if (disposed || frame.dataset.name !== S.active) return;
    let term;
    try { term = frame.contentWindow.term; } catch (e) { return; }
    if (!term || typeof term.registerLinkProvider !== 'function') {
      attempts += 1;
      if (attempts < 100 && frame.isConnected) retryTimer = setTimeout(attach, 50);
      return;
    }
    const knownLinks = new Map();
    const linksLive = function () {
      return !disposed && frame.isConnected && frame.dataset.name === S.active && session === S.active;
    };
    let lastDownload = { path: '', at: 0 };
    const activateDownload = function (filePath) {
      if (lastDownload.path === filePath && Date.now() - lastDownload.at < 1000) return;
      lastDownload = { path: filePath, at: Date.now() };
      startDownload(session, filePath);
    };
    const syncLinkOverlay = function (lineNumber, links) {
      const screen = term.element?.querySelector('.xterm-screen');
      const cell = term._core?._renderService?.dimensions?.css?.cell;
      if (!screen || !cell?.width || !cell?.height) return;
      for (const old of screen.querySelectorAll('.mcw-file-link[data-line="' + lineNumber + '"]')) old.remove();
      const visibleLine = lineNumber - term.buffer.active.viewportY;
      if (visibleLine < 1 || visibleLine > term.rows) return;
      for (const link of links) {
        const anchor = h('a', {
          class: 'mcw-file-link',
          href: '/api/files/download?' + new URLSearchParams({ session: session, path: link.text }).toString(),
          download: '',
          'aria-label': 'Download ' + link.text,
          title: 'Download ' + link.text
        });
        anchor.dataset.line = String(lineNumber);
        anchor.style.position = 'absolute';
        anchor.style.zIndex = '10';
        anchor.style.left = ((link.range.start.x - 1) * cell.width) + 'px';
        anchor.style.top = ((visibleLine - 1) * cell.height) + 'px';
        anchor.style.width = ((link.range.end.x - link.range.start.x + 1) * cell.width) + 'px';
        anchor.style.height = cell.height + 'px';
        anchor.style.cursor = 'pointer';
        anchor.style.background = 'transparent';
        anchor.addEventListener('click', function (event) { event.stopPropagation(); });
        screen.append(anchor);
      }
    };
    const linkProvider = term.registerLinkProvider({
      provideLinks: function (lineNumber, callback) {
        const line = term.buffer.active.getLine(lineNumber - 1);
        if (!line) { callback(undefined); return; }
        const text = line.translateToString(true);
        const candidates = pathCandidates(text);
        if (!candidates.length) { callback(undefined); return; }
        existingPaths(session, candidates.map(function (candidate) { return candidate.path; }))
          .then(function (stats) {
            if (!linksLive()) return;
            const links = [];
            for (let index = 0; index < candidates.length; index += 1) {
              if (!stats[index]?.exists) continue;
              const candidate = candidates[index];
              links.push({
                range: {
                  start: { x: candidate.start + 1, y: lineNumber },
                  end: { x: candidate.start + candidate.length, y: lineNumber }
                },
                text: candidate.path,
                activate: function (event, textValue) {
                  event.preventDefault();
                  activateDownload(textValue);
                }
              });
            }
            knownLinks.set(lineNumber, links);
            syncLinkOverlay(lineNumber, links);
            callback(links.length ? links : undefined);
          })
          .catch(function () {
            if (!linksLive()) return;
            knownLinks.delete(lineNumber);
            syncLinkOverlay(lineNumber, []);
            callback(undefined);
          });
      }
    });
    let overlayTimer = 0;
    let overlayGeneration = 0;
    const refreshVisibleLinks = async function () {
      const generation = ++overlayGeneration;
      const start = term.buffer.active.viewportY;
      const candidates = [];
      for (let row = 0; row < term.rows; row += 1) {
        const text = term.buffer.active.getLine(start + row)?.translateToString(true) || '';
        for (const candidate of pathCandidates(text)) {
          if (candidates.length >= 64) break;
          candidates.push({ ...candidate, lineNumber: start + row + 1 });
        }
        if (candidates.length >= 64) break;
      }
      const screen = term.element?.querySelector('.xterm-screen');
      if (!candidates.length) {
        if (screen) for (const old of screen.querySelectorAll('.mcw-file-link')) old.remove();
        return;
      }
      try {
        const stats = await existingPaths(session, candidates.map(function (candidate) { return candidate.path; }));
        if (!linksLive() || generation !== overlayGeneration) return;
        if (screen) for (const old of screen.querySelectorAll('.mcw-file-link')) old.remove();
        const byLine = new Map();
        for (let index = 0; index < candidates.length; index += 1) {
          if (!stats[index]?.exists) continue;
          const candidate = candidates[index];
          const links = byLine.get(candidate.lineNumber) || [];
          links.push({
            text: candidate.path,
            range: {
              start: { x: candidate.start + 1, y: candidate.lineNumber },
              end: { x: candidate.start + candidate.length, y: candidate.lineNumber }
            }
          });
          byLine.set(candidate.lineNumber, links);
        }
        for (const [lineNumber, links] of byLine) {
          knownLinks.set(lineNumber, links);
          syncLinkOverlay(lineNumber, links);
        }
      } catch (e) { /* an existence check failure produces no file links */ }
    };
    const scheduleOverlayRefresh = function () {
      clearTimeout(overlayTimer);
      overlayTimer = setTimeout(refreshVisibleLinks, 250);
    };
    const renderSubscription = term.onRender(scheduleOverlayRefresh);
    const scrollSubscription = term.onScroll(scheduleOverlayRefresh);
    scheduleOverlayRefresh();
    const linkAtEvent = function (event) {
      const screen = term.element?.querySelector('.xterm-screen');
      const cell = term._core?._renderService?.dimensions?.css?.cell;
      if (!screen || !cell?.width || !cell?.height) return null;
      const rect = screen.getBoundingClientRect();
      const x = Math.floor((event.clientX - rect.left) / cell.width) + 1;
      const y = Math.floor((event.clientY - rect.top) / cell.height) + 1;
      const lineNumber = term.buffer.active.viewportY + y;
      const known = (knownLinks.get(lineNumber) || []).find(function (link) {
        return x >= link.range.start.x && x <= link.range.end.x;
      });
      if (known) return known;
      const text = term.buffer.active.getLine(lineNumber - 1)?.translateToString(true) || '';
      const candidate = pathCandidates(text).find(function (item) {
        return x >= item.start + 1 && x <= item.start + item.length;
      });
      const cached = candidate && pathCache.get(candidate.path)?.value;
      if (!candidate || cached?.exists === false) return null;
      return {
        text: candidate.path,
        unchecked: !cached,
        range: { start: { x: candidate.start + 1, y: lineNumber }, end: { x: candidate.start + candidate.length, y: lineNumber } }
      };
    };
    const activateEventLink = function (link) {
      if (!link.unchecked) { activateDownload(link.text); return; }
      existingPaths(session, [link.text]).then(function (stats) {
        if (linksLive() && stats[0]?.exists) activateDownload(link.text);
      }).catch(function () { /* an existence check failure is not a link */ });
    };
    const onMouseDown = function (event) {
      if (!linkAtEvent(event)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const onMouseUp = function (event) {
      const link = linkAtEvent(event);
      if (!link) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      activateEventLink(link);
    };
    const onDocumentClick = function (event) {
      const link = linkAtEvent(event);
      if (!link) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      activateEventLink(link);
    };
    term.element.addEventListener('mousedown', onMouseDown, true);
    term.element.addEventListener('mouseup', onMouseUp, true);
    frame.contentDocument.addEventListener('click', onDocumentClick, true);
    teardown = function () {
      clearTimeout(overlayTimer);
      overlayGeneration += 1;
      linkProvider.dispose();
      renderSubscription.dispose();
      scrollSubscription.dispose();
      term.element.removeEventListener('mousedown', onMouseDown, true);
      term.element.removeEventListener('mouseup', onMouseUp, true);
      frame.contentDocument?.removeEventListener('click', onDocumentClick, true);
      const screen = term.element?.querySelector('.xterm-screen');
      if (screen) for (const old of screen.querySelectorAll('.mcw-file-link')) old.remove();
      knownLinks.clear();
    };
  };
  attach();
}

async function openFilesDrawer() {
  if (!S.active) return;
  const session = S.active;
  $('#files-session').textContent = session;
  $('#files-drop-session').textContent = session;
  $('#files-choose').disabled = !canMutate();
  const list = $('#files-list');
  clear(list);
  list.append(h('p', { class: 'empty small' }, 'Loading files.'));
  $('#files-drawer').hidden = false;
  try {
    const result = await api('GET', '/api/sessions/' + encodeURIComponent(session) + '/files');
    if (S.active !== session) return;
    clear(list);
    if (!(result.transfers || []).length) {
      list.append(h('p', { class: 'empty small' }, 'No transfers for this session.'));
      return;
    }
    for (const transfer of result.transfers) {
      list.append(h('div', { class: 'file-row' },
        h('div', { class: 'file-path', title: transfer.path }, transfer.path),
        h('div', { class: 'file-meta' }, (transfer.direction === 'upload' ? 'Uploaded' : 'Downloaded') + ' · ' + fmtBytes(transfer.size) + ' · ' + fmtAge(transfer.created_at)),
        h('button', {
          class: 'file-download', type: 'button', disabled: !canMutate(),
          'aria-label': 'Download ' + transfer.path,
          onclick: function () { startDownload(session, transfer.path); }
        }, 'Download')
      ));
    }
  } catch (e) {
    clear(list);
    list.append(h('p', { class: 'form-error' }, errText(e)));
  }
}

$('#files-button').addEventListener('click', openFilesDrawer);
$('#files-close').addEventListener('click', function () { $('#files-drawer').hidden = true; });

/* ---------- sidebar ---------- */

const PHONE_QUERY = window.matchMedia('(max-width: 760px)');
const SIDEBAR_DEFAULT = 300;

function isPhone() { return PHONE_QUERY.matches; }
function sidebarDevice() { return isPhone() ? 'phone' : 'desktop'; }
function sidebarKey(suffix) { return 'mcw.sidebar.' + sidebarDevice() + '.' + suffix; }

function pruneWarmFrames() {
  if (S.authed) syncFrames();
}

window.addEventListener('resize', pruneWarmFrames);
for (const query of [PHONE_QUERY, WARM_COARSE_QUERY]) {
  if (query.addEventListener) query.addEventListener('change', pruneWarmFrames);
  else query.addListener(pruneWarmFrames);
}
function clampSidebarWidth(value) {
  return Math.max(220, Math.min(520, Math.min(window.innerWidth * .55, Number(value) || SIDEBAR_DEFAULT)));
}

function loadSidebarState() {
  S.sidebarWidth = clampSidebarWidth(LS.get(sidebarKey('width'), SIDEBAR_DEFAULT));
  S.sidebarCollapsed = !!LS.get(sidebarKey('collapsed'), isPhone());
  applySidebarState(false);
}

function applySidebarState(save) {
  document.documentElement.style.setProperty('--sidebar-width', Math.round(S.sidebarWidth) + 'px');
  document.body.classList.toggle('sidebar-collapsed', S.sidebarCollapsed);
  $('#show-sidebar').setAttribute('aria-expanded', S.sidebarCollapsed ? 'false' : 'true');
  $('#scrim').hidden = !isPhone() || S.sidebarCollapsed;
  $('#sidebar-resizer').setAttribute('aria-valuenow', String(Math.round(S.sidebarWidth)));
  if (save) {
    LS.set(sidebarKey('width'), Math.round(S.sidebarWidth));
    LS.set(sidebarKey('collapsed'), S.sidebarCollapsed);
  }
  requestAnimationFrame(function () { refitTerminals(); requestAnimationFrame(refitTerminals); });
}

function setSidebarCollapsed(collapsed) {
  S.sidebarCollapsed = !!collapsed;
  applySidebarState(true);
}

$('#hide-sidebar').addEventListener('click', function () { setSidebarCollapsed(true); });
$('#show-sidebar').addEventListener('click', function () { setSidebarCollapsed(false); });
$('#scrim').addEventListener('click', function () { setSidebarCollapsed(true); });
$('#collapse-folders').addEventListener('click', function () {
  S.collapsed.add(FOLDERS_KEY);
  for (const n of S.nodes) if (n.kind === 'folder') S.collapsed.add(n.id);
  persistView();
  S.sig = stateSig();
  renderTree();
});

const sidebarResizer = $('#sidebar-resizer');
let resizingSidebar = false;

sidebarResizer.addEventListener('pointerdown', function (ev) {
  if (isPhone() || ev.button !== 0) return;
  resizingSidebar = true;
  sidebarResizer.classList.add('dragging');
  sidebarResizer.setPointerCapture(ev.pointerId);
  ev.preventDefault();
});

sidebarResizer.addEventListener('pointermove', function (ev) {
  if (!resizingSidebar) return;
  S.sidebarWidth = clampSidebarWidth(ev.clientX);
  applySidebarState(false);
});

function finishSidebarResize() {
  if (!resizingSidebar) return;
  resizingSidebar = false;
  sidebarResizer.classList.remove('dragging');
  applySidebarState(true);
}

sidebarResizer.addEventListener('pointerup', finishSidebarResize);
sidebarResizer.addEventListener('pointercancel', finishSidebarResize);
sidebarResizer.addEventListener('dblclick', function () {
  S.sidebarWidth = SIDEBAR_DEFAULT;
  applySidebarState(true);
});
sidebarResizer.addEventListener('keydown', function (ev) {
  if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
  ev.preventDefault();
  S.sidebarWidth = clampSidebarWidth(S.sidebarWidth + (ev.key === 'ArrowRight' ? 10 : -10));
  applySidebarState(true);
});

PHONE_QUERY.addEventListener('change', loadSidebarState);

/* ---------- context menus ---------- */

let currentMenu = null;

function menuOpen() { return currentMenu !== null; }

function closeMenu() {
  if (!currentMenu) return;
  currentMenu.remove();
  currentMenu = null;
  document.removeEventListener('pointerdown', onMenuOutside, true);
  window.removeEventListener('resize', closeMenu);
  // deferred so a menu opened straight after this one still measures a live anchor row
  if (S.sig !== stateSig()) setTimeout(render, 0);
}

function onMenuOutside(ev) {
  if (currentMenu && !currentMenu.contains(ev.target)) closeMenu();
}

function openMenu(anchor, head, items) {
  closeMenu();
  const m = h('div', { class: 'menu', role: 'menu' });
  if (head) m.append(h('div', { class: 'menu-head' }, head));
  for (const it of items) {
    if (!it) continue;
    m.append(h('button', {
      class: 'menu-item' + (it.danger ? ' danger' : ''),
      type: 'button', role: 'menuitem',
      disabled: it.disabled === true,
      onclick: function () { closeMenu(); it.run(); }
    }, it.label));
  }
  document.body.append(m);

  const r = anchor.getBoundingClientRect();
  const mw = m.offsetWidth, mh = m.offsetHeight;
  let left = Math.min(r.right - mw, window.innerWidth - mw - 8);
  left = Math.max(8, left);
  let top = r.bottom + 4;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 4);
  m.style.left = left + 'px';
  m.style.top = top + 'px';

  currentMenu = m;
  m.addEventListener('focusin', function (ev) {
    for (const item of m.querySelectorAll('.menu-item')) item.removeAttribute('data-menu-focus');
    if (ev.target.classList && ev.target.classList.contains('menu-item')) ev.target.dataset.menuFocus = 'true';
  });
  m.addEventListener('keydown', function (ev) {
    const enabled = Array.from(m.querySelectorAll('.menu-item:not([disabled])'));
    const at = enabled.indexOf(document.activeElement);
    let next = -1;
    if (ev.key === 'ArrowDown') next = (at + 1) % enabled.length;
    else if (ev.key === 'ArrowUp') next = (at - 1 + enabled.length) % enabled.length;
    else if (ev.key === 'Home') next = 0;
    else if (ev.key === 'End') next = enabled.length - 1;
    else if (ev.key === 'Escape') { ev.preventDefault(); closeMenu(); anchor.focus(); return; }
    else return;
    ev.preventDefault();
    if (enabled[next]) enabled[next].focus();
  });
  document.addEventListener('pointerdown', onMenuOutside, true);
  window.addEventListener('resize', closeMenu);
  const first = m.querySelector('.menu-item:not([disabled])');
  if (first) setTimeout(function () { try { first.focus(); } catch (e) { /* ignore */ } }, 10);
}

function menuFolder(anchor, n) {
  if (!n) return;
  const ro = !canMutate();
  openMenu(anchor, n.name, [
    { label: 'New session here', disabled: ro, run: function () { dlgNewSession(n.id); } },
    { label: 'New folder here', disabled: ro, run: function () { dlgNewFolder(n.id); } },
    { label: 'Rename folder', disabled: ro, run: function () { dlgRename(n); } },
    { label: 'Move to folder', disabled: ro, run: function () { dlgMove(n); } },
    { label: 'Delete folder', danger: true, disabled: ro, run: function () { dlgDeleteFolder(n); } }
  ]);
}

function menuLeaf(anchor, n) {
  if (!n) return;
  const ro = !canMutate();
  const st = liveState(n.session_name);
  openMenu(anchor, n.session_name, [
    { label: 'Open terminal', run: function () { openSession(n.session_name); } },
    st === 'idle' ? { label: 'Hibernate', disabled: ro, run: function () { dlgHibernateOne(n.session_name); } } : null,
    st === 'missing' ? { label: 'Create session', disabled: ro, run: function () { dlgRecreate(n); } } : null,
    st === 'idle' ? { label: 'Rename session', disabled: ro, run: function () { dlgRenameSession(n.session_name); } } : null,
    { label: 'Move to folder', disabled: ro, run: function () { dlgMove(n); } },
    { label: 'Delete session', danger: true, disabled: ro, run: function () { dlgDeleteLeaf(n); } }
  ]);
}

function menuUnfiled(anchor, name) {
  const ro = !canMutate();
  const st = liveState(name);
  openMenu(anchor, name, [
    { label: 'Open terminal', run: function () { openSession(name); } },
    st === 'idle' ? { label: 'Hibernate', disabled: ro, run: function () { dlgHibernateOne(name); } } : null,
    st === 'idle' ? { label: 'Rename session', disabled: ro, run: function () { dlgRenameSession(name); } } : null,
    { label: 'File into folder', disabled: ro, run: function () { dlgAdopt(name); } },
    { label: 'Delete session', danger: true, disabled: ro, run: function () { dlgDeleteUnfiled(name); } }
  ]);
}

/* ---------- modal framework ---------- */

const modals = [];

function closeAllModals() { while (modals.length) modals[modals.length - 1].close(); }

document.addEventListener('keydown', function (ev) {
  if (ev.key !== 'Escape') return;
  if (currentMenu) { closeMenu(); return; }
  if (modals.length) modals[modals.length - 1].close();
});

function modal(opts) {
  const lastFocus = document.activeElement;
  const errEl = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const bodyEl = h('div', { class: 'modal-body' });
  add(bodyEl, opts.body);
  const footEl = h('div', { class: 'modal-foot' });
  const card = h('form', { class: 'modal-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': opts.title },
    h('h2', { class: 'modal-title' }, opts.title), bodyEl, errEl, footEl);
  const back = h('div', { class: 'modal-back' }, card);

  const ctl = {
    card: card,
    close: function () {
      back.remove();
      const i = modals.indexOf(ctl);
      if (i >= 0) modals.splice(i, 1);
      if (lastFocus && lastFocus.isConnected && lastFocus.focus) { try { lastFocus.focus(); } catch (e) { /* gone */ } }
      if (S.sig !== stateSig()) setTimeout(render, 0);
    },
    error: function (m) { errEl.textContent = m || ''; errEl.hidden = !m; },
    busy: function (on) {
      card.classList.toggle('busy', !!on);
      for (const b of footEl.querySelectorAll('button')) b.disabled = !!on;
    },
    restoreFocus: null
  };

  function runner(fn) {
    return async function () {
      ctl.error('');
      ctl.busy(true);
      try { await fn(ctl); ctl.close(); }
      catch (e) { ctl.error(errText(e)); ctl.busy(false); }
    };
  }

  if (opts.cancel !== false) footEl.append(h('button', { class: 'btn', type: 'button', onclick: ctl.close }, opts.cancelLabel || 'Cancel'));
  for (const a of (opts.extra || [])) {
    if (!a) continue;
    footEl.append(h('button', { class: 'btn' + (a.danger ? ' danger' : ''), type: 'button', onclick: runner(a.run) }, a.label));
  }
  if (opts.onSubmit) footEl.append(h('button', { class: 'btn primary', type: 'submit' }, opts.submitLabel || 'Save'));

  card.addEventListener('submit', function (ev) {
    ev.preventDefault();
    if (opts.onSubmit) runner(opts.onSubmit)();
  });
  back.addEventListener('pointerdown', function (ev) { if (ev.target === back) ctl.close(); });

  $('#modal-root').append(back);
  modals.push(ctl);

  const focusEl = opts.focus || card.querySelector('input:not([type=radio]), select, textarea') || footEl.querySelector('.primary');
  if (focusEl) {
    let selection = null;
    const remember = function () {
      if (typeof focusEl.selectionStart === 'number') selection = [focusEl.selectionStart, focusEl.selectionEnd];
    };
    focusEl.addEventListener('select', remember);
    focusEl.addEventListener('input', remember);
    focusEl.addEventListener('keyup', remember);
    focusEl.addEventListener('blur', remember);
    ctl.restoreFocus = function () {
      if (!focusEl.isConnected) return;
      try { focusEl.focus({ preventScroll: true }); } catch (e) { focusEl.focus(); }
      if (selection && focusEl.setSelectionRange) {
        try { focusEl.setSelectionRange(selection[0], selection[1]); } catch (e) { /* non-text control */ }
      }
    };
  }
  if (focusEl) setTimeout(function () {
    try {
      focusEl.focus();
      if (focusEl.select && focusEl.type === 'text') focusEl.select();
      if (typeof focusEl.selectionStart === 'number') focusEl.dispatchEvent(new Event('select'));
    } catch (e) { /* ignore */ }
  }, 20);

  return ctl;
}

function field(labelText, control, hint) {
  return h('label', { class: 'field' },
    h('span', { class: 'field-label' }, labelText), control,
    hint ? h('span', { class: 'hint' }, hint) : null);
}

function group(labelText, control, hint) {
  return h('div', { class: 'field' },
    h('span', { class: 'field-label' }, labelText), control,
    hint ? h('span', { class: 'hint' }, hint) : null);
}

function kv(k, v) {
  return h('div', { class: 'kv' }, h('span', { class: 'k' }, k), h('span', { class: 'v' }, v));
}

const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

/* ---------- folder dialogs ---------- */

function dlgNewFolder(parentId) {
  const input = h('input', { class: 'inp', type: 'text', maxlength: '64', autocapitalize: 'off', spellcheck: 'false' });
  modal({
    title: 'New folder',
    body: [field('Name', input), h('p', { class: 'hint' }, 'In ' + pathOf(parentId))],
    submitLabel: 'Create',
    onSubmit: async function () {
      const name = input.value.trim();
      if (!name) throw new Error('Enter a name.');
      await api('POST', '/api/folders', { name: name, parent_id: parentId || null });
      await refreshState(true);
    }
  });
}

function dlgRename(n) {
  const input = h('input', { class: 'inp', type: 'text', maxlength: '64', value: n.name, autocapitalize: 'off', spellcheck: 'false' });
  modal({
    title: 'Rename folder',
    body: [field('Name', input)],
    submitLabel: 'Rename',
    onSubmit: async function () {
      const name = input.value.trim();
      if (!name) throw new Error('Enter a name.');
      if (name === n.name) return;
      await api('PATCH', '/api/nodes/' + encodeURIComponent(n.id), { name: name });
      await refreshState(true);
    }
  });
}

function dlgDeleteFolder(n) {
  const ids = descendantIds(n.id);
  let folders = 0, sessions = 0;
  for (const id of ids) {
    const d = nodeById(id);
    if (!d) continue;
    if (d.kind === 'folder') folders++; else sessions++;
  }
  const empty = ids.size === 0;
  const counts = folders + (folders === 1 ? ' folder' : ' folders') + ' and ' + sessions + (sessions === 1 ? ' session' : ' sessions');

  modal({
    title: 'Delete folder ' + n.name,
    body: [
      h('p', { class: 'modal-text' }, empty ? 'This folder is empty.' : 'This folder contains ' + counts + '.'),
      empty ? null : h('p', { class: 'hint' }, 'Move contents up keeps the sessions and puts everything in ' + pathOf(n.parent_id) + '. Delete contents destroys the real zellij sessions on the session host.')
    ],
    extra: empty ? [
      { label: 'Delete folder', danger: true, run: async function () {
        await api('DELETE', '/api/folders/' + encodeURIComponent(n.id) + '?mode=move_up');
        await refreshState(true);
      } }
    ] : [
      { label: 'Move contents up', run: async function () {
        await api('DELETE', '/api/folders/' + encodeURIComponent(n.id) + '?mode=move_up');
        await refreshState(true);
      } },
      { label: 'Delete contents and sessions', danger: true, run: async function () {
        await api('DELETE', '/api/folders/' + encodeURIComponent(n.id) + '?mode=delete_sessions');
        await refreshState(true);
      } }
    ]
  });
}

/* ---------- move and adopt ---------- */

function folderPicker(state, banned) {
  const list = h('div', { class: 'pick-list' });

  function row(id, label, depth) {
    const b = h('button', { class: 'pick' + (state.pid === id ? ' on' : ''), type: 'button', 'aria-pressed': state.pid === id ? 'true' : 'false' }, label);
    b.style.paddingLeft = (10 + depth * 16) + 'px';
    b.addEventListener('click', function () {
      state.pid = id;
      for (const el of list.querySelectorAll('.pick')) { el.classList.remove('on'); el.setAttribute('aria-pressed', 'false'); }
      b.classList.add('on');
      b.setAttribute('aria-pressed', 'true');
    });
    return b;
  }

  function walk(pid, depth) {
    for (const n of childrenOf(pid)) {
      if (n.kind !== 'folder') continue;
      if (banned && banned.has(n.id)) continue;
      list.append(row(n.id, n.name, depth));
      walk(n.id, depth + 1);
    }
  }

  list.append(row(null, 'Root', 0));
  walk(null, 1);
  return list;
}

function dlgMove(n) {
  const banned = descendantIds(n.id);
  banned.add(n.id);
  const state = { pid: n.parent_id || null };
  modal({
    title: 'Move ' + n.name,
    body: [group('Destination', folderPicker(state, banned))],
    submitLabel: 'Move',
    onSubmit: async function () {
      if ((state.pid || null) === (n.parent_id || null)) return;
      await api('PATCH', '/api/nodes/' + encodeURIComponent(n.id), { parent_id: state.pid || null, position: endPosition(state.pid || null) });
      if (state.pid) S.collapsed.delete(state.pid);
      persistView();
      await refreshState(true);
    }
  });
}

function dlgAdopt(sessionName) {
  const state = { pid: null };
  modal({
    title: 'File ' + sessionName,
    body: [group('Destination', folderPicker(state, null))],
    submitLabel: 'File',
    onSubmit: async function () {
      await api('POST', '/api/adopt', { session_name: sessionName, parent_id: state.pid || null });
      if (state.pid) S.collapsed.delete(state.pid);
      persistView();
      await refreshState(true);
    }
  });
}

/* ---------- session dialogs ---------- */

function renameOpenSession(oldName, newName) {
  if (S.active === oldName) S.active = newName;
  persistView();
}

function dlgRenameSession(oldName) {
  const input = h('input', {
    class: 'inp', type: 'text', maxlength: '64', value: oldName,
    autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false'
  });
  modal({
    title: 'Rename session',
    body: [
      field('Name', input, 'This renames the zellij session and the Claude Remote Control session.'),
      h('p', { class: 'hint' }, 'Claude must be waiting at its prompt so it can accept /rename.')
    ],
    focus: input,
    submitLabel: 'Rename',
    onSubmit: async function () {
      const newName = input.value.trim();
      if (!NAME_RE.test(newName)) throw new Error('Use letters, numbers, dot, dash or underscore, 1 to 64 characters.');
      if (newName === oldName) return;
      const result = await api('POST', '/api/sessions/rename', { old_name: oldName, new_name: newName });
      renameOpenSession(oldName, newName);
      await refreshState(true);
      toast('Session renamed to ' + newName + '.');
      return result;
    }
  });
}

function dlgDeleteLeaf(n) {
  modal({
    title: 'Delete session ' + n.session_name,
    body: [
      h('p', { class: 'modal-text' }, 'This destroys the zellij session ' + n.session_name + ' on the session host and removes the leaf from the tree.'),
      h('p', { class: 'hint' }, 'Anything running in its panes is stopped.')
    ],
    extra: [{ label: 'Delete session', danger: true, run: async function () {
      await api('DELETE', '/api/sessions/' + encodeURIComponent(n.id));
      closeSession(n.session_name);
      await refreshState(true);
    } }]
  });
}

function dlgDeleteUnfiled(name) {
  modal({
    title: 'Delete session ' + name,
    body: [
      h('p', { class: 'modal-text' }, 'This destroys the zellij session ' + name + ' on the session host.'),
      h('p', { class: 'hint' }, 'Anything running in its panes is stopped.')
    ],
    extra: [{ label: 'Delete session', danger: true, run: async function () {
      // DELETE /api/sessions takes a node id, and an unfiled session has no node yet,
      // so it is filed at the root first and the resulting leaf is deleted.
      const res = await api('POST', '/api/adopt', { session_name: name, parent_id: null });
      const id = res && res.node && res.node.id;
      if (!id) throw new Error('The server did not return a node for ' + name + '.');
      await api('DELETE', '/api/sessions/' + encodeURIComponent(id));
      closeSession(name);
      await refreshState(true);
    } }]
  });
}

function hibernatePreviewRows(rows) {
  if (!rows.length) return h('p', { class: 'modal-text' }, 'No sessions meet the hibernation conditions.');
  const list = h('div', { class: 'pick-list', 'aria-label': 'Sessions to hibernate' });
  for (const row of rows) {
    list.append(h('div', { class: 'pick' },
      h('strong', null, row.name),
      h('div', { class: 'hint' }, (row.lastActivityAt ? fmtAge(row.lastActivityAt) : 'No recorded activity') + '. ' + row.reason)
    ));
  }
  return list;
}

async function dlgHibernateOne(name) {
  let preview;
  try { preview = await api('GET', '/api/sessions/hibernate-preview'); }
  catch (e) { toast(errText(e), true); return; }
  const candidate = (preview.candidates || []).find(function (row) { return row.name === name; });
  if (!candidate) {
    const excluded = (preview.excluded || []).find(function (row) { return row.name === name; });
    toast(name + ' cannot hibernate: ' + (excluded?.reason || 'state changed') + '.', true);
    return;
  }
  modal({
    title: 'Hibernate ' + name,
    body: [h('p', { class: 'modal-text' }, 'This stops the session while preserving its Claude conversation for wake.'), hibernatePreviewRows([candidate])],
    extra: [{ label: 'Hibernate', run: async function () {
      await api('POST', '/api/sessions/' + encodeURIComponent(name) + '/hibernate', {});
      closeSession(name);
      await refreshState(true);
    } }]
  });
}

async function dlgHibernateIdle() {
  let preview;
  try { preview = await api('GET', '/api/sessions/hibernate-preview'); }
  catch (e) { toast(errText(e), true); return; }
  const candidates = preview.candidates || [];
  modal({
    title: 'Hibernate idle sessions',
    body: [
      h('p', { class: 'modal-text' }, candidates.length ? 'These sessions will be hibernated. Their conversations are preserved for wake.' : 'No sessions meet the hibernation conditions.'),
      hibernatePreviewRows(candidates)
    ],
    extra: candidates.length ? [{ label: 'Hibernate ' + candidates.length + (candidates.length === 1 ? ' session' : ' sessions'), run: async function () {
      const result = await api('POST', '/api/sessions/hibernate-idle', { names: candidates.map(function (row) { return row.name; }) });
      for (const item of result.hibernated || []) closeSession(item.name);
      await refreshState(true);
      if (result.skipped?.length) toast(result.skipped.length + ' session' + (result.skipped.length === 1 ? ' was' : 's were') + ' skipped because its state changed.');
    } }] : []
  });
}

function dlgRecreate(n) {
  modal({
    title: 'Create session ' + n.session_name,
    body: [
      h('p', { class: 'modal-text' }, 'This session is in the tree but is not running on the session host. It will be created with its stored settings.'),
      kv('Name', n.session_name),
      kv('Panes', String(n.panes || 1)),
      kv('Directory', n.workdir || '/workspace'),
      kv('Resume', n.resume_sid || 'none')
    ],
    submitLabel: 'Create session',
    onSubmit: async function () {
      await api('POST', '/api/sessions', {
        name: n.session_name,
        panes: Number(n.panes) || 1,
        workdir: n.workdir || '/workspace',
        resume_sid: n.resume_sid || null,
        parent_id: n.parent_id || null
      });
      await refreshState(true);
      openSession(n.session_name);
    }
  });
}

/* ---------- create session ---------- */

function transcriptSection(state) {
  const search = h('input', { class: 'inp', type: 'search', placeholder: 'Search', 'aria-label': 'Search transcripts' });
  const list = h('div', { class: 'tr-list' });
  const status = h('p', { class: 'hint' }, 'Loading transcripts.');
  let all = [];

  function option(sid, title, age) {
    const sel = state.sid === sid;
    const label = h('label', { class: 'tr' + (sel ? ' sel' : '') },
      h('input', { type: 'radio', name: 'resume-sid', value: sid || '', checked: sel }),
      h('span', { class: 'tr-main' },
        h('span', { class: 'tr-title' }, title),
        age ? h('span', { class: 'tr-age' }, age) : null)
    );
    label.addEventListener('change', function () {
      state.sid = sid;
      for (const el of list.querySelectorAll('.tr')) el.classList.remove('sel');
      label.classList.add('sel');
    });
    return label;
  }

  function draw() {
    clear(list);
    const q = search.value.trim().toLowerCase();
    list.append(option(null, 'None', ''));
    for (const t of all) {
      const title = String(t.title || t.sid || '');
      if (q && title.toLowerCase().indexOf(q) < 0 && String(t.sid || '').toLowerCase().indexOf(q) < 0) continue;
      list.append(option(t.sid, title, fmtAge(t.mtime)));
    }
  }

  search.addEventListener('input', draw);
  draw();

  api('GET', '/api/transcripts').then(function (d) {
    all = (d && Array.isArray(d.transcripts)) ? d.transcripts : [];
    status.textContent = all.length ? '' : 'No transcripts on the host.';
    status.hidden = !status.textContent;
    draw();
  }).catch(function (e) {
    status.textContent = 'Transcripts unavailable. ' + errText(e);
    status.hidden = false;
  });

  return h('div', { class: 'stack' }, search, list, status);
}

function dlgNewSession(parentId) {
  const nameInput = h('input', { class: 'inp', type: 'text', maxlength: '64', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' });
  const dirInput = h('input', { class: 'inp', type: 'text', value: '/workspace', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' });
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Pane count' });
  const resume = { sid: null };
  let panes = 1;

  for (const n of [1, 2, 3, 4]) {
    const b = h('button', { class: 'seg-btn' + (n === 1 ? ' on' : ''), type: 'button', 'aria-pressed': n === 1 ? 'true' : 'false' }, String(n));
    b.addEventListener('click', function () {
      panes = n;
      const kids = seg.children;
      for (let i = 0; i < kids.length; i++) {
        const on = (i + 1) === panes;
        kids[i].classList.toggle('on', on);
        kids[i].setAttribute('aria-pressed', on ? 'true' : 'false');
      }
    });
    seg.append(b);
  }

  modal({
    title: 'New session',
    body: [
      field('Name', nameInput, 'Letters, numbers, dot, dash and underscore. This is the zellij session name.'),
      group('Panes', seg),
      field('Working directory', dirInput),
      group('Resume a Claude conversation', transcriptSection(resume)),
      h('p', { class: 'hint' }, 'In ' + pathOf(parentId))
    ],
    focus: nameInput,
    submitLabel: 'Create session',
    onSubmit: async function () {
      const name = nameInput.value.trim();
      if (!NAME_RE.test(name)) throw new Error('Use letters, numbers, dot, dash or underscore, 1 to 64 characters.');
      const workdir = dirInput.value.trim() || '/workspace';
      if (workdir.charAt(0) !== '/') throw new Error('The working directory must be an absolute path.');
      await api('POST', '/api/sessions', {
        name: name,
        panes: panes,
        workdir: workdir,
        resume_sid: resume.sid || null,
        parent_id: parentId || null
      });
      if (parentId) { S.collapsed.delete(parentId); persistView(); }
      await refreshState(true);
      openSession(name);
    }
  });
}

/* ---------- drag and drop, pointer events so it works on touch ---------- */

const treeEl = $('#tree');

const drag = {
  pending: null, active: false, kind: null, id: null, name: '', label: '',
  row: null, ghost: null, pointerId: null, banned: null,
  lastX: 0, lastY: 0, target: null,
  holdTimer: null, scrollTimer: null, suppressClick: false
};

treeEl.addEventListener('pointerdown', function (ev) {
  if (ev.button !== 0) return;
  if (!canMutate()) return;
  if (ev.target.closest('button')) return;
  const row = ev.target.closest('.row');
  if (!row || row.dataset.drag !== '1') return;

  endDrag();
  drag.pending = { row: row, x: ev.clientX, y: ev.clientY, type: ev.pointerType, pointerId: ev.pointerId };
  drag.lastX = ev.clientX;
  drag.lastY = ev.clientY;
  if (ev.pointerType !== 'mouse') drag.holdTimer = setTimeout(startDrag, 320);
  document.addEventListener('pointermove', onDragMove, { passive: false });
  document.addEventListener('pointerup', onDragUp);
  document.addEventListener('pointercancel', onDragUp);
});

function onDragMove(ev) {
  drag.lastX = ev.clientX;
  drag.lastY = ev.clientY;

  if (!drag.active) {
    if (!drag.pending) return;
    const dx = Math.abs(ev.clientX - drag.pending.x), dy = Math.abs(ev.clientY - drag.pending.y);
    if (drag.pending.type === 'mouse') { if (dx + dy > 5) startDrag(); }
    else if (dx > 10 || dy > 10) endDrag();
    return;
  }
  if (ev.cancelable) ev.preventDefault();
  moveGhost(ev.clientX, ev.clientY);
  updateDropTarget(ev.clientX, ev.clientY);
}

function startDrag() {
  const p = drag.pending;
  if (!p || !p.row.isConnected) { endDrag(); return; }
  clearTimeout(drag.holdTimer);
  drag.holdTimer = null;

  const row = p.row;
  drag.active = true;
  drag.row = row;
  drag.kind = row.dataset.kind;
  drag.id = row.dataset.id || null;
  drag.name = row.dataset.name || '';
  drag.pointerId = p.pointerId;
  drag.banned = drag.id ? descendantIds(drag.id) : new Set();
  const nameEl = row.querySelector('.name');
  drag.label = nameEl ? nameEl.textContent : (drag.name || 'item');

  try { row.setPointerCapture(p.pointerId); } catch (e) { /* capture is best effort */ }
  row.classList.add('dz-src');
  document.documentElement.classList.add('dragging');
  drag.ghost = h('div', { class: 'ghost' }, drag.label);
  document.body.append(drag.ghost);
  moveGhost(drag.lastX, drag.lastY);
  updateDropTarget(drag.lastX, drag.lastY);
  if (navigator.vibrate) { try { navigator.vibrate(12); } catch (e) { /* no haptics */ } }
  drag.scrollTimer = setInterval(autoScroll, 40);
}

function moveGhost(x, y) {
  if (!drag.ghost) return;
  const gx = Math.min(Math.max(8, x + 12), window.innerWidth - 16);
  const gy = Math.min(Math.max(8, y - 16), window.innerHeight - 40);
  drag.ghost.style.transform = 'translate(' + gx + 'px,' + gy + 'px)';
}

function clearMarks() {
  for (const el of treeEl.querySelectorAll('.dz-into, .dz-before, .dz-after')) {
    el.classList.remove('dz-into', 'dz-before', 'dz-after');
  }
  treeEl.classList.remove('dz-root');
}

function updateDropTarget(x, y) {
  clearMarks();
  drag.target = null;

  const box = treeEl.getBoundingClientRect();
  if (x < box.left || x > box.right || y < box.top - 6 || y > box.bottom + 6) return;

  const under = document.elementFromPoint(x, y);
  const row = (under && under.closest) ? under.closest('.row') : null;

  if (!row || !treeEl.contains(row)) {
    if (dropAllowed({ mode: 'root' })) { drag.target = { mode: 'root' }; treeEl.classList.add('dz-root'); }
    return;
  }
  const kind = row.dataset.kind;
  if (kind === 'unfiled' || kind === 'section' || kind === 'recent') return;
  if (row === drag.row) return;

  const r = row.getBoundingClientRect();
  const rel = (y - r.top) / Math.max(1, r.height);
  const mode = (kind === 'folder')
    ? (rel < 0.28 ? 'before' : (rel > 0.72 ? 'after' : 'into'))
    : (rel < 0.5 ? 'before' : 'after');

  const t = { mode: mode, row: row, id: row.dataset.id };
  if (!dropAllowed(t)) return;

  drag.target = t;
  if (mode === 'into') row.classList.add('dz-into');
  else if (mode === 'before') row.classList.add('dz-before');
  else row.classList.add('dz-after');
}

function resolveDrop(t, selfId) {
  if (!t) return null;
  if (t.mode === 'root') return { parentId: null, position: endPosition(null) };
  if (t.mode === 'into') return { parentId: t.id, position: endPosition(t.id) };

  const target = nodeById(t.id);
  if (!target) return null;
  const parentId = target.parent_id || null;
  const sibs = childrenOf(parentId).filter(function (n) { return n.id !== selfId; });
  const idx = sibs.findIndex(function (n) { return n.id === t.id; });
  if (idx < 0) return { parentId: parentId, position: endPosition(parentId) };
  return { parentId: parentId, position: positionAt(sibs, t.mode === 'before' ? idx : idx + 1) };
}

function dropAllowed(t) {
  const d = resolveDrop(t, drag.id);
  if (!d) return false;
  if (drag.kind === 'unfiled') return true;
  if (!drag.id) return false;
  if (d.parentId === drag.id) return false;
  if (d.parentId && drag.banned && drag.banned.has(d.parentId)) return false;
  return true;
}

function autoScroll() {
  if (!drag.active) return;
  const box = treeEl.getBoundingClientRect();
  const margin = 46;
  let dy = 0;
  if (drag.lastY < box.top + margin) dy = -14;
  else if (drag.lastY > box.bottom - margin) dy = 14;
  if (!dy) return;
  const before = treeEl.scrollTop;
  treeEl.scrollTop += dy;
  if (treeEl.scrollTop !== before) updateDropTarget(drag.lastX, drag.lastY);
}

function onDragUp() {
  if (!drag.active) { endDrag(); return; }
  const snap = { kind: drag.kind, id: drag.id, name: drag.name, target: drag.target };
  endDrag();
  drag.suppressClick = true;
  setTimeout(function () { drag.suppressClick = false; }, 350);
  if (snap.target) applyDrop(snap);
  else render();
}

async function applyDrop(snap) {
  const d = resolveDrop(snap.target, snap.id);
  if (!d) { render(); return; }
  try {
    if (snap.kind === 'unfiled') {
      await api('POST', '/api/adopt', { session_name: snap.name, parent_id: d.parentId });
    } else {
      await api('PATCH', '/api/nodes/' + encodeURIComponent(snap.id), { parent_id: d.parentId, position: d.position });
    }
    if (d.parentId) { S.collapsed.delete(d.parentId); persistView(); }
  } catch (e) {
    if (e.status !== 401) toast(errText(e), true);
  }
  await refreshState(true);
}

function endDrag() {
  clearTimeout(drag.holdTimer);
  clearInterval(drag.scrollTimer);
  drag.holdTimer = null;
  drag.scrollTimer = null;

  if (drag.row) {
    drag.row.classList.remove('dz-src');
    if (drag.pointerId !== null) { try { drag.row.releasePointerCapture(drag.pointerId); } catch (e) { /* already gone */ } }
  }
  if (drag.ghost) drag.ghost.remove();
  clearMarks();
  document.documentElement.classList.remove('dragging');
  document.removeEventListener('pointermove', onDragMove, { passive: false });
  document.removeEventListener('pointerup', onDragUp);
  document.removeEventListener('pointercancel', onDragUp);

  drag.pending = null;
  drag.active = false;
  drag.row = null;
  drag.ghost = null;
  drag.pointerId = null;
  drag.target = null;
  drag.banned = null;
  drag.kind = null;
  drag.id = null;
  drag.name = '';
}

/* ---------- root actions and boot ---------- */

$('#new-folder-root').addEventListener('click', function () { dlgNewFolder(null); });
$('#new-session-root').addEventListener('click', function () { dlgNewSession(null); });
$('#hibernate-idle').addEventListener('click', dlgHibernateIdle);

(async function boot() {
  let authed = null;
  try {
    const res = await fetch('/api/me', { credentials: 'same-origin', headers: { accept: 'application/json' } });
    const d = await res.json().catch(function () { return null; });
    authed = !!(d && d.authenticated === true);
  } catch (e) {
    authed = null;
  }
  $('#boot').hidden = true;
  if (authed === true) enterApp();
  else showLogin(authed === null ? 'Cannot reach the server.' : '');
})();

})();
