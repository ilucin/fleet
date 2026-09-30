// Session stacks, the web side (docs/architecture.md → Session stacks). A stack is N Claude
// sessions sharing one markdown file, the StackBrief; the `fleet` CLI owns it entirely
// (`fleet --local stack … --json`, lib/fleet-cli.mjs). The server never parses the markdown: it
// passes the CLI's JSON (StackView) through, adds `editorUrl` on the serving side, spawns
// siblings with its own spawner and, in the background, adds the new session to the stack once
// it has registered and keeps membership in sync (`stack sync`).
import { promises as fs } from 'node:fs';
import os from 'node:os';

import { HttpError } from './http.mjs';
import { editorUrl } from './editor.mjs';
import { expandHome } from './config.mjs';
import { isWithin, resolveAllowedDir } from './spawn.mjs';
import { findSpawned } from './autoname.mjs';

/** A stack id: `st-` + 8 lowercase hex chars (never changes). */
export const STACK_ID_RE = /^st-[0-9a-f]{8}$/;
/** PUT …/stacks/:id: the markdown cap (bytes, UTF-8). */
export const MAX_STACK_MARKDOWN = 64 * 1024;
/** The request body cap for that PUT: the markdown plus its JSON envelope and escaping. */
export const STACK_BODY_LIMIT = 256 * 1024;
export const MAX_STACK_LABEL = 80;
const ISO_RE = /^[0-9][0-9T:.+\-Z]{9,39}$/;

/** Waits between tries of the post-spawn `stack add`: 75 s in all, tighter at first. */
export const STACK_JOIN_DELAYS_MS = [3000, 4000, 5000, 6000, 7000, 10000, 10000, 15000, 15000];
/** The first background `stack sync` runs this long after start. */
export const STACK_SYNC_INITIAL_DELAY_MS = 30 * 1000;

/**
 * The CLI's stderr for a stack that is not there: `no stack matches "<q>"` (exit 3) or
 * `stack st-… is gone` (exit 3, deleted between resolve and write). → 404, not 409.
 */
const STACK_MISSING_RE = /\b(no stack|unknown stack|no such stack|stack not found|not found)\b|\bstack st-[0-9a-f]{8} is gone\b/i;

/** A FleetCliError from a `fleet stack` call → the HttpError the API answers with. */
export function stackHttpError(err, what = 'fleet stack') {
  if (err instanceof HttpError) return err;
  const msg = String(err?.message ?? err);
  if (err?.timedOut) return new HttpError(`${what} timed out: ${msg}`, 504);
  if (err?.missing) return new HttpError('this host\'s fleet CLI has no `stack` command — update fleet there', 501);
  if (STACK_MISSING_RE.test(msg)) return new HttpError(msg, 404);
  if (err?.exitCode === 2 || err?.exitCode === 3) return new HttpError(msg, 409); // ambiguous / nothing to act on
  if (err?.exitCode === 1) return new HttpError(msg, 400); // usage / refusal
  return new HttpError(`${what} failed: ${msg}`, 502);
}

/** The body of PUT …/stacks/:id → { markdown, expectUpdated }; throws HttpError(400). */
export function validateStackEdit(body) {
  const markdown = body?.markdown;
  if (typeof markdown !== 'string') throw new HttpError('markdown must be a string', 400);
  if (Buffer.byteLength(markdown) > MAX_STACK_MARKDOWN) throw new HttpError(`markdown too long (max ${MAX_STACK_MARKDOWN} bytes)`, 400);
  let expectUpdated = null;
  if (body.expectUpdated != null && body.expectUpdated !== '') {
    if (typeof body.expectUpdated !== 'string' || !ISO_RE.test(body.expectUpdated)) throw new HttpError('expectUpdated must be an ISO timestamp', 400);
    expectUpdated = body.expectUpdated;
  }
  return { markdown, expectUpdated };
}

/** Optional `label` of a sibling spawn (used only when a new stack is created). */
export function validateStackLabel(label) {
  if (label == null || label === '') return null;
  if (typeof label !== 'string') throw new HttpError('label must be a string', 400);
  const l = label.trim();
  if (!l) return null;
  if (/[\r\n]/.test(l) || [...l].length > MAX_STACK_LABEL) throw new HttpError(`label must be one line of at most ${MAX_STACK_LABEL} characters`, 400);
  return l;
}

