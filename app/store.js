/**
 * @file root 폴더(~/artifacts)를 읽고 쓰는 순수 함수 모음. Electron에 의존하지 않아 테스트에서 바로 부른다.
 * 폴더가 곧 DB다: 1차 분류는 하위 폴더, 2차 분류는 태그(`<meta name="tags">` 또는 `.url`의 `Tags=`).
 */
const fs = require('fs');
const path = require('path');

/**
 * 목록의 한 항목. 파일 하나(.html 또는 .url)에 대응한다.
 * @typedef {object} Item
 * @property {string} path 절대 경로
 * @property {string} folder root 기준 폴더 (루트면 '')
 * @property {string} name 확장자를 뺀 파일 이름
 * @property {string} title 제목 (없으면 name)
 * @property {string[]} tags
 * @property {number} mtime 수정 시각(ms)
 * @property {'file' | 'link'} kind
 * @property {string} [url] 링크일 때 URL
 * @property {string} text 본문 검색용 텍스트 (링크는 '')
 */

/**
 * 줄바꿈을 공백으로 바꾸고 앞뒤 공백을 지운다.
 * @param {unknown} s
 * @returns {string}
 */
const clean = s => String(s || '').replace(/[\r\n]/g, ' ').trim();

/**
 * 파일 이름으로 쓸 수 없는 문자를 `-`로 바꾸고 80자로 자른다. 앞의 점은 지워 숨김 파일이 되지 않게 한다.
 * @param {unknown} s
 * @returns {string}
 */
