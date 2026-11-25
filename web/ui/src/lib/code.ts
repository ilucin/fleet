/** `#/code/<host>/<id>[/root/<root>]`: VS Code on one of the session's checkouts, its chat beside it. */
export const codeHref = (host: string, id: string, root?: string | null) =>
  `/code/${encodeURIComponent(host)}/${encodeURIComponent(id)}${root ? `/root/${encodeURIComponent(root)}` : ''}`

export function parseCodeLocation(location: string): { host: string; id: string; root?: string } | null {
  const m = /^\/code\/([^/]+)\/([^/]+)(?:\/root\/([^/]+))?\/?$/.exec(location)
  if (!m) return null
  try {
    return { host: decodeURIComponent(m[1]), id: decodeURIComponent(m[2]), ...(m[3] ? { root: decodeURIComponent(m[3]) } : {}) }
  } catch {
    return null
  }
}
