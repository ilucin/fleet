// The HTTP JSON API (/api/*), independent of any UI. server.mjs mounts it next to the
// static UI; tests mount it on an ephemeral port with fake dependencies.
// Endpoint reference: ARCHITECTURE.md → "HTTP API".
import { HttpError, readJsonBody } from './http.mjs';
import { clampLines, findSession, resolveHost, validateKey, validateSendText } from './util.mjs';
import { resolveAllowedDir, validateSpawnRequest } from './spawn.mjs';
import { fetchPeerHost as defaultFetchPeerHost, proxyToPeer as defaultProxyToPeer } from './peers.mjs';
import { createSnapshot } from './snapshot.mjs';
import { DISABLED_GROUPS } from './grouping.mjs';

export const API_VERSION = 1;

const SESSION_ROUTE = /^\/api\/hosts\/([^/]+)\/sessions\/([^/]+)\/(peek|messages|send|keys|kill)$/;
const POST_ACTIONS = new Set(['send', 'keys', 'kill']);
const SPAWN_ROUTE = /^\/api\/hosts\/([^/]+)\/spawn$/;
const AUTONAME_ROUTE = /^\/api\/hosts\/([^/]+)\/autoname$/;

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
 *   killer      lib/kill.mjs killer (kill action; absent → 501)
 *   autoNamer   lib/autoname.mjs instance (autoname route + health; absent → 501)
 *   grouper     lib/grouping.mjs instance when THIS host runs grouping (absent → proxy to the
 *               grouping host, or a disabled response)
 *   warmFleet   keep the merged /api/fleet warm in the background (lib/snapshot.mjs)
 *   name, version, startedAt   for /api/health
 *   fetchPeerHost, proxyToPeer (optional, for tests)
 * @returns {(req, url) => Promise<{status, body}>}  throws HttpError / BackendError.
 *   The function carries `.refreshFleet()` and `.stop()` (clears the background refresh).
 */
