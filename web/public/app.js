// fleet-web UI — vanilla ES module, no deps, no build step.
// Views: list (#/) and detail (#/s/<host>/<session_id>).

// The detail view has two modes: chat (conversation messages, markdown) and
// term (raw terminal capture). Both share one composer.

// Linkifying plain terminal text and rendering Claude markdown both live in
// markdown.js so there is a single, DOM-only (never innerHTML) implementation.
import { renderLinkified, renderMarkdown } from './markdown.js';

// ------------------------------------------------------------------ helpers

/** Build an element. Text is always set via textContent — never innerHTML with data. */
function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = String(v);
      else if (k === 'html') throw new Error('h(): html is not allowed');
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  for (const child of children.flat(3)) {
    if (child === null || child === undefined || child === false || child === '') continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

const STATUS_META = {
  waiting: { key: 'waiting', label: 'needs you' },
  busy: { key: 'busy', label: 'working' },
  idle: { key: 'idle', label: 'idle' },
  unknown: { key: 'unknown', label: 'unknown' },
};

function statusMeta(status) {
  return STATUS_META[String(status || '').toLowerCase()] || STATUS_META.unknown;
}

/** `ctx 62%` for a session's context usage (same bands as the CLI); null when unknown. */
function ctxBadge(c) {
  if (!c || !Number.isFinite(c.pct)) return null;
  const pct = Math.round(c.pct);
  const level = pct > 85 ? 'hot' : pct >= 60 ? 'warn' : 'low';
  const title = `${Math.round(c.used / 1000)}k / ${Math.round(c.window / 1000)}k tokens${c.model ? ` · ${c.model}` : ''}`;
  return h('span', { class: `row-ctx ctx-${level}`, text: `ctx ${pct}%`, title });
}

function relTime(ms, now = Date.now()) {
  const t = Number(ms);
  if (!Number.isFinite(t) || t <= 0) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const hr = Math.round(m / 60);
  if (hr < 48) return `${hr}h`;
  return `${Math.round(hr / 24)}d`;
}

const pad2 = (n) => String(n).padStart(2, '0');

/** "14:03", or day.month. plus the time ("3.7. 14:03") when the message is not from today. */
function clockTime(ms, now = Date.now()) {
  const t = Number(ms);
  if (!Number.isFinite(t) || t <= 0) return '';
  const d = new Date(t);
  const today = new Date(now);
  const hhmm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const sameDay =
    d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
  return sameDay ? hhmm : `${d.getDate()}.${d.getMonth() + 1}. ${hhmm}`;
}

/** CSS-safe host token for per-host badge colours. */
function hostClass(host) {
  // Stable per-name colour slot (host-c0..c3), whatever the host is called.
  let hash = 0;
  for (const ch of String(host || '')) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return `c${hash % 4}`;
}

/** Home-dir prefixes (macOS Users dir, Linux home dir) -> ~ */
function shortCwd(cwd) {
  const p = String(cwd || '').replace(/^\/(?:Users|home)\/[^/]+/, '~');
  // Truncate from the head: the tail of a path is the informative part.
  // (Done here rather than with CSS `direction: rtl`, which visually reorders segments.)
  return p.length <= 46 ? p : `…${p.slice(-45)}`;
}

function firstLine(text) {
  if (typeof text !== 'string') return '';
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t) return t;
  }
  return '';
}

/** The session's one title (`display_title` from the CLI; older CLIs: the name). */
function sessionTitle(s) {
  const t = typeof s?.display_title === 'string' ? s.display_title.trim() : '';
  return t || s?.name || '';
}

/** The line under the title: the first prompt. */
function sessionSubtitle(s) {
  const line = firstLine(s.title);
  return line.length > 240 ? `${line.slice(0, 240)}…` : line;
}

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : v;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, String(value));
    } catch {
      /* private mode / blocked storage — ignore */
    }
  },
};

// ---------------------------------------------------------------------- api

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

function isAbort(err) {
  return err && (err.name === 'AbortError' || err.code === 20);
}

async function api(path, { signal, method = 'GET', body } = {}) {
  const init = { method, signal, headers: {} };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch (err) {
    if (isAbort(err)) throw err;
    throw new ApiError('network unreachable', 0);
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) throw new ApiError((data && data.error) || `HTTP ${res.status}`, res.status);
  return data;
}

const enc = encodeURIComponent;
const sessionPath = (host, id, suffix) => `/api/hosts/${enc(host)}/sessions/${enc(id)}/${suffix}`;

// ------------------------------------------------------------------- toast

const toastEl = document.getElementById('toast');
let toastTimer = null;

function toast(message, kind = '') {
  if (!toastEl) return;
  toastEl.textContent = message;
  toastEl.className = `toast${kind ? ` is-${kind}` : ''}`;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.hidden = true;
  }, 2500);
}

// ------------------------------------------------------------------ poller

/**
 * setTimeout-chained poller — never overlaps, pauses while the document is hidden,
 * aborts the in-flight request when stopped (route change).
 */
function createPoller(fn, intervalMs) {
  let timer = null;
  let controller = null;
  let stopped = false;
  let running = false;
  let firstRun = true;

  function schedule() {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(tick, intervalMs);
  }

  async function tick() {
    if (stopped || running) return;
    clearTimeout(timer);
    // The very first fetch always runs, even in a backgrounded/prerendered tab,
    // so the view never sits on skeletons. After that, hidden means paused.
    if (!firstRun && document.visibilityState !== 'visible') {
      schedule();
      return;
    }
    firstRun = false;
    running = true;
    controller = new AbortController();
    try {
      await fn(controller.signal);
    } catch (err) {
      if (!isAbort(err)) console.warn('poll failed', err);
    } finally {
      running = false;
      schedule();
    }
  }

  function onVisible() {
    if (document.visibilityState === 'visible') refresh();
  }

  function refresh() {
    if (stopped) return;
    if (running && controller) controller.abort();
    running = false;
    clearTimeout(timer);
    timer = setTimeout(tick, 0);
  }

  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('pageshow', onVisible);

  return {
    start() {
      tick();
    },
    refresh,
    stop() {
      stopped = true;
      clearTimeout(timer);
      if (controller) controller.abort();
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pageshow', onVisible);
    },
  };
}

/** Keeps "updated Xs ago" honest without hammering the network. */
function createTicker(fn, ms = 1000) {
  const id = setInterval(fn, ms);
  return () => clearInterval(id);
}

