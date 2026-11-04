// Pay screens (Bakong KHQR and your own merchant QR), cancel, polling
// ---------- Pay ----------
function renderPay() {
  if (state.order.mode === 'manual') return renderManualPay();
  const o = state.order;
  mainButton(null);
  backButton(null);
  $('#app').innerHTML = `
    <div class="pay-wrap">
      <div class="khqr-stage">
        <div class="khqr" id="khqr" role="img" aria-label="KHQR: pay ${esc(o.total)} to ${esc(o.merchant)}">
          <div class="khqr-top">
            <img src="/khqr-logo.svg" alt="KHQR" onerror="this.outerHTML='<span class=&quot;khqr-word&quot;>KHQR</span>'" />
          </div>
          <div class="khqr-info">
            <div class="khqr-name">${esc(o.merchant)}</div>
            <div class="khqr-amount">${o.currency === 'USD' ? o.amount.toFixed(2) : o.amount.toLocaleString('en-US')}<small>${o.currency}</small></div>
          </div>
          <div class="khqr-sep"></div>
          <div class="khqr-qr"><div class="q">
            <img class="code" src="${o.qrUrl}" alt="" />
            <span class="mark" aria-hidden="true">${o.currency === 'USD' ? '$' : '៛'}</span>
          </div></div>
          <div class="khqr-expired-label">QR expired</div>
        </div>
      </div>
      <div class="timer" id="timer"></div>
      <div class="waiting" id="waiting"><img src="/logo-small.webp" alt="" />Waiting for your payment…</div>
      <div class="pay-actions" id="actions">
        ${o.deeplink ? `<button class="btn primary" id="openBank">Open my banking app</button>` : ''}
        <button class="btn ${o.deeplink ? '' : 'primary'}" id="saveQr">Save QR to photos</button>
        <button class="btn ghost" id="cancel">Cancel order</button>
      </div>
      <p class="hint">Paying from this phone? Save the QR, then choose “scan from gallery” in ABA, ACLEDA, Wing or any Bakong app.</p>
      <button class="help-link" id="help">Paid but stuck? Get help</button>
    </div>`;

  $('#openBank')?.addEventListener('click', () => tg ? tg.openLink(o.deeplink) : window.open(o.deeplink));
  $('#saveQr').onclick = () => {
    const url = location.origin + (o.cardUrl || o.qrUrl); // full KHQR card, not just the code
    if (tg?.isVersionAtLeast?.('8.0')) tg.downloadFile({ url, file_name: `KHQR-kafee-${o.id}.png` });
    else if (tg) tg.openLink(url);
    else window.open(url);
  };
  $('#cancel').onclick = () => cancelOrder('Cancel this order? Don’t cancel if you’ve already paid.');
  $('#help').onclick = () => openSupport(o);

  const tick = () => {
    const left = Math.max(0, o.expiresAt - Date.now());
    const mm = Math.floor(left / 60000), ss = String(Math.floor(left / 1000) % 60).padStart(2, '0');
    const t = $('#timer'); if (!t) return;
    t.textContent = left ? `QR expires in ${mm}:${ss}` : 'This QR has expired';
    t.classList.toggle('low', left > 0 && left < 60000);
    if (!left) showExpired();
  };
  tick(); tickTimer = setInterval(tick, 1000);
  pollTimer = setInterval(pollOrder, 3000);
}

