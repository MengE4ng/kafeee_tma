// The live menu, stored in the database so the shop owner can edit it from the app.
// On the very first start it is filled from src/menu.js; after that src/menu.js is not used.
const db = require('./db');

const raw = db.raw;
raw.exec(`
CREATE TABLE IF NOT EXISTS menu_items (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL, price REAL NOT NULL,
  emoji TEXT, desc TEXT, options_json TEXT NOT NULL DEFAULT '[]', sort INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS menu_options (
  id TEXT PRIMARY KEY, label TEXT NOT NULL, default_choice TEXT, choices_json TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0
);
`);

// ---- first start: import src/menu.js ----
if (raw.prepare('SELECT COUNT(*) AS n FROM menu_items').get().n === 0) {
  const seed = require('./menu');
  const insItem = raw.prepare('INSERT INTO menu_items (id, name, category, price, emoji, desc, options_json, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  seed.items.forEach((i, n) => insItem.run(i.id, i.name, i.category, i.price, i.emoji || '', i.desc || '', JSON.stringify(i.options || []), n));
  const insOpt = raw.prepare('INSERT OR IGNORE INTO menu_options (id, label, default_choice, choices_json, sort) VALUES (?, ?, ?, ?, ?)');
  Object.entries(seed.optionGroups).forEach(([id, g], n) => insOpt.run(id, g.label, g.default, JSON.stringify(g.choices), n));
  console.log(`Menu imported from src/menu.js (${seed.items.length} items). Edit it in the app from now on.`);
}

let cache = null;
const invalidate = () => { cache = null; };

// Same shape the app always used: { items, categories, optionGroups }
function getMenu({ includeHidden = false } = {}) {
  if (!cache) {
    const items = raw.prepare('SELECT * FROM menu_items ORDER BY sort, rowid').all().map((r) => ({
      id: r.id, name: r.name, category: r.category, price: r.price, emoji: r.emoji, desc: r.desc,
      options: JSON.parse(r.options_json), hidden: Boolean(r.hidden), sort: r.sort,
    }));
    const optionGroups = {};
    for (const r of raw.prepare('SELECT * FROM menu_options ORDER BY sort, rowid').all()) {
      optionGroups[r.id] = { label: r.label, default: r.default_choice, choices: JSON.parse(r.choices_json), sort: r.sort };
    }
    const saved = db.getSetting('categoryOrder', []);
    const cats = [...new Set(items.map((i) => i.category))];
    const categories = [...saved.filter((c) => cats.includes(c)), ...cats.filter((c) => !saved.includes(c))];
    cache = { items, optionGroups, categories };
  }
  if (includeHidden) return cache;
  const items = cache.items.filter((i) => !i.hidden);
  return { ...cache, items, categories: cache.categories.filter((c) => items.some((i) => i.category === c)) };
}

// ---- validation helpers ----
class MenuError extends Error {}
const str = (v, field, min, max) => {
  const s = String(v ?? '').trim();
  if (s.length < min || s.length > max) throw new MenuError(`${field} must be ${min}–${max} characters`);
  return s;
};
const money = (v, field) => {
  const n = Math.round(Number(v) * 100) / 100;
  if (Number.isFinite(n) === false || n < 0 || n > 1000) throw new MenuError(`${field} must be a number between 0 and 1000`);
  return n;
};
const slug = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'item';
function uniqueId(base, table) {
  let id = base, n = 2;
  while (raw.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id)) id = `${base}-${n++}`;
  return id;
}

function saveItem(input) {
  const m = getMenu({ includeHidden: true });
  const name = str(input.name, 'Name', 1, 40);
  const category = str(input.category, 'Category', 1, 24);
  const price = money(input.price, 'Price');
  const emoji = str(input.emoji || '☕', 'Emoji', 1, 8);
  const desc = str(input.desc || '', 'Description', 0, 80);
  const options = (Array.isArray(input.options) ? input.options : []).filter((o) => m.optionGroups[o]);
  const hidden = input.hidden ? 1 : 0;
  if (input.id && raw.prepare('SELECT 1 FROM menu_items WHERE id = ?').get(input.id)) {
    raw.prepare('UPDATE menu_items SET name = ?, category = ?, price = ?, emoji = ?, desc = ?, options_json = ?, hidden = ? WHERE id = ?')
      .run(name, category, price, emoji, desc, JSON.stringify(options), hidden, input.id);
    invalidate();
    return input.id;
  }
  const id = uniqueId(slug(name), 'menu_items');
  const sort = (raw.prepare('SELECT MAX(sort) AS s FROM menu_items').get().s ?? 0) + 1;
  raw.prepare('INSERT INTO menu_items (id, name, category, price, emoji, desc, options_json, sort, hidden) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, name, category, price, emoji, desc, JSON.stringify(options), sort, hidden);
  invalidate();
  return id;
}

function deleteItem(id) {
  raw.prepare('DELETE FROM menu_items WHERE id = ?').run(id);
  invalidate();
}

function saveOption(input) {
  const label = str(input.label, 'Option name', 1, 24);
  const choices = (Array.isArray(input.choices) ? input.choices : []).map((c, i) => ({
    id: String(c.id || '').trim() || `c${i + 1}`,
    label: str(c.label, 'Choice name', 1, 24),
    add: money(c.add || 0, 'Extra price'),
  }));
  if (choices.length === 0 || choices.length > 12) throw new MenuError('An option needs 1–12 choices');
  const ids = new Set();
  choices.forEach((c) => { while (ids.has(c.id)) c.id += '-2'; ids.add(c.id); });
  const def = choices.some((c) => c.id === input.default) ? input.default : choices[0].id;
  if (input.id && raw.prepare('SELECT 1 FROM menu_options WHERE id = ?').get(input.id)) {
    raw.prepare('UPDATE menu_options SET label = ?, default_choice = ?, choices_json = ? WHERE id = ?')
      .run(label, def, JSON.stringify(choices), input.id);
    invalidate();
    return input.id;
  }
  const id = uniqueId(slug(label), 'menu_options');
  const sort = (raw.prepare('SELECT MAX(sort) AS s FROM menu_options').get().s ?? 0) + 1;
  raw.prepare('INSERT INTO menu_options (id, label, default_choice, choices_json, sort) VALUES (?, ?, ?, ?, ?)')
    .run(id, label, def, JSON.stringify(choices), sort);
  invalidate();
  return id;
}

function deleteOption(id) {
  raw.prepare('DELETE FROM menu_options WHERE id = ?').run(id);
  // remove it from every drink that used it
  for (const r of raw.prepare('SELECT id, options_json FROM menu_items').all()) {
    const opts = JSON.parse(r.options_json);
    if (opts.includes(id)) raw.prepare('UPDATE menu_items SET options_json = ? WHERE id = ?').run(JSON.stringify(opts.filter((o) => o !== id)), r.id);
  }
  invalidate();
}

function reorder({ items, categories }) {
  if (Array.isArray(items)) {
    const st = raw.prepare('UPDATE menu_items SET sort = ? WHERE id = ?');
    items.forEach((id, n) => st.run(n, String(id)));
  }
  if (Array.isArray(categories)) db.setSetting('categoryOrder', categories.map(String).slice(0, 50));
  invalidate();
}

module.exports = { getMenu, saveItem, deleteItem, saveOption, deleteOption, reorder, MenuError };