// ----------------------------------------------------------------- app state

const appEl = document.getElementById('app');

/** Last fleet snapshot, so a reload paints the list instantly while the first poll runs. */
const SNAPSHOT_KEY = 'fleet.snapshot';
const SNAPSHOT_MAX_AGE_MS = 6 * 60 * 60 * 1000;
function loadFleetSnapshot() {
  try {
    const raw = store.get(SNAPSHOT_KEY, '');
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.fleet?.hosts) || !parsed.at) return null;
    if (Date.now() - parsed.at > SNAPSHOT_MAX_AGE_MS) return null; // too old to be useful
    return parsed;
  } catch {
    return null;
  }
}
const fleetSnapshot = loadFleetSnapshot();

const state = {
  fleet: fleetSnapshot ? fleetSnapshot.fleet : null, // last good { self, hosts }
  fleetAt: fleetSnapshot ? fleetSnapshot.at : 0,
  filter: store.get('fleet.filter', 'all'),
  search: '',
  termFont: Number(store.get('fleet.termFont', '12')) || 12,
  termLines: Number(store.get('fleet.termLines', '200')) || 200,
  detailMode: store.get('fleet.detailMode', 'chat') === 'term' ? 'term' : 'chat',
  chatFont: Number(store.get('fleet.chatFont', '15')) || 15,
  hideInterim: store.get('fleet.chatHideNotes', '0') === '1',
};

/** Record a fresh /api/fleet body (the server's `snapshotAt` is when it was built). */
function setFleet(data) {
  state.fleet = data;
  state.fleetAt = data?.snapshotAt || Date.now();
  store.set(SNAPSHOT_KEY, JSON.stringify({ fleet: data, at: state.fleetAt }));
}

const FILTERS = [
  { id: 'all', label: 'All', match: () => true },
  { id: 'waiting', label: 'Needs you', match: (s) => s.status === 'waiting' },
  { id: 'busy', label: 'Busy', match: (s) => s.status === 'busy' },
  { id: 'idle', label: 'Idle', match: (s) => s.status === 'idle' },
];

function findFilter(id) {
  return FILTERS.find((f) => f.id === id) || FILTERS[0];
}

function lookupSession(host, id) {
  const hosts = (state.fleet && state.fleet.hosts) || [];
  for (const hostEntry of hosts) {
    if (hostEntry.name !== host) continue;
    for (const s of hostEntry.sessions || []) {
      if (s.session_id === id) return s;
    }
  }
  return null;
}

// ------------------------------------------------------------------ list view

function createListView() {
  const statusEl = h('div', { class: 'hdr-note' });
  const newBtn = h(
    'button',
    { class: 'new-btn', type: 'button', 'aria-label': 'New session', title: 'New session', onclick: () => openNewSessionSheet() },
    '+',
  );
  const searchInput = h('input', {
    class: 'search',
    type: 'search',
    inputmode: 'search',
    autocomplete: 'off',
    autocorrect: 'off',
    autocapitalize: 'none',
    spellcheck: 'false',
    placeholder: 'Search name, title, cwd…',
    'aria-label': 'Search sessions',
  });
  searchInput.value = state.search;
  searchInput.addEventListener('input', () => {
    state.search = searchInput.value;
    renderBody();
  });

  const chipsEl = h('div', { class: 'chips', role: 'group', 'aria-label': 'Filter' });
  const chipButtons = new Map();
  for (const f of FILTERS) {
    const countEl = h('span', { class: 'count' });
    const btn = h(
      'button',
      {
        class: 'chip',
        type: 'button',
        'aria-pressed': String(state.filter === f.id),
        onclick: () => {
          state.filter = f.id;
          store.set('fleet.filter', f.id);
          for (const [id, b] of chipButtons) b.btn.setAttribute('aria-pressed', String(id === f.id));
          renderBody();
        },
      },
      f.label,
      countEl,
    );
    chipButtons.set(f.id, { btn, countEl });
    chipsEl.append(btn);
  }

  const listEl = h('main', { class: 'list' });

  const root = h(
    'div',
    { class: 'view-list' },
    h(
      'header',
      { class: 'hdr' },
      h(
        'div',
        { class: 'hdr-inner' },
        h('div', { class: 'hdr-top' }, h('h1', { class: 'hdr-title', text: 'Fleet' }), statusEl, newBtn),
        h('div', { class: 'search-wrap' }, searchInput),
        chipsEl,
      ),
    ),
    listEl,
  );

  let lastError = null;
  let refreshing = false;

  function matchesSearch(s) {
    const q = state.search.trim().toLowerCase();
    if (!q) return true;
    const hay = [s.display_title, s.name, s.gen_title, s.title, s.cwd, s.tmux_session, s.host]
      .filter((v) => typeof v === 'string')
      .join('\n')
      .toLowerCase();
    return hay.includes(q);
  }

  function renderStatus() {
    if (refreshing && !state.fleet) {
      statusEl.className = 'hdr-note';
      statusEl.textContent = 'loading…';
      return;
    }
    if (lastError) {
      statusEl.className = 'hdr-note is-error';
      statusEl.textContent = 'offline — retrying';
      return;
    }
    statusEl.className = 'hdr-note';
    if (refreshing) {
      statusEl.textContent = 'refreshing…';
      return;
    }
    statusEl.textContent = state.fleetAt ? `updated ${relTime(state.fleetAt)} ago` : '';
  }

  function sessionRow(s, now) {
    const meta = statusMeta(s.status);
    const label =
      meta.key === 'waiting' && typeof s.waiting_for === 'string' && s.waiting_for.trim()
        ? `${meta.label} · ${s.waiting_for.trim()}`
        : meta.label;
    const subtitle = sessionSubtitle(s);
    const cwd = shortCwd(s.cwd);
    const backend = String(s.backend || 'unknown');

    return h(
      'a',
      { class: 'row', href: `#/s/${enc(s.host)}/${enc(s.session_id)}` },
      h(
        'div',
        { class: 'row-top' },
        h('span', { class: `dot s-${meta.key}` }),
        h('span', { class: 'row-name', text: sessionTitle(s) || '(unnamed)' }),
        h('span', { class: `badge host host-${hostClass(s.host)}`, text: String(s.host) }),
        h('span', { class: `row-status t-${meta.key}`, text: label }),
      ),
      subtitle ? h('div', { class: 'row-title', text: subtitle }) : null,
      h(
        'div',
        { class: 'row-meta' },
        cwd ? h('span', { class: 'row-cwd', text: cwd }) : null,
        s.tmux_session ? h('span', { class: 'badge tmux', text: String(s.tmux_session) }) : null,
        backend !== 'unknown' ? h('span', { class: `badge ${backend}`, text: backend }) : null,
        ctxBadge(s.context),
        h('span', { class: 'row-time', text: relTime(s.updated_at, now) }),
      ),
    );
  }

  function renderBody() {
    renderStatus();

    if (!state.fleet) {
      clear(listEl);
      if (lastError) {
        listEl.append(h('div', { class: 'banner', text: `Could not reach fleet-web: ${lastError}` }));
      }
      for (let i = 0; i < 4; i += 1) listEl.append(h('div', { class: 'skel' }));
      for (const { countEl } of chipButtons.values()) countEl.textContent = '';
      return;
    }

    const hosts = state.fleet.hosts || [];
    const searched = [];
    for (const host of hosts) for (const s of host.sessions || []) if (matchesSearch(s)) searched.push(s);

    for (const f of FILTERS) {
      const entry = chipButtons.get(f.id);
      if (entry) entry.countEl.textContent = String(searched.filter(f.match).length);
    }

    const filter = findFilter(state.filter);
    const now = Date.now();

    clear(listEl);

    if (lastError) {
      listEl.append(h('div', { class: 'banner', text: `Refresh failed: ${lastError} — showing last known data` }));
    }

    // Unreachable hosts first, as banners — their sessions are simply absent below.
    for (const host of hosts) {
      if (host.ok === false) {
        listEl.append(h('div', { class: 'banner host-error', text: `${host.name} unreachable: ${host.error || 'no response'}` }));
      }
    }

    // One flat list across hosts, most recent activity first.
    const sessions = searched.filter((s) => filter.match(s)).sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
    const shown = sessions.length;
    if (shown > 0) {
      const rows = h('div', { class: 'rows' });
      for (const s of sessions) rows.append(sessionRow(s, now));
      listEl.append(rows);
    }

    if (shown === 0 && hosts.every((host) => host.ok !== false)) {
      listEl.append(h('div', { class: 'empty', text: 'Nothing matches.' }));
    }
  }

  const poller = createPoller(async (signal) => {
    refreshing = true;
    renderStatus();
    try {
      const data = await api('/api/fleet', { signal });
      setFleet(data);
      lastError = null;
    } catch (err) {
      if (isAbort(err)) throw err;
      lastError = err.message || 'request failed';
    } finally {
      refreshing = false;
    }
    renderBody();
  }, 5000);

  const stopTicker = createTicker(() => {
    if (!refreshing) renderStatus();
  }, 1000);

  renderBody();
  poller.start();

  return {
    el: root,
    destroy() {
      poller.stop();
      stopTicker();
    },
  };
}

