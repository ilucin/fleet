// Load relief (docs/architecture.md → Host load → Relief): while this host is `critical`, the web
// server deactivates sessions (`fleet sleep`: the agent ends, the session stays resumable from
// Inactive) until it recovers, so a shed that runs out of memory comes back by itself instead of
// freezing. Idle sessions go first, heaviest first; a busy one only once the host has been
// critical for `reliefBusySeconds` and no idle one is left. Never: the voice operator, a resident
// bot's session, a stack's lead, a session waiting on you, one without a session id.
import os from 'node:os';

/** At most one round per this long: a slept session's memory shows up in the next samples. */
export const RELIEF_EVERY_MS = 30 * 1000;
/** At most this many sessions per round (memory: as many as it takes to get back to `hot`). */
export const RELIEF_MAX_PER_ROUND = 5;
/** Kept for the UI and the owner's DM. */
const KEEP = 20;
export const RECENT_MS = 60 * 60 * 1000;

/** Is the critical verdict about memory (sleeping idle sessions helps) or only CPU (it does not)? */
export function memoryBound(sample, s) {
  if (!sample) return false;
  if (sample.pressure === 'critical') return true;
  if (sample.freePct != null && sample.freePct < (s.memory?.critical ?? 5)) return true;
  if (sample.psi?.full != null && sample.psi.full >= (s.psi?.critical ?? 10)) return true;
  return false;
}

/**
 * Which sessions to deactivate this round. Pure.
 *   verdict    the monitor's current() (state, since, level, sample, override)
 *   sessions   this host's rows (`list --json`)
 *   use        lib/load.mjs#processUse(...).sessions — rssMb / cpu per session id
 *   protect    (row) → true for a session never to touch
 *   totalMb    this machine's memory
 * → { pick: [{ id, name, status, rssMb, cpu, session }], why } (pick empty: nothing to do / nothing left)
 */
export function planRelief({ verdict, settings: s, sessions = [], use = [], protect = () => false, totalMb = 0, now = Date.now() }) {
  if (!s?.enabled || !s.relief) return { pick: [], why: 'off' };
  if (!verdict || verdict.override || verdict.state !== 'critical' || verdict.level !== 'critical') return { pick: [], why: 'not critical' };
  const byId = new Map(use.map((u) => [u.id, u]));
  const rows = sessions
    .filter((r) => typeof r?.session_id === 'string' && !r.session_id.startsWith('pid-') && !protect(r))
    .map((r) => ({ id: r.session_id, name: r.name || r.title || r.tmux_session || r.session_id, status: r.status, rssMb: byId.get(r.session_id)?.rssMb ?? 0, cpu: byId.get(r.session_id)?.cpu ?? 0, session: r }));
  const memory = memoryBound(verdict.sample, s);
  if (memory) {
    const idle = rows.filter((r) => r.status === 'idle').sort((a, b) => b.rssMb - a.rssMb);
    if (idle.length) {
      // Enough to get free memory back above the `hot` line (one at least, a few at most).
      const free = verdict.sample?.freePct;
      const needMb = free != null && totalMb > 0 ? ((s.memory.hot - free) / 100) * totalMb : 0;
      const pick = [];
      let freed = 0;
      for (const r of idle) {
        if (pick.length >= RELIEF_MAX_PER_ROUND || (pick.length && freed >= needMb)) break;
        pick.push(r);
        freed += r.rssMb;
      }
      return { pick, why: 'idle' };
    }
  }
  // A busy one only after a while, one per round: it loses the turn it is on.
  const waited = now - (verdict.since ?? now);
  if (!(s.reliefBusySeconds > 0) || waited < s.reliefBusySeconds * 1000) return { pick: [], why: memory ? 'no idle session; busy ones wait' : 'CPU; busy ones wait' };
  const busy = rows.filter((r) => r.status === 'busy').sort((a, b) => (memory ? b.rssMb - a.rssMb : b.cpu - a.cpu));
  return busy.length ? { pick: [busy[0]], why: 'busy' } : { pick: [], why: 'nothing left to deactivate' };
}

/**
 * @param deps
 *   settings      () → the `resources` settings (live)
 *   listSessions  async () → this host's rows, fresh (null when discovery failed)
 *   readUse       async (rows) → lib/load.mjs#processUse(...)
 *   sleepSession  async (row) → void (`fleet sleep`, and the iTerm tab)
 *   residents     async () → Set of resident bot names (`on.slack`); their sessions stay
 *   isOperator    (row) → true for the voice operator
 */
export function createRelief({ settings, listSessions, readUse, sleepSession, residents = async () => new Set(), isOperator = () => false, totalMb = Math.round(os.totalmem() / 1024 / 1024), now = Date.now, log = () => {} }) {
  let last = -Infinity;
  let running = false;
  const done = [];

  async function check(verdict) {
    const s = settings();
    if (running || !s?.enabled || !s.relief || verdict?.state !== 'critical' || verdict.override) return [];
    if (now() - last < RELIEF_EVERY_MS) return [];
    running = true;
    try {
      const sessions = await listSessions();
      if (!sessions?.length) return [];
      const res = await residents().catch(() => new Set());
      const protect = (r) => isOperator(r) || (r.origin?.job && res.has(r.origin.job)) || (r.stack?.lead && r.stack.lead === r.session_id) || r.status === 'waiting';
      const use = (await readUse(sessions).catch(() => null))?.sessions ?? [];
      const { pick, why } = planRelief({ verdict, settings: s, sessions, use, protect, totalMb, now: now() });
      if (!pick.length) {
        if (why !== 'not critical' && why !== 'off') log(`[load] relief: nothing deactivated (${why})`);
        return [];
      }
      last = now();
      const out = [];
      for (const p of pick) {
        try {
          await sleepSession(p.session);
          const rec = { at: now(), id: p.id, name: p.name, status: p.status, rssMb: p.rssMb, cpu: p.cpu };
          done.push(rec);
          out.push(rec);
          log(`[load] relief: deactivated ${p.status} session "${p.name}" (${p.rssMb} MB, ${p.cpu}% CPU)`);
        } catch (err) {
          log(`[load] relief: could not deactivate "${p.name}": ${err?.message ?? err}`);
        }
      }
      while (done.length > KEEP) done.shift();
      return out;
    } finally {
      running = false;
    }
  }

  /** What it deactivated in the last hour, oldest first. */
  const recent = () => done.filter((d) => now() - d.at < RECENT_MS);

  return { check, recent };
}
