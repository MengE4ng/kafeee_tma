// Start-up
// ---------- Boot ----------
(async () => {
  const started = Date.now();
  try {
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
