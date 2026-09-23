// Claude Code transcript reader: turns ~/.claude/projects/<cwd>/<session>.jsonl into a
// chat-like message list (user prompts + assistant text), dropping tool calls, tool
// results, thinking, hooks and bookkeeping entries.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const MAX_TAIL_BYTES = 6 * 1024 * 1024;

/** Mirror of the fleet CLI's `encode_cwd`: `/` and `.` become `-`. */
export function encodeCwd(cwd) {
  return String(cwd).replace(/[/.]/g, '-');
}

export function claudeHome() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

export function transcriptPath(cwd, sessionId, home = claudeHome()) {
  return path.join(home, 'projects', encodeCwd(cwd), `${sessionId}.jsonl`);
}

/** Find the transcript even when the session's cwd changed (worktrees, cd). */
export async function locateTranscript(cwd, sessionId, home = claudeHome()) {
  const direct = cwd ? transcriptPath(cwd, sessionId, home) : null;
  if (direct) {
    try {
      await fs.access(direct);
      return direct;
    } catch {
      /* fall through */
    }
  }
  const root = path.join(home, 'projects');
  let dirs = [];
  try {
    dirs = await fs.readdir(root);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const candidate = path.join(root, dir, `${sessionId}.jsonl`);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      /* next */
    }
  }
  return null;
}

/** Read at most the last `maxBytes` of a file, dropping a leading partial line. */
export async function readTail(file, maxBytes = MAX_TAIL_BYTES) {
  const stat = await fs.stat(file);
  const start = Math.max(0, stat.size - maxBytes);
  const fh = await fs.open(file, 'r');
  try {
    const buf = Buffer.alloc(stat.size - start);
    await fh.read(buf, 0, buf.length, start);
    let text = buf.toString('utf8');
    if (start > 0) {
      const nl = text.indexOf('\n');
      text = nl === -1 ? '' : text.slice(nl + 1);
    }
    return { text, truncated: start > 0, size: stat.size, mtimeMs: stat.mtimeMs };
  } finally {
    await fh.close();
  }
}

// ------------------------------------------------------------------ parsing

const SYSTEM_REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

function textOfContent(content, blockType = 'text') {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === blockType && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

function tag(text, name) {
  const m = text.match(new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`));
  return m ? m[1].trim() : null;
}

/** Classify one user-typed transcript entry. Returns null for entries not worth showing. */
export function classifyUserText(raw) {
  const text = raw.replace(SYSTEM_REMINDER_RE, '').trim();
  if (!text) return null;
  if (text.startsWith('<local-command-caveat>') || text.startsWith('<local-command-stdout>')) return null;
  if (text.startsWith('<command-name>')) {
    const name = tag(text, 'command-name') ?? '';
    const args = tag(text, 'command-args') ?? '';
    const shown = `${name}${args ? ` ${args}` : ''}`.trim();
    return shown ? { kind: 'command', text: shown } : null;
  }
  if (text.startsWith('<task-notification>')) {
    const summary = tag(text, 'summary') ?? 'Background task finished';
    return { kind: 'system', text: summary };
  }
  return { kind: 'user', text };
}

/**
 * Parse transcript JSONL text into ordered chat messages.
 *   { role: 'user'|'assistant'|'system', kind, text, ts, final? }
 * Assistant text blocks that end a turn (`stop_reason` != 'tool_use') are `final: true`;
 * interim narration between tool calls is `final: false`.
 */
export function parseTranscript(text) {
  const out = [];
  let lastAssistantId = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== 'object' || entry.isSidechain) continue;
    const msg = entry.message;
    if (!msg || typeof msg !== 'object') continue;
    const ts = entry.timestamp ? Date.parse(entry.timestamp) || null : null;

    if (entry.type === 'user') {
      if (entry.isMeta) continue;
      const raw = textOfContent(msg.content);
      if (!raw.trim()) continue; // pure tool_result
      const classified = classifyUserText(raw);
      if (!classified) continue;
      out.push({ role: classified.kind === 'user' ? 'user' : 'system', kind: classified.kind, text: classified.text, ts });
      lastAssistantId = null;
      continue;
    }

    if (entry.type === 'assistant') {
      const body = textOfContent(msg.content).trim();
      if (!body) continue;
      const final = msg.stop_reason !== 'tool_use';
      const prev = out[out.length - 1];
      // Streamed messages arrive as one JSONL line per block; glue blocks of the same
      // API message back together instead of showing them as separate bubbles.
      if (prev && prev.role === 'assistant' && msg.id && msg.id === lastAssistantId) {
        prev.text = `${prev.text}\n\n${body}`;
        prev.final = prev.final || final;
        prev.ts = ts ?? prev.ts;
      } else {
        out.push({ role: 'assistant', kind: 'assistant', text: body, ts, final });
      }
      lastAssistantId = msg.id ?? null;
    }
  }
  return out;
}

// ------------------------------------------------------------------ service

/**
 * Cached transcript reader. `messages(session, limit)` returns the last `limit` chat
 * messages of a `fleet list --json` session object ({ session_id, cwd }).
 */
export function createTranscriptReader({ home = claudeHome(), maxBytes = MAX_TAIL_BYTES } = {}) {
  const cache = new Map(); // sessionId -> { file, size, mtimeMs, messages, truncated }

  async function load(session) {
    const id = session.session_id;
    const cached = cache.get(id);
    const file = cached?.file ?? (await locateTranscript(session.cwd, id, home));
    if (!file) return null;
    let stat;
    try {
      stat = await fs.stat(file);
    } catch {
      cache.delete(id);
      return null;
    }
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached;
    const tail = await readTail(file, maxBytes);
    const fresh = {
      file,
      size: tail.size,
      mtimeMs: tail.mtimeMs,
      truncated: tail.truncated,
      messages: parseTranscript(tail.text),
    };
    cache.set(id, fresh);
    return fresh;
  }

  return {
    async messages(session, limit = 60) {
      const data = await load(session);
      if (!data) return null;
      const total = data.messages.length;
      const slice = limit > 0 ? data.messages.slice(-limit) : data.messages;
      return { messages: slice, total, truncated: data.truncated || slice.length < total, file: data.file, updatedAt: data.mtimeMs };
    },
  };
}
