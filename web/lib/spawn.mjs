// Start a fresh Claude Code session in a new tmux session (one tmux session = one job,
// same convention as `fleet tmux new`). Mirrors `fleet spawn` (tmux): open the pane in `dir`,
// then type `claude [--model <id>] [-n <name>] '<prompt>'` into the shell so the user's PATH/profile apply.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MODEL_ID_RE } from './config.mjs';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;

/** POSIX single-quote shell escaping (same as the fleet CLI's `shq`). */
export function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * Quote a string that gets *typed* into a shell. A raw newline inside '…' does not survive
 * being typed (zsh drops it), so multi-line text goes as ANSI-C `$'…'` with escapes instead.
 */
export function shqTyped(s) {
  const str = String(s);
  if (!/[\n\r\t]/.test(str)) return shq(str);
  const esc = str.replace(/[\\'\n\r\t]/g, (c) => ({ '\\': '\\\\', "'": "\\'", '\n': '\\n', '\r': '\\r', '\t': '\\t' })[c]);
  return `$'${esc}'`;
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

/**
 * The longest line we type inline. A fresh pane's shell may still be sourcing its profile,
 * so typed text can land in the tty's canonical-mode buffer, which macOS caps at 1024 bytes
 * (MAX_CANON) — the rest is dropped and the command never runs. Longer prompts go via a file.
 */
export const TYPED_LINE_MAX = 900;

/** Build the shell line typed into the new pane (`promptFile`: read the prompt from there). */
export function launchCommand({ launcher = 'claude', name, prompt, model, promptFile }) {
  // No name → plain `claude`: it derives `<cwd>-9d` and the auto-namer (lib/autoname.mjs)
  // replaces that with a task-shaped name, tmux session included, once the session is idle.
  const parts = [launcher];
  if (model) parts.push('--model', shq(model));
  if (name) parts.push('-n', shq(name));
  if (promptFile) parts.push(`"$(cat ${shq(promptFile)})"`);
  else if (prompt && prompt.trim()) parts.push(shqTyped(prompt));
  return parts.join(' ');
}

export function validateSpawnRequest(body, { spawnDirs = [] } = {}) {
  const errors = [];
  const nameGiven = Boolean(body?.name && sanitizeName(body.name));
  const name = nameGiven ? sanitizeName(body.name) : defaultName();
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
  // Typed into a shell: a strict charset on top of the quoting. '' / absent = Claude's default.
  let model = '';
  if (body?.model != null && body.model !== '') {
    if (typeof body.model !== 'string' || !MODEL_ID_RE.test(body.model)) {
      errors.push('model must be 1-100 chars of letters, digits, . _ [ ] or -');
    } else model = body.model;
  }
  if (errors.length) return { ok: false, error: errors.join('; ') };
  return { ok: true, name, dir, prompt, nameGiven, model };
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

/**
 * `promptDir`: where prompts too long to type are written (like `fleet handoff` briefs,
 * they are kept — the record of what the session was started with).
 */
export function createSpawner({
  run,
  tmux = 'tmux',
  launcher = 'claude',
  enterDelayMs = 400,
  sleep,
  promptDir = path.join(os.homedir(), '.claude', 'fleet-prompts'),
}) {
  const wait = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

  async function tmuxHasSession(name) {
    try {
      await run(tmux, ['has-session', '-t', `=${name}`], { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  /** @returns {{ name, dir, tmuxSession, command, trusted, model }} */
  async function spawn({ name, dir, prompt, nameGiven = true, model = '' }) {
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
    const launch = { launcher, name: nameGiven ? name : null, prompt, model };
    let command = launchCommand(launch);
    if (Buffer.byteLength(command) > TYPED_LINE_MAX) {
      const d = new Date();
      const p = (n) => String(n).padStart(2, '0');
      const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
      const promptFile = path.join(promptDir, `${stamp}-${name}.md`);
      await fs.mkdir(promptDir, { recursive: true, mode: 0o700 });
      await fs.writeFile(promptFile, prompt, { mode: 0o600 });
      command = launchCommand({ ...launch, promptFile });
    }
    // Give the login shell a moment to source its profile before typing into it.
    await wait(enterDelayMs);
    await run(tmux, ['send-keys', '-t', `${name}:`, '-l', '--', command], { timeout: 8000 });
    await wait(150);
    await run(tmux, ['send-keys', '-t', `${name}:`, 'Enter'], { timeout: 8000 });
    const trusted = await acceptTrustPrompt(name);
    return { name, dir, tmuxSession: name, command, trusted, model: model || null };
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
