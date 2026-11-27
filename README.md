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
the extension reads state straight from the CLI instead of guessing. The one
exception is whether you're sharing your screen or webcam, which the CLI
doesn't report; see *Known gaps*.

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
| In a call | Title and timer (with buttons to ask an AI agent about the call and to rename it), Mute, Share my screen, Share my webcam (opens Tuple's camera picker), Control their screen, Participants (remove), Reactions & more (sounds, emoji and animations, raise hand, screenshot of the shared screen, transcript capture), Leave |
| Always | Your name and account in the header, Live calls (calls your teammates are on that you can join, or "No live calls"), Contacts (presence dot, ⭐ favourite, click to call, or to add to the current call, remove for contacts outside your team, invite someone by email), Rooms (join, copy link, ⭐, create team room), Recent calls (opens a Markdown export, ask an AI agent about it, rename, delete, plus full-text search), your other machines, update banner, Settings, Stop Tuple, Log out |

**Notices posted into the call:** when an agent or integration posts a notice or
asks a question in your current call (`tuple notifications`), it also shows up
as a GNOME notification, and is withdrawn when it's answered or the call ends.

**AI agent:** the terminal button on the call header, or on a Recent calls row,
asks what you want help with (optional) and opens your AI agent in a terminal
with that call as context (`tuple connect`). Set the agent up once with
`tuple connect configure` in a terminal. The terminal is GNOME's default one if
it's installed, otherwise the first of Ptyxis, Console, GNOME Terminal, kitty,
Alacritty, foot, WezTerm, Konsole or xterm; Settings → Extension → Terminal
command overrides it. If the agent fails to start, the terminal stays open to
show why.

**Keyboard shortcuts:** mute / unmute, answer, leave, and join the link on the
clipboard, set under Settings → Extension. They work anywhere in GNOME, and
mute / unmute shows the result on screen.

**Settings** (from the menu, or `gnome-extensions prefs tuple-deck@eliassfl.github.io`):
Tuple's own settings (annotation overlay, start muted, capture method,
shared-screen mode, transcription model), plus the extension's options: call
timer, notifications, keyboard shortcuts, the path to `tuple`, the update
command, the terminal for AI agents and a debug log.

## Requirements

- GNOME Shell 51 (the only version it has been tested on).
- The `tuple` CLI, v2026_10_21.0 or newer, logged in. GNOME Shell's PATH usually
  leaves out `~/.local/bin`, so the extension also looks in `~/.local/bin` and
  `$XDG_BIN_HOME`. You can also set an explicit path in Settings.
  Webcam, raise hand and the emoji / animation reactions need v2026_11_19.0;
  on older versions those items are hidden.
- `curl` and `sha256sum` for the "Update Tuple" item (see below).

## Install

```sh
./install.sh          # compiles, packs dist/*.zip, installs and enables for your user
```

The extension is written in TypeScript, so installing from a clone needs Node.js
(for `tsc`); `install.sh` runs `npm ci` the first time. The zip attached to each
GitHub release is already compiled and only needs `gnome-extensions install`.

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
| Live state | `tuple --format json state follow`, `contacts follow`, `rooms follow`: long-running, one JSON snapshot per line, restarted with backoff if Tuple stops. `notifications follow` runs the same way, only while you're in a call |
| Calls | `call start / accept / join / leave / mute / unmute / react / raise-hand / lower-hand`, `call participants add / remove`, `call list --joinable` and `call show` (both read when the menu opens; `state` has no call title), `call edit --title` |
| AI agent | `connect [--call <id>] [-- <purpose>]`, run in a terminal |
| Webcam | `webcam start` (opens the camera picker), `webcam stop` |
| Sharing state | Read-only watch of the daemon's log, `$XDG_DATA_HOME/tuple/<n>/log.txt`, for the lines that say screen or webcam sharing started or stopped |
| What the CLI offers | `--help` and `call --help` (which commands exist), `call react --help` (which reactions exist), read at startup and on reconnect |
| Rooms, contacts | `rooms join / create / favorite / unfavorite`, `contacts favorite / unfavorite / invite / remove` |
| History | `capture list / search / export --as markdown / delete`, `capture start / stop` |
| Screen | `screen -o ~/Pictures/Tuple/…` |
| Account / daemon | `start`, `stop`, `login`, `auth`, `logout`, `whoami`, `machines list` |
| **Deprecated, still used** | `share` / `unshare` and `settings` / `set` (no replacements yet). They don't accept `--format json`. The UI hides each control when its command disappears from `tuple --help`. |

