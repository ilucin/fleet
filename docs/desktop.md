# Desktop app (macOS)

`Fleet.app` is the web UI in its own window: a Dock icon, ⌘-Tab, a remembered window, native
menus — instead of a browser tab. It is a thin [Tauri 2](https://tauri.app) shell
(`crates/fleet-desktop`) around this machine's `fleet web serve`; the UI is exactly the one the
server serves, so it never needs its own release.

Why Tauri: it uses the system WebKit (a ~10 MB app, not a bundled Chromium like Electron), it is
Rust, so it lives in this workspace and reads the config through `fleet::core::config`, and it has
first-class hooks for everything a wrapper has to decide (navigation, new windows, downloads, file
drops). A plain WKWebView app in Swift would be smaller still but a second language and toolchain.

## Build and install

On a Mac with the repo's Rust toolchain (arm64 builds an arm64 app):

```sh
crates/fleet-desktop/bundle.sh             # → target/release/bundle/Fleet.app and Fleet.zip
crates/fleet-desktop/bundle.sh --install   # ...and copy it to ~/Applications
```

The script runs `cargo build --release -p fleet-desktop`, writes the bundle (Info.plist, an
`.icns` made from `crates/fleet-desktop/icons/icon.png` with `sips`/`iconutil`) and signs it
ad hoc. No Tauri CLI, Node or Xcode app is needed (the Command Line Tools are). The crate is not a
default workspace member, so a plain `cargo build` / `cargo test` does not build Tauri; build or
test it with `-p fleet-desktop`.

**Another Mac** (e.g. build on the workstation, run on the laptop — same architecture): copy the
bundle over and put it in Applications.

```sh
rsync -a target/release/bundle/Fleet.app laptop:Applications/   # or scp the Fleet.zip and unzip it
```

The app is not notarized. Copied with rsync/scp it has no quarantine flag and just opens; if it
came through a browser, AirDrop or Mail, macOS refuses it once — right-click → Open, or
`xattr -dr com.apple.quarantine ~/Applications/Fleet.app`. The target Mac needs `fleet` itself
(`fleet install --host laptop` from the other machine, or `cargo install`) and a config.

## Which server it opens

The first of:

1. `FLEET_DESKTOP_URL` (env, for testing: run `Fleet.app/Contents/MacOS/fleet-desktop` from a shell);
2. `desktop.url` in `~/.config/fleet/config.json` — e.g. the workstation's URL, to use it without a
   local server (`fleet config set desktop.url http://100.x.y.z:7777`);
3. `hosts.<self>.web` — this machine's own server, the normal case;
4. `http://127.0.0.1:<web.port>` (7777 without a config).

Since every server merges its peers, the local server shows the whole fleet.

On launch a small start page checks `GET /api/health`. If the server answers, the window loads
it. If not and the URL is this machine's (3, 4, or a loopback 1/2), the app starts
`fleet --local web serve --port <that port>` (plus `--bind 127.0.0.1` for a loopback URL) with the
login shell's `PATH`, logs to `~/Library/Logs/Fleet/web-serve.log`, and opens the UI once it is
up. A server the app started stops when the app quits; to keep one running (and reachable from the
phone) with the lid open and the app closed, use `fleet web install-service` — the app then just
connects. Anything else — a remote URL that is down, a server that exits, one that does not come up
within 30 s — shows "Fleet server is not running" with the error, the log tail and Retry.
`fleet` is found as config `fleetBin`, else on the login shell's `PATH`, `~/.local/bin`,
`~/.cargo/bin`, `/opt/homebrew/bin`, `/usr/local/bin`.

## Behaviour

| | |
| --- | --- |
| ⌘R | reload (back to the start page when the server is gone) |
| ⌘⇧R | reconnect: the start page again (re-checks, restarts a server the app owns) |
| ⌘[ / ⌘] | back / forward (the app's hash routes) |
| ⌘W, close button | hide the window; the Dock icon brings it back; ⌘Q quits |
| links | the server's own pages stay in the window; other http(s) pages and every `target="_blank"` link open in the default browser; `vscode://`, `vscode-insiders://`, `cursor://`, `mailto:` go to macOS (**Open in VS Code / Cursor** works); other schemes are dropped |
| downloads | the preview's Download saves to `~/Downloads` (no overwrite: `name (1).ext`) and reveals the file in Finder |
| files | dropping files on a session / the New session form, pasting images and the paperclip picker work as in the browser (Tauri's own drop handler is off, so the page gets the drop) |
| clipboard | Copy path and ⌘C/⌘V/⌘X/⌘A work (Edit menu); on a plain-http tailnet URL the UI uses its non-secure-context copy fallback |
| window | size, position and maximized/fullscreen state are remembered; the title follows the page (`(2) session · Fleet`) |
| single instance | opening the app again focuses the running one |

The server's page gets no Tauri IPC: only the bundled start page may call the app's two commands
(`connect`, `open_log`). The web app has no notifications today, so the app asks for no
notification permission.

## Develop

```sh
cargo run -p fleet-desktop                                   # debug build, the config's server
FLEET_DESKTOP_URL=http://127.0.0.1:7796 cargo run -p fleet-desktop   # a test server of your own
cargo test -p fleet-desktop
cargo clippy -p fleet-desktop --all-targets -- -D warnings
```

Layout: `src/server.rs` (URL resolution, health probe, starting the server), `src/links.rs` (the
navigation / new-window policy), `src/main.rs` (window, menu, plugins), `start/index.html` (the
start page), `tauri.conf.json`, `icons/` (`icon.svg` is the web icon on the macOS icon grid;
`icon.png` is rendered from it).
