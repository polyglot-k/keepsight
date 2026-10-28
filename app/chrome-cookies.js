/**
 * @file Reads and decrypts Chrome's (macOS) claude.ai cookies. Cookies for other domains are never read.
 * Format: encrypted_value = 'v10' + AES-128-CBC(key = PBKDF2(Keychain "Chrome Safe Storage", 'saltysalt', 1003, sha1), iv = 16 spaces)
 *       If meta.version >= 24, the first 32 bytes of plaintext are a domain hash and are stripped.
 * ponytail: only v10 (macOS) is supported. If Chrome changes the format, only this file needs fixing
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile, execFileSync } = require('child_process');

const CHROME_DIR = path.join(os.homedir(), 'Library/Application Support/Google/Chrome');
const HOST_SQL = "host_key = 'claude.ai' OR host_key LIKE '%.claude.ai'";

/**
 * Runs a query with the system sqlite3 and returns an array of JSON rows.
 * @param {string} db
 * @param {string} sql
 * @returns {Record<string, any>[]}
 */
function sqlite(db, sql) {
  const out = execFileSync('/usr/bin/sqlite3', ['-json', db, sql], { encoding: 'utf8' });
  return out.trim() ? JSON.parse(out) : [];
}

/**
 * The DB may be locked while Chrome is running, so read a temporary copy and delete it afterwards.
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
 * Picks the Chrome profile with the most claude.ai cookies.
 * @returns {{ dir: string, name?: string, email?: string, n: number }}
 * @throws {Error} if no profile is logged in to claude.ai
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
 * Reads the "Chrome Safe Storage" password from the Keychain. Waits asynchronously because a permission prompt may appear.
 * @returns {Promise<string>}
 */
const keychainPassword = () => new Promise((resolve, reject) =>
  execFile('security', ['find-generic-password', '-w', '-s', 'Chrome Safe Storage'], (err, out) =>
    err ? reject(new Error('Could not read "Chrome Safe Storage" from the Keychain (access may have been denied)')) : resolve(out.trim())));

/**
 * Decrypts a Chrome cookie value (v10).
 * @param {string} hex hex of encrypted_value
 * @param {Buffer} key key from {@link deriveKey}
 * @param {number} metaVersion meta.version of the cookie DB (at 24 or above, the first 32 bytes are a domain hash)
 * @returns {string}
 * @throws {Error} if the format is not v10
 */
function decrypt(hex, key, metaVersion) {
  const buf = Buffer.from(hex, 'hex');
  if (buf.subarray(0, 3).toString() !== 'v10') throw new Error('Unsupported cookie encryption format');
  const d = crypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '));
  const plain = Buffer.concat([d.update(buf.subarray(3)), d.final()]);
  return (metaVersion >= 24 ? plain.subarray(32) : plain).toString('utf8');
}

/**
 * Derives the AES key from the Keychain password.
 * @param {string} password
 * @returns {Buffer}
 */
const deriveKey = password => crypto.pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
const SAME_SITE = { '-1': 'unspecified', 0: 'no_restriction', 1: 'lax', 2: 'strict' };

/**
 * Reads Chrome's claude.ai cookies and returns them in a shape ready for Electron `session.cookies.set()`.
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
        domain: c.host_key.startsWith('.') ? c.host_key : undefined, // host-only cookies (no leading dot) stay host-only only if domain is left unset
        name: c.name,
        value: decrypt(c.ev, key, metaVersion),
        path: c.path,
        secure: !!c.is_secure,
        httpOnly: !!c.is_httponly,
        sameSite: SAME_SITE[c.samesite] || 'unspecified',
        // Chrome uses microseconds since 1601-01-01; 0 means a session cookie
        expirationDate: c.expires_utc > 0 ? c.expires_utc / 1e6 - 11644473600 : undefined,
      }));
  });
  return { profile: { name: profile.name, email: profile.email }, cookies };
}

module.exports = { readClaudeCookies, decrypt, deriveKey };
