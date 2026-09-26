// Smart grouping: the scheduler (lib/grouping.mjs), /api/groups served by the grouping host
// and proxied from peers, the config keys, and `run`'s stdin. The `fleet` CLI is faked.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createApi } from '../lib/api.mjs';
import { createHttpServer } from '../lib/app.mjs';
import { createFleet } from '../lib/fleet.mjs';
import { createFleetCli } from '../lib/fleet-cli.mjs';
import { normalizeConfig } from '../lib/config.mjs';
import { createGrouper, liveKeys, memberKeys } from '../lib/grouping.mjs';
import { run } from '../lib/run.mjs';

const HOME = '/home/tester';

function report(groups, lastRun = { mode: 'incremental', ok: true, modelCalls: 1, classified: 2 }) {
  return { version: 1, applied: true, updatedAt: 42, lastRun, groups, ungrouped: [], hosts: {} };
}

const BOARD = { id: 'g-1', label: 'Fleet Board', description: 'Kanban', source: 'llm', members: [{ host: 'laptop', id: 'a1', name: 'board' }] };

function fakeCli({ fail = false } = {}) {
  const calls = [];
  return {
    calls,
    groupCached: async () => (calls.push(['cached']), report([BOARD], { mode: 'noop', ok: true, modelCalls: 0, classified: 0 })),
    groupRun: async ({ fleet, refresh }) => {
      calls.push(['run', fleet, refresh]);
      if (fail) throw new Error('fleet group timed out after 300s');
      return report([BOARD, { id: 'g-2', label: 'Team Reviews', description: null, source: 'llm', members: [{ host: 'workstation', id: 'b1' }] }]);
    },
  };
}

const FLEET = {
  self: 'laptop',
  hosts: [
    { name: 'laptop', ok: true, sessions: [{ host: 'laptop', session_id: 'a1' }] },
    { name: 'workstation', ok: true, sessions: [{ host: 'workstation', session_id: 'b1' }] },
    { name: 'down', ok: false, sessions: [{ host: 'down', session_id: 'z' }] },
  ],
};

test('liveKeys / memberKeys', () => {
  assert.deepEqual([...liveKeys(FLEET)], ['laptop/a1', 'workstation/b1']);
  assert.deepEqual([...memberKeys(report([BOARD]))], ['laptop/a1']);
});

test('grouper: stored groups first, a run feeds the fleet to the CLI and reports lastRun', async () => {
  const cli = fakeCli();
  let t = 1000;
  const g = createGrouper({ cli, getFleet: async () => FLEET, self: 'laptop', now: () => t, intervalMs: 600000 });
  await g.loadCached();
  let r = g.response();
  assert.equal(r.enabled, true);
  assert.equal(r.host, 'laptop');
  assert.equal(r.intervalMinutes, 10);
  assert.equal(r.groups.length, 1);
  assert.deepEqual(r.groups[0].members, [{ host: 'laptop', id: 'a1' }], 'members reduced to host/id');
  assert.equal(r.lastRun.reason, 'stored');

  const a = g.runOnce('manual');
  const b = g.runOnce('manual');
  assert.equal(a, b, 'concurrent runs are de-duplicated');
  t = 1500;
  r = await a;
  assert.equal(cli.calls.filter((c) => c[0] === 'run').length, 1);
  assert.equal(cli.calls.at(-1)[1], FLEET);
  assert.equal(r.groups.length, 2);
  assert.equal(r.running, false);
  assert.equal(r.updatedAt, 42);
  assert.deepEqual(
    { ...r.lastRun },
    { at: 1000, ms: 500, ok: true, reason: 'manual', mode: 'incremental', modelCalls: 1, classified: 2 },
  );
});

test('grouper: a failing run keeps the last groups and reports the error', async () => {
  const g = createGrouper({ cli: fakeCli({ fail: true }), getFleet: async () => FLEET });
  await g.loadCached();
  const r = await g.runOnce('scheduled');
  assert.equal(r.lastRun.ok, false);
  assert.match(r.lastRun.error, /timed out/);
  assert.equal(r.groups.length, 1, 'stored groups survive');
});

