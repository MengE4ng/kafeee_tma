// Menu screen and the drink sheet
// ---------- Menu ----------
function renderMenu() {
  const m = state.menu;
  const inCart = (id) => state.cart.filter((l) => l.id === id).reduce((s, l) => s + l.qty, 0);
  const intro = state.firstMenu && !reduceMotion;
  let rowIndex = 0;
  $('#app').innerHTML = `
    <header class="hero">
      <img src="/logo.png" alt="Kafee" class="${intro ? 'intro' : ''}" id="logo" width="622" height="214" />
      ${state.isAdmin ? '<div><button class="admin-link" id="openAdmin">⚙ Manage menu</button></div>' : ''}
      <div class="status-pill ${m.open ? '' : 'closed'}"><i></i>${m.open ? (m.closesAt ? `Open now · until ${m.closesAt}` : 'Open now · order ahead') : (m.opensAt ? `Closed · opens ${m.opensAt}` : 'Closed right now')}</div>
    </header>
    ${m.open ? '' : `<div class="closed-note">${m.opensAt ? `We’re closed now. Browse the menu, and order when we open ${esc(m.opensAt)}.` : 'You can look at the menu, but ordering opens when we do.'}</div>`}
    <nav class="bar" id="bar" role="tablist">
      <img class="mini" src="/logo-mark.png" alt="" />
      ${m.categories.map((c, i) => `<button class="tab" role="tab" aria-selected="${i === 0}" data-cat="${esc(c)}">${esc(c)}</button>`).join('')}
    </nav>
    <div class="board">
      ${m.categories.map((c) => `
        <h2 class="cat-title ${catClass(c)}" id="cat-${esc(c)}">${esc(c)}</h2>
        ${m.items.filter((i) => i.category === c).map((i) => {
          const n = inCart(i.id);
          return `<button class="row ${intro ? 'stagger' : ''}" style="animation-delay:${intro ? 350 + rowIndex++ * 60 : 0}ms" data-item="${i.id}" ${i.soldOut ? 'disabled' : ''}>
            <span class="ico ${catClass(i.category)}" aria-hidden="true">${i.emoji}${n ? `<span class="badge">${n}</span>` : ''}</span>
            <span class="line"><span class="nm">${esc(i.name)}</span><span class="dots"></span><span class="pr">${fmt(minor(i.price))}</span></span>
            <span class="desc">${i.soldOut ? 'Sold out today' : esc(i.desc)}</span>
          </button>`;
        }).join('')}`).join('')}
      <div class="oz"><span>ALL DRINKS 20OZ</span></div>
    </div>
    ${visitCard('Find us')}
  `;
  state.firstMenu = false;
  bindContact($('#visit') || document.createElement('div'));

  $$('[data-item]').forEach((b) => b.onclick = () => { haptic('light'); openSheet(b.dataset.item); });
  $('#openAdmin')?.addEventListener('click', () => { adminState.menu = null; go('admin'); });
  const logo = $('#logo');

  // Tabs scroll to category; highlight follows scroll
  $$('.tab').forEach((t) => t.onclick = () => {
    haptic('tap');
    document.getElementById('cat-' + t.dataset.cat).scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth' });
  });
  const bar = $('#bar');
  stickObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.target === logo) bar.classList.toggle('stuck', !e.isIntersecting);
      else if (e.isIntersecting) $$('.tab').forEach((t) => t.setAttribute('aria-selected', 'cat-' + t.dataset.cat === e.target.id));
    }
  }, { rootMargin: '-70px 0px -55% 0px' });
  stickObserver.observe(logo);
  $$('.cat-title').forEach((h) => stickObserver.observe(h));

  backButton(null);
  updateCartButton();
}
function updateCartButton() {
  const n = cartCount();
  mainButton(n ? `VIEW ORDER · ${n} · ${fmt(cartTotal())}` : null, () => go('cart'));
  if (!tg && n) {
    let b = $('#devCart');
    if (!b) { $('.board').insertAdjacentHTML('afterend', '<div class="actions"><button class="btn dark" id="devCart"></button></div>'); b = $('#devCart'); b.onclick = () => go('cart'); }
    b.textContent = `View order · ${n} · ${fmt(cartTotal())}`;
  }
}

