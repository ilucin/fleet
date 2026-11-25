import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createCodeProxy, findCodeCli, parseCodePath } from '../lib/code.mjs';
import { codeUrl } from '../lib/editor.mjs';

test('parseCodePath: host and rest, nothing else', () => {
  assert.deepEqual(parseCodePath('/code/laptop/'), { host: 'laptop', rest: '/' });
  assert.deepEqual(parseCodePath('/code/laptop'), { host: 'laptop', rest: '/' });
  assert.deepEqual(parseCodePath('/code/work-1/stable-abc/static/x.js'), { host: 'work-1', rest: '/stable-abc/static/x.js' });
  assert.equal(parseCodePath('/code/'), null);
  assert.equal(parseCodePath('/code/a%2Fb/x'), null);
  assert.equal(parseCodePath('/api/fleet'), null);
});

test('codeUrl: a relative /code/<host>/?folder= url, null when off or not absolute', () => {
  const on = { code: { enabled: true } };
  assert.equal(codeUrl(on, 'laptop', '/home/tester/wt/app feat'), '/code/laptop/?folder=%2Fhome%2Ftester%2Fwt%2Fapp%20feat');
  assert.equal(codeUrl(on, 'laptop', 'rel/path'), null);
  assert.equal(codeUrl(on, 'bad/host', '/x'), null);
  assert.equal(codeUrl({ code: { enabled: false } }, 'laptop', '/x'), null);
  assert.equal(codeUrl({}, 'laptop', '/x'), null);
});

test('findCodeCli: an explicit path, else the newest Remote-SSH CLI', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-code-'));
  assert.equal(findCodeCli({ home, env: { PATH: '' } }), null);
  const dir = path.join(home, '.vscode-server');
  fs.mkdirSync(dir);
  const old = path.join(dir, `code-${'a'.repeat(40)}`);
  const recent = path.join(dir, `code-${'b'.repeat(40)}`);
  fs.writeFileSync(old, '');
  fs.writeFileSync(recent, '');
  fs.utimesSync(old, new Date(1000), new Date(1000));
  assert.equal(findCodeCli({ home, env: { PATH: '' } }), recent);
  assert.equal(findCodeCli({ explicit: old, home }), old);
  assert.equal(findCodeCli({ explicit: path.join(home, 'nope'), home }), null);
  fs.rmSync(home, { recursive: true, force: true });
});

/** A stand-in for `code serve-web`: echoes what it got, and upgrades to an echo socket. */
function fakeServeWeb() {
  let server = null;
  const seen = [];
  const spawnFn = (cli, args) => {
    const socketPath = args[args.indexOf('--socket-path') + 1];
    server = http.createServer((req, res) => {
      seen.push({ url: req.url, headers: req.headers, args });
      res.writeHead(200, { 'content-type': 'application/json', connection: 'keep-alive' });
      res.end(JSON.stringify({ url: req.url, cookie: req.headers.cookie ?? null, origin: req.headers.origin ?? null, host: req.headers.host }));
    });
    server.on('upgrade', (req, socket) => {
      seen.push({ url: req.url, headers: req.headers, upgrade: true });
      socket.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n');
      socket.pipe(socket);
    });
    server.listen(socketPath);
    return { exitCode: null, stdout: null, stderr: null, on() {}, kill: () => server.close() };
  };
  return { spawnFn, seen, close: () => server?.close() };
}

test('the proxy starts serve-web on first use and passes requests and WebSockets through', async (t) => {
  const socketDir = fs.mkdtempSync('/tmp/fct-');
  const fake = fakeServeWeb();
  const config = { self: 'laptop', peers: {}, code: { enabled: true, cli: process.execPath, socketDir } };
  const code = createCodeProxy({ config, spawnFn: fake.spawnFn });
  const front = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (!(await code.handle(req, res, url))) {
      res.writeHead(404);
      res.end();
    }
  });
  front.on('upgrade', (req, socket, head) => code.upgrade(req, socket, head, new URL(req.url, 'http://x')));
  await new Promise((r) => front.listen(0, '127.0.0.1', r));
  const port = front.address().port;
  t.after(() => {
    code.stop();
    front.close();
    fs.rmSync(socketDir, { recursive: true, force: true });
  });

  const res = await fetch(`http://127.0.0.1:${port}/code/laptop/?folder=%2Ftmp`, { headers: { cookie: 'fleet_auth=secret; vscode-tkn=k', origin: `http://127.0.0.1:${port}` } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.url, '/code/laptop/?folder=%2Ftmp');
  assert.equal(body.cookie, 'vscode-tkn=k', 'fleet_auth never reaches VS Code');
  assert.equal(body.origin, `http://${body.host}`, 'Origin matches Host');
  assert.ok(fake.seen[0].args.includes('/code/laptop'), 'base path is /code/<self>');
  assert.equal((fs.statSync(socketDir).mode & 0o777).toString(8), '700');

  const unknown = await fetch(`http://127.0.0.1:${port}/code/elsewhere/`);
  assert.equal(unknown.status, 404);

  // WebSocket: the 101 comes back and bytes flow both ways.
  const echoed = await new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => {
      s.write(`GET /code/laptop/stable-x?reconnection=false HTTP/1.1\r\nhost: 127.0.0.1:${port}\r\nconnection: Upgrade\r\nupgrade: websocket\r\n\r\n`);
    });
    let buf = '';
    s.on('data', (d) => {
      buf += d;
      if (buf.includes('\r\n\r\n') && !buf.includes('ping')) s.write('ping');
      if (buf.includes('ping')) {
        s.destroy();
        resolve(buf);
      }
    });
    s.on('error', reject);
  });
  assert.match(echoed, /^HTTP\/1.1 101/);
  assert.match(echoed, /ping$/);
});

test('web.code off: this host answers 404', async () => {
  const code = createCodeProxy({ config: { self: 'laptop', peers: {}, code: { enabled: false } } });
  const res = await new Promise((resolve) => {
    const front = http.createServer(async (req, r) => {
      await code.handle(req, r, new URL(req.url, 'http://x'));
    });
    front.listen(0, '127.0.0.1', async () => {
      const out = await fetch(`http://127.0.0.1:${front.address().port}/code/laptop/`);
      front.close();
      resolve(out);
    });
  });
  assert.equal(res.status, 404);
});
