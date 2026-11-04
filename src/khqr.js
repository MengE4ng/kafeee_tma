const { BakongKHQR, khqrData, IndividualInfo } = require('bakong-khqr');

const API = process.env.BAKONG_API || 'https://api-bakong.nbc.gov.kh';

// Builds a dynamic (fixed-amount, expiring) KHQR string.
function generateKHQR({ amount, currency, billNumber, expiresAt }) {
  const optionalData = {
    currency: currency === 'USD' ? khqrData.currency.usd : khqrData.currency.khr,
    amount,
    billNumber: String(billNumber).slice(0, 25),
    storeLabel: (process.env.SHOP_NAME || 'Coffee').slice(0, 25),
    terminalLabel: 'Telegram',
    expirationTimestamp: expiresAt, // ms; required by the SDK when amount is set
  };

  const info = new IndividualInfo(
    process.env.BAKONG_ACCOUNT_ID,
    (process.env.MERCHANT_NAME || process.env.SHOP_NAME || 'Coffee').slice(0, 25),
    process.env.MERCHANT_CITY || 'Phnom Penh',
    optionalData,
  );

  const res = new BakongKHQR().generateIndividual(info);
  if (!res || res.status?.code !== 0 || !res.data) {
    throw new Error(`KHQR generation failed: ${JSON.stringify(res?.status)}`);
  }
  return { qr: res.data.qr, md5: res.data.md5 };
}

async function bakongPost(path, body) {
  const r = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.BAKONG_TOKEN}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (r.status === 401) throw new Error('Bakong token rejected (expired?). Renew it at api-bakong.nbc.gov.kh');
  if (r.status === 403) throw new Error('Bakong API returned 403 (often means the server IP is outside Cambodia)');
  return r.json();
}

// Returns transaction data if this exact QR (identified by md5) has been paid, else null.
async function checkPaymentByMd5(md5) {
  const j = await bakongPost('/v1/check_transaction_by_md5', { md5 });
  if (j && j.responseCode === 0 && j.data) return j.data; // { hash, fromAccountId, toAccountId, currency, amount, ... }
  return null;
}

// Optional: a short link that opens the customer's banking app with the QR prefilled.
// Useful because customers usually can't scan a QR shown on their own phone.
async function generateDeepLink(qr) {
  try {
    const j = await bakongPost('/v1/generate_deeplink_by_qr', {
      qr,
      sourceInfo: {
        appIconUrl: process.env.APP_ICON_URL || 'https://bakong.nbc.gov.kh/images/logo.svg',
        appName: (process.env.SHOP_NAME || 'Coffee').slice(0, 25),
        appDeepLinkCallback: process.env.WEBAPP_URL,
      },
    });
    return j?.data?.shortLink || null;
  } catch (e) {
    console.warn('Deeplink unavailable:', e.message);
    return null;
  }
}

module.exports = { generateKHQR, checkPaymentByMd5, generateDeepLink };

// ---- Put an amount into an existing (static) merchant KHQR ----
// KHQR is a list of fields: 2-digit tag + 2-digit length + value. We keep every field of
// your merchant QR as-is (including ABA PayWay's data), then:
//   01 → "12" (dynamic QR), 54 → amount, 99 → created/expires timestamps, 63 → new checksum.
function parseTlv(s) {
  const out = [];
  for (let i = 0; i < s.length;) {
    const tag = s.slice(i, i + 2), len = Number(s.slice(i + 2, i + 4));
    if (!/^\d{2}$/.test(tag) || Number.isNaN(len)) throw new Error('Not a valid KHQR string');
    out.push([tag, s.slice(i + 4, i + 4 + len)]);
    i += 4 + len;
  }
  return out;
}
const tlv = (tag, value) => tag + String(value.length).padStart(2, '0') + value;

function crc16(str) { // CRC-16/CCITT-FALSE, as used by EMV / KHQR
  let crc = 0xffff;
  for (const b of Buffer.from(str, 'utf8')) {
    crc ^= b << 8;
    for (let j = 0; j < 8; j++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function addAmountToKhqr(qr, amount, { expiresAt } = {}) {
  const fields = parseTlv(qr.trim()).filter(([t]) => !['54', '63', '99'].includes(t));
  const currency = fields.find(([t]) => t === '53')?.[1];
  const value = currency === '116' ? String(Math.round(amount)) : (Math.round(amount * 100) / 100).toFixed(2).replace(/\.?0+$/, '');
  const set = (tag, v) => { const f = fields.find(([t]) => t === tag); if (f) f[1] = v; else fields.push([tag, v]); };
  set('01', '12');
  set('54', value);
  if (expiresAt) set('99', tlv('00', String(Date.now())) + tlv('01', String(expiresAt)));
  fields.sort(([a], [b]) => Number(a) - Number(b));
  const body = fields.map(([t, v]) => tlv(t, v)).join('') + '6304';
  return body + crc16(body);
}

module.exports.addAmountToKhqr = addAmountToKhqr;
