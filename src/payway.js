// ABA PayWay (Checkout / Purchase API) integration.
// Creates a payment that returns an ABA KHQR + "open ABA app" deeplink, and checks whether it was paid.
//
// .env:
//   PAYMENT_MODE=payway
//   PAYWAY_MERCHANT_ID=ec479294
//   PAYWAY_API_KEY=...            (called "Public Key" in the PayWay portal; it signs every request)
//   PAYWAY_BASE=https://checkout-sandbox.payway.com.kh   (live: the production URL ABA gives you)
//
// The hash field order below follows PayWay's Purchase / Check transaction docs. If ABA's docs for
// your account list a different order, change only HASH_FIELDS. Run `npm run check:payway` to verify.
const crypto = require('crypto');

const BASE = () => (process.env.PAYWAY_BASE || 'https://checkout-sandbox.payway.com.kh').replace(/\/+$/, '');
const MERCHANT = () => String(process.env.PAYWAY_MERCHANT_ID || '').trim();
const KEY = () => String(process.env.PAYWAY_API_KEY || '').trim();

const HASH_FIELDS = {
  purchase: ['req_time', 'merchant_id', 'tran_id', 'amount', 'items', 'shipping', 'firstname', 'lastname', 'email', 'phone',
    'type', 'payment_option', 'return_url', 'cancel_url', 'continue_success_url', 'return_deeplink', 'currency',
    'custom_fields', 'return_params', 'payout', 'lifetime', 'additional_params', 'google_pay_token', 'skip_success_page'],
  check: ['req_time', 'merchant_id', 'tran_id'],
};

const sign = (fields, data) => crypto.createHmac('sha512', KEY()).update(fields.map((f) => data[f] ?? '').join('')).digest('base64');
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
// PayWay wants UTC time as YYYYMMDDHHmmss
const reqTime = () => new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

class PayWayError extends Error {}

async function call(path, body, asForm) {
  const url = BASE() + path;
  let res;
  try {
    if (asForm) {
      const form = new FormData();
      for (const [k, v] of Object.entries(body)) form.append(k, v ?? '');
      res = await fetch(url, { method: 'POST', body: form, signal: AbortSignal.timeout(20000) });
    } else {
      res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    }
  } catch (e) {
    throw new PayWayError(`Could not reach PayWay (${e.cause?.code || e.message})`);
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { http: res.status, json, text };
}

/**
 * Create a payment. Returns { qrString, qrImage, deeplink, raw }.
 * tranId: unique per attempt (max 20 chars). amount: number in `currency` units.
 */
async function createPayment({ tranId, amount, currency = 'USD', items = [], returnUrl = '', lifetimeMin = 15, firstname = '', phone = '' }) {
  if (!MERCHANT() || !KEY()) throw new PayWayError('PAYWAY_MERCHANT_ID and PAYWAY_API_KEY must be set');
  const data = {
    req_time: reqTime(),
    merchant_id: MERCHANT(),
    tran_id: tranId,
    amount: currency === 'KHR' ? String(Math.round(amount)) : Number(amount).toFixed(2),
    items: items.length ? b64(JSON.stringify(items)) : '',
    shipping: '0', // PayWay requires a number here (no delivery fee)
    firstname: String(firstname).slice(0, 20),
    lastname: '',
    email: '',
    phone: String(phone || ''),
    type: 'purchase',
    payment_option: 'abapay_khqr_deeplink', // returns JSON with the KHQR string + ABA deeplink
    return_url: returnUrl ? b64(returnUrl) : '', // PayWay "pushback": called when the payment succeeds
    cancel_url: '',
    continue_success_url: '',
    return_deeplink: '',
    currency,
    custom_fields: '',
    return_params: '',
    payout: '',
    lifetime: String(Math.max(3, Math.round(lifetimeMin))),
    additional_params: '',
    google_pay_token: '',
    skip_success_page: '',
  };
  data.hash = sign(HASH_FIELDS.purchase, data);
  const r = await call('/api/payment-gateway/v1/payments/purchase', data, true);
  const code = r.json?.status?.code;
  if (code !== undefined && String(code) !== '00') throw new PayWayError(`PayWay refused the payment: ${r.json.status.message || code}`);
  const qrString = r.json?.qrString || r.json?.qr_string;
  if (!qrString) throw new PayWayError(`Unexpected PayWay answer (HTTP ${r.http}): ${r.text.slice(0, 200)}`);
  return { qrString, qrImage: r.json.qrImage || null, deeplink: r.json.abapay_deeplink || r.json.deeplink || null, raw: r.json };
}

/**
 * Ask PayWay whether a payment went through. Returns { paid, amount, currency, status, raw }.
 */
async function checkTransaction(tranId) {
  const data = { req_time: reqTime(), merchant_id: MERCHANT(), tran_id: tranId };
  data.hash = sign(HASH_FIELDS.check, data);
  const r = await call('/api/payment-gateway/v1/payments/check-transaction-2', data, false);
  const d = r.json?.data || {};
  const status = String(d.payment_status || d.status || '').toUpperCase();
  const paid = status === 'APPROVED' || status === 'PRE-AUTH' || String(d.payment_status_code) === '0';
  return {
    paid,
    amount: Number(d.total_amount ?? d.payment_amount ?? d.original_amount ?? NaN),
    currency: String(d.payment_currency || d.currency || '').toUpperCase(),
    status: status || r.json?.status?.message || `HTTP ${r.http}`,
    code: r.json?.status?.code,
    raw: r.json || r.text,
  };
}

module.exports = { createPayment, checkTransaction, PayWayError, HASH_FIELDS };