// ---------------------------------------------------------------- detail view

// Text chips come from /api/settings (config `web.quickReplies`); keys are fixed.
let quickReplies = [
  { label: 'Continue', text: 'Continue.' },
  { label: 'Yes', text: 'Yes' },
  { label: 'No', text: 'No' },
  { label: '1', text: '1' },
  { label: '2', text: '2' },
];
const QUICK_KEYS = [
  { label: 'Esc', kind: 'key', value: 'Escape' },
  { label: '↵', kind: 'key', value: 'Enter' },
  { label: '↑', kind: 'key', value: 'Up' },
  { label: '↓', kind: 'key', value: 'Down' },
];
function quickActions() {
  return [...quickReplies.map((q) => ({ label: q.label, kind: 'text', value: q.text })), ...QUICK_KEYS];
}

const FONT_SIZES = [11, 12, 14];
const CHAT_FONT_SIZES = [13, 15, 17];
const CHAT_LIMITS = [60, 200, 500];
const GROUP_GAP_MS = 2 * 60 * 1000; // captions only on the last message of a burst

function peekErrorMessage(err) {
  if (!err) return '';
  if (err.status === 409) return "This session's backend can't be controlled from here";
  if (err.status === 404) return 'Session gone';
  if (err.status === 502 || err.status === 504) return 'host unreachable';
  if (err.status === 503) return 'session discovery failed on that host';
  if (err.status === 0) return 'network unreachable';
  return err.message || 'peek failed';
}

