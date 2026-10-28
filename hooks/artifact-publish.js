#!/usr/bin/env node
/**
 * @file Claude Code PostToolUse(Artifact) hook: records each published claude.ai Artifact as a .url in ~/artifacts/claude/ (it shows up in KeepSight right away).
 * Runs standalone from the plugin folder or ~/.claude/hooks/, so it does not depend on store.js (keep the format in sync with store.js).
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
 * @returns {string} a file-name-safe string of at most 80 characters
 */
const safeName = s => clean(s).replace(/[\/\\:*?"<>|]/g, '-').replace(/^\.+/, '').slice(0, 80);

/**
 * URLs already recorded. A URL found here is a redeploy, so it is skipped.
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
 * Artifact title. If the input has no title, reads `<title>` from the published HTML file.
 * @param {{ title?: string, file_path?: string }} input Artifact tool input
 * @param {string} [cwd] base folder for relative paths
 * @returns {string} empty string if not found
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
 * Takes a PostToolUse event and records the published claude.ai Artifact URL as `claude/<title>.url`. Skips already-recorded URLs and non-publish calls.
 * @param {{ tool_input?: Record<string, any>, tool_response?: unknown, cwd?: string }} ev hook input (JSON)
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
  // A hook failure must not block Claude's work, so errors go to stderr only and the exit code stays 0
  try { main(JSON.parse(raw)); } catch (e) { console.error(`artifact-publish hook: ${e.message}`); }
});
