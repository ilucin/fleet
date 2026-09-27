// Session briefs without a model: what a session produced and its todo list, read from its
// transcript. Parsed incrementally like lib/touched.mjs — each call reads only what the
// transcript grew by — and kept in memory; the brief file (lib/briefs.mjs) is what persists.
//
// Resources, by source (tool results are mostly *reading*, so they count only where they are
// the output of making something):
//   Edit / Write / MultiEdit / NotebookEdit targets, files a shell command wrote → File / Spec
//   the output of `gh pr create` / `gh issue create`                               → PR / Issue
//   the result of an Artifact publish                                              → Artifact
//   assistant text: GitHub PR/issue, claude.ai artifact and other http(s) links    → PR/Issue/Artifact/Link
//   user prompts: GitHub PR/issue and artifact links (what the work is about)      → PR/Issue/Artifact
// Todos: the latest TodoWrite list, or the task list built from TaskCreate / TaskUpdate calls.
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { classifyUserText, parseTranscript } from './transcript.mjs';
import { ingestCommand } from './touched.mjs';
import { classifyUrl, cleanUrl, resourceKey } from './brief-format.mjs';

/** On the first read of a transcript, only its last this-many bytes are scanned. */
export const MAX_SCAN_BYTES = 16 * 1024 * 1024;
/** Most recent items kept per kind. */
export const PER_KIND = { PR: 20, Issue: 20, Artifact: 20, Spec: 10, File: 30, Link: 15 };
const MAX_PENDING = 500;
const MAX_SESSIONS = 200;
const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const GH_CREATE_RE = /\bgh\s+(?:pr|issue)\s+create\b/;
const URL_RE = /https?:\/\/[^\s<>"'`)\]]+/g;
// Links that are never a resource: servers on this machine or the private network (IP literals,
// dotless names, `.local`, tailnet `.ts.net`), schema/boilerplate hosts.
const JUNK_HOST_RE = /^(?:[^.]+|\d+\.\d+\.\d+\.\d+|\[[0-9a-f:]+\]|.*\.(?:local|localhost|internal|ts\.net)|(?:www\.)?(?:example\.(?:com|org|net)|w3\.org|schema\.org|json-schema\.org))(?::\d+)?$/i;
/** Scratch files are not resources: /tmp, macOS per-user temp dirs. */
export const TEMP_PATH_RE = /^\/(?:tmp|private\/tmp|private\/var\/folders|var\/folders)\//;
const SPEC_RE = /(?:^|\/)(?:SPEC|FINAL)\.md$|\/specs?\//i;

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('\n');
}

/** http(s) URLs in free text → classified { kind, label, url }; junk dropped. */
export function extractUrls(text, kinds = null) {
  const out = [];
  if (typeof text !== 'string' || !text.includes('http')) return out;
  for (const m of text.matchAll(URL_RE)) {
    const url = cleanUrl(m[0]);
    // Templated, or cut short in the text ("github.com/…/pull/1").
    if (/[{}<>$…]|%E2%80%A6/i.test(url) || url.length > 500) continue;
    let host;
    try {
      host = new URL(url).host;
    } catch {
      continue;
    }
    if (!host || JUNK_HOST_RE.test(host)) continue;
    const c = classifyUrl(url);
    if (kinds && !kinds.includes(c.kind)) continue;
    out.push(c);
  }
  return out;
}

function newState(file, skipPath) {
  return { file, skipPath, offset: 0, size: 0, mtimeMs: 0, seq: 0, items: new Map(), pending: new Map(), todos: null, tasks: new Map(), taskSeq: 0 };
}

function addItem(state, item) {
  const key = resourceKey(item);
  if (!key) return;
  state.items.delete(key); // re-insert: Map order = recency
  state.items.set(key, { ...item, seq: ++state.seq });
}

function addFile(state, abs) {
  if (typeof abs !== 'string' || !abs.startsWith('/') || (state.skipPath ?? TEMP_PATH_RE).test(abs) || abs.includes('\0')) return;
  const p = path.normalize(abs);
  addItem(state, { kind: SPEC_RE.test(p) ? 'Spec' : 'File', path: p });
}

