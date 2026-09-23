import path from 'node:path';

export const BODY_LIMIT = 64 * 1024;

export class HttpError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.webp': 'image/webp',
  '.map': 'application/json; charset=utf-8',
};

export function contentTypeFor(file) {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Map a request path to a file inside publicDir.
 * → { ok:true, file } | { ok:false, status, error }
 * Rejects traversal, encoded traversal, null bytes and absolute escapes.
 */
export function resolveStaticPath(publicDir, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath ?? '/');
  } catch {
    return { ok: false, status: 400, error: 'bad request path' };
  }
  if (decoded.includes('\0')) return { ok: false, status: 400, error: 'bad request path' };
  if (!decoded.startsWith('/')) return { ok: false, status: 400, error: 'bad request path' };
  const segments = decoded.split('/');
  if (segments.some((s) => s === '..')) return { ok: false, status: 400, error: 'path traversal rejected' };

  const rel = decoded === '/' ? 'index.html' : decoded.slice(1);
  const root = path.resolve(publicDir);
  const file = path.resolve(root, rel);
  if (file !== root && !file.startsWith(root + path.sep)) {
    return { ok: false, status: 400, error: 'path traversal rejected' };
  }
  return { ok: true, file };
}

export function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

/** Read the request body with a hard 64 KB limit. Rejects with HttpError(413/400). */
export function readBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const fail = (err) => {
      if (done) return;
      done = true;
      chunks.length = 0;
      reject(err);
      // Keep draining so the response can still be written; node dumps the rest
      // of the request once the response ends.
    };
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        fail(new HttpError(`request body too large (max ${limit} bytes)`, 413));
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', (err) => fail(new HttpError(err.message, 400)));
    req.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

export async function readJsonBody(req, limit = BODY_LIMIT) {
  const raw = await readBody(req, limit);
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new HttpError('body must be a JSON object', 400);
    }
    return parsed;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError('invalid JSON body', 400);
  }
}
