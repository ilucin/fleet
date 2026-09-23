import { sortSessions } from './util.mjs';

/**
 * Local session discovery (via the `fleet` CLI, see lib/fleet-cli.mjs) with a short TTL
 * cache and in-flight de-duplication. Never throws: failures come back as { ok:false, error }.
 */
export function createFleet({ cli, self = 'local', ttlMs = 2000, now = Date.now } = {}) {
  if (!cli || typeof cli.list !== 'function') throw new TypeError('cli.list must be a function');

  let cached = null; // { at, value }
  let inFlight = null;

  async function discover() {
    const fetchedAt = now();
    try {
      const raw = await cli.list();
      const sessions = sortSessions(raw).map((s) => ({ ...s, host: self }));
      return { name: self, ok: true, fetchedAt, sessions };
    } catch (err) {
      return { name: self, ok: false, error: String(err?.message ?? err), fetchedAt, sessions: [] };
    }
  }

  async function localHost({ force = false } = {}) {
    if (!force && cached && now() - cached.at < ttlMs) return cached.value;
    if (inFlight) return inFlight;
    inFlight = discover()
      .then((value) => {
        cached = { at: now(), value };
        return value;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  /** Sessions of this host, or null if discovery failed. */
  async function localSessions(opts) {
    const host = await localHost(opts);
    return host.ok ? host.sessions : null;
  }

  function invalidate() {
    cached = null;
  }

  return { localHost, localSessions, invalidate };
}