const safeName = s => clean(s).replace(/[\/\\:*?"<>|]/g, '-').replace(/^\.+/, '').slice(0, 80);

/**
 * 쉼표로 구분된 태그 문자열을 배열로 나눈다. 빈 항목은 버린다.
 * @param {string | undefined} s
 * @returns {string[]}
 */
const splitTags = s => (s || '').split(',').map(t => t.trim()).filter(Boolean);

/**
 * HTML 속성·텍스트에 넣을 수 있게 `&`, `<`, `"`를 이스케이프한다.
 * @param {string} s
 * @returns {string}
 */
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

/**
 * {@link esc}의 역변환. 자주 쓰는 엔티티만 되돌린다.
 * @param {string} s
 * @returns {string}
 */
const unesc = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;
const TAGS_RE = /<meta\s+name=["']tags["']\s+content=["']([^"']*)["'][^>]*>/i;

/**
 * renderer가 넘긴 경로는 신뢰하지 않는다. root 밖이면 거부한다.
 * @param {string} root
 * @param {string} p
 * @returns {string} 정규화한 절대 경로
 * @throws {Error} root 밖 경로일 때
 */
function inRoot(root, p) {
  const r = path.resolve(p);
  if (!r.startsWith(path.resolve(root) + path.sep)) throw new Error(`Path is outside the root: ${p}`);
  return r;
}

/**
 * `a/b` 형식의 폴더 이름을 안전한 조각으로 나눠 root 아래 절대 경로로 만든다.
 * @param {string} root
 * @param {string} folder
 * @returns {string}
 */
function folderDir(root, folder) {
  const segs = clean(folder).split('/').map(safeName).filter(Boolean);
  return path.join(root, ...segs);
}

/**
 * `.url` 파일에서 `[InternetShortcut]` 형식의 key=value 줄만 읽는다.
 * @param {string} p
 * @returns {{ url?: string, title?: string, tags: string[] }}
 */
function readLink(p) {
  const kv = {};
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^(\w+)=(.*)$/);
    if (m) kv[m[1]] = m[2].trim();
  }
  return { url: kv.URL, title: kv.Title, tags: splitTags(kv.Tags) };
}

/** 본문 검색용 텍스트의 최대 길이(자). 큰 파일 때문에 목록 갱신이 무거워지지 않게 자른다 */
const MAX_TEXT = 100_000;

/**
 * 본문 검색용 텍스트를 만든다. script/style과 태그를 걷어내고 공백을 접는다. 최대 {@link MAX_TEXT}자.
 * @param {string} html
 * @returns {string}
 */
function bodyText(html) {
  return unesc(html.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' '))
    .replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
}

/**
 * HTML 파일에서 제목·태그(앞 8KB)와 본문 검색용 텍스트를 읽는다.
 * @param {string} p
 * @returns {{ title?: string, tags: string[], text: string }}
 */
function readHtml(p) {
  const html = fs.readFileSync(p, 'utf8');
  const h = html.slice(0, 8192);
  const title = h.match(TITLE_RE)?.[1].trim();
  const tags = h.match(TAGS_RE)?.[1];
  return { title: title && unesc(title), tags: splitTags(tags && unesc(tags)), text: bodyText(html) };
}

/**
 * root 아래의 `.html`·`.url`을 모두 읽어 최근 수정 순으로 돌려준다. 숨김 폴더와 node_modules는 건너뛴다.
 * ponytail: 매번 전체 스캔(본문까지 읽음), 수천 개 넘어 느려지면 mtime 캐시 추가
 * @param {string} root
 * @returns {Item[]}
 */
function scan(root) {
  const items = [];
  for (const rel of fs.readdirSync(root, { recursive: true })) {
    if (rel.split(path.sep).some(seg => seg.startsWith('.') || seg === 'node_modules')) continue;
    const ext = path.extname(rel).toLowerCase();
    if (ext !== '.html' && ext !== '.url') continue;
    const full = path.join(root, rel);
    const stat = fs.statSync(full);
    if (!stat.isFile()) continue;
    const meta = ext === '.url' ? readLink(full) : readHtml(full);
    items.push({
      path: full,
      folder: path.dirname(rel) === '.' ? '' : path.dirname(rel),
      name: path.basename(rel, ext),
      title: meta.title || path.basename(rel, ext),
      tags: meta.tags,
      mtime: stat.mtimeMs,
      kind: ext === '.url' ? 'link' : 'file',
      url: meta.url,
      text: meta.text || '',
    });
  }
  return items.sort((a, b) => b.mtime - a.mtime);
}

/**
 * 링크를 `.url` 파일로 만든다. https만 받고, 같은 이름이 있으면 덮어쓰지 않고 실패한다.
 * @param {string} root
 * @param {{ url: string, title?: string, folder?: string, tags?: string }} link
 * @returns {string} 만든 파일 경로
 * @throws {Error} https가 아니거나 같은 이름이 있을 때
 */
function addLink(root, { url, title, folder, tags }) {
  url = clean(url);
  if (!/^https:\/\//.test(url)) throw new Error('Only https:// links can be added');
  const dir = folderDir(root, folder);
  const name = safeName(title) || safeName(new URL(url).pathname.split('/').pop()) || 'link';
  const dest = inRoot(root, path.join(dir, `${name}.url`));
  fs.mkdirSync(dir, { recursive: true });
  const body = `[InternetShortcut]\nURL=${url}\nTitle=${clean(title)}\nTags=${splitTags(clean(tags)).join(',')}\n`;
  fs.writeFileSync(dest, body, { flag: 'wx' }); // 같은 이름이 있으면 덮어쓰지 않음
  return dest;
}

/**
 * 정규식에 걸리는 태그가 있으면 교체하고, 없으면 `<head>` 바로 뒤(없으면 맨 앞)에 넣는다.
 * @param {string} html
 * @param {RegExp} re
 * @param {string} tag 넣을 태그 문자열
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
 * 제목·태그를 파일에 다시 쓰고, 폴더가 바뀌었으면 파일을 옮긴다.
 * @param {string} root
 * @param {string} p 대상 파일
 * @param {{ title?: string, tags?: string, folder?: string }} meta
 * @returns {string} 옮긴 뒤의 경로
 * @throws {Error} root 밖 경로이거나 옮길 폴더에 같은 이름이 있을 때
 */
function updateMeta(root, p, { title, tags, folder }) {
  p = inRoot(root, p);
  const dir = folderDir(root, folder);
  const dest = inRoot(root, path.join(dir, path.basename(p)));
  if (dest !== p && fs.existsSync(dest)) throw new Error(`A file with the same name already exists: ${dest}`);

  title = clean(title);
  tags = splitTags(clean(tags)).join(',');
  if (p.endsWith('.url')) {
    const keep = fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(l => l && !/^(Title|Tags)=/.test(l));
    fs.writeFileSync(p, [...keep, `Title=${title}`, `Tags=${tags}`, ''].join('\n'));
  } else {
    let h = fs.readFileSync(p, 'utf8');
    h = upsert(h, TITLE_RE, `<title>${esc(title)}</title>`);
    h = upsert(h, TAGS_RE, `<meta name="tags" content="${esc(tags)}">`);
    fs.writeFileSync(p, h);
  }

  if (dest !== p) {
    fs.mkdirSync(dir, { recursive: true });
    fs.renameSync(p, dest);
    moveHistory(root, p, dest);
  }
  return dest;
}

// ---- 버전 기록: <root>/.history/<상대 경로>/<시각>.html (숨김 폴더라 scan에 안 잡힌다) ----

/** 파일 하나당 남기는 최대 버전 수. 넘으면 오래된 것부터 지운다 */
const MAX_VERSIONS = 50;

/**
 * 한 파일의 버전 폴더 경로.
 * @param {string} root
 * @param {string} p root 안의 파일
 * @returns {string}
 */
const historyDir = (root, p) => path.join(root, '.history', path.relative(root, p));

/**
 * 한 버전.
 * @typedef {object} Version
 * @property {string} path 버전 파일 경로
 * @property {number} time 저장 시각(ms)
 * @property {number} size 바이트
 */

/**
 * 파일의 버전 목록. 최신이 먼저.
 * @param {string} root
 * @param {string} p
 * @returns {Version[]}
 */
function listHistory(root, p) {
  const dir = historyDir(root, inRoot(root, p));
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => /^\d+\.html$/.test(f))
    .map(f => ({ path: path.join(dir, f), time: Number(f.slice(0, -5)), size: fs.statSync(path.join(dir, f)).size }))
    .sort((a, b) => b.time - a.time);
}

/**
 * 지금 내용을 새 버전으로 남긴다. 최신 버전과 내용이 같으면 아무것도 하지 않는다.
 * @param {string} root
 * @param {string} p HTML 파일
 * @param {number} [now] 버전 시각(ms). 테스트용
 * @returns {string | null} 만든 버전 경로, 변경이 없으면 null
 */
function snapshot(root, p, now = Date.now()) {
  p = inRoot(root, p);
  if (!p.endsWith('.html') || !fs.existsSync(p)) return null;
  const html = fs.readFileSync(p);
  const versions = listHistory(root, p);
  if (versions[0] && html.equals(fs.readFileSync(versions[0].path))) return null;
  const dir = historyDir(root, p);
  fs.mkdirSync(dir, { recursive: true });
  // 같은 밀리초에 두 번 저장돼도 덮어쓰지 않게 최신보다 뒤의 시각을 쓴다
  const time = Math.max(now, (versions[0]?.time ?? 0) + 1);
  const dest = path.join(dir, `${time}.html`);
  fs.writeFileSync(dest, html);
  for (const old of versions.slice(MAX_VERSIONS - 1)) fs.rmSync(old.path);
  return dest;
}

/**
 * 버전을 되돌린다. 되돌리기 직전 내용도 버전으로 남겨서 되돌리기를 다시 되돌릴 수 있다.
 * @param {string} root
 * @param {string} p 대상 파일
 * @param {string} version {@link listHistory}가 돌려준 버전 경로
 * @returns {string} 대상 파일 경로
 * @throws {Error} 그 파일의 버전이 아닐 때
 */
function restore(root, p, version) {
  p = inRoot(root, p);
  version = inRoot(root, version);
  if (path.dirname(version) !== historyDir(root, p)) throw new Error(`Not a version of this file: ${version}`);
  snapshot(root, p);
  fs.copyFileSync(version, p);
  return p;
}

/**
 * 파일을 옮기면 버전 기록도 같이 옮긴다.
 * @param {string} root
 * @param {string} from
 * @param {string} to
 */
function moveHistory(root, from, to) {
  const src = historyDir(root, from);
  if (!fs.existsSync(src)) return;
  const dest = historyDir(root, to);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(src, dest);
}

module.exports = { scan, readLink, addLink, updateMeta, inRoot, bodyText, snapshot, listHistory, restore };