function openSheet(id) {
  const item = itemById(id);
  const groups = state.menu.optionGroups;
  const sel = Object.fromEntries(item.options.map((g) => [g, groups[g].default]));
  let qty = 1;
  const sheet = $('#sheet'), scrim = $('#scrim');

  sheet.innerHTML = `
    <div class="grabber"></div>
    <div class="sheet-hero"><span class="big" aria-hidden="true">${item.emoji}</span></div>
    <h2>${esc(item.name)}</h2>
    <div class="sub">${esc(item.desc)} · 20oz · ${fmt(minor(item.price))}</div>
    <div id="opts"></div>
    <div class="qty-line"><strong>Quantity</strong>
      <span class="stepper"><button data-q="-1" aria-label="Fewer">−</button><span id="qty">1</span><button data-q="1" aria-label="More">+</button></span>
    </div>
    ${tg ? '' : '<div style="margin-top:20px"><button class="btn dark" id="addBtn"></button></div>'}`;

  const drawOptions = () => {
    $('#opts', sheet).innerHTML = activeGroups(item, sel).map((g) => `
      <div class="opt-group"><h3>${esc(groups[g].label)}</h3><div class="chips">
        ${groups[g].choices.map((c) => `<button class="chip" data-g="${g}" data-c="${c.id}" aria-pressed="${sel[g] === c.id}">
          ${esc(c.label)}${c.add ? ` +${fmt(minor(c.add))}` : ''}</button>`).join('')}
      </div></div>`).join('');
    $$('.chip', sheet).forEach((b) => b.onclick = () => {
      const changedTemp = b.dataset.g === 'temp' && sel.temp !== b.dataset.c;
      sel[b.dataset.g] = b.dataset.c; haptic('tap');
      if (changedTemp) drawOptions(); // shows/hides the ice choice
      else $$(`.chip[data-g="${b.dataset.g}"]`, sheet).forEach((x) => x.setAttribute('aria-pressed', x === b));
      updateLabel();
    });
  };
  const updateLabel = () => {
    const label = `ADD TO ORDER · ${fmt(unitPrice(item, sel) * qty)}`;
    mainButton(label, add);
    if ($('#addBtn')) $('#addBtn').textContent = label;
  };
  $$('[data-q]', sheet).forEach((b) => b.onclick = () => {
    const next = Math.max(1, Math.min(20, qty + +b.dataset.q));
    if (next === qty) return;
    qty = next; haptic('tap');
    const q = $('#qty'); q.textContent = qty; q.classList.remove('bump'); void q.offsetWidth; q.classList.add('bump');
    updateLabel();
  });

  const close = (added) => {
    sheet.classList.remove('show'); scrim.classList.remove('show');
    unlockScroll();
    sheetHideTimer = setTimeout(() => { sheet.classList.add('hidden'); scrim.classList.add('hidden'); }, 380);
    backButton(null);
    if (added) {
      const n = state.cart.filter((l) => l.id === id).reduce((s, l) => s + l.qty, 0);
      const row = $(`[data-item="${id}"]`);
      const ico = $('.ico', row);
      let badge = $('.badge', ico);
      if (!badge) { ico.insertAdjacentHTML('beforeend', '<span class="badge"></span>'); badge = $('.badge', ico); }
      badge.textContent = n;
      if (!reduceMotion) {
        badge.classList.remove('pop'); void badge.offsetWidth; badge.classList.add('pop');
        row.insertAdjacentHTML('beforeend', `<span class="plus-one">+${added}</span>`);
        setTimeout(() => $('.plus-one', row)?.remove(), 800);
      }
    }
    updateCartButton();
  };
  const add = () => { addToCart(item.id, { ...sel }, qty); haptic('success'); close(qty); };

  clearTimeout(sheetHideTimer);
  drawOptions(); updateLabel();
  $('#addBtn')?.addEventListener('click', add);
  sheet.classList.remove('hidden'); scrim.classList.remove('hidden'); lockScroll(); sheet.scrollTop = 0;
  requestAnimationFrame(() => requestAnimationFrame(() => { sheet.classList.add('show'); scrim.classList.add('show'); }));
  scrim.onclick = () => close(0);
  backButton(() => close(0));
}
