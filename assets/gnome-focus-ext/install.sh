#!/bin/bash
set -euo pipefail

# Description: Installs the Nudge focus probe GNOME Shell extension for the current user.
#              On Wayland the shell only discovers new extensions at login, so the
#              extension is enabled now and starts answering after the next login.
# Usage: ./scripts/gnome-focus-ext/install.sh
# Dependencies: gnome-shell 45+, gsettings

readonly UUID="nudge-focus@kodylabs"
readonly SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly TARGET_DIR="${HOME}/.local/share/gnome-shell/extensions/${UUID}"

mkdir -p "$TARGET_DIR"
cp "${SOURCE_DIR}/metadata.json" "${SOURCE_DIR}/extension.js" "$TARGET_DIR/"

enabled="$(gsettings get org.gnome.shell enabled-extensions)"
if [[ "$enabled" != *"$UUID"* ]]; then
    if [[ "$enabled" == "@as []" ]]; then
        gsettings set org.gnome.shell enabled-extensions "['${UUID}']"
    else
        gsettings set org.gnome.shell enabled-extensions "${enabled%]}, '${UUID}']"
    fi
fi

echo "installed to ${TARGET_DIR}"
echo "log out and back in, then check:"
echo "  gdbus call --session --dest org.gnome.Shell --object-path /app/mynudge/FocusProbe --method app.mynudge.FocusProbe.FocusedApp"
