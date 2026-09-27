// Session briefs: the file format (docs/architecture.md → "Session briefs"). Pure functions,
// no I/O — shared by the brief service (lib/briefs.mjs) and anything else that reads or writes
// the files (a future `fleet brief` CLI reads the same format).
//
//   ---
//   session: <session id>
//   host: <host name>            cwd: <directory>        (written by the server, informational)
//   updated: <iso>               last write of any kind
//   generatedThrough: <n>        transcript BYTE offset the summary has consumed
//   generatedAt: <iso>           last model generation
//   editedAt: <iso>              last human edit (omitted until there is one)
//   todos: <hash>                the todo state last copied into ## Plan
//   dismissed: ["key", …]        resources the user deleted; never re-added
//   ---
//   ## Summary / ## Resources / ## Plan   (any other `## ` section is kept, after Plan)
//
// A human edit is authoritative: parsing tolerates missing sections, extra text and sections,
// `*` bullets and `[X]`; serialising writes the three sections in canonical order.

export const SECTIONS = ['Summary', 'Resources', 'Plan'];
export const RESOURCE_KINDS = ['PR', 'Issue', 'Artifact', 'Spec', 'File', 'Branch', 'Worktree', 'Link'];
const KIND_BY_LOWER = new Map(RESOURCE_KINDS.map((k) => [k.toLowerCase(), k]));

/** Frontmatter keys in the order they are written; unknown keys follow, as found. */
const META_ORDER = ['session', 'host', 'cwd', 'updated', 'generatedThrough', 'generatedAt', 'editedAt', 'todos', 'dismissed'];
export const MAX_DISMISSED = 200;

