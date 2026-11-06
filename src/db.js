// Uses Node's built-in SQLite (Node 22.13+), so nothing has to be compiled on install.
const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync(process.env.DB_PATH || './data.db');
db.exec('PRAGMA journal_mode = WAL');

// Small helper: run fn inside a transaction (node:sqlite has no db.transaction()).
const transaction = (fn) => (...args) => {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn(...args);
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
};

db.exec(`
CREATE TABLE IF NOT EXISTS orders (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  code           TEXT,                 -- pickup number, assigned when paid (e.g. "007")
  user_id        INTEGER NOT NULL,
  user_name      TEXT,
  username       TEXT,
  items_json     TEXT NOT NULL,
  note           TEXT,
  total          INTEGER NOT NULL,     -- minor units (cents for USD, riel for KHR)
  currency       TEXT NOT NULL,
  status         TEXT NOT NULL,        -- pending_payment | awaiting_confirmation | paid | preparing | ready | picked_up | expired | cancelled
  qr             TEXT,
  md5            TEXT,
  qr_expires_at  INTEGER,
  deeplink       TEXT,
  tx_hash        TEXT,
  tx_from        TEXT,
  amount_ok      INTEGER,
  barista_msg_id INTEGER,
  created_at     INTEGER NOT NULL,
  paid_at        INTEGER,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
`);

// Columns added for manual payment mode (safe to run on an existing database)
for (const col of ['claimed_at INTEGER', 'rejected_count INTEGER DEFAULT 0', 'claim_ref TEXT', 'claim_photo TEXT']) {
  try { db.exec(`ALTER TABLE orders ADD COLUMN ${col}`); } catch { /* already exists */ }
}

const now = () => Date.now();

function getSetting(key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : fallback;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}

const isOpen = () => getSetting('open', true);
const setOpen = (v) => setSetting('open', !!v);
const soldOut = () => new Set(getSetting('soldOut', []));
function setSoldOut(itemId, isSoldOut) {
  const s = soldOut();
  isSoldOut ? s.add(itemId) : s.delete(itemId);
  setSetting('soldOut', [...s]);
}

function createOrder({ userId, userName, username, items, note, total, currency }) {
  const t = now();
  const info = db.prepare(`
    INSERT INTO orders (user_id, user_name, username, items_json, note, total, currency, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending_payment', ?, ?)
  `).run(userId, userName ?? null, username ?? null, JSON.stringify(items), note ?? null, total, currency, t, t);
  return Number(info.lastInsertRowid);
}

function setQR(id, { qr, md5, expiresAt, deeplink }) {
  db.prepare(`UPDATE orders SET qr = ?, md5 = ?, qr_expires_at = ?, deeplink = ?, status = 'pending_payment', updated_at = ? WHERE id = ?`)
    .run(qr, md5, expiresAt, deeplink || null, now(), id);
}

function getOrder(id) {
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (o) o.items = JSON.parse(o.items_json);
  return o;
}

function activeOrderForUser(userId) {
  const o = db.prepare(`
    SELECT id FROM orders
    WHERE user_id = ? AND status IN ('pending_payment','awaiting_confirmation','paid','preparing','ready')
    ORDER BY id DESC LIMIT 1
  `).get(userId);
  return o ? getOrder(o.id) : null;
}

const pendingPayments = () =>
  db.prepare(`SELECT * FROM orders WHERE status = 'pending_payment' AND md5 IS NOT NULL`).all();

// Atomically marks an order paid and assigns today's pickup number.
// Returns true only for the first caller, so the barista is never notified twice.
const markPaid = transaction((id, { hash, fromAccountId, amountOk }) => {
  const order = db.prepare(`SELECT status FROM orders WHERE id = ?`).get(id);
  if (!order || !['pending_payment', 'awaiting_confirmation', 'expired', 'cancelled'].includes(order.status)) return false;
  const { n } = db.prepare(`
    SELECT COUNT(*) AS n FROM orders
    WHERE code IS NOT NULL AND date(paid_at / 1000, 'unixepoch', 'localtime') = date('now', 'localtime')
  `).get();
  const code = String(n + 1).padStart(3, '0');
  db.prepare(`
    UPDATE orders SET status = 'paid', code = ?, tx_hash = ?, tx_from = ?, amount_ok = ?, paid_at = ?, updated_at = ?
    WHERE id = ?
  `).run(code, hash, fromAccountId, amountOk ? 1 : 0, now(), now(), id);
  return true;
});

