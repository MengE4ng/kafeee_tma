// Turns every NAME_ENC=h1.… line in .env back into a plain NAME=value line.
// Needs the same key (~/.kafee_secret.key) that encrypted them.
const fs = require('fs');
const path = require('path');
const { decrypt, readKey } = require('../src/secret');

const ENV = path.join(__dirname, '..', '.env');
const key = readKey();
const lines = fs.readFileSync(ENV, 'utf8').split('\n');
const done = [];

const out = lines.map((line) => {
  const m = line.match(/^([A-Z0-9_]+)_ENC=(.*)$/);
  if (m === null) return line;
  const value = decrypt(m[2].trim(), key);
  done.push(m[1]);
  return `${m[1]}=${value}`;
});

fs.writeFileSync(ENV, out.join('\n'), { mode: 0o600 });
console.log(done.length ? `Decrypted: ${done.join(', ')}` : 'Nothing was encrypted.');
