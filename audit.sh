#!/bin/bash
set -euo pipefail

# Description: Logs the name of the frontmost app every N seconds to a
#              daily CSV in ./data. Stretches with no keyboard/mouse input are
#              logged as "idle" so lunch and sleep don't count as focus.
#              Only the app name is recorded: no window titles, no URLs, no
#              keystrokes, no screenshots. Nothing leaves your machine, and no
#              elevated permissions are needed.
# Usage: ./audit.sh [interval_seconds]   (default 30, ctrl-c to stop)
#        install.sh runs it in the background at login instead.
# Dependencies: macOS: lsappinfo, ioreg, osascript (built-ins)
#               Linux: gdbus / mutter (or xprintidle / xdotool)

export PATH="${HOME}/.bun/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"

readonly OS="$(uname)"
readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly DATA_DIR="${SCRIPT_DIR}/data"
readonly INTERVAL="${1:-30}"
readonly IDLE_THRESHOLD=300
readonly READY_AFTER_DAYS=7

if [[ ! "$INTERVAL" =~ ^[0-9]+$ ]] || [[ "$INTERVAL" -lt 5 ]]; then
    echo "Usage: $0 [interval_seconds >= 5]" >&2
    exit 1
fi

idle_seconds_macos() {
    local idle
    idle=$(ioreg -c IOHIDSystem 2>/dev/null \
        | awk '/HIDIdleTime/ && !found {print int($NF/1000000000); found=1}') || true
    echo "${idle:-0}"
}

idle_seconds_linux() {
    # 1. GNOME Mutter via D-Bus
    if command -v gdbus >/dev/null 2>&1; then
        local idle_ms
        idle_ms=$(gdbus call --session --dest org.gnome.Mutter.IdleMonitor \
            --object-path /org/gnome/Mutter/IdleMonitor/Core \
            --method org.gnome.Mutter.IdleMonitor.GetIdletime 2>/dev/null | tr -dc '0-9' || true)
        if [[ -n "$idle_ms" && "$idle_ms" =~ ^[0-9]+$ ]]; then
            echo $(( idle_ms / 1000 ))
            return 0
        fi
    fi

    # 2. X11 via xprintidle
    if command -v xprintidle >/dev/null 2>&1; then
        local x_idle
        x_idle=$(xprintidle 2>/dev/null | tr -dc '0-9' || true)
        if [[ -n "$x_idle" && "$x_idle" =~ ^[0-9]+$ ]]; then
            echo $(( x_idle / 1000 ))
            return 0
        fi
    fi

    echo 0
}

idle_seconds() {
    if [[ "$OS" == "Darwin" ]]; then
        idle_seconds_macos
    else
        idle_seconds_linux
    fi
}

frontmost_app_macos() {
    local name
    name=$(lsappinfo info -only name "$(lsappinfo front 2>/dev/null)" 2>/dev/null \
        | sed -E 's/.*"="(.*)"$/\1/') || true
    echo "${name:-unknown}"
}

frontmost_app_linux() {
    local app=""

    # 1. GNOME Shell via FocusProbe D-Bus extension (Wayland/X11)
    if command -v gdbus >/dev/null 2>&1; then
        local reply
        reply="$(gdbus call --session --dest org.gnome.Shell \
            --object-path /app/mynudge/FocusProbe \
            --method app.mynudge.FocusProbe.FocusedApp 2>/dev/null || true)"
        if [[ -n "$reply" && "$reply" == \(\'* ]]; then
            reply="${reply#*\'}"
            reply="${reply%\'*}"
            app="$reply"
        fi
    fi

    # 2. Hyprland (Wayland)
    if [[ -z "$app" ]] && command -v hyprctl >/dev/null 2>&1; then
        app=$(hyprctl activewindow -j 2>/dev/null | jq -r '.class // empty' 2>/dev/null || true)
    fi

    # 3. Sway (Wayland)
    if [[ -z "$app" ]] && command -v swaymsg >/dev/null 2>&1; then
        app=$(swaymsg -t get_tree 2>/dev/null | jq -r '.. | select(.focused? == true) | .app_id // .window_properties?.class // empty' 2>/dev/null || true)
    fi

    # 4. X11 / XWayland via xdotool & xprop
    if [[ -z "$app" ]] && command -v xdotool >/dev/null 2>&1 && command -v xprop >/dev/null 2>&1; then
        local win_id
        win_id=$(xdotool getactivewindow 2>/dev/null || true)
        if [[ -n "$win_id" ]]; then
            app=$(xprop -id "$win_id" WM_CLASS 2>/dev/null | awk -F '"' '{print $(NF-1)}' || true)
        fi
    fi

    echo "${app:-unknown}"
}

frontmost_app() {
    if [[ "$OS" == "Darwin" ]]; then
        frontmost_app_macos
    else
        frontmost_app_linux
    fi
}

log_file_for_today() {
    echo "${DATA_DIR}/audit_$(date +%Y-%m-%d).csv"
}

# Once 7 days are logged, offer the card. "Later" asks again the next day.
offer_card_when_week_done() {
    local done_marker="${DATA_DIR}/.card_shown"
    local asked_marker="${DATA_DIR}/.card_asked_$(date +%Y-%m-%d)"
    [[ -f "$done_marker" || -f "$asked_marker" ]] && return 0
    local days
    days=$(find "$DATA_DIR" -name 'audit_*.csv' | wc -l | tr -d ' ')
    [[ "$days" -lt "$READY_AFTER_DAYS" ]] && return 0

    rm -f "${DATA_DIR}"/.card_asked_*
    touch "$asked_marker"
    echo "${READY_AFTER_DAYS} days logged. your card is ready: ./card.sh"
    ( "${SCRIPT_DIR}/card.sh" --ask >/dev/null 2>&1 && touch "$done_marker" ) &
}

mkdir -p "$DATA_DIR"
echo "logging the frontmost app every ${INTERVAL}s to data/audit_YYYY-MM-DD.csv"
echo "idle after ${IDLE_THRESHOLD}s without input. ctrl-c to stop."
echo "after ${READY_AFTER_DAYS} days you get a prompt for your card (or run ./card.sh any time)"

while true; do
    log_file="$(log_file_for_today)"
    if [[ ! -f "$log_file" ]]; then
        echo "timestamp,app" > "$log_file"
    fi
    offer_card_when_week_done

    if [[ "$(idle_seconds)" -ge "$IDLE_THRESHOLD" ]]; then
        app="idle"
    else
        app="$(frontmost_app)"
    fi

    printf '%s,"%s"\n' "$(date +%Y-%m-%dT%H:%M:%S)" "${app//\"/}" >> "$log_file"
    sleep "$INTERVAL"
done
