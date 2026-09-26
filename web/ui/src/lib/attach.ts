// Attaching files to a prompt: the file is uploaded to the host the session runs on
// (POST /api/hosts/:host/uploads) and the stored copy's absolute path is typed into the
// textarea. Claude Code reads a plain absolute path (images included) with its Read tool,
// so no `@` mention syntax — that one resolves relative to the session's cwd.

/** A path as prompt text: plain, or double-quoted when it has whitespace or quotes. */
export function formatPath(p: string): string {
  if (!/[\s"'`]/.test(p)) return p
  return `"${p.replace(/(["\\])/g, '\\$1')}"`
}

/**
 * Insert `paths` into `value` at the selection [start, end) (the selection is replaced),
 * space-separated and padded so they never glue onto neighbouring words; a trailing space
 * is always added so typing can continue. → the new value and the caret after the insert.
 */
export function insertPaths(value: string, start: number, end: number, paths: string[]): { value: string; cursor: number } {
  if (!paths.length) return { value, cursor: end }
  const s = Math.max(0, Math.min(start, value.length))
  const e = Math.max(s, Math.min(end, value.length))
  const before = value.slice(0, s)
  const after = value.slice(e)
  const lead = before && !/\s$/.test(before) ? ' ' : ''
  const trail = after && /^\s/.test(after) ? '' : ' '
  const text = lead + paths.map(formatPath).join(' ') + trail
  return { value: before + text + after, cursor: before.length + text.length }
}

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/heic': 'heic',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'application/json': 'json',
}

/**
 * The name to upload a file under. Clipboard images come as `image.png` (or nameless):
 * give them a `pasted-<yyyymmdd-hhmmss>.<ext>` name so several pastes are told apart.
 */
export function uploadName(file: { name?: string; type?: string }, now: Date = new Date()): string {
  const name = (file.name ?? '').trim()
  if (name && !/^image\.(png|jpe?g|gif|webp)$/i.test(name)) return name
  const p = (n: number) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  const ext = name.match(/\.([A-Za-z0-9]+)$/)?.[1]?.toLowerCase() ?? MIME_EXT[file.type ?? ''] ?? 'bin'
  return `pasted-${stamp}.${ext}`
}

/** Is `size` over the host's limit (`web.uploads.maxMB`; null = unknown → let the server decide)? */
export function overLimit(size: number, maxMB: number | null | undefined): boolean {
  return typeof maxMB === 'number' && maxMB > 0 && size > maxMB * 1024 * 1024
}

/** `1.2 MB`, `340 KB`, `12 B`. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  const mb = n / 1024 / 1024
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`
}

/** Does a drag carry files (not text / links dragged from the page)? */
export function dragHasFiles(dt: { types?: ArrayLike<string> | null } | null | undefined): boolean {
  return !!dt?.types && Array.from(dt.types).includes('Files')
}
