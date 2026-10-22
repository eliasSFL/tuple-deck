#!/bin/bash
# Packs the extension and installs it for the current user.
#   ./install.sh            build dist/<uuid>.shell-extension.zip and install it
#   ./install.sh --pack     only build the zip
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
UUID="tuple-deck@eliassfl.github.io"

mkdir -p "$REPO/dist"
gnome-extensions pack "$REPO/src" \
    --force \
    --out-dir "$REPO/dist" \
    --extra-source=lib \
    --extra-source=icons \
    --schema=schemas/org.gnome.shell.extensions.tuple-deck.gschema.xml
ZIP="$REPO/dist/$UUID.shell-extension.zip"
echo "Built $ZIP"
[[ "${1:-}" == "--pack" ]] && exit 0

gnome-extensions install --force "$ZIP"
glib-compile-schemas "${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID/schemas"
echo "Installed $UUID."
if gnome-extensions list | grep -qx "$UUID"; then
    gnome-extensions enable "$UUID"
    echo "Enabled. If you updated an existing install, log out and back in to load the new code."
else
    echo "GNOME Shell only discovers new extensions at login on Wayland:"
    echo "log out and back in, then run: gnome-extensions enable $UUID"
fi
