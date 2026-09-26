// File uploads: the UI drops/pastes a file, the server that hosts the session stores it
// and answers with an absolute path the UI types into the prompt (browsers never expose
// real local paths). Layout: <dir>/YYYY-MM-DD/<random-6>-<sanitized-name>.
// The body is streamed to disk with a byte limit; a failed or oversized upload leaves no file.
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { DEFAULT_UPLOAD_MAX_MB, DEFAULT_UPLOAD_RETENTION_DAYS } from './config.mjs';
import { HttpError } from './http.mjs';

const NAME_MAX = 80;
const EXT_MAX = 16;
const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_DIR = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A safe file name from whatever the client sent: last path segment only, control chars
 * dropped, anything but letters/digits/`.`/`_`/`-` → `-`, no leading dots (no hidden files,
 * no `..`), at most 80 chars with the extension kept. Never empty.
 */
export function sanitizeUploadName(raw) {
  let name = typeof raw === 'string' ? raw : '';
  name = name.replace(/[\u0000-\u001f\u007f]/g, '');
  name = name.split(/[/\\]/).pop() ?? '';
  name = name.normalize('NFC').replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/-{2,}/g, '-');
  name = name.replace(/^[.-]+/, '').replace(/[.-]+$/, '');
  if (!name) return 'file';
  const dot = name.lastIndexOf('.');
  let ext = dot > 0 ? name.slice(dot) : '';
  if (ext.length > EXT_MAX) ext = '';
  let base = ext ? name.slice(0, -ext.length) : name;
  if (base.length + ext.length > NAME_MAX) base = base.slice(0, NAME_MAX - ext.length);
  base = base.replace(/[.-]+$/, '');
  return (base || 'file') + ext;
}

/** `YYYY-MM-DD` in local time. */
export function dayDir(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

/**
 * @param {object} opts
 *   dir            upload root (absolute)
 *   maxBytes       per-file limit
 *   retentionDays  day dirs older than this are removed by cleanup(); 0 = keep forever
 */
export function createUploader({
  dir,
  maxBytes = DEFAULT_UPLOAD_MAX_MB * 1024 * 1024,
  retentionDays = DEFAULT_UPLOAD_RETENTION_DAYS,
  now = () => new Date(),
  random = () => crypto.randomBytes(3).toString('hex'),
  log = () => {},
} = {}) {
  const tooLarge = () => new HttpError(`file too large (max ${Math.round(maxBytes / 1024 / 1024)} MB)`, 413);

  /** Stream `req` into a new file. → { path, name, size } */
  async function store(req, rawName) {
    const declared = Number(req.headers?.['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge();

    const name = sanitizeUploadName(rawName);
    const day = path.join(dir, dayDir(now()));
    await fsp.mkdir(day, { recursive: true });

    // `wx`: never clobber — a random-prefix collision just picks another prefix.
    let file = null;
    let handle = null;
    for (let i = 0; i < 5 && !handle; i++) {
      file = path.join(day, `${random()}-${name}`);
      try {
        handle = await fsp.open(file, 'wx');
      } catch (err) {
        if (err?.code !== 'EEXIST') throw err;
      }
    }
    if (!handle) throw new HttpError('could not allocate an upload file name', 500);

    let size = 0;
    let over = false;
    const limit = new Transform({
      transform(chunk, _enc, cb) {
        size += chunk.length;
        if (size > maxBytes) {
          over = true;
          cb(tooLarge());
          return;
        }
        cb(null, chunk);
      },
    });
    // Not pipeline(req, …): that would destroy the request (and its socket) on a 413,
    // and the client would never see the response.
    const written = pipeline(limit, handle.createWriteStream());
    const onClose = () => {
      if (!req.complete) limit.destroy(new HttpError('upload aborted by the client', 400));
    };
    const onError = (err) => limit.destroy(err);
    req.on('close', onClose);
    req.on('error', onError);
    req.pipe(limit);
    try {
      await written;
    } catch (err) {
      req.unpipe(limit);
      await handle.close().catch(() => {});
      await fsp.rm(file, { force: true }).catch(() => {});
      // Drain the rest of the body so the error response can still be read.
      if (!req.readableEnded) req.resume();
      if (over) throw tooLarge();
      if (err instanceof HttpError) throw err;
      throw new HttpError(`upload failed: ${err?.message ?? err}`, 500);
    } finally {
      req.off('close', onClose);
      req.off('error', onError);
    }
    return { path: file, name: path.basename(file), size };
  }

  /** Remove YYYY-MM-DD dirs older than retentionDays (by the date in the name). */
  async function cleanup() {
    if (!(retentionDays > 0)) return { removed: [] };
    const cutoff = dayDir(new Date(now().getTime() - retentionDays * DAY_MS));
    let entries = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (err?.code === 'ENOENT') return { removed: [] };
      throw err;
    }
    const removed = [];
    for (const e of entries) {
      if (!e.isDirectory() || !DAY_DIR.test(e.name) || e.name >= cutoff) continue;
      await fsp.rm(path.join(dir, e.name), { recursive: true, force: true });
      removed.push(e.name);
    }
    if (removed.length) log(`[uploads] removed ${removed.length} old day dir(s): ${removed.join(', ')}`);
    return { removed };
  }

  let timer = null;
  function start() {
    const tick = () => cleanup().catch((err) => log(`[uploads] cleanup failed: ${err?.message ?? err}`));
    tick();
    timer = setInterval(tick, DAY_MS);
    timer.unref?.();
  }
  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { dir, maxBytes, retentionDays, store, cleanup, start, stop };
}
