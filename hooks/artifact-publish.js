#!/usr/bin/env node
/**
 * @file Claude Code PostToolUse(Artifact) hook: publish된 claude.ai Artifact를 ~/artifacts/claude/에 .url로 남긴다 (KeepSight 목록에 바로 뜬다).
 * 플러그인 폴더나 ~/.claude/hooks/에서 단독 실행되므로 store.js에 의존하지 않는다 (형식은 store.js와 동일하게 유지할 것).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = process.env.ARTIFACTS_ROOT || path.join(os.homedir(), 'artifacts');
const URL_RE = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9_-]+/;

/**
 * @param {unknown} s
 * @returns {string}
 */
const clean = s => String(s || '').replace(/[\r\n]/g, ' ').trim();

/**
 * @param {unknown} s
 * @returns {string} 파일 이름으로 쓸 수 있는 80자 이하 문자열
 */
const safeName = s => clean(s).replace(/[\/\\:*?"<>|]/g, '-').replace(/^\.+/, '').slice(0, 80);

/**
 * 이미 기록한 URL 목록. 여기 있으면 재배포이므로 건너뛴다.
 * @param {string} dir
 * @returns {Set<string>}
 */
function knownUrls(dir) {
  const urls = new Set();
  for (const rel of fs.readdirSync(dir, { recursive: true })) {
    if (!rel.endsWith('.url')) continue;
    const m = fs.readFileSync(path.join(dir, rel), 'utf8').match(/^URL=(.*)$/m);
    if (m) urls.add(m[1].trim());
  }
  return urls;
}

/**
 * Artifact 제목. 입력에 title이 없으면 publish한 HTML 파일의 `<title>`을 읽는다.
 * @param {{ title?: string, file_path?: string }} input Artifact 도구 입력
 * @param {string} [cwd] 상대 경로 기준 폴더
 * @returns {string} 못 찾으면 빈 문자열
 */
function titleOf(input, cwd) {
  if (input.title) return clean(input.title);
  if (!input.file_path) return '';
  try {
    const html = fs.readFileSync(path.resolve(cwd || '.', input.file_path), 'utf8').slice(0, 8192);
    return clean(html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]);
  } catch {
    return '';
  }
}

/**
 * PostToolUse 이벤트를 받아 publish된 claude.ai Artifact URL을 `claude/<제목>.url`로 남긴다. 이미 기록한 URL이나 publish가 아닌 호출은 건너뛴다.
 * @param {{ tool_input?: Record<string, any>, tool_response?: unknown, cwd?: string }} ev hook 입력(JSON)
 */
function main(ev) {
  const input = ev.tool_input || {};
  if ((input.action || 'publish') !== 'publish' || input.asset) return;
  const url = JSON.stringify(ev.tool_response ?? '').match(URL_RE)?.[0];
  if (!url) return;

  fs.mkdirSync(path.join(ROOT, 'claude'), { recursive: true });
  if (knownUrls(ROOT).has(url)) return;

  const title = titleOf(input, ev.cwd) || url.split('/').pop();
  const base = safeName(title) || 'artifact';
  const body = `[InternetShortcut]\nURL=${url}\nTitle=${title}\nTags=\n`;
  for (let n = 1; n < 100; n++) {
    try {
      return fs.writeFileSync(path.join(ROOT, 'claude', `${n === 1 ? base : `${base}-${n}`}.url`), body, { flag: 'wx' });
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
}

let raw = '';
process.stdin.on('data', d => (raw += d)).on('end', () => {
  // hook 실패가 Claude 작업을 막으면 안 되므로 에러는 stderr로만 남기고 0으로 끝낸다
  try { main(JSON.parse(raw)); } catch (e) { console.error(`artifact-publish hook: ${e.message}`); }
});
