// VS Code in the browser (`web.code`): `/code/<host>/…` is VS Code's own web UI (`code serve-web`)
// for the files on <host>, so the UI can show a session's worktree next to its chat.
//
// - This host: the VS Code CLI (`web.code.cli`, else the one Remote-SSH left in
//   ~/.vscode-server, else `code` on PATH) runs `serve-web` on a unix socket in an owner-only dir
//   (no port, no token: only this user can reach it), started on the first request and kept
//   running. Its base path is `/code/<self>`, so every URL it writes stays under that prefix.
// - Another host: the request (HTTP and WebSocket) is piped to that peer's server at the same
//   path, with the peer's token (lib/peers.mjs); the peer runs its own serve-web.
//
// Requests reach here only after the guard and web.auth (lib/app.mjs). The browser's fleet_auth
// cookie is never passed on; VS Code checks that Origin matches Host, so the hop to the socket
// aligns Origin with Host.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';

import { peerDial } from './peers.mjs';

export const CODE_PREFIX = '/code/';
const HOST_RE = /^[A-Za-z0-9._-]{1,64}$/;
const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-authorization']);

/** `/code/<host>/rest` → { host, rest } (rest keeps the leading slash), or null. */
export function parseCodePath(pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith(CODE_PREFIX)) return null;
  const tail = pathname.slice(CODE_PREFIX.length);
  const slash = tail.indexOf('/');
  const host = slash === -1 ? tail : tail.slice(0, slash);
  if (!HOST_RE.test(host)) return null;
  return { host, rest: slash === -1 ? '/' : tail.slice(slash) };
}

/** The VS Code CLI to run: an explicit path, else the newest ~/.vscode-server/code-<commit>, else the app's, else PATH. */
export function findCodeCli({ explicit = null, home = os.homedir(), env = process.env } = {}) {
  if (explicit) return fs.existsSync(explicit) ? explicit : null;
  const dir = path.join(home, '.vscode-server');
  try {
    const clis = fs
      .readdirSync(dir)
      .filter((f) => /^code-[0-9a-f]{40}$/.test(f))
      .map((f) => path.join(dir, f))
      .filter((f) => fs.statSync(f).isFile())
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    if (clis.length) return clis[0];
  } catch {
    /* no Remote-SSH install */
  }
  for (const app of ['/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code', path.join(home, 'Applications/Visual Studio Code.app/Contents/Resources/app/bin/code')]) {
    if (fs.existsSync(app)) return app;
  }
  for (const p of String(env.PATH ?? '').split(':')) {
    if (!p) continue;
    const f = path.join(p, 'code');
    if (fs.existsSync(f)) return f;
  }
  return null;
}

/** Strip hop-by-hop headers and the fleet_auth cookie from a browser request's headers. */
function forwardHeaders(headers, { keepUpgrade = false } = {}) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v == null) continue;
    if (HOP_HEADERS.has(k) && !(keepUpgrade && (k === 'connection' || k === 'upgrade'))) continue;
    if (k === 'cookie') {
      const kept = String(v)
        .split(/;\s*/)
        .filter((c) => c && !/^fleet_auth=/.test(c))
        .join('; ');
      if (kept) out.cookie = kept;
      continue;
    }
    out[k] = v;
  }
  return out;
}

/**
 * The `/code/` handler. `config` = normalized config ({ self, peers, code: { enabled, cli, socketDir } }).
 * → { handle(req, res, url) → bool, upgrade(req, socket, head, url) → bool, stop() }.
 */
