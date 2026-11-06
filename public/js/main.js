// Start-up
// ---------- Outside Telegram ----------
function showOpenInTelegram(username) {
  const link = username ? `https://t.me/${username}` : 'https://telegram.org';
  document.title = 'Kafee · Open in Telegram';
  $('#app').innerHTML = `
    <div class="outside">
      <img src="/logo.png" alt="Kafee" width="622" height="214" />
      <h1 class="caps">Order in Telegram</h1>
      <p>Kafee orders are placed inside our Telegram bot, so your order and payment stay linked to your Telegram account.</p>
      <a class="btn primary" href="${link}">Open ${username ? '@' + esc(username) : 'Telegram'}</a>
      <p class="hint">Then tap <b>Order</b> in the chat.</p>
    </div>`;
}

// ---------- Boot ----------
(async () => {
  const started = Date.now();
  try {
    // Opened as a normal website (not inside Telegram)? Show "Open in Telegram" instead of the shop.
    if (!tg?.initData) {
      const info = await fetch('/api/bot').then((r) => r.json()).catch(() => ({}));
      if (!info.dev) return showOpenInTelegram(info.username);
    }
    state.menu = await api('/api/menu');
    let active = null;
    if (tg?.initData || !tg) {
      active = await api('/api/orders/active').catch(() => null);
      state.isAdmin = Boolean((await api('/api/me').catch(() => null))?.isAdmin);
    }
    // let the splash land before switching
    await new Promise((r) => setTimeout(r, Math.max(0, (reduceMotion ? 0 : 700) - (Date.now() - started))));
    if (active) { state.order = active; return go(['pending_payment', 'awaiting_confirmation'].includes(active.status) ? 'pay' : 'status', 'up'); }
    go('menu', 'up');
  } catch (e) {
    $('#app').innerHTML = `<div class="empty"><img src="/logo-mark.png" alt="" /><p>${esc(e.message)}</p>
      <div class="actions"><button class="btn primary" onclick="location.reload()">Try again</button></div></div>`;
  }
})();
