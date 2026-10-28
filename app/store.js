/**
 * @file Pure functions that read and write the root folder (~/artifacts). No Electron dependency, so tests,
 * the save script, and the publish hook all call them directly.
 * The folder is the database: subfolders are the primary grouping, tags (`<meta name="tags">` or `Tags=` in `.url`) the secondary.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

/** Root folder when `ARTIFACTS_ROOT` is not set */
const DEFAULT_ROOT = path.join(os.homedir(), 'artifacts');

/**
 * One list item. Maps to a single file (.html or .url).
 * @typedef {object} Item
 * @property {string} path absolute path
 * @property {string} folder folder relative to root ('' at the root)
 * @property {string} name file name without extension
 * @property {string} title title (name if missing)
 * @property {string[]} tags
 * @property {number} modifiedAt modification time (ms)
 * @property {'file' | 'link'} kind
 * @property {string} [url] URL, for links
 * @property {string} searchText body text for full-text search ('' for links)
 */

/**
 * One saved version of a file.
 * @typedef {object} Version
 * @property {string} path version file path
 * @property {number} time save time (ms)
 * @property {number} size bytes
 */

// ---- Text helpers ----

/**
 * Replaces newlines with spaces and trims.
 * @param {unknown} value
 * @returns {string}
 */
const toSingleLine = value => String(value || '').replace(/[\r\n]/g, ' ').trim();

/**
 * Replaces characters not allowed in file names with `-` and truncates to 80 characters.
 * Strips leading dots so the file isn't hidden.
 * @param {unknown} value
 * @returns {string}
 */
const toSafeFileName = value => toSingleLine(value).replace(/[\/\\:*?"<>|]/g, '-').replace(/^\.+/, '').slice(0, 80);

/**
 * Splits a comma-separated tag string into an array. Drops empty entries.
 * @param {string | undefined} tagText
 * @returns {string[]}
 */
const splitTags = tagText => (tagText || '').split(',').map(tag => tag.trim()).filter(Boolean);

/**
 * Normalizes user-entered tags to the stored `a,b,c` form.
 * @param {unknown} tagText
 * @returns {string}
 */
const normalizeTags = tagText => splitTags(toSingleLine(tagText)).join(',');

/**
 * Escapes `&`, `<`, and `"` for use in HTML attributes and text.
 * @param {string} text
 * @returns {string}
 */
const escapeHtml = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

/**
 * Inverse of {@link escapeHtml}. Decodes only common entities.
 * @param {string} text
 * @returns {string}
 */
const unescapeHtml = text => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

/**
 * Whether the value is an https URL. Links are only stored and opened over https.
 * @param {unknown} value
 * @returns {boolean}
 */
const isHttpsUrl = value => /^https:\/\//.test(String(value || ''));

// ---- Paths ----

/**
 * Resolves a path and rejects anything outside root. Paths from the renderer or the command line are untrusted.
 * @param {string} root
 * @param {string} filePath
 * @returns {string} normalized absolute path
 * @throws {Error} if the path is outside root
 */
function resolveInsideRoot(root, filePath) {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(root) + path.sep)) throw new Error(`Path is outside the root: ${filePath}`);
  return resolved;
}

/**
 * Splits an `a/b` folder name into safe segments and builds an absolute path under root.
 * `..` segments become empty and are dropped, so the result never leaves root.
 * @param {string} root
 * @param {string} folder
 * @returns {string}
 */
function folderPath(root, folder) {
  const segments = toSingleLine(folder).split('/').map(toSafeFileName).filter(Boolean);
  return path.join(root, ...segments);
}

/**
 * Writes a new file without overwriting: `name.ext`, then `name-2.ext`, `name-3.ext`, and so on.
 * @param {string} directory
 * @param {string} baseName file name without extension
 * @param {string} extension including the dot, e.g. `.html`
 * @param {string | Buffer} content
 * @returns {string} path of the written file
 * @throws {Error} if 99 names are already taken
 */