export function createCodeProxy({ config, log = () => {}, logError = () => {}, spawnFn = spawn } = {}) {
  const code = config.code ?? { enabled: false };
  let child = null;
  let starting = null;
  const socketPath = code.socketDir ? path.join(code.socketDir, 'vscode.sock') : null;

  function waitForSocket(ms) {
    return new Promise((resolve, reject) => {
      const until = Date.now() + ms;
      const tick = () => {
        const req = http.request({ socketPath, path: '/', method: 'HEAD' }, (res) => {
          res.resume();
          resolve();
        });
        req.on('error', () => (Date.now() > until ? reject(new Error('VS Code did not start')) : setTimeout(tick, 250)));
        req.end();
      };
      tick();
    });
  }

  /** Start serve-web once; resolves when its socket answers. */
  function ensureServer() {
    if (child && child.exitCode == null && !starting) return Promise.resolve();
    if (starting) return starting;
    const cli = findCodeCli({ explicit: code.cli });
    if (!cli) return Promise.reject(Object.assign(new Error('no VS Code CLI on this host (set web.code.cli, or connect once with VS Code Remote-SSH)'), { status: 503 }));
    fs.mkdirSync(code.socketDir, { recursive: true, mode: 0o700 });
    if (fs.statSync(code.socketDir).uid !== process.getuid?.()) return Promise.reject(Object.assign(new Error(`${code.socketDir} belongs to another user`), { status: 503 }));
    fs.chmodSync(code.socketDir, 0o700);
    fs.rmSync(socketPath, { force: true });
    const args = ['serve-web', '--socket-path', socketPath, '--without-connection-token', '--accept-server-license-terms', '--server-base-path', `/code/${config.self}`, '--disable-telemetry'];
    log(`[code] starting ${path.basename(cli)} serve-web on ${socketPath}`);
    child = spawnFn(cli, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: false });
    const tail = (b) => {
      const s = String(b).trim();
      if (s && /error|fail/i.test(s)) log(`[code] ${s.split('\n').slice(-1)[0]}`);
    };
    child.stdout?.on('data', tail);
    child.stderr?.on('data', tail);
    child.on('exit', (c, sig) => {
      log(`[code] serve-web exited (${sig ?? c})`);
      child = null;
    });
    // The first start downloads the server (~1 min); later ones take a second.
    starting = waitForSocket(120 * 1000).finally(() => {
      starting = null;
    });
    return starting;
  }

  function fail(res, status, message) {
    if (res.headersSent) return res.destroy();
    const body = `<!doctype html><meta charset=utf-8><body style="font:14px system-ui;padding:2rem;color:#666">${message.replace(/[<&]/g, (c) => (c === '<' ? '&lt;' : '&amp;'))}</body>`;
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(body);
  }

  /** → { mod: http|https, options } for this host's socket or a peer, or an { error }. */
  async function target(host, req, url, { upgrade = false } = {}) {
    const headers = forwardHeaders(req.headers, { keepUpgrade: upgrade });
    if (host === config.self) {
      if (!code.enabled) return { error: 'VS Code in Fleet is off on this host (web.code)', status: 404 };
      await ensureServer();
      // VS Code builds its WebSocket url from Host, and refuses one whose Origin is another host
      // (the browser's Fleet origin may differ from Host behind a proxy or a peer hop).
      if (headers.origin && headers.host) headers.origin = `http://${headers.host}`;
      return { mod: http, options: { socketPath, path: url.pathname + url.search, method: req.method, headers } };
    }
    const base = config.peers?.[host];
    if (!base) return { error: `unknown host: ${host}`, status: 404 };
    delete headers.origin;
    delete headers.referer;
    const dial = peerDial(new URL(`${base.replace(/\/+$/, '')}${url.pathname}${url.search}`));
    return { mod: dial.protocol === 'https:' ? https : http, options: { ...dial.options, method: req.method, headers: { ...headers, ...dial.headers }, agent: dial.agent } };
  }

  async function handle(req, res, url) {
    const parsed = parseCodePath(url.pathname);
    if (!parsed) return false;
    let t;
    try {
      t = await target(parsed.host, req, url);
    } catch (err) {
      fail(res, err.status ?? 502, `VS Code: ${err.message}`);
      return true;
    }
    if (t.error) {
      fail(res, t.status, t.error);
      return true;
    }
    await new Promise((resolve) => {
      const out = t.mod.request(t.options, (up) => {
        const headers = { ...up.headers };
        for (const h of HOP_HEADERS) delete headers[h];
        res.writeHead(up.statusCode ?? 502, headers);
        up.pipe(res);
        up.on('end', resolve);
        up.on('error', resolve);
      });
      out.on('error', (err) => {
        fail(res, 502, `VS Code on ${parsed.host} unreachable: ${err.message}`);
        resolve();
      });
      res.on('close', () => {
        out.destroy();
        resolve();
      });
      req.pipe(out);
    });
    return true;
  }

  async function upgrade(req, socket, head, url) {
    const parsed = parseCodePath(url.pathname);
    if (!parsed) return false;
    const refuse = (status, msg) => {
      socket.end(`HTTP/1.1 ${status} ${msg}\r\nconnection: close\r\n\r\n`);
    };
    let t;
    try {
      t = await target(parsed.host, req, url, { upgrade: true });
    } catch (err) {
      refuse(err.status ?? 502, 'Bad Gateway');
      return true;
    }
    if (t.error) {
      refuse(t.status, 'Not Found');
      return true;
    }
    const out = t.mod.request(t.options);
    out.on('upgrade', (up, upSocket, upHead) => {
      const lines = [`HTTP/1.1 ${up.statusCode} ${up.statusMessage}`];
      for (let i = 0; i < up.rawHeaders.length; i += 2) lines.push(`${up.rawHeaders[i]}: ${up.rawHeaders[i + 1]}`);
      socket.write(lines.join('\r\n') + '\r\n\r\n');
      if (upHead?.length) socket.write(upHead);
      if (head?.length) upSocket.write(head);
      upSocket.pipe(socket).pipe(upSocket);
      const close = () => {
        upSocket.destroy();
        socket.destroy();
      };
      upSocket.on('error', close);
      socket.on('error', close);
      upSocket.on('close', close);
      socket.on('close', close);
    });
    out.on('response', (res) => {
      // No upgrade: pass the refusal on.
      refuse(res.statusCode ?? 502, res.statusMessage ?? 'Bad Gateway');
      res.resume();
    });
    out.on('error', (err) => {
      logError(err, `code upgrade ${parsed.host}`);
      refuse(502, 'Bad Gateway');
    });
    out.end();
    return true;
  }

  function stop() {
    if (child && child.exitCode == null) child.kill('SIGTERM');
  }

  return { handle, upgrade, stop };
}
