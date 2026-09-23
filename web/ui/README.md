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
  lib/format.ts       pure display helpers: relTime, clockTime, shortCwd, sessionSubtitle, hostColorSlot
  lib/sessions.ts     status meta/labels, filters, search, sort, listView(), findSession(), sessionHref()
  lib/styles.ts       static Tailwind class maps: status dot/text colours, host badge colours
  lib/storage.ts      localStorage that never throws
  lib/viewport.ts     --app-h from visualViewport (keyboard-aware height; utilities h-app / min-h-app)
  lib/utils.ts        cn() (shadcn)
  hooks/usePoller.ts  setTimeout-chained poller: no overlap, pauses while hidden, abort on unmount, refresh()
  hooks/useFleet.ts   fleet context + localStorage snapshot (`fleet.snapshot`, shared with the classic UI)
  hooks/useSettings.ts, useTheme.ts, useNow.ts, usePersistentState.ts
  providers/          FleetProvider (polls /api/fleet every 5s), SettingsProvider (/api/settings once), ThemeProvider
  components/ui/      shadcn components — generated, edit sparingly; add with `npx shadcn@latest add <name>`
  components/         app components: StatusDot, HostBadge/HostDot, SessionRow, SessionListSkeleton, ScreenHeader
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

## Phase 2 (not built yet)

The detail screen is a placeholder. Still to port from the classic UI (`../public/app.js`):

- Session detail: Chat | Term toggle (`fleet.detailMode`); chat polls `messages` every 3s with
  markdown, interim-note hiding, "Load older" (limits 60/200/500), follow-scroll; term polls `peek`
  every 2s (lines 200/600, font size); error states via `sessionErrorMessage()`.
- Composer: send (1..8000 chars), quick replies from `useSettings().quickReplies`, key chips
  `QUICK_KEYS` (Esc/↵/↑/↓ → `api.keys`), disabled for `backend: unknown` (409).
- ⋯ menu: text size, auto-name → Run now (`api.autoname`), Close session (two taps → `api.kill`,
  back to the list), theme (`useTheme().setTheme`).
- New-session sheet (`+` in the list header): host, dir from that host's `spawnDirs`, name, prompt →
  `api.spawn`, then poll the fleet for `tmux_session === tmuxSession` and open it (`applyFleet`).
- PWA polish: service worker/offline shell if wanted, standalone status-bar colours.
