#!/bin/bash
set -euo pipefail

# Description: Installs the attention audit for the current user:
#              - copies the scripts to ~/.attention-audit
#              - starts the logger in the background at login (LaunchAgent on macOS, systemd --user on Linux)
#              - adds "Attention Card" launcher (macOS App or Linux .desktop)
#              No sudo, no permission prompt, nothing leaves your machine.
# Usage: curl -fsSL https://raw.githubusercontent.com/Neysixx/attention-audit/main/install.sh | bash
#        ~/.attention-audit/install.sh uninstall
# Dependencies: macOS: curl, tar, launchctl, osacompile, codesign (built-ins)
#               Linux: bun, systemd, zenity (optional)

export PATH="${HOME}/.bun/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"

readonly OS="$(uname)"
readonly INSTALL_DIR="${HOME}/.attention-audit"
readonly TARBALL="https://github.com/Neysixx/attention-audit/archive/refs/heads/main.tar.gz"
readonly FILES=(audit.sh card.sh card.js card-macos.js card-linux.js install.sh package.json)

# macOS specific
readonly LABEL="com.neysixx.attention-audit"
readonly PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
readonly APP="${HOME}/Applications/Attention Card.app"

# Linux specific
readonly SERVICE_NAME="attention-audit.service"
readonly SYSTEMD_USER_DIR="${HOME}/.config/systemd/user"
readonly DESKTOP_DIR="${HOME}/.local/share/applications"

stop_agent_macos() {
    launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
}

stop_service_linux() {
    if command -v systemctl >/dev/null 2>&1; then
        systemctl --user stop "$SERVICE_NAME" 2>/dev/null || true
        systemctl --user disable "$SERVICE_NAME" 2>/dev/null || true
    fi
}

uninstall() {
    if [[ "$OS" == "Darwin" ]]; then
        stop_agent_macos
        rm -f "$PLIST"
        rm -rf "$APP"
        echo "stopped the logger and removed Attention Card.app."
    else
        stop_service_linux
        rm -f "${SYSTEMD_USER_DIR}/${SERVICE_NAME}"
        rm -f "${DESKTOP_DIR}/attention-card.desktop"
        if command -v systemctl >/dev/null 2>&1; then
            systemctl --user daemon-reload 2>/dev/null || true
        fi
        echo "stopped the logger and removed Attention Card launcher."
    fi
    echo "your data is still in ${INSTALL_DIR}/data. delete it with: rm -rf ${INSTALL_DIR}"
}

