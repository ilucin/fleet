// Typed client for the fleet web HTTP API. Same origin (the server serves this UI);
// in dev, Vite proxies /api to a running server (see vite.config.ts).
import type {
  AutoNameRun,
  Brief,
  BriefRegenerateResponse,
  DormantResponse,
  FileOpenResponse,
  ForgetResponse,
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
  RestoreResponse,
  SessionKey,
  Settings,
  SpawnDirEntry,
  SpawnDirsResponse,
  SpawnRequest,
  SpawnResponse,
  StackSpawnRequest,
  StackSpawnResponse,
  StacksResponse,
  StackView,
  UploadResponse,
  UsageResponse,
} from './types'
import type { GroupEdit } from '@/lib/groups'

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
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  body?: unknown
  /** A raw body (a File for uploads), sent as-is with its own type. */
  file?: Blob
  /** Let the request outlive the page (unload, app close) — small bodies only (64 KB). */
  keepalive?: boolean
}

export async function request<T>(path: string, { signal, method = 'GET', body, file, keepalive }: RequestOptions = {}): Promise<T> {
  const init: RequestInit = { method, signal, headers: {} }
  if (keepalive) init.keepalive = true
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

  send: (host: string, id: string, text: string, o: Opts & { keepalive?: boolean } = {}) =>
    request<OkResponse>(sessionPath(host, id, 'send'), { ...o, method: 'POST', body: { text } }),
  keys: (host: string, id: string, key: SessionKey, o: Opts = {}) =>
    request<OkResponse>(sessionPath(host, id, 'keys'), { ...o, method: 'POST', body: { key } }),
  rename: (host: string, id: string, title: string, o: Opts = {}) =>
    request<RenameResponse>(sessionPath(host, id, 'rename'), { ...o, method: 'POST', body: { title } }),
  kill: (host: string, id: string, o: Opts = {}) =>
    request<KillResponse>(sessionPath(host, id, 'kill'), { ...o, method: 'POST', body: {} }),

  spawn: (host: string, body: SpawnRequest, o: Opts = {}) =>
    request<SpawnResponse>(`${hostPath(host)}/spawn`, { ...o, method: 'POST', body }),
  /** The host's Start directories (config `spawnDirs`) and whether its own paths exist. */
  spawnDirs: (host: string, o: Opts = {}) => request<SpawnDirsResponse>(`${hostPath(host)}/spawn-dirs`, o),
  /** Replace the host's list (400 `SpawnDirsError` when invalid); `dryRun` validates only. */
  saveSpawnDirs: (host: string, spawnDirs: SpawnDirEntry[], { dryRun = false, ...o }: Opts & { dryRun?: boolean } = {}) =>
    request<SpawnDirsResponse>(`${hostPath(host)}/spawn-dirs`, { ...o, method: 'PUT', body: { spawnDirs, ...(dryRun ? { dryRun } : {}) } }),
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

  /** Session stacks on `host` (404 / 501 on servers that predate stacks — see lib/stacks.ts `stacksMissing`). */
  stacks: (host: string, o: Opts = {}) => request<StacksResponse>(`${hostPath(host)}/stacks`, o),
  stack: (host: string, id: string, o: Opts = {}) => request<StackView>(`${hostPath(host)}/stacks/${enc(id)}`, o),
  /** A human edit of the whole StackBrief; 409 `{ error, updated }` when `expectUpdated` is stale. */
  saveStack: (host: string, id: string, markdown: string, expectUpdated?: string | null, o: Opts = {}) =>
    request<StackView>(`${hostPath(host)}/stacks/${enc(id)}`, {
      ...o,
      method: 'PUT',
      body: { markdown, ...(expectUpdated ? { expectUpdated } : {}) },
    }),
  /** Rename a stack (400 bad label, 404 unknown stack, 501 / router 404 on servers without stacks). */
  renameStack: (host: string, id: string, label: string, o: Opts = {}) =>
    request<StackView>(`${hostPath(host)}/stacks/${enc(id)}/rename`, { ...o, method: 'POST', body: { label } }),
  deleteStack: (host: string, id: string, o: Opts = {}) =>
    request<{ removed: string }>(`${hostPath(host)}/stacks/${enc(id)}`, { ...o, method: 'DELETE' }),
  /** A sibling of `sessionId`: its stack (created first when it has none — one model call), then a new session in its cwd. */
  spawnSibling: (host: string, sessionId: string, body: StackSpawnRequest, o: Opts = {}) =>
    request<StackSpawnResponse>(sessionPath(host, sessionId, 'stack/spawn'), { ...o, method: 'POST', body }),
  /** A new session in an existing stack (in the stack's directory). */
  spawnInStack: (host: string, stackId: string, body: StackSpawnRequest, o: Opts = {}) =>
    request<StackSpawnResponse>(`${hostPath(host)}/stacks/${enc(stackId)}/spawn`, { ...o, method: 'POST', body }),
  syncStacks: (host: string, o: Opts = {}) =>
    request<{ host?: string; changed: string[]; stacks: StackView[] }>(`${hostPath(host)}/stacks/sync`, { ...o, method: 'POST', body: {} }),
  /** The Claude subscription limits of the account logged in on that host (`refresh` skips its 60s cache). */
  usage: (host: string, { refresh = false, ...o }: Opts & { refresh?: boolean } = {}) =>
    request<UsageResponse>(`${hostPath(host)}/usage${refresh ? '?refresh=1' : ''}`, o),

  /** Sessions a reboot left dormant on `host` (404 / 501 on servers or CLIs that predate session recovery). */
  dormant: (host: string, o: Opts = {}) => request<DormantResponse>(`${hostPath(host)}/dormant`, o),
  /** Bring one back (`target`: tmux name or session id) or every one (`all`). Starts agents. */
  /** `closed: true`: a recently closed session (never with `all`). */
  restoreDormant: (host: string, body: { target: string; closed?: true } | { all: true }, o: Opts = {}) =>
    request<RestoreResponse>(`${hostPath(host)}/dormant/restore`, { ...o, method: 'POST', body }),
  forgetDormant: (host: string, body: { target: string; closed?: true } | { all: true; closed?: true }, o: Opts = {}) =>
    request<ForgetResponse>(`${hostPath(host)}/dormant/forget`, { ...o, method: 'POST', body }),

  groups: (o: Opts = {}) => request<GroupsResponse>('/api/groups', o),
  runGroups: (o: Opts = {}) => request<GroupsResponse>('/api/groups/run', { ...o, method: 'POST', body: {} }),
  /** Rename a group / move a session (409: the id or label was refused). */
  editGroups: (edit: GroupEdit, o: Opts = {}) => request<GroupsResponse>('/api/groups/edit', { ...o, method: 'POST', body: edit }),
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

/**
 * A failed send, for the chat's inline error: a 409 carries the server's reason (waiting on a
 * prompt, no usable handle) when it gave one; anything else is sessionErrorMessage().
 */
export function sendErrorMessage(err: unknown): string {
  if (err instanceof ApiError && err.status === 409 && err.message && !/^HTTP \d+$/.test(err.message)) return err.message
  return sessionErrorMessage(err)
}

/** 404 "unknown session: …" — the session no longer exists (vs. 404 "transcript not found"). */
export function isSessionGone(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404 && /^unknown session/i.test(err.message)
}
