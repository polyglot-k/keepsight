---
name: keepsight
description: Opens, installs, or updates the KeepSight app (a local Electron app that shows ~/artifacts, formerly Artifact Manager). Triggers when the user says things like "open keepsight", "set up / install / update keepsight", "open the artifact app", "the app won't open", or "turn off autostart". Saving files into ~/artifacts is handled by the keepsight-save skill. Also triggers on Korean requests such as "keepsight 열어", "킵사이트 켜줘", "artifact 앱 열어", "아티팩트 앱 켜줘", "앱 안 떠", "artifact 앱 셋업/설치/갱신해줘", "자동 실행 꺼줘".
---

# KeepSight

Everything goes through the repo's single `manage.sh`. `${CLAUDE_PLUGIN_ROOT}` is replaced with the repo path by Claude Code when installed as a plugin, or by the script when installed with `manage.sh setup`.

## Open

```sh
"${CLAUDE_PLUGIN_ROOT}/manage.sh" open
```

- Starts the app if it is not running; if it is, brings its window (even a hidden one) to the front.
- Relay the one-line output as is. If the app does not appear, read `/tmp/keepsight.log` and report the cause.

## Install / update

```sh
"${CLAUDE_PLUGIN_ROOT}/manage.sh" setup                 # includes launch at login (default)
"${CLAUDE_PLUGIN_ROOT}/manage.sh" setup --no-autostart  # without launch at login
```

- Order: install dependencies (first run only) → `npm test` → register the `keepsight` command → copy the skills and hook into `~/.claude` (skipped for plugin installs) → register (or remove) launch at login → start the app. Rerunning gives the same result.
- Updating the plugin changes its install path, so rerun `setup` to point launch at login at the new path.
- Rerun `setup` after changing the repo code, too. A running app is restarted with the new code.
- `[todo]` in the output means PATH or hook registration is missing. If it says the hook is not in `~/.claude/settings.json`, do not edit settings.json yourself; show the user the printed JSON snippet and where to put it.
- If the tests fail, stop there and show the failure output as is.
