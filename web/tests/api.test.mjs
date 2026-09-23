// End-to-end over real HTTP on ephemeral ports: two API servers (laptop + workstation)
// peering with each other, all child processes faked. No network beyond 127.0.0.1.
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

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

function fakeHost(self, sessions) {
  const calls = [];
  const cli = createFleetCli({ run: async () => ({ stdout: JSON.stringify(sessions), stderr: '' }) });
  const backend = {
    peek: async (s, lines) => (calls.push(['peek', s.session_id, lines]), `screen of ${s.name}`),
    send: async (s, text) => void calls.push(['send', s.session_id, text]),
    keys: async (s, key) => void calls.push(['keys', s.session_id, key]),
  };
  const transcripts = { messages: async () => ({ messages: [{ role: 'user', text: 'hi' }], total: 1, truncated: false, updatedAt: 1 }) };
  const spawner = { spawn: async (req) => (calls.push(['spawn', req]), { name: req.name, dir: req.dir, tmuxSession: req.name, command: 'claude', trusted: false }) };
  return { calls, cli, backend, transcripts, spawner, fleet: createFleet({ cli, self }) };
}

async function startPair(t) {
  const uiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-web-ui-'));
  fs.writeFileSync(path.join(uiDir, 'index.html'), '<p>custom ui</p>');
  t.after(() => fs.rmSync(uiDir, { recursive: true, force: true }));

  const lap = fakeHost('laptop', [{ session_id: 'aaaaaaaa-0000-0000-0000-000000000001', name: 'one', status: 'idle', backend: 'tmux', handle: '%1', updated_at: 1 }]);
  const remote = fakeHost('workstation', [{ session_id: 'bbbbbbbb-0000-0000-0000-000000000002', name: 'two', status: 'waiting', backend: 'tmux', handle: '%2', updated_at: 2 }]);

  // Bind first so each side knows the other's URL.
  const servers = {};
  const urls = {};
  const cfgs = {};
  for (const [name, host] of [['laptop', lap], ['workstation', remote]]) {
    let handle = null;
    servers[name] = createHttpServer({ handleApi: (req, url) => handle(req, url), uiDir });
    urls[name] = await listen(servers[name]);
    host.setHandle = (h) => (handle = h);
    t.after(() => servers[name].close());
  }
  for (const [name, host] of [['laptop', lap], ['workstation', remote]]) {
    cfgs[name] = normalizeConfig(
      {
        self: name,
        hosts: { laptop: { web: urls.laptop }, workstation: { web: urls.workstation } },
        spawnDirs: [{ label: 'Tmp', paths: { [name]: os.tmpdir() } }],
      },
      { env: {}, home: '/home/tester' },
    );
    host.setHandle(createApi({ config: cfgs[name], ...host, version: '9.9.9' }));
  }
  return { lap, remote, urls };
}