const URL_RE = /https?:\/\/[^\s<>"'`)\]]+/g;
const HEADING_RE = /^##\s+(.+?)\s*#*\s*$/;
const BULLET_RE = /^\s*[-*+]\s+(.*)$/;
const CHECK_RE = /^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/;

function oneLine(v) {
  return String(v).replace(/[\r\n]+/g, ' ').trim();
}

// ------------------------------------------------------------------ frontmatter

/** Split `---\n…\n---` off the top. → { meta, body }. No frontmatter → meta {}. */
export function parseFrontmatter(text) {
  const src = String(text ?? '').replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(src);
  if (!m) return { meta: {}, body: src };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, key, raw] = kv;
    let v = raw.trim();
    if (!/^[[{"]/.test(v)) v = v.replace(/\s+#.*$/, ''); // a trailing `# comment`
    if (v === '' || v === 'null' || v === '~') continue;
    if (/^-?\d+$/.test(v)) meta[key] = Number(v);
    else if (/^[[{"]/.test(v)) {
      try {
        meta[key] = JSON.parse(v);
      } catch {
        meta[key] = v;
      }
    } else meta[key] = v;
  }
  return { meta, body: src.slice(m[0].length) };
}

export function serializeFrontmatter(meta = {}) {
  const keys = [...META_ORDER.filter((k) => k in meta), ...Object.keys(meta).filter((k) => !META_ORDER.includes(k))];
  const lines = [];
  for (const k of keys) {
    const v = meta[k];
    if (v == null || v === '' || (Array.isArray(v) && v.length === 0)) continue;
    if (typeof v === 'number') lines.push(`${k}: ${v}`);
    else if (typeof v === 'object') lines.push(`${k}: ${JSON.stringify(v)}`);
    else {
      const s = oneLine(v);
      // Quote what would read back as another type (a number, JSON, a comment).
      lines.push(`${k}: ${/^(-?\d+|null|~)$|^[[{"]|\s#/.test(s) ? JSON.stringify(s) : s}`);
    }
  }
  return `---\n${lines.join('\n')}\n---\n`;
}

// ------------------------------------------------------------------ resources / plan lines

/** Strip markdown noise from a URL's surroundings: trailing punctuation, a closing paren run. */
export function cleanUrl(url) {
  let u = String(url).replace(/[.,;:!?'"]+$/, '');
  while (u.endsWith(')') && (u.match(/\(/g)?.length ?? 0) < (u.match(/\)/g)?.length ?? 0)) u = u.slice(0, -1);
  return u;
}

/** The identity of a resource for de-duplication and `dismissed`: its URL, else its path. */
export function resourceKey(r) {
  if (r.url) return r.url.replace(/#.*$/, '').replace(/\/+$/, '');
  if (r.path) return `${r.kind === 'Branch' || r.kind === 'Worktree' ? `${r.kind.toLowerCase()}:` : ''}${r.path}`;
  return (r.text ?? '').trim().toLowerCase();
}

/** One Resources bullet (without the `- `) → { kind, label, url, path, text, key }. */
export function parseResourceLine(text) {
  const t = String(text).trim();
  let kind = null;
  let value = t;
  const km = /^([A-Za-z][A-Za-z ]{0,15}?)\s*:\s+(.*)$/.exec(t);
  if (km && KIND_BY_LOWER.has(km[1].toLowerCase())) {
    kind = KIND_BY_LOWER.get(km[1].toLowerCase());
    value = km[2].trim();
  }
  let url = null;
  let label = null;
  let p = null;
  const link = /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/.exec(value);
  if (link) {
    label = link[1].trim() || null;
    url = link[2];
  } else {
    const u = value.match(URL_RE);
    if (u) url = cleanUrl(u[0]);
  }
  if (!url) {
    const bt = /`([^`]+)`/.exec(value);
    p = (bt ? bt[1] : value).trim() || null;
    label = p;
  }
  if (!kind) kind = url ? classifyUrl(url).kind : null;
  const r = { kind, label: label ?? url, url, path: p, text: t };
  return { ...r, key: resourceKey(r) };
}

/** → `PR: [owner/repo#12](url)`, `File: \`path\``, … (the bullet text, no `- `). */
export function formatResource(r) {
  const kind = r.kind ?? 'Link';
  if (r.url) return `${kind}: [${(r.label ?? r.url).replace(/[[\]]/g, '')}](${r.url})`;
  return `${kind}: \`${String(r.path ?? '').replace(/`/g, '')}\``;
}

/** Classify a (cleaned) URL. → { kind, label, url } (url canonicalised for GitHub PRs/issues). */
export function classifyUrl(url) {
  const gh = /^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(pull|issues)\/(\d+)/.exec(url);
  if (gh) {
    const [, owner, repo, what, n] = gh;
    return {
      kind: what === 'pull' ? 'PR' : 'Issue',
      label: `${owner}/${repo}#${n}`,
      url: `https://github.com/${owner}/${repo}/${what}/${n}`,
    };
  }
  const art = /^https?:\/\/claude\.ai\/(?:code\/)?artifacts?\/([A-Za-z0-9-]{6,})/.exec(url);
  if (art) return { kind: 'Artifact', label: `artifact ${art[1].slice(0, 8)}`, url: url.replace(/[?#].*$/, '') };
  let label = url;
  try {
    const u = new URL(url);
    label = `${u.host}${u.pathname === '/' ? '' : u.pathname}`;
    if (label.length > 80) label = `${label.slice(0, 77)}…`;
  } catch {
    /* keep the raw url */
  }
  return { kind: 'Link', label, url };
}

export function parsePlanLine(line) {
  const m = CHECK_RE.exec(line);
  return m ? { done: m[1] !== ' ', text: m[2].trim() } : null;
}

export function formatPlan(items) {
  return items.map((i) => `- [${i.done ? 'x' : ' '}] ${oneLine(i.text)}`).join('\n');
}

// ------------------------------------------------------------------ whole brief

/**
 * Parse a brief (with or without frontmatter). →
 *   { meta, preamble, summary, resourcesText, planText, extra: [{ heading, body }],
 *     resources: [parsed lines], plan: [{ done, text }] }
 */
export function parseBrief(text) {
  const { meta, body } = parseFrontmatter(text);
  const known = { summary: [], resources: [], plan: [] };
  const extra = [];
  const pre = [];
  let cur = pre;
  for (const line of body.split('\n')) {
    const h = HEADING_RE.exec(line);
    if (h) {
      const name = h[1].trim().toLowerCase();
      if (name in known) cur = known[name];
      else {
        const sec = { heading: h[1].trim(), lines: [] };
        extra.push(sec);
        cur = sec.lines;
      }
      continue;
    }
    cur.push(line);
  }
  const join = (lines) => lines.join('\n').replace(/^\s*\n/, '').trimEnd();
  const resourcesText = join(known.resources);
  const planText = join(known.plan);
  const resources = [];
  for (const line of resourcesText.split('\n')) {
    const b = BULLET_RE.exec(line);
    if (b && b[1].trim()) resources.push(parseResourceLine(b[1]));
  }
  const plan = planText.split('\n').map(parsePlanLine).filter(Boolean);
  return {
    meta,
    preamble: join(pre),
    summary: join(known.summary),
    resourcesText,
    planText,
    extra: extra.map((s) => ({ heading: s.heading, body: join(s.lines) })),
    resources,
    plan,
  };
}

/** A parsed (possibly modified) brief → canonical text. */
export function serializeBrief(b) {
  const parts = [serializeFrontmatter(b.meta ?? {})];
  if (b.preamble) parts.push(`${b.preamble}\n\n`);
  parts.push(`## Summary\n${b.summary ? `${b.summary}\n` : ''}\n`);
  parts.push(`## Resources\n${b.resourcesText ? `${b.resourcesText}\n` : ''}\n`);
  parts.push(`## Plan\n${b.planText ? `${b.planText}\n` : ''}`);
  for (const s of b.extra ?? []) parts.push(`\n## ${s.heading}\n${s.body ? `${s.body}\n` : ''}`);
  return parts.join('');
}

export function emptyBrief(sessionId) {
  return parseBrief(serializeBrief({ meta: { session: sessionId } }));
}

/**
 * Add auto-extracted resources to the Resources section: every existing line is kept as it is
 * (hand-written ones included), new items are appended unless their key is already there or
 * was dismissed. → { text, added }.
 */
export function mergeResources(resourcesText, items, dismissed = [], { max = 80 } = {}) {
  const existing = String(resourcesText ?? '').trimEnd();
  const lines = existing ? existing.split('\n') : [];
  const have = new Set();
  let count = 0;
  for (const line of lines) {
    const b = BULLET_RE.exec(line);
    if (!b) continue;
    count += 1;
    const r = parseResourceLine(b[1]);
    have.add(r.key);
    if (r.url) have.add(resourceKey({ url: classifyUrl(r.url).url }));
  }
  const skip = new Set(dismissed);
  let added = 0;
  for (const item of items) {
    const key = resourceKey(item);
    if (!key || have.has(key) || skip.has(key)) continue;
    if (count >= max) break;
    lines.push(`- ${formatResource(item)}`);
    have.add(key);
    count += 1;
    added += 1;
  }
  return { text: lines.join('\n'), added };
}

/** Keys that were in `before`'s Resources and are gone from `after`'s: what a human deleted. */
export function removedResourceKeys(before, after) {
  const now = new Set(after.resources.map((r) => r.key));
  return before.resources.map((r) => r.key).filter((k) => k && !now.has(k));
}

export function addDismissed(dismissed = [], keys = []) {
  const out = [...dismissed.filter((k) => !keys.includes(k)), ...keys];
  return out.slice(-MAX_DISMISSED);
}

// ------------------------------------------------------------------ model output

const MAX_SUMMARY_CHARS = 1200;
const MAX_PLAN_ITEMS = 20;

/**
 * Validate what the model answered: `## Summary` (required, prose, ≤ 1200 chars) and
 * optionally `## Plan` (checkbox items only; anything else is dropped). → { summary, plan|null }
 * or null for garbage — the caller then keeps the old brief.
 */
export function parseModelOutput(text) {
  let t = String(text ?? '').trim();
  const fence = /^```[\w-]*\n([\s\S]*?)\n```$/.exec(t);
  if (fence) t = fence[1].trim();
  if (!/^##\s+summary\s*$/im.test(t)) return null;
  const b = parseBrief(t);
  const summary = b.summary.trim();
  if (!summary || summary.length > MAX_SUMMARY_CHARS || /^#/m.test(summary) || /^---$/m.test(summary)) return null;
  const hasPlan = /^##\s+plan\s*$/im.test(t);
  const plan = hasPlan ? b.plan.filter((i) => i.text && i.text.length <= 300).slice(0, MAX_PLAN_ITEMS) : null;
  return { summary, plan: plan && plan.length ? plan : null };
}

// ------------------------------------------------------------------ continue prompt

/**
 * The first prompt for a NEW session that picks up where the brief's session left off.
 * `where` = { host, cwd } (defaults: the brief's frontmatter).
 */
export function continuePrompt(brief, where = {}) {
  const host = where.host ?? brief.meta?.host ?? null;
  const cwd = where.cwd ?? brief.meta?.cwd ?? null;
  const session = brief.meta?.session ?? null;
  const origin = [session ? `session ${session}` : 'a previous session', host ? `on ${host}` : null, cwd ? `in ${cwd}` : null]
    .filter(Boolean)
    .join(' ');
  const out = [`Continue the work of ${origin}. Its brief:`];
  if (brief.summary) out.push(`Summary:\n${brief.summary}`);
  if (brief.resourcesText) out.push(`Resources:\n${brief.resourcesText}`);
  if (brief.planText) out.push(`Plan:\n${brief.planText}`);
  const open = brief.plan?.find((i) => !i.done);
  out.push(
    `${open ? `Pick up the first open plan item ("${open.text}")` : 'Pick up where it left off'}. ` +
      'Check the current state (git status, the files and PRs above) before changing anything, and tell me briefly what you found first.',
  );
  return out.join('\n\n');
}
