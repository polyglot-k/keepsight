#!/bin/sh
# KeepSight 설치·실행 (macOS)
#   ./manage.sh setup [--no-autostart]   의존성 설치 → 테스트 → `keepsight` 명령 등록 → Claude Code skill·hook 복사(플러그인 설치면 생략) → 로그인 시 자동 실행 등록 → 앱 실행
#   ./manage.sh open                     앱을 켜거나, 이미 켜져 있으면 창을 앞으로
# setup 뒤에는 어느 폴더에서든 `keepsight open|setup`으로 부를 수 있다.
# 몇 번을 다시 실행해도 같은 결과가 되게 짰다. 저장소를 고친 뒤 setup을 다시 돌리면 skill·hook·앱이 갱신된다.
set -e

# ~/.local/bin의 심볼릭 링크로 불려도 저장소 경로를 찾도록 링크를 따라간다
REPO=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
BIN_DIR="$HOME/.local/bin"
ELECTRON="$REPO/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
LABEL=com.local.keepsight
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

# 경로에 ?·* 같은 문자가 있어도 맞도록 정규식(pgrep) 대신 명령줄 전체를 그대로 비교한다
app_pids() { ps -axo pid=,command= | while read -r pid cmd; do [ "$cmd" = "$ELECTRON $REPO" ] && echo "$pid"; done; }
running() { [ -n "$(app_pids)" ]; }
loaded() { launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; }

open_app() {
  if running; then
    # 단일 인스턴스라 한 번 더 실행하면 기존 창이 앞으로 오고 새 프로세스는 바로 끝난다
    "$ELECTRON" "$REPO" >/dev/null 2>&1 &
  elif loaded; then
    launchctl kickstart "$DOMAIN/$LABEL"
  else
    nohup "$ELECTRON" "$REPO" >/tmp/keepsight.log 2>&1 &
  fi
  echo "Opened KeepSight ($REPO)"
}

# 플러그인으로 설치했으면 Claude Code가 skill·hook을 이미 불러오므로 건너뛴다.
# 직접 설치할 때는 SKILL.md의 ${CLAUDE_PLUGIN_ROOT}를 이 저장소 경로로 바꿔 ~/.claude에 넣는다
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

# 경로가 설치 위치마다 달라서 plist는 여기서 만든다
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
  # 이미 떠 있는 앱(이전 실행분)은 새 코드로 갈아끼운다
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
