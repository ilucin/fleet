// Start a fresh Claude Code session in a new tmux session (one tmux session = one job,
// same convention as `fleet tmux new`). Mirrors `fleet spawn` (tmux): open the pane in `dir`,
// then type `claude -n <name> '<prompt>'` into the shell so the user's PATH/profile apply.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;

/** POSIX single-quote shell escaping (same as the fleet CLI's `shq`). */
export function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** Sanitize a user-typed name into a tmux-safe session name (like `fleet tmux new`). */
export function sanitizeName(raw) {
  const cleaned = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return cleaned;
}

export function defaultName(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `fw-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

/** Build the shell line typed into the new pane. */
export function launchCommand({ launcher = 'claude', name, prompt }) {
  const parts = [launcher, '-n', shq(name)];
  if (prompt && prompt.trim()) parts.push(shq(prompt));
  return parts.join(' ');
}

export function validateSpawnRequest(body, { spawnDirs = [] } = {}) {
  const errors = [];
  const name = body?.name ? sanitizeName(body.name) : defaultName();
  if (!NAME_RE.test(name)) errors.push('name must be 1-40 chars of letters, digits, - or _');

  let dir = typeof body?.dir === 'string' && body.dir.trim() ? body.dir.trim() : spawnDirs[0];
  if (!dir) errors.push('dir is required');
  else if (!path.isAbsolute(dir)) errors.push('dir must be an absolute path');
  else dir = path.normalize(dir);

  let prompt = '';
  if (body?.prompt != null) {
    if (typeof body.prompt !== 'string') errors.push('prompt must be a string');
    else if (body.prompt.length > 8000) errors.push('prompt too long (max 8000 chars)');
    else prompt = body.prompt;
  }
  if (errors.length) return { ok: false, error: errors.join('; ') };
  return { ok: true, name, dir, prompt };
}

/** True when `child` is `root` or lies beneath it (both already resolved). */
export function isWithin(child, root) {
  const rel = path.relative(root, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Resolve `dir` (realpath: follows symlinks, collapses `..`) and require it to be one of
 * `roots` (this host's spawnDirs; $HOME when none) or a subdirectory of one. Returns the
 * resolved path; throws `{ status: 400 }` otherwise, so a web client can't start Claude
 * anywhere on the machine.
 */
export async function resolveAllowedDir(dir, roots, { home = os.homedir() } = {}) {
  const list = roots?.length ? roots : [home];
  let real;
  try {
    real = await fs.realpath(dir);
  } catch {
    throw Object.assign(new Error(`dir does not exist: ${dir}`), { status: 400 });
  }
  const resolvedRoots = [];
  for (const r of list) {
    try {
      resolvedRoots.push(await fs.realpath(r));
    } catch {
      /* a configured root that doesn't exist on disk allows nothing */
    }
  }
  if (!resolvedRoots.some((r) => isWithin(real, r))) {
    throw Object.assign(
      new Error(`dir is not inside one of this host's spawn dirs (${list.join(', ')}): ${dir}`),
      { status: 400 },
    );
  }
  return real;
}

export function createSpawner({ run, tmux = 'tmux', launcher = 'claude', enterDelayMs = 400, sleep }) {
  const wait = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

  async function tmuxHasSession(name) {
    try {
      await run(tmux, ['has-session', '-t', `=${name}`], { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  /** @returns {{ name, dir, tmuxSession, command }} */
  async function spawn({ name, dir, prompt }) {
    let st;
    try {
      st = await fs.stat(dir);
    } catch {
      throw Object.assign(new Error(`dir does not exist: ${dir}`), { status: 400 });
    }
    if (!st.isDirectory()) throw Object.assign(new Error(`not a directory: ${dir}`), { status: 400 });
    if (await tmuxHasSession(name)) {
      throw Object.assign(new Error(`tmux session "${name}" already exists`), { status: 409 });
    }
    await run(tmux, ['new-session', '-d', '-s', name, '-c', dir], { timeout: 8000 });
    const command = launchCommand({ launcher, name, prompt });
    // Give the login shell a moment to source its profile before typing into it.
    await wait(enterDelayMs);
    await run(tmux, ['send-keys', '-t', `${name}:`, '-l', '--', command], { timeout: 8000 });
    await wait(150);
    await run(tmux, ['send-keys', '-t', `${name}:`, 'Enter'], { timeout: 8000 });
    const trusted = await acceptTrustPrompt(name);
    return { name, dir, tmuxSession: name, command, trusted };
  }

  /**
   * A directory Claude has never run in stops at "Is this a project you trust?" with
   * "No, exit" preselected; `fleet list` does not show the session until that is answered.
   * The user picked the directory explicitly, so answer "Yes" (Down, Enter) for them.
   * Polls the pane for up to ~8s; returns true when the prompt was seen and accepted.
   */
  async function acceptTrustPrompt(name, { tries = 16, intervalMs = 500, settleMs = 1200 } = {}) {
    for (let i = 0; i < tries; i += 1) {
      await wait(intervalMs);
      let text = '';
      try {
        ({ stdout: text } = await run(tmux, ['capture-pane', '-p', '-t', `${name}:`], { timeout: 5000 }));
      } catch {
        return false; // pane gone
      }
      if (/trust this folder/i.test(text)) {
        // The dialog is drawn before Ink listens for keys: settle, move to "Yes",
        // and only press Enter once the pane shows "Yes" highlighted — an early
        // Enter would confirm the preselected "No, exit".
        await wait(settleMs);
        for (let attempt = 0; attempt < 4; attempt += 1) {
          await run(tmux, ['send-keys', '-t', `${name}:`, 'Down'], { timeout: 5000 });
          await wait(400);
          const { stdout: after } = await run(tmux, ['capture-pane', '-p', '-t', `${name}:`], { timeout: 5000 });
          if (/[❯>]\s*Yes, I trust/i.test(after)) {
            await run(tmux, ['send-keys', '-t', `${name}:`, 'Enter'], { timeout: 5000 });
            return true;
          }
        }
        return false;
      }
      if (/^\s*[❯>]\s*$/m.test(text) || /bypass permissions|auto mode|shift\+tab/i.test(text)) return false; // Claude is up
    }
    return false;
  }

  return { spawn, tmuxHasSession, acceptTrustPrompt };
}
