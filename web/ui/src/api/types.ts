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
  /** "Open in editor" link for the cwd (like Brief.editorUrl, without the git-root lookup). Older servers omit it. */
  editorUrl?: string | null
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

/** One Settings → Start directories entry: a label and a directory per host (config `spawnDirs`). */
export interface SpawnDirEntry {
  label: string
  /** host name → directory on that host (absolute or `~/…`); a missing host = not offered there. */
  paths: Record<string, string>
}

/** Whether the answering host's own path of one entry is a directory there (null: no path for it). */
export interface SpawnDirCheck {
  path: string
  /** Absolute, `~` expanded. */
  resolved: string
  exists: boolean
  isDir: boolean
}

/** GET/PUT /api/hosts/:host/spawn-dirs. */
export interface SpawnDirsResponse {
  host: string
  /** This host + every host in its config. */
  hosts: string[]
  spawnDirs: SpawnDirEntry[]
  /** Index-aligned with `spawnDirs`. */
  checks: (SpawnDirCheck | null)[]
  /** What the host offers now (`Host.spawnDirs`). */
  offered: SpawnDir[]
  limits: { maxEntries: number; maxLabel: number; maxPath: number }
  /** PUT only: false for a dry run. */
  saved?: boolean
}

/** A PUT spawn-dirs 400: `errors[].index` into the list sent; `host` = that host's path cell. */
export interface SpawnDirsError {
  error: string
  errors: { index: number; field: 'label' | 'paths' | 'list'; host?: string; error: string }[]
  checks: (SpawnDirCheck | null)[]
}

