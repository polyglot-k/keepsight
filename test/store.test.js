const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scan, addLink, updateMeta } = require('../app/store');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'artifacts-'));
const p = rel => path.join(root, rel);
const write = (rel, body) => {
  fs.mkdirSync(path.dirname(p(rel)), { recursive: true });
  fs.writeFileSync(p(rel), body);
};
const byName = () => Object.fromEntries(scan(root).map(i => [i.name, i]));

// ---- scan ----
write('study/db.html', '<html><head><title>Index 정리</title><meta name="tags" content="db, mysql"></head><body>본문</body></html>');
write('plain.html', '<p>no head</p>');
write('work/claude.url', '[InternetShortcut]\nURL=https://claude.ai/artifact/abc\nTitle=대시보드\nTags=work\n');
write('.hidden/x.html', '<title>skip</title>');
write('notes.md', '# skip');

let by = byName();
assert.deepStrictEqual(Object.keys(by).sort(), ['claude', 'db', 'plain']);
assert.strictEqual(by.db.title, 'Index 정리');
assert.deepStrictEqual(by.db.tags, ['db', 'mysql']);
assert.strictEqual(by.db.folder, 'study');
assert.strictEqual(by.plain.title, 'plain');
assert.strictEqual(by.plain.folder, '');
assert.strictEqual(by.claude.kind, 'link');
assert.strictEqual(by.claude.url, 'https://claude.ai/artifact/abc');
assert.strictEqual(by.db.text, 'Index 정리 본문');
assert.strictEqual(by.claude.text, '');

// ---- bodyText: skip script/style, strip tags, decode entities ----
const { bodyText } = require('../app/store');
assert.strictEqual(bodyText('<style>.a{}</style><script>var x="<b>"</script><p>SELECT *\n  FROM&nbsp;t &amp; u</p>'), 'SELECT * FROM t & u');

// ---- updateMeta: html replace + escape round trip + folder move ----
let dest = updateMeta(root, p('study/db.html'), { title: 'A & <B> "C"', tags: 'db, , innodb', folder: 'study/mysql' });
assert.strictEqual(dest, p('study/mysql/db.html'));
assert.ok(!fs.existsSync(p('study/db.html')));
by = byName();
assert.strictEqual(by.db.title, 'A & <B> "C"');
assert.deepStrictEqual(by.db.tags, ['db', 'innodb']);
assert.strictEqual(by.db.folder, 'study/mysql');
assert.ok(fs.readFileSync(dest, 'utf8').includes('<body>본문</body>'), 'body is untouched');

// html without <head> gets the tags prepended
updateMeta(root, p('plain.html'), { title: '새 제목', tags: 'x', folder: '' });
by = byName();
assert.strictEqual(by.plain.title, '새 제목');
assert.deepStrictEqual(by.plain.tags, ['x']);
assert.ok(fs.readFileSync(p('plain.html'), 'utf8').endsWith('<p>no head</p>'));

// .url keeps its URL
updateMeta(root, p('work/claude.url'), { title: '대시보드 v2', tags: 'work,kpi', folder: 'work' });
by = byName();
assert.strictEqual(by.claude.url, 'https://claude.ai/artifact/abc');
assert.strictEqual(by.claude.title, '대시보드 v2');
assert.deepStrictEqual(by.claude.tags, ['work', 'kpi']);

// ---- edge cases: outside root, name collision, non-https ----
assert.throws(() => updateMeta(root, '/etc/hosts', { title: 'x', tags: '', folder: '' }), /outside the root/);
// '..' segments are dropped, so it cannot escape root
dest = updateMeta(root, p('plain.html'), { title: 'x', tags: '', folder: '../../tmp' });
assert.strictEqual(dest, p('tmp/plain.html'));
dest = updateMeta(root, dest, { title: 'x', tags: '', folder: '' });
write('dup/plain.html', '');
assert.throws(() => updateMeta(root, p('plain.html'), { title: 'x', tags: '', folder: 'dup' }), /same name/);
assert.throws(() => addLink(root, { url: 'http://x.com', title: 't' }), /https/);
assert.strictEqual(addLink(root, { url: 'https://x.com/a', title: '../../evil', folder: '../..' }), p('-..-evil.url'));

