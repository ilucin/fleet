# fleet web UI (React)

The mobile-first PWA for the fleet web server, built with Vite + React 19 + TypeScript +
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
  lib/format.ts       pure display helpers: relTime, clockTime, shortCwd, sessionSubtitle, hostColorSlot
  lib/sessions.ts     status meta/labels, filters, search, sort, listView(), findSession(), sessionHref(),
                      spawnTargets(), findSpawned(), withoutSession()
  lib/chat.ts         detail-view constants + pure helpers (sizes, limits, grouping, interim notes)
  lib/markdown.ts     safe markdown → AST (port of ../public/markdown.js), linkify()
  lib/autoname.ts     naming-pass summaries for toasts / the menu
  lib/styles.ts       static Tailwind class maps: status dot/text colours, host badge colours
  lib/storage.ts      localStorage that never throws
  lib/viewport.ts     --app-h / --app-top from visualViewport (utilities h-app / min-h-app / fixed-app)
  lib/utils.ts        cn() (shadcn)
  hooks/usePoller.ts  setTimeout-chained poller: no overlap, pauses while hidden, abort on unmount,
                      refresh() (runs even while hidden)
  hooks/useFollowScroll.ts  follow-the-tail scrolling for chat / term
  hooks/useFleet.ts   fleet context + localStorage snapshot (`fleet.snapshot`, shared with the classic UI)
  hooks/useSettings.ts, useTheme.ts, useNow.ts, usePersistentState.ts
  providers/          FleetProvider (polls /api/fleet every 5s), SettingsProvider (/api/settings once), ThemeProvider
  components/ui/      shadcn components — generated, edit sparingly; add with `npx shadcn@latest add <name>`
  components/         app components: StatusDot, HostBadge/HostDot, SessionRow, SessionListSkeleton, ScreenHeader,
                      Markdown/Linkified, NewSessionDrawer
  components/session/ detail screen parts: ChatView, TermView, Composer, SessionMenu, LatestButton
  screens/            ListScreen (`#/`), SessionScreen (`#/s/:host/:id`)
  App.tsx             providers + wouter hash router
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
- **Storage keys** are `fleet.*`; reuse the classic UI's keys where the meaning is the same
  (`fleet.detailMode`, `fleet.termFont`, `fleet.termLines`, `fleet.chatFont`, `fleet.chatHideNotes`).
- **Text from sessions is data**: render it as text (React escapes); never `dangerouslySetInnerHTML`.
  Markdown must stay DOM-only with `http(s)` links only, like `../public/markdown.js`.
- Pure logic goes in `lib/` with a `*.test.ts` next to it.

## Features

- **List** (`#/`): all sessions across hosts, status + host filter chips, search, unreachable-host
  banners, `+` → New session.
- **New session** (drawer): host, directory (radio from that host's `spawnDirs`), optional name
  and first prompt → `api.spawn`. 400/409 are shown inline; on success a loading toast watches
  `/api/fleet` (`api/spawnWatch.ts`, 1.5s for up to 45s) for `tmux_session === tmuxSession` and
  opens the session. Remembers `fleet.spawnHost` / `fleet.spawnDirLabel.<host>` (classic keys).
- **Session detail** (`#/s/:host/:id`), fixed full-screen layout that follows the visual viewport
  (`fixed-app`: `--app-h` + `--app-top`, so the composer stays above the iOS keyboard):
  - header: back, name, status, host, "updated Xs ago", Chat | Term toggle, ⋯;
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
  Auto-name → Run now (+ last run / schedule from `/api/health` when the host is this server),
  session details (tmux, backend, pid, id), Close session (two taps within 5s → `api.kill`, back
  to the list, row dropped optimistically).
- **PWA**: `public/` has the manifest (standalone, `/#/`) and the same icons as the classic UI;
  `index.html` sets theme-color (kept in sync with the theme), apple-mobile-web-app meta,
  `viewport-fit=cover` and `interactive-widget=resizes-content`. No service worker (the app is
  useless offline; the server revalidates every file).
