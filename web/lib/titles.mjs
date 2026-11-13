// Session titles written by the brief generator (lib/briefs.mjs).
//
// A session's display title is the Claude name a human chose, else the generated title stored
// in `~/.claude/fleet-names.json` (core::naming::NameCache, keyed by session id). The CLI fills
// that file from the opening prompts; once a brief exists, the brief call answers a `## Title`
// too and it is written here with source `brief`, which the CLI then leaves alone (until an
// explicit `fleet name --refresh`). No `/rename` is ever sent for a generated title, so the Claude
// name stays a human's choice (docs/architecture.md → "Session titles").
//
// Writes follow the CLI's: whole-file merge, newer `generated_at` wins, temp file + rename,
// entries older than PRUNE_AFTER_MS dropped so the file does not grow forever.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

/** Mirrors core::naming::{MAX_NAME, MAX_RAW, BRIEF_SOURCE, PRUNE_AFTER_MS}. */
export const MAX_TITLE = 32;
const MAX_RAW = 60;
export const BRIEF_SOURCE = 'brief';
export const PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

function capOnBoundary(s, cap) {
  if (s.length <= cap) return s;
  const hard = s.slice(0, cap);
  if (s[cap] === '-') return hard.replace(/^-+|-+$/g, '');
  const i = hard.lastIndexOf('-');
  return i >= 0 && i * 3 >= cap * 2 ? s.slice(0, i) : hard.replace(/^-+|-+$/g, '');
}

/** Lowercase ASCII alphanumerics, anything else one `-`, capped on a word boundary. */
export function slugify(text, cap = MAX_TITLE) {
  const slug = String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return capOnBoundary(slug, cap);
}

/**
 * A model's `## Title` answer → a kebab-case title, or null. Same rules as
 * core::naming::sanitize_name: first real line, a quoted/backticked span unwrapped, and anything
 * still carrying whitespace or an apostrophe is a sentence, not a title.
 */
export function sanitizeTitle(raw) {
  const line = String(raw ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !/^(```|~~~)/.test(l));
  if (!line) return null;
  const quoted = /[`"]([^`"]*\S[^`"]*)[`"]/.exec(line);
  const candidate = (quoted ? quoted[1] : line).trim().replace(/^-\s+/, '');
  if (/[\s']/.test(candidate) || candidate.length > MAX_RAW) return null;
  return slugify(candidate) || null;
}

/** The file the CLI reads titles from. */
export function defaultTitlesPath(home = os.homedir()) {
  return path.join(home, '.claude', 'fleet-names.json');
}

/**
 * @param deps  file (fleet-names.json path), now
 * → { read(id) → title | null, write(id, title) } — synchronous: one small file, and a
 *   read-modify-write with no await in between keeps the race window with the CLI tiny.
 */
export function createTitleStore({ file = defaultTitlesPath(), now = Date.now } = {}) {
  function load() {
    try {
      const v = JSON.parse(fs.readFileSync(file, 'utf8'));
      return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    } catch {
      return {};
    }
  }
  return {
    read(id) {
      const e = load()[id];
      return typeof e?.name === 'string' && e.name ? e.name : null;
    },
    write(id, title) {
      const t = now();
      const entries = load();
      entries[id] = { name: title, source: BRIEF_SOURCE, generated_at: t, input_hash: '' };
      for (const [k, e] of Object.entries(entries)) {
        if (!(Number(e?.generated_at) >= t - PRUNE_AFTER_MS)) delete entries[k];
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
      try {
        fs.writeFileSync(tmp, JSON.stringify(entries));
        fs.renameSync(tmp, file);
      } catch (err) {
        fs.rmSync(tmp, { force: true });
        throw err;
      }
    },
  };
}
