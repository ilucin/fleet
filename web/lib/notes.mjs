// Notes explorer: browse, search and read a directory of markdown notes (`web.notes.root`).
// Everything is relative to that root and, after realpath, must stay inside it (symlinks out
// are refused). Hidden entries (.git, .obsidian, …), node_modules, `web.notes.exclude` and the
// root .gitignore's simple patterns are skipped. age-armored blocks are never served or searched.
// Search is built in (an in-memory text cache keyed by mtime) or an external `searchCmd`.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { HttpError } from './http.mjs';
import { contentTypeForKind, isDenied } from './files.mjs';

export const MAX_FILES = 5000;
const MAX_DEPTH = 16;
/** A note larger than this is not returned (nor searched). */
export const NOTE_MAX_BYTES = 2 * 1024 * 1024;
const TREE_TTL_MS = 3000;
const TITLE_SNIFF = 4096;
const MAX_QUERY = 200;
const MAX_TERMS = 8;
const SNIPPET_CHARS = 180;
const MATCHES_PER_FILE = 3;
const DEFAULT_LIMIT = 50;
const SEARCH_CMD_TIMEOUT_MS = 10000;
const CACHE_MAX_BYTES = 64 * 1024 * 1024;

const MARKDOWN_EXT = new Set(['.md', '.markdown', '.mdx', '.mdown', '.mkd']);
const TEXT_EXT = new Set(['.txt', '.json', '.jsonl', '.yaml', '.yml', '.toml', '.csv', '.tsv', '.sh', '.bash', '.zsh', '.fish', '.js', '.mjs', '.ts', '.py', '.rb', '.sql', '.ini', '.conf', '.xml', '.html', '.css', '.lua', '.rs', '.go']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg', '.bmp', '.ico']);
const ALWAYS_EXCLUDED = new Set(['node_modules', '__pycache__']);

const AGE_BLOCK_RE = /-----BEGIN AGE ENCRYPTED FILE-----[\s\S]*?(?:-----END AGE ENCRYPTED FILE-----|$)/g;
const HAS_AGE_RE = /-----BEGIN AGE ENCRYPTED FILE-----/;

export function noteKind(file) {
  const ext = path.extname(file).toLowerCase();
  if (MARKDOWN_EXT.has(ext)) return 'markdown';
  if (IMAGE_EXT.has(ext)) return 'image';
  if (TEXT_EXT.has(ext)) return 'text';
  return null;
}

/** Glob (`*`, `?`, `**`) → RegExp over a whole path segment or a root-relative path. */
function globRe(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*';
      i++;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/**
 * The simple part of .gitignore: `name`, `name/`, `/path`, `*.ext`, `dir/**`. Negations and
 * character classes are ignored (the entry is dropped, i.e. nothing extra is hidden).
 * → [{ re, anchored, dirOnly }]
 */
export function parseIgnore(text) {
  const out = [];
  for (let line of String(text ?? '').split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('#') || line.startsWith('!') || /[[\]\\]/.test(line)) continue;
    const dirOnly = line.endsWith('/');
    if (dirOnly) line = line.slice(0, -1);
    const anchored = line.startsWith('/') || line.slice(0, -1).includes('/');
    line = line.replace(/^\//, '');
    if (!line) continue;
    out.push({ re: globRe(line), anchored, dirOnly });
  }
  return out;
}

/** Is `rel` (root-relative, `/`-separated) excluded by these rules? */
export function isIgnored(rel, name, isDir, rules) {
  return rules.some((r) => (!r.dirOnly || isDir) && (r.anchored ? r.re.test(rel) : r.re.test(name)));
}

/**
 * A client path → a normalized root-relative path, or null. No absolute paths, no `..`, no
 * hidden segments, no NUL / backslashes.
 */
export function cleanRel(raw) {
  if (typeof raw !== 'string') return null;
  const p = raw.trim().replace(/^\.\/+/, '');
  if (!p || p.length > 1024 || p.includes('\0') || p.includes('\\') || p.startsWith('/')) return null;
  const segs = p.split('/').filter((s) => s !== '' && s !== '.');
  if (!segs.length || segs.some((s) => s === '..' || s.startsWith('.'))) return null;
  return segs.join('/');
}

/** YAML-ish frontmatter: `key: value`, `key: [a, b]`, `key:` + `- item` lines. → { meta: [[k, v]], body, lines } */
export function splitFrontmatter(text) {
  const src = String(text ?? '').replace(/\r\n?/g, '\n');
  const m = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(src);
  if (!m) return { meta: [], body: src, lines: 0 };
  const meta = [];
  let list = null;
  for (const line of m[1].split('\n')) {
    const item = /^\s+-\s+(.*)$/.exec(line) ?? (list ? /^-\s+(.*)$/.exec(line) : null);
    if (item && list) {
      list.push(unquote(item[1].trim()));
      continue;
    }
    const kv = /^([A-Za-z_][\w.-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const v = kv[2].trim();
    if (v === '') {
      list = [];
      meta.push([kv[1], list]);
    } else {
      list = null;
      if (/^\[.*\]$/.test(v)) meta.push([kv[1], v.slice(1, -1).split(',').map((s) => unquote(s.trim())).filter(Boolean)]);
      else meta.push([kv[1], unquote(v)]);
    }
  }
  return { meta: meta.filter(([, v]) => !Array.isArray(v) || v.length), body: src.slice(m[0].length), lines: m[0].split('\n').length - 1 };
}

const unquote = (s) => (/^(["']).*\1$/.test(s) ? s.slice(1, -1) : s);

/** Tags from frontmatter (`tags:` / `tag:`), lowercased, without `#`. */
function metaTags(meta) {
  const out = [];
  for (const [k, v] of meta) {
    if (k !== 'tags' && k !== 'tag') continue;
    for (const t of Array.isArray(v) ? v : String(v).split(/[\s,]+/)) if (t) out.push(t.replace(/^#/, '').toLowerCase());
  }
  return out;
}

function titleOf(text, file) {
  const { meta, body } = splitFrontmatter(text);
  const t = meta.find(([k]) => k === 'title')?.[1];
  if (typeof t === 'string' && t.trim()) return t.trim();
  const h = /^#\s+(.+)$/m.exec(body);
  if (h) return h[1].replace(/[*_`]/g, '').trim();
  return path.basename(file).replace(/\.[^.]+$/, '');
}

/** Replace age-armored blocks (never served or searched). → { text, encrypted } */
export function withoutSecrets(text) {
  if (!HAS_AGE_RE.test(text)) return { text, encrypted: false };
  return { text: text.replace(AGE_BLOCK_RE, '[encrypted]'), encrypted: true };
}

/** `a b "c d" #tag` → [{ v: 'a' }, { v: 'b' }, { v: 'c d' }, { v: '#tag', tag: 'tag' }] (lowercased). */
export function parseQuery(q) {
  const out = [];
  for (const m of String(q ?? '').slice(0, MAX_QUERY).matchAll(/"([^"]+)"|(\S+)/g)) {
    const v = (m[1] ?? m[2]).toLowerCase().trim();
    if (!v || out.some((t) => t.v === v)) continue;
    out.push(/^#[\w/-]+$/.test(v) ? { v, tag: v.slice(1) } : { v });
    if (out.length >= MAX_TERMS) break;
  }
  return out;
}

/** Match ranges ([start, end)) of any term in `line` (case-insensitive), merged. */
export function matchRanges(line, terms) {
  const lower = line.toLowerCase();
  if (lower.length !== line.length) return [];
  const ranges = [];
  for (const t of terms) {
    let i = lower.indexOf(t.v);
    while (i !== -1 && ranges.length < 50) {
      ranges.push([i, i + t.v.length]);
      i = lower.indexOf(t.v, i + t.v.length);
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }
  return merged;
}

/** One line cut to a window around its first match. → { text, ranges } */
export function snippet(line, terms, max = SNIPPET_CHARS) {
  const clean = line.replace(/\t/g, ' ').trim();
  let ranges = matchRanges(clean, terms);
  if (clean.length <= max) return { text: clean, ranges };
  const first = ranges[0]?.[0] ?? 0;
  let start = Math.max(0, Math.min(first - Math.floor(max / 3), clean.length - max));
  const end = Math.min(clean.length, start + max);
  const prefix = start > 0 ? '…' : '';
  const text = prefix + clean.slice(start, end) + (end < clean.length ? '…' : '');
  const shift = prefix.length - start;
  ranges = ranges.filter(([s, e]) => s >= start && e <= end).map(([s, e]) => [s + shift, e + shift]);
  return { text, ranges };
}

/**
 * Score one note against the terms (all must match somewhere: path, title, tags or text).
 * → null | { score, matches: [{ line, text, ranges }], more }
 */
export function scoreNote({ rel, title, text, tags }, terms) {
  const lowerPath = rel.toLowerCase();
  const lowerTitle = (title ?? '').toLowerCase();
  const lowerText = text.toLowerCase();
  let score = 0;
  for (const t of terms) {
    const inPath = lowerPath.includes(t.tag ?? t.v);
    const inTitle = lowerTitle.includes(t.v);
    const inTags = t.tag ? tags.includes(t.tag) : false;
    const inText = lowerText.includes(t.v);
    if (!inPath && !inTitle && !inTags && !inText) return null;
    if (inTags) score += 12;
    if (inTitle) score += 8;
    if (path.basename(lowerPath).includes(t.tag ?? t.v)) score += 6;
    else if (inPath) score += 3;
    if (inText) {
      let n = 0;
      for (let i = lowerText.indexOf(t.v); i !== -1 && n < 20; i = lowerText.indexOf(t.v, i + t.v.length)) n++;
      score += Math.min(n, 20) * 0.5;
    }
  }
  const matches = [];
  let more = 0;
  const lines = text.split('\n');
  const headingBonus = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) continue;
    const lower = l.toLowerCase();
    if (!terms.some((t) => lower.includes(t.v))) continue;
    if (/^#{1,6}\s/.test(l)) headingBonus.push(i);
    if (matches.length < MATCHES_PER_FILE) matches.push({ line: i + 1, ...snippet(l, terms) });
    else more++;
  }
  score += Math.min(headingBonus.length, 3) * 2;
  return { score, matches, more };
}

/** Parse external search output: `path:line:text` (grep -n / rg) or a path line + indented match lines. */
export function parseSearchOutput(stdout) {
  const byPath = new Map();
  let cur = null;
  const add = (p, m) => {
    if (!byPath.has(p)) byPath.set(p, []);
    if (m) byPath.get(p).push(m);
  };
  for (const raw of String(stdout ?? '').split('\n')) {
    if (!raw.trim()) continue;
    const grepLine = /^([^\s:][^:]*?):(\d+):(.*)$/.exec(raw);
    if (grepLine && noteKind(grepLine[1])) {
      cur = null;
      add(grepLine[1], { line: Number(grepLine[2]), text: grepLine[3] });
      continue;
    }
    if (/^\s/.test(raw)) {
      const text = raw.trim();
      if (cur && !/^\.\.\. \+\d+ more$/.test(text)) add(cur, { line: null, text });
      continue;
    }
    const p = raw.trim().replace(/:$/, '');
    if (noteKind(p)) {
      cur = p;
      add(p, null);
    }
  }
  return [...byPath].map(([p, matches]) => ({ path: p, matches }));
}

/**
 * @param {object} opts
 *   config    normalized `web.notes` ({ root, name, searchCmd, exclude }) — null = off
 *   home      this host's $HOME (display paths, the secrets deny list)
 *   run       lib/run.mjs (for searchCmd)
 */
export function createNotes({ config, home, run = null, now = Date.now } = {}) {
  if (!config?.root) return null;
  const root = path.resolve(config.root);
  const exclude = new Set(config.exclude ?? []);
  let realRoot = null;
  let tree = null; // { at, files, truncated }
  let treeBuilding = null;
  const texts = new Map(); // rel → { key, text, title, tags, encrypted, bytes }
  let cachedBytes = 0;

  async function rootReal() {
    try {
      realRoot = await fsp.realpath(root);
    } catch {
      throw new HttpError(`notes root is missing: ${displayPath(root)}`, 503);
    }
    return realRoot;
  }

  function displayPath(abs) {
    if (home && (abs === home || abs.startsWith(home + path.sep))) return abs === home ? '~' : `~/${path.relative(home, abs)}`;
    return abs;
  }

  async function ignoreRules(real) {
    try {
      return parseIgnore(await fsp.readFile(path.join(real, '.gitignore'), 'utf8'));
    } catch {
      return [];
    }
  }

  async function walk() {
    const real = await rootReal();
    const rules = await ignoreRules(real);
    const files = [];
    let truncated = false;
    async function visit(dirAbs, dirRel, depth) {
      if (depth > MAX_DEPTH || truncated) return;
      let entries;
      try {
        entries = await fsp.readdir(dirAbs, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const e of entries) {
        if (e.name.startsWith('.') || ALWAYS_EXCLUDED.has(e.name) || exclude.has(e.name)) continue;
        const rel = dirRel ? `${dirRel}/${e.name}` : e.name;
        if (exclude.has(rel)) continue;
        const abs = path.join(dirAbs, e.name);
        // A symlinked file is listed when it stays inside the root; symlinked dirs are not
        // followed (no cycles, no duplicate subtrees).
        const isDir = e.isDirectory();
        let isFile = e.isFile();
        if (e.isSymbolicLink()) {
          const target = await fsp.realpath(abs).catch(() => null);
          if (!target || !inside(target, real)) continue;
          isFile = !!(await fsp.stat(target).catch(() => null))?.isFile();
        }
        if (isIgnored(rel, e.name, isDir, rules)) continue;
        if (isDir) await visit(abs, rel, depth + 1);
        else if (isFile) {
          const kind = noteKind(e.name);
          if (!kind) continue;
          if (files.length >= MAX_FILES) {
            truncated = true;
            return;
          }
          const st = await fsp.stat(abs).catch(() => null);
          if (!st) continue;
          files.push({ path: rel, kind, size: st.size, mtime: Math.round(st.mtimeMs) });
        }
      }
    }
    await visit(real, '', 0);
    // Titles (and the search cache) for markdown; cheap when unchanged (mtime + size key).
    await Promise.all(files.filter((f) => f.kind === 'markdown').map(async (f) => {
      const entry = await loadText(f).catch(() => null);
      if (entry) {
        f.title = entry.title;
        if (entry.encrypted) f.encrypted = true;
      }
    }));
    const seen = new Set(files.map((f) => f.path));
    for (const [rel, e] of texts) {
      if (!seen.has(rel)) {
        cachedBytes -= e.bytes;
        texts.delete(rel);
      }
    }
    return { at: now(), files, truncated };
  }

  async function getTree({ force = false } = {}) {
    if (!force && tree && now() - tree.at < TREE_TTL_MS) return tree;
    treeBuilding ??= walk().finally(() => (treeBuilding = null));
    tree = await treeBuilding;
    return tree;
  }

  /** A tree entry's text (cached by mtime + size); age blocks removed. */
  async function loadText(f) {
    const key = `${f.mtime}:${f.size}`;
    const hit = texts.get(f.path);
    if (hit && hit.key === key) return hit;
    if (f.size > NOTE_MAX_BYTES) return null;
    const abs = await resolveReal(f.path);
    const rawText = await fsp.readFile(abs, 'utf8');
    const { text, encrypted } = withoutSecrets(rawText);
    const { meta } = splitFrontmatter(text);
    const entry = { key, text, title: titleOf(text.slice(0, TITLE_SNIFF * 4), f.path), tags: metaTags(meta), encrypted, bytes: text.length };
    if (hit) cachedBytes -= hit.bytes;
    if (cachedBytes + entry.bytes <= CACHE_MAX_BYTES) {
      texts.set(f.path, entry);
      cachedBytes += entry.bytes;
    }
    return entry;
  }

  /** root-relative → a real absolute path inside the root; throws 400/403/404. */
  async function resolveReal(relRaw) {
    const rel = cleanRel(relRaw);
    if (!rel) throw new HttpError('bad path', 400);
    const real = realRoot ?? (await rootReal());
    const abs = path.join(real, rel);
    if (!inside(abs, real)) throw new HttpError('outside the notes root', 403);
    let target;
    try {
      target = await fsp.realpath(abs);
    } catch {
      throw new HttpError(`not found: ${rel}`, 404);
    }
    if (!inside(target, real)) throw new HttpError('outside the notes root', 403);
    if (home && (isDenied(target, home) || isDenied(abs, home))) throw new HttpError('not served (secrets)', 403);
    return target;
  }

  /** The tree entry for `rel` (a listed file), or a 404 — excluded / ignored files are not served. */
  async function entryFor(relRaw) {
    const rel = cleanRel(relRaw);
    if (!rel) throw new HttpError('bad path', 400);
    let t = await getTree();
    let f = t.files.find((x) => x.path === rel);
    if (!f) {
      t = await getTree({ force: true });
      f = t.files.find((x) => x.path === rel);
    }
    if (!f) throw new HttpError(`not found: ${rel}`, 404);
    return f;
  }

  async function treeResponse() {
    const t = await getTree();
    return {
      name: config.name,
      root: displayPath(root),
      rootAbs: root,
      searchEngine: config.searchCmd ? 'command' : 'builtin',
      files: t.files,
      truncated: t.truncated,
      scannedAt: t.at,
    };
  }

  async function file(relRaw) {
    const f = await entryFor(relRaw);
    if (f.kind === 'image') throw new HttpError('an image — use notes/raw', 400);
    const abs = await resolveReal(f.path);
    const st = await fsp.stat(abs);
    if (st.size > NOTE_MAX_BYTES) throw new HttpError(`too large to preview (${st.size} bytes, max ${NOTE_MAX_BYTES})`, 413);
    const { text, encrypted } = withoutSecrets(await fsp.readFile(abs, 'utf8'));
    const fm = f.kind === 'markdown' ? splitFrontmatter(text) : { meta: [], body: text, lines: 0 };
    return {
      path: f.path,
      abs: path.join(root, f.path),
      kind: f.kind,
      size: st.size,
      mtime: Math.round(st.mtimeMs),
      title: f.kind === 'markdown' ? titleOf(text, f.path) : path.basename(f.path),
      encrypted,
      meta: fm.meta,
      body: fm.body,
      bodyLine: fm.lines + 1,
      text,
    };
  }

  /** Images referenced by notes: streamed with the files API's safe headers. */
  async function raw(relRaw) {
    const f = await entryFor(relRaw);
    if (f.kind !== 'image') throw new HttpError('only images are served raw', 400);
    const abs = await resolveReal(f.path);
    const st = await fsp.stat(abs);
    return {
      status: 200,
      headers: {
        'content-type': contentTypeForKind('image', abs),
        'content-length': st.size,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
      },
      stream: fs.createReadStream(abs),
    };
  }

  async function builtinSearch(terms, limit) {
    const t = await getTree();
    const results = [];
    for (const f of t.files) {
      if (f.kind === 'image') continue;
      const entry = await loadText(f).catch(() => null);
      if (!entry) continue;
      const hit = scoreNote({ rel: f.path, title: entry.title, text: entry.text, tags: entry.tags }, terms);
      if (!hit) continue;
      results.push({ path: f.path, kind: f.kind, title: entry.title, mtime: f.mtime, ...hit });
    }
    results.sort((a, b) => b.score - a.score || b.mtime - a.mtime);
    return { results: results.slice(0, limit), total: results.length };
  }

  async function commandSearch(q, terms, limit) {
    const [bin, ...args] = config.searchCmd;
    // `{query}` = the query as one argument, `{args}` = one argument per term; neither → appended.
    const words = q.split(/\s+/).filter(Boolean);
    const argv = args.some((a) => a.includes('{query}') || a === '{args}')
      ? args.flatMap((a) => (a === '{args}' ? words : [a.replaceAll('{query}', q)]))
      : [...args, q];
    let stdout = '';
    try {
      ({ stdout } = await run(bin, argv, { timeout: SEARCH_CMD_TIMEOUT_MS, cwd: root, maxBuffer: 8 * 1024 * 1024 }));
    } catch (err) {
      // grep-style "no matches" (exit 1, nothing printed) is not an error.
      if (err?.code === 1 && !String(err.stdout ?? '').trim()) return { results: [], total: 0 };
      if (err?.code === 1 && err.stdout) stdout = err.stdout;
      else throw err;
    }
    const t = await getTree();
    const real = realRoot ?? (await rootReal());
    const byPath = new Map(t.files.map((f) => [f.path, f]));
    const results = [];
    for (const hit of parseSearchOutput(stdout)) {
      let rel = hit.path;
      if (path.isAbsolute(rel)) rel = inside(rel, real) ? path.relative(real, rel) : inside(rel, root) ? path.relative(root, rel) : null;
      const f = rel ? byPath.get(cleanRel(rel)) : null;
      if (!f) continue; // outside the root, hidden or excluded: dropped
      const entry = f.kind === 'image' ? null : await loadText(f).catch(() => null);
      if (entry?.encrypted && hit.matches.some((m) => /-----BEGIN AGE|^[A-Za-z0-9+/=]{40,}$/.test(m.text))) continue;
      const matches = hit.matches.slice(0, MATCHES_PER_FILE).map((m) => ({ line: m.line, ...snippet(m.text, terms) }));
      results.push({ path: f.path, kind: f.kind, title: entry?.title ?? path.basename(f.path), mtime: f.mtime, score: 0, matches, more: Math.max(0, hit.matches.length - MATCHES_PER_FILE) });
      if (results.length >= limit) break;
    }
    return { results, total: results.length };
  }

  async function search(qRaw, { limit = DEFAULT_LIMIT } = {}) {
    const q = String(qRaw ?? '').trim().slice(0, MAX_QUERY);
    const terms = parseQuery(q);
    const started = now();
    if (!terms.length) return { q, engine: 'builtin', results: [], total: 0, ms: 0 };
    if (config.searchCmd && run) {
      try {
        const r = await commandSearch(q, terms, limit);
        return { q, engine: 'command', ...r, ms: now() - started };
      } catch (err) {
        const r = await builtinSearch(terms, limit);
        return { q, engine: 'builtin', fallback: `search command failed: ${String(err?.message ?? err).split('\n')[0].slice(0, 200)}`, ...r, ms: now() - started };
      }
    }
    return { q, engine: 'builtin', ...(await builtinSearch(terms, limit)), ms: now() - started };
  }

  return { tree: treeResponse, file, raw, search, root, name: config.name };
}

const inside = (p, r) => p === r || p.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