export function createApi({
  config,
  fleet,
  backend,
  transcripts,
  spawner,
  killer = null,
  autoNamer = null,
  grouper = null,
  groupingDiscoveryMs = 5 * 60 * 1000,
  name = 'fleet-web',
  version = '0.0.0',
  startedAt = Date.now(),
  fetchPeerHost = defaultFetchPeerHost,
  proxyToPeer = defaultProxyToPeer,
  peerFleetTimeoutMs = 6000,
  peerProxyTimeoutMs = 20000,
  warmFleet = true,
  fleetRefreshMs = 3000,
  fleetIdleAfterMs = 90 * 1000,
  logError = () => {},
}) {
  async function buildFleet({ force = false } = {}) {
    const selfHost = { ...(await fleet.localHost({ force })), spawnDirs: config.spawnDirs };
    const peerNames = Object.keys(config.peers);
    const peerHosts = await Promise.all(
      peerNames.map((n) => fetchPeerHost(n, config.peers[n], { timeoutMs: peerFleetTimeoutMs })),
    );
    return { self: config.self, hosts: [selfHost, ...peerHosts] };
  }

  // The merged fleet, served stale-while-revalidate so a page load never waits on
  // discovery or the slowest peer (see lib/snapshot.mjs).
  const snapshot = warmFleet
    ? createSnapshot({ build: () => buildFleet({ force: true }), refreshMs: fleetRefreshMs, idleAfterMs: fleetIdleAfterMs, logError })
    : null;

  /** After a mutation: drop the local cache and rebuild the merged snapshot behind it. */
  function refreshFleet() {
    fleet.invalidate?.();
    snapshot?.refresh().catch(() => {});
  }

  async function handleFleet(url) {
    if (url.searchParams.get('local') === '1') {
      // Peers poll this: the local host (2s TTL cache), never the merged snapshot.
      const selfHost = { ...(await fleet.localHost()), spawnDirs: config.spawnDirs };
      return { status: 200, body: { self: config.self, hosts: [selfHost] } };
    }
    if (snapshot) return { status: 200, body: await snapshot.get() };
    return { status: 200, body: { ...(await buildFleet()), snapshotAt: Date.now() } };
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
    if (action === 'kill') {
      if (!killer) throw new HttpError('kill is not available on this server', 501);
      const session = await resolveLocalSession(id);
      const result = await killer.kill(session);
      refreshFleet();
      return {
        status: 200,
        body: { ok: true, host: config.self, id: session.session_id, name: session.name ?? null, ...result },
      };
    }

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
      // No name typed → let Claude derive one and the auto-namer replace it (when it runs).
      const nameGiven = check.nameGiven !== false || !config.autoName?.enabled;
      const result = await spawner.spawn({ ...check, nameGiven });
      refreshFleet();
      return { status: 200, body: { ok: true, host: config.self, ...result } };
    } catch (err) {
      if (err?.status) throw new HttpError(err.message, err.status);
      throw err;
    }
  }

  // --- /api/groups: served by the grouping host, proxied from everywhere else ----------
  let discovered = null; // { at, name } — the peer found running grouping (name null: none)

  async function groupsTarget(url) {
    if (grouper) return { kind: 'self' };
    if (url.searchParams.get('local') === '1') return { kind: 'none' }; // never chain
    const host = config.grouping?.host ?? null;
    if (host === config.self) return { kind: 'none' };
    if (host) {
      const peerUrl = config.peers[host];
      if (!peerUrl) return { kind: 'none', error: `grouping.host "${host}" is not a peer with a web URL` };
      return { kind: 'peer', name: host, url: peerUrl };
    }
    // No grouping.host: the first peer whose server runs grouping (cached).
    if (!discovered || Date.now() - discovered.at > groupingDiscoveryMs) {
      let found = null;
      for (const [peer, peerUrl] of Object.entries(config.peers)) {
        const r = await proxyToPeer(peerUrl, { method: 'GET', pathname: '/api/groups', timeoutMs: 3000 });
        if (r.status === 200 && r.body?.enabled === true) {
          found = peer;
          break;
        }
      }
      discovered = { at: Date.now(), name: found };
    }
    return discovered.name ? { kind: 'peer', name: discovered.name, url: config.peers[discovered.name] } : { kind: 'none' };
  }

  async function handleGroups(req, url, action) {
    const target = await groupsTarget(url);
    if (action === 'get') {
      if (target.kind === 'self') return { status: 200, body: grouper.response() };
      if (target.kind === 'peer') {
        const r = await proxyToPeer(target.url, { method: 'GET', pathname: '/api/groups', timeoutMs: peerProxyTimeoutMs });
        if (r.status === 200) return { status: 200, body: r.body };
        discovered = null;
        return { status: 200, body: { ...DISABLED_GROUPS, host: target.name, error: r.body?.error ?? `HTTP ${r.status}` } };
      }
      return { status: 200, body: { ...DISABLED_GROUPS, ...(target.error ? { error: target.error } : {}) } };
    }
    // run
    await readJsonBody(req);
    if (target.kind === 'self') {
      const body = await grouper.runOnce('manual');
      refreshFleet();
      return { status: body.lastRun?.ok === false ? 502 : 200, body };
    }
    if (target.kind === 'peer') {
      const r = await proxyToPeer(target.url, {
        method: 'POST',
        pathname: '/api/groups/run',
        body: '{}',
        timeoutMs: 6 * 60 * 1000,
      });
      return { status: r.status, body: r.body };
    }
    throw new HttpError(target.error ?? 'smart grouping is not enabled on this fleet (web.grouping.enabled)', 501);
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

  async function handleApi(req, url) {
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
          autoName: { ...(config.autoName ?? { enabled: false }), lastRun: autoNamer?.lastRun ?? null },
          grouping: {
            enabled: Boolean(grouper),
            host: grouper ? config.self : (config.grouping?.host ?? null),
            lastRun: grouper?.lastRun ?? null,
          },
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

    if (url.pathname === '/api/groups') {
      if (req.method !== 'GET') throw new HttpError('method not allowed', 405);
      return handleGroups(req, url, 'get');
    }

    if (url.pathname === '/api/groups/run') {
      if (req.method !== 'POST') throw new HttpError('method not allowed', 405);
      return handleGroups(req, url, 'run');
    }

    const m = SESSION_ROUTE.exec(url.pathname);
    if (m) {
      const [, rawHost, rawId, action] = m;
      const wantPost = POST_ACTIONS.has(action);
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

    const a = AUTONAME_ROUTE.exec(url.pathname);
    if (a) {
      if (req.method !== 'POST') throw new HttpError('method not allowed', 405);
      return forHost({
        req,
        url,
        host: decodeURIComponent(a[1]),
        local: async () => {
          await readJsonBody(req);
          if (!autoNamer) throw new HttpError('auto-naming is not available on this server', 501);
          const result = await autoNamer.runOnce('manual');
          refreshFleet();
          return { status: result.ok ? 200 : 502, body: { host: config.self, ...result } };
        },
      });
    }

    throw new HttpError('not found', 404);
  }

  handleApi.refreshFleet = refreshFleet;
  /** A fresh merged fleet, built once — what the grouper feeds `fleet group`. Doesn't warm the snapshot. */
  handleApi.buildFleet = () => buildFleet({ force: true });
  /** The warm snapshot if someone is watching, else null — for cheap change checks. */
  handleApi.peekFleet = () => snapshot?.peek() ?? null;
  handleApi.stop = () => snapshot?.stop();
  return handleApi;
}
