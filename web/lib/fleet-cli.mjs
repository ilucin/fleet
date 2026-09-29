// The one place the web server talks to the `fleet` CLI. Everything the server needs
// from the CLI goes through here, so an alternative UI/TUI server can reuse it and the
// contracts (`fleet list --json`, `fleet rename --json`, `fleet name --all --apply`, `fleet name <id> --apply`, `fleet group` (+ `--rename` / `--move`),
// `fleet config set`, `fleet --local stack … --json`) are documented in one
// spot (see ARCHITECTURE.md).
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

/** clap's answer when the binary predates `fleet stack` (an older CLI on that host). */
const NO_SUBCOMMAND_RE = /unrecognized subcommand|unexpected argument 'stack'|invalid subcommand/i;

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
   * The naming pass: `fleet name --all --apply` (or `-n name --all` for a dry run).
   * Generates task-shaped names for every session still carrying Claude's cwd+hash name
   * and types `/rename` into them (the CLI holds ones waiting on a prompt). The CLI
   * brings each renamed session's tmux name along (a slug of the title) — one rename
   * path for everything, see docs/architecture.md → "Session titles".
   * Resolves { stdout, stderr } (human output, NO_COLOR); throws FleetCliError.
   */
  async function nameAll({ dryRun = false, timeoutMs: t = 300 * 1000 } = {}) {
    const args = dryRun ? ['-n', 'name', '--all'] : ['name', '--all', '--apply'];
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

  /**
   * Name one session: `fleet name <target> --apply` — the same generator and rename path as
   * `nameAll`, for a session just spawned (lib/autoname.mjs#createSpawnNamer). Output as
   * `nameAll`. Throws FleetCliError.
   */
  async function nameOne({ target, timeoutMs: t = 120 * 1000 } = {}) {
    try {
      const { stdout, stderr } = await run(bin, ['name', String(target), '--apply'], { timeout: t, env: { ...process.env, NO_COLOR: '1' } });
      return { stdout: stdout ?? '', stderr: stderr ?? '' };
    } catch (err) {
      throw wrap(err, 'fleet name', t);
    }
  }

  /**
   * Rename one session: `fleet rename <target> <title> --json` — Claude's `/rename` (the
   * title, the source of truth) plus the derived tmux name. Resolves the report
   * ({ ok, result: renamed|sent|held, held, tmux, message, … }); a held session (waiting
   * on a prompt, exit 3) resolves too, with `ok: false`. Throws FleetCliError otherwise.
   */
  async function rename({ target, title, timeoutMs: t = 20 * 1000 } = {}) {
    const args = ['rename', String(target), String(title), '--json'];
    let stdout;
    try {
      ({ stdout } = await run(bin, args, { timeout: t, env: { ...process.env, NO_COLOR: '1' } }));
    } catch (err) {
      // Held exits 3 with the report on stdout; anything else is a real failure.
      const report = tryObject(err?.stdout);
      if (report && report.result === 'held') return report;
      throw wrap(err, 'fleet rename', t);
    }
    return parseObject(stdout, 'fleet rename');
  }

  function tryObject(text) {
    try {
      const v = JSON.parse(String(text ?? '').trim());
      return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
    } catch {
      return null;
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

  /**
   * A change made on the board: `fleet group --rename <id> --label <l> --json` or
   * `fleet group --move <host/id> (--to <group id> | --label <new group>) --json`. Edits the
   * stored groups only (no discovery, no model call); resolves the report like `--cached`.
   */
  async function groupEdit({ op, id, label, host, session, to, timeoutMs: t = 10 * 1000 } = {}) {
    const args = ['group'];
    // `--flag=value`: a label starting with "-" must not read as a flag.
    if (op === 'rename') args.push(`--rename=${id}`, `--label=${label}`);
    else if (op === 'move') args.push(`--move=${host}/${session}`, to ? `--to=${to}` : `--label=${label}`);
    else throw new FleetCliError(`unknown group edit "${op}"`);
    args.push('--json');
    let stdout;
    try {
      ({ stdout } = await run(bin, args, { timeout: t, env: { ...process.env, NO_COLOR: '1' } }));
    } catch (err) {
      const e = wrap(err, 'fleet group', t);
      const why = String(err?.stderr ?? '').replace(/^Error:\s*/, '').trim();
      if (why && !e.timedOut) e.message = why;
      e.refused = !e.timedOut && Boolean(why);
      throw e;
    }
    return parseObject(stdout, 'fleet group');
  }

  /**
   * Write one config key: `fleet --local config set <key> <json>` against `configFile`
   * (FLEET_CONFIG). The CLI owns the config file: it rewrites the raw JSON atomically
   * (tmp + rename), keeps every other key and refuses a file that does not parse.
   * Resolves { stdout, stderr }; throws FleetCliError.
   */
  async function configSet({ key, value, configFile = null, timeoutMs: t = 10 * 1000 } = {}) {
    const env = { ...process.env, NO_COLOR: '1' };
    if (configFile) env.FLEET_CONFIG = configFile;
    try {
      const { stdout, stderr } = await run(bin, ['--local', 'config', 'set', String(key), JSON.stringify(value)], { timeout: t, env });
      return { stdout: stdout ?? '', stderr: stderr ?? '' };
    } catch (err) {
      throw wrap(err, 'fleet config set', t);
    }
  }

  /**
   * `fleet --local stack <args…> --json` (session stacks, docs/architecture.md → Session stacks).
   * Resolves the parsed JSON object. Throws FleetCliError carrying `exitCode`, `report` (a JSON
   * object the CLI printed on stdout before failing — `set` does on a conflict, exit 3),
   * `missing` (the binary has no `stack` command), `timedOut`; its message is the CLI's stderr.
   */
  async function stack(args, { input = null, timeoutMs: t = 20 * 1000 } = {}) {
    const argv = ['--local', 'stack', ...args.map(String), '--json'];
    let stdout;
    try {
      ({ stdout } = await run(bin, argv, { timeout: t, env: { ...process.env, NO_COLOR: '1' }, ...(input != null ? { input } : {}) }));
    } catch (err) {
      const e = wrap(err, `fleet stack ${args[0] ?? ''}`.trim(), t);
      const why = String(err?.stderr ?? '').replace(/^Error:\s*/, '').trim();
      if (why && !e.timedOut) e.message = why.split('\n')[0];
      e.exitCode = typeof err?.code === 'number' ? err.code : null;
      e.report = tryObject(err?.stdout);
      e.missing = !e.timedOut && NO_SUBCOMMAND_RE.test(why);
      throw e;
    }
    return parseObject(stdout, `fleet stack ${args[0] ?? ''}`.trim());
  }

  // `--flag=value` everywhere: a value starting with "-" must not read as a flag.
  const stackList = () => stack(['list']);
  const stackShow = (id) => stack(['show', id]);
  /** Human edit: the markdown on stdin; exit 3 (conflict) when `expectUpdated` is stale. */
  const stackSet = (id, markdown, expectUpdated = null) =>
    stack(['set', id, ...(expectUpdated ? [`--expect-updated=${expectUpdated}`] : [])], { input: markdown });
  const stackRemove = (id) => stack(['rm', id, '-f']);
  /** The session's stack, created around it when it has none (may call the model: 150 s). */
  const stackEnsure = (sessionId, { label = null } = {}) =>
    stack(['ensure', sessionId, ...(label ? [`--label=${label}`] : [])], { timeoutMs: 150 * 1000 });
  const stackAdd = (stackId, sessionId) => stack(['add', stackId, sessionId]);
  const stackSync = () => stack(['sync']);

  return {
    bin,
    list,
    nameAll,
    nameOne,
    rename,
    groupRun,
    groupCached,
    groupEdit,
    configSet,
    stackList,
    stackShow,
    stackSet,
    stackRemove,
    stackEnsure,
    stackAdd,
    stackSync,
  };
}
