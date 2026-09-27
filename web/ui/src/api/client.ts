// Typed client for the fleet web HTTP API. Same origin (the server serves this UI);
// in dev, Vite proxies /api to a running server (see vite.config.ts).
import type {
  AutoNameRun,
  Brief,
  BriefRegenerateResponse,
  FileOpenResponse,
  FileStatResponse,
  FleetResponse,
  GroupsResponse,
  Health,
  KillResponse,
  MessagesResponse,
  NoteFile,
  NotesSearch,
  NotesTree,
  OkResponse,
  PeekResponse,
  RenameResponse,
  SessionKey,
  Settings,
  SpawnRequest,
  SpawnResponse,
  UploadResponse,
} from './types'

/** A failed request. `status` is the HTTP status, or 0 when the network is unreachable. */
export class ApiError extends Error {
  status: number
  /** The parsed JSON error body (e.g. `{ error, retryAfterMs }`), when there was one. */
  data: unknown
  constructor(message: string, status: number, data: unknown = null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.data = data
  }
}

export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException ? err.name === 'AbortError' : (err as { name?: string })?.name === 'AbortError'
}

export interface RequestOptions {
  signal?: AbortSignal
  method?: 'GET' | 'POST' | 'PUT'
  body?: unknown
  /** A raw body (a File for uploads), sent as-is with its own type. */
  file?: Blob
}

export async function request<T>(path: string, { signal, method = 'GET', body, file }: RequestOptions = {}): Promise<T> {
  const init: RequestInit = { method, signal, headers: {} }
  if (file !== undefined) {
    init.headers = { 'content-type': file.type || 'application/octet-stream' }
    init.body = file
  } else if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  let res: Response
  try {
    res = await fetch(path, init)
  } catch (err) {
    if (isAbortError(err)) throw err
    throw new ApiError('network unreachable', 0)
  }
  let data: unknown = null
  try {
    data = await res.json()
  } catch {
    data = null
  }
  if (!res.ok) {
    const msg = (data as { error?: string } | null)?.error
    throw new ApiError(msg || `HTTP ${res.status}`, res.status, data)
  }
  return data as T
}

const enc = encodeURIComponent
const hostPath = (host: string) => `/api/hosts/${enc(host)}`
const sessionPath = (host: string, id: string, suffix: string) => `${hostPath(host)}/sessions/${enc(id)}/${suffix}`

type Opts = { signal?: AbortSignal }

