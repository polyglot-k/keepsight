/**
 * @file 크롬(macOS)의 claude.ai 쿠키를 읽어 복호화한다. 다른 도메인 쿠키는 읽지 않는다.
 * 형식: encrypted_value = 'v10' + AES-128-CBC(key = PBKDF2(키체인 "Chrome Safe Storage", 'saltysalt', 1003, sha1), iv = 공백 16개)
 *       meta.version >= 24 이면 평문 앞 32바이트는 도메인 해시라 잘라낸다.
 * ponytail: v10(macOS)만 지원. 크롬이 형식을 바꾸면 여기만 고치면 된다
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile, execFileSync } = require('child_process');

const CHROME_DIR = path.join(os.homedir(), 'Library/Application Support/Google/Chrome');
const HOST_SQL = "host_key = 'claude.ai' OR host_key LIKE '%.claude.ai'";

/**
 * 시스템 sqlite3로 쿼리를 실행해 JSON 행 배열을 돌려준다.
 * @param {string} db
 * @param {string} sql
 * @returns {Record<string, any>[]}
 */
function sqlite(db, sql) {
  const out = execFileSync('/usr/bin/sqlite3', ['-json', db, sql], { encoding: 'utf8' });
  return out.trim() ? JSON.parse(out) : [];
}

/**
 * 크롬이 켜져 있으면 DB가 잠겨 있을 수 있어 임시 사본을 만들어 읽고, 끝나면 지운다.
 * @template T
 * @param {string} profileDir
 * @param {(db: string) => T} fn
 * @returns {T}
 */
function withCopy(profileDir, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-cookies-'));
  try {
    const db = path.join(tmp, 'Cookies');
    fs.copyFileSync(path.join(profileDir, 'Cookies'), db);
    return fn(db);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * claude.ai 쿠키가 가장 많은 크롬 프로필을 고른다.
 * @returns {{ dir: string, name?: string, email?: string, n: number }}
 * @throws {Error} claude.ai에 로그인된 프로필이 없을 때
 */
function pickProfile() {
  const info = JSON.parse(fs.readFileSync(path.join(CHROME_DIR, 'Local State'), 'utf8')).profile.info_cache;
  let best = null;
  for (const [dir, meta] of Object.entries(info)) {
    const full = path.join(CHROME_DIR, dir);
    if (!fs.existsSync(path.join(full, 'Cookies'))) continue;
    const n = withCopy(full, db => sqlite(db, `SELECT count(*) n FROM cookies WHERE ${HOST_SQL}`)[0].n);
    if (n && (!best || n > best.n)) best = { dir: full, name: meta.name, email: meta.user_name, n };
  }
  if (!best) throw new Error('No Chrome profile is signed in to claude.ai');
  return best;
}

/**
 * 키체인에서 "Chrome Safe Storage" 비밀번호를 읽는다. 허용 창이 뜰 수 있어 비동기로 기다린다.
 * @returns {Promise<string>}
 */
const keychainPassword = () => new Promise((resolve, reject) =>
  execFile('security', ['find-generic-password', '-w', '-s', 'Chrome Safe Storage'], (err, out) =>
    err ? reject(new Error('Could not read "Chrome Safe Storage" from the Keychain (access may have been denied)')) : resolve(out.trim())));

/**
 * 크롬 쿠키 값(v10)을 복호화한다.
 * @param {string} hex encrypted_value의 hex
 * @param {Buffer} key {@link deriveKey}로 만든 키
 * @param {number} metaVersion 쿠키 DB의 meta.version (24 이상이면 앞 32바이트가 도메인 해시)
 * @returns {string}
 * @throws {Error} v10이 아닌 형식일 때
 */
function decrypt(hex, key, metaVersion) {
  const buf = Buffer.from(hex, 'hex');
  if (buf.subarray(0, 3).toString() !== 'v10') throw new Error('Unsupported cookie encryption format');
  const d = crypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '));
  const plain = Buffer.concat([d.update(buf.subarray(3)), d.final()]);
  return (metaVersion >= 24 ? plain.subarray(32) : plain).toString('utf8');
}

/**
 * 키체인 비밀번호로 AES 키를 만든다.
 * @param {string} password
 * @returns {Buffer}
 */
const deriveKey = password => crypto.pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
const SAME_SITE = { '-1': 'unspecified', 0: 'no_restriction', 1: 'lax', 2: 'strict' };

/**
 * 크롬의 claude.ai 쿠키를 읽어 Electron `session.cookies.set()`에 바로 넣을 수 있는 형태로 돌려준다.
 * @returns {Promise<{ profile: { name?: string, email?: string }, cookies: Electron.CookiesSetDetails[] }>}
 */
async function readClaudeCookies() {
  const profile = pickProfile();
  const key = deriveKey(await keychainPassword());
  const cookies = withCopy(profile.dir, db => {
    const metaVersion = Number(sqlite(db, "SELECT value FROM meta WHERE key = 'version'")[0]?.value || 0);
    return sqlite(db, `SELECT host_key, name, path, hex(encrypted_value) ev, expires_utc, is_secure, is_httponly, samesite FROM cookies WHERE ${HOST_SQL}`)
      .map(c => ({
        url: `https://${c.host_key.replace(/^\./, '')}${c.path}`,
        domain: c.host_key.startsWith('.') ? c.host_key : undefined, // 점 없는 host-only 쿠키는 domain을 비워야 유지된다
        name: c.name,
        value: decrypt(c.ev, key, metaVersion),
        path: c.path,
        secure: !!c.is_secure,
        httpOnly: !!c.is_httponly,
        sameSite: SAME_SITE[c.samesite] || 'unspecified',
        // 크롬은 1601-01-01 기준 마이크로초, 0이면 세션 쿠키
        expirationDate: c.expires_utc > 0 ? c.expires_utc / 1e6 - 11644473600 : undefined,
      }));
  });
  return { profile: { name: profile.name, email: profile.email }, cookies };
}

module.exports = { readClaudeCookies, decrypt, deriveKey };