export interface Host {
  name: string
  ok: boolean
  error?: string
  fetchedAt?: number
  spawnDirs?: SpawnDir[]
  /** Set when that host's server has a notes explorer (`web.notes.root`). */
  notes?: { name: string | null }
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

/** One New session model choice (`web.models`); id '' = no `--model`, Claude's default. */
export interface ModelOption {
  id: string
  label: string
}

/** GET /api/settings */
export interface Settings {
  apiVersion: number
  self: string
  hosts: string[]
  quickReplies: QuickReply[]
  /** `web.uploads.maxMB` of this server (older servers: absent). */
  uploads?: { maxMB: number | null }
  /** The New session model picker (older servers: absent → lib/models.ts defaults). */
  models?: ModelOption[]
  /** This server's notes explorer (older servers: absent). */
  notes?: { enabled: boolean; name?: string | null }
}

/** POST /api/hosts/:host/uploads — the stored copy on that host. */
export interface UploadResponse {
  host: string
  /** Absolute path on `host`. */
  path: string
  name: string
  size: number
}

export type FileKind = 'markdown' | 'text' | 'image' | 'pdf' | 'other'

/** One entry of POST …/sessions/:id/files/stat — a path mentioned in chat, resolved on the session's host. */
export interface FileStat {
  /** What was asked (`docs/a.md:12`). */
  input: string
  /** Absolute path on the host (resolved against the session cwd). */
  path: string
  /** Relative to the cwd when inside it, else `~/…`, else absolute. */
  rel?: string
  line?: number
  col?: number
  exists: boolean
  /** Outside $HOME / the cwd, or a secret store: never served. */
  forbidden?: boolean
  isFile?: boolean
  isDir?: boolean
  size?: number
  mtime?: number
  kind?: FileKind
}

export interface FileStatResponse {
  host: string
  id: string
  cwd: string | null
  home: string
  files: FileStat[]
}

export interface FileOpenResponse {
  ok: true
  host: string
  path: string
  /** A runnable file was revealed in its folder instead of opened. */
  revealed: boolean
  command: string
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
  /** kind 'command': the slash command / skill (`/p-dev:review`), or `!` for a shell command. */
  name?: string
  /** kind 'command': what was typed after the command, when anything was. */
  args?: string
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
  /** Still accepted by the server; the UI leaves naming to the auto-namer. */
  name?: string
  dir?: string
  prompt?: string
  /** A `models` id; '' / absent = Claude's default. */
  model?: string
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

/** A `## Resources` bullet of a session brief. `url` or `path` is set; `kind: null` = a hand-written line. */
export type BriefResourceKind = 'PR' | 'Issue' | 'Artifact' | 'Spec' | 'File' | 'Git' | 'Branch' | 'Worktree' | 'Link'

export interface BriefResource {
  kind: BriefResourceKind | string | null
  label: string | null
  url: string | null
  /**
   * Relative to the session cwd when inside it, else `~/…`, else absolute (a branch name for the
   * legacy `Branch`; the repo / worktree root for `Git`).
   */
  path: string | null
  /** The bullet as written. */
  text: string
  /** `Git` only (null otherwise; older servers omit it): the branch, null when detached. */
  branch?: string | null
  /** `Git` only: true = a linked worktree, false = the main checkout (null: unknown / not Git). */
  linked?: boolean | null
}

/** A `## Todos` checkbox line. */
export interface BriefTodo {
  done: boolean
  text: string
}

/** @deprecated the section is `## Todos` now — use BriefTodo. */
export type BriefPlanItem = BriefTodo

/** GET/PUT /api/hosts/:host/sessions/:id/brief (`exists: false` = the empty skeleton, no file yet). */
export interface Brief {
  host: string
  id: string
  exists: boolean
  /** The whole file, frontmatter included. */
  markdown: string
  parsed: {
    summary: string
    resources: BriefResource[]
    /** Older servers omit it — fall back to `plan`. */
    todos?: BriefTodo[]
    /** @deprecated alias of `todos` (same array), kept for one release. */
    plan: BriefTodo[]
  }
  /** ISO 8601 (frontmatter), null when never written. */
  updated: string | null
  editedAt: string | null
  generatedAt: string | null
  generatedThrough: number
  generating: boolean
  /** Background generation is on for that host (`web.briefs.enabled`). */
  enabled: boolean
  /** The first prompt for a new session that continues this one. */
  continuePrompt: string
  /** The session's directory on its host, absolute (no `~`); null when unknown. Older servers omit it. */
  absCwd?: string | null
  /** The git checkout root (repo or linked worktree) containing absCwd, absolute; null outside git. */
  gitRoot?: string | null
  /** `web.editor` of the server that answered: which editor `editorUrl` opens; null = hide the button. */
  editor?: 'vscode' | 'cursor' | null
  /**
   * `vscode://file/<path>` for a session on the answering server's host, or
   * `vscode://vscode-remote/ssh-remote+<alias><path>` for another host (`cursor://…` alike);
   * gitRoot preferred over absCwd. null: no editor, no path, or no ssh alias for that host.
   */
  editorUrl?: string | null
}

/** POST …/brief/regenerate (202). */
export interface BriefRegenerateResponse {
  host: string
  id: string
  started: boolean
  queued: boolean
  generating: true
}

// --- Notes explorer (GET /api/hosts/:host/notes/*) ------------------------------------------

export type NoteKind = 'markdown' | 'text' | 'image'

export interface NoteEntry {
  /** Root-relative, `/`-separated. */
  path: string
  kind: NoteKind
  size: number
  mtime: number
  /** Markdown: frontmatter `title`, else the first `# heading`, else the file name. */
  title?: string
  /** Had age-encrypted blocks (withheld by the server). */
  encrypted?: boolean
}

export interface NotesTree {
  host: string
  name: string
  /** Display path (`~/…`). */
  root: string
  rootAbs: string
  searchEngine: 'builtin' | 'command'
  files: NoteEntry[]
  truncated: boolean
  scannedAt: number
  editorUrl: string | null
}

export interface NoteMatch {
  /** 1-based; null when the search command gave no line numbers. */
  line: number | null
  text: string
  /** [start, end) of each match in `text`. */
  ranges: [number, number][]
}

export interface NoteHit {
  path: string
  kind: NoteKind
  title: string
  mtime: number
  score: number
  matches: NoteMatch[]
  more: number
}

export interface NotesSearch {
  host: string
  q: string
  engine: 'builtin' | 'command'
  /** The search command failed and the built-in search answered instead. */
  fallback?: string
  results: NoteHit[]
  total: number
  ms: number
}

export interface NoteFile {
  host: string
  path: string
  abs: string
  kind: NoteKind
  size: number
  mtime: number
  title: string
  encrypted: boolean
  /** Frontmatter, in file order. */
  meta: [string, string | string[]][]
  body: string
  /** The line `body` starts on. */
  bodyLine: number
  text: string
  editorUrl: string | null
}
