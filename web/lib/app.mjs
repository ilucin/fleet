// HTTP server: /api/* goes to the API handler (lib/api.mjs), everything else is served
// as static files from `uiDir` (default web/public, configurable via config.web.ui).
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { HttpError, contentTypeFor, resolveStaticPath, sendJson } from './http.mjs';
import { BackendError } from './backends.mjs';

const PLACEHOLDER_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>fleet-web</title>
<style>body{font:16px -apple-system,system-ui,sans-serif;background:#111;color:#eee;
display:grid;place-items:center;height:100vh;margin:0}</style>
</head><body><p>fleet-web: no UI found (API is at /api/)</p></body></html>
`;

export function createHttpServer({ handleApi, uiDir, log = () => {}, logError = () => {} }) {
  async function serveStatic(req, res, url) {
    if (!uiDir) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    const resolved = resolveStaticPath(uiDir, url.pathname);
    if (!resolved.ok) {
      sendJson(res, resolved.status, { error: resolved.error });
      return;
    }

    let file = resolved.file;
    let stat = await fsp.stat(file).catch(() => null);
    if (stat?.isDirectory()) {
      file = path.join(file, 'index.html');
      stat = await fsp.stat(file).catch(() => null);
    }

    if (!stat?.isFile()) {
      if (url.pathname === '/' || url.pathname === '/index.html') {
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-cache',
          'content-length': Buffer.byteLength(PLACEHOLDER_HTML),
        });
        res.end(PLACEHOLDER_HTML);
        return;
      }
      sendJson(res, 404, { error: 'not found' });
      return;
    }

    res.writeHead(200, {
      'content-type': contentTypeFor(file),
      'cache-control': 'no-cache',
      'content-length': stat.size,
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    await new Promise((resolve) => {
      const stream = fs.createReadStream(file);
      stream.on('error', (err) => {
        logError(err, `static ${file}`);
        res.destroy();
        resolve();
      });
      stream.on('close', resolve);
      stream.pipe(res);
    });
  }

  const server = http.createServer((req, res) => {
    const startedAt = process.hrtime.bigint();
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    } catch {
      url = null;
    }

    const finish = (status) => {
      const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
      log(`${req.method} ${req.url} ${status} ${ms.toFixed(1)}ms`);
    };
    res.on('finish', () => finish(res.statusCode));
    res.on('close', () => {
      if (!res.writableEnded) finish(res.statusCode || 499);
    });

    (async () => {
      if (!url) {
        sendJson(res, 400, { error: 'bad request url' });
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        const result = await handleApi(req, url);
        if (result) sendJson(res, result.status, result.body);
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
      }
      await serveStatic(req, res, url);
    })().catch((err) => {
      const status = err instanceof HttpError || err instanceof BackendError ? err.status : 500;
      if (status >= 500) logError(err, `${req.method} ${req.url}`);
      if (!res.headersSent) sendJson(res, status, { error: err?.message ?? 'internal error' });
      else res.destroy();
    });
  });

  server.headersTimeout = 30000;
  server.requestTimeout = 60000;
  return server;
}
