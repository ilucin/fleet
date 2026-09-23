import { sortSessions } from './util.mjs';

function withLocalFlag(search) {
  const params = new URLSearchParams(search ?? '');
  params.set('local', '1');
  return params.toString();
}

async function fetchWithTimeout(url, opts, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function describeError(err, timeoutMs) {
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') return `timed out after ${timeoutMs}ms`;
  const cause = err?.cause?.message ?? err?.cause?.code;
  return cause ? `${err.message} (${cause})` : String(err?.message ?? err);
}

/**
 * Ask a peer for its local fleet and return a single host entry for it.
 * Never throws — an unreachable peer becomes { ok:false, error:"unreachable: ..." }.
 */
export async function fetchPeerHost(name, baseUrl, { timeoutMs = 6000, now = Date.now } = {}) {
  const fetchedAt = now();
  try {
    const res = await fetchWithTimeout(
      `${baseUrl}/api/fleet?local=1`,
      { headers: { accept: 'application/json' } },
      timeoutMs,
    );
    if (!res.ok) {
      return { name, ok: false, error: `unreachable: HTTP ${res.status}`, fetchedAt, sessions: [] };
    }
    const body = await res.json();
    const hosts = Array.isArray(body?.hosts) ? body.hosts : [];
    const host = hosts.find((h) => h?.name === name) ?? hosts[0];
    if (!host) {
      return { name, ok: false, error: 'unreachable: peer returned no hosts', fetchedAt, sessions: [] };
    }
    const sessions = sortSessions(Array.isArray(host.sessions) ? host.sessions : []).map((s) => ({
      ...s,
      host: name,
    }));
    return {
      name,
      ok: host.ok !== false,
      ...(host.ok === false && host.error ? { error: host.error } : {}),
      fetchedAt: Number(host.fetchedAt) || fetchedAt,
      ...(Array.isArray(host.spawnDirs) ? { spawnDirs: host.spawnDirs } : {}),
      sessions,
    };
  } catch (err) {
    return { name, ok: false, error: `unreachable: ${describeError(err, timeoutMs)}`, fetchedAt, sessions: [] };
  }
}

/**
 * Proxy a single-host request to a peer, forcing ?local=1 so it is never re-proxied.
 * Returns { status, body } where body is already-parsed JSON (or an error envelope).
 */
export async function proxyToPeer(baseUrl, { method = 'GET', pathname, search = '', body = null, timeoutMs = 15000 } = {}) {
  const url = `${baseUrl}${pathname}?${withLocalFlag(search)}`;
  try {
    const res = await fetchWithTimeout(
      url,
      {
        method,
        headers: {
          accept: 'application/json',
          ...(body != null ? { 'content-type': 'application/json' } : {}),
        },
        ...(body != null ? { body } : {}),
      },
      timeoutMs,
    );
    const text = await res.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      return { status: 502, body: { error: 'peer returned non-JSON response' } };
    }
    return { status: res.status, body: parsed };
  } catch (err) {
    const message = describeError(err, timeoutMs);
    const status = /timed out/.test(message) ? 504 : 502;
    return { status, body: { error: `peer ${baseUrl} unreachable: ${message}` } };
  }
}
