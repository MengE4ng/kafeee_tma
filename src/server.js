require('dotenv').config();
require('./secret').loadSecrets(); // decrypts BOT_TOKEN_ENC if used
const path = require('path');
const express = require('express');
const QRCode = require('qrcode');
const crypto = require('crypto');
const { renderKhqrCard } = require('./khqrCard');

const db = require('./db');
const menuStore = require('./menuStore');
// Who may edit the menu in the app: ADMIN_IDS (IDs or @usernames) plus managers added with /addadmin
const { isAdmin } = require('./admins');
const shop = require('./shop');
const { BakongKHQR } = require('bakong-khqr');
const { generateKHQR, checkPaymentByMd5, generateDeepLink, addAmountToKhqr } = require('./khqr');
const payway = require('./payway');
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
else if (MODE === 'payway') Object.assign(required, { PAYWAY_MERCHANT_ID: process.env.PAYWAY_MERCHANT_ID, PAYWAY_API_KEY: process.env.PAYWAY_API_KEY });
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

const { bot, notifyBaristaNewOrder, notifyBaristaClaim, notifyBaristaReport, notifyCustomer, notifyClaimWithdrawn, notifyAudit } = createBot({
  token: BOT_TOKEN, baristaChatId: BARISTA_CHAT_ID, baristaTopicId: process.env.BARISTA_TOPIC_ID, webAppUrl: WEBAPP_URL, formatMoney, manualTtlMs: QR_TTL_MS, shop: require('./shop'),
});

const app = express();
// small JSON everywhere, except "I've paid" which may carry a payment screenshot
const smallJson = express.json({ limit: '50kb' }), proofJson = express.json({ limit: '6mb' });
app.use((req, res, next) => (req.path.endsWith('/claim-paid') ? proofJson : smallJson)(req, res, next));
const MAX_REJECTIONS = 3; // "Not received" claims per customer per 24h before ordering is paused
// ---------- Security ----------
app.set('trust proxy', 1); // real client IP behind Render / Cloudflare
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({
    // Only load scripts, styles, fonts and frames from where the app needs them
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://telegram.org",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data: blob:",
      "connect-src 'self'",
      'frame-src https://www.openstreetmap.org',
      "frame-ancestors 'self' https://web.telegram.org https://*.telegram.org", // Telegram Web shows the app in a frame
      "base-uri 'none'",
      "form-action 'self'",
      "object-src 'none'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
  });
  next();
});

// Simple rate limits (per Telegram user when logged in, otherwise per IP)
const hits = new Map();
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.reset < now) hits.delete(k); }, 60_000).unref();
function rateLimit(name, max, windowMs, message = 'Too many requests. Please wait a moment and try again.') {
  return (req, res, next) => {
    const who = req.user?.id ? `u${req.user.id}` : `ip${req.ip}`;
    const key = `${name}:${who}`, now = Date.now();
    const h = hits.get(key) || { n: 0, reset: now + windowMs };
    if (h.reset < now) { h.n = 0; h.reset = now + windowMs; }
    h.n += 1; hits.set(key, h);
    if (h.n > max) { res.set('Retry-After', Math.ceil((h.reset - now) / 1000)); return next(new HttpError(429, message)); }
    next();
  };
}
app.use('/api', rateLimit('api', 240, 60_000)); // overall cap per IP/user

if (process.env.DEV_SKIP_AUTH === '1') {
  console.warn('⚠️  [security] DEV_SKIP_AUTH=1: Telegram login is OFF. Never use this on a live server.');
  if (process.env.NODE_ENV === 'production') console.warn('   (ignored because NODE_ENV=production)');
}

app.use(express.static(path.join(__dirname, '..', 'public')));

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

