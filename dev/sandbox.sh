#!/bin/bash
# Runs Tuple Deck in a throwaway headless GNOME Shell against dev/mock-tuple,
# executes a test plan (see dev/test-helper/extension.js) and leaves
# screenshots + logs in the output directory.
#
#   dev/sandbox.sh [plan.json] [out-dir]     defaults: dev/plans/tour.json, dev/out
#   TUPLE_DECK_REAL=1 dev/sandbox.sh dev/plans/real-readonly.json
#       reads from the real Tuple app through dev/readonly-tuple instead
#       (read-only commands only; screenshots then show real contacts).
#
# Isolation: every XDG dir (dconf settings, extensions, cache, runtime dir)
# points into a temp directory and the session has its own D-Bus, so the real
# desktop's settings and extensions are never touched, and the mock CLI means
# nobody gets called.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
PLAN="$(realpath "${1:-$REPO/dev/plans/tour.json}")"
OUT="$(realpath -m "${2:-$REPO/dev/out}")"
DECK_UUID="tuple-deck@eliassfl.github.io"
HELPER_UUID="tuple-deck-test@eliassfl.github.io"

SB="$(mktemp -d -t tuple-deck-sandbox.XXXXXX)"
cleanup() {
    # The extension's CLI streams outlive the killed shell (they get reparented
    # to systemd), so reap everything that still carries this sandbox's env.
    local env
    for env in /proc/[0-9]*/environ; do
        grep -qzx "TUPLE_MOCK_DIR=$SB/mock" "$env" 2>/dev/null &&
            kill "$(cut -d/ -f3 <<<"$env")" 2>/dev/null
    done
    # xdg-document-portal leaves a FUSE mount in the runtime dir.
    fusermount3 -uz "$SB/runtime/doc" 2>/dev/null
    rm -rf "$SB"
}
trap cleanup EXIT
mkdir -p "$SB"/{config,data,cache,state,runtime,mock}
chmod 700 "$SB/runtime"
rm -rf "$OUT" && mkdir -p "$OUT"

glib-compile-schemas "$REPO/src/schemas"
EXT_DIR="$SB/data/gnome-shell/extensions"
mkdir -p "$EXT_DIR"
ln -s "$REPO/src" "$EXT_DIR/$DECK_UUID"
ln -s "$REPO/dev/test-helper" "$EXT_DIR/$HELPER_UUID"

# The extension shows Tuple's installed app icon; mirror it into the sandbox
# so screenshots look like the real thing (the generic fallback otherwise).
for icon in "${XDG_DATA_HOME:-$HOME/.local/share}"/icons/hicolor/*/apps/tuple.png; do
    [[ -f "$icon" ]] || continue
    dest="$SB/data/icons/hicolor/$(basename "$(dirname "$(dirname "$icon")")")/apps"
    mkdir -p "$dest" && cp "$icon" "$dest/"
done

cp "$REPO"/dev/fixtures/common/*.json "$SB/mock/"
cp "$REPO/dev/fixtures/idle/state.json" "$SB/mock/"

TUPLE_BIN="$REPO/dev/mock-tuple"
if [[ "${TUPLE_DECK_REAL:-}" == 1 ]]; then
    TUPLE_BIN="$REPO/dev/readonly-tuple"
    export REAL_TUPLE="$(command -v tuple || echo "$HOME/.local/bin/tuple")"
    export REAL_XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}" \
           REAL_XDG_DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}" \
           REAL_XDG_CACHE_HOME="${XDG_CACHE_HOME:-$HOME/.cache}" \
           REAL_XDG_STATE_HOME="${XDG_STATE_HOME:-$HOME/.local/state}" \
           REAL_XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
fi
export TUPLE_BIN

# XDG_BIN_HOME too: the bundled update-tuple installs there, and must never
# overwrite the real ~/.local/bin/tuple from a test.
export XDG_CONFIG_HOME="$SB/config" XDG_DATA_HOME="$SB/data" XDG_CACHE_HOME="$SB/cache" \
       XDG_STATE_HOME="$SB/state" XDG_RUNTIME_DIR="$SB/runtime" XDG_BIN_HOME="$SB/bin"
export TUPLE_MOCK_DIR="$SB/mock" TUPLE_DECK_TEST_PLAN="$PLAN" TUPLE_DECK_TEST_OUT="$OUT" \
       TUPLE_DECK_FIXTURES="$REPO/dev/fixtures"
export SB REPO OUT DECK_UUID HELPER_UUID
unset WAYLAND_DISPLAY DISPLAY

dbus-run-session -- bash -c '
    set -euo pipefail
    gsettings set org.gnome.shell disable-user-extensions false
    gsettings set org.gnome.shell enabled-extensions "[\"$DECK_UUID\", \"$HELPER_UUID\"]"
    gsettings set org.gnome.shell welcome-dialog-last-shown-version "999"
    # The sandbox shares the system bus with the real session, so a logind
    # lock of the real screen would lock (and disable extensions in) this one.
    gsettings set org.gnome.desktop.lockdown disable-lock-screen true
    gsettings set org.gnome.desktop.screensaver lock-enabled false
    gsettings set org.gnome.desktop.session idle-delay 0
    GSETTINGS_SCHEMA_DIR="$REPO/src/schemas" \
        gsettings set org.gnome.shell.extensions.tuple-deck tuple-path "$TUPLE_BIN"

    gnome-shell --headless --virtual-monitor 1600x900 --no-x11 > "$OUT/shell.log" 2>&1 &
    shell=$!
    for _ in $(seq 1 240); do
        [[ -f "$OUT/done" ]] && break
        kill -0 $shell 2>/dev/null || break
        sleep 0.5
    done
    kill $shell 2>/dev/null || true
    wait $shell 2>/dev/null || true
' 2> "$OUT/session.log"
cp "$SB/mock/commands.log" "$OUT/" 2>/dev/null || true

echo "== helper log"
cat "$OUT/helper.log" 2>/dev/null || echo "(none — the helper never ran)"
echo "== extension errors in shell.log"
grep -nE "JS ERROR|JS WARNING|tuple-deck|Gjs-CRITICAL" "$OUT/shell.log" | grep -v "Battery-Health" || echo "(none)"
if [[ ! -f "$OUT/done" ]]; then
    echo "TIMED OUT"
    exit 1
fi
failures="$(cat "$OUT/done")"
echo "== $failures failure(s); screenshots in $OUT"
[[ "$failures" == "0" ]]
