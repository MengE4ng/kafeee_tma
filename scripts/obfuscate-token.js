// Encrypts secrets in .env so the file only contains hieroglyphs.
//
//   node scripts/obfuscate-token.js            → encrypts BOT_TOKEN, WEBAPP_URL, BARISTA_CHAT_ID
//   node scripts/obfuscate-token.js WEBAPP_URL → asks for a NEW value for just that one (e.g. new tunnel URL)
//   node scripts/obfuscate-token.js --all      → encrypts EVERY plain line in .env
//
// The key is saved outside the project in ~/.kafee_secret.key (readable only by you).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { encrypt, decrypt, KEY_FILE } = require('../src/secret');

const ENV = path.join(__dirname, '..', '.env');
const SECRETS = ['BOT_TOKEN', 'WEBAPP_URL', 'BARISTA_CHAT_ID', 'BARISTA_TOPIC_ID', 'PAYWAY_MERCHANT_ID', 'PAYWAY_API_KEY'];
const CHECKS = {
  BOT_TOKEN: [/^\d+:[\w-]{30,}$/, 'That does not look like a bot token.'],
  WEBAPP_URL: [/^https:\/\/\S+$/, 'The URL must start with https://'],
  BARISTA_CHAT_ID: [/^-?\d+$/, 'The chat ID must be a number like -1001234567890'],
  BARISTA_TOPIC_ID: [/^\d+$/, 'The topic ID must be a number like 12'],
  PAYWAY_MERCHANT_ID: [/^[A-Za-z0-9_-]{3,40}$/, 'That does not look like a PayWay merchant ID.'],
  PAYWAY_API_KEY: [/^[A-Za-z0-9]{16,128}$/, 'That does not look like a PayWay API key (the "Public Key" in the PayWay portal).'],
};

function ask(question, hidden) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) rl._writeToOutput = (s) => { if (s.includes(question)) process.stdout.write(s); };
    rl.question(question, (answer) => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(answer.trim()); });
  });
}

const lineRe = (name) => new RegExp(`^${name}=(.*)$`, 'm');
const unquote = (v) => v.trim().replace(/^(['"])(.*)\1$/, '$2');

(async () => {
  if (!fs.existsSync(ENV)) { console.error('No .env file found. Create it first (cp .env.example .env).'); process.exit(1); }
  if (!fs.existsSync(KEY_FILE)) {
    fs.writeFileSync(KEY_FILE, crypto.randomBytes(32).toString('hex') + '\n', { mode: 0o600 });
    console.log(`Created secret key: ${KEY_FILE}`);
  }
  const key = Buffer.from(fs.readFileSync(KEY_FILE, 'utf8').trim(), 'hex');
  let env = fs.readFileSync(ENV, 'utf8');

  const all = process.argv[2] === '--all';
  const only = process.argv[2] && all === false ? process.argv[2].toUpperCase().replace(/_ENC$/, '') : null;
  if (only && SECRETS.includes(only) === false) { console.error(`Choose one of: ${SECRETS.join(', ')} (or --all)`); process.exit(1); }

  // --all: every NAME=value line that has a value and isn't encrypted yet
  const allNames = [...env.matchAll(/^([A-Z][A-Z0-9_]*)=(.+)$/gm)]
    .map((m) => m[1]).filter((n) => n.endsWith('_ENC') === false && unquote(env.match(lineRe(n))[1]).replace(/\s+#.*$/, ''));

  const done = [];
  for (const name of only ? [only] : all ? allNames : SECRETS) {
    const plain = env.match(lineRe(name));
    const hasEnc = lineRe(`${name}_ENC`).test(env);
    let value = plain ? unquote(plain[1].replace(/\s+#.*$/, '')) : ''; // drop "# comments" after values

    const optional = ['BARISTA_TOPIC_ID', 'PAYWAY_MERCHANT_ID', 'PAYWAY_API_KEY'].includes(name);
    if (only || (!value && !hasEnc && optional === false)) {
      const hidden = name === 'BOT_TOKEN' || name === 'PAYWAY_API_KEY';
      value = await ask(`New value for ${name}${hidden ? ' (hidden)' : ''}: `, hidden);
    }
    if (!value) { if (hasEnc) console.log(`${name}: already encrypted, kept.`); continue; }

    const [re, msg] = CHECKS[name] || [/[\s\S]*/, ''];
    if (re.test(value) === false) { console.error(`${name}: ${msg} Nothing changed.`); process.exit(1); }

    const enc = encrypt(value, key);
    if (decrypt(enc, key) !== value) { console.error('Self-check failed, nothing changed.'); process.exit(1); }

    env = env.replace(new RegExp(`^${name}(_ENC)?=.*\\n?`, 'gm'), '');
    env = `${name}_ENC=${enc}\n` + env;
    done.push(name);
  }

  fs.writeFileSync(ENV, env, { mode: 0o600 });
  fs.chmodSync(ENV, 0o600);
  console.log(done.length ? `Done. Encrypted: ${done.join(', ')}` : 'Nothing to change.');
})();