function createDetailView(host, id) {
  let sess = lookupSession(host, id);
  let peekText = null;
  let peekAt = 0;
  let peekErr = null;
  let backend = sess ? String(sess.backend || 'unknown') : null;
  let follow = true;
  let sending = false;
  let gone = false;

  // chat mode state
  let mode = state.detailMode;
  let messages = null; // last good array
  let chatAt = 0;
  let chatErr = null;
  let chatStatus = sess ? String(sess.status || 'unknown') : 'unknown';
  let chatLimit = CHAT_LIMITS[0];
  let chatTruncated = false;
  let chatFollow = true;
  let restoreAnchor = false; // set when "Load older" prepends messages

  // header ---------------------------------------------------------------
  const nameEl = h('div', { class: 'detail-name', text: sessionTitle(sess) || id.slice(0, 8) });
  const subEl = h('div', { class: 'detail-sub' });
  const backBtn = h(
    'button',
    {
      class: 'back',
      type: 'button',
      'aria-label': 'Back',
      onclick: () => {
        if (window.history.length > 1) window.history.back();
        else window.location.hash = '#/';
      },
    },
    '‹',
  );

  const fontBtnDown = h('button', { class: 'tool-btn', type: 'button', 'aria-label': 'Smaller text', onclick: () => bumpFont(-1) }, 'A-');
  const fontBtnUp = h('button', { class: 'tool-btn', type: 'button', 'aria-label': 'Larger text', onclick: () => bumpFont(1) }, 'A+');
  const linesBtn = h('button', {
    class: 'tool-btn',
    type: 'button',
    'aria-label': 'Toggle captured lines',
    onclick: () => {
      state.termLines = state.termLines >= 600 ? 200 : 600;
      store.set('fleet.termLines', state.termLines);
      linesBtn.textContent = String(state.termLines);
      peekText = null;
      refreshActive();
    },
  });
  linesBtn.textContent = String(state.termLines);

  function bumpFont(dir) {
    const sizes = mode === 'chat' ? CHAT_FONT_SIZES : FONT_SIZES;
    const key = mode === 'chat' ? 'chatFont' : 'termFont';
    const i = sizes.indexOf(state[key]);
    const next = sizes[Math.min(sizes.length - 1, Math.max(0, (i === -1 ? 1 : i) + dir))];
    state[key] = next;
    store.set(mode === 'chat' ? 'fleet.chatFont' : 'fleet.termFont', next);
    applyFont();
  }

  function applyFont() {
    termEl.style.fontSize = `${state.termFont}px`;
    chatEl.style.fontSize = `${state.chatFont}px`;
    const sizes = mode === 'chat' ? CHAT_FONT_SIZES : FONT_SIZES;
    const size = mode === 'chat' ? state.chatFont : state.termFont;
    fontBtnDown.disabled = size === sizes[0];
    fontBtnUp.disabled = size === sizes[sizes.length - 1];
    fontSizeEl.textContent = `${size}px`;
    if (mode === 'chat') {
      if (chatFollow) scrollChatToBottom();
    } else if (follow) scrollToBottom();
  }

  const modeButtons = new Map();
  const segEl = h('div', { class: 'seg', role: 'group', 'aria-label': 'View mode' });
  for (const m of [{ id: 'chat', label: 'Chat' }, { id: 'term', label: 'Term' }]) {
    const btn = h(
      'button',
      { class: 'seg-btn', type: 'button', 'aria-pressed': String(mode === m.id), onclick: () => setMode(m.id) },
      m.label,
    );
    modeButtons.set(m.id, btn);
    segEl.append(btn);
  }

  const notesBtn = h('button', {
    class: 'tool-btn',
    type: 'button',
    'aria-pressed': String(state.hideInterim),
    'aria-label': 'Hide progress notes',
    title: 'Hide progress notes',
    onclick: () => {
      state.hideInterim = !state.hideInterim;
      store.set('fleet.chatHideNotes', state.hideInterim ? '1' : '0');
      notesBtn.setAttribute('aria-pressed', String(state.hideInterim));
      syncNotesBtn();
      renderedChatKey = null;
      renderChat();
    },
  });
  function syncNotesBtn() {
    notesBtn.textContent = state.hideInterim ? 'Hidden' : 'Shown';
  }
  syncNotesBtn();

  // --- overflow menu (⋯): everything that used to crowd the header -------
  const fontSizeEl = h('span', { class: 'menu-value' });
  const menuRow = (label, ...controls) => h('div', { class: 'menu-row' }, h('span', { class: 'menu-label', text: label }), h('div', { class: 'menu-controls' }, ...controls));
  const notesRow = menuRow('Progress notes', notesBtn);
  const linesRow = menuRow('Lines', linesBtn);

  // Auto-name: run the `fleet name` pass on this session's host right now.
  let naming = false;
  const nameBtn = h('button', { class: 'tool-btn', type: 'button', 'aria-label': 'Name sessions now' }, 'Run now');
  nameBtn.addEventListener('click', async () => {
    if (naming) return;
    naming = true;
    nameBtn.disabled = true;
    nameBtn.textContent = 'Naming…';
    try {
      const res = await api(`/api/hosts/${enc(host)}/autoname`, { method: 'POST', body: {} });
      const n = res.renamed?.length || 0;
      toast(n ? `Renamed ${n}: ${res.renamed.map((r) => r.to).join(', ')}` : `Nothing to rename${res.held?.length ? ` (${res.held.length} busy)` : ''}`);
    } catch (err) {
      toast(err.message || 'Naming failed', 'error');
    } finally {
      naming = false;
      nameBtn.disabled = false;
      nameBtn.textContent = 'Run now';
    }
  });
  const nameRow = menuRow(`Auto-name (${host})`, nameBtn);

  // Close session: two taps. The first arms the button, the second kills Claude + its tmux.
  let closeArmed = false;
  let closeTimer = null;
  let closing = false;
  const closeBtn = h('button', { class: 'tool-btn danger', type: 'button', 'aria-label': 'Close session' }, 'Close…');
  function disarmClose() {
    closeArmed = false;
    clearTimeout(closeTimer);
    closeBtn.classList.remove('armed');
    closeBtn.textContent = 'Close…';
  }
  closeBtn.addEventListener('click', async () => {
    if (closing) return;
    if (!closeArmed) {
      closeArmed = true;
      closeBtn.classList.add('armed');
      closeBtn.textContent = 'Confirm close';
      closeTimer = setTimeout(disarmClose, 5000);
      return;
    }
    closing = true;
    clearTimeout(closeTimer);
    closeBtn.disabled = true;
    closeBtn.textContent = 'Closing…';
    try {
      const res = await api(sessionPath(host, id, 'kill'), { method: 'POST', body: {} });
      toast(`Closed ${res.name || id.slice(0, 8)} (${String(res.terminal || 'done').replace(/-/g, ' ')})`);
      setMenu(false);
      window.location.hash = '#/';
    } catch (err) {
      toast(err.message || 'Close failed', 'error');
      closing = false;
      closeBtn.disabled = false;
      disarmClose();
    }
  });
  const closeRow = menuRow('Close session', closeBtn);

  const menuEl = h(
    'div',
    { class: 'menu', role: 'menu', hidden: true },
    menuRow('View', segEl),
    notesRow,
    menuRow('Text size', fontBtnDown, fontSizeEl, fontBtnUp),
    linesRow,
    nameRow,
    closeRow,
  );
  let menuOpen = false;
  function setMenu(open) {
    menuOpen = open;
    menuEl.hidden = !open;
    menuBtn.setAttribute('aria-expanded', String(open));
    if (!open && !closing) disarmClose();
  }
  const menuBtn = h(
    'button',
    { class: 'tool-btn menu-btn', type: 'button', 'aria-label': 'More', 'aria-haspopup': 'menu', 'aria-expanded': 'false', onclick: (e) => { e.stopPropagation(); setMenu(!menuOpen); } },
    '⋯',
  );
  menuEl.addEventListener('click', (e) => e.stopPropagation());
  const onDocClick = () => { if (menuOpen) setMenu(false); };
  const onDocKey = (e) => { if (e.key === 'Escape' && menuOpen) setMenu(false); };
  document.addEventListener('click', onDocClick);
  document.addEventListener('keydown', onDocKey);

  const header = h(
    'header',
    { class: 'detail-hdr' },
    h(
      'div',
      { class: 'detail-hdr-row' },
      backBtn,
      h('div', { class: 'detail-ident' }, nameEl, subEl),
      h('div', { class: 'detail-tools' }, menuBtn),
    ),
    menuEl,
  );

  // terminal --------------------------------------------------------------
  const termEl = h('pre', { class: 'term', tabindex: '0', 'aria-label': 'Terminal output' });
  const errEl = h('div', { class: 'term-err', hidden: true });
  const latestBtn = h(
    'button',
    {
      class: 'latest-btn',
      type: 'button',
      hidden: true,
      onclick: () => {
        follow = true;
        latestBtn.hidden = true;
        scrollToBottom();
      },
    },
    '↓ latest',
  );
  const termWrap = h('div', { class: 'term-wrap' }, termEl, errEl, latestBtn);

  function scrollToBottom() {
    termEl.scrollTop = termEl.scrollHeight;
  }

  termEl.addEventListener('scroll', () => {
    const distance = termEl.scrollHeight - termEl.scrollTop - termEl.clientHeight;
    if (distance > 40) {
      if (follow) {
        follow = false;
        latestBtn.hidden = false;
      }
    } else if (!follow) {
      follow = true;
      latestBtn.hidden = true;
    }
  }, { passive: true });

  // chat ------------------------------------------------------------------
  const olderBtn = h(
    'button',
    {
      class: 'older-btn',
      type: 'button',
      onclick: () => {
        const next = CHAT_LIMITS.find((n) => n > chatLimit);
        if (!next) return;
        chatLimit = next;
        restoreAnchor = true;
        olderBtn.disabled = true;
        olderBtn.textContent = 'loading…';
        refreshActive();
      },
    },
    '↑ Load older',
  );
  const olderWrap = h('div', { class: 'chat-older', hidden: true }, olderBtn);
  const chatListEl = h('div', { class: 'chat-list' });
  const typingEl = h('div', { class: 'chat-typing', hidden: true });
  const chatEl = h('div', { class: 'chat', tabindex: '0', 'aria-label': 'Conversation' }, olderWrap, chatListEl, typingEl);
  const chatErrEl = h('div', { class: 'term-err', hidden: true });
  const chatLatestBtn = h(
    'button',
    {
      class: 'latest-btn',
      type: 'button',
      hidden: true,
      onclick: () => {
        chatFollow = true;
        chatLatestBtn.hidden = true;
        scrollChatToBottom();
      },
    },
    '↓ latest',
  );
  const chatWrap = h('div', { class: 'chat-wrap' }, chatEl, chatErrEl, chatLatestBtn);

  // Rebuilding the list momentarily collapses scrollHeight, so the browser
  // clamps scrollTop and fires a scroll event that must not be read as "the
  // user moved". Remember where we put the scroller ourselves and ignore the
  // echo — any other position is a real gesture.
  let selfScrollTop = -1;

  function setChatTop(top) {
    chatEl.scrollTop = top;
    selfScrollTop = Math.round(chatEl.scrollTop);
  }

  function scrollChatToBottom() {
    setChatTop(chatEl.scrollHeight);
  }

  chatEl.addEventListener('scroll', () => {
    if (Math.round(chatEl.scrollTop) === selfScrollTop) return;
    selfScrollTop = -1;
    const distance = chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight;
    if (distance > 60) {
      if (chatFollow) {
        chatFollow = false;
        chatLatestBtn.hidden = false;
      }
    } else if (!chatFollow) {
      chatFollow = true;
      chatLatestBtn.hidden = true;
    }
  }, { passive: true });

  const msgKind = (m) => String((m && (m.kind || m.role)) || 'assistant');

  /** Same speaker, close in time → one caption for the whole burst. */
  function sameGroup(a, b) {
    if (!a || !b) return false;
    const ka = msgKind(a);
    if (ka !== msgKind(b)) return false;
    if (ka === 'command' || ka === 'system') return false;
    const ta = Number(a.ts);
    const tb = Number(b.ts);
    if (!Number.isFinite(ta) || !Number.isFinite(tb) || ta <= 0 || tb <= 0) return false;
    return Math.abs(tb - ta) <= GROUP_GAP_MS;
  }

  function visibleMessages() {
    const list = Array.isArray(messages) ? messages : [];
    return state.hideInterim ? list.filter((m) => !(m.role === 'assistant' && m.final === false)) : list;
  }

  function bubble(m, showCaption, now) {
    const kind = msgKind(m);
    const time = clockTime(m.ts, now);
    const text = typeof m.text === 'string' ? m.text : '';
    const cap = showCaption && time ? h('div', { class: 'cap', text: time }) : null;

    if (kind === 'command') return h('div', { class: 'chat-mid' }, h('span', { class: 'chat-cmd', text }));
    if (kind === 'system') return h('div', { class: 'chat-mid' }, h('span', { class: 'chat-sys', text }));
    if (kind === 'user') {
      return h('div', { class: 'chat-row is-user' }, h('div', { class: 'bubble is-user', text }), cap);
    }
    const interim = m.final === false;
    const body = h('div', { class: interim ? 'note' : 'bubble is-claude' });
    renderMarkdown(body, text);
    return h('div', { class: `chat-row is-claude${interim ? ' is-interim' : ''}` }, body, cap);
  }

  function renderTyping() {
    if (mode !== 'chat') return;
    if (chatStatus === 'busy') {
      typingEl.hidden = false;
      if (!typingEl.classList.contains('is-busy')) {
        clear(typingEl);
        typingEl.className = 'chat-typing is-busy';
        typingEl.append(
          h('span', { class: 'dots' }, h('i'), h('i'), h('i')),
          h('span', { text: 'Claude is working…' }),
        );
      }
    } else if (chatStatus === 'waiting') {
      typingEl.hidden = false;
      if (!typingEl.classList.contains('is-waiting')) {
        clear(typingEl);
        typingEl.className = 'chat-typing is-waiting';
        typingEl.append(h('span', { text: '⚑ needs you — Claude is waiting for an answer' }));
      }
    } else {
      typingEl.hidden = true;
      typingEl.className = 'chat-typing';
    }
    if (chatFollow) scrollChatToBottom();
  }

  // Diff-aware: rebuild only when the message payload (or the filter) changed,
  // so scroll position survives a poll.
  let renderedChatKey = null;

  function renderChat() {
    if (mode !== 'chat') return;
    const errKey = chatErr ? String(chatErr.status || chatErr.message || 'err') : '';
    const key = `${state.hideInterim ? 1 : 0}|${errKey}|${messages === null ? 'null' : JSON.stringify(messages)}`;
    renderTyping();
    olderWrap.hidden = !(chatTruncated && chatLimit < CHAT_LIMITS[CHAT_LIMITS.length - 1]);
    if (!olderWrap.hidden) {
      olderBtn.disabled = false;
      olderBtn.textContent = '↑ Load older';
    }
    if (key === renderedChatKey) return;
    renderedChatKey = key;

    const prevTop = chatEl.scrollTop;
    const prevHeight = chatEl.scrollHeight;
    clear(chatListEl);

    if (messages === null) {
      chatListEl.append(
        h('div', { class: 'chat-empty', text: chatErr && chatErr.status === 404 ? 'No transcript for this session yet' : 'loading…' }),
      );
      return;
    }
    const list = visibleMessages();
    if (list.length === 0) {
      chatListEl.append(
        h('div', {
          class: 'chat-empty',
          text: messages.length ? 'Only progress notes here — unhide them with ···' : 'No messages yet',
        }),
      );
      return;
    }
    const now = Date.now();
    for (let i = 0; i < list.length; i += 1) {
      chatListEl.append(bubble(list[i], !sameGroup(list[i], list[i + 1]), now));
    }
    if (restoreAnchor) {
      // older messages were prepended — keep the same message under the thumb
      restoreAnchor = false;
      chatFollow = false;
      chatLatestBtn.hidden = false;
      setChatTop(prevTop + (chatEl.scrollHeight - prevHeight));
    } else if (chatFollow) {
      scrollChatToBottom();
    } else {
      setChatTop(prevTop);
    }
  }

  function renderChatError() {
    if (!chatErr || (chatErr.status === 404 && messages === null)) {
      chatErrEl.hidden = true;
      return;
    }
    chatErrEl.hidden = false;
    chatErrEl.textContent = chatErr.status === 404 ? 'No transcript for this session yet' : peekErrorMessage(chatErr);
  }

  // composer --------------------------------------------------------------
  const textarea = h('textarea', {
    class: 'compose-input',
    rows: '1',
    placeholder: 'Message for Claude…',
    'aria-label': 'Message',
    autocapitalize: 'sentences',
    autocomplete: 'off',
    spellcheck: 'false',
  });
  const sendBtn = h('button', { class: 'send-btn', type: 'button', disabled: true }, 'Send');
  const quickEl = h('div', { class: 'quick' });
  const noteEl = h('div', { class: 'composer-note', hidden: true });
  const composer = h('form', { class: 'composer' }, quickEl, h('div', { class: 'compose-row' }, textarea, sendBtn), noteEl);
  composer.addEventListener('submit', (e) => e.preventDefault());

  const quickButtons = [];
  for (const action of quickActions()) {
    const btn = h(
      'button',
      {
        class: `qchip${action.kind === 'key' ? ' key' : ''}`,
        type: 'button',
        onclick: () => (action.kind === 'key' ? doSendKey(action.value) : doSend(action.value, false)),
      },
      action.label,
    );
    quickButtons.push(btn);
    quickEl.append(btn);
  }

  function autoGrow() {
    textarea.style.height = 'auto';
    const max = 21 * 5 + 24; // ~5 rows + padding
    textarea.style.height = `${Math.min(max, Math.max(44, textarea.scrollHeight))}px`;
  }

  textarea.addEventListener('input', () => {
    autoGrow();
    syncComposer();
  });

  // Hardware keyboards send on Enter; touch keyboards must keep Enter as newline.
  const isTouch = navigator.maxTouchPoints > 0;
  textarea.addEventListener('keydown', (e) => {
    if (isTouch) return;
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      doSend(textarea.value, true);
    }
  });

  sendBtn.addEventListener('click', () => doSend(textarea.value, true));

  function composerLocked() {
    return gone || backend === 'unknown';
  }

  function syncComposer() {
    const locked = composerLocked();
    composer.classList.toggle('is-disabled', locked);
    const empty = textarea.value.trim().length === 0;
    sendBtn.disabled = locked || sending || empty;
    sendBtn.textContent = sending ? '…' : 'Send';
    textarea.disabled = locked;
    for (const b of quickButtons) b.disabled = locked || sending;
    if (locked) {
      noteEl.hidden = false;
      noteEl.textContent = gone ? 'Session is gone — nothing to steer.' : "Backend is unknown — this session can't be steered.";
    } else {
      noteEl.hidden = true;
    }
  }

  async function doSend(rawText, fromTextarea) {
    const text = String(rawText || '');
    if (sending || composerLocked() || text.trim().length === 0) return;
    sending = true;
    syncComposer();
    try {
      await api(sessionPath(host, id, 'send'), { method: 'POST', body: { text } });
      if (fromTextarea) {
        textarea.value = '';
        autoGrow();
      }
      toast('sent ✓', 'ok');
      // jump back to the bottom so the new bubble / prompt is visible
      follow = true;
      chatFollow = true;
      chatLatestBtn.hidden = true;
      latestBtn.hidden = true;
      scheduleRefresh(800);
      scheduleRefresh(2000);
    } catch (err) {
      if (!isAbort(err)) {
        if (err.status === 404) gone = true;
        toast(peekErrorMessage(err), 'error');
      }
    } finally {
      sending = false;
      syncComposer();
    }
  }

  async function doSendKey(key) {
    if (sending || composerLocked()) return;
    sending = true;
    syncComposer();
    try {
      await api(sessionPath(host, id, 'keys'), { method: 'POST', body: { key } });
      toast(`${key} ✓`, 'ok');
      scheduleRefresh(800);
      scheduleRefresh(2000);
    } catch (err) {
      if (!isAbort(err)) {
        if (err.status === 404) gone = true;
        toast(peekErrorMessage(err), 'error');
      }
    } finally {
      sending = false;
      syncComposer();
    }
  }

  const followUpTimers = new Set();
  function scheduleRefresh(delay) {
    const t = setTimeout(() => {
      followUpTimers.delete(t);
      refreshActive();
    }, delay);
    followUpTimers.add(t);
  }

  // render ----------------------------------------------------------------
  function renderHeader() {
    const meta = statusMeta(sess ? sess.status : gone ? 'unknown' : 'unknown');
    if (sessionTitle(sess)) nameEl.textContent = sessionTitle(sess);
    clear(subEl);
    subEl.append(h('span', { text: host }));
    subEl.append(
      h('span', { class: `pill t-${meta.key}` }, h('span', { class: `dot s-${meta.key}` }), gone ? 'gone' : meta.label),
    );
    if (backend) subEl.append(h('span', { class: `badge ${backend}`, text: backend }));
    const age = mode === 'chat' ? chatAt : peekAt;
    subEl.append(h('span', { class: 'term-age', text: age ? `updated ${relTime(age)} ago` : 'connecting…' }));
  }

  // Diff-aware: only touch the DOM when the captured text actually changed,
  // so scroll position and text selection survive a poll.
  let renderedText = null;

  function renderTerm() {
    if (peekText === null) {
      if (renderedText !== '') {
        renderedText = '';
        termEl.textContent = peekErr ? '' : 'loading…';
      }
      return;
    }
    if (renderedText === peekText) return;
    const prevTop = termEl.scrollTop;
    renderedText = peekText;
    renderLinkified(termEl, peekText);
    if (follow) scrollToBottom();
    else termEl.scrollTop = prevTop;
  }

  function renderError() {
    if (!peekErr) {
      errEl.hidden = true;
      return;
    }
    errEl.hidden = false;
    errEl.textContent = peekErrorMessage(peekErr);
  }

  // polling ---------------------------------------------------------------
  // Exactly one mode loop runs at a time: switching Chat/Term stops the other,
  // which aborts its in-flight request and unhooks its visibility listeners.
  let poller = null;

  function refreshActive() {
    if (poller) poller.refresh();
  }

  function makePeekPoller() {
    return createPoller(async (signal) => {
      try {
        const data = await api(`${sessionPath(host, id, 'peek')}?lines=${state.termLines}`, { signal });
        peekText = typeof data.text === 'string' ? data.text : '';
        peekAt = data.capturedAt || Date.now();
        backend = String(data.backend || backend || 'unknown');
        peekErr = null;
        gone = false;
      } catch (err) {
        if (isAbort(err)) throw err;
        peekErr = err;
        if (err.status === 404) gone = true;
        if (err.status === 409) backend = 'unknown';
      }
      renderHeader();
      renderTerm();
      renderError();
      syncComposer();
    }, 2000);
  }

  function makeChatPoller() {
    return createPoller(async (signal) => {
      try {
        const data = await api(`${sessionPath(host, id, 'messages')}?limit=${chatLimit}`, { signal });
        messages = Array.isArray(data.messages) ? data.messages : [];
        chatTruncated = data.truncated === true;
        chatStatus = String(data.status || 'unknown');
        if (data.backend && (!backend || backend === 'unknown')) backend = String(data.backend);
        chatAt = data.capturedAt || Date.now();
        chatErr = null;
        gone = false;
      } catch (err) {
        if (isAbort(err)) throw err;
        // 404 here means "no transcript on disk", not "session is gone"
        chatErr = err;
      }
      renderHeader();
      renderChat();
      renderChatError();
      syncComposer();
    }, 3000);
  }

  /** Swap modes: stop the other loop, swap the DOM, start the new loop. */
  function setMode(next) {
    const wanted = next === 'term' ? 'term' : 'chat';
    if (wanted === mode && poller) return;
    mode = wanted;
    state.detailMode = wanted;
    store.set('fleet.detailMode', wanted);
    for (const [key, btn] of modeButtons) btn.setAttribute('aria-pressed', String(key === wanted));
    if (poller) {
      poller.stop();
      poller = null;
    }
    linesRow.hidden = wanted === 'chat';
    notesRow.hidden = wanted !== 'chat';
    setMenu(false);
    if (wanted === 'chat') {
      if (termWrap.parentNode) termWrap.remove();
      if (!chatWrap.parentNode) root.insertBefore(chatWrap, composer);
      renderedChatKey = null;
      chatFollow = true;
      renderChat();
      renderChatError();
      poller = makeChatPoller();
    } else {
      if (chatWrap.parentNode) chatWrap.remove();
      if (!termWrap.parentNode) root.insertBefore(termWrap, composer);
      renderedText = null;
      follow = true;
      renderTerm();
      renderError();
      poller = makePeekPoller();
    }
    applyFont();
    renderHeader();
    poller.start();
  }

  // keep the status pill / name fresh without a second fast loop
  const metaPoller = createPoller(async (signal) => {
    try {
      const data = await api('/api/fleet', { signal });
      setFleet(data);
      const found = lookupSession(host, id);
      if (found) {
        sess = found;
        // fallback for older servers whose /messages lacks `backend`
        if (!backend || backend === 'unknown') backend = String(found.backend || 'unknown');
        if (mode === 'chat') chatStatus = String(found.status || chatStatus);
      }
      renderHeader();
      if (mode === 'chat') renderTyping();
      syncComposer();
    } catch (err) {
      if (isAbort(err)) throw err;
    }
  }, 10000);

  const stopTicker = createTicker(renderHeader, 1000);

  const root = h('div', { class: 'detail' }, header, composer);

  renderHeader();
  syncComposer();
  setMode(mode); // mounts the active pane, applies the font, starts the one loop
  metaPoller.start();

  return {
    el: root,
    destroy() {
      if (poller) poller.stop();
      metaPoller.stop();
      stopTicker();
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('keydown', onDocKey);
      clearTimeout(closeTimer);
      for (const t of followUpTimers) clearTimeout(t);
      followUpTimers.clear();
    },
  };
}

