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
  /**
   * The session's one title, computed by the CLI (core::title::display_title): the chosen
   * Claude name, else the generated title, else a heuristic. Older CLIs omit it — use
   * `sessionTitle()` (lib/title.ts), never a field directly.
   */
  display_title?: string | null
  /** Context-window usage from the transcript tail; null when unknown (older CLIs omit it). */
  context?: ContextUsage | null
}

/** `context` on a session row — see docs/architecture.md → "Context usage". */
export interface ContextUsage {
  /** Prompt tokens of the last main-thread request (input + cache read + cache creation). */
  used: number
  /** Inferred window: 200000 or 1000000. */
  window: number
  /** Whole percent, rounded; may exceed 100. */
  pct: number
  model?: string | null
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

/** POST /api/hosts/:host/sessions/:id/rename → `fleet rename --json` (409 when held). */
export interface RenameResponse {
  ok: boolean
  host: string
  id: string
  /** `renamed` (confirmed), `sent` (typed, not reflected yet), `held` (nothing sent). */
  result: 'renamed' | 'sent' | 'held' | string
  title: string
  from?: string
  /** Why nothing was sent: `waiting` (on a permission prompt / question). */
  held?: 'waiting' | string | null
  tmux?: { renamed: boolean; from?: string | null; to?: string | null; note: string } | null
  message?: string
}

export interface OkResponse {
  ok: true
}

/** One member of a group: a session on a host (`id` = session_id, or String(pid) without one). */
export interface GroupMember {
  host: string
  id: string
}

/** A smart group of sessions (`fleet group`). Ids are stable across runs. */
export interface SessionGroup {
  id: string
  label: string
  description?: string | null
  /** `llm` (model-made) or `fallback` (grouped by repo). */
  source?: 'llm' | 'fallback' | string
  members: GroupMember[]
}

export interface GroupRun {
  at: number
  ms: number
  ok: boolean
  reason?: 'scheduled' | 'manual' | 'startup' | 'changes' | string
  mode?: 'noop' | 'incremental' | 'consolidate' | 'full' | 'fallback' | string
  modelCalls?: number
  classified?: number
  error?: string
  note?: string
}

/** GET /api/groups (and POST /api/groups/run). `enabled: false` → the UI groups by repo itself. */
export interface GroupsResponse {
  enabled: boolean
  /** The host that runs the grouping pass. */
  host: string | null
  intervalMinutes: number | null
  running: boolean
  /** Epoch ms of the last applied grouping state. */
  updatedAt: number | null
  lastRun: GroupRun | null
  groups: SessionGroup[]
  error?: string
}
