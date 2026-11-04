// Pickup ticket / order status screen
// ---------- Status / pickup ticket ----------
const FLOW = [['paid', 'Payment received'], ['preparing', 'Making your drinks'], ['ready', 'Ready at the counter'], ['picked_up', 'Picked up']];
function renderStatus(prevStatus) {
  const o = state.order;
  const idx = FLOW.findIndex(([s]) => s === o.status);
  const prevIdx = FLOW.findIndex(([s]) => s === prevStatus);
  const msg = { paid: 'You’re in the queue', preparing: 'Your drinks are being made', ready: 'Come and get it!', picked_up: 'Enjoy your Kafee' }[o.status] || '';
  const isDone = (i) => i === 0 || i < idx || (i === idx && o.status === 'picked_up'); // payment is done the moment we're here
  $('#app').innerHTML = `
    <div class="ticket-wrap" id="tw">
      ${burst(o.status === 'ready' ? '#5d7f2c' : BRAND.espresso, 18)}
      <div class="ticket">
        <div class="label">PICKUP NO.</div>
        <div class="code">${esc(o.code || '—')}</div>
        <div class="sub">${esc(msg)}</div>
      </div>
    </div>
    ${o.status === 'ready' ? '<div class="ready-banner">YOUR ORDER IS READY!</div>' : ''}
    <ol class="steps">
      ${FLOW.map(([s, label], i) => `<li class="${isDone(i) ? 'done' : i === idx ? 'now' : ''} ${isDone(i) && prevIdx >= 0 && i >= prevIdx && i > 0 ? 'fresh' : ''}">
        <span class="mark">${isDone(i) ? '✓' : ''}</span>${label}</li>`).join('')}
    </ol>
    <div class="receipt">
      ${o.items.map((it) => `<div><span>${it.qty}× ${esc(it.name)}${Object.keys(it.options).length ? `<br><small>${esc(Object.values(it.options).join(', '))}</small>` : ''}</span><span>${esc(it.subtotal)}</span></div>`).join('')}
      ${o.note ? `<div><small>Note: ${esc(o.note)}</small></div>` : ''}
      <div class="t"><span>PAID WITH KHQR</span><span>${esc(o.total)}</span></div>
    </div>
    ${['picked_up', 'ready'].includes(o.status) ? '' : '<p class="hint">We’ll also message you on Telegram when it’s ready.</p>'}
    ${o.status === 'picked_up' ? '' : visitCard('Pick up at', { hours: false })}
    <button class="help-link" id="help">Something wrong with your order? Get help</button>
    ${!tg && ['picked_up', 'ready'].includes(o.status) ? '<div class="actions"><button class="btn primary" id="again">Order something else</button></div>' : ''}
  `;
  const svg = $('#tw svg');
  if (!reduceMotion) {
    if (prevStatus && prevStatus !== o.status) { $('#tw').classList.add('pop'); }
    else svg.classList.add('spin');
  }
  if ($('#visit')) bindContact($('#visit'));
  $('#help').onclick = () => openSupport(o);
  const again = async () => { state.order = null; state.menu = await api('/api/menu'); go('menu', 'back'); };
  $('#again')?.addEventListener('click', again);
  backButton(null);
  mainButton(['picked_up', 'ready'].includes(o.status) ? 'ORDER SOMETHING ELSE' : null, again);
  if (!['picked_up', 'cancelled'].includes(o.status) && !pollTimer) pollTimer = setInterval(pollOrder, 5000);
}

function celebrate() {
  if (reduceMotion) return;
  $('#tw')?.classList.add('pop');
  $('#tw svg')?.classList.remove('spin');
}
