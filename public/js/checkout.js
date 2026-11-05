// Cart screen and placing the order
// ---------- Cart ----------
function renderCart() {
  backButton(() => go('menu'));
  if (!state.cart.length) {
    $('#app').innerHTML = `<h1 class="page-title">Your order</h1>
      <div class="empty"><img src="/logo-mark.png" alt="" /><p>Your cup is empty. Pick something from the menu.</p>
      <div class="actions"><button class="btn primary" id="toMenu">See the menu</button></div></div>`;
    $('#toMenu').onclick = () => go('menu');
    mainButton(null);
    return;
  }
  $('#app').innerHTML = `
    <h1 class="page-title">Your order</h1>
    <div class="board">
      ${state.cart.map((l, idx) => {
        const it = itemById(l.id);
        return `<div class="cart-line" data-line="${idx}">
          <span class="ico ${catClass(it.category)}" aria-hidden="true">${it.emoji}</span>
          <div style="min-width:0"><div class="nm">${esc(it.name)}</div>
            <div class="opts">${esc(optionSummary(it, l.options) || '20oz')}</div>
            <div class="pr">${fmt(unitPrice(it, l.options) * l.qty)}</div></div>
          <span class="stepper"><button data-i="${idx}" data-d="-1" aria-label="Remove one">−</button><span>${l.qty}</span><button data-i="${idx}" data-d="1" aria-label="Add one">+</button></span>
        </div>`;
      }).join('')}
    </div>
    <textarea class="note" id="note" maxlength="200" placeholder="Note for the barista (optional), e.g. “less sweet” or “I’ll pick up at 8:30”">${esc(state.note)}</textarea>
    <div class="total-line"><span>Total</span><span id="total">${fmt(cartTotal())}</span></div>
    ${!tg ? '<div class="actions"><button class="btn dark" id="payBtn">Pay with KHQR</button></div>' : ''}
  `;
  $('#note').oninput = (e) => state.note = e.target.value;
  $$('[data-d]').forEach((b) => b.onclick = () => {
    const i = +b.dataset.i, l = state.cart[i];
    haptic('tap');
    if (l.qty + +b.dataset.d <= 0) {
      const el = $(`[data-line="${i}"]`);
      el.classList.add('out');
      setTimeout(() => { state.cart.splice(i, 1); renderCart(); }, reduceMotion ? 0 : 240);
      return;
    }
    l.qty += +b.dataset.d; renderCart();
  });
  const label = state.menu.open ? `PAY ${fmt(cartTotal())} WITH KHQR` : 'SHOP IS CLOSED';
  mainButton(label, placeOrder, { enabled: state.menu.open });
  $('#payBtn')?.addEventListener('click', placeOrder);
}

async function placeOrder() {
  if (!state.menu.open) return;
  if (tg && tg.initDataUnsafe?.user && !tg.initDataUnsafe.user.allows_write_to_pm && tg.isVersionAtLeast?.('6.9')) {
    await new Promise((r) => tg.requestWriteAccess(() => r()));
  }
  tg?.MainButton.showProgress();
  try {
    state.order = await api('/api/orders', {
      method: 'POST',
      body: JSON.stringify({ items: state.cart.map(({ id, qty, options }) => ({ id, qty, options })), note: state.note }),
    });
    haptic('medium');
    go('pay');
  } catch (e) {
    haptic('error'); toast(e.message);
    if (/sold out|menu/i.test(e.message)) state.menu = await api('/api/menu');
  } finally {
    tg?.MainButton.hideProgress();
  }
}