// ---------- Auth: every API call carries Telegram initData ----------
function auth(req, res, next) {
  const header = req.get('Authorization') || '';
  const initData = header.startsWith('tma ') ? header.slice(4) : '';
  let user = validateInitData(initData, BOT_TOKEN);
  if (!user && process.env.DEV_SKIP_AUTH === '1' && process.env.NODE_ENV !== 'production') {
    user = { id: 1, first_name: 'Dev', username: 'dev', _authDate: Math.floor(Date.now() / 1000) };
  }
  if (!user) return next(new HttpError(401, 'Open this app from Telegram'));
  req.authDate = user._authDate;
  delete user._authDate;
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
      : o.qr ? `/api/orders/${o.id}/qr.png?k=${cardKey(o.id)}` : null,
    amountInQr: MODE === 'manual' && Boolean(o.qr),
    cardUrl: `/api/orders/${o.id}/card.png?k=${cardKey(o.id)}`,
    shareUrl: `/share/${o.id}?k=${cardKey(o.id)}`,
    abaUrl: o.deeplink ? `/open-aba/${o.id}?k=${cardKey(o.id)}` : null, // https page that opens the ABA app
    qrCurrency: MODE === 'manual' ? merchantQR.currency : o.currency,
    rejectedCount: o.rejected_count || 0,
    deeplink: o.deeplink,
    expiresAt: o.qr_expires_at,
    paidAt: o.paid_at,
    merchant: MODE === 'manual' ? merchantQR.name : ((o.qr && khqrName(o.qr)) || process.env.MERCHANT_NAME || SHOP_NAME),
  };
}

// Server-side pricing: never trust prices sent from the client.
function priceLine(line) {
  const menu = menuStore.getMenu();
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
    if (!group) continue; // option was deleted from the menu
    const choice = group.choices.find((c) => c.id === (line.options?.[g] ?? group.default));
    if (!choice) throw new HttpError(400, `Invalid ${group.label.toLowerCase()}`);
    unit += toMinor(choice.add || 0);
    options[g] = choice.summary || choice.label;
  }
  return { id: item.id, name: item.name, qty, unit, subtotal: unit * qty, options };
}

