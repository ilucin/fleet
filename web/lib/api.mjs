// The HTTP JSON API (/api/*), independent of any UI. server.mjs mounts it next to the
// static UI; tests mount it on an ephemeral port with fake dependencies.
// Endpoint reference: ARCHITECTURE.md → "HTTP API".
import { HttpError, readJsonBody } from './http.mjs';
import { clampLines, findSession, resolveHost, validateKey, validateSendText } from './util.mjs';
import { resolveAllowedDir, validateSpawnRequest } from './spawn.mjs';
import { fetchPeerHost as defaultFetchPeerHost, proxyToPeer as defaultProxyToPeer } from './peers.mjs';

export const API_VERSION = 1;

const SESSION_ROUTE = /^\/api\/hosts\/([^/]+)\/sessions\/([^/]+)\/(peek|messages|send|keys)$/;
const SPAWN_ROUTE = /^\/api\/hosts\/([^/]+)\/spawn$/;

export const DEFAULT_QUICK_REPLIES = [
  { label: 'Continue', text: 'Continue.' },
  { label: 'Yes', text: 'Yes' },
  { label: 'No', text: 'No' },
  { label: '1', text: '1' },
  { label: '2', text: '2' },
];

/**
 * @param {object} deps
 *   config      normalized config (lib/config.mjs)
 *   fleet       lib/fleet.mjs instance (local discovery)
 *   backend     lib/backends.mjs instance (peek/send/keys)
 *   transcripts lib/transcript.mjs reader
 *   spawner     lib/spawn.mjs spawner
 *   name, version, startedAt   for /api/health
 *   fetchPeerHost, proxyToPeer (optional, for tests)
 * @returns {(req, url) => Promise<{status, body}>}  throws HttpError / BackendError
 */
export function createApi({
  config,
  fleet,
  backend,
  transcripts,
  spawner,
  name = 'fleet-web',
  version = '0.0.0',
  startedAt = Date.now(),
  fetchPeerHost = defaultFetchPeerHost,
  proxyToPeer = defaultProxyToPeer,
  peerFleetTimeoutMs = 6000,
  peerProxyTimeoutMs = 20000,
}) {
  async function handleFleet(url) {
    const selfHost = { ...(await fleet.localHost()), spawnDirs: config.spawnDirs };
    if (url.searchParams.get('local') === '1') return { status: 200, body: { self: config.self, hosts: [selfHost] } };
    const peerNames = Object.keys(config.peers);
    const peerHosts = await Promise.all(
      peerNames.map((n) => fetchPeerHost(n, config.peers[n], { timeoutMs: peerFleetTimeoutMs })),
    );
    return { status: 200, body: { self: config.self, hosts: [selfHost, ...peerHosts] } };
  }

  async function resolveLocalSession(id) {
    const host = await fleet.localHost();
    if (!host.ok) throw new HttpError(`session discovery failed: ${host.error}`, 503);
    const session = findSession(host.sessions, id);
    if (!session) throw new HttpError(`unknown session: ${id}`, 404);
    return session;
  }

  async function localSessionAction({ action, id, url, req }) {
    if (action === 'peek') {
      const lines = clampLines(url.searchParams.get('lines'));
      const session = await resolveLocalSession(id);
      const text = await backend.peek(session, lines);
      return {
        status: 200,
        body: { host: config.self, id: session.session_id, backend: session.backend, lines, text, capturedAt: Date.now() },
      };
    }

    if (action === 'messages') {
      const limit = clampLines(url.searchParams.get('limit'), 60, 1, 500);
      const session = await resolveLocalSession(id);
      const result = await transcripts.messages(session, limit);
      if (!result) throw new HttpError('transcript not found for this session', 404);
      return {
        status: 200,
        body: {
          host: config.self,
          id: session.session_id,
          status: session.status,
          backend: session.backend,
          name: session.name,
          limit,
          messages: result.messages,
          total: result.total,
          truncated: result.truncated,
          updatedAt: result.updatedAt,
          capturedAt: Date.now(),
        },
      };
    }

    const body = await readJsonBody(req);
    if (action === 'send') {
      const check = validateSendText(body.text);
      if (!check.ok) throw new HttpError(check.error, 400);
      const session = await resolveLocalSession(id);
      await backend.send(session, check.text);
      return { status: 200, body: { ok: true } };
    }

    // keys
    const check = validateKey(body.key);
    if (!check.ok) throw new HttpError(check.error, 400);
    const session = await resolveLocalSession(id);
    await backend.keys(session, check.key);
    return { status: 200, body: { ok: true } };
  }

  async function localSpawn(req) {
    const body = await readJsonBody(req);
    const roots = config.spawnDirs.map((d) => d.path);
    const check = validateSpawnRequest(body, { spawnDirs: roots });
    if (!check.ok) throw new HttpError(check.error, 400);
    try {
      check.dir = await resolveAllowedDir(check.dir, roots);
      const result = await spawner.spawn(check);
      fleet.invalidate?.();
      return { status: 200, body: { ok: true, host: config.self, ...result } };
    } catch (err) {
      if (err?.status) throw new HttpError(err.message, err.status);
      throw err;
    }
  }

  /** Serve locally when `host` is self, proxy (once, with ?local=1) when it is a peer. */
  async function forHost({ req, url, host, local }) {
    const target = resolveHost(host, config);
    if (target.kind === 'unknown') throw new HttpError(`unknown host: ${host}`, 404);
    if (target.kind === 'self') return local();
    if (url.searchParams.get('local') === '1') throw new HttpError(`unknown host: ${host}`, 404); // never chain
    const rawBody = req.method === 'POST' ? JSON.stringify(await readJsonBody(req)) : null;
    const proxied = await proxyToPeer(target.url, {
      method: req.method,
      pathname: url.pathname,
      search: url.search.replace(/^\?/, ''),
      body: rawBody,
      timeoutMs: peerProxyTimeoutMs,
    });
    return { status: proxied.status, body: proxied.body };
  }

  return async function handleApi(req, url) {
    if (url.pathname === '/api/health') {
      return {
        status: 200,
        body: {
          name,
          version,
          apiVersion: API_VERSION,
          self: config.self,
          uptime: Math.round((Date.now() - startedAt) / 1000),
          now: Date.now(),
        },
      };
    }

    if (url.pathname === '/api/settings') {
      if (req.method !== 'GET') throw new HttpError('method not allowed', 405);
      return {
        status: 200,
        body: {
          apiVersion: API_VERSION,
          self: config.self,
          hosts: config.hosts,
          quickReplies: config.quickReplies ?? DEFAULT_QUICK_REPLIES,
        },
      };
    }

    if (url.pathname === '/api/fleet') {
      if (req.method !== 'GET') throw new HttpError('method not allowed', 405);
      return handleFleet(url);
    }

    const m = SESSION_ROUTE.exec(url.pathname);
    if (m) {
      const [, rawHost, rawId, action] = m;
      const wantPost = action === 'send' || action === 'keys';
      if (req.method !== (wantPost ? 'POST' : 'GET')) throw new HttpError('method not allowed', 405);
      const id = decodeURIComponent(rawId);
      return forHost({
        req,
        url,
        host: decodeURIComponent(rawHost),
        local: () => localSessionAction({ action, id, url, req }),
      });
    }

    const s = SPAWN_ROUTE.exec(url.pathname);
    if (s) {
      if (req.method !== 'POST') throw new HttpError('method not allowed', 405);
      return forHost({ req, url, host: decodeURIComponent(s[1]), local: () => localSpawn(req) });
    }

    throw new HttpError('not found', 404);
  };
}
