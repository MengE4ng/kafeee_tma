// Decrypts *_ENC values from .env using a key kept OUTSIDE the project folder,
// so .env only ever contains unreadable text.
// The encryption is AES-256-GCM; the "h1." format just writes the encrypted bytes
// as Egyptian hieroglyphs instead of letters (same security, nicer to look at).
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const KEY_FILE = process.env.KAFEE_KEY_FILE || path.join(os.homedir(), '.kafee_secret.key');

// 256 hieroglyphs (U+13000 to U+130FF): one glyph per byte
const GLYPH_BASE = 0x13000;
const toGlyphs = (buf) => Array.from(buf, (b) => String.fromCodePoint(GLYPH_BASE + b)).join('');
const fromGlyphs = (str) => Buffer.from(Array.from(str, (ch) => {
  const b = ch.codePointAt(0) - GLYPH_BASE;
  if (b < 0 || b > 255) throw new Error('Damaged hieroglyph text');
  return b;
}));

// Only your user account should be able to read the key and .env (chmod 600)
function lockDown(file) {
  try {
    if (fs.existsSync(file) && (fs.statSync(file).mode & 0o077)) {
      fs.chmodSync(file, 0o600);
      console.warn(`[security] ${path.basename(file)} was readable by other users; permissions fixed (600).`);
    }
  } catch { /* not supported on this system */ }
}
lockDown(KEY_FILE);
lockDown(path.join(__dirname, '..', '.env'));

function readKey() {
  const hex = process.env.KAFEE_KEY || (fs.existsSync(KEY_FILE) ? fs.readFileSync(KEY_FILE, 'utf8').trim() : '');
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error(`Secret key not found. Expected it in ${KEY_FILE} (run: node scripts/obfuscate-token.js)`);
  return Buffer.from(hex, 'hex');
}

function encrypt(plain, key, style = 'hiero') {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  const raw = Buffer.concat([iv, c.getAuthTag(), data]);
  return style === 'hiero' ? 'h1.' + toGlyphs(raw) : 'v1.' + raw.toString('base64url');
}

function decrypt(enc, key) {
  let buf;
  if (enc.startsWith('h1.')) buf = fromGlyphs(enc.slice(3));
  else if (enc.startsWith('v1.')) buf = Buffer.from(enc.slice(3), 'base64url');
  else throw new Error('Unknown encrypted format');
  const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
}

// Called once at startup: every NAME_ENC in .env is decrypted into NAME, in memory only.
// e.g. BOT_TOKEN_ENC → BOT_TOKEN, WEBAPP_URL_ENC → WEBAPP_URL, BARISTA_CHAT_ID_ENC → BARISTA_CHAT_ID
function loadSecrets() {
  const names = Object.keys(process.env).filter((k) => k.endsWith('_ENC') && process.env[k]);
  if (!names.length) return; // plain values still work
  let key;
  try { key = readKey(); } catch (e) { console.error('Could not decrypt .env:', e.message); process.exit(1); }
  for (const name of names) {
    try {
      process.env[name.slice(0, -4)] = decrypt(process.env[name].trim(), key);
    } catch (e) {
      console.error(`Could not decrypt ${name}: ${e.message}. Re-run: node scripts/obfuscate-token.js ${name.slice(0, -4)}`);
      process.exit(1);
    }
  }
}

module.exports = { loadSecrets, encrypt, decrypt, readKey, KEY_FILE };
