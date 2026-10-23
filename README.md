# Tuple Deck

A GNOME Shell extension that puts the **Tuple Linux client** in your top bar:
presence, calls, contacts, rooms, screen sharing and call history, all driven
through the official `tuple` CLI.

> **Unofficial.** Not affiliated with, endorsed by, or supported by Tuple.
> [Tuple for Linux](https://docs.tuple.app/getting-started/tuple-for-linux) is
> in alpha and its CLI changes between releases. "Tuple" is a trademark of its
> respective owner. MIT licensed, use at your own risk.

This replaces [tuple-panel](https://github.com/eliasSFL/tuple-panel), a GTK4 app
built against the pre-October-2026 CLI. That CLI had no status command, so the
panel tailed Tuple's log file and typed into the interactive `tuple call` picker.
The current CLI (v2026_10_21.0+) has JSON output and live `follow` streams, so
the extension reads state straight from the CLI instead of guessing.

## What it does

**Top bar:** Tuple's own app icon (the one its Linux client installs, looked up
by name, not bundled; a generic call icon if it isn't installed). It fades when
Tuple is stopped, logged out or offline, and gets an amber dot while a call
rings (in or out) and a green dot during a call, next to a running call timer
and a crossed-out microphone when you are muted.

**Menu:**

| State | You get |
|---|---|
| Not running / logged out | Start Tuple, Log in (opens the link, asks for the code) |
| Idle | Start a call in your room, Join a link from the clipboard |
| Incoming call | Who's calling + Answer (also as a notification with an Answer button) |
| Calling someone | Ringing status + Cancel |
| In a call | Title and timer, Mute, Share my screen, Control their screen, Participants (remove), Reactions & more (air horn / sad trombone / flute, screenshot of the shared screen, transcript capture), Leave |
| Always | Contacts (presence dot, ⭐ favourite, click to call, or to add to the current call), Rooms (join, copy link, ⭐, create team room), Recent calls (opens a Markdown export, plus full-text search), your other machines, update banner, Settings, Stop Tuple, Log out |

**Settings** (from the menu, or `gnome-extensions prefs tuple-deck@eliassfl.github.io`):
Tuple's own settings (annotation overlay, start muted, capture method,
shared-screen mode, transcription model), plus the extension's options: call
timer, notifications, the path to `tuple`, the update command and a debug log.

## Requirements

- GNOME Shell 51 (the only version it has been tested on).
- The `tuple` CLI, v2026_10_21.0 or newer, logged in. GNOME Shell's PATH usually
  leaves out `~/.local/bin`, so the extension also looks in `~/.local/bin` and
  `$XDG_BIN_HOME`. You can also set an explicit path in Settings.
- `curl` and `sha256sum` for the "Update Tuple" item (see below).

## Install

```sh
./install.sh          # packs dist/*.zip, installs and enables for your user
```

GNOME on Wayland only discovers a newly installed extension at login. Log out and
back in (then `gnome-extensions enable tuple-deck@eliassfl.github.io` if
`install.sh` couldn't enable it yet). Updates also need a re-login.

## Updating Tuple

Tuple has no package for any Linux distro, so the extension bundles an updater,
[`src/bin/update-tuple`](src/bin/update-tuple). When Tuple reports a newer
release, the menu shows **Update Tuple to vX**. Clicking it runs the script in
the background:

1. Asks Tuple's release API for the latest version, its download URL and
   SHA-256 (x86_64 or arm64, picked from `uname -m`).
2. Skips the download if you're already on that version.
3. Downloads it, checks that it's an ELF binary and matches the checksum, then
   installs it to `$XDG_BIN_HOME/tuple` or `~/.local/bin/tuple` (no sudo).
4. Notifies you, with a **Restart Tuple** button (`tuple stop && tuple start`),
   because the running daemon keeps the old binary until restarted. The button
   is left out while you're in a call.

The script also works on its own: `bash src/bin/update-tuple [--force | vYYYY_MM_DD.N]`.
To use a different updater, set **Settings → Extension → Update command**;
leave it empty for the bundled one.

## How it talks to Tuple

| Need | CLI |
|---|---|
| Live state | `tuple --format json state follow`, `contacts follow`, `rooms follow`: long-running, one JSON snapshot per line, restarted with backoff if Tuple stops |
| Calls | `call start / accept / join / leave / mute / unmute / react`, `call participants add / remove` |
| Rooms, favourites | `rooms join / create / favorite / unfavorite`, `contacts favorite / unfavorite` |
| History | `capture list / search / export --as markdown`, `capture start / stop` |
| Screen | `screen -o ~/Pictures/Tuple/…` |
| Account / daemon | `start`, `stop`, `login`, `auth`, `logout`, `machines list` |
| **Deprecated, still used** | `share` / `unshare` and `settings` / `set` (no replacements yet). They don't accept `--format json`. The UI hides each control when its command disappears from `tuple --help`. |

Known gaps:

- **Incoming calls are inferred.** No public schema documents how an incoming
  call appears in `state`. The extension treats "not in a call, but a call is
  present (state contains `incoming`/`ring`)" as incoming. If incoming calls
  aren't detected, turn on **Settings → Extension → Log call state changes**,
  receive a call, and look at `~/.cache/tuple-deck/state-log.ndjson`.
- Mute, share and capture switches use the call payload when it includes that
  state and otherwise fall back to remembering what you last clicked.
- Call history needs Tuple's capture store, which needs a transcription model.
  Without one the submenu explains that instead of listing calls.

## Development

```
src/                    the extension (what gets packed)
  extension.js          wiring: store → indicator, notifications
  prefs.js              Adw preferences window
  lib/cli.js            TupleCli (one-shot commands) + Follower (JSON line streams)
  lib/store.js          live state from the three follow streams; incoming/presence events
  lib/model.js          pure helpers: status derivation, normalizers (unit tested)
  lib/actions.js        every menu action as a CLI call, errors → notifications
  lib/indicator.js      the panel button and menu
  lib/menuItems.js      contact / room / participant rows
  lib/dialogs.js        prompt, confirm, login and search dialogs
  bin/update-tuple      bundled updater for the tuple CLI (bash)
tests/model.test.js     gjs -m tests/model.test.js
dev/sandbox.sh          headless GNOME Shell test run (see below)
dev/mock-tuple          fake tuple CLI serving dev/fixtures/<scenario>/
dev/readonly-tuple      passes only read-only commands to the real CLI
dev/test-helper/        sandbox-only extension that runs a plan: clicks, scenarios, screenshots
dev/plans/*.json        test plans
```

```sh
gjs -m tests/model.test.js                     # unit tests
dev/sandbox.sh                                 # full UI tour against mock-tuple → dev/out/*.png
TUPLE_DECK_REAL=1 dev/sandbox.sh dev/plans/real-readonly.json   # against your real Tuple, read-only
```

The sandbox runs `gnome-shell --headless` on its own D-Bus session, with every
XDG directory (dconf, extensions, cache, runtime) in a temp dir. Your real
desktop's settings and extensions are never touched, and with `mock-tuple`
nobody gets called. The test helper drives the menu with a virtual pointer,
asserts which CLI commands were run (`["expect", "<regex>"]`), and saves
screenshots.
