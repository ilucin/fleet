// Shared fleet config (owned by the `fleet` CLI, read here).
//
// Path: $FLEET_CONFIG, else ${XDG_CONFIG_HOME:-~/.config}/fleet/config.json.
// Shape (v1) — see config.example.json and ARCHITECTURE.md:
//   { version, self, defaultHost, hosts: { name: { ssh, web } }, web: { port, bind, dir, ui },
//     tmux, fleetBin, claude, spawnDirs: [ { label, paths: { host: dir } } ] }
//
// A missing config file is not an error: the server runs as a single local host
// ("local", 127.0.0.1, no peers). A present-but-broken file is a hard error.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_PORT = 7777;
export const DEFAULT_SELF = 'local';
export const SUPPORTED_VERSION = 1;

const BIN_FALLBACK_DIRS = ['/opt/homebrew/bin', '/usr/local/bin'];

/** Expand a leading `~` / `~/` against `home`. Other paths pass through. */
export function expandHome(p, home = os.homedir()) {
  if (typeof p !== 'string') return p;
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  return p;
}

/** Where the shared config lives. */
export function configPath(env = process.env, home = os.homedir()) {
  if (env.FLEET_CONFIG) return path.resolve(expandHome(env.FLEET_CONFIG, home));
  const base = env.XDG_CONFIG_HOME ? expandHome(env.XDG_CONFIG_HOME, home) : path.join(home, '.config');
  return path.join(base, 'fleet', 'config.json');
}

/** Prepend the usual Homebrew / user bin dirs so children launched by launchd find binaries. */
export function ensurePath(env = process.env, home = os.homedir()) {
  const extra = ['/opt/homebrew/bin', path.join(home, '.local', 'bin'), '/usr/local/bin'];
  const current = (env.PATH || '').split(':').filter(Boolean);
  const merged = [...extra.filter((p) => !current.includes(p)), ...current];
  env.PATH = merged.join(':');
  return env.PATH;
}

