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
