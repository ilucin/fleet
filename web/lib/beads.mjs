// Beads (`bd`, a dependency-aware issue tracker for agents): the issues a session works on.
//
// lib/brief-extract.mjs finds bead-id-shaped tokens in the session's `bd` commands (and the ids
// `bd create` prints); this module asks this host's `bd` which of them exist and reduces them to
// their top-level parents (an epic, or an issue without a parent): the Beads section of the
// session's Details. `bead()` is the viewer: one issue with its children, comments and links.
//
// bd runs in the session's cwd, with BEADS_DIR = web.beads.dir (else $BEADS_DIR) when set, so a
// global database and a per-repo `.beads/` both work. Read-only: only show / list / comments.
import os from 'node:os';

/** A bead id from the URL: never a flag, nothing a shell would care about. */
export const BEAD_ID_PARAM_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
/** Candidate ids checked per request (the newest the session touched). */
export const MAX_CANDIDATES = 40;
/** Parents listed per session. */
export const MAX_PARENTS = 12;
/** How long a session's list is reused. */
export const LIST_TTL_MS = 15 * 1000;
const PARENT_DEPTH = 4;

function parseJson(stdout) {
  const t = String(stdout ?? '').trim();
  if (!t) return [];
  const v = JSON.parse(t);
  return Array.isArray(v) ? v : v && typeof v === 'object' ? [v] : [];
}

/** The parent of an issue: its `parent` field, else its parent-child dependency, else the dotted id's stem. */
export function parentOf(issue) {
  if (typeof issue?.parent === 'string' && issue.parent) return issue.parent;
  const dep = (Array.isArray(issue?.dependencies) ? issue.dependencies : []).find((d) => d?.type === 'parent-child' && d.issue_id === issue.id);
  if (dep?.depends_on_id) return dep.depends_on_id;
  return null;
}

/** `bd-5kc.3.1` → `bd-5kc` (a hierarchical child's root by its id). */
export function rootByName(id) {
  const i = id.indexOf('.');
  return i === -1 ? id : id.slice(0, i);
}

/** The part of an issue the list shows. */
function summary(issue, children) {
  const closed = children.filter((c) => c.status === 'closed').length;
  return {
    id: issue.id,
    title: String(issue.title ?? ''),
    status: String(issue.status ?? ''),
    type: String(issue.issue_type ?? ''),
    priority: Number.isFinite(issue.priority) ? issue.priority : null,
    labels: Array.isArray(issue.labels) ? issue.labels : [],
    updatedAt: issue.updated_at ?? null,
    children: { total: children.length, closed, inProgress: children.filter((c) => c.status === 'in_progress').length },
  };
}

/** An issue for the viewer: everything bd says, with the dependency edges as plain lists. */
function full(issue) {
  const deps = Array.isArray(issue.dependencies) ? issue.dependencies : [];
  const out = (type) => deps.filter((d) => d?.issue_id === issue.id && d.type === type).map((d) => d.depends_on_id);
  return {
    id: issue.id,
    title: String(issue.title ?? ''),
    status: String(issue.status ?? ''),
    type: String(issue.issue_type ?? ''),
    priority: Number.isFinite(issue.priority) ? issue.priority : null,
    labels: Array.isArray(issue.labels) ? issue.labels : [],
    assignee: issue.assignee ?? null,
    owner: issue.owner ?? null,
    description: issue.description ?? '',
    design: issue.design ?? '',
    acceptance: issue.acceptance_criteria ?? '',
    notes: issue.notes ?? '',
    parent: parentOf(issue),
    blockedBy: out('blocks'),
    related: [...out('related'), ...deps.filter((d) => d?.depends_on_id === issue.id && d.type === 'related').map((d) => d.issue_id)],
    createdAt: issue.created_at ?? null,
    updatedAt: issue.updated_at ?? null,
    closedAt: issue.closed_at ?? null,
    closeReason: issue.close_reason ?? null,
    commentCount: issue.comment_count ?? 0,
  };
}