Known gaps:

- **Incoming calls are inferred.** No public schema documents how an incoming
  call appears in `state`. The extension treats "not in a call, but a call is
  present (state contains `incoming`/`ring`)" as incoming. If incoming calls
  aren't detected, turn on **Settings → Extension → Log call state changes**,
  receive a call, and look at `~/.cache/tuple-deck/state-log.ndjson`.
- **Live calls and call notices are also inferred.** `call list` and
  `notifications follow` only return something while calls are going on, so
  their parsing accepts several likely field names. With the debug log on,
  call notices are written to `~/.cache/tuple-deck/notifications-log.ndjson`.
- **Questions can't be answered from GNOME.** The CLI can only post and
  withdraw notices; accepting or rejecting one happens in the Tuple app, so
  the notification says so instead of showing buttons.
- Remove is offered only for contacts outside your team (`kind` other than
  `teammate`), assuming teammates come from the team and can't be removed.
- **Sharing state comes from Tuple's log.** The CLI doesn't say whether you're
  sharing your screen or webcam (`state` has no sharer or webcam field, even
  while you share), but the daemon logs when either starts or stops, however
  it happened: from the menu, Tuple's own window, or GNOME's screen-share
  stop button. The two switches follow those lines, so a cancelled picker or
  a share stopped elsewhere shows correctly. The log isn't a documented
  interface; if it can't be found or stops matching, the switches fall back
  to remembering what you last clicked.
- Mute and capture switches use the call payload (`muted`, `transcribing`)
  and fall back to remembering what you last clicked. Raise hand always
  remembers, as nothing reports it.
- Call history needs Tuple's capture store, which needs a transcription model.
  Without one the submenu explains that instead of listing calls.

## Development

```
src/                    the extension, in TypeScript
  extension.ts          wiring: store → indicator, notifications, shortcuts
  prefs.ts              Adw preferences window
  lib/cli.ts            TupleCli (one-shot commands) + Follower (JSON line streams)
  lib/store.ts          live state from the follow streams; incoming/presence/card events
  lib/tupleLog.ts       watches Tuple's daemon log for screen / webcam sharing
  lib/model.ts          Tuple's JSON types + pure helpers: status, normalizers (unit tested)
  lib/actions.ts        every menu action as a CLI call, errors → notifications
  lib/indicator.ts      the panel button and menu
  lib/menuItems.ts      contact / room / participant / live call / history rows
  lib/dialogs.ts        prompt, confirm, login and search dialogs
  ambient.d.ts          types for gi:// and resource:/// imports (@girs packages)
  bin/update-tuple      bundled updater for the tuple CLI (bash)
build/                  compiled JS + metadata, schemas, css, bin (what gets packed; not committed)
tests/model.test.js     unit tests, run against build/
dev/sandbox.sh          headless GNOME Shell test run (see below)
dev/mock-tuple          fake tuple CLI serving dev/fixtures/<scenario>/
dev/fake-terminal       stand-in terminal for the sandbox: logs the agent command, then runs it
dev/readonly-tuple      passes only read-only commands to the real CLI
dev/test-helper/        sandbox-only extension that runs a plan: clicks, scenarios, screenshots
dev/plans/*.json        test plans
```

```sh
npm ci                                         # once: typescript + @girs type packages
npm run check                                  # type-check only
npm run build                                  # src/ → build/
npm test                                       # build, then unit tests
dev/sandbox.sh                                 # build, then full UI tour against mock-tuple → dev/out/*.png
TUPLE_DECK_REAL=1 dev/sandbox.sh dev/plans/real-readonly.json   # against your real Tuple, read-only
```

`tsc` emits plain ES modules that keep the source's layout and comments, so
what ships stays readable. Types come from `@girs/gnome-shell` 50, the newest
published; nothing the extension uses changed in GNOME 51. GObject subclasses
register in a `static {}` block so they keep their TypeScript types, and
`useDefineForClassFields` is off so a field declaration emits nothing (with
define semantics it would reset the field after `super()`, wiping anything the
base class's `_init` had set).

The sandbox runs `gnome-shell --headless` on its own D-Bus session, with every
XDG directory (dconf, extensions, cache, runtime) in a temp dir. Your real
desktop's settings and extensions are never touched, and with `mock-tuple`
nobody gets called. The test helper drives the menu with a virtual pointer,
asserts which CLI commands were run (`["expect", "<regex>"]`), and saves
screenshots.
