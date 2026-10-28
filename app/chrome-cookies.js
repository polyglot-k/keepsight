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

const CHROME_DATA_DIRECTORY = path.join(os.homedir(), 'Library/Application Support/Google/Chrome');
const CLAUDE_HOST_CONDITION = "host_key = 'claude.ai' OR host_key LIKE '%.claude.ai'";
const SAME_SITE_BY_CHROME_VALUE = { '-1': 'unspecified', 0: 'no_restriction', 1: 'lax', 2: 'strict' };

/**
 * Runs a query with the system sqlite3 and returns the rows as objects.
 * @param {string} databasePath
 * @param {string} query
 * @returns {Record<string, any>[]}
 */
function querySqlite(databasePath, query) {
  const output = execFileSync('/usr/bin/sqlite3', ['-json', databasePath, query], { encoding: 'utf8' });
  return output.trim() ? JSON.parse(output) : [];
}

/**
 * The cookie database may be locked while Chrome is running, so this reads a temporary copy and deletes it afterwards.
 * @template T
 * @param {string} profileDirectory
 * @param {(databasePath: string) => T} readDatabase
 * @returns {T}
 */
function withCookieDatabaseCopy(profileDirectory, readDatabase) {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-cookies-'));
  try {
    const databasePath = path.join(temporaryDirectory, 'Cookies');
    fs.copyFileSync(path.join(profileDirectory, 'Cookies'), databasePath);
    return readDatabase(databasePath);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

/**
 * Picks the Chrome profile with the most claude.ai cookies.
 * @returns {{ directory: string, name?: string, email?: string, cookieCount: number }}
 * @throws {Error} if no profile is signed in to claude.ai
 */
function pickProfile() {
  const profiles = JSON.parse(fs.readFileSync(path.join(CHROME_DATA_DIRECTORY, 'Local State'), 'utf8')).profile.info_cache;
  let best = null;
  for (const [profileName, profileInfo] of Object.entries(profiles)) {
    const directory = path.join(CHROME_DATA_DIRECTORY, profileName);
    if (!fs.existsSync(path.join(directory, 'Cookies'))) continue;
    const cookieCount = withCookieDatabaseCopy(directory, databasePath =>
      querySqlite(databasePath, `SELECT count(*) AS cookie_count FROM cookies WHERE ${CLAUDE_HOST_CONDITION}`)[0].cookie_count);
    if (cookieCount && (!best || cookieCount > best.cookieCount)) {
      best = { directory, name: profileInfo.name, email: profileInfo.user_name, cookieCount };
    }
  }
  if (!best) throw new Error('No Chrome profile is signed in to claude.ai');
  return best;
}

/**
 * Reads the "Chrome Safe Storage" password from the Keychain. Asynchronous because a permission prompt may appear.
 * @returns {Promise<string>}
 */
const readKeychainPassword = () => new Promise((resolve, reject) =>
  execFile('security', ['find-generic-password', '-w', '-s', 'Chrome Safe Storage'], (error, output) =>
    error ? reject(new Error('Could not read "Chrome Safe Storage" from the Keychain (access may have been denied)')) : resolve(output.trim())));

/**
 * Derives the AES key from the Keychain password.
 * @param {string} password
 * @returns {Buffer}
 */
const deriveKey = password => crypto.pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');

/**
 * Decrypts a Chrome cookie value (v10).
 * @param {string} encryptedHex hex of encrypted_value
 * @param {Buffer} key key from {@link deriveKey}
 * @param {number} databaseVersion meta.version of the cookie database (at 24 or above, the first 32 bytes are a domain hash)
 * @returns {string}
 * @throws {Error} if the format is not v10
 */
function decrypt(encryptedHex, key, databaseVersion) {
  const encrypted = Buffer.from(encryptedHex, 'hex');
  if (encrypted.subarray(0, 3).toString() !== 'v10') throw new Error('Unsupported cookie encryption format');
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '));
  const plaintext = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]);
  return (databaseVersion >= 24 ? plaintext.subarray(32) : plaintext).toString('utf8');
}

/**
 * Reads Chrome's claude.ai cookies and returns them in a shape ready for Electron `session.cookies.set()`.
 * @returns {Promise<{ profile: { name?: string, email?: string }, cookies: Electron.CookiesSetDetails[] }>}
 */
async function readClaudeCookies() {
  const profile = pickProfile();
  const key = deriveKey(await readKeychainPassword());
  const cookies = withCookieDatabaseCopy(profile.directory, databasePath => {
    const databaseVersion = Number(querySqlite(databasePath, "SELECT value FROM meta WHERE key = 'version'")[0]?.value || 0);
    const rows = querySqlite(databasePath,
      `SELECT host_key, name, path, hex(encrypted_value) AS encrypted_hex, expires_utc, is_secure, is_httponly, samesite FROM cookies WHERE ${CLAUDE_HOST_CONDITION}`);
    return rows.map(row => ({
      url: `https://${row.host_key.replace(/^\./, '')}${row.path}`,
      domain: row.host_key.startsWith('.') ? row.host_key : undefined, // host-only cookies (no leading dot) stay host-only only if domain is left unset
      name: row.name,
      value: decrypt(row.encrypted_hex, key, databaseVersion),
      path: row.path,
      secure: !!row.is_secure,
      httpOnly: !!row.is_httponly,
      sameSite: SAME_SITE_BY_CHROME_VALUE[row.samesite] || 'unspecified',
      // Chrome uses microseconds since 1601-01-01; 0 means a session cookie
      expirationDate: row.expires_utc > 0 ? row.expires_utc / 1e6 - 11644473600 : undefined,
    }));
  });
  return { profile: { name: profile.name, email: profile.email }, cookies };
}

module.exports = { readClaudeCookies, decrypt, deriveKey };