/** A StackView + `editor` / `editorUrl` for its `absCwd` (built by the server the browser asked). */
export function withStackEditor(view, host, config) {
  if (!view || typeof view !== 'object' || Array.isArray(view) || view.error) return view;
  return { ...view, editor: config.editor ?? null, editorUrl: editorUrl(config, host, typeof view.absCwd === 'string' ? view.absCwd : null) };
}

/** `{ host, stacks: [StackView] }` (list / sync bodies) with editor links on every stack. */
export function withStacksEditor(body, host, config) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.stacks)) return body;
  return { ...body, stacks: body.stacks.map((s) => withStackEditor(s, host, config)) };
}

/**
 * Where a sibling starts: `base` (the source session's cwd or the stack's absCwd, `~`
 * expanded) unless `requested` is given, which must lie inside `base` or pass
 * resolveAllowedDir against this host's spawn dirs (`roots`). Returns a realpath; throws
 * HttpError(400) when a directory does not exist or is not allowed.
 */
export async function resolveStackSpawnDir({ base, requested = null, roots = [], home = os.homedir() }) {
  const abs = expandHome(typeof base === 'string' ? base : '', home);
  let realBase = null;
  try {
    realBase = await fs.realpath(abs);
    if (!(await fs.stat(realBase)).isDirectory()) realBase = null;
  } catch {
    realBase = null;
  }
  if (!requested) {
    if (!realBase) throw new HttpError(`not a directory on this host: ${base || '(none)'}`, 400);
    return realBase;
  }
  let real;
  try {
    real = await fs.realpath(requested);
  } catch {
    throw new HttpError(`dir does not exist: ${requested}`, 400);
  }
  if (realBase && isWithin(real, realBase)) return real;
  try {
    return await resolveAllowedDir(requested, roots, { home });
  } catch {
    throw new HttpError(`dir must be inside ${base} or one of this host's spawn dirs: ${requested}`, 400);
  }
}

/**
 * @param deps
 *   cli           lib/fleet-cli.mjs instance (stackList/Show/Set/Remove/Ensure/Add/Sync)
 *   listSessions  () => Promise<rows> — this host's fresh `fleet list --json` rows
 *   gateSessions  () => Promise<rows | null> — the current list for the sync gate (a cached one
 *                 is fine: server.mjs passes fleet.localHost(), 2 s TTL); default listSessions
 *   syncEnabled   run the background sync (web.stacks; FLEET_WEB_STACKS=0 turns it off)
 *   syncIntervalMs, initialDelayMs, joinDelaysMs, sleep, log, now
 */
