#!/usr/bin/env node
/**
 * @file HTML 파일을 KeepSight 루트(~/artifacts)에 규칙대로 저장한다. 원본은 건드리지 않는다.
 *   node save-html.js <src.html> [--folder study/db] [--tags a,b] [--title 제목] [--name file-name]
 * - <title>, <meta name="tags">가 없으면 넣고, 인자로 주면 교체한다. 본문은 그대로.
 * - 같은 이름이 있으면 덮어쓰지 않고 -2, -3을 붙인다. 저장한 경로를 stdout으로 출력한다.
 * 플러그인 폴더나 저장소에서 단독 실행되므로 store.js에 의존하지 않는다 (형식은 store.js와 동일하게 유지할 것).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = process.env.ARTIFACTS_ROOT || path.join(os.homedir(), 'artifacts');

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
 * @param {string} s
 * @returns {string}
 */
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;
const TAGS_RE = /<meta\s+name=["']tags["']\s+content=["']([^"']*)["'][^>]*>/i;

/**
 * 정규식에 걸리는 태그가 있으면 교체하고, 없으면 `<head>` 바로 뒤(없으면 맨 앞)에 넣는다.
 * @param {string} html
 * @param {RegExp} re
 * @param {string} tag
 * @returns {string}
 */
function upsert(html, re, tag) {
  if (re.test(html)) return html.replace(re, () => tag);
  const m = html.match(/<head[^>]*>/i);
  if (!m) return `${tag}\n${html}`;
  const at = m.index + m[0].length;
  return `${html.slice(0, at)}\n${tag}${html.slice(at)}`;
}

/**
 * `--key value` 형식의 인자를 객체로, 나머지는 `_`에 모은다.
 * @param {string[]} argv
 * @returns {{ _: string[], [key: string]: any }}
 */
function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[++i] ?? '';
    else args._.push(argv[i]);
  }
  return args;
}

/**
 * HTML을 root 아래에 규칙대로 저장한다. 원본은 건드리지 않고, 같은 이름이 있으면 `-2`, `-3`을 붙인다.
 * @param {string} src 원본 HTML
 * @param {{ folder?: string, tags?: string, title?: string, name?: string }} [opts]
 * @returns {string} 저장한 경로
 * @throws {Error} root 밖 폴더이거나 같은 이름이 너무 많을 때
 */
function save(src, { folder = '', tags, title, name } = {}) {
  let html = fs.readFileSync(src, 'utf8');
  if (title != null) html = upsert(html, TITLE_RE, `<title>${esc(clean(title))}</title>`);
  else if (!TITLE_RE.test(html)) html = upsert(html, TITLE_RE, `<title>${esc(path.basename(src, path.extname(src)))}</title>`);
  if (tags != null) {
    const t = clean(tags).split(',').map(s => s.trim()).filter(Boolean).join(',');
    html = upsert(html, TAGS_RE, `<meta name="tags" content="${esc(t)}">`);
  }

  const dir = path.join(ROOT, ...clean(folder).split('/').map(safeName).filter(Boolean));
  if (!path.resolve(dir).startsWith(path.resolve(ROOT))) throw new Error(`Folder is outside the root: ${folder}`);
  fs.mkdirSync(dir, { recursive: true });
  const base = safeName(name || path.basename(src, path.extname(src))) || 'artifact';
  for (let n = 1; n < 100; n++) {
    const dest = path.join(dir, `${n === 1 ? base : `${base}-${n}`}.html`);
    try {
      fs.writeFileSync(dest, html, { flag: 'wx' });
      return dest;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
  throw new Error('Too many files with the same name');
}

if (require.main === module) {
  const a = parseArgs(process.argv.slice(2));
  if (!a._[0]) {
    console.error('usage: save-html.js <src.html> [--folder f] [--tags a,b] [--title t] [--name n]');
    process.exit(2);
  }
  try {
    console.log(save(a._[0], a));
  } catch (e) {
    console.error(`save-html: ${e.message}`);
    process.exit(1);
  }
}

module.exports = { save };