// ---- Chrome cookie decryption: a value encrypted the same way round-trips ----
const crypto = require('crypto');
const { decrypt, deriveKey } = require('../app/chrome-cookies');
const key = deriveKey('test-password');
const enc = (plain, hashPrefix) => {
  const c = crypto.createCipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '));
  const body = Buffer.concat([hashPrefix ? crypto.randomBytes(32) : Buffer.alloc(0), Buffer.from(plain)]);
  return Buffer.concat([Buffer.from('v10'), c.update(body), c.final()]).toString('hex');
};
assert.strictEqual(decrypt(enc('sk-session-값', true), key, 24), 'sk-session-값');
assert.strictEqual(decrypt(enc('old-format', false), key, 23), 'old-format');
assert.throws(() => decrypt(Buffer.from('v11xxxx').toString('hex'), key, 24), /Unsupported/);

// ---- save-html (skill script): fill meta + never overwrite ----
process.env.ARTIFACTS_ROOT = root;
delete require.cache[require.resolve('../skills/keepsight-save/save-html')];
const { save } = require('../skills/keepsight-save/save-html');
write('src/report.html', '<html><head><meta charset="utf-8"></head><body>본문</body></html>');
const s1 = save(p('src/report.html'), { folder: 'work/enable', tags: 'enable-3444, db', title: 'A & B' });
const s2 = save(p('src/report.html'), { folder: 'work/enable' });
assert.strictEqual(s1, p('work/enable/report.html'));
assert.strictEqual(s2, p('work/enable/report-2.html'));
by = Object.fromEntries(scan(root).map(i => [path.relative(root, i.path), i]));
assert.strictEqual(by['work/enable/report.html'].title, 'A & B');
assert.deepStrictEqual(by['work/enable/report.html'].tags, ['enable-3444', 'db']);
assert.strictEqual(by['work/enable/report-2.html'].title, 'report', 'no title falls back to file name');
assert.ok(fs.readFileSync(s1, 'utf8').includes('<body>본문</body>'));
assert.strictEqual(save(p('src/report.html'), { folder: '../../x' }), p('x/report.html'));

// ---- version history: skip identical content, restore (keeps the prior content), follow moves, cap count ----
const { snapshot, listHistory, restore } = require('../app/store');
write('h/doc.html', 'v1');
assert.ok(snapshot(root, p('h/doc.html'), 1000));
assert.strictEqual(snapshot(root, p('h/doc.html'), 2000), null, 'no new version when content is unchanged');
write('h/doc.html', 'v2');
snapshot(root, p('h/doc.html'), 3000);
assert.deepStrictEqual(listHistory(root, p('h/doc.html')).map(v => v.time), [3000, 1000]);
assert.ok(!scan(root).some(i => i.path.includes('.history')), 'version files are not listed');

const v1 = listHistory(root, p('h/doc.html'))[1].path;
write('h/doc.html', 'v3-unsaved');
restore(root, p('h/doc.html'), v1);
assert.strictEqual(fs.readFileSync(p('h/doc.html'), 'utf8'), 'v1');
assert.strictEqual(fs.readFileSync(listHistory(root, p('h/doc.html'))[0].path, 'utf8'), 'v3-unsaved', 'content before restore is kept');
assert.throws(() => restore(root, p('h/doc.html'), p('plain.html')), /Not a version/);

const moved = updateMeta(root, p('h/doc.html'), { title: 'd', tags: '', folder: 'h2' });
assert.strictEqual(listHistory(root, moved).length, 3, 'history follows the move');

for (let n = 0; n < 60; n++) { write('h/many.html', String(n)); snapshot(root, p('h/many.html'), 10_000 + n); }
assert.strictEqual(listHistory(root, p('h/many.html')).length, 50);
assert.strictEqual(fs.readFileSync(listHistory(root, p('h/many.html'))[0].path, 'utf8'), '59');

fs.rmSync(root, { recursive: true });
console.log('ok');