function writeWithoutOverwrite(directory, baseName, extension, content) {
  fs.mkdirSync(directory, { recursive: true });
  for (let attempt = 1; attempt < 100; attempt++) {
    const destination = path.join(directory, `${attempt === 1 ? baseName : `${baseName}-${attempt}`}${extension}`);
    try {
      fs.writeFileSync(destination, content, { flag: 'wx' });
      return destination;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  throw new Error(`Too many files named ${baseName}${extension}`);
}

// ---- File formats ----

const TITLE_PATTERN = /<title[^>]*>([\s\S]*?)<\/title>/i;
const TAGS_PATTERN = /<meta\s+name=["']tags["']\s+content=["']([^"']*)["'][^>]*>/i;

/** Max length (characters) of the search text kept per file, so large files don't make list refreshes heavy */
const MAX_SEARCH_TEXT_LENGTH = 100_000;

/**
 * Replaces the tag matching the pattern, or else inserts it right after `<head>` (or at the start if there is none).
 * @param {string} html
 * @param {RegExp} pattern
 * @param {string} tag tag markup to insert
 * @returns {string}
 */
function upsertTag(html, pattern, tag) {
  if (pattern.test(html)) return html.replace(pattern, () => tag);
  const head = html.match(/<head[^>]*>/i);
  if (!head) return `${tag}\n${html}`;
  const insertAt = head.index + head[0].length;
  return `${html.slice(0, insertAt)}\n${tag}${html.slice(insertAt)}`;
}

/**
 * Whether an HTML document already has a `<title>`.
 * @param {string} html
 * @returns {boolean}
 */
const hasTitle = html => TITLE_PATTERN.test(html);

/**
 * Sets the `<title>` of an HTML document.
 * @param {string} html
 * @param {string} title
 * @returns {string}
 */
const withTitle = (html, title) => upsertTag(html, TITLE_PATTERN, `<title>${escapeHtml(toSingleLine(title))}</title>`);

/**
 * Sets the `<meta name="tags">` of an HTML document.
 * @param {string} html
 * @param {string} tags comma-separated
 * @returns {string}
 */
const withTags = (html, tags) => upsertTag(html, TAGS_PATTERN, `<meta name="tags" content="${escapeHtml(normalizeTags(tags))}">`);

/**
 * Builds the text used for full-text search: strips script/style and tags and collapses whitespace.
 * @param {string} html
 * @returns {string} at most {@link MAX_SEARCH_TEXT_LENGTH} characters
 */
function extractSearchText(html) {
  const withoutMarkup = html.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');
  return unescapeHtml(withoutMarkup).replace(/\s+/g, ' ').trim().slice(0, MAX_SEARCH_TEXT_LENGTH);
}

/**
 * Reads the title and tags (from the first 8KB) and the search text of an HTML file.
 * @param {string} filePath
 * @returns {{ title?: string, tags: string[], searchText: string }}
 */
function readHtml(filePath) {
  const html = fs.readFileSync(filePath, 'utf8');
  const head = html.slice(0, 8192);
  const title = head.match(TITLE_PATTERN)?.[1].trim();
  const tags = head.match(TAGS_PATTERN)?.[1];
  return { title: title && unescapeHtml(title), tags: splitTags(tags && unescapeHtml(tags)), searchText: extractSearchText(html) };
}

/**
 * Builds the content of a `.url` bookmark (`[InternetShortcut]` format, readable by Finder).
 * @param {{ url: string, title?: string, tags?: string }} link
 * @returns {string}
 */
const linkFileContent = ({ url, title, tags }) => `[InternetShortcut]\nURL=${url}\nTitle=${toSingleLine(title)}\nTags=${normalizeTags(tags)}\n`;

/**
 * Reads only the `key=value` lines of a `.url` file.
 * @param {string} filePath
 * @returns {{ url?: string, title?: string, tags: string[] }}
 */
function readLink(filePath) {
  const fields = {};
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const field = line.match(/^(\w+)=(.*)$/);
    if (field) fields[field[1]] = field[2].trim();
  }
  return { url: fields.URL, title: fields.Title, tags: splitTags(fields.Tags) };
}

// ---- Library ----

/**
 * Lists every `.html` and `.url` under root, most recently modified first. Skips hidden folders and node_modules.
 * ponytail: full scan every time (bodies included); add a modification-time cache if thousands of files make it slow
 * @param {string} root
 * @returns {Item[]}
 */
function scan(root) {
  const items = [];
  for (const relativePath of fs.readdirSync(root, { recursive: true })) {
    if (relativePath.split(path.sep).some(segment => segment.startsWith('.') || segment === 'node_modules')) continue;
    const extension = path.extname(relativePath).toLowerCase();
    if (extension !== '.html' && extension !== '.url') continue;
    const absolutePath = path.join(root, relativePath);
    const stats = fs.statSync(absolutePath);
    if (!stats.isFile()) continue;
    const isLink = extension === '.url';
    const content = isLink ? readLink(absolutePath) : readHtml(absolutePath);
    const name = path.basename(relativePath, extension);
    items.push({
      path: absolutePath,
      folder: path.dirname(relativePath) === '.' ? '' : path.dirname(relativePath),
      name,
      title: content.title || name,
      tags: content.tags,
      modifiedAt: stats.mtimeMs,
      kind: isLink ? 'link' : 'file',
      url: content.url,
      searchText: content.searchText || '',
    });
  }
  return items.sort((a, b) => b.modifiedAt - a.modifiedAt);
}

/**
 * Creates a `.url` bookmark. Accepts https only, and fails rather than overwrite an existing name.
 * @param {string} root
 * @param {{ url: string, title?: string, folder?: string, tags?: string }} link
 * @returns {string} path of the created file
 * @throws {Error} if not https or the name already exists
 */
function addLink(root, { url, title, folder, tags }) {
  url = toSingleLine(url);
  if (!isHttpsUrl(url)) throw new Error('Only https:// links can be added');
  const directory = folderPath(root, folder);
  const name = toSafeFileName(title) || toSafeFileName(new URL(url).pathname.split('/').pop()) || 'link';
  const destination = resolveInsideRoot(root, path.join(directory, `${name}.url`));
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(destination, linkFileContent({ url, title, tags }), { flag: 'wx' });
  return destination;
}

/**
 * Writes the title and tags back into the file, and moves it if the folder changed.
 * @param {string} root
 * @param {string} filePath target file
 * @param {{ title?: string, tags?: string, folder?: string }} changes
 * @returns {string} path after the move
 * @throws {Error} if the path is outside root or the destination folder already has that name
 */
function updateMeta(root, filePath, { title, tags, folder }) {
  filePath = resolveInsideRoot(root, filePath);
  const directory = folderPath(root, folder);
  const destination = resolveInsideRoot(root, path.join(directory, path.basename(filePath)));
  if (destination !== filePath && fs.existsSync(destination)) throw new Error(`A file with the same name already exists: ${destination}`);

  if (filePath.endsWith('.url')) {
    const otherLines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(line => line && !/^(Title|Tags)=/.test(line));
    fs.writeFileSync(filePath, [...otherLines, `Title=${toSingleLine(title)}`, `Tags=${normalizeTags(tags)}`, ''].join('\n'));
  } else {
    fs.writeFileSync(filePath, withTags(withTitle(fs.readFileSync(filePath, 'utf8'), title), tags));
  }

  if (destination !== filePath) {
    fs.mkdirSync(directory, { recursive: true });
    fs.renameSync(filePath, destination);
    moveHistory(root, filePath, destination);
  }
  return destination;
}

// ---- Version history: <root>/.history/<relative path>/<time>.html (a hidden folder, so scan skips it) ----

/** Max versions kept per file. The oldest are deleted beyond this */
const MAX_VERSIONS = 50;

/**
 * Version folder of one file.
 * @param {string} root
 * @param {string} filePath file inside root
 * @returns {string}
 */
const historyDirectory = (root, filePath) => path.join(root, '.history', path.relative(root, filePath));

/**
 * Versions of a file, newest first.
 * @param {string} root
 * @param {string} filePath
 * @returns {Version[]}
 */
function listVersions(root, filePath) {
  const directory = historyDirectory(root, resolveInsideRoot(root, filePath));
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter(fileName => /^\d+\.html$/.test(fileName))
    .map(fileName => {
      const versionPath = path.join(directory, fileName);
      return { path: versionPath, time: Number(path.basename(fileName, '.html')), size: fs.statSync(versionPath).size };
    })
    .sort((a, b) => b.time - a.time);
}

/**
 * Saves the current content as a new version. Does nothing if it matches the latest version.
 * @param {string} root
 * @param {string} filePath HTML file
 * @param {number} [now] version time (ms), for tests
 * @returns {string | null} path of the new version, or null if unchanged
 */
function saveVersion(root, filePath, now = Date.now()) {
  filePath = resolveInsideRoot(root, filePath);
  if (!filePath.endsWith('.html') || !fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath);
  const versions = listVersions(root, filePath);
  const latest = versions[0];
  if (latest && content.equals(fs.readFileSync(latest.path))) return null;
  const directory = historyDirectory(root, filePath);
  fs.mkdirSync(directory, { recursive: true });
  // Use a time after the latest so two saves in the same millisecond don't overwrite each other
  const time = Math.max(now, (latest?.time ?? 0) + 1);
  const destination = path.join(directory, `${time}.html`);
  fs.writeFileSync(destination, content);
  for (const expired of versions.slice(MAX_VERSIONS - 1)) fs.rmSync(expired.path);
  return destination;
}

/**
 * Restores a version. The content just before restoring is saved as a version too, so a restore can itself be undone.
 * @param {string} root
 * @param {string} filePath target file
 * @param {string} versionPath a path returned by {@link listVersions}
 * @returns {string} target file path
 * @throws {Error} if it is not a version of that file
 */
function restoreVersion(root, filePath, versionPath) {
  filePath = resolveInsideRoot(root, filePath);
  versionPath = resolveInsideRoot(root, versionPath);
  if (path.dirname(versionPath) !== historyDirectory(root, filePath)) throw new Error(`Not a version of this file: ${versionPath}`);
  saveVersion(root, filePath);
  fs.copyFileSync(versionPath, filePath);
  return filePath;
}

/**
 * Moves a file's version history along with the file.
 * @param {string} root
 * @param {string} fromPath
 * @param {string} toPath
 */
function moveHistory(root, fromPath, toPath) {
  const source = historyDirectory(root, fromPath);
  if (!fs.existsSync(source)) return;
  const destination = historyDirectory(root, toPath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.renameSync(source, destination);
}

module.exports = {
  DEFAULT_ROOT,
  toSingleLine,
  toSafeFileName,
  isHttpsUrl,
  resolveInsideRoot,
  folderPath,
  writeWithoutOverwrite,
  hasTitle,
  withTitle,
  withTags,
  extractSearchText,
  readHtml,
  linkFileContent,
  readLink,
  scan,
  addLink,
  updateMeta,
  listVersions,
  saveVersion,
  restoreVersion,
};