fetch_files() {
    local script_dir
    script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || echo "")"

    mkdir -p "${INSTALL_DIR}/data"
    mkdir -p "${INSTALL_DIR}/assets"

    if [[ -n "$script_dir" && -f "${script_dir}/audit.sh" && -f "${script_dir}/card.sh" ]]; then
        # Running from local repo
        for f in "${FILES[@]}"; do
            if [[ -f "${script_dir}/${f}" ]]; then
                cp "${script_dir}/${f}" "${INSTALL_DIR}/${f}"
            fi
        done
        if [[ -f "${script_dir}/bun.lock" ]]; then
            cp "${script_dir}/bun.lock" "${INSTALL_DIR}/bun.lock"
        fi
        cp -R "${script_dir}/assets/." "${INSTALL_DIR}/assets/"
    else
        # Running via curl | bash
        local tmp
        tmp=$(mktemp -d)
        trap 'rm -rf "$tmp"' RETURN
        curl -fsSL "$TARBALL" | tar -xz -C "$tmp" --strip-components 1
        for f in "${FILES[@]}"; do
            if [[ -f "${tmp}/${f}" ]]; then
                cp "${tmp}/${f}" "${INSTALL_DIR}/${f}"
            fi
        done
        cp -R "${tmp}/assets/." "${INSTALL_DIR}/assets/"
    fi

    chmod +x "${INSTALL_DIR}"/*.sh "${INSTALL_DIR}"/*.js

    # On Linux: install Bun dependencies (for @napi-rs/canvas)
    if [[ "$OS" != "Darwin" ]] && command -v bun >/dev/null 2>&1; then
        (cd "${INSTALL_DIR}" && bun install --silent)
    fi
}

install_agent_macos() {
    mkdir -p "$(dirname "$PLIST")"
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>${INSTALL_DIR}/audit.sh</string>
    </array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>ProcessType</key><string>Background</string>
    <key>StandardOutPath</key><string>${INSTALL_DIR}/audit.log</string>
    <key>StandardErrorPath</key><string>${INSTALL_DIR}/audit.log</string>
</dict>
</plist>
EOF
    stop_agent_macos
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
}

install_app_macos() {
    mkdir -p "$(dirname "$APP")"
    rm -rf "$APP"
    osacompile -o "$APP" -e "do shell script quoted form of \"${INSTALL_DIR}/card.sh\" & \" > /dev/null 2>&1 &\""
    # Swapping the icon breaks osacompile's ad-hoc signature, so sign again.
    cp "${INSTALL_DIR}/assets/nudge.icns" "${APP}/Contents/Resources/applet.icns"
    codesign --force --sign - "$APP" >/dev/null 2>&1 || true
    touch "$APP"
}

install_gnome_ext() {
    local ext_src="${INSTALL_DIR}/assets/gnome-focus-ext"
    if [[ ! -d "$ext_src" ]] || ! command -v gnome-shell >/dev/null 2>&1; then
        return 0
    fi

    local uuid="nudge-focus@kodylabs"
    local ext_target="${HOME}/.local/share/gnome-shell/extensions/${uuid}"
    mkdir -p "$ext_target"
    cp "${ext_src}/metadata.json" "${ext_src}/extension.js" "$ext_target/"

    if command -v gnome-extensions >/dev/null 2>&1; then
        gnome-extensions enable "$uuid" 2>/dev/null || true
    fi
    if command -v gsettings >/dev/null 2>&1; then
        local enabled
        enabled="$(gsettings get org.gnome.shell enabled-extensions 2>/dev/null || echo '')"
        if [[ -n "$enabled" && "$enabled" != *"$uuid"* ]]; then
            if [[ "$enabled" == "@as []" ]]; then
                gsettings set org.gnome.shell enabled-extensions "['${uuid}']"
            else
                gsettings set org.gnome.shell enabled-extensions "${enabled%]}, '${uuid}']"
            fi
        fi
    fi
}

install_service_linux() {
    mkdir -p "$SYSTEMD_USER_DIR"
    cat > "${SYSTEMD_USER_DIR}/${SERVICE_NAME}" <<EOF
[Unit]
Description=Attention Audit Logger
After=graphical-session.target

[Service]
Type=simple
ExecStart=/bin/bash %h/.attention-audit/audit.sh
Restart=always
RestartSec=10
Environment="PATH=%h/.bun/bin:/usr/local/bin:/usr/bin:/bin"

[Install]
WantedBy=default.target
EOF

    if command -v systemctl >/dev/null 2>&1; then
        systemctl --user daemon-reload
        systemctl --user enable --now "$SERVICE_NAME"
    fi
}

install_app_linux() {
    mkdir -p "$DESKTOP_DIR"
    cat > "${DESKTOP_DIR}/attention-card.desktop" <<EOF
[Desktop Entry]
Version=1.0
Type=Application
Name=Attention Card
Comment=Nudge Attention Audit Card
Exec=${INSTALL_DIR}/card.sh
Icon=${INSTALL_DIR}/assets/nudge-icon.png
Terminal=false
Categories=Utility;
EOF
    chmod +x "${DESKTOP_DIR}/attention-card.desktop"
    if command -v update-desktop-database >/dev/null 2>&1; then
        update-desktop-database "$DESKTOP_DIR" 2>/dev/null || true
    fi
}

if [[ "${1:-}" == "uninstall" ]]; then
    uninstall
    exit 0
fi

if [[ "$OS" != "Darwin" ]]; then
    if ! command -v bun >/dev/null 2>&1; then
        echo "Error: 'bun' is required on Linux to render the attention card." >&2
        echo "Install bun with: curl -fsSL https://bun.sh/install | bash" >&2
        exit 1
    fi
fi

echo "installing attention audit to ${INSTALL_DIR}"
fetch_files

if [[ "$OS" == "Darwin" ]]; then
    install_agent_macos
    install_app_macos
else
    install_gnome_ext
    install_service_linux
    install_app_linux
fi

cat <<EOF

done. the audit is now running in the background, and starts again at login.

- in 7 days you get a prompt with your card
- want it earlier?
EOF

if [[ "$OS" == "Darwin" ]]; then
    cat <<EOF
  open "Attention Card" from ~/Applications (or Spotlight)
  or run: ${INSTALL_DIR}/card.sh
- stop and remove: ${INSTALL_DIR}/install.sh uninstall
EOF
else
    cat <<EOF
  open "Attention Card" from your application launcher
  or run: ${INSTALL_DIR}/card.sh
- check status: systemctl --user status attention-audit
- stop and remove: ${INSTALL_DIR}/install.sh uninstall
EOF
fi

cat <<EOF
- your data: ${INSTALL_DIR}/data (plain CSV, never leaves your computer)
EOF