function isExecutable(file, fsImpl = fs) {
  try {
    fsImpl.accessSync(file, fs.constants.X_OK);
    return fsImpl.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve a binary: explicit path (config/env) wins; else first hit on PATH, then the
 * extra dirs. Returns an absolute path, or the bare `name` so execFile reports ENOENT.
 */
export function resolveBinary(name, { explicit = null, env = process.env, extraDirs = [], home = os.homedir(), fsImpl = fs } = {}) {
  if (typeof explicit === 'string' && explicit.trim()) return expandHome(explicit.trim(), home);
  const dirs = [...(env.PATH || '').split(':').filter(Boolean), ...BIN_FALLBACK_DIRS, ...extraDirs];
  for (const dir of dirs) {
    const candidate = path.join(expandHome(dir, home), name);
    if (isExecutable(candidate, fsImpl)) return candidate;
  }
  return name;
}

/** `fleet` binary: FLEET_BIN env > config.fleetBin > PATH > ~/.local/bin > ~/.cargo/bin. */
export function resolveFleetBin(raw = {}, { env = process.env, home = os.homedir(), fsImpl = fs } = {}) {
  return resolveBinary('fleet', {
    explicit: env.FLEET_BIN || raw.fleetBin,
    env,
    home,
    fsImpl,
    extraDirs: [path.join(home, '.local', 'bin'), path.join(home, '.cargo', 'bin')],
  });
}

function parsePort(value, label) {
  const port = typeof value === 'string' ? Number.parseInt(value, 10) : Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`${label} invalid: ${value}`);
  return port;
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Map one `spawnDirs` entry to the `{ label, path }` this host offers (or null when the
 * entry has no path for this host). Accepts `{ label, paths: { host: dir } }` (canonical)
 * and `{ label, path }` (same dir on every host).
 */
function spawnDirFor(entry, self, home) {
  if (typeof entry === 'string') entry = { path: entry };
  if (!isObject(entry)) throw new Error('config.spawnDirs entries must be objects');
  let dir = null;
  if (isObject(entry.paths)) dir = entry.paths[self] ?? null;
  else if (typeof entry.path === 'string') dir = entry.path;
  if (dir == null) return null;
  if (typeof dir !== 'string' || !dir.trim()) throw new Error('config.spawnDirs paths must be non-empty strings');
  const abs = expandHome(dir.trim(), home);
  if (!path.isAbsolute(abs)) throw new Error(`config.spawnDirs path must be absolute or start with ~: ${dir}`);
  const label = typeof entry.label === 'string' && entry.label.trim() ? entry.label.trim() : path.basename(abs);
  return { label, path: path.normalize(abs) };
}

/**
 * Turn the raw shared config into what the server needs:
 *   { self, port, bind, peers: { name: url }, hosts: [names], fleetBin, tmux, claude,
 *     spawnDirs: [{ label, path }], uiDir, quickReplies, configFile, configFound }
 */
export function normalizeConfig(
  raw = {},
  { env = process.env, home = os.homedir(), found = true, webRoot = null, fsImpl = fs } = {},
) {
  if (!isObject(raw)) throw new Error('config must be a JSON object');
  if (raw.version != null && raw.version !== SUPPORTED_VERSION) {
    throw new Error(`config.version ${raw.version} is not supported (expected ${SUPPORTED_VERSION})`);
  }

  const self = raw.self == null ? DEFAULT_SELF : raw.self;
  if (typeof self !== 'string' || !self.trim()) throw new Error('config.self must be a non-empty string');

  const hosts = raw.hosts == null ? {} : raw.hosts;
  if (!isObject(hosts)) throw new Error('config.hosts must be an object of name -> { ssh, web }');
  const peers = {};
  for (const [name, host] of Object.entries(hosts)) {
    if (name === self.trim()) continue; // never peer with yourself
    if (!isObject(host)) throw new Error(`config.hosts.${name} must be an object`);
    if (host.web == null) continue; // host without a web server: not a peer
    if (typeof host.web !== 'string' || !/^https?:\/\//.test(host.web)) {
      throw new Error(`config.hosts.${name}.web must be an http(s) url`);
    }
    peers[name] = host.web.replace(/\/+$/, '');
  }

  const web = raw.web == null ? {} : raw.web;
  if (!isObject(web)) throw new Error('config.web must be an object');

  let port = DEFAULT_PORT;
  if (web.port != null) port = parsePort(web.port, 'config.web.port');
  const envPort = env.FLEET_WEB_PORT || env.PORT;
  if (envPort) port = parsePort(envPort, 'FLEET_WEB_PORT/PORT');

  // No config → loopback only (there is no auth). With a config, default to all
  // interfaces so peers on the tailnet can reach this host.
  let bind = found ? '0.0.0.0' : '127.0.0.1';
  if (typeof web.bind === 'string' && web.bind) bind = web.bind;
  if (env.FLEET_WEB_BIND) bind = env.FLEET_WEB_BIND;

  const defaultUi = webRoot ? path.join(webRoot, 'public') : null;
  const uiRaw = env.FLEET_WEB_UI || (typeof web.ui === 'string' && web.ui ? web.ui : null);
  const uiDir = uiRaw ? path.resolve(expandHome(uiRaw, home)) : defaultUi;

  const spawnList = raw.spawnDirs == null ? [] : raw.spawnDirs;
  if (!Array.isArray(spawnList)) throw new Error('config.spawnDirs must be an array');
  let spawnDirs = spawnList.map((e) => spawnDirFor(e, self.trim(), home)).filter(Boolean);
  if (spawnDirs.length === 0) spawnDirs = [{ label: 'Home', path: home }];

  let quickReplies = null;
  if (web.quickReplies != null) {
    if (!Array.isArray(web.quickReplies)) throw new Error('config.web.quickReplies must be an array');
    quickReplies = web.quickReplies.map((q) => {
      const r = typeof q === 'string' ? { label: q, text: q } : q;
      if (!isObject(r) || typeof r.text !== 'string' || !r.text) {
        throw new Error('config.web.quickReplies entries must be strings or { label, text }');
      }
      return { label: typeof r.label === 'string' && r.label ? r.label : r.text, text: r.text };
    });
  }

  return {
    self: self.trim(),
    port,
    bind,
    peers,
    hosts: [self.trim(), ...Object.keys(peers)],
    fleetBin: resolveFleetBin(raw, { env, home, fsImpl }),
    tmux: resolveBinary('tmux', { explicit: env.FLEET_TMUX || raw.tmux, env, home, fsImpl }),
    claude: typeof raw.claude === 'string' && raw.claude ? expandHome(raw.claude, home) : 'claude',
    spawnDirs,
    uiDir,
    quickReplies,
  };
}

/** Read + normalize the shared config. Throws with a clear message on a broken file. */
export function loadConfig({ env = process.env, home = os.homedir(), webRoot = null, log = console, fsImpl = fs } = {}) {
  const file = configPath(env, home);
  let raw = {};
  let found = false;
  let text = null;
  try {
    text = fsImpl.readFileSync(file, 'utf8');
  } catch (err) {
    if (err?.code !== 'ENOENT') throw new Error(`cannot read fleet config ${file}: ${err.message}`);
  }
  if (text != null) {
    found = true;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new Error(`fleet config ${file} is not valid JSON: ${err.message}`);
    }
  } else {
    log.warn?.(`[config] no fleet config at ${file} — running as a single local host. Run \`fleet init\` to set up hosts.`);
  }
  let cfg;
  try {
    cfg = normalizeConfig(raw, { env, home, found, webRoot, fsImpl });
  } catch (err) {
    throw new Error(`invalid fleet config ${file}: ${err.message}`);
  }
  return { ...cfg, configFile: found ? file : null };
}
