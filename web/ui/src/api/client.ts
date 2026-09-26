// Typed client for the fleet web HTTP API. Same origin (the server serves this UI);
// in dev, Vite proxies /api to a running server (see vite.config.ts).
import type {
  AutoNameRun,
  FleetResponse,
  GroupsResponse,
  Health,
  KillResponse,
  MessagesResponse,
  OkResponse,
  PeekResponse,
  SessionKey,
  Settings,
  SpawnRequest,
  SpawnResponse,
} from './types'

/** A failed request. `status` is the HTTP status, or 0 when the network is unreachable. */
export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException ? err.name === 'AbortError' : (err as { name?: string })?.name === 'AbortError'
}

export interface RequestOptions {
  signal?: AbortSignal
  method?: 'GET' | 'POST'
  body?: unknown
}

export async function request<T>(path: string, { signal, method = 'GET', body }: RequestOptions = {}): Promise<T> {
  const init: RequestInit = { method, signal, headers: {} }
  if (body !== undefined) {
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
    throw new ApiError(msg || `HTTP ${res.status}`, res.status)
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
  kill: (host: string, id: string, o: Opts = {}) =>
    request<KillResponse>(sessionPath(host, id, 'kill'), { ...o, method: 'POST', body: {} }),

  spawn: (host: string, body: SpawnRequest, o: Opts = {}) =>
    request<SpawnResponse>(`${hostPath(host)}/spawn`, { ...o, method: 'POST', body }),
  autoname: (host: string, o: Opts = {}) =>
    request<AutoNameRun>(`${hostPath(host)}/autoname`, { ...o, method: 'POST', body: {} }),

  groups: (o: Opts = {}) => request<GroupsResponse>('/api/groups', o),
  runGroups: (o: Opts = {}) => request<GroupsResponse>('/api/groups/run', { ...o, method: 'POST', body: {} }),
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
