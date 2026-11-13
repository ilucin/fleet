import assert from 'node:assert/strict';
import test from 'node:test';

import { createPrStates, stateOf } from '../lib/pr-state.mjs';

test('pr-state: stateOf maps gh output', () => {
  assert.equal(stateOf({ state: 'OPEN', isDraft: true }), 'draft');
  assert.equal(stateOf({ state: 'OPEN', isDraft: false }), 'open');
  assert.equal(stateOf({ state: 'MERGED' }), 'merged');
  assert.equal(stateOf({ state: 'CLOSED' }), 'closed');
  assert.equal(stateOf({}), null);
});

test('pr-state: caches per PR, skips non-PR urls, refreshes stale open ones in the background', async () => {
  let clock = 0;
  const calls = [];
  let answer = { state: 'OPEN', isDraft: true };
  const gh = async (args) => {
    calls.push(args[2]);
    return { stdout: JSON.stringify(answer) };
  };
  const states = createPrStates({ gh, now: () => clock });
  const a = 'https://github.com/o/r/pull/1';
  const got = await states([a, 'https://example.com/x', a]);
  assert.deepEqual([...got], [[a, 'draft']]);
  assert.deepEqual(calls, [a]);

  await states([a]);
  assert.equal(calls.length, 1, 'cached');

  answer = { state: 'MERGED' };
  clock += 10 * 60_000;
  assert.equal((await states([a])).get(a), 'draft', 'stale value served at once');
  await new Promise((r) => setImmediate(r));
  assert.equal((await states([a])).get(a), 'merged');
  assert.equal(calls.length, 2);
});

test('pr-state: a failing or slow gh gives null, not an error', async () => {
  const states = createPrStates({ gh: async () => Promise.reject(new Error('no auth')) });
  const u = 'https://github.com/o/r/pull/2';
  assert.equal((await states([u])).get(u), null);

  const slow = createPrStates({ gh: () => new Promise(() => {}), waitMs: 10 });
  assert.equal((await slow([u])).has(u), false);
});

test('pr-state: headOf gives the head branch once the PR was read', async () => {
  const states = createPrStates({ gh: async () => ({ stdout: JSON.stringify({ state: 'OPEN', isDraft: false, headRefName: 'fix-login' }) }) });
  const u = 'https://github.com/o/r/pull/3';
  assert.equal(states.headOf(u), null);
  await states([u]);
  assert.equal(states.headOf(u), 'fix-login');
  assert.equal(states.headOf('https://example.com/x'), null);
});
