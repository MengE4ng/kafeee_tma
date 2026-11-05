// Pay screens (Bakong KHQR and your own merchant QR), cancel, polling
// ---------- Pay ----------
// "Share or save QR": opens the phone's share sheet with the KHQR card image, so the customer can
// send it to their banking app (if it accepts images) or save it to photos. The image is loaded in
// advance because phones only allow the share sheet right after a tap.
// A soft "QR-shaped" placeholder: three finder squares, scattered dots, and a centre circle.
// Built once with a fixed seed, so it looks the same every time.
const QR_SKELETON = (() => {
  const N = 29, cells = [];
  let seed = 7;
  const rand = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
  const inFinder = (x, y) => (x < 8 && y < 8) || (x > N - 9 && y < 8) || (x < 8 && y > N - 9);
  const inCentre = (x, y) => (x - 14) ** 2 + (y - 14) ** 2 < 18;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    if (!inFinder(x, y) && !inCentre(x, y) && rand() < 0.42) cells.push(`<rect x="${x + 0.12}" y="${y + 0.12}" width=".76" height=".76" rx=".22"/>`);
  }
  const finder = (x, y) => `<rect x="${x + 0.5}" y="${y + 0.5}" width="6" height="6" rx="1.6" fill="none" stroke="currentColor" stroke-width="1"/><rect x="${x + 2}" y="${y + 2}" width="3" height="3" rx=".8"/>`;
  return `<svg viewBox="0 0 ${N} ${N}" aria-hidden="true"><g class="dots">${cells.join('')}</g><g class="finders">${finder(0, 0)}${finder(N - 7, 0)}${finder(0, N - 7)}</g><circle class="centre" cx="14.5" cy="14.5" r="3.4"/></svg>`;
})();

// QR image: shimmer skeleton while it loads, and a retry button if it fails (slow network / server waking up)
function qrFailed(img) { img.parentNode.classList.add('failed'); }
function qrRetry(btn) {
  const q = btn.parentNode, img = q.querySelector('img.code');
  q.classList.remove('failed'); q.classList.add('loading');
  img.src = img.src.replace(/([?&])r=\d+/, '').replace(/$/, (img.src.includes('?') ? '&' : '?') + 'r=' + Date.now());
}

