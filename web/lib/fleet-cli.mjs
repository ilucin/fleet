// The one place the web server talks to the `fleet` CLI. Everything the server needs
// from the CLI goes through here, so an alternative UI/TUI server can reuse it and the
// contracts (`fleet list --json`, `fleet name --all --apply`, `fleet group`) are documented in one spot (see ARCHITECTURE.md).
//
// Peek/send/keys are NOT done through the CLI: `fleet peek` truncates to terminal width
// and adds a header, so lib/backends.mjs drives tmux / iTerm directly.

export class FleetCliError extends Error {
  constructor(message, { timedOut = false } = {}) {
    super(message);
    this.name = 'FleetCliError';
    this.timedOut = timedOut;
  }
}

/**
 * `run(file, args, opts)` is injected (lib/run.mjs in production, a fake in tests).
 * `bin` is the resolved `fleet` binary (lib/config.mjs#resolveFleetBin).
 */
export function createFleetCli({ run, bin = 'fleet', timeoutMs = 8000 } = {}) {
  if (typeof run !== 'function') throw new TypeError('run must be a function');

  /** Local Claude sessions: the parsed `fleet list --json` array. Throws FleetCliError. */
  async function list() {
    let stdout;
    try {
      ({ stdout } = await run(bin, ['list', '--json'], { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }));
    } catch (err) {
      const killed = err?.killed || err?.signal === 'SIGTERM';
      if (killed) throw new FleetCliError(`fleet list timed out after ${Math.round(timeoutMs / 1000)}s`, { timedOut: true });
      if (err?.code === 'ENOENT') throw new FleetCliError(`fleet binary not found (${bin}) — install it or set "fleetBin" in the fleet config`);
      throw new FleetCliError(String(err?.message ?? err));
    }
    const text = (stdout ?? '').trim();
    if (!text) return [];
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new FleetCliError('fleet returned non-JSON output');
    }
    if (!Array.isArray(parsed)) throw new FleetCliError('fleet did not return an array');
    return parsed.filter((s) => s && typeof s === 'object');
  }

  /**
   * The naming pass: `fleet name --all --apply --no-tmux-sync` (or `-n name --all` for a
   * dry run). Generates task-shaped names for every session still carrying Claude's
   * cwd+hash name and types `/rename` into the idle ones (the CLI holds busy/waiting ones).
   * tmux is left alone here; lib/autoname.mjs syncs only generic tmux names.
   * Resolves { stdout, stderr } (human output, NO_COLOR); throws FleetCliError.
   */
  async function nameAll({ dryRun = false, timeoutMs: t = 300 * 1000 } = {}) {
    const args = dryRun ? ['-n', 'name', '--all'] : ['name', '--all', '--apply', '--no-tmux-sync'];
    try {
      const { stdout, stderr } = await run(bin, args, { timeout: t, env: { ...process.env, NO_COLOR: '1' } });
      return { stdout: stdout ?? '', stderr: stderr ?? '' };
    } catch (err) {
      const killed = err?.killed || err?.signal === 'SIGTERM';
      if (killed) throw new FleetCliError(`fleet name timed out after ${Math.round(t / 1000)}s`, { timedOut: true });
      if (err?.code === 'ENOENT') throw new FleetCliError(`fleet binary not found (${bin})`);
      throw new FleetCliError(String(err?.message ?? err));
    }
  }

  function wrap(err, what, t) {
    const killed = err?.killed || err?.signal === 'SIGTERM';
    if (killed) return new FleetCliError(`${what} timed out after ${Math.round(t / 1000)}s`, { timedOut: true });
    if (err?.code === 'ENOENT') return new FleetCliError(`fleet binary not found (${bin})`);
    return new FleetCliError(String(err?.message ?? err));
  }

  function parseObject(stdout, what) {
    try {
      const v = JSON.parse(String(stdout ?? '').trim());
      if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    } catch {
      /* below */
    }
    throw new FleetCliError(`${what} returned non-JSON output`);
  }

  /**
   * The grouping pass: `fleet group --input - --apply --json` with the merged fleet
   * (`/api/fleet` body) on stdin. Reads sessions and calls `claude -p`; never sends
   * anything to a session. Resolves the parsed report (docs/cli.md → `fleet group`).
   */
  async function groupRun({ fleet, refresh = false, consolidate = false, timeoutMs: t = 5 * 60 * 1000 } = {}) {
    const args = ['group', '--input', '-', '--apply', '--json'];
    if (refresh) args.push('--refresh');
    if (consolidate) args.push('--consolidate');
    let stdout;
    try {
      ({ stdout } = await run(bin, args, { timeout: t, input: JSON.stringify(fleet ?? { hosts: [] }), env: { ...process.env, NO_COLOR: '1' } }));
    } catch (err) {
      throw wrap(err, 'fleet group', t);
    }
    return parseObject(stdout, 'fleet group');
  }

  /** The stored groups (`fleet group --cached --json`): no discovery, no model call. */
  async function groupCached({ timeoutMs: t = 10 * 1000 } = {}) {
    let stdout;
    try {
      ({ stdout } = await run(bin, ['group', '--cached', '--json'], { timeout: t, env: { ...process.env, NO_COLOR: '1' } }));
    } catch (err) {
      throw wrap(err, 'fleet group --cached', t);
    }
    return parseObject(stdout, 'fleet group --cached');
  }

  return { bin, list, nameAll, groupRun, groupCached };
}