export const api = {
  health: (o: Opts = {}) => request<Health>('/api/health', o),
  settings: (o: Opts = {}) => request<Settings>('/api/settings', o),
  fleet: (o: Opts = {}) => request<FleetResponse>('/api/fleet', o),

  peek: (host: string, id: string, lines = 200, o: Opts = {}) =>
    request<PeekResponse>(`${sessionPath(host, id, 'peek')}?lines=${lines}`, o),
  messages: (host: string, id: string, limit = 60, o: Opts = {}) =>
    request<MessagesResponse>(`${sessionPath(host, id, 'messages')}?limit=${limit}`, o),

  send: (host: string, id: string, text: string, o: Opts = {}) =>
    request<OkResponse>(sessionPath(host, id, 'send'), { ...o, method: 'POST', body: { text } }),
  keys: (host: string, id: string, key: SessionKey, o: Opts = {}) =>
    request<OkResponse>(sessionPath(host, id, 'keys'), { ...o, method: 'POST', body: { key } }),
  rename: (host: string, id: string, title: string, o: Opts = {}) =>
    request<RenameResponse>(sessionPath(host, id, 'rename'), { ...o, method: 'POST', body: { title } }),
  kill: (host: string, id: string, o: Opts = {}) =>
    request<KillResponse>(sessionPath(host, id, 'kill'), { ...o, method: 'POST', body: {} }),

  spawn: (host: string, body: SpawnRequest, o: Opts = {}) =>
    request<SpawnResponse>(`${hostPath(host)}/spawn`, { ...o, method: 'POST', body }),
  autoname: (host: string, o: Opts = {}) =>
    request<AutoNameRun>(`${hostPath(host)}/autoname`, { ...o, method: 'POST', body: {} }),

  /** Store a file on `host`; the response carries its absolute path there. */
  upload: (host: string, file: Blob, name: string, o: Opts = {}) =>
    request<UploadResponse>(`${hostPath(host)}/uploads?name=${enc(name)}`, { ...o, method: 'POST', file }),

  /** Which of these paths (as written in chat, relative to the session cwd) exist on the session's host. */
  fileStat: (host: string, id: string, paths: string[], o: Opts = {}) =>
    request<FileStatResponse>(sessionPath(host, id, 'files/stat'), { ...o, method: 'POST', body: { paths } }),
  /** Open the file with its default app — on `host`, not in this browser. */
  fileOpen: (host: string, id: string, path: string, o: Opts = {}) =>
    request<FileOpenResponse>(sessionPath(host, id, 'files/open'), { ...o, method: 'POST', body: { path } }),
  /** The file's text (preview); 413 when it is too large. */
  fileText: async (host: string, id: string, path: string, o: Opts = {}) => {
    let res: Response
    try {
      res = await fetch(fileRawUrl(host, id, path), { signal: o.signal })
    } catch (err) {
      if (isAbortError(err)) throw err
      throw new ApiError('network unreachable', 0)
    }
    if (!res.ok) {
      const msg = await res.json().then((d: { error?: string }) => d?.error, () => null)
      throw new ApiError(msg || `HTTP ${res.status}`, res.status)
    }
    return res.text()
  },

  /** The session's brief (never calls the model); `exists: false` = none yet. */
  brief: (host: string, id: string, o: Opts = {}) => request<Brief>(sessionPath(host, id, 'brief'), o),
  /** A human edit: the body markdown (the server keeps its frontmatter keys). */
  saveBrief: (host: string, id: string, markdown: string, o: Opts = {}) =>
    request<Brief>(sessionPath(host, id, 'brief'), { ...o, method: 'PUT', body: { markdown } }),
  /** 202 at once; poll `brief` until `generating` is false. 429 `{ retryAfterMs }` at the hourly cap. */
  regenerateBrief: (host: string, id: string, o: Opts = {}) =>
    request<BriefRegenerateResponse>(sessionPath(host, id, 'brief/regenerate'), { ...o, method: 'POST', body: {} }),

  notesTree: (host: string, o: Opts = {}) => request<NotesTree>(`${hostPath(host)}/notes/tree`, o),
  notesSearch: (host: string, q: string, limit = 50, o: Opts = {}) =>
    request<NotesSearch>(`${hostPath(host)}/notes/search?q=${enc(q)}&limit=${limit}`, o),
  noteFile: (host: string, path: string, o: Opts = {}) => request<NoteFile>(`${hostPath(host)}/notes/file?path=${enc(path)}`, o),

  groups: (o: Opts = {}) => request<GroupsResponse>('/api/groups', o),
  runGroups: (o: Opts = {}) => request<GroupsResponse>('/api/groups/run', { ...o, method: 'POST', body: {} }),
}

/** GET …/files/raw — for <img>, <iframe>, fetch and download links. */
export function fileRawUrl(host: string, id: string, path: string, { download = false } = {}): string {
  return `${sessionPath(host, id, 'files/raw')}?path=${enc(path)}${download ? '&download=1' : ''}`
}

/** GET …/notes/raw — an image inside the notes root. */
export function noteRawUrl(host: string, path: string): string {
  return `${hostPath(host)}/notes/raw?path=${enc(path)}`
}

/** A short, human message for a failed session request (peek/messages/send…). */
export function sessionErrorMessage(err: unknown): string {
  if (!(err instanceof ApiError)) return (err as Error)?.message || 'request failed'
  switch (err.status) {
    case 409:
      return "This session's backend can't be controlled from here"
    case 404:
      return 'Session gone'
    case 502:
    case 504:
      return 'host unreachable'
    case 503:
      return 'session discovery failed on that host'
    case 0:
      return 'network unreachable'
    default:
      return err.message || 'request failed'
  }
}

/** 404 "unknown session: …" — the session no longer exists (vs. 404 "transcript not found"). */
export function isSessionGone(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404 && /^unknown session/i.test(err.message)
}