test('grouper: the change check runs early only for unknown live sessions, never discovers', async () => {
  const cli = fakeCli();
  let t = 0;
  let peek = null;
  let built = 0;
  const g = createGrouper({
    cli,
    getFleet: async () => (built++, FLEET),
    peekFleet: () => peek,
    now: () => t,
    minGapMs: 1000,
  });
  await g.loadCached();
  assert.equal(await g.checkChanges(), false, 'no snapshot → nothing');
  peek = { hosts: [{ name: 'laptop', ok: true, sessions: [{ host: 'laptop', session_id: 'a1' }] }] };
  assert.equal(await g.checkChanges(), false, 'every live session is known');
  assert.equal(built, 0);
  peek = FLEET; // workstation/b1 is new
  assert.equal(await g.checkChanges(), true);
  assert.equal(cli.calls.at(-1)[0], 'run');
  assert.equal(g.lastRun.reason, 'changes');
  peek = { hosts: [{ name: 'laptop', ok: true, sessions: [{ host: 'laptop', session_id: 'new' }] }] };
  t = 500;
  assert.equal(await g.checkChanges(), false, 'within the minimum gap');
  t = 5000;
  assert.equal(await g.checkChanges(), true);
});

test('fleet-cli groupRun pipes the fleet on stdin and parses the report', async () => {
  const seen = [];
  const cli = createFleetCli({
    run: async (bin, args, opts) => (seen.push({ args, opts }), { stdout: JSON.stringify(report([BOARD])), stderr: '' }),
  });
  const r = await cli.groupRun({ fleet: FLEET, refresh: true });
  assert.equal(r.groups[0].id, 'g-1');
  assert.deepEqual(seen[0].args, ['group', '--input', '-', '--apply', '--json', '--refresh']);
  assert.deepEqual(JSON.parse(seen[0].opts.input), FLEET);
  const bad = createFleetCli({ run: async () => ({ stdout: 'nope', stderr: '' }) });
  await assert.rejects(bad.groupRun({ fleet: FLEET }), /non-JSON/);
  const cached = createFleetCli({ run: async (b, args) => (seen.push({ args }), { stdout: '{"groups":[]}', stderr: '' }) });
  await cached.groupCached();
  assert.deepEqual(seen.at(-1).args, ['group', '--cached', '--json']);
});

test('run() writes opts.input to the child stdin', async () => {
  const { stdout } = await run(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { input: 'hello' });
  assert.equal(stdout, 'hello');
});

test('config: web.grouping is opt-in, grouping.host makes one host authoritative', () => {
  const n = (raw, env = {}) => normalizeConfig(raw, { env, home: HOME }).grouping;
  assert.deepEqual(n({}), { enabled: false, intervalMinutes: 10, host: null });
  assert.deepEqual(n({ self: 'laptop', web: { grouping: { enabled: true, intervalMinutes: 3 } } }), {
    enabled: true,
    intervalMinutes: 3,
    host: null,
  });
  assert.equal(n({ self: 'laptop', web: { grouping: { enabled: true } }, grouping: { host: 'laptop' } }).enabled, true);
  // Enabled here but another host is the grouping host: this one stays off.
  assert.equal(n({ self: 'laptop', web: { grouping: { enabled: true } }, grouping: { host: 'workstation' } }).enabled, false);
  assert.equal(n({ self: 'laptop' }, { FLEET_WEB_GROUPING: '1' }).enabled, true);
  assert.throws(() => n({ web: { grouping: { enabled: 'yes' } } }), /grouping.enabled/);
  assert.throws(() => n({ web: { grouping: { intervalMinutes: 0 } } }), /intervalMinutes/);
  assert.throws(() => n({ grouping: { host: '' } }), /grouping.host/);
});

// --- over HTTP: laptop runs grouping, workstation proxies to it -------------------------

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

