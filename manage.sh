#!/bin/sh
# KeepSight install and launch (macOS)
#   ./manage.sh setup [--no-autostart]   install deps -> test -> register the `keepsight` command -> copy Claude Code skills and hook (skipped for plugin installs) -> register launch at login -> start the app
#   ./manage.sh open                     start the app, or bring its window to the front if already running
# After setup, run `keepsight open|setup` from any folder.
# Idempotent: rerunning gives the same result. After changing the repo, rerun setup to refresh the skills, hook, and app.
set -e

# Follow the symlink so the repo path is found even when called via ~/.local/bin
REPO=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
BIN_DIR="$HOME/.local/bin"
ELECTRON="$REPO/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
LABEL=com.local.keepsight
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

# Compare the full command line instead of a regex (pgrep) so paths containing ? or * still match
app_pids() { ps -axo pid=,command= | while read -r pid cmd; do [ "$cmd" = "$ELECTRON $REPO" ] && echo "$pid"; done; }
running() { [ -n "$(app_pids)" ]; }
loaded() { launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; }

open_app() {
  if running; then
    # Single instance: launching again brings the existing window forward and the new process exits immediately
    "$ELECTRON" "$REPO" >/dev/null 2>&1 &
  elif loaded; then
    launchctl kickstart "$DOMAIN/$LABEL"
  else
    nohup "$ELECTRON" "$REPO" >/tmp/keepsight.log 2>&1 &
  fi
  echo "Opened KeepSight ($REPO)"
}

# Skipped for plugin installs, since Claude Code already loads the skills and hook.
# For a manual install, replaces ${CLAUDE_PLUGIN_ROOT} in SKILL.md with this repo path and copies into ~/.claude
install_claude() {
  case "$REPO" in
    "$HOME/.claude/plugins/"*) echo "Installed as a Claude Code plugin; skipping skill and hook copy"; return ;;
  esac
  for s in keepsight keepsight-save; do
    mkdir -p "$HOME/.claude/skills/$s"
    cp -R "skills/$s/." "$HOME/.claude/skills/$s/"
    sed "s#\${CLAUDE_PLUGIN_ROOT}#$REPO#g" "skills/$s/SKILL.md" > "$HOME/.claude/skills/$s/SKILL.md"
  done
  mkdir -p "$HOME/.claude/hooks"
  cp hooks/artifact-publish.js "$HOME/.claude/hooks/"
  echo "Copied Claude Code skills (keepsight, keepsight-save) and the publish hook to ~/.claude"
  if ! grep -q 'artifact-publish.js' "$HOME/.claude/settings.json" 2>/dev/null; then
    echo '[todo] The publish hook is not registered yet. Add this to "hooks" > "PostToolUse" in ~/.claude/settings.json:'
    echo '  {"matcher": "Artifact", "hooks": [{"type": "command", "command": "node ~/.claude/hooks/artifact-publish.js", "timeout": 10}]}'
  fi
}

install_bin() {
  mkdir -p "$BIN_DIR"
  ln -sf "$REPO/manage.sh" "$BIN_DIR/keepsight"
  case ":$PATH:" in
    *":$BIN_DIR:"*) echo "Run 'keepsight open' from anywhere to open the app" ;;
    *) echo "[todo] $BIN_DIR is not on your PATH. Add export PATH=\"\$HOME/.local/bin:\$PATH\" to your shell profile" ;;
  esac
}

# The plist is generated here because paths differ per install location
write_plist() {
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$ELECTRON</string>
    <string>$REPO</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>StandardErrorPath</key><string>/tmp/keepsight.log</string>
</dict>
</plist>
EOF
}

setup() {
  cd "$REPO"
  [ -x "$ELECTRON" ] || npm install
  npm test --silent
  install_bin
  install_claude

  if [ "$1" = "--no-autostart" ]; then
    if loaded; then launchctl bootout "$DOMAIN/$LABEL"; fi
    rm -f "$PLIST"
    echo "Disabled launch at login"
    open_app
    return
  fi
  write_plist
  # Replace an already-running app (from a previous run) with the new code
  if loaded; then launchctl bootout "$DOMAIN/$LABEL" || true; fi
  for pid in $(app_pids); do kill "$pid"; done
  sleep 1
  launchctl bootstrap "$DOMAIN" "$PLIST"
  echo "Registered launch at login and started the app (log: /tmp/keepsight.log)"
}

case "$1" in
  setup) shift; setup "$@" ;;
  open) open_app ;;
  *) echo "usage: keepsight setup [--no-autostart] | open"; exit 2 ;;
esac
