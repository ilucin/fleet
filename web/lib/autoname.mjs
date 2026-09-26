// Periodic auto-naming. Sessions started without a name carry Claude's cwd+hash fallback
// (`project-9d`); the `fleet` CLI can generate task-shaped names and apply them via
// Claude's own `/rename` (`fleet name --all --apply`, it holds sessions waiting on a prompt), but
// nothing runs it on a schedule. The web server does: it already runs on every host, inside
// tmux, which is also where `claude -p` (the name generator) has a logged-in keychain on a
// headless machine; a plain ssh shell often does not.
//
// One rename path: the CLI renames the Claude session (the title, the source of truth) and
// brings the tmux session name along as a slug of it, only for a tmux session that is
// that one Claude session's own. A tmux session somebody named by hand is not clobbered:
// the CLI adopts its name as the title instead of generating one (docs/architecture.md →
// "Session titles"). Nothing here touches tmux.

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

/**
 * @param deps
 *   cli           lib/fleet-cli.mjs instance (`nameAll`)
 *   intervalMs, initialDelayMs, log, dryRun
 */
export function createAutoNamer({ cli, intervalMs = 5 * 60 * 1000, initialDelayMs = 60 * 1000, log = () => {}, dryRun = false }) {
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
