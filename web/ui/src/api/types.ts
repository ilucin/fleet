// Types for the fleet web HTTP API (see web/ARCHITECTURE.md → "HTTP API").
// The API is a stable contract: fields are only ever added, so unknown extra
// fields are fine and everything a UI does not strictly need is optional.

export type SessionStatus = 'busy' | 'idle' | 'waiting' | 'unknown'
export type Backend = 'iterm' | 'tmux' | 'unknown'

/** One Claude Code session: a `fleet list --json` row plus the host it runs on. */
export interface Session {
  host: string
  session_id: string
  pid?: number
  name?: string | null
  cwd?: string | null
  /** Unknown strings are possible from newer CLIs — treat as `unknown`. */
  status?: SessionStatus | string | null
  /** Last activity, epoch ms. */
  updated_at?: number | null
  tty?: string | null
  backend?: Backend | string | null
  /** iTerm session id or tmux pane id (`%87`). */
  handle?: string | null
  tab?: string | null
  tmux_session?: string | null
  name_source?: string | null
  waiting_for?: string | null
  /** First prompt, trimmed to ~300 chars for transport. */
  title?: string | null
  gen_title?: string | null
}

export interface SpawnDir {
  label: string
  path: string
}

export interface Host {
  name: string
  ok: boolean
  error?: string
  fetchedAt?: number
  spawnDirs?: SpawnDir[]
  sessions: Session[]
}

/** GET /api/fleet — self first, then peers. */
export interface FleetResponse {
  self: string
  hosts: Host[]
  /** When the merged snapshot was built (epoch ms); absent on `?local=1`. */
  snapshotAt?: number
}

export interface QuickReply {
  label: string
  text: string
}

/** GET /api/settings */
export interface Settings {
  apiVersion: number
  self: string
  hosts: string[]
  quickReplies: QuickReply[]
}

export interface AutoNameRun {
  host?: string
  ok?: boolean
  at?: number
  ms?: number
  reason?: string
  dryRun?: boolean
  renamed?: { from: string; to: string }[]
  tmux?: string[]
  held?: string[]
  errors?: string[]
  error?: string
}

/** GET /api/health */
export interface Health {
  name: string
  version: string
  apiVersion: number
  self: string
  uptime: number
  now: number
  autoName: { enabled: boolean; intervalMinutes: number; lastRun: AutoNameRun | null }
}

/** GET /api/hosts/:host/sessions/:id/peek */
export interface PeekResponse {
  host: string
  id: string
  backend: Backend | string
  lines: number
  text: string
  capturedAt: number
}

export type MessageRole = 'user' | 'assistant' | 'system'
export type MessageKind = 'user' | 'assistant' | 'command' | 'system'

export interface Message {
  role: MessageRole
  kind: MessageKind
  text: string
  ts?: number | null
  /** Assistant text that ends a turn; `false` = narration between tool calls. */
  final?: boolean
}

/** GET /api/hosts/:host/sessions/:id/messages */
export interface MessagesResponse {
  host: string
  id: string
  status: SessionStatus | string
  backend: Backend | string
  name?: string | null
  limit: number
  messages: Message[]
  total: number
  truncated: boolean
  updatedAt?: number | null
  capturedAt: number
}

export type SessionKey = 'Enter' | 'Escape' | 'Up' | 'Down'

export interface SpawnRequest {
  name?: string
  dir?: string
  prompt?: string
}

export interface SpawnResponse {
  ok: boolean
  host: string
  name: string
  dir: string
  tmuxSession: string
  command: string
  trusted: boolean
}

export interface KillResponse {
  ok: true
  host: string
  id: string
  name?: string | null
  process: 'terminated' | 'killed' | 'gone' | 'skipped' | string
  terminal: string
}

export interface OkResponse {
  ok: true
}
