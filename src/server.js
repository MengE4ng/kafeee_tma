require('dotenv').config();
require('./secret').loadSecrets(); // decrypts BOT_TOKEN_ENC if used
const path = require('path');
const express = require('express');
const QRCode = require('qrcode');
const crypto = require('crypto');
const { renderKhqrCard } = require('./khqrCard');

const db = require('./db');
const menu = require('./menu');
const shop = require('./shop');
const { BakongKHQR } = require('bakong-khqr');
const { generateKHQR, checkPaymentByMd5, generateDeepLink, addAmountToKhqr } = require('./khqr');
// Manual mode: put each order's amount into your merchant QR, so customers don't type it.
// Set QR_WITH_AMOUNT=0 in .env to go back to the plain QR where customers type the amount.
const QR_WITH_AMOUNT = process.env.QR_WITH_AMOUNT !== '0';
const { validateInitData } = require('./telegramAuth');
const { createBot } = require('./bot');

const {
  BOT_TOKEN, WEBAPP_URL, BARISTA_CHAT_ID, PORT = 3000,
  CURRENCY = 'USD', SHOP_NAME = 'Coffee', BAKONG_ACCOUNT_ID,
} = process.env;
// PAYMENT_MODE=manual → show your own (static) merchant QR; barista confirms each payment
// PAYMENT_MODE=bakong → generate a QR per order with bakong-khqr; payment detected automatically
const MODE = (process.env.PAYMENT_MODE || 'manual').toLowerCase();
const required = { BOT_TOKEN, WEBAPP_URL, BARISTA_CHAT_ID };
if (MODE === 'bakong') Object.assign(required, { BAKONG_ACCOUNT_ID, BAKONG_TOKEN: process.env.BAKONG_TOKEN });
else required.MERCHANT_KHQR = process.env.MERCHANT_KHQR;
for (const [k, v] of Object.entries(required)) {
  if (!v) { console.error(`Missing ${k} in .env`); process.exit(1); }
}

// Read the merchant QR once, so the app can show its name and currency
let merchantQR = null;
if (MODE === 'manual') {
  const qr = process.env.MERCHANT_KHQR.trim();
  if (!BakongKHQR.verify(qr).isValid) { console.error('MERCHANT_KHQR is not a valid KHQR string'); process.exit(1); }
  const d = BakongKHQR.decode(qr).data;
  merchantQR = { qr, name: d.merchantName, currency: d.transactionCurrency === '116' ? 'KHR' : 'USD' };
  if (merchantQR.currency !== CURRENCY) {
    console.warn(`⚠️  Your merchant QR is in ${merchantQR.currency} but CURRENCY=${CURRENCY}. Customers will see prices in ${CURRENCY}.`);
  }
}

const QR_TTL_MS = (Number(process.env.QR_TTL_MIN) || (MODE === 'manual' ? 15 : 10)) * 60 * 1000;
const POLL_MS = 4000;
const FACTOR = CURRENCY === 'USD' ? 100 : 1; // money is stored in minor units
const toMinor = (v) => Math.round(v * FACTOR);
const fromMinor = (v) => v / FACTOR;
const formatMoney = (minor, cur = CURRENCY) =>
  cur === 'USD' ? `$${(minor / 100).toFixed(2)}` : `${minor.toLocaleString('en-US')}៛`;

const { bot, notifyBaristaNewOrder, notifyBaristaClaim, notifyBaristaReport, notifyCustomer } = createBot({
  token: BOT_TOKEN, baristaChatId: BARISTA_CHAT_ID, baristaTopicId: process.env.BARISTA_TOPIC_ID, webAppUrl: WEBAPP_URL, formatMoney, manualTtlMs: QR_TTL_MS, shop: require('./shop'),
});