// ------------------------------------------------------- new session sheet

let sheetEl = null;
let spawnWatch = null; // { host, name, timer, deadline }

function closeSheet() {
  if (sheetEl) sheetEl.remove();
  sheetEl = null;
}

function hostsForSpawn() {
  const hosts = (state.fleet && state.fleet.hosts) || [];
  return hosts.filter((x) => x.ok !== false).map((x) => ({ name: x.name, dirs: Array.isArray(x.spawnDirs) ? x.spawnDirs : [] }));
}

function openNewSessionSheet() {
  closeSheet();
  const hosts = hostsForSpawn();
  if (hosts.length === 0) {
    toast('No reachable host to start a session on', 'error');
    return;
  }
  let host = store.get('fleet.spawnHost', hosts[0].name);
  if (!hosts.some((x) => x.name === host)) host = hosts[0].name;

  const hostSeg = h('div', { class: 'seg seg-wide', role: 'group', 'aria-label': 'Host' });
  const hostBtns = new Map();
  const dirSeg = h('div', { class: 'seg seg-wide', role: 'radiogroup', 'aria-label': 'Directory' });
  let dir = '';
  const nameInput = h('input', { class: 'field', type: 'text', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', placeholder: 'auto (fw-hhmmss)', maxlength: '40' });
  const promptInput = h('textarea', { class: 'field field-area', rows: '3', placeholder: 'First prompt (optional)…' });
  const errEl = h('div', { class: 'sheet-err', hidden: true });

  function pickHost(name) {
    host = name;
    store.set('fleet.spawnHost', name);
    for (const [k, b] of hostBtns) b.setAttribute('aria-pressed', String(k === name));
    const dirs = (hosts.find((x) => x.name === name) || {}).dirs || [];
    const remembered = store.get(`fleet.spawnDirLabel.${name}`, '');
    const initial = dirs.find((d) => d.label === remembered) || dirs[0];
    clear(dirSeg);
    dir = initial ? initial.path : '';
    for (const d of dirs) {
      const b = h(
        'button',
        { class: 'seg-btn', type: 'button', role: 'radio', 'aria-checked': String(d === initial), title: d.path, onclick: () => pickDir(d) },
        d.label,
      );
      dirSeg.append(b);
    }
  }
  function pickDir(d) {
    dir = d.path;
    store.set(`fleet.spawnDirLabel.${host}`, d.label);
    for (const b of dirSeg.children) b.setAttribute('aria-checked', String(b.title === d.path));
  }
  for (const x of hosts) {
    const b = h('button', { class: 'seg-btn', type: 'button', 'aria-pressed': 'false', onclick: () => pickHost(x.name) }, x.name);
    hostBtns.set(x.name, b);
    hostSeg.append(b);
  }
  pickHost(host);

  let busy = false;
  const startBtn = h('button', { class: 'send-btn', type: 'button' }, 'Start');
  startBtn.addEventListener('click', async () => {
    if (busy) return;
    if (!dir) {
      errEl.textContent = 'This host advertises no directories.';
      errEl.hidden = false;
      return;
    }
    busy = true;
    startBtn.disabled = true;
    startBtn.textContent = 'Starting…';
    errEl.hidden = true;
    try {
      const res = await api(`/api/hosts/${enc(host)}/spawn`, {
        method: 'POST',
        body: { name: nameInput.value.trim() || undefined, dir, prompt: promptInput.value },
      });
      closeSheet();
      toast(`Starting ${res.name} on ${host}…`);
      watchForSpawned(host, res.name);
    } catch (err) {
      errEl.textContent = err.message || 'Failed to start';
      errEl.hidden = false;
      busy = false;
      startBtn.disabled = false;
      startBtn.textContent = 'Start';
    }
  });

  const field = (label, control) => h('label', { class: 'sheet-field' }, h('span', { class: 'sheet-label', text: label }), control);
  const card = h(
    'div',
    { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'New session' },
    h('div', { class: 'sheet-hdr' }, h('div', { class: 'sheet-title', text: 'New session' }), h('button', { class: 'tool-btn', type: 'button', 'aria-label': 'Close', onclick: closeSheet }, '✕')),
    field('Host', hostSeg),
    field('Directory', dirSeg),
    field('Name', nameInput),
    field('Prompt', promptInput),
    errEl,
    h('div', { class: 'sheet-actions' }, h('button', { class: 'tool-btn', type: 'button', onclick: closeSheet }, 'Cancel'), startBtn),
    h('div', { class: 'composer-note', text: 'Starts a new tmux session with Claude in it. A first-time folder trust prompt is accepted for you.' }),
  );
  card.addEventListener('click', (e) => e.stopPropagation());
  sheetEl = h('div', { class: 'sheet-backdrop', onclick: closeSheet }, card);
  document.body.append(sheetEl);
  promptInput.focus();
}

/** Poll the fleet until the freshly spawned session registers, then open it. */
function watchForSpawned(host, name) {
  if (spawnWatch) clearTimeout(spawnWatch.timer);
  const deadline = Date.now() + 45000;
  const tick = async () => {
    try {
      const data = await api('/api/fleet');
      setFleet(data);
      const hostEntry = (data.hosts || []).find((x) => x.name === host);
      const found = (hostEntry?.sessions || []).find((s) => s.tmux_session === name || s.name === name);
      if (found) {
        spawnWatch = null;
        toast(`${name} is up`);
        window.location.hash = `#/s/${enc(host)}/${enc(found.session_id)}`;
        return;
      }
    } catch {
      /* keep trying */
    }
    if (Date.now() > deadline) {
      spawnWatch = null;
      toast(`${name} has not shown up yet — check the list in a moment`, 'error');
      return;
    }
    spawnWatch = { host, name, timer: setTimeout(tick, 1500), deadline };
  };
  spawnWatch = { host, name, timer: setTimeout(tick, 1500), deadline };
}

// ------------------------------------------------------------------- router

let current = null;

function parseRoute() {
  const raw = window.location.hash.replace(/^#/, '');
  const parts = raw.split('/').filter(Boolean);
  if (parts[0] === 's' && parts[1] && parts[2]) {
    return { name: 'detail', host: decodeURIComponent(parts[1]), id: decodeURIComponent(parts[2]) };
  }
  return { name: 'list' };
}

function render() {
  const route = parseRoute();
  if (current) {
    current.destroy();
    current = null;
  }
  clear(appEl);
  const view = route.name === 'detail' ? createDetailView(route.host, route.id) : createListView();
  current = view;
  appEl.classList.toggle('is-detail', route.name === 'detail');
  appEl.append(view.el);
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', render);

/**
 * iOS Safari: 100dvh does not shrink for the software keyboard, visualViewport does.
 * Keep --app-h in sync so the composer stays above the keyboard.
 */
function syncViewportHeight() {
  const vv = window.visualViewport;
  const height = vv ? vv.height : window.innerHeight;
  document.documentElement.style.setProperty('--app-h', `${Math.round(height)}px`);
}

if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', syncViewportHeight);
  window.visualViewport.addEventListener('scroll', syncViewportHeight);
}
window.addEventListener('resize', syncViewportHeight);
window.addEventListener('orientationchange', syncViewportHeight);
syncViewportHeight();

// Load UI settings once; render regardless of whether that works.
api('/api/settings')
  .then((data) => {
    if (Array.isArray(data?.quickReplies)) {
      quickReplies = data.quickReplies.filter((q) => q && typeof q.text === 'string' && q.text);
    }
  })
  .catch(() => {})
  .finally(render);
