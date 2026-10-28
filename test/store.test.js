const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const store = require('../app/store');
const { decrypt, deriveKey } = require('../app/chrome-cookies');
const { save } = require('../skills/keepsight-save/save-html');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keepsight-test-'));
const pathInRoot = relativePath => path.join(root, relativePath);
const write = (relativePath, content) => {
  fs.mkdirSync(path.dirname(pathInRoot(relativePath)), { recursive: true });
  fs.writeFileSync(pathInRoot(relativePath), content);
};
const itemsByName = () => Object.fromEntries(store.scan(root).map(item => [item.name, item]));
const itemsByRelativePath = () => Object.fromEntries(store.scan(root).map(item => [path.relative(root, item.path), item]));

// ---- scan ----
write('study/db.html', '<html><head><title>Index 정리</title><meta name="tags" content="db, mysql"></head><body>본문</body></html>');
write('plain.html', '<p>no head</p>');
write('work/claude.url', '[InternetShortcut]\nURL=https://claude.ai/artifact/abc\nTitle=대시보드\nTags=work\n');
write('.hidden/x.html', '<title>skip</title>');
write('notes.md', '# skip');

let items = itemsByName();
assert.deepStrictEqual(Object.keys(items).sort(), ['claude', 'db', 'plain']);
assert.strictEqual(items.db.title, 'Index 정리');
assert.deepStrictEqual(items.db.tags, ['db', 'mysql']);
assert.strictEqual(items.db.folder, 'study');
assert.strictEqual(items.plain.title, 'plain');
assert.strictEqual(items.plain.folder, '');
assert.strictEqual(items.claude.kind, 'link');
assert.strictEqual(items.claude.url, 'https://claude.ai/artifact/abc');
assert.strictEqual(items.db.searchText, 'Index 정리 본문');
assert.strictEqual(items.claude.searchText, '');

// ---- extractSearchText: skip script/style, strip tags, decode entities ----
assert.strictEqual(store.extractSearchText('<style>.a{}</style><script>var x="<b>"</script><p>SELECT *\n  FROM&nbsp;t &amp; u</p>'), 'SELECT * FROM t & u');

// ---- updateMeta: html replace + escape round trip + folder move ----
let destination = store.updateMeta(root, pathInRoot('study/db.html'), { title: 'A & <B> "C"', tags: 'db, , innodb', folder: 'study/mysql' });
assert.strictEqual(destination, pathInRoot('study/mysql/db.html'));
assert.ok(!fs.existsSync(pathInRoot('study/db.html')));
items = itemsByName();
assert.strictEqual(items.db.title, 'A & <B> "C"');
assert.deepStrictEqual(items.db.tags, ['db', 'innodb']);
assert.strictEqual(items.db.folder, 'study/mysql');
assert.ok(fs.readFileSync(destination, 'utf8').includes('<body>본문</body>'), 'body is untouched');

// html without <head> gets the tags prepended
store.updateMeta(root, pathInRoot('plain.html'), { title: '새 제목', tags: 'x', folder: '' });
items = itemsByName();
assert.strictEqual(items.plain.title, '새 제목');
assert.deepStrictEqual(items.plain.tags, ['x']);
assert.ok(fs.readFileSync(pathInRoot('plain.html'), 'utf8').endsWith('<p>no head</p>'));

// .url keeps its URL
store.updateMeta(root, pathInRoot('work/claude.url'), { title: '대시보드 v2', tags: 'work,kpi', folder: 'work' });
items = itemsByName();
assert.strictEqual(items.claude.url, 'https://claude.ai/artifact/abc');
assert.strictEqual(items.claude.title, '대시보드 v2');
assert.deepStrictEqual(items.claude.tags, ['work', 'kpi']);

// ---- edge cases: outside root, name collision, non-https ----
assert.throws(() => store.updateMeta(root, '/etc/hosts', { title: 'x', tags: '', folder: '' }), /outside the root/);
// '..' segments are dropped, so it cannot escape root
destination = store.updateMeta(root, pathInRoot('plain.html'), { title: 'x', tags: '', folder: '../../tmp' });
assert.strictEqual(destination, pathInRoot('tmp/plain.html'));
store.updateMeta(root, destination, { title: 'x', tags: '', folder: '' });
write('dup/plain.html', '');
assert.throws(() => store.updateMeta(root, pathInRoot('plain.html'), { title: 'x', tags: '', folder: 'dup' }), /same name/);
assert.throws(() => store.addLink(root, { url: 'http://x.com', title: 't' }), /https/);
assert.strictEqual(store.addLink(root, { url: 'https://x.com/a', title: '../../evil', folder: '../..' }), pathInRoot('-..-evil.url'));