const app = express();
app.use(express.json({ limit: '50kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

// ---------- Auth: every API call carries Telegram initData ----------
function auth(req, res, next) {
  const header = req.get('Authorization') || '';
  const initData = header.startsWith('tma ') ? header.slice(4) : '';
  let user = validateInitData(initData, BOT_TOKEN);
  if (!user && process.env.DEV_SKIP_AUTH === '1' && process.env.NODE_ENV !== 'production') {
    user = { id: 1, first_name: 'Dev', username: 'dev' };
  }
  if (!user) return next(new HttpError(401, 'Open this app from Telegram'));
  req.user = user;
  next();
}

function ownedOrder(req) {
  const order = db.getOrder(Number(req.params.id));
  if (!order || order.user_id !== req.user.id) throw new HttpError(404, 'Order not found');
  return order;
}

function publicOrder(o) {
  return {
    id: o.id,
    code: o.code,
    status: o.status,
    items: o.items.map((it) => ({ ...it, subtotal: formatMoney(it.subtotal, o.currency) })),
    note: o.note,
    total: formatMoney(o.total, o.currency),
    amount: fromMinor(o.total),
    currency: o.currency,
    mode: MODE,
    qrUrl: MODE === 'manual'
      ? (o.qr ? `/api/orders/${o.id}/qr.png?k=${cardKey(o.id)}` : '/api/merchant-qr.png')
      : o.md5 ? `/api/orders/${o.id}/qr.png?k=${o.md5}` : null,
    amountInQr: MODE === 'manual' && Boolean(o.qr),
    cardUrl: `/api/orders/${o.id}/card.png?k=${cardKey(o.id)}`,
    qrCurrency: MODE === 'manual' ? merchantQR.currency : o.currency,
    rejectedCount: o.rejected_count || 0,
    deeplink: o.deeplink,
    expiresAt: o.qr_expires_at,
    paidAt: o.paid_at,
    merchant: MODE === 'manual' ? merchantQR.name : (process.env.MERCHANT_NAME || SHOP_NAME),
  };
}

// Server-side pricing: never trust prices sent from the client.
function priceLine(line) {
  const item = menu.items.find((i) => i.id === line?.id);
  if (!item) throw new HttpError(400, 'An item in your cart is no longer on the menu');
  if (db.soldOut().has(item.id)) throw new HttpError(409, `${item.name} just sold out`);
  const qty = Number(line.qty);
  if (!Number.isInteger(qty) || qty < 1 || qty > 20) throw new HttpError(400, 'Invalid quantity');

  let unit = toMinor(item.price);
  const options = {};
  for (const g of item.options) {
    if (g === 'ice' && line.options?.temp === 'hot') continue; // no ice in a hot drink
    const group = menu.optionGroups[g];
    const choice = group.choices.find((c) => c.id === (line.options?.[g] ?? group.default));
    if (!choice) throw new HttpError(400, `Invalid ${group.label.toLowerCase()}`);
    unit += toMinor(choice.add || 0);
    options[g] = choice.summary || choice.label;
  }
  return { id: item.id, name: item.name, qty, unit, subtotal: unit * qty, options };
}

async function attachNewQR(orderId) {
  if (MODE === 'manual') {
    if (QR_WITH_AMOUNT) {
      const o = db.getOrder(orderId);
      const qr = addAmountToKhqr(merchantQR.qr, fromMinor(o.total));
      db.setQR(orderId, { qr, md5: null, expiresAt: Date.now() + QR_TTL_MS, deeplink: null });
    } else {
      db.extendDeadline(orderId, QR_TTL_MS);
    }
    return db.getOrder(orderId);
  }
  const order = db.getOrder(orderId);
  const expiresAt = Date.now() + QR_TTL_MS;
  const { qr, md5 } = generateKHQR({
    amount: fromMinor(order.total), currency: order.currency, billNumber: `ORD${order.id}`, expiresAt,
  });
  const deeplink = await generateDeepLink(qr);
  db.setQR(order.id, { qr, md5, expiresAt, deeplink });
  return db.getOrder(order.id);
}

// ---------- Opening hours ----------
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const to12h = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
function hoursStatus(now = new Date()) {
  const hours = shop.hours || {};
  if (Object.keys(hours).length === 0) return { openNow: true };
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: shop.timezone || 'Asia/Phnom_Penh', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map((x) => [x.type, x.value]));
  const dayIdx = DAYS.indexOf(p.weekday.toLowerCase().slice(0, 3));
  const mins = Number(p.hour) * 60 + Number(p.minute);
  const today = hours[DAYS[dayIdx]];
  if (today && mins >= toMin(today[0]) && mins < toMin(today[1])) return { openNow: true, closesAt: to12h(today[1]) };
  for (let i = 0; i < 8; i++) {
    const h = hours[DAYS[(dayIdx + i) % 7]];
    if (h && (i > 0 || mins < toMin(h[0]))) {
      const when = i === 0 ? 'today' : i === 1 ? 'tomorrow' : DAYS[(dayIdx + i) % 7].replace(/^./, (c) => c.toUpperCase());
      return { openNow: false, opensAt: `${when} at ${to12h(h[0])}` };
    }
  }
  return { openNow: false };
}
function shopState() {
  const h = hoursStatus();
  const manualOpen = db.isOpen();
  return { open: manualOpen && h.openNow, reason: manualOpen ? (h.openNow ? null : 'hours') : 'manual', ...h };
}
const publicShop = () => ({
  address: shop.address || '', mapsUrl: shop.mapsUrl || '', lat: shop.lat ?? null, lng: shop.lng ?? null,
  phone: shop.phone || '', telegram: (shop.telegram || '').replace(/^@/, ''), hours: shop.hours || {},
  timezone: shop.timezone || 'Asia/Phnom_Penh',
});

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// "Call" button: Telegram's in-app window can't open phone links, so the app opens this
// page in the phone's browser, which then hands the number to the phone app.
app.get('/call', (req, res) => {
  const phone = String(shop.phone || '');
  if (!phone) return res.status(404).send('No phone number set');
  const tel = phone.replace(/[^\d+]/g, '');
  const safe = phone.replace(/[<>&"]/g, '');
  res.set('Content-Type', 'text/html; charset=utf-8').send(`<!doctype html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Call ${safe}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4ead3;font-family:-apple-system,Roboto,sans-serif;color:#1b1410}
a{display:inline-block;padding:16px 28px;border:2.5px solid #1b1410;border-radius:14px;background:#c9a12b;color:#1b1410;font-size:20px;font-weight:800;text-decoration:none;box-shadow:4px 4px 0 #1b1410}
p{text-align:center}</style></head>
<body><p>☕ Kafee<br><br><a href="tel:${tel}">📞 Call ${safe}</a></p>
<script>location.href = 'tel:${tel}';</script></body></html>`);
});

// ---------- API ----------
app.get('/api/menu', (req, res) => {
  const so = db.soldOut();
  res.json({
    shopName: SHOP_NAME,
    ...(() => { const s = shopState(); return { open: s.open, closedReason: s.reason, opensAt: s.opensAt || null, closesAt: s.closesAt || null }; })(),
    shop: publicShop(),
    currency: CURRENCY,
    categories: menu.categories,
    optionGroups: menu.optionGroups,
    items: menu.items.map((i) => ({ ...i, soldOut: so.has(i.id) })),
  });
});

app.post('/api/orders', auth, wrap(async (req, res) => {
  const st = shopState();
  if (st.open === false) throw new HttpError(409, st.opensAt ? `We’re closed. We open ${st.opensAt}.` : 'The shop is closed right now');
  const lines = Array.isArray(req.body.items) ? req.body.items.slice(0, 30).map(priceLine) : [];
  if (!lines.length) throw new HttpError(400, 'Your cart is empty');
  const total = lines.reduce((s, l) => s + l.subtotal, 0);

  const id = db.createOrder({
    userId: req.user.id,
    userName: [req.user.first_name, req.user.last_name].filter(Boolean).join(' '),
    username: req.user.username,
    items: lines,
    note: String(req.body.note || '').trim().slice(0, 200),
    total,
    currency: CURRENCY,
  });
  res.json(publicOrder(await attachNewQR(id)));
}));

app.get('/api/orders/active', auth, (req, res) => {
  const o = db.activeOrderForUser(req.user.id);
  res.json(o ? publicOrder(o) : null);
});

app.get('/api/orders/:id', auth, (req, res) => res.json(publicOrder(ownedOrder(req))));

// Manual mode: customer taps "I've paid" → barista gets a confirm request
app.post('/api/orders/:id/claim-paid', auth, wrap(async (req, res) => {
  if (MODE !== 'manual') throw new HttpError(400, 'Not available');
  const order = ownedOrder(req);
  if (db.claimPaid(order.id)) {
    try {
      await notifyBaristaClaim(db.getOrder(order.id));
    } catch (e) {
      console.error('Notify barista failed:', e.message, '→ is the bot in the barista group and BARISTA_CHAT_ID correct?');
      db.setStatus(order.id, 'pending_payment'); // let the customer try again
      throw new HttpError(503, 'We couldn’t reach the barista. Please show your payment at the counter.');
    }
  }
  res.json(publicOrder(db.getOrder(order.id)));
}));

// Customer asks for help with an order → message in the barista group
const reportCount = new Map();
app.post('/api/orders/:id/report', auth, wrap(async (req, res) => {
  const order = ownedOrder(req);
  const n = (reportCount.get(order.id) || 0) + 1;
  if (n > 3) throw new HttpError(429, 'We already got your messages. Please call or message us directly.');
  const message = String(req.body.message || '').trim().slice(0, 500);
  if (message.length < 2) throw new HttpError(400, 'Please write what went wrong.');
  reportCount.set(order.id, n);
  await notifyBaristaReport(order, message).catch((e) => {
    console.error('Report failed:', e.message);
    throw new HttpError(503, 'Could not send. Please call or message us directly.');
  });
  res.json({ ok: true });
}));

app.post('/api/orders/:id/regenerate', auth, wrap(async (req, res) => {
  const order = ownedOrder(req);
  if (!['pending_payment', 'expired'].includes(order.status)) throw new HttpError(409, 'This order is already paid');
  if (MODE === 'bakong' && await checkAndSettle(order)) return res.json(publicOrder(db.getOrder(order.id)));
  res.json(publicOrder(await attachNewQR(order.id)));
}));

app.post('/api/orders/:id/cancel', auth, wrap(async (req, res) => {
  const order = ownedOrder(req);
  if (!['pending_payment', 'expired', 'awaiting_confirmation'].includes(order.status)) throw new HttpError(409, 'Paid orders can’t be cancelled in the app. Please ask the barista.');
  // Last check so we never cancel an order whose payment just landed
  if (MODE === 'manual' || !(await checkAndSettle(order))) db.setStatus(order.id, 'cancelled');
  res.json(publicOrder(db.getOrder(order.id)));
}));

// Full KHQR card (header, merchant, amount, QR) as one image for "Save QR to photos".
// The key in the link stops people from guessing other orders' cards.
function cardKey(id) {
  return crypto.createHmac('sha256', BOT_TOKEN).update(`card:${id}`).digest('hex').slice(0, 24);
}
const cardCache = new Map();
app.get('/api/orders/:id/card.png', wrap(async (req, res) => {
  const order = db.getOrder(Number(req.params.id));
  if (!order || req.query.k !== cardKey(order.id)) throw new HttpError(404, 'Not found');
  const manual = MODE === 'manual';
  const qr = manual ? (order.qr || merchantQR.qr) : order.qr;
  if (!qr) throw new HttpError(404, 'Not found');
  const cacheKey = `${order.id}:${order.md5 || 'manual'}`;
  let png = cardCache.get(cacheKey);
  if (!png) {
    png = await renderKhqrCard({
      qr,
      merchant: manual ? merchantQR.name : (process.env.MERCHANT_NAME || SHOP_NAME),
      amount: fromMinor(order.total),
      currency: manual ? merchantQR.currency : order.currency,
      fixedAmount: !manual || Boolean(order.qr),
    });
    cardCache.set(cacheKey, png);
    if (cardCache.size > 100) cardCache.delete(cardCache.keys().next().value);
  }
  res.set('Content-Type', 'image/png');
  res.set('Content-Disposition', `inline; filename="KHQR-kafee-${order.id}.png"`);
  res.send(png);
}));

// Manual mode: your own merchant QR, rendered sharp from the KHQR string
app.get('/api/merchant-qr.png', wrap(async (req, res) => {
  if (MODE !== 'manual') throw new HttpError(404, 'Not found');
  const png = await QRCode.toBuffer(merchantQR.qr, { width: 720, margin: 2, errorCorrectionLevel: 'Q' });
  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', 'public, max-age=86400');
  res.set('Content-Disposition', 'inline; filename="KHQR-kafee.png"');
  res.send(png);
}));

// QR as PNG so the customer can save it and "scan from gallery" in their bank app.
// The md5 in the query acts as an unguessable key, since downloads can't send auth headers.
app.get('/api/orders/:id/qr.png', wrap(async (req, res) => {
  const order = db.getOrder(Number(req.params.id));
  if (!order || !order.qr || (req.query.k !== order.md5 && req.query.k !== cardKey(order.id))) throw new HttpError(404, 'Not found');
  const png = await QRCode.toBuffer(order.qr, { width: 720, margin: 2, errorCorrectionLevel: 'Q' });
  res.set('Content-Type', 'image/png');
  res.set('Content-Disposition', `inline; filename="KHQR-order-${order.id}.png"`);
  res.send(png);
}));

app.use((err, req, res, next) => {
  if (!err.status) console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Something went wrong. Please try again.' });
});

// ---------- Payment watcher ----------
// Polls Bakong for every unpaid order until it is paid or its QR expires.
async function checkAndSettle(order) {
  if (!order.md5) return false;
  const tx = await checkPaymentByMd5(order.md5);
  if (!tx) return false;

  const amountOk =
    toMinor(Number(tx.amount)) === order.total &&
    String(tx.currency).toUpperCase() === order.currency &&
    (!tx.toAccountId || tx.toAccountId === BAKONG_ACCOUNT_ID);

  const firstTime = db.markPaid(order.id, { hash: tx.hash, fromAccountId: tx.fromAccountId, amountOk });
  if (firstTime) {
    const paid = db.getOrder(order.id);
    console.log(`Order ${paid.id} paid → #${paid.code}`);
    await notifyBaristaNewOrder(paid).catch((e) => console.error('Notify barista failed:', e.message));
    await notifyCustomer(paid);
  }
  return true;
}

let polling = false;
setInterval(async () => {
  if (MODE === 'manual') { db.expireManualOrders(60_000); return; }
  if (polling) return;
  polling = true;
  try {
    for (const order of db.pendingPayments()) {
      try {
        const paid = await checkAndSettle(order);
        // small grace period after expiry in case the bank confirms slightly late
        if (!paid && Date.now() > order.qr_expires_at + 60_000) db.setStatus(order.id, 'expired');
      } catch (e) {
        console.error(`Payment check failed for order ${order.id}:`, e.message);
      }
    }
  } finally {
    polling = false;
  }
}, POLL_MS);

// ---------- Start ----------
app.listen(PORT, () => console.log(`Mini app server on :${PORT}  (public URL: ${WEBAPP_URL.slice(0, 12)}…)  payment mode: ${MODE}${merchantQR ? ` → ${merchantQR.name}` : ''}`));

bot.api.setChatMenuButton({ menu_button: { type: 'web_app', text: 'Order', web_app: { url: WEBAPP_URL } } })
  .catch((e) => console.warn('Could not set menu button:', e.message));
bot.start({ onStart: (me) => console.log(`Bot @${me.username} running`) })
  .catch((e) => { console.error('Bot failed to start (check BOT_TOKEN):', e.message); process.exit(1); });
