#!/usr/bin/env node
/**
 * @file Saves an HTML file into the KeepSight root (~/artifacts) following its conventions. The source file is left untouched.
 *   node save-html.js <source.html> [--folder study/db] [--tags a,b] [--title title] [--name file-name]
 * - Adds <title> and <meta name="tags"> if missing, or replaces them when given as arguments. The body is left as is.
 * - Never overwrites: if the name exists, appends -2, -3. Prints the saved path to stdout.
 */
const fs = require('fs');
const path = require('path');
const store = require('../../app/store');

/**
 * Collects `--key value` arguments into an object and the remaining arguments into `positional`.
 * @param {string[]} argumentList
 * @returns {{ positional: string[], [option: string]: any }}
 */
function parseArguments(argumentList) {
  const parsed = { positional: [] };
  for (let index = 0; index < argumentList.length; index++) {
    const argument = argumentList[index];
    if (argument.startsWith('--')) parsed[argument.slice(2)] = argumentList[++index] ?? '';
    else parsed.positional.push(argument);
  }
  return parsed;
}

/**
 * Saves the HTML under root following the conventions. Leaves the source untouched and appends `-2`, `-3` if the name exists.
 * @param {string} sourcePath source HTML
 * @param {{ folder?: string, tags?: string, title?: string, name?: string, root?: string }} [options]
 * @returns {string} the saved path
 * @throws {Error} if there are too many files with the same name
 */
function save(sourcePath, { folder = '', tags, title, name, root = process.env.ARTIFACTS_ROOT || store.DEFAULT_ROOT } = {}) {
  const fileName = path.basename(sourcePath, path.extname(sourcePath));
  let html = fs.readFileSync(sourcePath, 'utf8');
  if (title != null) html = store.withTitle(html, title);
  else if (!store.hasTitle(html)) html = store.withTitle(html, fileName);
  if (tags != null) html = store.withTags(html, tags);
  const baseName = store.toSafeFileName(name || fileName) || 'artifact';
  return store.writeWithoutOverwrite(store.folderPath(root, folder), baseName, '.html', html);
}

if (require.main === module) {
  const { positional, ...options } = parseArguments(process.argv.slice(2));
  if (!positional[0]) {
    console.error('usage: save-html.js <source.html> [--folder folder] [--tags a,b] [--title title] [--name file-name]');
    process.exit(2);
  }
  try {
    console.log(save(positional[0], options));
  } catch (error) {
    console.error(`save-html: ${error.message}`);
    process.exit(1);
  }
}

module.exports = { save };
