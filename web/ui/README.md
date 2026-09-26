# fleet web UI (React)

The mobile-first PWA (with a keyboard-first desktop layout from 1024px up) for the fleet web server, built with Vite + React 19 + TypeScript +
Tailwind CSS v4 + [shadcn/ui](https://ui.shadcn.com) (radix, "nova" style) + lucide-react.
It talks only to the server's HTTP API ([../ARCHITECTURE.md](../ARCHITECTURE.md) → "HTTP API").

The server serves `dist/` by default once it is built (else the classic `../public/` UI;
force that one with `web.ui: "classic"` or `FLEET_WEB_UI=classic`). `dist/` is gitignored and is
what `fleet install --host` copies — sources and `node_modules` never leave this machine.

## Build

```sh
fleet web build                                  # npm ci (if needed) + npm run build
npm --prefix web/ui ci && npm --prefix web/ui run build   # the same, by hand
```

## Develop

```sh
fleet web serve --port 7796 --bind 127.0.0.1     # an API to talk to (any running server works)
FLEET_WEB_URL=http://127.0.0.1:7796 npm run dev  # Vite on :5173, /api proxied (default target :7777)
```

Checks (all must be clean): `npm run typecheck`, `npm run lint` (oxlint), `npm test` (vitest),
`npm run build`.

## Structure

```
src/
  api/types.ts        API types (Session, Host, FleetResponse, Message, …) — mirror ARCHITECTURE.md
  api/client.ts       typed fetch client: api.fleet(), api.messages(), api.send(), … + ApiError, sessionErrorMessage
  api/spawnWatch.ts   after a spawn: poll the fleet until the new session registers
  lib/format.ts       pure display helpers: relTime, clockTime, shortCwd, sessionSubtitle (first prompt), hostColorSlot
  lib/title.ts        the one session title: sessionTitle() (display_title + optimistic override), validateTitle(),
                      titleChanged(), renameFailure() / tmuxNote() toast copy, echoesTitle()
  lib/sessions.ts     status meta/labels, filters, search, sort, listView(), findSession(), sessionHref(),
                      spawnTargets(), findSpawned(), withoutSession()
  lib/chat.ts         detail-view constants + pure helpers (sizes, limits, grouping, interim notes)
  lib/markdown.ts     safe markdown → AST (port of ../public/markdown.js), linkify()
  lib/autoname.ts     naming-pass summaries for toasts / the menu
  lib/groups.ts       Board view: boardColumns() (sessions × /api/groups → columns, Ungrouped last),
                      fallbackGroups()/repoOf() (client-side group-by-repo, worktree-aware),
                      statusSummary(), boardOrder() (j/k order), groupsStatusText(), regroupToast()
  lib/styles.ts       static Tailwind class maps: status dot/text colours, host badge colours
  lib/shortcuts.ts    desktop keyboard map: matchShortcut() (key + typing/chord context → action),
                      isTypingTarget(), stepCursor(), sessionKey(), SHORTCUT_HELP (the `?` dialog)
  lib/palette.ts      paletteFilter(): the ⌘K palette's substring matcher / ranking
  lib/layout.ts       sidebar width bounds + clampSidebarWidth()
  lib/storage.ts      localStorage that never throws
  lib/viewport.ts     --app-h / --app-top from visualViewport (utilities h-app / min-h-app / fixed-app)
  lib/utils.ts        cn() (shadcn)
  hooks/usePoller.ts  setTimeout-chained poller: no overlap, pauses while hidden, abort on unmount,
                      refresh() (runs even while hidden)
  hooks/useFollowScroll.ts  follow-the-tail scrolling for chat / term
  hooks/useFleet.ts   fleet context + localStorage snapshot (`fleet.snapshot`, shared with the classic UI)
  hooks/useSessionList.ts  list state shared by the mobile list and the desktop sidebar (search, filters, counts)
  hooks/useGroups.ts  useViewMode() (`fleet.view`: list | board), useGroups(enabled): polls /api/groups
                      every 30s (4s while a pass runs) only while the Board is shown; run() = Regroup now
  hooks/useMediaQuery.ts   useMediaQuery(), useIsDesktop() (≥ 1024px), WIDE_QUERY (≥ 1440px)
  hooks/useTitles.ts  inline-rename store: startEditing/openTitleEditor/stopEditing, useEditing(scope, key),
                      useSessionTitle(s) (optimistic title + saving), useRename() (POST rename, rollback + toast)
  hooks/useLongPress.ts  touch long-press on a row link (swallows the click that follows)
  hooks/useSettings.ts, useTheme.ts, useNow.ts, usePersistentState.ts
  providers/          FleetProvider (polls /api/fleet every 5s), SettingsProvider (/api/settings once), ThemeProvider
  components/ui/      shadcn components — generated, edit sparingly; add with `npx shadcn@latest add <name>`
  components/         app components: StatusDot, HostBadge/HostDot, SessionRow, EditableTitle, SessionListSkeleton, ScreenHeader,
                      Markdown/Linkified, NewSessionDrawer, ViewToggle (List | Board)
  components/board/   Board (desktop Kanban + header), BoardCard, GroupedList (mobile collapsible sections),
                      GroupsStatus (last run + Regroup), StatusSummaryDots
  components/session/ detail screen parts: ChatView, TermView, Composer, SessionMenu (drawer) /
                      SessionMenuBody (also the desktop details panel), LatestButton
  components/desktop/ Sidebar (+ SidebarRail when collapsed), CommandPalette (⌘K), ShortcutsDialog (?)
  screens/            ListScreen (`#/`), SessionScreen (`#/s/:host/:id`; `layout="pane"` on desktop),
                      DesktopShell (≥ lg master–detail + the keyboard handler)
  App.tsx             providers + wouter hash router; picks DesktopShell or the mobile screens
```

## Conventions

- **Routing**: wouter with hash location, same URLs as the classic UI (`#/`, `#/s/<host>/<id>`),
  so no server SPA fallback is needed and old bookmarks/PWA installs keep working.
- **Data**: one `FleetProvider` polls `/api/fleet` for the whole app; screens read it with
  `useFleet()` (`fleet`, `fleetAt`, `error`, `refreshing`, `refresh()`, `applyFleet()`).
  Per-screen loops (messages, peek) use `usePoller(fn, ms)` — `fn` gets an `AbortSignal`; pass it to
  the `api.*` call. Never `setInterval` + fetch.
- **Colours**: tokens in `src/index.css` — shadcn's (`background`, `card`, `muted-foreground`, …)
  plus `dimmer`, `status-{waiting,busy,idle,unknown,error}` and `host-{0..3}`. Use them as Tailwind
  classes (`text-status-busy`, `bg-host-2/10`); keep class names literal (maps in `lib/styles.ts`).
  Dark is the default; light only when the OS prefers it or `fleet.theme` = `light`.
- **Mobile**: ≥ 44px tap targets, inputs ≥ 16px (no iOS zoom), `pt-safe`/`pb-safe`/`px-safe` on an
  outer wrapper (they set padding, so put spacing on an inner element), `min-h-app`/`h-app` for
  full-height screens.
- **Desktop vs mobile**: `App` renders `DesktopShell` at ≥ 1024px (`useIsDesktop()`), else the
  mobile `Switch` — two trees, not responsive classes, so the mobile layout cannot drift. Shared
  components take opt-in props (`layout="pane"`, `wide`, `desktop`, `selected`/`cursor`) whose
  defaults keep the mobile markup byte-identical; keep it that way (check a 390px iframe).
- **Storage keys** are `fleet.*`; reuse the classic UI's keys where the meaning is the same
  (`fleet.detailMode`, `fleet.termFont`, `fleet.termLines`, `fleet.chatFont`, `fleet.chatHideNotes`).
- **Text from sessions is data**: render it as text (React escapes); never `dangerouslySetInnerHTML`.
  Markdown must stay DOM-only with `http(s)` links only, like `../public/markdown.js`.
- Pure logic goes in `lib/` with a `*.test.ts` next to it.
- **Titles**: draw a session's name only through `sessionTitle()` / `useSessionTitle()` /
  `<EditableTitle>` — never `s.name` or `s.gen_title` directly. The CLI's `display_title` is the
  one title (docs/architecture.md → Session titles); the tmux name is details-panel metadata only.

## Features

- **List** (`#/`): all sessions across hosts, status + host filter chips, search, unreachable-host
  banners, `+` → New session.
- **Inline rename** (`EditableTitle`): rows, board cards and the session header show the one
  title; the tmux session name is not on rows any more (it follows the title — details panel only).
  Open the editor with the pencil on row hover (desktop), `e` / F2 (the open session's header,
  else the cursor row/card), ⌘K → Rename session…, a click on the header title, a long press on
  a row (touch), or ⋯ → Rename…. Enter / ✓ saves, Esc / ✕ / clicking away cancels. Saving is
  optimistic (spinner) → `POST …/rename`; a 409 (session waiting on a prompt) or an error rolls
  back with a toast; success toasts the new title and the tmux rename.
- **Board** (`List | Board` toggle next to the search field; `fleet.view`): sessions grouped by
  what they work on. Groups come from `GET /api/groups` (the server's periodic `fleet group`
  pass — stable ids, a 2–4 word label, an optional description); sessions no group claims yet
  go in **Ungrouped** (last), members that are no longer live are dropped, empty groups vanish.
  When grouping is off (`enabled: false`), or the endpoint is missing / failing, the UI groups
  by repo itself (cwd basename; `<repo>/.worktrees/<x>`, `<repo>/worktrees/<x>` and
  `<repo>/.claude/worktrees/<x>` count as `<repo>`) and says "fallback: by repo". Columns with
  sessions that need you come first, then busy ones, then by size and label; cards within a
  column put waiting sessions first, then most recent. The list's search / status / host
  filters apply. "Regroup now" (`POST /api/groups/run`, toast with the result) and the last run
  ("grouped 3m ago · 1 model call") sit in the header. Mobile: a grouped list with collapsible
  sections (label, description, status dots, count; collapsed ids in `fleet.groupsCollapsed`)
  of the usual `SessionRow`s. The List view is unchanged.
- **New session** (drawer): host, directory (radio from that host's `spawnDirs`), optional name
  and first prompt → `api.spawn`. 400/409 are shown inline; on success a loading toast watches
  `/api/fleet` (`api/spawnWatch.ts`, 1.5s for up to 45s) for `tmux_session === tmuxSession` and
  opens the session. Remembers `fleet.spawnHost` / `fleet.spawnDirLabel.<host>` (classic keys).
- **Session detail** (`#/s/:host/:id`), fixed full-screen layout that follows the visual viewport
  (`fixed-app`: `--app-h` + `--app-top`, so the composer stays above the iOS keyboard):
  - header: back, title (click to rename), status, host, "updated Xs ago", Chat | Term toggle, ⋯;
  - **Chat** polls `messages` every 3s (60 → 200 → 500 with "Load older", which keeps the same
    message under the thumb); bubbles for user / Claude, quiet progress notes (hideable), centred
    command / system lines, time captions per burst, "Claude is working…" / "Needs you" footer;
    markdown via `lib/markdown.ts` (AST, pure) + `components/Markdown.tsx` (React elements only,
    `http(s)` links only);
  - **Term** polls `peek` every 2s (200/600 lines), bare URLs linkified;
  - both follow the tail (`hooks/useFollowScroll.ts`): scrolling up pauses and shows "Latest";
    re-renders happen only when the payload changed;
  - errors (`sessionErrorMessage`) as a pill over the pane; host-unreachable / not-in-fleet /
    gone banners; the composer locks for a gone session or `backend: unknown`.
- **Composer**: auto-growing textarea (Enter sends on hardware keyboards, newline on touch;
  1..8000 chars), quick-reply chips from `/api/settings` + built-in keys Esc / Enter / Up / Down;
  a toast per result; two follow-up polls after steering.
- **⋯ menu** (drawer): Chat/Terminal, progress notes (`fleet.chatHideNotes`), scrollback
  (`fleet.termLines`), text size (`fleet.chatFont` / `fleet.termFont`), theme (`fleet.theme`),
  Title → Rename…, Auto-name → Run now (+ last run / schedule from `/api/health` when the host is this server),
  session details (tmux, backend, pid, id), Close session (two taps within 5s → `api.kill`, back
  to the list, row dropped optimistically).
- **PWA**: `public/` has the manifest (standalone, `/#/`) and the same icons as the classic UI;
  `index.html` sets theme-color (kept in sync with the theme), apple-mobile-web-app meta,
  `viewport-fit=cover` and `interactive-widget=resizes-content`. No service worker (the app is
  useless offline; the server revalidates every file).

## Desktop (≥ 1024px)

Master–detail on the same hash routes as mobile (`#/` = nothing open, `#/s/<host>/<id>` = that
session in the pane), so a link opens the same session on either layout.

- **Sidebar** (left): Fleet summary, "updated Xs ago", `+`, search (`/`), compact status + host
  filter chips, the session list (the open row is highlighted, the keyboard cursor has a ring),
  footer buttons for the palette and the shortcuts. Resizable by dragging its edge (280–560px,
  double-click resets, ←/→ on the focused handle; `fleet.sidebarWidth`), collapsible to a rail
  with `[` / ⌘B (`fleet.sidebar`).
- **Pane**: the session screen without the back button; header adds the cwd; chat is a wider
  (max-w-4xl) readable column, the terminal uses the full width; the composer sends on Enter (also
  ⌘/Ctrl+Enter, touch-capable laptops included), Shift+Enter is a newline. Nothing open → an empty
  state with key hints and the sessions that need you.
- **Board** (`b`, the toggle in the sidebar / board header, or ⌘K): the Kanban replaces the
  sidebar — full width, one column per group (label, status dots, count, description), cards
  with status, name, host, subtitle, status / `waiting_for`, context meter and age. Clicking a
  card (or j/k + Enter / o, walking the columns left to right) opens the session in the normal
  pane to the right of the board (`#/s/<host>/<id>`, same route as the list), with the board
  still visible and scrollable beside it; Esc closes the pane. `[` does nothing on the board.
- **Details panel** (right, `i` or the header button; `fleet.inspector`, open by default from
  1440px): name, host · cwd, context meter + model, view settings (chat/terminal, notes,
  scrollback, text size, theme), auto-name, tmux/backend/pid/id, Close session (click twice) —
  the mobile ⋯ menu's content (`SessionMenuBody`).
- **New session**: the mobile form in a dialog. Toasts sit bottom-right, above the composer.
- **Polling** is unchanged: one `/api/fleet` loop (FleetProvider, 5s) feeds the sidebar and the
  pane's status; the pane runs exactly one messages (3s) or peek (2s) loop. The tab title is
  `(<needs you>) <session> · Fleet`.

### Shortcuts

Single keys never fire while typing in a field (input, textarea, contenteditable); with a dialog
open only ⌘K works. One `keydown` listener in `DesktopShell` maps keys through `matchShortcut()`.

| Keys | Action |
| --- | --- |
| `j` / `↓`, `k` / `↑` | move the list cursor (arrows only when focus is not in the chat/terminal) |
| `g g`, `G` | cursor to first / last |
| `Enter` | open the cursor's session and focus the composer |
| `o` | open the cursor's session |
| `r` | focus the composer |
| `/` | search (in the field: ↑/↓ move, Enter opens, Esc clears then leaves) |
| `c`, `n` | new session |
| `g c`, `g t` | chat / terminal view |
| `Enter`, ⌘/Ctrl+`Enter` · `Shift+Enter` | send · newline (composer) |
| `Esc` | leave the field; otherwise close the pane (`#/`) |
| `[`, ⌘/Ctrl+`B` | toggle the sidebar |
| `b` | switch List / Board |
| `i` | toggle the details panel |
| `g r` | refresh now |
| ⌘/Ctrl+`K` | command palette: jump to any session (all hosts, ignores filters), actions, filters, theme |
| `?` | shortcuts help |
