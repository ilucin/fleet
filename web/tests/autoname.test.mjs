import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAutoNamer, parseNameOutput } from '../lib/autoname.mjs';
import { createFleetCli } from '../lib/fleet-cli.mjs';

test('parseNameOutput splits renamed / tmux / held / errors', () => {
  const out = [
    'app-1a  →  fix-login-flow',
    '   ⧉ fix-login → fix-login-flow',
    '⏸ app-4f is mid-turn — nothing sent (--force overrides)',
    '✕ app-01: claude exited 1',
    'app-c4  →  cache-warmup   (llm)',
    '\x1b[2mapp-d5\x1b[0m  →  \x1b[1mrelease-notes\x1b[0m',
  ].join('\n');
  const r = parseNameOutput(out);
  assert.deepEqual(r.renamed, [
    { from: 'app-1a', to: 'fix-login-flow' },
    { from: 'app-c4', to: 'cache-warmup' },
    { from: 'app-d5', to: 'release-notes' },
  ]);
  assert.deepEqual(r.tmux, ['fix-login → fix-login-flow']);
  assert.equal(r.held.length, 1);
  assert.equal(r.errors.length, 1);
  assert.deepEqual(parseNameOutput('no sessions still carry a Claude-derived name — nothing to rename').renamed, []);
});

test('fleet CLI nameAll runs `fleet name --all --apply` (tmux synced by the CLI) with NO_COLOR (dry run: `-n name --all`)', async () => {
  const calls = [];
  const run = async (bin, args, opts) => (calls.push({ bin, args, opts }), { stdout: 'x', stderr: '' });
  const cli = createFleetCli({ run, bin: '/x/fleet' });
  assert.deepEqual(await cli.nameAll(), { stdout: 'x', stderr: '' });
  assert.deepEqual(calls[0].args, ['name', '--all', '--apply']);
  assert.equal(calls[0].bin, '/x/fleet');
  assert.equal(calls[0].opts.env.NO_COLOR, '1');
  await cli.nameAll({ dryRun: true });
  assert.deepEqual(calls[1].args, ['-n', 'name', '--all']);
  const missing = createFleetCli({ run: async () => { throw Object.assign(new Error('spawn'), { code: 'ENOENT' }); } });
  await assert.rejects(missing.nameAll(), /not found/);
});

test('runOnce calls the CLI once for concurrent runs and records lastRun (tmux lines come from the CLI)', async () => {
  let n = 0;
  const cli = {
    nameAll: async () => {
      n += 1;
      await new Promise((r) => setTimeout(r, 5));
      return { stdout: 'app-1a  →  fix-login-flow\n   ⧉ fw-101010 → fix-login-flow\n', stderr: '' };
    },
  };
  const an = createAutoNamer({ cli });
  const [a, b] = await Promise.all([an.runOnce('manual'), an.runOnce('manual')]);
  assert.equal(a, b);
  assert.equal(n, 1);
  assert.equal(an.lastRun.ok, true);
  assert.equal(an.lastRun.reason, 'manual');
  assert.equal(an.lastRun.renamed[0].to, 'fix-login-flow');
  assert.deepEqual(an.lastRun.tmux, ['fw-101010 → fix-login-flow']);
});

test('runOnce records failures without throwing', async () => {
  const an = createAutoNamer({ cli: { nameAll: async () => { throw new Error('boom'); } } });
  const r = await an.runOnce('scheduled');
  assert.equal(r.ok, false);
  assert.match(r.error, /boom/);
  assert.deepEqual(r.renamed, []);
});

test('start schedules a first run after the initial delay, stop cancels it', async () => {
  let n = 0;
  const an = createAutoNamer({ cli: { nameAll: async () => (n++, { stdout: '', stderr: '' }) }, initialDelayMs: 5, intervalMs: 60000 });
  an.start();
  await new Promise((r) => setTimeout(r, 40));
  an.stop();
  assert.equal(n, 1);
  assert.equal(an.lastRun.reason, 'scheduled');
});