export function createStacks({
  cli,
  listSessions,
  gateSessions = null,
  syncEnabled = true,
  syncIntervalMs = 2 * 60 * 1000,
  initialDelayMs = STACK_SYNC_INITIAL_DELAY_MS,
  joinDelaysMs = STACK_JOIN_DELAYS_MS,
  sleep,
  log = () => {},
  now = Date.now,
}) {
  if (!cli || typeof cli.stackSync !== 'function') throw new TypeError('cli.stackSync must be a function');
  if (typeof listSessions !== 'function') throw new TypeError('listSessions must be a function');
  const wait = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms).unref?.()));

  const call = async (what, fn) => {
    try {
      return await fn();
    } catch (err) {
      throw stackHttpError(err, what);
    }
  };

  // --- membership sync: de-duplicated, with one trailing re-run for a call made mid-run ---
  let lastSync = null;
  let inFlight = null;
  let queued = null;

  async function doSync(reason) {
    const at = now();
    try {
      const report = await cli.stackSync();
      const changed = Array.isArray(report?.changed) ? report.changed : [];
      lastSync = { at, ms: now() - at, reason, ok: true, changed };
      if (changed.length) log(`[stacks] ${reason} sync: ${changed.join(', ')} updated`);
      return report;
    } catch (err) {
      lastSync = { at, ms: now() - at, reason, ok: false, changed: [], error: String(err?.message ?? err) };
      log(`[stacks] ${reason} sync failed: ${lastSync.error}`);
      throw err;
    }
  }

  /** `fleet --local stack sync --json` → `{ host, changed, stacks }`; throws FleetCliError. */
  function sync(reason = 'manual') {
    if (!inFlight) {
      inFlight = doSync(reason).finally(() => {
        inFlight = null;
      });
      return inFlight;
    }
    if (!queued) {
      queued = inFlight
        .catch(() => {})
        .then(() => {
          queued = null;
          return sync(reason);
        });
    }
    return queued;
  }

  /** One background tick: sync only when the last list showed a session in a stack. */
  async function tick() {
    const rows = await (gateSessions ?? listSessions)().catch(() => null);
    if (!Array.isArray(rows) || !rows.some((r) => r?.stack != null)) return { ran: false };
    await sync('scheduled').catch(() => {}); // logged in doSync
    return { ran: true };
  }

  let timer = null;
  let stopped = false;
  function schedule(delay) {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      await tick();
      schedule(syncIntervalMs);
    }, delay);
    timer.unref?.();
  }

  // --- after a sibling spawn: find the new session by its tmux name, then `stack add` ----
  const pending = new Map(); // `${stackId} ${tmuxSession}` -> promise

  async function runJoin(tmuxSession, stackId) {
    let tries = 0;
    for (const delay of joinDelaysMs) {
      await wait(delay);
      if (stopped) return { ok: false, reason: 'stopped', tries };
      tries += 1;
      let rows;
      try {
        rows = await listSessions();
      } catch {
        continue;
      }
      const s = findSpawned(rows, tmuxSession);
      if (!s) continue; // not registered yet
      if (s.stack?.id === stackId) return { ok: true, reason: 'already a member', session: s.session_id, tries };
      try {
        await cli.stackAdd(stackId, s.session_id);
        log(`[stacks] ${tmuxSession} (${String(s.session_id).slice(0, 8)}) joined ${stackId}`);
        return { ok: true, reason: 'added', session: s.session_id, tries };
      } catch (err) {
        const msg = String(err?.message ?? err);
        if (!err?.timedOut && [1, 2, 3].includes(err?.exitCode)) {
          log(`[stacks] ${tmuxSession}: not added to ${stackId}: ${msg}`);
          return { ok: false, reason: 'refused', session: s.session_id, tries, error: msg };
        }
        log(`[stacks] ${tmuxSession}: add to ${stackId} failed (try ${tries}): ${msg}`);
      }
    }
    log(`[stacks] ${tmuxSession}: not found after ${tries} tries — run \`fleet stack add ${stackId} <session>\``);
    return { ok: false, reason: 'not found', tries };
  }

  /** Start the background add for a just-spawned tmux session (once per pair); its promise never rejects. */
  function join(tmuxSession, stackId) {
    const key = `${stackId} ${tmuxSession}`;
    if (pending.has(key)) return pending.get(key);
    const p = runJoin(tmuxSession, stackId).finally(() => pending.delete(key));
    pending.set(key, p);
    return p;
  }

  return {
    list: () => call('fleet stack list', () => cli.stackList()),
    show: (id) => call('fleet stack show', () => cli.stackShow(id)),
    /** A human edit. Conflict (CLI exit 3) → HttpError 409 carrying `body: { error, updated }`. */
    async set(id, markdown, expectUpdated = null) {
      try {
        return await cli.stackSet(id, markdown, expectUpdated);
      } catch (err) {
        if (err?.exitCode === 3 && !err?.missing && !STACK_MISSING_RE.test(String(err?.message))) {
          const report = err.report ?? {};
          const e = new HttpError(report.error ?? report.message ?? err.message ?? 'the stack changed since it was loaded', 409);
          e.body = { ...report, error: e.message, updated: report.updated ?? null };
          throw e;
        }
        throw stackHttpError(err, 'fleet stack set');
      }
    },
    remove: (id) => call('fleet stack rm', () => cli.stackRemove(id)),
    rename: (id, label) => call('fleet stack rename', () => cli.stackRename(id, label)),
    ensure: (sessionId, opts) => call('fleet stack ensure', () => cli.stackEnsure(sessionId, opts)),
    /** POST …/stacks/sync: like `sync`, errors mapped to HttpError. */
    syncNow: (reason = 'manual') => call('fleet stack sync', () => sync(reason)),
    sync,
    tick,
    join,
    start() {
      stopped = false;
      if (syncEnabled) schedule(initialDelayMs);
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
    status: () => ({ sync: syncEnabled, syncMinutes: syncIntervalMs / 60000, lastSync }),
    get lastSync() {
      return lastSync;
    },
    get pending() {
      return [...pending.keys()];
    },
  };
}