function setupSaveQr(o) {
  const btn = $('#saveQr');
  if (!btn) return;
  const url = location.origin + (o.cardUrl || o.qrUrl); // full KHQR card, not just the code
  const name = `KHQR-kafee-${o.id}.png`;
  let file = null;
  if (navigator.canShare) {
    fetch(url).then((r) => r.blob()).then((b) => {
      const f = new File([b], name, { type: 'image/png' });
      if (navigator.canShare({ files: [f] })) file = f;
    }).catch(() => {});
  }
  const download = () => {
    if (tg?.isVersionAtLeast?.('8.0')) tg.downloadFile({ url, file_name: name });
    else if (tg) tg.openLink(url);
    else window.open(url);
  };
  btn.onclick = async () => {
    haptic('light');
    if (file) {
      try {
        await navigator.share({ files: [file], title: 'KHQR payment', text: `Pay ${o.total} to ${o.merchant}` });
        toast('After paying, come back and tap “I’ve paid”.');
        return;
      } catch (e) {
        if (e.name === 'AbortError') return; // customer closed the share sheet
      }
    }
    // Android Telegram can't open the share sheet: open a share page in the phone's browser instead
    if (tg && tg.platform === 'android' && o.shareUrl) {
      tg.openLink(location.origin + o.shareUrl);
      toast('Tap “Share to my banking app” on the next screen.');
      return;
    }
    download(); // no share sheet available: save the image instead
  };
}

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
            <img src="/khqr-logo.svg" alt="KHQR" onerror="if (this.src.endsWith('.svg')) { this.src = '/khqr-logo.png'; } else { this.outerHTML = '<span class=&quot;khqr-word&quot;>KHQR</span>'; }" />
          </div>
          <div class="khqr-info">
            <div class="khqr-name">${esc(o.merchant)}</div>
            <div class="khqr-amount">${o.currency === 'USD' ? o.amount.toFixed(2) : o.amount.toLocaleString('en-US')}<small>${o.currency}</small></div>
          </div>
          <div class="khqr-sep"></div>
          <div class="khqr-qr"><div class="q loading"><div class="qr-skel">${QR_SKELETON}</div>
            <img class="code" src="${o.qrUrl}" alt="" onload="this.parentNode.classList.remove('loading', 'failed')" onerror="qrFailed(this)" />
            <button class="qr-retry" onclick="qrRetry(this)">Couldn’t load the QR. Tap to try again</button>
            <span class="mark" aria-hidden="true">${o.currency === 'USD' ? '$' : '៛'}<img src="/khqr-center.svg" alt="" onerror="if (this.src.endsWith('.svg')) { this.src = '/khqr-center.png'; } else { this.remove(); }" /></span>
          </div></div>
          <div class="khqr-expired-label">QR expired</div>
        </div>
      </div>
      <div class="timer" id="timer"></div>
      <div class="waiting" id="waiting"><img src="/logo-mark.png" alt="" />Waiting for your payment…</div>
      <div class="pay-actions" id="actions">
        ${o.deeplink ? `<button class="btn primary" id="openBank">Open my banking app</button>` : ''}
        <button class="btn ${o.deeplink ? '' : 'primary'}" id="saveQr">Share or save QR</button>
        <button class="btn ghost" id="cancel">Cancel order</button>
      </div>
      <p class="hint">Paying from this phone? Tap “Share or save QR” and pick your banking app, or save it and choose “scan from gallery”.</p>
      <button class="help-link" id="help">Paid but stuck? Get help</button>
    </div>`;

  $('#openBank')?.addEventListener('click', () => tg ? tg.openLink(o.deeplink) : window.open(o.deeplink));
  setupSaveQr(o);
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
        <img src="/logo-mark.png" alt="" />
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
            <img src="/khqr-logo.svg" alt="KHQR" onerror="if (this.src.endsWith('.svg')) { this.src = '/khqr-logo.png'; } else { this.outerHTML = '<span class=&quot;khqr-word&quot;>KHQR</span>'; }" />
          </div>
          <div class="khqr-info"><div class="khqr-name">${esc(o.merchant)}</div>${o.amountInQr ? `<div class="khqr-amount">${amountText(o)}<small>${o.currency}</small></div>` : ''}</div>
          <div class="khqr-sep"></div>
          <div class="khqr-qr"><div class="q loading"><div class="qr-skel">${QR_SKELETON}</div>
            <img class="code" src="${o.qrUrl}" alt="" onload="this.parentNode.classList.remove('loading', 'failed')" onerror="qrFailed(this)" />
            <button class="qr-retry" onclick="qrRetry(this)">Couldn’t load the QR. Tap to try again</button>
            <span class="mark" aria-hidden="true">${o.qrCurrency === 'KHR' ? '៛' : '$'}<img src="/khqr-center.svg" alt="" onerror="if (this.src.endsWith('.svg')) { this.src = '/khqr-center.png'; } else { this.remove(); }" /></span>
          </div></div>
          <div class="khqr-expired-label">Time’s up</div>
        </div>
      </div>
      <ol class="pay-steps">
        <li>Scan this QR, or tap “Share or save QR” and pick your banking app</li>
        <li>${o.amountInQr ? `Check the amount is ${esc(money)} and pay` : `Type ${esc(money)} in your bank app and pay`}</li>
        <li>Come back and tap “I’ve paid”</li>
      </ol>
      <div class="timer" id="timer"></div>
      <div class="pay-actions" id="actions">
        ${!tg ? `<button class="btn dark" id="paidBtn">I’ve paid ${esc(money)}</button>` : ''}
        <button class="btn" id="saveQr">Share or save QR</button>
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
  setupSaveQr(o);
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
  else { toast('This order is already paid. Here’s your pickup number.'); go('status', 'up'); } // payment had already been confirmed
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
    if (state.view === 'pay' && o.status === 'cancelled') {
      toast('This order was cancelled.'); go('cart', 'back');
    } else if (state.view === 'pay' && !['pending_payment', 'expired', 'awaiting_confirmation', 'cancelled'].includes(o.status)) {
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
