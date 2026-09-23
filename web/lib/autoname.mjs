// Periodic auto-naming. Sessions started without a name carry Claude's cwd+hash fallback
// (`project-9d`); the `fleet` CLI can generate task-shaped names and apply them via
// Claude's own `/rename` (`fleet name --all --apply`, it skips busy/waiting sessions), but
// nothing runs it on a schedule. The web server does: it already runs on every host, inside
// tmux, which is also where `claude -p` (the name generator) has a logged-in keychain on a
// headless machine; a plain ssh shell often does not.
//
// tmux is synced here rather than by the CLI (which is called with --no-tmux-sync): the
// CLI's sync renames the tmux session whatever it was called, which would clobber names
// the user picked by hand (`fleet new fix-login`). Only *generic* tmux names are renamed:
// the web spawner's own `fw-hhmmss`, tmux's numeric default, or Claude's `<cwd>-9d` style,
// and only when the tmux session has a single window.

const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Turn `fleet name` human output into a summary. Lines look like:
 *  `project-1a  →  fix-login-flow`          (renamed; dry run appends `   (llm)`)
 *  `   ⧉ fix-login → fix-login-flow`        (tmux synced, indented note)
 *  `⏸ project-4f is mid-turn — nothing sent (--force overrides)` (held)
 *  `✕ project-01: ...` (error)
 *  `no sessions still carry a Claude-derived name — nothing to rename`
 */
export function parseNameOutput(text) {
  const renamed = [];
  const tmux = [];
  const held = [];
  const errors = [];
  for (const raw of String(text).replace(ANSI_RE, '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('⏸')) held.push(line.slice(1).trim());
    else if (line.startsWith('✕')) errors.push(line.slice(1).trim());
    else if (line.startsWith('⧉')) tmux.push(line.slice(1).trim());
    else if (line.includes('  →  ')) {
      const [from, to] = line.split('  →  ');
      renamed.push({ from: from.trim(), to: to.trim().split(/\s+/)[0] });
    }
  }
  return { renamed, tmux, held, errors };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Is this tmux session name one nobody chose? */
export function isGenericTmuxName(tmuxSession, cwd = '') {
  const name = String(tmuxSession || '');
  if (!name) return false;
  if (/^fw-\d{6}$/.test(name) || /^\d+$/.test(name)) return true;
  const base = String(cwd || '').split('/').filter(Boolean).pop() || '';
  return Boolean(base) && new RegExp(`^${escapeRe(base)}-[0-9a-f]{2}$`, 'i').test(name);
}

/** tmux-safe session name (no `.`/`:`, no spaces), unique among `taken`. */
export function tmuxNameFor(claudeName, taken = []) {
  const base = String(claudeName)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  if (!base) return '';
  let candidate = base;
  for (let i = 2; taken.includes(candidate) && i < 100; i += 1) candidate = `${base}-${i}`;
  return candidate;
}

/**
 * Rename generic tmux sessions after the Claude sessions inside them got a real name.
 * `sessions` = `fleet list --json` rows of this host. Returns [{ from, to }].
 */
export async function syncGenericTmux({ sessions, run, tmux = 'tmux' }) {
  const renames = [];
  const candidates = (sessions || []).filter(
    (s) =>
      s.backend === 'tmux' &&
      s.handle &&
      s.tmux_session &&
      s.name_source === 'user' &&
      s.name &&
      isGenericTmuxName(s.tmux_session, s.cwd),
  );
  if (candidates.length === 0) return renames;
  let taken = [];
  try {
    const { stdout } = await run(tmux, ['list-sessions', '-F', '#{session_name}'], { timeout: 5000 });
    taken = stdout.split('\n').filter(Boolean);
  } catch {
    return renames; // no tmux server: nothing to rename
  }
  for (const s of candidates) {
    try {
      // Pane id as the target: session-name independent (see lib/kill.mjs).
      const { stdout } = await run(tmux, ['list-windows', '-t', s.handle, '-F', '#{window_id}'], { timeout: 5000 });
      if (stdout.split('\n').filter(Boolean).length > 1) continue; // shared session: leave it
      const to = tmuxNameFor(s.name, taken);
      if (!to || to === s.tmux_session) continue;
      await run(tmux, ['rename-session', '-t', s.handle, to], { timeout: 5000 });
      taken = taken.map((n) => (n === s.tmux_session ? to : n));
      renames.push({ from: s.tmux_session, to });
    } catch {
      /* best effort, next one */
    }
  }
  return renames;
}

/**
 * @param deps
 *   cli           lib/fleet-cli.mjs instance (`nameAll`)
 *   run, tmux     for the tmux sync
 *   listSessions  () => Promise<rows|null> — fresh local sessions (fleet.localSessions({ force: true }))
 *   intervalMs, initialDelayMs, log, dryRun, settleMs (wait for /rename to land in the registry)
 */
export function createAutoNamer({
  cli,
  run,
  tmux = 'tmux',
  listSessions = null,
  intervalMs = 5 * 60 * 1000,
  initialDelayMs = 60 * 1000,
  settleMs = 3000,
  log = () => {},
  dryRun = false,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  if (!cli || typeof cli.nameAll !== 'function') throw new TypeError('cli.nameAll must be a function');
  let timer = null;
  let inFlight = null;
  let lastRun = null;
  let stopped = false;

  async function runOnce(reason = 'manual') {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const startedAt = Date.now();
      try {
        const { stdout, stderr } = await cli.nameAll({ dryRun });
        const summary = parseNameOutput(`${stdout}\n${stderr}`);
        if (!dryRun && listSessions && run) {
          // /rename takes a moment to land in Claude's session registry.
          if (summary.renamed.length && settleMs > 0) await sleep(settleMs);
          const sessions = await listSessions();
          summary.tmux = (await syncGenericTmux({ sessions, run, tmux })).map((r) => `${r.from} → ${r.to}`);
        }
        lastRun = { at: startedAt, ms: Date.now() - startedAt, reason, ok: true, dryRun, ...summary };
        const brief = summary.renamed.map((r) => `${r.from}→${r.to}`).join(', ') || 'nothing to rename';
        const tmuxBrief = summary.tmux.length ? ` tmux: ${summary.tmux.join(', ')}` : '';
        const heldBrief = summary.held.length ? ` (${summary.held.length} held)` : '';
        const errBrief = summary.errors.length ? ` (${summary.errors.length} errors)` : '';
        log(`[autoname] ${reason}: ${brief}${tmuxBrief}${heldBrief}${errBrief}`);
      } catch (err) {
        lastRun = {
          at: startedAt,
          ms: Date.now() - startedAt,
          reason,
          ok: false,
          dryRun,
          error: err?.message ?? String(err),
          renamed: [],
          tmux: [],
          held: [],
          errors: [],
        };
        log(`[autoname] ${reason} failed: ${lastRun.error}`);
      } finally {
        inFlight = null;
      }
      return lastRun;
    })();
    return inFlight;
  }

  function schedule(delay) {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      await runOnce('scheduled');
      schedule(intervalMs);
    }, delay);
    timer.unref?.();
  }

  return {
    start() {
      stopped = false;
      schedule(initialDelayMs);
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
    runOnce,
    get lastRun() {
      return lastRun;
    },
  };
}
