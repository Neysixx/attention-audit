#!/bin/bash
set -euo pipefail

# Description: Builds your attention card from the logged data, opens it, and
#              opens a prefilled post so sharing is one drag. Nothing is posted
#              until you hit send.
# Usage: ./card.sh            build, open, offer to share
#        ./card.sh --ask      ask first with a dialog (used by the 7-day prompt)
#        ./card.sh --no-share build and print the report only
# Dependencies: macOS: built-in osascript
#               Linux: bun, zenity (optional), xdg-open

export PATH="${HOME}/.bun/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"

readonly OS="$(uname)"
readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly DATA_DIR="${SCRIPT_DIR}/data"
readonly CARD="${SCRIPT_DIR}/card.png"
readonly ICON_MACOS="${SCRIPT_DIR}/assets/nudge.icns"
readonly ICON_LINUX="${SCRIPT_DIR}/assets/nudge-icon.png"
readonly REPO_URL="github.com/Neysixx/attention-audit"
readonly X_HANDLE="@ks_nsx"
readonly WAITLIST_URL="https://mynudge.app/?utm_source=attention-audit&utm_medium=script&utm_campaign=card#waitlist"
readonly CTA="Want to know what your numbers mean + early access to Nudge?"
readonly MODE="${1:-}"

ask_dialog() {
    local title="$1"
    local msg="$2"
    local ok_label="$3"
    local cancel_label="$4"

    if [[ "$OS" == "Darwin" ]]; then
        local answer
        answer=$(osascript -e "button returned of (display dialog \"${msg}\" with title \"${title}\" buttons {\"${cancel_label}\", \"${ok_label}\"} default button \"${ok_label}\" with icon POSIX file \"${ICON_MACOS}\")" 2>/dev/null || echo "${cancel_label}")
        [[ "$answer" == "$ok_label" ]] && return 0 || return 1
    else
        if command -v zenity >/dev/null 2>&1; then
            zenity --question --title="$title" --text="$msg" \
                --ok-label="$ok_label" --cancel-label="$cancel_label" \
                --window-icon="$ICON_LINUX" 2>/dev/null
            return $?
        elif command -v kdialog >/dev/null 2>&1; then
            kdialog --title "$title" --yes-label "$ok_label" --no-label "$cancel_label" --warningyesno "$msg" 2>/dev/null
            return $?
        fi
        return 0
    fi
}

show_error() {
    local msg="$1"
    echo "$msg" >&2
    if [[ ! -t 1 ]]; then
        if [[ "$OS" == "Darwin" ]]; then
            osascript -e "display alert \"Nudge · Attention audit\" message \"${msg//\"/}\"" >/dev/null 2>&1 || true
        elif command -v zenity >/dev/null 2>&1; then
            zenity --error --title="Nudge · Attention audit" --text="${msg}" 2>/dev/null || true
        fi
    fi
}

open_target() {
    local target="$1"
    if [[ "$OS" == "Darwin" ]]; then
        open "$target" >/dev/null 2>&1 &
    else
        if command -v xdg-open >/dev/null 2>&1; then
            xdg-open "$target" >/dev/null 2>&1 &
        fi
    fi
}

url_encode() {
    local str="$1"
    if [[ "$OS" == "Darwin" ]]; then
        osascript -l JavaScript -e 'function run(argv) { return encodeURIComponent(argv[0]) }' "$str"
    else
        bun -e 'console.log(encodeURIComponent(process.argv[1]))' "$str"
    fi
}

if [[ "$MODE" == "--ask" ]]; then
    if ! ask_dialog "Nudge · Attention audit" "7 days logged. Your attention card is ready." "Show my card" "Later"; then
        exit 1
    fi
fi

# Run the card generation engine according to OS
if [[ "$OS" == "Darwin" ]]; then
    if ! output=$(osascript -l JavaScript "${SCRIPT_DIR}/card-macos.js" "$DATA_DIR" "$CARD" "${SCRIPT_DIR}/assets" 2>&1); then
        message="${output##*Error: }"
        show_error "$message"
        exit 1
    fi
else
    if ! output=$(bun "${SCRIPT_DIR}/card-linux.js" "$DATA_DIR" "$CARD" "${SCRIPT_DIR}/assets" 2>&1); then
        message="${output##*Error: }"
        show_error "$message"
        exit 1
    fi
fi

summary=$(tail -n 1 <<< "$output")
echo "${output%$'\n'*}"
echo
echo "card saved to $CARD"
echo
echo "$CTA"
echo "$WAITLIST_URL"

[[ "$MODE" == "--no-share" ]] && exit 0

field() {
    sed -E "s/.*\"$1\":\"?([^\",}]*)\"?.*/\1/" <<< "$summary"
}

if [[ "$OS" == "Darwin" ]]; then
    platform_str="my mac"
else
    platform_str="Linux"
fi

post="my attention audit, $(field days) days on ${platform_str}:

$(field perDay) app switches a day. median focus stretch: $(field median).

check yours: ${REPO_URL} via ${X_HANDLE}"

encoded=$(url_encode "$post")

open_target "$CARD"
open_target "https://x.com/intent/post?text=${encoded}"

# Asked once, after the card: by then they have seen their numbers.
marker="${DATA_DIR}/.waitlist_asked"
if [[ ! -f "$marker" ]]; then
    touch "$marker"
    if ask_dialog "Nudge · Attention audit" "${CTA}" "Join the waitlist" "No thanks"; then
        open_target "$WAITLIST_URL"
    fi
fi
