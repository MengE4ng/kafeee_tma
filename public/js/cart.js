// Cart helpers (prices, options, totals)
// ---------- Cart helpers ----------
const itemById = (id) => state.menu.items.find((i) => i.id === id);
const activeGroups = (item, opts) => item.options.filter((g) => !(g === 'ice' && opts.temp === 'hot'));
function unitPrice(item, opts) {
  return activeGroups(item, opts).reduce((p, g) => {
    const c = state.menu.optionGroups[g].choices.find((c) => c.id === opts[g]);
    return p + minor(c?.add || 0);
  }, minor(item.price));
}
function optionSummary(item, opts) {
  return activeGroups(item, opts).map((g) => {
    const c = state.menu.optionGroups[g].choices.find((c) => c.id === opts[g]);
    return c ? (c.summary || c.label) : '';
  }).filter(Boolean).join(', ');
}
const cartCount = () => state.cart.reduce((s, l) => s + l.qty, 0);
const cartTotal = () => state.cart.reduce((s, l) => s + unitPrice(itemById(l.id), l.options) * l.qty, 0);
function addToCart(id, opts, qty) {
  const clean = Object.fromEntries(activeGroups(itemById(id), opts).map((g) => [g, opts[g]]));
  const key = id + '|' + JSON.stringify(clean);
  const existing = state.cart.find((l) => l.key === key);
  existing ? existing.qty += qty : state.cart.push({ key, id, options: clean, qty });
}
const catClass = (cat) => cat.toLowerCase().includes('matcha') ? 'matcha' : 'coffee';
