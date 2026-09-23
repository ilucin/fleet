// The one place the web server talks to the `fleet` CLI. Everything the server needs
// from the CLI goes through here, so an alternative UI/TUI server can reuse it and the
// contract (`fleet list --json`) is documented in one spot (see ARCHITECTURE.md).
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

  return { bin, list };
}
