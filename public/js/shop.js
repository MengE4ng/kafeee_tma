// Find us card, contact buttons and the Need help? panel
// ---------- Find us, contact & help ----------
const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY_NAMES = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
const shopInfo = () => state.menu?.shop || {};
const hasMap = (s) => s.lat != null && s.lng != null;
function todayKey(s) {
  try { return new Intl.DateTimeFormat('en-US', { timeZone: s.timezone, weekday: 'short' }).format(new Date()).toLowerCase().slice(0, 3); }
  catch { return DAY_KEYS[(new Date().getDay() + 6) % 7]; }
}
function directionsUrl(s) {
  return s.mapsUrl || (hasMap(s) ? `https://www.google.com/maps/search/?api=1&query=${s.lat},${s.lng}` : '');
}
function mapHtml(s) {
  if (!hasMap(s)) return '';
  const d = 0.004, e = 0.0025;
  const src = `https://www.openstreetmap.org/export/embed.html?bbox=${s.lng - d},${s.lat - e},${s.lng + d},${s.lat + e}&layer=mapnik&marker=${s.lat},${s.lng}`;
  return `<button class="map" data-act="dir" aria-label="Open directions"><iframe src="${src}" loading="lazy" tabindex="-1" title="Map"></iframe><span>DIRECTIONS</span></button>`;
}
function contactButtons(s, { directions = true } = {}) {
  const b = [];
  if (directions && directionsUrl(s)) b.push('<button class="btn primary" data-act="dir">📍 Directions</button>');
  if (s.phone) b.push('<button class="btn" data-act="call">📞 Call</button>');
  if (s.telegram) b.push('<button class="btn" data-act="msg">💬 Chat</button>');
  return b.length ? `<div class="contact-row">${b.join('')}</div>` : '';
}
function bindContact(root) {
  const s = shopInfo();
  $$('[data-act]', root).forEach((el) => el.onclick = () => {
    haptic('light');
    const act = el.dataset.act;
    if (act === 'dir') { const u = directionsUrl(s); tg ? tg.openLink(u) : window.open(u); }
    if (act === 'call') {
      navigator.clipboard?.writeText(s.phone).catch(() => {});
      toast(`Calling ${s.phone} (number copied)`);
      if (tg) tg.openLink(location.origin + '/call'); // opens the phone's browser, which starts the call
      else window.location.href = 'tel:' + s.phone.replace(/[^\d+]/g, '');
    }
    if (act === 'msg') { const u = `https://t.me/${s.telegram}`; tg ? tg.openTelegramLink(u) : window.open(u); }
  });
}
const to12h = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
const hoursText = (h) => (h ? `${to12h(h[0])} – ${to12h(h[1])}` : 'Closed');
function visitCard(title, { hours = true } = {}) {
  const s = shopInfo();
  const days = DAY_KEYS.filter((k) => k in (s.hours || {}));
  const today = todayKey(s);
  const sameEveryDay = days.length === 7 && days.every((k) => JSON.stringify(s.hours[k]) === JSON.stringify(s.hours.mon));
  const hoursHtml = !hours || days.length === 0 ? '' : sameEveryDay
    ? `<div class="hours"><span class="today">Every day</span><span class="today">${hoursText(s.hours.mon)}</span></div>`
    : `<div class="hours">${days.map((k) => {
      const cls = k === today ? 'today' : '';
      return `<span class="${cls}">${DAY_NAMES[k]}</span><span class="${cls}">${hoursText(s.hours[k])}</span>`;
    }).join('')}</div>`;
  const body = hoursHtml + (s.address ? `<p class="addr">${esc(s.address)}</p>` : '') + mapHtml(s) + contactButtons(s);
  return body ? `<section class="visit" id="visit"><h2>${title}</h2>${body}</section>` : '';
}

// Bottom panel (reuses the item sheet). Restores the Telegram buttons when closed.
function openPanel(inner, mount) {
  const sheet = $('#sheet'), scrim = $('#scrim');
  const saved = { main: mainHandler && tg ? { text: tg.MainButton.text, handler: mainHandler, enabled: tg.MainButton.isActive } : null, back: backHandler };
  mainButton(null);
  clearTimeout(sheetHideTimer);
  sheet.innerHTML = `<div class="grabber"></div>${inner}`;
  sheet.classList.remove('hidden'); scrim.classList.remove('hidden'); lockScroll(); sheet.scrollTop = 0;
  requestAnimationFrame(() => requestAnimationFrame(() => { sheet.classList.add('show'); scrim.classList.add('show'); }));
  const close = () => {
    sheet.classList.remove('show'); scrim.classList.remove('show');
    unlockScroll();
    sheetHideTimer = setTimeout(() => { sheet.classList.add('hidden'); scrim.classList.add('hidden'); }, 380);
    backButton(saved.back);
    if (saved.main) mainButton(saved.main.text, saved.main.handler, { enabled: saved.main.enabled });
  };
  scrim.onclick = close;
  backButton(close);
  mount?.(sheet, close);
}

function openSupport(order) {
  const s = shopInfo();
  const chat = s.telegram ? `<div style="margin-top:14px"><button class="btn primary" data-act="msg">💬 Chat with the barista on Telegram</button></div>` : '';
  const contacts = contactButtons({ ...s, telegram: '' }); // Directions + Call; chat is the big button above
  const where = s.address ? `<p class="addr" style="text-align:center">📍 ${esc(s.address)}</p>` : '';
  openPanel(`
    <h2 class="panel-title">Need help?</h2>
    <p class="panel-sub">${s.telegram ? 'Message us on Telegram and a barista will reply.' : 'Tell the barista what went wrong.'}</p>
    ${chat}
    ${contacts}
    ${where}
    ${order ? `
      <h3 class="panel-h3">Report a problem with this order</h3>
      <textarea class="note" id="reportMsg" maxlength="500" placeholder="e.g. I paid ${esc(order.total)} but the app still says checking"></textarea>
      <div style="margin-top:14px"><button class="btn dark" id="sendReport">Send to the barista</button></div>` : ''}
  `, (sheet, close) => {
    bindContact(sheet);
    $('#sendReport', sheet)?.addEventListener('click', async () => {
      const message = $('#reportMsg', sheet).value.trim();
      if (message.length < 2) return toast('Please write what went wrong.');
      try {
        await api(`/api/orders/${order.id}/report`, { method: 'POST', body: JSON.stringify({ message }) });
        haptic('success'); toast('Sent. A barista will get back to you.'); close();
      } catch (e) { haptic('error'); toast(e.message); }
    });
  });
}
