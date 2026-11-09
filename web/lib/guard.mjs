// Browser guards. The server has no auth of its own: it trusts the network it listens on (a
// tailnet, see web.bind). That trust does not cover a web page open in a browser on that network,
// which can send requests to this server too. Two checks close that:
//
// - Host (DNS rebinding): a request must name this server by an IP address, a loopback name, a
//   fleet host (its name or its web url's host), this machine's hostname, a `*.ts.net` name or a
//   `web.allowedHosts` entry (`"*"` turns the check off). A page whose own name was re-pointed at
//   this server's address still sends its own name, and is refused.
// - Origin (cross-site requests): a request a browser sends from a page of another origin is
//   refused. Requests without an Origin (the CLI, curl, peers, the operator's ./api) pass, and so
//   do a loopback origin (a UI dev server on this machine) and a fleet server's own name (behind a
//   reverse proxy, Host and Origin differ).
import net from 'node:net';
import os from 'node:os';

const LOOPBACK_NAMES = new Set(['localhost', 'ip6-localhost', 'ip6-loopback']);

/** The hostname of a Host header (`name:port`, `[v6]:port`), lowercased, without the port. */
export function hostnameOf(hostHeader) {
  if (typeof hostHeader !== 'string' || !hostHeader.trim()) return null;
  try {
    return new URL(`http://${hostHeader.trim()}`).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return null;
  }
}

function isLoopbackName(name) {
  if (LOOPBACK_NAMES.has(name) || name.endsWith('.localhost')) return true;
  if (net.isIPv4(name)) return name.startsWith('127.');
  return name === '::1';
}

/** This machine's hostname as a browser may use it: `name`, `name.local` (Bonjour). */
export function machineNames(hostname = os.hostname()) {
  const h = String(hostname ?? '').trim().toLowerCase();
  if (!h) return [];
  const short = h.replace(/\.local$/, '');
  return [...new Set([h, short, `${short}.local`])];
}

/**
 * @param {object} opts
 * @param {string[]} [opts.names] names a browser may reach this server by: fleet host names,
 *   their web urls' hosts, this machine's hostnames
 * @param {string[]} [opts.allowedHosts] `web.allowedHosts`: more names, or `"*"` for any
 * @returns {(req: { headers: object }) => null | { status: number, error: string }}
 */
export function createRequestGuard({ names = [], allowedHosts = [] } = {}) {
  const anyHost = allowedHosts.includes('*');
  const exact = new Set([...names, ...allowedHosts].filter((n) => typeof n === 'string' && n.trim()).map((n) => n.trim().toLowerCase()));

  const hostAllowed = (name) => anyHost || net.isIP(name) !== 0 || isLoopbackName(name) || name.endsWith('.ts.net') || exact.has(name);

  return function check(req) {
    const host = req.headers?.host;
    const name = hostnameOf(host);
    if (!name) return { status: 400, error: 'missing or bad Host header' };
    if (!hostAllowed(name)) return { status: 403, error: `host not allowed: ${name} (add it to web.allowedHosts)` };

    const origin = req.headers?.origin;
    if (origin == null) return null;
    let o;
    try {
      o = new URL(origin);
    } catch {
      return { status: 403, error: 'cross-origin request refused' };
    }
    if (o.host.toLowerCase() === String(host).trim().toLowerCase()) return null;
    const oName = o.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    // A loopback origin (a dev server), or a page of a fleet server itself (one behind a reverse
    // proxy that rewrites Host sends its public name as the Origin).
    if (isLoopbackName(oName) || exact.has(oName)) return null;
    return { status: 403, error: `cross-origin request refused: ${o.origin}` };
  };
}

/**
 * The addresses to listen on for `web.bind`. A wildcard or loopback bind is one address. A
 * specific address (a tailnet IP) also gets loopback, so this machine's own clients
 * (`scripts/deploy.sh`, the desktop app, internal calls) keep reaching it.
 */
export function listenAddresses(bind) {
  const b = typeof bind === 'string' ? bind.trim() : '';
  if (!b || b === '0.0.0.0' || b === '::') return [b || '0.0.0.0'];
  if (isLoopbackName(b.toLowerCase())) return [b];
  return [b, net.isIPv6(b) ? '::1' : '127.0.0.1'];
}

/** The address this server calls itself on: loopback unless it listens on one address only. */
export function loopbackFor(bind) {
  const addrs = listenAddresses(bind);
  if (addrs.length > 1) return addrs[1];
  const a = addrs[0];
  return a === '0.0.0.0' || a === '::' ? '127.0.0.1' : a;
}
