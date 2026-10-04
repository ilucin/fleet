// Dormant sessions on the web side: lib/fleet-cli.mjs `restore`, lib/dormant.mjs (argv, error
// mapping, restore.onBoot) and the /api/hosts/:host/dormant… routes. The `fleet` CLI is faked;
// the peer pair runs on 127.0.0.1 ephemeral ports. Nothing here starts tmux or claude.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createApi } from '../lib/api.mjs';
import { createHttpServer } from '../lib/app.mjs';
import { createFleet } from '../lib/fleet.mjs';
import { createFleetCli } from '../lib/fleet-cli.mjs';
import { normalizeConfig } from '../lib/config.mjs';
import { HttpError } from '../lib/http.mjs';
import { ambiguityCandidates, createDormant, dormantHttpError, validateDormantRequest } from '../lib/dormant.mjs';

const SID = 'aaaaaaaa-0000-0000-0000-000000000001';

/** `fleet restore --json` (docs/cli.md → Session recovery). */
function dormantList(host, bootId = '1727000000') {
  return {
    host,
    bootId,
    dormant: [
      { kind: 'tmux', target: 'fleet-test-a', name: 'fleet-test-a', since: '2026-10-01T10:00:00Z', windows: 1, panes: 2, sessions: [{ sessionId: SID, name: 'fix', title: 'Fix login', cwd: '~/Code/project' }] },
      { kind: 'tmux', target: 'fleet-test-b', name: 'fleet-test-b', since: '2026-10-01T10:00:00Z', windows: 1, panes: 1, sessions: [] },
    ],
  };
}

const cliError = (code, stderr, stdout = '') => Object.assign(new Error(stderr || `exit ${code}`), { code, stderr, stdout });

