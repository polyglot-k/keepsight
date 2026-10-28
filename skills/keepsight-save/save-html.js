#!/usr/bin/env node
/**
 * @file Saves an HTML file into the KeepSight root (~/artifacts) following its conventions. The source file is left untouched.
 *   node save-html.js <src.html> [--folder study/db] [--tags a,b] [--title title] [--name file-name]
 * - Adds <title> and <meta name="tags"> if missing, or replaces them when given as arguments. The body is left as is.
 * - Never overwrites: if the name exists, appends -2, -3. Prints the saved path to stdout.
 * Runs standalone from the plugin folder or the repo, so it does not depend on store.js (keep the format in sync with store.js).
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
 * @returns {string} a file-name-safe string of at most 80 characters
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
 * Replaces the tag matching the regex, or inserts it right after `<head>` (or at the very start if there is no `<head>`).
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
 * Collects `--key value` arguments into an object and the rest into `_`.
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
 * Saves the HTML under root following the conventions. Leaves the source untouched and appends `-2`, `-3` if the name exists.
 * @param {string} src source HTML
 * @param {{ folder?: string, tags?: string, title?: string, name?: string }} [opts]
 * @returns {string} the saved path
 * @throws {Error} if the folder is outside root or there are too many files with the same name
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
