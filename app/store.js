/**
 * @file Pure functions that read and write the root folder (~/artifacts). No Electron dependency, so tests call them directly.
 * The folder is the DB: subfolders are the primary grouping, tags (`<meta name="tags">` or `Tags=` in `.url`) the secondary.
 */
const fs = require('fs');
const path = require('path');

/**
 * One list item. Maps to a single file (.html or .url).
 * @typedef {object} Item
 * @property {string} path absolute path
 * @property {string} folder folder relative to root ('' at the root)
 * @property {string} name file name without extension
 * @property {string} title title (name if missing)
 * @property {string[]} tags
 * @property {number} mtime modification time (ms)
 * @property {'file' | 'link'} kind
 * @property {string} [url] URL, for links
 * @property {string} text body text for search ('' for links)
 */

/**
 * Replaces newlines with spaces and trims.
 * @param {unknown} s
 * @returns {string}
 */
const clean = s => String(s || '').replace(/[\r\n]/g, ' ').trim();

/**
 * Replaces characters not allowed in file names with `-` and truncates to 80 chars. Strips leading dots so the file isn't hidden.
 * @param {unknown} s
 * @returns {string}
 */
const safeName = s => clean(s).replace(/[\/\\:*?"<>|]/g, '-').replace(/^\.+/, '').slice(0, 80);

/**
 * Splits a comma-separated tag string into an array. Drops empty entries.
 * @param {string | undefined} s
 * @returns {string[]}
 */
const splitTags = s => (s || '').split(',').map(t => t.trim()).filter(Boolean);

/**
 * Escapes `&`, `<`, and `"` for use in HTML attributes and text.
 * @param {string} s
 * @returns {string}
 */
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

/**
 * Inverse of {@link esc}. Decodes only common entities.
 * @param {string} s
 * @returns {string}
 */
const unesc = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;
const TAGS_RE = /<meta\s+name=["']tags["']\s+content=["']([^"']*)["'][^>]*>/i;

/**
 * Paths from the renderer are untrusted. Rejects anything outside root.
 * @param {string} root
 * @param {string} p
 * @returns {string} normalized absolute path
 * @throws {Error} if the path is outside root
 */
function inRoot(root, p) {
  const r = path.resolve(p);
  if (!r.startsWith(path.resolve(root) + path.sep)) throw new Error(`Path is outside the root: ${p}`);
  return r;
}

/**
 * Splits an `a/b` folder name into safe segments and builds an absolute path under root.
 * @param {string} root
 * @param {string} folder
 * @returns {string}
 */
function folderDir(root, folder) {
  const segs = clean(folder).split('/').map(safeName).filter(Boolean);
  return path.join(root, ...segs);
}

/**
 * Reads only the `[InternetShortcut]`-style key=value lines from a `.url` file.
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

/** Max length (chars) of body search text. Truncated so large files don't make list refresh heavy */
const MAX_TEXT = 100_000;

/**
 * Builds body search text. Strips script/style and tags and collapses whitespace. At most {@link MAX_TEXT} chars.
 * @param {string} html
 * @returns {string}
 */
function bodyText(html) {
  return unesc(html.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' '))
    .replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
}

/**
 * Reads the title and tags (first 8KB) and the body search text from an HTML file.
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
 * Reads every `.html` and `.url` under root and returns them most recently modified first. Skips hidden folders and node_modules.
 * ponytail: full scan every time (bodies included); add an mtime cache if thousands of files make it slow
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
 * Creates a `.url` file for a link. Accepts https only, and fails rather than overwrite an existing name.
 * @param {string} root
 * @param {{ url: string, title?: string, folder?: string, tags?: string }} link
 * @returns {string} path of the created file
 * @throws {Error} if not https or the name already exists
 */
function addLink(root, { url, title, folder, tags }) {
  url = clean(url);
  if (!/^https:\/\//.test(url)) throw new Error('Only https:// links can be added');
  const dir = folderDir(root, folder);
  const name = safeName(title) || safeName(new URL(url).pathname.split('/').pop()) || 'link';
  const dest = inRoot(root, path.join(dir, `${name}.url`));
  fs.mkdirSync(dir, { recursive: true });
  const body = `[InternetShortcut]\nURL=${url}\nTitle=${clean(title)}\nTags=${splitTags(clean(tags)).join(',')}\n`;
  fs.writeFileSync(dest, body, { flag: 'wx' }); // never overwrite an existing name
  return dest;
}

/**
 * Replaces the tag matching the regex, or else inserts it right after `<head>` (or at the start if there is none).
 * @param {string} html
 * @param {RegExp} re
 * @param {string} tag tag string to insert
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
 * Writes the title and tags back to the file, and moves it if the folder changed.
 * @param {string} root
 * @param {string} p target file
 * @param {{ title?: string, tags?: string, folder?: string }} meta
 * @returns {string} path after the move
 * @throws {Error} if the path is outside root or the destination folder already has that name
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

// ---- Version history: <root>/.history/<relative path>/<time>.html (hidden folder, so scan skips it) ----

/** Max versions kept per file. Oldest are deleted beyond this */
const MAX_VERSIONS = 50;

/**
 * Version folder path for one file.
 * @param {string} root
 * @param {string} p file inside root
 * @returns {string}
 */
const historyDir = (root, p) => path.join(root, '.history', path.relative(root, p));

/**
 * One version.
 * @typedef {object} Version
 * @property {string} path version file path
 * @property {number} time save time (ms)
 * @property {number} size bytes
 */

/**
 * Versions of a file, newest first.
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
 * Saves the current content as a new version. Does nothing if it matches the latest version.
 * @param {string} root
 * @param {string} p HTML file
 * @param {number} [now] version time (ms), for tests
 * @returns {string | null} path of the new version, or null if unchanged
 */
function snapshot(root, p, now = Date.now()) {
  p = inRoot(root, p);
  if (!p.endsWith('.html') || !fs.existsSync(p)) return null;
  const html = fs.readFileSync(p);
  const versions = listHistory(root, p);
  if (versions[0] && html.equals(fs.readFileSync(versions[0].path))) return null;
  const dir = historyDir(root, p);
  fs.mkdirSync(dir, { recursive: true });
  // Use a time after the latest so two saves in the same millisecond don't overwrite each other
  const time = Math.max(now, (versions[0]?.time ?? 0) + 1);
  const dest = path.join(dir, `${time}.html`);
  fs.writeFileSync(dest, html);
  for (const old of versions.slice(MAX_VERSIONS - 1)) fs.rmSync(old.path);
  return dest;
}

/**
 * Restores a version. The content just before restoring is also saved as a version, so a restore can itself be undone.
 * @param {string} root
 * @param {string} p target file
 * @param {string} version version path returned by {@link listHistory}
 * @returns {string} target file path
 * @throws {Error} if it is not a version of that file
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
 * When a file moves, its version history moves with it.
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