/** A fake `fleet` binary: `list --json` and `--local restore --json …`, every call recorded. */
function fakeRun(self, { bootId } = {}) {
  const calls = [];
  const run = async (bin, args) => {
    calls.push(args);
    const out = (v) => ({ stdout: JSON.stringify(v), stderr: '' });
    if (args[0] === 'list') return out([]);
    assert.deepEqual(args.slice(0, 3), ['--local', 'restore', '--json'], `unexpected fleet call ${args.join(' ')}`);
    const rest = args.slice(3);
    const dry = rest.includes('--dry-run');
    const restored = (name) => ({ kind: 'tmux', from: name, session: name, renamed: false, windows: 1, panes: 1, launched: [], warnings: [], commands: [], dryRun: dry });
    if (!rest.length) return out(dormantList(self, bootId));
    if (rest.includes('--all')) {
      // One fails: exit 1, the report still on stdout.
      throw cliError(1, 'Error: 1 restore failed', JSON.stringify({ host: self, restored: [restored('fleet-test-a')], failed: [{ target: 'fleet-test-b', error: 'tmux: boom' }] }));
    }
    if (rest.includes('--forget-all')) return out({ host: self, forgotten: ['fleet-test-a', 'fleet-test-b'] });
    const forget = rest.find((a) => a.startsWith('--forget='));
    const target = forget ? forget.slice('--forget='.length) : rest[rest.indexOf('--') + 1];
    if (target === 'fleet-test') throw cliError(2, 'Error: "fleet-test" matches 2 dormant sessions: fleet-test-a, fleet-test-b — be more specific');
    if (target === 'broken') throw cliError(1, 'Error: restore failed', JSON.stringify({ host: self, restored: [], failed: [{ target, error: 'cwd gone' }] }));
    if (!target.startsWith('fleet-test-')) throw cliError(3, `Error: no dormant session matches "${target}"`);
    return out(forget ? { host: self, forgotten: [target] } : { host: self, restored: [restored(target)], failed: [] });
  };
  return { calls, run };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

async function startPair(t, { withDormant = true } = {}) {
  const hosts = {};
  const urls = {};
  const handles = {};
  for (const name of ['laptop', 'workstation']) {
    const fake = fakeRun(name);
    const cli = createFleetCli({ run: fake.run });
    const logs = [];
    hosts[name] = { ...fake, cli, logs, dormant: withDormant ? createDormant({ cli, log: (l) => logs.push(l) }) : null };
    const server = createHttpServer({ handleApi: (req, url) => handles[name](req, url) });
    urls[name] = await listen(server);
    t.after(() => server.close());
  }
  for (const name of ['laptop', 'workstation']) {
    const config = normalizeConfig(
      { self: name, hosts: { laptop: { web: urls.laptop }, workstation: { web: urls.workstation } } },
      { env: {}, home: '/home/tester' },
    );
    const h = hosts[name];
    const api = createApi({
      config,
      fleet: createFleet({ cli: h.cli, self: name }),
      backend: {},
      transcripts: {},
      spawner: {},
      cli: h.cli,
      dormant: h.dormant,
      warmFleet: false,
    });
    t.after(() => api.stop());
    handles[name] = api;
  }
  return { hosts, urls };
}

async function call(url, method = 'GET', body) {
  const res = await fetch(url, body === undefined ? { method } : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

test('validateDormantRequest: a one-line target or all: true; dryRun only for restore', () => {
  assert.deepEqual(validateDormantRequest({ target: ' fleet-test-a ' }), { all: false, target: 'fleet-test-a', dryRun: false });
  assert.deepEqual(validateDormantRequest({ all: true, dryRun: true }, { allowDryRun: true }), { all: true, target: null, dryRun: true });
  assert.equal(validateDormantRequest({ target: 'x', dryRun: true }).dryRun, false);
  for (const bad of [{}, null, { target: '' }, { target: 'a\nb' }, { target: 5 }, { target: 'x'.repeat(201) }, { all: true, target: 'x' }, { all: 'yes' }]) {
    assert.throws(() => validateDormantRequest(bad), (e) => e instanceof HttpError && e.status === 400, JSON.stringify(bad));
  }
});

test('dormantHttpError: ambiguous → 409 with candidates, no match → 404, timeout → 504, old CLI → 501', () => {
  assert.deepEqual(ambiguityCandidates('"q" matches 2 dormant sessions: a-1, b-2 — be more specific'), ['a-1', 'b-2']);
  assert.deepEqual(ambiguityCandidates('something else'), []);
  const amb = dormantHttpError(Object.assign(new Error('"q" matches 2 dormant sessions: a, b — be more specific'), { exitCode: 2 }));
  assert.equal(amb.status, 409);
  assert.deepEqual(amb.body.candidates, ['a', 'b']);
  assert.equal(dormantHttpError(Object.assign(new Error('no dormant session matches "x"'), { exitCode: 3 })).status, 404);
  assert.equal(dormantHttpError(Object.assign(new Error('slow'), { timedOut: true })).status, 504);
  assert.equal(dormantHttpError(Object.assign(new Error('x'), { missing: true })).status, 501);
  assert.equal(dormantHttpError(new Error('boom')).status, 502);
});

test('fleet CLI restore: `--local restore --json …`, the target after `--`, forget as --forget=', async () => {
  const { calls, run } = fakeRun('laptop');
  const d = createDormant({ cli: createFleetCli({ run }) });
  await d.list();
  await d.restore({ target: 'fleet-test-a' });
  await d.restore({ target: 'fleet-test-a', dryRun: true });
  await d.forget({ target: 'fleet-test-a' });
  await d.forget({ all: true });
  assert.deepEqual(calls, [
    ['--local', 'restore', '--json'],
    ['--local', 'restore', '--json', '--', 'fleet-test-a'],
    ['--local', 'restore', '--json', '--dry-run', '--', 'fleet-test-a'],
    ['--local', 'restore', '--json', '--forget=fleet-test-a'],
    ['--local', 'restore', '--json', '--forget-all'],
  ]);
});

test('fleet CLI restore: an old binary without `restore` → 501', async () => {
  const cli = createFleetCli({ run: async () => { throw cliError(2, "error: unrecognized subcommand 'restore'"); } });
  await assert.rejects(createDormant({ cli }).list(), (e) => e.status === 501);
});

test('GET dormant: the CLI JSON, served locally or proxied once to the peer', async (t) => {
  const { hosts, urls } = await startPair(t);
  const local = await call(`${urls.laptop}/api/hosts/laptop/dormant`);
  assert.equal(local.status, 200);
  assert.deepEqual(local.body, dormantList('laptop'));
  const remote = await call(`${urls.laptop}/api/hosts/workstation/dormant`);
  assert.equal(remote.status, 200);
  assert.equal(remote.body.host, 'workstation');
  assert.deepEqual(hosts.workstation.calls.at(-1), ['--local', 'restore', '--json']);
  assert.equal((await call(`${urls.laptop}/api/hosts/nowhere/dormant`)).status, 404);
  assert.equal((await call(`${urls.laptop}/api/hosts/laptop/dormant`, 'POST', {})).status, 405);
  assert.equal((await call(`${urls.laptop}/api/hosts/laptop/dormant/restore`)).status, 405);
});

test('POST dormant/restore: one target, dry run, ambiguity 409 with candidates, unknown 404, bad body 400', async (t) => {
  const { hosts, urls } = await startPair(t);
  const base = `${urls.laptop}/api/hosts/workstation/dormant/restore`;
  const ok = await call(base, 'POST', { target: 'fleet-test-a' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.restored[0].session, 'fleet-test-a');
  assert.match(hosts.workstation.logs.at(-1), /restored fleet-test-a/);
  const dry = await call(base, 'POST', { target: 'fleet-test-a', dryRun: true });
  assert.equal(dry.body.restored[0].dryRun, true);
  assert.ok(hosts.workstation.calls.at(-1).includes('--dry-run'));
  const amb = await call(base, 'POST', { target: 'fleet-test' });
  assert.equal(amb.status, 409);
  assert.deepEqual(amb.body.candidates, ['fleet-test-a', 'fleet-test-b']);
  assert.match(amb.body.error, /be more specific/);
  assert.equal((await call(base, 'POST', { target: 'nope' })).status, 404);
  assert.equal((await call(base, 'POST', { target: '' })).status, 400);
  const failed = await call(base, 'POST', { target: 'broken' });
  assert.equal(failed.status, 502);
  assert.equal(failed.body.error, 'cwd gone');
});

test('POST dormant/restore { all: true }: a partial failure is a 200 with the report', async (t) => {
  const { hosts, urls } = await startPair(t);
  const r = await call(`${urls.laptop}/api/hosts/laptop/dormant/restore`, 'POST', { all: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.restored.length, 1);
  assert.deepEqual(r.body.failed, [{ target: 'fleet-test-b', error: 'tmux: boom' }]);
  assert.deepEqual(hosts.laptop.calls.at(-1), ['--local', 'restore', '--json', '--all']);
  assert.match(hosts.laptop.logs.at(-1), /failed fleet-test-b: tmux: boom/);
});

test('POST dormant/forget: a target or all; no dormant module → 501', async (t) => {
  const { urls } = await startPair(t);
  const one = await call(`${urls.laptop}/api/hosts/laptop/dormant/forget`, 'POST', { target: 'fleet-test-b' });
  assert.deepEqual(one.body, { host: 'laptop', forgotten: ['fleet-test-b'] });
  const all = await call(`${urls.laptop}/api/hosts/workstation/dormant/forget`, 'POST', { all: true });
  assert.deepEqual(all.body.forgotten, ['fleet-test-a', 'fleet-test-b']);
  const { urls: bare } = await startPair(t, { withDormant: false });
  const r = await call(`${bare.laptop}/api/hosts/laptop/dormant`);
  assert.equal(r.status, 501);
});

test('restore.onBoot: restores --all once per boot id (marker file), never throws', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-dormant-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const markerFile = path.join(dir, 'state', 'web-restored-boot');
  const { calls, run } = fakeRun('laptop', { bootId: '42' });
  const logs = [];
  const d = createDormant({ cli: createFleetCli({ run }), log: (l) => logs.push(l) });
  const first = await d.restoreOnBoot({ markerFile });
  assert.equal(first.restored.length, 1);
  assert.deepEqual(calls.at(-1), ['--local', 'restore', '--json', '--all']);
  assert.equal(fs.readFileSync(markerFile, 'utf8').trim(), '42');
  const n = calls.length;
  assert.equal(await d.restoreOnBoot({ markerFile }), null, 'a server restart in the same boot does nothing');
  assert.equal(calls.length, n + 1, 'only the list ran');
  const broken = createDormant({ cli: createFleetCli({ run: async () => { throw new Error('boom'); } }), log: (l) => logs.push(l) });
  assert.equal(await broken.restoreOnBoot({ markerFile }), null);
  assert.match(logs.at(-1), /restore\.onBoot failed/);
});

test('config: restore.onBoot defaults to false; a non-boolean is refused', () => {
  const base = { self: 'laptop' };
  const c = normalizeConfig(base, { env: {}, home: '/home/tester' });
  assert.equal(c.restore.onBoot, false);
  assert.equal(c.restore.markerFile, '/home/tester/.local/state/fleet/web-restored-boot');
  assert.equal(normalizeConfig({ ...base, restore: { onBoot: true } }, { env: {}, home: '/home/tester' }).restore.onBoot, true);
  assert.throws(() => normalizeConfig({ ...base, restore: { onBoot: 'yes' } }, { env: {}, home: '/home/tester' }), /restore\.onBoot/);
});
