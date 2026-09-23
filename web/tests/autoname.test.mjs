import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAutoNamer, isGenericTmuxName, parseNameOutput, syncGenericTmux, tmuxNameFor } from '../lib/autoname.mjs';
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

test('fleet CLI nameAll runs `fleet name --all --apply --no-tmux-sync` with NO_COLOR (dry run: `-n name --all`)', async () => {
  const calls = [];
  const run = async (bin, args, opts) => (calls.push({ bin, args, opts }), { stdout: 'x', stderr: '' });
  const cli = createFleetCli({ run, bin: '/x/fleet' });
  assert.deepEqual(await cli.nameAll(), { stdout: 'x', stderr: '' });
  assert.deepEqual(calls[0].args, ['name', '--all', '--apply', '--no-tmux-sync']);
  assert.equal(calls[0].bin, '/x/fleet');
  assert.equal(calls[0].opts.env.NO_COLOR, '1');
  await cli.nameAll({ dryRun: true });
  assert.deepEqual(calls[1].args, ['-n', 'name', '--all']);
  const missing = createFleetCli({ run: async () => { throw Object.assign(new Error('spawn'), { code: 'ENOENT' }); } });
  await assert.rejects(missing.nameAll(), /not found/);
});

test('runOnce calls the CLI once for concurrent runs, syncs tmux and records lastRun', async () => {
  let n = 0;
  const cli = {
    nameAll: async () => {
      n += 1;
      await new Promise((r) => setTimeout(r, 5));
      return { stdout: 'app-1a  →  fix-login-flow\n', stderr: '' };
    },
  };
  let listed = 0;
  const an = createAutoNamer({ cli, run: async () => ({ stdout: '', stderr: '' }), listSessions: async () => (listed++, []), sleep: async () => {} });
  const [a, b] = await Promise.all([an.runOnce('manual'), an.runOnce('manual')]);
  assert.equal(a, b);
  assert.equal(n, 1);
  assert.equal(listed, 1);
  assert.equal(an.lastRun.ok, true);
  assert.equal(an.lastRun.reason, 'manual');
  assert.equal(an.lastRun.renamed[0].to, 'fix-login-flow');
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

test('isGenericTmuxName: fw-hhmmss, numeric and <cwd>-9d are generic, hand-picked names are not', () => {
  assert.equal(isGenericTmuxName('fw-101010'), true);
  assert.equal(isGenericTmuxName('3'), true);
  assert.equal(isGenericTmuxName('app-9d', '/home/u/Code/app'), true);
  assert.equal(isGenericTmuxName('app-9d', '/home/u/Code/notes'), false);
  assert.equal(isGenericTmuxName('fix-login', '/home/u/Code/app'), false);
  assert.equal(isGenericTmuxName('plain', '/home/u/Code/app'), false);
  assert.equal(isGenericTmuxName('pr-12', '/home/u/Code/app'), false);
  assert.equal(isGenericTmuxName('my.app-1f', '/home/u/my.app'), true, 'regex metacharacters in the cwd are literal');
  assert.equal(isGenericTmuxName('myxapp-1f', '/home/u/my.app'), false);
  assert.equal(isGenericTmuxName('', '/x'), false);
});

test('tmuxNameFor sanitizes and dedupes', () => {
  assert.equal(tmuxNameFor('Fix Login: flow.1'), 'fix-login-flow-1');
  assert.equal(tmuxNameFor('job', ['job', 'job-2']), 'job-3');
  assert.equal(tmuxNameFor('!!!'), '');
});

test('syncGenericTmux renames only generic, single-window tmux sessions of user-named Claude sessions', async () => {
  const calls = [];
  const run = async (bin, args) => {
    calls.push(args);
    if (args[0] === 'list-sessions') return { stdout: 'fw-101010\nfix-login\nshared\n', stderr: '' };
    if (args[0] === 'list-windows') return { stdout: args[2] === '%4' ? '@1\n@2\n' : '@1\n', stderr: '' };
    return { stdout: '', stderr: '' };
  };
  const sessions = [
    { backend: 'tmux', handle: '%1', tmux_session: 'fw-101010', name: 'cache-warmup', name_source: 'user', cwd: '/x/app' },
    { backend: 'tmux', handle: '%2', tmux_session: 'fix-login', name: 'login-retry', name_source: 'user', cwd: '/x/app' },
    { backend: 'tmux', handle: '%3', tmux_session: 'app-9d', name: 'app-9d', name_source: 'derived', cwd: '/x/app' },
    { backend: 'tmux', handle: '%4', tmux_session: '7', name: 'shared-thing', name_source: 'user', cwd: '/x/app' },
    { backend: 'iterm', handle: 'ABC', tmux_session: null, name: 'laptop-thing', name_source: 'user', cwd: '/x/app' },
  ];
  const renames = await syncGenericTmux({ sessions, run });
  assert.deepEqual(renames, [{ from: 'fw-101010', to: 'cache-warmup' }]);
  assert.deepEqual(calls.filter((a) => a[0] === 'rename-session'), [['rename-session', '-t', '%1', 'cache-warmup']]);
});

test('syncGenericTmux without a tmux server renames nothing', async () => {
  const sessions = [{ backend: 'tmux', handle: '%1', tmux_session: 'fw-101010', name: 'x', name_source: 'user' }];
  assert.deepEqual(await syncGenericTmux({ sessions, run: async () => { throw new Error('no server'); } }), []);
});
