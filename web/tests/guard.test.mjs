import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createHttpServer } from '../lib/app.mjs';
import { normalizeConfig } from '../lib/config.mjs';
import { createRequestGuard, hostnameOf, listenAddresses, loopbackFor, machineNames } from '../lib/guard.mjs';

const req = (headers) => ({ headers });
const guard = createRequestGuard({ names: ['laptop', 'workstation', 'workstation.example', ...machineNames('Workstation.local')] });

test('hostnameOf: name, port, IPv6 brackets, junk', () => {
  assert.equal(hostnameOf('Example.COM:7777'), 'example.com');
  assert.equal(hostnameOf('[::1]:7777'), '::1');
  assert.equal(hostnameOf('100.64.0.1'), '100.64.0.1');
  assert.equal(hostnameOf(''), null);
  assert.equal(hostnameOf(undefined), null);
  assert.equal(hostnameOf('bad host'), null);
});

test('machineNames: the hostname with and without .local', () => {
  assert.deepEqual(machineNames('Workstation.local'), ['workstation.local', 'workstation']);
  assert.deepEqual(machineNames('box'), ['box', 'box.local']);
  assert.deepEqual(machineNames(''), []);
});

test('guard: IPs, loopback names, fleet names, *.ts.net and the hostname pass', () => {
  for (const host of ['100.64.0.1:7777', '127.0.0.1:7777', '[::1]:7777', 'localhost:7777', 'app.localhost', 'laptop:7777', 'workstation.example:7777', 'box.tail1234.ts.net', 'workstation.local:7777', 'WORKSTATION:7777']) {
    assert.equal(guard(req({ host })), null, host);
  }
});

test('guard: an unknown name is refused (DNS rebinding), a missing Host is a bad request', () => {
  const r = guard(req({ host: 'evil.example:7777' }));
  assert.equal(r.status, 403);
  assert.match(r.error, /host not allowed: evil\.example/);
  assert.equal(guard(req({})).status, 400);
});

test('guard: web.allowedHosts adds names, "*" allows any', () => {
  assert.equal(createRequestGuard({ allowedHosts: ['fleet.example'] })(req({ host: 'fleet.example' })), null);
  assert.equal(createRequestGuard({ allowedHosts: ['*'] })(req({ host: 'anything.example' })), null);
});

test('guard: no Origin passes (CLI, curl, peers); same origin passes', () => {
  assert.equal(guard(req({ host: '100.64.0.1:7777' })), null);
  assert.equal(guard(req({ host: '100.64.0.1:7777', origin: 'http://100.64.0.1:7777' })), null);
  assert.equal(guard(req({ host: 'Laptop:7777', origin: 'http://laptop:7777' })), null);
});

test('guard: another origin is refused, a loopback origin (dev server) passes', () => {
  for (const origin of ['https://evil.example', 'http://100.64.0.1:7778', 'null', 'https://box.tail1234.ts.net']) {
    const r = guard(req({ host: '100.64.0.1:7777', origin }));
    assert.equal(r?.status, 403, origin);
    assert.match(r.error, /cross-origin/);
  }
  assert.equal(guard(req({ host: '100.64.0.1:7777', origin: 'http://localhost:5173' })), null);
  assert.equal(guard(req({ host: '127.0.0.1:7777', origin: 'http://127.0.0.1:5173' })), null);
});

test('guard: a fleet name as Origin passes (a reverse proxy rewrites Host)', () => {
  assert.equal(guard(req({ host: '127.0.0.1:7777', origin: 'https://workstation.example' })), null);
  assert.equal(createRequestGuard({ allowedHosts: ['fleet.example'] })(req({ host: '127.0.0.1:7777', origin: 'https://fleet.example' })), null);
});

test('listenAddresses / loopbackFor: a specific address also gets loopback', () => {
  assert.deepEqual(listenAddresses('0.0.0.0'), ['0.0.0.0']);
  assert.deepEqual(listenAddresses('::'), ['::']);
  assert.deepEqual(listenAddresses(''), ['0.0.0.0']);
  assert.deepEqual(listenAddresses('127.0.0.1'), ['127.0.0.1']);
  assert.deepEqual(listenAddresses('localhost'), ['localhost']);
  assert.deepEqual(listenAddresses('100.64.0.1'), ['100.64.0.1', '127.0.0.1']);
  assert.deepEqual(listenAddresses('fd7a:115c:a1e0::1'), ['fd7a:115c:a1e0::1', '::1']);
  assert.equal(loopbackFor('0.0.0.0'), '127.0.0.1');
  assert.equal(loopbackFor('::'), '127.0.0.1');
  assert.equal(loopbackFor('127.0.0.1'), '127.0.0.1');
  assert.equal(loopbackFor('100.64.0.1'), '127.0.0.1');
});

test('normalizeConfig: web.allowedHosts is a list of names', () => {
  const base = { version: 1, self: 'laptop', hosts: { laptop: {} } };
  assert.deepEqual(normalizeConfig(base, { env: { PATH: '' }, home: '/home/tester' }).allowedHosts, []);
  const cfg = normalizeConfig({ ...base, web: { allowedHosts: [' Fleet.Example ', '*'] } }, { env: { PATH: '' }, home: '/home/tester' });
  assert.deepEqual(cfg.allowedHosts, ['fleet.example', '*']);
  assert.throws(() => normalizeConfig({ ...base, web: { allowedHosts: 'fleet.example' } }, { env: { PATH: '' }, home: '/home/tester' }), /allowedHosts/);
});

test('the HTTP server refuses before the API sees the request', async () => {
  let calls = 0;
  const server = createHttpServer({
    handleApi: async () => {
      calls += 1;
      return { status: 200, body: { ok: true } };
    },
    uiDir: null,
    guard: createRequestGuard({ names: [] }),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    assert.equal((await fetch(`${base}/api/health`)).status, 200, 'no Origin: CLI / curl / peers');
    // Node's fetch sends no Origin, the same as the peer proxy: peers keep working.
    const cross = await fetch(`${base}/api/hosts/x/spawn`, { method: 'POST', headers: { origin: 'https://evil.example' }, body: '{}' });
    assert.equal(cross.status, 403);
    assert.match((await cross.json()).error, /cross-origin/);
    // fetch() keeps its own Host; a rebound page's request names the attacker's host.
    const rebound = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/api/health', headers: { host: 'evil.example' } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      }).on('error', reject);
    });
    assert.equal(rebound, 403);
    assert.equal(calls, 1);
  } finally {
    server.close();
  }
});
