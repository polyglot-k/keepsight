#!/usr/bin/env node
/**
 * @file Claude Code PostToolUse (Artifact) hook: records each published claude.ai Artifact as a `.url` bookmark
 * in ~/artifacts/claude/, so it shows up in KeepSight right away.
 */
const fs = require('fs');
const path = require('path');
const store = require('../app/store');

const ROOT = process.env.ARTIFACTS_ROOT || store.DEFAULT_ROOT;
const ARTIFACT_URL_PATTERN = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9_-]+/;

/**
 * URLs already bookmarked anywhere under root. A URL found here means a redeploy, so it is skipped.
 * @param {string} root
 * @returns {Set<string>}
 */
function bookmarkedUrls(root) {
  const urls = new Set();
  for (const relativePath of fs.readdirSync(root, { recursive: true })) {
    if (!relativePath.endsWith('.url')) continue;
    const { url } = store.readLink(path.join(root, relativePath));
    if (url) urls.add(url);
  }
  return urls;
}

/**
 * Artifact title. If the tool input has no title, reads `<title>` from the published HTML file.
 * @param {{ title?: string, file_path?: string }} toolInput Artifact tool input
 * @param {string} [workingDirectory] base folder for a relative `file_path`
 * @returns {string} empty string if not found
 */
function artifactTitle(toolInput, workingDirectory) {
  if (toolInput.title) return store.toSingleLine(toolInput.title);
  if (!toolInput.file_path) return '';
  try {
    return store.readHtml(path.resolve(workingDirectory || '.', toolInput.file_path)).title || '';
  } catch {
    return '';
  }
}

/**
 * Records the published claude.ai Artifact URL as `claude/<title>.url`. Skips already-bookmarked URLs and non-publish calls.
 * @param {{ tool_input?: Record<string, any>, tool_response?: unknown, cwd?: string }} hookEvent hook input (JSON)
 */
function recordPublishedArtifact(hookEvent) {
  const toolInput = hookEvent.tool_input || {};
  if ((toolInput.action || 'publish') !== 'publish' || toolInput.asset) return;
  const url = JSON.stringify(hookEvent.tool_response ?? '').match(ARTIFACT_URL_PATTERN)?.[0];
  if (!url) return;

  fs.mkdirSync(ROOT, { recursive: true });
  if (bookmarkedUrls(ROOT).has(url)) return;

  const title = artifactTitle(toolInput, hookEvent.cwd) || url.split('/').pop();
  const baseName = store.toSafeFileName(title) || 'artifact';
  store.writeWithoutOverwrite(path.join(ROOT, 'claude'), baseName, '.url', store.linkFileContent({ url, title }));
}

let standardInput = '';
process.stdin.on('data', chunk => (standardInput += chunk)).on('end', () => {
  // A hook failure must not block Claude's work, so errors go to stderr only and the exit code stays 0
  try {
    recordPublishedArtifact(JSON.parse(standardInput));
  } catch (error) {
    console.error(`artifact-publish hook: ${error.message}`);
  }
});
