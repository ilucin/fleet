import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSpawner, isWithin, launchCommand, resolveAllowedDir, sanitizeName, shq, validateSpawnRequest } from '../lib/spawn.mjs';

test('shq quotes like the fleet CLI', () => {
  assert.equal(shq('a b'), "'a b'");
  assert.equal(shq("it's"), "'it'\\''s'");
});

test('sanitizeName mirrors fleet tmux new', () => {
  assert.equal(sanitizeName('  Fix Login Bug! '), 'fix-login-bug');
  assert.equal(sanitizeName('---'), '');
  assert.equal(sanitizeName('x'.repeat(60)).length, 40);
});

test('launchCommand builds claude -n name [prompt]', () => {
  assert.equal(launchCommand({ name: 'job', prompt: '' }), "claude -n 'job'");
  assert.equal(launchCommand({ launcher: 'cc', name: 'job', prompt: "do it's" }), "cc -n 'job' 'do it'\\''s'");
});

test('validateSpawnRequest defaults, sanitizes and rejects bad input', () => {
  const ok = validateSpawnRequest({ name: 'My Job', prompt: 'hi' }, { spawnDirs: ['/tmp'] });
  assert.equal(ok.ok, true);
  assert.equal(ok.name, 'my-job');
  assert.equal(ok.dir, '/tmp');
  const auto = validateSpawnRequest({}, { spawnDirs: ['/tmp'] });
  assert.match(auto.name, /^fw-\d{6}$/);
  assert.equal(validateSpawnRequest({ dir: 'relative' }).ok, false);
  assert.equal(validateSpawnRequest({ prompt: 'x'.repeat(8001) }, { spawnDirs: ['/tmp'] }).ok, false);
  assert.equal(validateSpawnRequest({}, { spawnDirs: [] }).ok, false);
});

test('spawner creates the tmux session then types the launcher', async () => {
  const calls = [];
  const run = async (bin, args) => {
    calls.push([bin, ...args]);
    if (args[0] === 'has-session') throw new Error('no such session');
    return { stdout: '', stderr: '' };
  };
  const sp = createSpawner({ run, tmux: 'tmux', launcher: 'claude', sleep: async () => {} });
  const res = await sp.spawn({ name: 'job', dir: '/tmp', prompt: 'go' });
  assert.equal(res.tmuxSession, 'job');
  assert.deepEqual(calls[0], ['tmux', 'has-session', '-t', '=job']);
  assert.deepEqual(calls[1], ['tmux', 'new-session', '-d', '-s', 'job', '-c', '/tmp']);
  assert.deepEqual(calls[2], ['tmux', 'send-keys', '-t', 'job:', '-l', '--', "claude -n 'job' 'go'"]);
  assert.deepEqual(calls[3], ['tmux', 'send-keys', '-t', 'job:', 'Enter']);
  assert.equal(res.trusted, false);
});

test('spawner accepts the folder-trust prompt when it appears', async () => {
  const calls = [];
  let captures = 0;
  const run = async (bin, args) => {
    calls.push(args);
    if (args[0] === 'has-session') throw new Error('no such session');
    if (args[0] === 'capture-pane') {
      captures += 1;
      if (captures < 2) return { stdout: 'starting…', stderr: '' };
      const downs = calls.filter((a) => a[0] === 'send-keys' && a[a.length - 1] === 'Down').length;
      return { stdout: downs === 0 ? '❯ No, exit\n  Yes, I trust this folder\n' : '  No, exit\n❯ Yes, I trust this folder\n', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };
  const sp = createSpawner({ run, sleep: async () => {} });
  const res = await sp.spawn({ name: 'job', dir: '/tmp', prompt: '' });
  assert.equal(res.trusted, true);
  const keys = calls.filter((a) => a[0] === 'send-keys').map((a) => a[a.length - 1]);
  assert.deepEqual(keys, ["claude -n 'job'", 'Enter', 'Down', 'Enter']);
});

test('spawner refuses an existing tmux session and a missing dir', async () => {
  const run = async () => ({ stdout: '', stderr: '' });
  const sp = createSpawner({ run, sleep: async () => {} });
  await assert.rejects(sp.spawn({ name: 'job', dir: '/tmp', prompt: '' }), (e) => e.status === 409);
  await assert.rejects(sp.spawn({ name: 'job', dir: '/definitely/not/here', prompt: '' }), (e) => e.status === 400);
});

test('isWithin is path-segment aware', () => {
  assert.equal(isWithin('/a/b', '/a/b'), true);
  assert.equal(isWithin('/a/b/c', '/a/b'), true);
  assert.equal(isWithin('/a/bc', '/a/b'), false);
  assert.equal(isWithin('/a', '/a/b'), false);
});

test('resolveAllowedDir allows roots and subdirs, rejects .. and symlink escapes', async (t) => {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'fleet-spawn-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'root');
  const outside = path.join(base, 'outside');
  mkdirSync(path.join(root, 'sub'), { recursive: true });
  mkdirSync(outside);
  symlinkSync(outside, path.join(root, 'link-out'));
  symlinkSync(path.join(root, 'sub'), path.join(base, 'link-in'));

  assert.equal(await resolveAllowedDir(root, [root]), root);
  assert.equal(await resolveAllowedDir(path.join(root, 'sub'), [root]), path.join(root, 'sub'));
  assert.equal(await resolveAllowedDir(path.join(base, 'link-in'), [root]), path.join(root, 'sub'), 'symlink into a root is fine');
  const bad = (e) => e.status === 400;
  await assert.rejects(resolveAllowedDir(outside, [root]), bad);
  await assert.rejects(resolveAllowedDir(path.join(root, '..', 'outside'), [root]), bad);
  await assert.rejects(resolveAllowedDir(path.join(root, 'link-out'), [root]), bad);
  await assert.rejects(resolveAllowedDir(path.join(root, 'missing'), [root]), bad);
  await assert.rejects(resolveAllowedDir(root, [path.join(base, 'nope')]), bad, 'a missing root allows nothing');
  // No spawnDirs: $HOME subtree only.
  assert.equal(await resolveAllowedDir(path.join(root, 'sub'), [], { home: base }), path.join(root, 'sub'));
  await assert.rejects(resolveAllowedDir('/', [], { home: base }), bad);
});