async function get(url) {
  const res = await fetch(url);
  return { status: res.status, body: await res.json() };
}
async function post(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

test('health and settings', async (t) => {
  const { urls } = await startPair(t);
  const h = await get(`${urls.laptop}/api/health`);
  assert.equal(h.status, 200);
  assert.equal(h.body.self, 'laptop');
  assert.equal(h.body.version, '9.9.9');
  assert.equal(h.body.apiVersion, 1);
  const s = await get(`${urls.laptop}/api/settings`);
  assert.deepEqual(s.body.hosts, ['laptop', 'workstation']);
  assert.ok(s.body.quickReplies.length > 0);
});

test('/api/fleet merges self + peer; ?local=1 does not fetch peers', async (t) => {
  const { urls } = await startPair(t);
  const all = await get(`${urls.laptop}/api/fleet`);
  assert.equal(all.status, 200);
  assert.deepEqual(all.body.hosts.map((h) => h.name), ['laptop', 'workstation']);
  assert.equal(all.body.hosts[1].sessions[0].host, 'workstation');
  assert.equal(all.body.hosts[1].spawnDirs[0].label, 'Tmp', 'peer advertises its own spawnDirs');
  const local = await get(`${urls.workstation}/api/fleet?local=1`);
  assert.deepEqual(local.body.hosts.map((h) => h.name), ['workstation']);
});

test('peek/send/keys are served locally or proxied exactly once', async (t) => {
  const { urls, lap, remote } = await startPair(t);
  const peek = await get(`${urls.laptop}/api/hosts/workstation/sessions/bbbbbbbb/peek?lines=50`);
  assert.equal(peek.status, 200);
  assert.equal(peek.body.host, 'workstation');
  assert.equal(peek.body.text, 'screen of two');
  assert.deepEqual(remote.calls.at(-1), ['peek', 'bbbbbbbb-0000-0000-0000-000000000002', 50]);

  assert.equal((await post(`${urls.laptop}/api/hosts/laptop/sessions/aaaaaaaa/send`, { text: 'go' })).status, 200);
  assert.deepEqual(lap.calls.at(-1), ['send', 'aaaaaaaa-0000-0000-0000-000000000001', 'go']);
  assert.equal((await post(`${urls.laptop}/api/hosts/workstation/sessions/bbbbbbbb/keys`, { key: 'Escape' })).status, 200);
  assert.deepEqual(remote.calls.at(-1), ['keys', 'bbbbbbbb-0000-0000-0000-000000000002', 'Escape']);

  const msgs = await get(`${urls.workstation}/api/hosts/laptop/sessions/aaaaaaaa/messages`);
  assert.equal(msgs.status, 200);
  assert.equal(msgs.body.messages[0].text, 'hi');

  // a request that already went through a proxy is never forwarded again
  const chained = await get(`${urls.laptop}/api/hosts/workstation/sessions/bbbbbbbb/peek?local=1`);
  assert.equal(chained.status, 404);
});

test('spawn validates against this host\'s spawnDirs and proxies to peers', async (t) => {
  const { urls, remote } = await startPair(t);
  const res = await post(`${urls.laptop}/api/hosts/workstation/spawn`, { name: 'My Job', prompt: 'hi' });
  assert.equal(res.status, 200);
  assert.equal(res.body.host, 'workstation');
  assert.equal(res.body.name, 'my-job');
  assert.equal(remote.calls.at(-1)[1].dir, fs.realpathSync(os.tmpdir()));
});

test('spawn rejects dirs outside this host\'s spawnDirs (400)', async (t) => {
  const { urls, remote } = await startPair(t);
  const before = remote.calls.length;
  const outside = await post(`${urls.laptop}/api/hosts/workstation/spawn`, { dir: '/' });
  assert.equal(outside.status, 400);
  assert.match(outside.body.error, /not inside one of this host's spawn dirs/);
  const escape = await post(`${urls.laptop}/api/hosts/workstation/spawn`, { dir: path.join(os.tmpdir(), '..', '..') });
  assert.equal(escape.status, 400);
  assert.equal(remote.calls.length, before, 'nothing spawned');
});

test('errors: unknown host/session/route, bad input, wrong method', async (t) => {
  const { urls } = await startPair(t);
  assert.equal((await get(`${urls.laptop}/api/hosts/nope/sessions/x/peek`)).status, 404);
  assert.equal((await get(`${urls.laptop}/api/hosts/laptop/sessions/zzzzzzzzzz/peek`)).status, 404);
  assert.equal((await get(`${urls.laptop}/api/nope`)).status, 404);
  assert.equal((await post(`${urls.laptop}/api/hosts/laptop/sessions/aaaaaaaa/send`, { text: '' })).status, 400);
  assert.equal((await post(`${urls.laptop}/api/hosts/laptop/sessions/aaaaaaaa/keys`, { key: 'C-c' })).status, 400);
  assert.equal((await get(`${urls.laptop}/api/hosts/laptop/sessions/aaaaaaaa/send`)).status, 405);
  assert.equal((await post(`${urls.laptop}/api/fleet`, {})).status, 405);
});

test('static UI is served from the configured ui dir', async (t) => {
  const { urls } = await startPair(t);
  const res = await fetch(`${urls.laptop}/`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '<p>custom ui</p>');
  assert.equal((await fetch(`${urls.laptop}/missing.js`)).status, 404);
});