// ---------- Manual payment: your own ABA / KHQR merchant QR ----------
const amountText = (o) => o.currency === 'USD' ? o.amount.toFixed(2) : o.amount.toLocaleString('en-US');
function renderManualPay() {
  const o = state.order;
  backButton(null);
  if (o.status === 'awaiting_confirmation') {
    mainButton(null);
    $('#app').innerHTML = `
      <div class="checking">
        <img src="/logo-small.webp" alt="" />
        <h2>Checking your payment</h2>
        <p>The barista is confirming your payment in the bank app. This usually takes under a minute.</p>
        <div class="amt">${esc(o.total)}</div>
        <button class="help-link" id="help">Taking too long? Get help</button>
        <div class="actions"><button class="btn ghost" id="cancelWait">Cancel order (only if you didn’t pay)</button></div>
      </div>`;
    $('#cancelWait').onclick = () => cancelOrder('Cancel this order? Only cancel if you did NOT pay.');
    $('#help').onclick = () => openSupport(o);
    pollTimer = setInterval(pollOrder, 3000);
    return;
  }

  const money = o.currency === 'USD' ? '$' + amountText(o) : amountText(o) + '៛';
  $('#app').innerHTML = `
    <div class="pay-wrap">
      ${o.rejectedCount ? `<div class="warn">We couldn’t find your payment yet. Check your bank app shows <u>${esc(money)}</u> paid to ${esc(o.merchant)}, then tap “I’ve paid” again.</div>` : ''}
      <div class="pay-amount">
        <div class="lbl">PAY EXACTLY</div>
        <div class="big">${esc(money)}</div><br>
        ${o.amountInQr ? '' : '<button class="copy" id="copyAmt">Copy amount</button>'}
      </div>
      <div class="khqr-stage">
        <div class="khqr ${o.amountInQr ? '' : 'static'}" id="khqr" role="img" aria-label="KHQR for ${esc(o.merchant)}">
          <div class="khqr-top">
            <img src="/khqr-logo.svg" alt="KHQR" onerror="this.outerHTML='<span class=&quot;khqr-word&quot;>KHQR</span>'" />
          </div>
          <div class="khqr-info"><div class="khqr-name">${esc(o.merchant)}</div>${o.amountInQr ? `<div class="khqr-amount">${amountText(o)}<small>${o.currency}</small></div>` : ''}</div>
          <div class="khqr-sep"></div>
          <div class="khqr-qr"><div class="q">
            <img class="code" src="${o.qrUrl}" alt="" />
            <span class="mark" aria-hidden="true">${o.qrCurrency === 'KHR' ? '៛' : '$'}</span>
          </div></div>
          <div class="khqr-expired-label">Time’s up</div>
        </div>
      </div>
      <ol class="pay-steps">
        <li>Scan this QR, or save it and scan from gallery</li>
        <li>${o.amountInQr ? `Check the amount is ${esc(money)} and pay` : `Type ${esc(money)} in your bank app and pay`}</li>
        <li>Come back and tap “I’ve paid”</li>
      </ol>
      <div class="timer" id="timer"></div>
      <div class="pay-actions" id="actions">
        ${!tg ? `<button class="btn dark" id="paidBtn">I’ve paid ${esc(money)}</button>` : ''}
        <button class="btn" id="saveQr">Save QR to photos</button>
        <button class="btn ghost" id="cancel">Cancel order</button>
      </div>
      <button class="help-link" id="help">Paid but stuck? Get help</button>
    </div>`;
  $('#help').onclick = () => openSupport(o);

  const claim = async () => {
    const ok = await new Promise((r) => tg?.showConfirm
      ? tg.showConfirm(`Did you pay ${money} to ${o.merchant}?`, r)
      : r(confirm(`Did you pay ${money}?`)));
    if (!ok) return;
    tg?.MainButton.showProgress();
    try {
      state.order = await api(`/api/orders/${o.id}/claim-paid`, { method: 'POST' });
      haptic('medium');
      go('pay', 'up');
    } catch (e) { toast(e.message); }
    finally { tg?.MainButton.hideProgress(); }
  };
  mainButton(`I’VE PAID ${money}`, claim);
  $('#paidBtn')?.addEventListener('click', claim);
  if ($('#copyAmt')) $('#copyAmt').onclick = async () => {
    try { await navigator.clipboard.writeText(amountText(o).replace(/,/g, '')); toast('Amount copied'); haptic('light'); }
    catch { toast(`Type ${money} in your bank app`); }
  };
  $('#saveQr').onclick = () => {
    const url = location.origin + (o.cardUrl || o.qrUrl); // full KHQR card, not just the code
    if (tg?.isVersionAtLeast?.('8.0')) tg.downloadFile({ url, file_name: `KHQR-kafee-${o.id}.png` });
    else if (tg) tg.openLink(url);
    else window.open(url);
  };
  $('#cancel').onclick = () => cancelOrder('Cancel this order? Don’t cancel if you’ve already paid. Tap “I’ve paid” instead.');

  const tick = () => {
    const left = Math.max(0, o.expiresAt - Date.now());
    const mm = Math.floor(left / 60000), ss = String(Math.floor(left / 1000) % 60).padStart(2, '0');
    const t = $('#timer'); if (!t) return;
    t.textContent = left ? `Pay within ${mm}:${ss}` : 'Time’s up for this order';
    t.classList.toggle('low', left > 0 && left < 60000);
    if (!left) showExpired();
  };
  tick(); tickTimer = setInterval(tick, 1000);
  pollTimer = setInterval(pollOrder, 5000);
}

async function cancelOrder(question) {
  const ok = await new Promise((r) => tg?.showConfirm ? tg.showConfirm(question, r) : r(confirm(question)));
  if (!ok) return;
  try { state.order = await api(`/api/orders/${state.order.id}/cancel`, { method: 'POST' }); }
  catch (e) { return toast(e.message); }
  if (state.order.status === 'cancelled') { toast('Order cancelled'); go('cart', 'back'); }
  else go('status'); // the payment had already arrived
}

function showExpired() {
  clearInterval(tickTimer);
  $('#khqr')?.classList.add('expired');
  $('#waiting')?.classList.add('hidden');
  const manual = state.order.mode === 'manual';
  if (manual) mainButton(null);
  $('#actions').innerHTML = `${manual ? '<button class="btn dark" id="paidLate">I already paid</button>' : ''}<button class="btn primary" id="regen">${manual ? 'I still want to order' : 'Get a new QR'}</button><button class="btn ghost" id="cancel2">Cancel order</button>`;
  $('#paidLate')?.addEventListener('click', async () => {
    try { state.order = await api(`/api/orders/${state.order.id}/claim-paid`, { method: 'POST' }); go('pay', 'up'); }
    catch (e) { toast(e.message); }
  });
  $('#regen').onclick = async () => {
    try { state.order = await api(`/api/orders/${state.order.id}/regenerate`, { method: 'POST' }); haptic('light'); go(state.order.status === 'pending_payment' ? 'pay' : 'status', 'up'); }
    catch (e) { toast(e.message); }
  };
  $('#cancel2').onclick = () => cancelOrder('Cancel this order?');
}

async function pollOrder() {
  try {
    const prev = state.order.status;
    const o = await api(`/api/orders/${state.order.id}`);
    state.order = o;
    if (state.view === 'pay' && !['pending_payment', 'expired', 'awaiting_confirmation', 'cancelled'].includes(o.status)) {
      haptic('success'); state.cart = []; state.note = '';
      go('status', 'up'); celebrate();
    } else if (state.view === 'pay' && o.status !== prev && o.status === 'pending_payment') {
      haptic('warning'); go('pay', 'up'); // barista couldn't find the payment
    } else if (state.view === 'status' && o.status !== prev) {
      if (o.status === 'ready') haptic('success');
      renderStatus(prev);
    }
  } catch {}
}
