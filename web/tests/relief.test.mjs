import assert from 'node:assert/strict';
import test from 'node:test';

import { loadSettings } from '../lib/load.mjs';
import { RELIEF_EVERY_MS, createRelief, memoryBound, planRelief } from '../lib/relief.mjs';

const S = loadSettings({ enabled: true });
const crit = (sample, extra = {}) => ({ state: 'critical', level: 'critical', since: 0, sample, ...extra });
const MEM = { pressure: 'normal', freePct: 3, perCore: 1 };
const row = (id, status, extra = {}) => ({ session_id: id, name: id, status, ...extra });
const use = (pairs) => pairs.map(([id, rssMb, cpu = 0]) => ({ id, rssMb, cpu }));

test('memoryBound: memory reasons, not CPU', () => {
  assert.equal(memoryBound({ freePct: 3, perCore: 1 }, S), true);
  assert.equal(memoryBound({ pressure: 'critical' }, S), true);
  assert.equal(memoryBound({ psi: { full: 20 } }, S), true);
  assert.equal(memoryBound({ freePct: 40, perCore: 6 }, S), false);
});

test('planRelief: idle first, heaviest first, as many as it takes to get back above hot', () => {
  const sessions = [row('a', 'idle'), row('b', 'idle'), row('c', 'idle'), row('w', 'busy')];
  // 16 GB, 3% free, hot at 10%: ~1.1 GB to free.
  const r = planRelief({ verdict: crit(MEM), settings: S, sessions, use: use([['a', 300], ['b', 900], ['c', 400], ['w', 4000]]), totalMb: 16384 });
  assert.equal(r.why, 'idle');
  assert.deepEqual(r.pick.map((p) => p.id), ['b', 'c']);
});

test('planRelief: never the protected ones, nor one without a session id', () => {
  const sessions = [row('lead', 'idle'), row('pid-12', 'idle'), row('ok', 'idle')];
  const r = planRelief({ verdict: crit(MEM), settings: S, sessions, use: use([['lead', 999], ['ok', 1]]), protect: (s) => s.session_id === 'lead', totalMb: 16384 });
  assert.deepEqual(r.pick.map((p) => p.id), ['ok']);
});

test('planRelief: a busy session only after reliefBusySeconds with no idle one left; CPU skips idle', () => {
  const sessions = [row('w1', 'busy'), row('w2', 'busy'), row('q', 'waiting')];
  const u = use([['w1', 500, 90], ['w2', 3000, 10]]);
  assert.equal(planRelief({ verdict: crit(MEM), settings: S, sessions, use: u, now: 60 * 1000 }).pick.length, 0, 'not yet');
  assert.deepEqual(planRelief({ verdict: crit(MEM), settings: S, sessions, use: u, now: 180 * 1000 }).pick.map((p) => p.id), ['w2'], 'memory: the heaviest');
  const cpu = { pressure: 'normal', freePct: 50, perCore: 6 };
  const withIdle = [...sessions, row('i', 'idle')];
  assert.deepEqual(planRelief({ verdict: crit(cpu), settings: S, sessions: withIdle, use: u, now: 180 * 1000 }).pick.map((p) => p.id), ['w1'], 'CPU: the busiest, idle ones do not help');
  assert.equal(planRelief({ verdict: crit(MEM), settings: { ...S, reliefBusySeconds: 0 }, sessions, use: u, now: 1e9 }).pick.length, 0, '0: never busy ones');
});

test('planRelief: nothing unless critical now, on, and not overridden', () => {
  const sessions = [row('a', 'idle')];
  const u = use([['a', 100]]);
  assert.equal(planRelief({ verdict: crit(MEM, { level: 'hot' }), settings: S, sessions, use: u }).pick.length, 0, 'already easing');
  assert.equal(planRelief({ verdict: { ...crit(MEM), state: 'hot' }, settings: S, sessions, use: u }).pick.length, 0);
  assert.equal(planRelief({ verdict: crit(MEM, { override: { until: 1 } }), settings: S, sessions, use: u }).pick.length, 0);
  assert.equal(planRelief({ verdict: crit(MEM), settings: { ...S, relief: false }, sessions, use: u }).pick.length, 0);
});

test('createRelief: sleeps, keeps the record, paces itself, spares the operator, residents, leads and waiting', async () => {
  let t = 1000;
  const slept = [];
  const sessions = [
    row('op', 'idle'),
    row('bot', 'idle', { origin: { job: 'help-desk', run: 'r1' } }),
    row('lead', 'idle', { stack: { id: 'st-1', lead: 'lead' } }),
    row('ask', 'waiting'),
    row('x', 'idle', { stack: { id: 'st-1', lead: 'lead' } }),
    row('y', 'idle'),
  ];
  const r = createRelief({
    settings: () => S,
    listSessions: async () => sessions,
    readUse: async () => ({ sessions: use([['op', 9000], ['bot', 9000], ['lead', 9000], ['ask', 9000], ['x', 700], ['y', 200]]) }),
    sleepSession: async (s) => slept.push(s.session_id),
    residents: async () => new Set(['help-desk']),
    isOperator: (s) => s.session_id === 'op',
    totalMb: 1000,
    now: () => t,
  });
  const out = await r.check(crit(MEM));
  assert.deepEqual(slept, ['x', 'y']);
  assert.deepEqual(out.map((d) => [d.id, d.rssMb]), [['x', 700], ['y', 200]]);
  t += RELIEF_EVERY_MS - 1;
  assert.deepEqual(await r.check(crit(MEM)), [], 'paced');
  assert.equal(r.recent().length, 2);
  t += 2 * 60 * 60 * 1000;
  assert.equal(r.recent().length, 0, 'an hour later it is history');
});