async function attachNewQR(orderId) {
  if (MODE === 'payway') {
    // Each attempt needs a new PayWay transaction id (max 20 characters); it is stored in the md5 column
    const o = db.getOrder(orderId);
    const tranId = `K${o.id}T${Date.now().toString(36)}`.slice(0, 20);
    const p = await payway.createPayment({
      tranId,
      amount: fromMinor(o.total),
      currency: o.currency,
      items: o.items.map((it) => ({ name: it.name.slice(0, 50), quantity: it.qty, price: fromMinor(it.unit) })),
      returnUrl: `${WEBAPP_URL.replace(/\/+$/, '')}/api/payway/callback`,
      lifetimeMin: QR_TTL_MS / 60000,
      firstname: o.user_name || '',
    });
    db.setQR(orderId, { qr: p.qrString, md5: tranId, expiresAt: Date.now() + QR_TTL_MS, deeplink: p.deeplink });
    return db.getOrder(orderId);
  }
  if (MODE === 'manual') {
    if (QR_WITH_AMOUNT) {
      const o = db.getOrder(orderId);
      // A QR with an amount must carry a timestamp to be valid KHQR. We give it 24h so it still
      // works if the barista asks the customer to try again; the app's own pay timer still applies.
      const qr = addAmountToKhqr(merchantQR.qr, fromMinor(o.total), { expiresAt: Date.now() + 24 * 3600 * 1000 });
      if (BakongKHQR.verify(qr).isValid) {
        db.setQR(orderId, { qr, md5: null, expiresAt: Date.now() + QR_TTL_MS, deeplink: null });
      } else {
        console.warn('Could not build a valid QR with amount; showing the plain merchant QR instead.');
        db.extendDeadline(orderId, QR_TTL_MS);
      }
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
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#FAF6F0;font-family:-apple-system,Roboto,sans-serif;color:#4A2C1A}
a{display:inline-block;padding:16px 28px;border-radius:12px;background:#4A2C1A;color:#FAF6F0;font-size:18px;font-weight:600;letter-spacing:.06em;text-decoration:none}
p{text-align:center}</style></head>
<body><p>☕ Kafee<br><br><a href="tel:${tel}">📞 Call ${safe}</a></p>
<script>location.href = 'tel:${tel}';</script></body></html>`);
});

// ---------- API ----------
// Public info for the "open in Telegram" screen shown to normal browsers
const DEV_BROWSER = process.env.DEV_SKIP_AUTH === '1' && process.env.NODE_ENV !== 'production';
app.get('/api/bot', (req, res) => {
  let username = null;
  try { username = bot.botInfo.username; } catch { /* bot not started yet */ }
  res.json({ username, dev: DEV_BROWSER });
});

// The menu is only served to people who opened the app from Telegram
app.get('/api/menu', auth, (req, res) => {
  const so = db.soldOut();
  res.json({
    shopName: SHOP_NAME,
    ...(() => { const s = shopState(); return { open: s.open, closedReason: s.reason, opensAt: s.opensAt || null, closesAt: s.closesAt || null }; })(),
    shop: publicShop(),
    currency: CURRENCY,
    ...(() => {
      const menu = menuStore.getMenu();
      return { categories: menu.categories, optionGroups: menu.optionGroups, items: menu.items.map((i) => ({ ...i, soldOut: so.has(i.id) })) };
    })(),
  });
});

app.post('/api/orders', auth, rateLimit('order', 10, 10 * 60_000, 'Too many orders in a short time. Please wait a few minutes.'), wrap(async (req, res) => {
  if (db.recentRejections(req.user.id) >= MAX_REJECTIONS) {
    throw new HttpError(429, 'Online ordering is paused for your account because several payments couldn’t be confirmed. Please order at the counter.');
  }
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
  try {
    res.json(publicOrder(await attachNewQR(id)));
  } catch (e) {
    if (e instanceof payway.PayWayError) {
      console.error('PayWay:', e.message);
      db.setStatus(id, 'cancelled');
      throw new HttpError(503, 'Payment service is busy. Please try again in a moment.');
    }
    throw e;
  }
}));

app.get('/api/orders/active', auth, (req, res) => {
  const o = db.activeOrderForUser(req.user.id);
  res.json(o ? publicOrder(o) : null);
});

app.get('/api/orders/:id', auth, (req, res) => res.json(publicOrder(ownedOrder(req))));

// Manual mode: customer taps "I've paid" → barista gets a confirm request
app.post('/api/orders/:id/claim-paid', auth, rateLimit('claim', 8, 10 * 60_000), wrap(async (req, res) => {
  if (MODE !== 'manual') throw new HttpError(400, 'Not available');
  const order = ownedOrder(req);

  // Proof of payment: a screenshot and/or the transaction ID from the bank receipt
  const ref = String(req.body?.ref || '').trim().replace(/\s+/g, '').slice(0, 30);
  let photo = null;
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body?.photo || ''));
  if (m) {
    photo = Buffer.from(m[2], 'base64');
    if (photo.length > 4 * 1024 * 1024) throw new HttpError(413, 'That screenshot is too large. Please try another.');
  }
  if (ref && /^[A-Za-z0-9-]+$/.test(ref) === false) throw new HttpError(400, 'The transaction ID can only contain letters and numbers.');

  if (db.claimPaid(order.id)) {
    db.setClaimProof(order.id, ref, null);
    try {
      await notifyBaristaClaim(db.getOrder(order.id), { photo });
    } catch (e) {
      console.error('Notify barista failed:', e.message, '→ is the bot in the barista group and BARISTA_CHAT_ID correct?');
      db.setStatus(order.id, 'pending_payment'); // let the customer try again
      throw new HttpError(503, 'We couldn’t reach the barista. Please show your payment at the counter.');
    }
  }
  res.json(publicOrder(db.getOrder(order.id)));
}));

// PayWay pushback: ABA calls this when a payment succeeds. We never trust the message itself;
// we only take the transaction id and ask PayWay directly whether it was paid.
app.post('/api/payway/callback', express.urlencoded({ extended: false, limit: '20kb' }), rateLimit('payway', 120, 60_000), wrap(async (req, res) => {
  let body = req.body || {};
  if (typeof body.response === 'string') { try { body = { ...body, ...JSON.parse(body.response) }; } catch { /* ignore */ } }
  const tranId = String(body.tran_id || body.tranId || '').slice(0, 40);
  const order = tranId && db.findOrderByPaymentRef(tranId);
  if (order && MODE === 'payway' && ['pending_payment', 'expired', 'cancelled'].includes(order.status)) {
    await settlePayWay(order).catch((e) => console.error('PayWay callback check failed:', e.message));
  }
  res.json({ ok: true });
}));

// "I haven't paid yet": back to the QR after tapping "I've paid" by mistake
app.post('/api/orders/:id/unclaim', auth, wrap(async (req, res) => {
  const order = ownedOrder(req);
  const wasPhoto = Boolean(order.claim_photo);
  if (db.unclaim(order.id, QR_TTL_MS)) await notifyClaimWithdrawn(order, wasPhoto);
  res.json(publicOrder(db.getOrder(order.id))); // if the barista already confirmed, this returns the paid order
}));

// Customer asks for help with an order → message in the barista group
const reportCount = new Map();
app.post('/api/orders/:id/report', auth, rateLimit('report', 5, 10 * 60_000), wrap(async (req, res) => {
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

// ---------- Menu admin (only for ADMIN_IDS) ----------
app.get('/api/me', auth, (req, res) => res.json({ id: req.user.id, isAdmin: isAdmin(req.user) }));
function adminOnly(req, res, next) {
  if (!isAdmin(req.user)) {
    console.warn(`[security] blocked menu admin request from Telegram user ${req.user?.id} (@${req.user?.username || '-'})`);
    return next(new HttpError(403, 'Only the shop owner can do this.'));
  }
  // Menu changes need a fresh Telegram login (max 1 hour old), so an old copied login can't be reused
  if (!req.authDate || Date.now() / 1000 - req.authDate > 3600) return next(new HttpError(401, 'For security, please close and reopen the app, then try again.'));
  next();
}
const adminLimit = rateLimit('admin', 60, 60_000);
// Every menu change is posted to the barista group, so changes are visible
const h = (v) => String(v ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); // safe in Telegram HTML
const who = (u) => h([u.first_name, u.last_name].filter(Boolean).join(' ') + (u.username ? ` (@${u.username})` : ''));
const priceText = (p) => formatMoney(toMinor(Number(p)));
function auditItem(req, before, after) {
  if (!before) return notifyAudit(`🛠 ${who(req.user)} added <b>${h(after.name)}</b> ${priceText(after.price)} (${h(after.category)})`);
  const changes = [];
  if (before.name !== after.name) changes.push(`name “${h(before.name)}” → “${h(after.name)}”`);
  if (Number(before.price) !== Number(after.price)) changes.push(`price ${priceText(before.price)} → ${priceText(after.price)}`);
  if (before.category !== after.category) changes.push(`category ${h(before.category)} → ${h(after.category)}`);
  if (Boolean(before.hidden) !== Boolean(after.hidden)) changes.push(after.hidden ? 'hidden from menu' : 'shown on menu');
  if (JSON.stringify(before.options) !== JSON.stringify(after.options)) changes.push('options changed');
  if (changes.length) notifyAudit(`🛠 ${who(req.user)} changed <b>${h(after.name)}</b>: ${changes.join(', ')}`);
}
const menuWrap = (fn) => wrap(async (req, res) => {
  try { await fn(req, res); } catch (e) { if (e instanceof menuStore.MenuError) throw new HttpError(400, e.message); throw e; }
});
const adminMenu = () => {
  const m = menuStore.getMenu({ includeHidden: true });
  const so = db.soldOut();
  return { ...m, items: m.items.map((i) => ({ ...i, soldOut: so.has(i.id) })) };
};
app.get('/api/admin/menu', auth, adminOnly, (req, res) => res.json(adminMenu()));
app.post('/api/admin/items', auth, adminOnly, adminLimit, menuWrap(async (req, res) => {
  const before = req.body?.id ? menuStore.getMenu({ includeHidden: true }).items.find((i) => i.id === req.body.id) : null;
  const id = menuStore.saveItem(req.body || {});
  auditItem(req, before, menuStore.getMenu({ includeHidden: true }).items.find((i) => i.id === id));
  if (typeof req.body?.soldOut === 'boolean') db.setSoldOut(id, req.body.soldOut);
  res.json({ id, menu: adminMenu() });
}));
app.delete('/api/admin/items/:id', auth, adminOnly, adminLimit, menuWrap(async (req, res) => {
  const before = menuStore.getMenu({ includeHidden: true }).items.find((i) => i.id === req.params.id);
  menuStore.deleteItem(req.params.id);
  if (before) notifyAudit(`🗑 ${who(req.user)} deleted <b>${h(before.name)}</b>`); db.setSoldOut(req.params.id, false); res.json({ menu: adminMenu() });
}));
app.post('/api/admin/options', auth, adminOnly, adminLimit, menuWrap(async (req, res) => {
  const id = menuStore.saveOption(req.body || {});
  const g = menuStore.getMenu({ includeHidden: true }).optionGroups[id];
  notifyAudit(`🛠 ${who(req.user)} saved option <b>${h(g.label)}</b>: ${g.choices.map((c) => h(c.label) + (c.add ? ` +${priceText(c.add)}` : '')).join(' · ')}`); res.json({ id, menu: adminMenu() });
}));
app.delete('/api/admin/options/:id', auth, adminOnly, adminLimit, menuWrap(async (req, res) => {
  const g = menuStore.getMenu({ includeHidden: true }).optionGroups[req.params.id];
  if (g) notifyAudit(`🗑 ${who(req.user)} deleted option <b>${h(g.label)}</b>`);
  menuStore.deleteOption(req.params.id); res.json({ menu: adminMenu() });
}));
app.post('/api/admin/reorder', auth, adminOnly, adminLimit, menuWrap(async (req, res) => {
  menuStore.reorder(req.body || {}); res.json({ menu: adminMenu() });
}));
app.post('/api/admin/soldout', auth, adminOnly, adminLimit, menuWrap(async (req, res) => {
  db.setSoldOut(String(req.body?.id), Boolean(req.body?.soldOut)); res.json({ menu: adminMenu() });
}));

app.post('/api/orders/:id/regenerate', auth, wrap(async (req, res) => {
  const order = ownedOrder(req);
  if (!['pending_payment', 'expired'].includes(order.status)) throw new HttpError(409, 'This order is already paid');
  if (MODE !== 'manual' && await checkAndSettle(order)) return res.json(publicOrder(db.getOrder(order.id)));
  res.json(publicOrder(await attachNewQR(order.id)));
}));

app.post('/api/orders/:id/cancel', auth, wrap(async (req, res) => {
  const order = ownedOrder(req);
  // Already cancelled (e.g. tapped twice, or cancelled on another device): just confirm it
  if (order.status === 'cancelled') return res.json(publicOrder(order));
  // Already paid: send the order back so the app can show the pickup number instead of an error
  if (['pending_payment', 'expired', 'awaiting_confirmation'].includes(order.status) === false) return res.json(publicOrder(order));
  // Last check so we never cancel an order whose payment just landed
  if (MODE === 'manual' || !(await checkAndSettle(order))) db.setStatus(order.id, 'cancelled');
  res.json(publicOrder(db.getOrder(order.id)));
}));

// Full KHQR card (header, merchant, amount, QR) as one image for "Save QR to photos".
// The key in the link stops people from guessing other orders' cards.
function khqrName(qr) { try { return BakongKHQR.decode(qr).data.merchantName; } catch { return null; } }
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
      merchant: manual ? merchantQR.name : (khqrName(qr) || process.env.MERCHANT_NAME || SHOP_NAME),
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

// "Pay with ABA Mobile": Telegram can only open https links, not the abamobilebank:// app link.
// So the app opens this page in the phone's browser, which then hands the payment to the ABA app.
app.get('/open-aba/:id', (req, res) => {
  const order = db.getOrder(Number(req.params.id));
  if (!order || req.query.k !== cardKey(order.id) || !order.deeplink) return res.status(404).send('Not found');
  const link = String(order.deeplink);
  if (/^(abamobilebank|https?):\/\//i.test(link) === false) return res.status(400).send('Invalid link');
  const total = formatMoney(order.total, order.currency);
  const safe = link.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  res.set('Content-Type', 'text/html; charset=utf-8').send(`<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pay ${total} with ABA</title>
<style>
  body{margin:0;min-height:100vh;background:#FAF6F0;font-family:-apple-system,Roboto,sans-serif;color:#4A2C1A;
    display:grid;place-items:center;padding:24px;box-sizing:border-box;text-align:center}
  .box{max-width:340px}
  h1{font-size:15px;letter-spacing:.2em;text-transform:uppercase;font-weight:600;margin:0 0 8px}
  .amt{font-size:40px;font-weight:500;margin:6px 0 20px}
  a.btn{display:block;padding:15px;border-radius:12px;background:#4A2C1A;color:#FAF6F0;text-decoration:none;font-weight:600;letter-spacing:.1em;text-transform:uppercase;font-size:14px}
  p{color:#8C7B6B;font-size:14px;line-height:1.45}
</style></head><body><div class="box">
  <h1>Kafee · ABA Pay</h1>
  <div class="amt">${total}</div>
  <a class="btn" href="${safe}" id="go">Open ABA Mobile</a>
  <p>If ABA Mobile doesn’t open, make sure it’s installed, or go back to Telegram and scan the KHQR with any banking app.<br><br>After paying, go back to Telegram: your order is confirmed automatically.</p>
</div>
<script>setTimeout(function(){ location.href = document.getElementById('go').getAttribute('href'); }, 300);</script>
</body></html>`);
});

// Share page, opened in the phone's own browser (Chrome on Android), where the share sheet works.
// Telegram's in-app window on Android can't open the share sheet, so the app sends customers here.
app.get('/share/:id', (req, res) => {
  const order = db.getOrder(Number(req.params.id));
  if (!order || req.query.k !== cardKey(order.id)) return res.status(404).send('Not found');
  const img = `/api/orders/${order.id}/card.png?k=${cardKey(order.id)}`;
  const total = formatMoney(order.total, order.currency);
  const file = `KHQR-kafee-${order.id}.png`;
  res.set('Content-Type', 'text/html; charset=utf-8').send(`<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pay ${total} · KHQR</title>
<style>
  body{margin:0;min-height:100vh;background:#FAF6F0;font-family:-apple-system,Roboto,'Noto Sans Khmer',sans-serif;color:#4A2C1A;
    display:flex;flex-direction:column;align-items:center;padding:20px 16px 32px;box-sizing:border-box}
  img{width:100%;max-width:340px;border-radius:18px;box-shadow:0 8px 24px rgba(0,0,0,.12)}
  .btn{display:block;width:100%;max-width:340px;margin-top:12px;padding:15px;border:1px solid #4A2C1A;border-radius:12px;
    font-size:14px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;text-align:center;text-decoration:none;color:#4A2C1A;box-sizing:border-box}
  .primary{background:#4A2C1A;color:#FAF6F0}.plain{background:transparent}
  p{max-width:340px;text-align:center;color:#8C7B6B;font-size:14px;line-height:1.45}
</style></head><body>
<img src="${img}" alt="KHQR ${total}">
<button class="btn primary" id="share">📲 Share to my banking app</button>
<a class="btn plain" href="${img}" download="${file}">⬇️ Save image</a>
<p>Pick your banking app in the share list. If it isn't there, tap “Save image”, then in your bank app choose Scan → Gallery.<br><br>After paying, go back to Telegram and tap “I’ve paid”.</p>
<script>
  let file = null;
  fetch('${img}').then(r => r.blob()).then(b => { file = new File([b], '${file}', { type: 'image/png' }); });
  document.getElementById('share').onclick = async () => {
    if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: 'KHQR payment', text: 'Pay ${total}' }); } catch (e) {}
    } else {
      location.href = '${img}';
    }
  };
</script></body></html>`);
});

// Manual mode: your own merchant QR, rendered sharp from the KHQR string
app.get('/api/merchant-qr.png', wrap(async (req, res) => {
  if (MODE !== 'manual') throw new HttpError(404, 'Not found');
  const png = await QRCode.toBuffer(merchantQR.qr, { width: 720, margin: 0, errorCorrectionLevel: 'Q' });
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
  const png = await QRCode.toBuffer(order.qr, { width: 720, margin: 0, errorCorrectionLevel: 'Q' });
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
async function settlePayWay(order) {
  if (!order.md5) return false;
  const tx = await payway.checkTransaction(order.md5);
  if (!tx.paid) return false;
  const amountOk = toMinor(tx.amount) === order.total && (!tx.currency || tx.currency === order.currency);
  const firstTime = db.markPaid(order.id, { hash: order.md5, fromAccountId: 'ABA PayWay', amountOk });
  if (firstTime) {
    const paid = db.getOrder(order.id);
    console.log(`Order ${paid.id} paid via PayWay → #${paid.code}${amountOk ? '' : ' (AMOUNT MISMATCH)'}`);
    await notifyBaristaNewOrder(paid).catch((e) => console.error('Notify barista failed:', e.message));
    await notifyCustomer(paid);
  }
  return true;
}

async function checkAndSettle(order) {
  if (MODE === 'payway') return settlePayWay(order);
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
app.listen(PORT, () => console.log(`Mini app server on :${PORT}  (public URL: ${WEBAPP_URL.slice(0, 12)}…)  payment mode: ${MODE}${merchantQR ? ` → ${merchantQR.name}` : ''}${MODE === 'payway' ? ` → merchant ${process.env.PAYWAY_MERCHANT_ID} (${(process.env.PAYWAY_BASE || '').includes('sandbox') || !process.env.PAYWAY_BASE ? 'SANDBOX' : 'LIVE'})` : ''}`));

bot.api.setChatMenuButton({ menu_button: { type: 'web_app', text: 'Order', web_app: { url: WEBAPP_URL } } })
  .catch((e) => console.warn('Could not set menu button:', e.message));
bot.start({ onStart: (me) => console.log(`Bot @${me.username} running`) })
  .catch((e) => { console.error('Bot failed to start (check BOT_TOKEN):', e.message); process.exit(1); });