// ---- Chrome cookie decryption: a value encrypted the same way round-trips ----
const key = deriveKey('test-password');
const encryptLikeChrome = (plaintext, withDomainHash) => {
  const cipher = crypto.createCipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '));
  const content = Buffer.concat([withDomainHash ? crypto.randomBytes(32) : Buffer.alloc(0), Buffer.from(plaintext)]);
  return Buffer.concat([Buffer.from('v10'), cipher.update(content), cipher.final()]).toString('hex');
};
assert.strictEqual(decrypt(encryptLikeChrome('sk-session-값', true), key, 24), 'sk-session-값');
assert.strictEqual(decrypt(encryptLikeChrome('old-format', false), key, 23), 'old-format');
assert.throws(() => decrypt(Buffer.from('v11xxxx').toString('hex'), key, 24), /Unsupported/);

// ---- save-html (skill script): fill meta + never overwrite ----
write('src/report.html', '<html><head><meta charset="utf-8"></head><body>본문</body></html>');
const firstSave = save(pathInRoot('src/report.html'), { root, folder: 'work/enable', tags: 'enable-3444, db', title: 'A & B' });
const secondSave = save(pathInRoot('src/report.html'), { root, folder: 'work/enable' });
assert.strictEqual(firstSave, pathInRoot('work/enable/report.html'));
assert.strictEqual(secondSave, pathInRoot('work/enable/report-2.html'));
items = itemsByRelativePath();
assert.strictEqual(items['work/enable/report.html'].title, 'A & B');
assert.deepStrictEqual(items['work/enable/report.html'].tags, ['enable-3444', 'db']);
assert.strictEqual(items['work/enable/report-2.html'].title, 'report', 'no title falls back to file name');
assert.ok(fs.readFileSync(firstSave, 'utf8').includes('<body>본문</body>'));
assert.strictEqual(save(pathInRoot('src/report.html'), { root, folder: '../../x' }), pathInRoot('x/report.html'));

// ---- publish hook: bookmarks a published Artifact once, skips other calls ----
const runHook = hookEvent => execFileSync('node', [path.join(__dirname, '../hooks/artifact-publish.js')], {
  input: JSON.stringify(hookEvent), env: { ...process.env, ARTIFACTS_ROOT: root },
});
const published = { tool_input: { action: 'publish', title: 'Lag Dashboard' }, tool_response: 'Published https://claude.ai/artifact/AbC123 ok' };
runHook(published);
runHook(published);
runHook({ tool_input: { action: 'read' }, tool_response: 'https://claude.ai/artifact/Other' });
const bookmarks = Object.values(itemsByRelativePath()).filter(item => item.folder === 'claude');
assert.deepStrictEqual(bookmarks.map(item => [item.title, item.url]), [['Lag Dashboard', 'https://claude.ai/artifact/AbC123']], 'one bookmark per URL');

// ---- version history: skip identical content, restore (keeps the prior content), follow moves, cap count ----
write('h/doc.html', 'v1');
assert.ok(store.saveVersion(root, pathInRoot('h/doc.html'), 1000));
assert.strictEqual(store.saveVersion(root, pathInRoot('h/doc.html'), 2000), null, 'no new version when content is unchanged');
write('h/doc.html', 'v2');
store.saveVersion(root, pathInRoot('h/doc.html'), 3000);
assert.deepStrictEqual(store.listVersions(root, pathInRoot('h/doc.html')).map(version => version.time), [3000, 1000]);
assert.ok(!store.scan(root).some(item => item.path.includes('.history')), 'version files are not listed');

const firstVersion = store.listVersions(root, pathInRoot('h/doc.html'))[1].path;
write('h/doc.html', 'v3-unsaved');
store.restoreVersion(root, pathInRoot('h/doc.html'), firstVersion);
assert.strictEqual(fs.readFileSync(pathInRoot('h/doc.html'), 'utf8'), 'v1');
assert.strictEqual(fs.readFileSync(store.listVersions(root, pathInRoot('h/doc.html'))[0].path, 'utf8'), 'v3-unsaved', 'content before restore is kept');
assert.throws(() => store.restoreVersion(root, pathInRoot('h/doc.html'), pathInRoot('plain.html')), /Not a version/);

const moved = store.updateMeta(root, pathInRoot('h/doc.html'), { title: 'd', tags: '', folder: 'h2' });
assert.strictEqual(store.listVersions(root, moved).length, 3, 'history follows the move');

for (let count = 0; count < 60; count++) {
  write('h/many.html', String(count));
  store.saveVersion(root, pathInRoot('h/many.html'), 10_000 + count);
}
assert.strictEqual(store.listVersions(root, pathInRoot('h/many.html')).length, 50);
assert.strictEqual(fs.readFileSync(store.listVersions(root, pathInRoot('h/many.html'))[0].path, 'utf8'), '59');

fs.rmSync(root, { recursive: true });
console.log('ok');
