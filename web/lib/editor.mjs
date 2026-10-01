// "Open in editor" links (`web.editor`: "vscode" | "cursor" | null). The browser follows them,
// so they are built for the machine the browser most likely runs on — the one whose server it
// asked: a session on this server's own host opens as a local folder (`vscode://file/<path>`),
// a session on another host through Remote-SSH with that host's ssh alias from this server's
// config (`vscode://vscode-remote/ssh-remote+<alias><path>`). A proxied response carries only
// the peer's absolute paths; the server that received the request fills in the link.

import { parseFrontmatter } from './brief-format.mjs';

export const EDITORS = ['vscode', 'cursor'];
export const DEFAULT_EDITOR = 'vscode';

/** An ssh destination that is safe in the URL's authority-like segment (alias or user@host). */
const SSH_ALIAS_RE = /^[A-Za-z0-9._@-]{1,253}$/;

function encodePath(p) {
  return p.split('/').map(encodeURIComponent).join('/');
}

/**
 * → the editor URL for `absPath` on `host`, or null (no editor, relative path, or a remote host
 * without a usable ssh alias). `config` = normalized config ({ self, editor, sshHosts }).
 */
export function editorUrl(config, host, absPath) {
  const editor = config?.editor ?? null;
  if (!EDITORS.includes(editor) || typeof absPath !== 'string' || !absPath.startsWith('/')) return null;
  if (host === config.self) return `${editor}://file${encodePath(absPath)}`;
  const alias = config.sshHosts?.[host] ?? null;
  if (typeof alias !== 'string' || !SSH_ALIAS_RE.test(alias)) return null;
  return `${editor}://vscode-remote/ssh-remote+${alias}${encodePath(absPath)}`;
}

/**
 * Fill `editor` / `editorUrl` into a GET/PUT brief body (gitRoot preferred over absCwd) and into
 * each of its `worktrees`. A peer
 * too old to send `absCwd` still has the session's cwd in the frontmatter (`cwd:`), used when
 * it is absolute.
 */
export function withBriefEditor(body, host, config) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || body.error) return body;
  let target = body.gitRoot ?? body.absCwd ?? null;
  if (target == null && body.absCwd === undefined && typeof body.markdown === 'string') {
    const cwd = parseFrontmatter(body.markdown).meta.cwd;
    if (typeof cwd === 'string' && cwd.startsWith('/')) target = cwd;
  }
  const out = { ...body, editor: config.editor ?? null, editorUrl: editorUrl(config, host, target) };
  if (Array.isArray(body.worktrees)) out.worktrees = body.worktrees.map((w) => ({ ...w, editorUrl: editorUrl(config, host, w?.path ?? null) }));
  return out;
}

/** Each session row of a fleet host gets `editorUrl` (its cwd; no git lookup — the brief has the root). */
export function withSessionEditors(hostEntry, config) {
  if (!hostEntry || !Array.isArray(hostEntry.sessions)) return hostEntry;
  return {
    ...hostEntry,
    sessions: hostEntry.sessions.map((s) => ({ ...s, editorUrl: editorUrl(config, hostEntry.name, typeof s?.cwd === 'string' ? s.cwd : null) })),
  };
}
