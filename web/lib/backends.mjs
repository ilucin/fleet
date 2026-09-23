import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { tailLines, sleep as defaultSleep } from './util.mjs';

/** Error with an HTTP status attached. */
export class BackendError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.name = 'BackendError';
    this.status = status;
  }
}

export const ITERM_SCRIPT = `on findSession(theId)
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if (id of s) is theId then return s
        end repeat
      end repeat
    end repeat
  end tell
  return missing value
end findSession

on run argv
  set theMode to item 1 of argv
  set theId to item 2 of argv
  set theSession to findSession(theId)
  if theSession is missing value then
    error "iterm session not found: " & theId number 1001
  end if
  if theMode is "peek" then
    tell application "iTerm2"
      return text of theSession
    end tell
  else if theMode is "send" then
    tell application "iTerm2"
      tell theSession to write text (item 3 of argv) without newline
    end tell
    delay 0.2
    tell application "iTerm2"
      tell theSession to write text ""
    end tell
    return "ok"
  else if theMode is "enter" then
    tell application "iTerm2"
      tell theSession to write text ""
    end tell
    return "ok"
  else if theMode is "escape" then
    tell application "iTerm2"
      tell theSession to write text (ASCII character 27) without newline
    end tell
    return "ok"
  else if theMode is "up" then
    tell application "iTerm2"
      tell theSession to write text ((ASCII character 27) & "[A") without newline
    end tell
    return "ok"
  else if theMode is "down" then
    tell application "iTerm2"
      tell theSession to write text ((ASCII character 27) & "[B") without newline
    end tell
    return "ok"
  end if
  error "unknown mode: " & theMode number 1002
end run
`;

/**
 * Write the AppleScript helper once per process and reuse the path.
 */
export function createScriptProvider({ tmpdir = os.tmpdir(), fsImpl = fs } = {}) {
  let cached = null;
  return () => {
    if (cached && fsImpl.existsSync(cached)) return cached;
    const file = path.join(tmpdir, `fleet-web-iterm-${process.pid}.applescript`);
    fsImpl.writeFileSync(file, ITERM_SCRIPT, 'utf8');
    cached = file;
    return file;
  };
}

/**
 * Backend driver. `run(file, args, opts)` is injected so the logic stays testable.
 */
export function createBackend({
  run,
  tmux = 'tmux',
  osascript = '/usr/bin/osascript',
  scriptPath = createScriptProvider(),
  sleep = defaultSleep,
  enterDelayMs = 150,
} = {}) {
  if (typeof run !== 'function') throw new TypeError('run must be a function');

  function requireHandle(session) {
    const handle = session?.handle;
    if (typeof handle !== 'string' || handle === '') {
      throw new BackendError('session has no usable handle', 409);
    }
    return handle;
  }

  function backendOf(session) {
    const b = String(session?.backend ?? 'unknown').toLowerCase();
    if (b !== 'tmux' && b !== 'iterm') {
      throw new BackendError(`backend "${session?.backend ?? 'unknown'}" cannot be controlled`, 409);
    }
    return b;
  }

  async function peek(session, lines) {
    const backend = backendOf(session);
    const handle = requireHandle(session);
    if (backend === 'tmux') {
      const { stdout } = await run(tmux, ['capture-pane', '-p', '-J', '-t', handle, '-S', `-${lines}`], {
        timeout: 8000,
      });
      return tailLines(stdout, lines);
    }
    const { stdout } = await run(osascript, [scriptPath(), 'peek', handle], { timeout: 15000 });
    return tailLines(stdout, lines);
  }

  async function send(session, text) {
    const backend = backendOf(session);
    const handle = requireHandle(session);
    if (backend === 'tmux') {
      await run(tmux, ['send-keys', '-t', handle, '-l', '--', text], { timeout: 8000 });
      await sleep(enterDelayMs);
      await run(tmux, ['send-keys', '-t', handle, 'Enter'], { timeout: 8000 });
      return;
    }
    await run(osascript, [scriptPath(), 'send', handle, text], { timeout: 15000 });
  }

  async function keys(session, key) {
    const backend = backendOf(session);
    const handle = requireHandle(session);
    if (backend === 'tmux') {
      await run(tmux, ['send-keys', '-t', handle, key], { timeout: 8000 });
      return;
    }
    const mode = { Escape: 'escape', Enter: 'enter', Up: 'up', Down: 'down' }[key] ?? 'enter';
    await run(osascript, [scriptPath(), mode, handle], { timeout: 15000 });
  }

  return { peek, send, keys };
}