/**
 * @param {object} opts
 *   bd         (args, { cwd, env }) → Promise<{ stdout }> (run(bdBin, …)); null → disabled
 *   extractor  lib/brief-extract.mjs#createBriefExtractor (shared with the briefs)
 *   settings   config.beads: { enabled, dir }
 */
export function createBeads({ bd, extractor, settings = {}, env = process.env, now = () => Date.now(), ttlMs = LIST_TTL_MS }) {
  const enabled = typeof bd === 'function' && !!extractor && settings.enabled !== false;
  const cache = new Map(); // session id → { at, body }

  function opts(session) {
    const cwd = typeof session?.cwd === 'string' && session.cwd.startsWith('/') ? session.cwd : os.homedir();
    return { cwd, env: settings.dir ? { ...env, BEADS_DIR: settings.dir } : env, timeout: 15000 };
  }

  /** `bd show` of several ids; the ones that do not exist are left out (bd skips them). */
  async function show(ids, o) {
    if (!ids.length) return [];
    try {
      return parseJson((await bd(['show', ...ids, '--json'], o)).stdout);
    } catch (err) {
      // bd exits non-zero when one id is missing but still prints the others.
      try {
        return parseJson(err?.stdout);
      } catch {
        return [];
      }
    }
  }

  async function children(id, o) {
    return parseJson((await bd(['list', '--parent', id, '--all', '--json', '-n', '0', '--flat'], o)).stdout);
  }

  /** The session's top-level beads → { enabled, beads: [summary] }. */
  async function list(session) {
    if (!enabled) return { enabled: false, beads: [] };
    const sid = session?.session_id;
    const hit = sid && cache.get(sid);
    if (hit && now() - hit.at < ttlMs) return hit.body;
    const ext = await extractor.refresh(session);
    const ids = (ext?.beads ?? []).slice(0, MAX_CANDIDATES);
    const o = opts(session);
    // Roots by name first (one bd call), then follow `parent` up for ids that have one.
    const order = [];
    for (const id of ids) {
      const r = rootByName(id);
      if (!order.includes(r)) order.push(r);
    }
    let found = await show(order, o);
    const byId = new Map(found.map((i) => [i.id, i]));
    for (let depth = 0; depth < PARENT_DEPTH; depth++) {
      const up = [...byId.values()].map(parentOf).filter((p) => p && !byId.has(p));
      if (!up.length) break;
      for (const i of await show([...new Set(up)], o)) byId.set(i.id, i);
    }
    const top = (id) => {
      let cur = byId.get(id);
      for (let d = 0; cur && d < PARENT_DEPTH; d++) {
        const p = parentOf(cur);
        if (!p || !byId.has(p)) break;
        cur = byId.get(p);
      }
      return cur;
    };
    const parents = [];
    for (const id of order) {
      const t = top(id);
      if (t && !parents.some((p) => p.id === t.id)) parents.push(t);
      if (parents.length >= MAX_PARENTS) break;
    }
    const beads = [];
    for (const p of parents) beads.push(summary(p, await children(p.id, o).catch(() => [])));
    const body = { enabled: true, beads };
    if (sid) cache.set(sid, { at: now(), body });
    if (cache.size > 200) cache.delete(cache.keys().next().value);
    return body;
  }

  /** One issue for the viewer → { issue, children, comments, parent } or null when bd does not know it. */
  async function bead(session, id) {
    if (!enabled) return null;
    const o = opts(session);
    const [issue] = await show([id], o);
    if (!issue) return null;
    const [kids, comments] = await Promise.all([
      children(id, o).catch(() => []),
      issue.comment_count ? bd(['comments', id, '--json'], o).then((r) => parseJson(r.stdout)).catch(() => []) : Promise.resolve([]),
    ]);
    const parentId = parentOf(issue);
    const parent = parentId ? ((await show([parentId], o))[0] ?? null) : null;
    return {
      issue: full(issue),
      parent: parent ? { id: parent.id, title: String(parent.title ?? ''), status: String(parent.status ?? '') } : null,
      children: kids.map(full),
      comments: comments.map((c) => ({ author: c.author ?? null, text: String(c.text ?? c.body ?? ''), createdAt: c.created_at ?? null })),
    };
  }

  return { enabled, list, bead };
}