async function startPair(t, { workstationGrouping = {} } = {}) {
  const hosts = {
    laptop: [{ session_id: 'a1', name: 'board', status: 'idle', backend: 'tmux' }],
    workstation: [{ session_id: 'b1', name: 'review', status: 'idle', backend: 'tmux' }],
  };
  const servers = {};
  const urls = {};
  const handles = {};
  for (const name of Object.keys(hosts)) {
    servers[name] = createHttpServer({ handleApi: (req, url) => handles[name](req, url), uiDir: null });
    urls[name] = await listen(servers[name]);
    t.after(() => servers[name].close());
  }
  const groupCli = fakeCli();
  for (const name of Object.keys(hosts)) {
    const raw = {
      self: name,
      hosts: { laptop: { web: urls.laptop }, workstation: { web: urls.workstation } },
      web: name === 'laptop' ? { grouping: { enabled: true } } : {},
      ...(name === 'workstation' ? { grouping: workstationGrouping } : {}),
    };
    const config = normalizeConfig(raw, { env: {}, home: HOME });
    const cli = createFleetCli({ run: async () => ({ stdout: JSON.stringify(hosts[name]), stderr: '' }) });
    const fleet = createFleet({ cli, self: name });
    let api = null;
    const grouper = config.grouping.enabled
      ? createGrouper({ cli: groupCli, getFleet: () => api.buildFleet(), peekFleet: () => api.peekFleet(), self: name })
      : null;
    api = createApi({ config, fleet, backend: {}, transcripts: {}, spawner: {}, grouper, warmFleet: false });
    t.after(() => api.stop());
    handles[name] = api;
  }
  return { urls, groupCli };
}

async function get(url) {
  const res = await fetch(url);
  return { status: res.status, body: await res.json() };
}
async function post(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

test('/api/groups: served by the grouping host, proxied by grouping.host, runs over the merged fleet', async (t) => {
  const { urls, groupCli } = await startPair(t, { workstationGrouping: { host: 'laptop' } });
  const empty = await get(`${urls.laptop}/api/groups`);
  assert.equal(empty.status, 200);
  assert.equal(empty.body.enabled, true);
  assert.deepEqual(empty.body.groups, []);

  const ran = await post(`${urls.workstation}/api/groups/run`, {});
  assert.equal(ran.status, 200);
  assert.equal(ran.body.host, 'laptop');
  assert.equal(ran.body.lastRun.reason, 'manual');
  const fed = groupCli.calls.at(-1)[1];
  assert.deepEqual(
    fed.hosts.map((h) => [h.name, h.sessions.map((s) => s.session_id)]),
    [
      ['laptop', ['a1']],
      ['workstation', ['b1']],
    ],
    'the CLI gets every host, fetched over HTTP',
  );

  const viaPeer = await get(`${urls.workstation}/api/groups`);
  assert.equal(viaPeer.status, 200);
  assert.equal(viaPeer.body.host, 'laptop');
  assert.deepEqual(viaPeer.body.groups.map((g) => g.label), ['Fleet Board', 'Team Reviews']);

  const h = await get(`${urls.laptop}/api/health`);
  assert.equal(h.body.grouping.enabled, true);
  assert.equal(h.body.grouping.lastRun.reason, 'manual');
  assert.equal((await get(`${urls.laptop}/api/groups/run`)).status, 405);
  assert.equal((await post(`${urls.laptop}/api/groups`, {})).status, 405);
});

test('/api/groups: without grouping.host a peer finds the grouping host itself', async (t) => {
  const { urls } = await startPair(t);
  const r = await get(`${urls.workstation}/api/groups`);
  assert.equal(r.body.enabled, true);
  assert.equal(r.body.host, 'laptop');
});

test('/api/groups: nobody runs grouping → disabled response and 501 on run', async () => {
  const config = normalizeConfig({ self: 'solo' }, { env: {}, home: HOME });
  const cli = createFleetCli({ run: async () => ({ stdout: '[]', stderr: '' }) });
  const api = createApi({ config, fleet: createFleet({ cli, self: 'solo' }), backend: {}, transcripts: {}, spawner: {}, warmFleet: false });
  const r = await api({ method: 'GET', headers: {} }, new URL('http://x/api/groups'));
  assert.equal(r.status, 200);
  assert.equal(r.body.enabled, false);
  assert.deepEqual(r.body.groups, []);
  const req = Object.assign(new (await import('node:stream')).PassThrough(), { method: 'POST', headers: {} });
  req.end('{}');
  await assert.rejects(api(req, new URL('http://x/api/groups/run')), (err) => err.status === 501);
});
