import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSnapshot } from '../lib/snapshot.mjs';

function fakeClock() {
  let t = 1000;
  const timers = [];
  return {
    now: () => t,
    advance: (ms) => (t += ms),
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => timer && (timer.cleared = true),
    fire: async () => {
      const due = timers.filter((x) => !x.cleared);
      timers.length = 0;
      for (const x of due) x.fn();
      await new Promise((r) => setImmediate(r));
    },
    pending: () => timers.filter((x) => !x.cleared).length,
  };
}

test('first get waits for a build; later gets are served instantly while a refresh runs behind', async () => {
  const clock = fakeClock();
  let builds = 0;
  const snap = createSnapshot({ build: async () => ({ n: ++builds }), ...clock, refreshMs: 3000 });
  const a = await snap.get();
  assert.deepEqual(a, { n: 1, snapshotAt: 1000 });
  assert.equal(clock.pending(), 1, 'a background refresh is scheduled');
  clock.advance(3000);
  await clock.fire();
  const b = await snap.get();
  assert.equal(b.n, 2);
  assert.equal(b.snapshotAt, 4000);
});

test('stops refreshing once nobody asked for idleAfterMs; the next get serves the old snapshot and wakes it up', async () => {
  const clock = fakeClock();
  let builds = 0;
  const snap = createSnapshot({ build: async () => ({ n: ++builds }), ...clock, refreshMs: 3000, idleAfterMs: 10000 });
  await snap.get();
  clock.advance(11000);
  await clock.fire(); // refresh #2, then it sees nobody asked → no reschedule
  assert.equal(builds, 2);
  assert.equal(clock.pending(), 0);
  const c = await snap.get();
  assert.equal(c.n, 2, 'served immediately from the snapshot');
  await new Promise((r) => setImmediate(r));
  assert.equal(builds, 3, 'and woke the refresher');
});

test('a failed refresh keeps the last snapshot; a failed first build throws', async () => {
  const clock = fakeClock();
  let fail = false;
  const errors = [];
  const snap = createSnapshot({
    build: async () => {
      if (fail) throw new Error('down');
      return { ok: true };
    },
    ...clock,
    logError: (e) => errors.push(e.message),
  });
  await snap.get();
  fail = true;
  const kept = await snap.refresh();
  assert.deepEqual(kept.body, { ok: true });
  assert.deepEqual(errors, ['down']);
  const cold = createSnapshot({ build: async () => { throw new Error('cold'); }, ...fakeClock() });
  await assert.rejects(cold.get(), /cold/);
});

test('concurrent refreshes are de-duplicated and stop() cancels the timer', async () => {
  const clock = fakeClock();
  let builds = 0;
  const snap = createSnapshot({ build: async () => ({ n: ++builds }), ...clock });
  await Promise.all([snap.refresh(), snap.refresh(), snap.get()]);
  assert.equal(builds, 1);
  snap.stop();
  assert.equal(clock.pending(), 0);
});