/** Feed one JSONL line. */
export function ingestLine(state, line, home = os.homedir()) {
  if (!line || !line.trim()) return;
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    return;
  }
  if (!entry || typeof entry !== 'object' || entry.isSidechain) return;
  const content = entry.message?.content;

  if (entry.type === 'assistant' && Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text') {
        for (const u of extractUrls(block.text)) addItem(state, u);
        continue;
      }
      if (block.type !== 'tool_use' || !block.input || typeof block.input !== 'object') continue;
      const { name, input } = block;
      if (block.id) {
        state.pending.set(block.id, { name, input });
        if (state.pending.size > MAX_PENDING) state.pending.delete(state.pending.keys().next().value);
      }
      if (FILE_TOOLS.has(name)) addFile(state, input.file_path ?? input.notebook_path);
      else if (name === 'Bash' && typeof input.command === 'string') {
        const tmp = { paths: new Map(), seq: 0 };
        ingestCommand(tmp, input.command, home);
        for (const [p, v] of tmp.paths) if (v.tier === 2) addFile(state, p);
      } else if (name === 'TodoWrite' && Array.isArray(input.todos)) {
        state.todos = input.todos
          .filter((t) => t && typeof t.content === 'string' && t.content.trim())
          .map((t) => ({ text: t.content.trim(), status: String(t.status ?? 'pending') }));
        state.tasks.clear();
      } else if (name === 'TaskCreate' && typeof (input.subject ?? input.title) === 'string') {
        // The task's id comes back in the tool result ("Task #3 created…"); until then, a local one.
        const local = `local-${++state.taskSeq}`;
        state.tasks.set(local, { text: String(input.subject ?? input.title).trim(), status: 'pending' });
        if (block.id) state.pending.get(block.id).task = local;
        state.todos = null;
      } else if (name === 'TaskUpdate' && input.taskId != null) {
        const t = state.tasks.get(String(input.taskId));
        if (t) {
          if (input.status === 'deleted') state.tasks.delete(String(input.taskId));
          else {
            if (typeof input.status === 'string') t.status = input.status;
            if (typeof input.subject === 'string' && input.subject.trim()) t.text = input.subject.trim();
          }
        }
      }
    }
    return;
  }

  if (entry.type !== 'user' || entry.isMeta) return;
  if (typeof content === 'string') {
    const c = classifyUserText(content);
    if (c?.kind === 'user') for (const u of extractUrls(c.text, ['PR', 'Issue', 'Artifact'])) addItem(state, u);
    return;
  }
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text') {
      const c = classifyUserText(block.text ?? '');
      if (c?.kind === 'user') for (const u of extractUrls(c.text, ['PR', 'Issue', 'Artifact'])) addItem(state, u);
      continue;
    }
    if (block.type !== 'tool_result') continue;
    const tool = state.pending.get(block.tool_use_id);
    if (!tool) continue;
    state.pending.delete(block.tool_use_id);
    const text = textOf(block.content);
    if (tool.name === 'Bash' && GH_CREATE_RE.test(String(tool.input?.command ?? ''))) {
      for (const u of extractUrls(text, ['PR', 'Issue'])) addItem(state, u);
    } else if (tool.name === 'Artifact' && !block.is_error) {
      const title = tool.input?.title || (tool.input?.file_path ? path.basename(String(tool.input.file_path)) : null);
      for (const u of extractUrls(text, ['Artifact'])) addItem(state, title ? { ...u, label: String(title).slice(0, 80) } : u);
    } else if (tool.task && !block.is_error) {
      const m = /#(\d+)\b/.exec(text) ?? /\btask\s+(\d+)\b/i.exec(text);
      const t = state.tasks.get(tool.task);
      if (m && t) {
        state.tasks.delete(tool.task);
        state.tasks.set(m[1], t);
      }
    }
  }
}

/** The session's current todo list, or null when it never used a todo tool. */
export function todosFromState(state) {
  const list = state.todos ?? (state.tasks.size ? [...state.tasks.values()] : null);
  if (!list || !list.length) return null;
  return list.map((t) => ({
    done: t.status === 'completed',
    text: t.status === 'in_progress' ? `${t.text} (in progress)` : t.text,
  }));
}

/** Resources, newest first, capped per kind (files that no longer exist are dropped by the caller). */
export function resourcesFromState(state) {
  const all = [...state.items.values()].sort((a, b) => b.seq - a.seq);
  const counts = {};
  return all.filter((r) => {
    counts[r.kind] = (counts[r.kind] ?? 0) + 1;
    return counts[r.kind] <= (PER_KIND[r.kind] ?? 20);
  });
}

/**
 * @param {object} [opts]
 *   locate     (cwd, sessionId) → transcript path | null
 *   maxBytes   first-read scan cap
 *   userHome   what `~` in shell commands means
 *   skipPath   written files matching this are not resources (default: temp dirs)
 */
