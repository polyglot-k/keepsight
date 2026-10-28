---
name: keepsight
description: KeepSight 앱(~/artifacts를 보여주는 로컬 Electron 앱, 예전 이름 Artifact Manager)을 켜거나 설치·갱신하는 skill. 사용자가 "keepsight 열어", "킵사이트 켜줘", "artifact 앱 열어", "아티팩트 앱 켜줘", "앱 안 떠", "artifact 앱 셋업/설치/갱신해줘", "자동 실행 꺼줘" 같은 말이나 "open keepsight", "set up / install / update keepsight", "open the artifact app", "turn off autostart" 같은 말을 하면 발동. 파일을 ~/artifacts에 저장하는 일은 keepsight-save skill이 맡는다.
---

# KeepSight

모든 동작은 저장소의 `manage.sh` 하나로 한다. `${CLAUDE_PLUGIN_ROOT}`는 플러그인으로 설치하면 Claude Code가, `manage.sh setup`으로 설치하면 스크립트가 저장소 경로로 바꿔 넣는다.

## 열기

```sh
"${CLAUDE_PLUGIN_ROOT}/manage.sh" open
```

- 꺼져 있으면 켜고, 켜져 있으면 숨겨진 창까지 앞으로 가져온다.
- 실행 결과 한 줄을 그대로 전한다. 앱이 안 뜨면 `/tmp/keepsight.log`를 읽고 원인을 알린다.

## 설치·갱신

```sh
"${CLAUDE_PLUGIN_ROOT}/manage.sh" setup                 # 로그인 시 자동 실행 포함 (기본)
"${CLAUDE_PLUGIN_ROOT}/manage.sh" setup --no-autostart  # 자동 실행 없이
```

- 순서: 의존성 설치(처음만) → `npm test` → `keepsight` 명령 등록 → `~/.claude`에 skill·hook 복사(플러그인으로 설치했으면 건너뜀) → 자동 실행 등록(또는 해제) → 앱 실행. 다시 돌려도 같은 결과가 된다.
- 플러그인을 업데이트하면 설치 경로가 바뀌므로 `setup`을 다시 돌려야 자동 실행이 새 경로를 가리킨다.
- 저장소 코드를 고친 뒤 반영할 때도 `setup`을 다시 돌린다. 실행 중인 앱은 새 코드로 다시 켜진다.
- 출력에 `[todo]`가 있으면 PATH 또는 hook 등록이 빠진 것이다. hook이 `~/.claude/settings.json`에 없다는 안내라면 settings.json은 직접 고치지 말고, 출력된 JSON 조각과 넣을 위치를 사용자에게 보여 준다.
- 테스트가 실패하면 거기서 멈춘다. 실패 출력을 그대로 보여 준다.
