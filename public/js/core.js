// Telegram setup, helpers, API, money and Telegram buttons
const tg = window.Telegram?.WebApp;
const BRAND = { paper: '#f4ead3', espresso: '#4b2e17', mustard: '#c9a12b', ink: '#1b1410' };
if (tg) {
  tg.ready(); tg.expand();
  try { tg.setHeaderColor(BRAND.paper); tg.setBackgroundColor(BRAND.paper); tg.setBottomBarColor?.(BRAND.paper); } catch {}
}

// No pinch / double-tap zoom (iOS ignores user-scalable=no, so block the gestures too)
['gesturestart', 'gesturechange', 'gestureend'].forEach((ev) => document.addEventListener(ev, (e) => e.preventDefault(), { passive: false }));
document.addEventListener('touchmove', (e) => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
try { tg?.disableVerticalSwipes?.(); } catch {} // swiping inside a sheet won't close the mini app

// Freeze the page behind a sheet so only the sheet scrolls
let lockedY = 0;
function lockScroll() {
  if (document.body.classList.contains('locked')) return;
  lockedY = window.scrollY;
  document.body.style.top = `-${lockedY}px`;
  document.body.classList.add('locked');
}
function unlockScroll() {
  if (!document.body.classList.contains('locked')) return;
  document.body.classList.remove('locked');
  document.body.style.top = '';
  window.scrollTo(0, lockedY);
}

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const haptic = (t) => { try { t === 'tap' ? tg.HapticFeedback.selectionChanged() : ['light','medium','heavy'].includes(t) ? tg.HapticFeedback.impactOccurred(t) : tg.HapticFeedback.notificationOccurred(t); } catch {} };
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

const state = { menu: null, cart: [], note: '', order: null, view: null, firstMenu: true };
let pollTimer = null, tickTimer = null, stickObserver = null, sheetHideTimer = null;

// Comic starburst, the same shape as the logo's background
function burst(fill, points = 16, stroke = BRAND.ink) {
  const pts = [];
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 ? 36 + (i % 4 === 1 ? 4 : 0) : 50;
    const a = (Math.PI * i) / points;
    pts.push((50 + r * Math.cos(a)).toFixed(1) + ',' + (50 + r * Math.sin(a)).toFixed(1));
  }
  return `<svg viewBox="-4 -4 108 108" aria-hidden="true"><polygon points="${pts.join(' ')}" fill="${fill}" stroke="${stroke}" stroke-width="2.5" stroke-linejoin="round"/></svg>`;
}

// ---------- API ----------
async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: 'tma ' + (tg?.initData || ''), ...(opts.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'No connection. Check your internet and try again.');
  return data;
}

// ---------- Money ----------
const minor = (v) => Math.round(v * (state.menu.currency === 'USD' ? 100 : 1));
const fmt = (m) => state.menu.currency === 'USD' ? '$' + (m / 100).toFixed(2) : m.toLocaleString('en-US') + '៛';

// ---------- Telegram buttons ----------
let mainHandler = null, backHandler = null;
function mainButton(text, onClick, { enabled = true } = {}) {
  if (!tg) return;
  if (mainHandler) tg.MainButton.offClick(mainHandler);
  if (!text) { tg.MainButton.hide(); mainHandler = null; return; }
  mainHandler = onClick;
  tg.MainButton.setParams({ text, is_active: enabled, is_visible: true, color: enabled ? BRAND.espresso : '#9c8a77', text_color: BRAND.paper });
  tg.MainButton.onClick(mainHandler);
}
function backButton(onClick) {
  if (!tg) return;
  if (backHandler) tg.BackButton.offClick(backHandler);
  backHandler = onClick || null;
  if (onClick) { tg.BackButton.onClick(onClick); tg.BackButton.show(); } else tg.BackButton.hide();
}
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 3200);
}
function stopTimers() { clearInterval(pollTimer); clearInterval(tickTimer); pollTimer = tickTimer = null; stickObserver?.disconnect(); }