export function createBriefExtractor({ locate, maxBytes = MAX_SCAN_BYTES, userHome = os.homedir(), skipPath = TEMP_PATH_RE } = {}) {
  if (typeof locate !== 'function') throw new TypeError('locate must be a function');
  const states = new Map(); // sessionId → state

  async function readRange(file, start, end) {
    const fh = await fsp.open(file, 'r');
    try {
      const buf = Buffer.alloc(end - start);
      const { bytesRead } = await fh.read(buf, 0, buf.length, start);
      return buf.subarray(0, bytesRead);
    } finally {
      await fh.close().catch(() => {});
    }
  }

  /** → { file, size, offset, resources, todos } or null without a transcript. */
  async function refresh(session) {
    const id = session?.session_id;
    if (!id) return null;
    let st = states.get(id);
    const file = st?.file ?? (await locate(session.cwd ?? null, id));
    if (!file) return null;
    let stat;
    try {
      stat = await fsp.stat(file);
    } catch {
      states.delete(id);
      return null;
    }
    if (!st || stat.size < st.offset) {
      st = newState(file, skipPath);
      if (states.size >= MAX_SESSIONS) states.delete(states.keys().next().value);
      states.set(id, st);
    }
    if (stat.size !== st.size || stat.mtimeMs !== st.mtimeMs) {
      let start = st.offset;
      let skipPartial = false;
      if (start === 0 && stat.size > maxBytes) {
        start = stat.size - maxBytes;
        skipPartial = true;
      }
      if (stat.size > start) {
        const buf = await readRange(file, start, stat.size);
        let from = 0;
        if (skipPartial) {
          const nl = buf.indexOf(0x0a);
          from = nl === -1 ? buf.length : nl + 1;
        }
        const lastNl = buf.lastIndexOf(0x0a);
        const upto = lastNl >= from ? lastNl + 1 : from;
        for (const line of buf.subarray(from, upto).toString('utf8').split('\n')) ingestLine(st, line, userHome);
        st.offset = start + upto;
      }
      st.size = stat.size;
      st.mtimeMs = stat.mtimeMs;
    }
    return { file, size: st.size, offset: st.offset, resources: resourcesFromState(st), todos: todosFromState(st) };
  }

  return {
    refresh,
    forget(id) {
      states.delete(id);
    },
    get sessions() {
      return [...states.keys()];
    },
  };
}

// ------------------------------------------------------------------ the model's input

export const DEFAULT_MAX_DELTA_BYTES = 8 * 1024 * 1024;
const PER_USER_CHARS = 1200;
const PER_ASSISTANT_CHARS = 1600;

function clip(text, max) {
  const t = String(text).replace(/\n{3,}/g, '\n\n').trim();
  if (t.length <= max) return t;
  const half = Math.floor((max - 5) / 2);
  return `${t.slice(0, half)} […] ${t.slice(-half)}`;
}

/**
 * The conversation a transcript grew by since byte `from`: user prompts and the assistant's
 * turn-ending replies, each clipped, newest kept first until `maxChars`. Reads at most
 * `maxBytes` (the newest part of a big delta).
 * → { text, userTurns, chars, messages, omitted, end } — `end` is the offset consumed (the last
 * complete line), what `generatedThrough` becomes.
 */
export async function readDelta(file, from, { maxChars = 12000, maxBytes = DEFAULT_MAX_DELTA_BYTES } = {}) {
  const stat = await fsp.stat(file);
  let start = Math.max(0, Math.min(Number(from) || 0, stat.size));
  if (stat.size < (Number(from) || 0)) start = 0; // replaced / shrunk: start over
  let skipPartial = false;
  if (stat.size - start > maxBytes) {
    start = stat.size - maxBytes;
    skipPartial = true;
  }
  let buf = Buffer.alloc(0);
  if (stat.size > start) {
    const fh = await fsp.open(file, 'r');
    try {
      buf = Buffer.alloc(stat.size - start);
      const { bytesRead } = await fh.read(buf, 0, buf.length, start);
      buf = buf.subarray(0, bytesRead);
    } finally {
      await fh.close().catch(() => {});
    }
  }
  let fromIdx = 0;
  if (skipPartial) {
    const nl = buf.indexOf(0x0a);
    fromIdx = nl === -1 ? buf.length : nl + 1;
  }
  const lastNl = buf.lastIndexOf(0x0a);
  const upto = lastNl >= fromIdx ? lastNl + 1 : fromIdx;
  const msgs = parseTranscript(buf.subarray(fromIdx, upto).toString('utf8')).filter(
    (m) => (m.role === 'user' && m.kind === 'user') || (m.role === 'assistant' && m.final),
  );
  const rendered = msgs.map((m) => (m.role === 'user' ? `[user] ${clip(m.text, PER_USER_CHARS)}` : `[assistant] ${clip(m.text, PER_ASSISTANT_CHARS)}`));
  const kept = [];
  let chars = 0;
  for (let i = rendered.length - 1; i >= 0; i -= 1) {
    const len = rendered[i].length + 2;
    if (chars + len > maxChars && kept.length) break;
    kept.unshift(rendered[i].slice(0, maxChars));
    chars += len;
  }
  const omitted = rendered.length - kept.length;
  const text = `${omitted ? `[… ${omitted} earlier message(s) omitted]\n\n` : ''}${kept.join('\n\n')}`;
  return {
    text,
    userTurns: msgs.filter((m) => m.role === 'user').length,
    chars: msgs.reduce((n, m) => n + m.text.length, 0),
    messages: msgs.length,
    omitted,
    end: start + upto,
  };
}
