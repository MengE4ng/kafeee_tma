const crypto = require('crypto');

// Validates Telegram.WebApp.initData as described in
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
// Returns the Telegram user object, or null if the data is forged/expired.

// Split the query string ourselves: URLSearchParams turns "+" into a space,
// which breaks the signature when a value contains a literal "+".
function parse(initData) {
  const pairs = [];
  for (const part of initData.split('&')) {
    if (!part) continue;
    const i = part.indexOf('=');
    const key = decodeURIComponent(i < 0 ? part : part.slice(0, i));
    const value = i < 0 ? '' : decodeURIComponent(part.slice(i + 1));
    pairs.push([key, value]);
  }
  return pairs;
}

function sign(pairs, secret) {
  const dataCheckString = pairs
    .map(([k, v]) => `${k}=${v}`)
    .sort() // plain byte order, as Telegram does
    .join('\n');
  return crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
}

function sameHex(a, b) {
  const x = Buffer.from(a, 'hex'), y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

// Telegram's public Ed25519 keys for the "signature" field (Bot API 8.0+).
// This check needs only the bot's numeric ID, not the token, so it still works
// if the token was recently revoked.
const TG_PUBLIC_KEYS = [
  'e7bf03a2fa4602af4580703d88dda5bb59f32ed8b02a56c187fe7d34caed242d', // production
  '40055058a4ee38156a06562e52eece92a771bcd8346a8c4615cb7376eddf72ec', // test environment
];
function ed25519Valid(fields, botId, signatureB64url, publicKeysHex = TG_PUBLIC_KEYS) {
  if (!signatureB64url || !botId) return false;
  const data = `${botId}:WebAppData\n` + fields
    .filter(([k]) => k !== 'signature')
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');
  const sig = Buffer.from(signatureB64url.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  return publicKeysHex.some((hex) => {
    try {
      const key = crypto.createPublicKey({
        key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(hex, 'hex')]),
        format: 'der', type: 'spki',
      });
      return crypto.verify(null, Buffer.from(data), key, sig);
    } catch { return false; }
  });
}

function validateInitData(initData, botToken, maxAgeSec = 24 * 3600, publicKeysHex) {
  const fail = (reason) => { console.warn(`[auth] Telegram login rejected: ${reason}`); return null; };
  if (!initData) return fail('no login data. Open the app with the bot’s Order button, not as a link or in a browser.');

  const pairs = parse(initData);
  const hash = pairs.find(([k]) => k === 'hash')?.[1];
  if (!hash) return fail('login data has no signature.');
  const fields = pairs.filter(([k]) => k !== 'hash');

  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken.trim()).digest();

  // Official method first; the other variants only cover client quirks and still need the bot token.
  const variants = {
    official: fields,
    plusAsSpace: [...new URLSearchParams(initData)].filter(([k]) => k !== 'hash'),
    withoutSignature: fields.filter(([k]) => k !== 'signature'),
    // Some desktop clients rebuild the user JSON and drop Telegram's "\/" escaping
    escapedSlashes: fields.map(([k, v]) => [k, k === 'user' ? v.replace(/\\?\//g, '\\/') : v]),
  };
  let matched = Object.entries(variants).find(([, f]) => sameHex(sign(f, secret), hash))?.[0];
  const botId = botToken.trim().split(':')[0];
  if (!matched && ed25519Valid(fields, botId, fields.find(([k]) => k === 'signature')?.[1], publicKeysHex)) {
    matched = 'telegram-signature';
  }
  if (!matched) {
    return fail(`signature does not match BOT_TOKEN (fields received: ${fields.map(([k]) => k).join(', ')}). ` +
      `This login was made for a different bot than ID ${botId}. Open the app from the bot whose token is in .env.`);
  }
  if (matched !== 'official') console.warn(`[auth] accepted using the "${matched}" check${matched === 'telegram-signature' ? ' (bot token check failed; if you revoked the token recently this is expected)' : ''}`);

  const get = (k) => fields.find(([key]) => key === k)?.[1];
  const authDate = Number(get('auth_date'));
  if (!authDate || Date.now() / 1000 - authDate > maxAgeSec) return fail('login data is older than 24 hours. Close the mini app and open it again.');

  try {
    return { ...JSON.parse(get('user')), _authDate: authDate };
  } catch {
    return fail('login data has no user.');
  }
}

module.exports = { validateInitData };