function setStatus(id, status) {
  db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), id);
}
function setBaristaMsg(id, msgId) {
  db.prepare('UPDATE orders SET barista_msg_id = ? WHERE id = ?').run(msgId, id);
}

// ---- Manual payment mode ----
// Customer tapped "I've paid": wait for the barista to check the bank app.
function claimPaid(id) {
  const r = db.prepare(`
    UPDATE orders SET status = 'awaiting_confirmation', claimed_at = ?, updated_at = ?
    WHERE id = ? AND status IN ('pending_payment', 'expired')
  `).run(now(), now(), id);
  return r.changes > 0;
}
// Barista couldn't find the money: give the customer another chance to pay.
function rejectPayment(id, ttlMs) {
  const r = db.prepare(`
    UPDATE orders SET status = 'pending_payment', rejected_count = COALESCE(rejected_count, 0) + 1,
      claim_ref = NULL, claim_photo = NULL, qr_expires_at = ?, updated_at = ?
    WHERE id = ? AND status = 'awaiting_confirmation'
  `).run(now() + ttlMs, now(), id);
  return r.changes > 0;
}
// Proof the customer gave with "I've paid": transaction ID and/or the Telegram file id of their screenshot
function setClaimProof(id, ref, photoId) {
  db.prepare('UPDATE orders SET claim_ref = COALESCE(?, claim_ref), claim_photo = COALESCE(?, claim_photo) WHERE id = ?').run(ref || null, photoId || null, id);
}
// How many "I've paid" claims of this customer were marked "Not received" in the last 24 hours
function recentRejections(userId) {
  return db.prepare('SELECT COALESCE(SUM(rejected_count), 0) AS n FROM orders WHERE user_id = ? AND updated_at > ?')
    .get(userId, now() - 24 * 3600 * 1000).n;
}
// Customer tapped "I've paid" by mistake and goes back to the QR (not counted as a failed payment)
function unclaim(id, ttlMs) {
  const r = db.prepare(`
    UPDATE orders SET status = 'pending_payment', claim_ref = NULL, claim_photo = NULL, qr_expires_at = ?, updated_at = ?
    WHERE id = ? AND status = 'awaiting_confirmation'
  `).run(now() + ttlMs, now(), id);
  return r.changes > 0;
}
function findOrderByPaymentRef(ref) {
  const r = db.prepare('SELECT id FROM orders WHERE md5 = ?').get(ref);
  return r ? getOrder(r.id) : null;
}
function extendDeadline(id, ttlMs) {
  db.prepare(`UPDATE orders SET status = 'pending_payment', qr_expires_at = ?, updated_at = ? WHERE id = ?`)
    .run(now() + ttlMs, now(), id);
}
const awaitingConfirmation = () =>
  db.prepare(`SELECT id FROM orders WHERE status = 'awaiting_confirmation' ORDER BY id`).all().map((r) => getOrder(r.id));

// Unpaid manual orders whose time ran out
function expireManualOrders(graceMs) {
  db.prepare(`
    UPDATE orders SET status = 'expired', updated_at = ?
    WHERE status = 'pending_payment' AND md5 IS NULL AND qr_expires_at < ?
  `).run(now(), now() - graceMs);
}

module.exports = {
  raw: db, getSetting, setSetting,
  findOrderByPaymentRef, claimPaid, rejectPayment, unclaim, setClaimProof, recentRejections, extendDeadline, expireManualOrders, awaitingConfirmation,
  isOpen, setOpen, soldOut, setSoldOut,
  createOrder, setQR, getOrder, activeOrderForUser, pendingPayments,
  markPaid, setStatus, setBaristaMsg,
};
