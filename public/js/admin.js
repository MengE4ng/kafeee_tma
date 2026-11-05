// Menu manager for the shop owner (only shown to Telegram IDs listed in ADMIN_IDS)
// ---------- Admin: manage menu ----------
const adminState = { tab: 'drinks', menu: null };

async function loadAdminMenu() { adminState.menu = await api('/api/admin/menu'); }
async function adminCall(path, method, body) {
  const res = await api(path, { method, body: body ? JSON.stringify(body) : undefined });
  adminState.menu = res.menu;
  return res;
}
const fmtPrice = (p) => fmt(minor(p));

async function renderAdmin() {
  backButton(async () => { state.menu = await api('/api/menu'); go('menu', 'back'); });
  mainButton(null);
  if (!adminState.menu) {
    $('#app').innerHTML = '<div class="empty"><p>Loading menu…</p></div>';
    try { await loadAdminMenu(); } catch (e) { $('#app').innerHTML = `<div class="empty"><p>${esc(e.message)}</p></div>`; return; }
  }
  const m = adminState.menu;
  const groupsText = (ids) => ids.map((g) => m.optionGroups[g]?.label).filter(Boolean).join(' · ');
  $('#app').innerHTML = `
    <h1 class="page-title">Manage menu</h1>
    <div class="seg" role="tablist">
      <button role="tab" data-tab="drinks" aria-selected="${adminState.tab === 'drinks'}">Drinks</button>
      <button role="tab" data-tab="options" aria-selected="${adminState.tab === 'options'}">Options</button>
    </div>
    ${adminState.tab === 'drinks' ? `
      <div class="actions"><button class="btn primary" id="addItem">+ Add drink</button></div>
      ${m.categories.map((c, ci) => `
        <div class="adm-cat">
          <h2 class="cat-title">${esc(c)}</h2>
          <span class="adm-move">
            <button data-cat-move="${ci}" data-dir="-1" aria-label="Move category up" ${ci === 0 ? 'disabled' : ''}>↑</button>
            <button data-cat-move="${ci}" data-dir="1" aria-label="Move category down" ${ci === m.categories.length - 1 ? 'disabled' : ''}>↓</button>
          </span>
        </div>
        ${m.items.filter((i) => i.category === c).map((i, n, arr) => `
          <div class="adm-row ${i.hidden ? 'is-hidden' : ''}">
            <button class="adm-main" data-edit="${esc(i.id)}">
              <span class="ico">${esc(i.emoji)}</span>
              <span class="adm-text"><span class="nm">${esc(i.name)}</span>
                <span class="desc">${fmtPrice(i.price)}${i.options.length ? ` · ${esc(groupsText(i.options))}` : ''}${i.hidden ? ' · Hidden' : ''}</span></span>
            </button>
            <label class="switch" title="Available">
              <input type="checkbox" data-avail="${esc(i.id)}" ${i.soldOut ? '' : 'checked'} /><span></span>
            </label>
            <span class="adm-move">
              <button data-move="${esc(i.id)}" data-dir="-1" aria-label="Move up" ${n === 0 ? 'disabled' : ''}>↑</button>
              <button data-move="${esc(i.id)}" data-dir="1" aria-label="Move down" ${n === arr.length - 1 ? 'disabled' : ''}>↓</button>
            </span>
          </div>`).join('')}`).join('')}
      <p class="hint">Switch = available today (off = sold out). Tap a drink to edit it.</p>
    ` : `
      <div class="actions"><button class="btn primary" id="addOpt">+ Add option</button></div>
      <div class="adm-list">
        ${Object.entries(m.optionGroups).map(([id, g]) => `
          <button class="adm-opt" data-opt="${esc(id)}">
            <span class="nm">${esc(g.label)}</span>
            <span class="desc">${g.choices.map((c) => esc(c.label) + (c.add ? ` +${fmtPrice(c.add)}` : '')).join(' · ')}</span>
            <span class="desc">Used by ${m.items.filter((i) => i.options.includes(id)).length} drink(s)</span>
          </button>`).join('') || '<p class="hint">No options yet.</p>'}
      </div>
    `}
  `;
  $$('[data-tab]').forEach((b) => b.onclick = () => { adminState.tab = b.dataset.tab; haptic('tap'); renderAdmin(); });
  $('#addItem')?.addEventListener('click', () => editItem(null));
  $('#addOpt')?.addEventListener('click', () => editOption(null));
  $$('[data-edit]').forEach((b) => b.onclick = () => editItem(b.dataset.edit));
  $$('[data-opt]').forEach((b) => b.onclick = () => editOption(b.dataset.opt));
  $$('[data-avail]').forEach((c) => c.onchange = async () => {
    try { await adminCall('/api/admin/soldout', 'POST', { id: c.dataset.avail, soldOut: !c.checked }); haptic('light'); toast(c.checked ? 'Available' : 'Marked sold out'); }
    catch (e) { toast(e.message); c.checked = !c.checked; }
  });
  $$('[data-move]').forEach((b) => b.onclick = () => moveItem(b.dataset.move, Number(b.dataset.dir)));
  $$('[data-cat-move]').forEach((b) => b.onclick = () => moveCategory(Number(b.dataset.catMove), Number(b.dataset.dir)));
}

async function moveItem(id, dir) {
  const items = adminState.menu.items;
  const item = items.find((i) => i.id === id);
  const same = items.filter((i) => i.category === item.category);
  const k = same.indexOf(item), other = same[k + dir];
  if (!other) return;
  const order = items.map((i) => i.id);
  const a = order.indexOf(item.id), b = order.indexOf(other.id);
  [order[a], order[b]] = [order[b], order[a]];
  try { await adminCall('/api/admin/reorder', 'POST', { items: order }); haptic('tap'); renderAdmin(); } catch (e) { toast(e.message); }
}
async function moveCategory(index, dir) {
  const cats = [...adminState.menu.categories];
  const j = index + dir;
  if (j < 0 || j >= cats.length) return;
  [cats[index], cats[j]] = [cats[j], cats[index]];
  try { await adminCall('/api/admin/reorder', 'POST', { categories: cats }); haptic('tap'); renderAdmin(); } catch (e) { toast(e.message); }
}

function editItem(id, draft) {
  const m = adminState.menu;
  const it = draft || (id ? m.items.find((i) => i.id === id) : { name: '', category: m.categories[0] || 'Coffee', price: '', emoji: '☕', desc: '', options: [], hidden: false });
  const sel = new Set(it.options);
  openPanel(`
    <h2 class="panel-title">${id ? 'Edit drink' : 'New drink'}</h2>
    <div class="form">
      <label class="field"><span>Name</span><input id="fName" maxlength="40" value="${esc(it.name)}" placeholder="e.g. Caramel Latte" /></label>
      <div class="field-row">
        <label class="field"><span>Price (${state.menu.currency})</span><input id="fPrice" inputmode="decimal" value="${esc(it.price)}" placeholder="1.75" /></label>
        <label class="field small"><span>Emoji</span><input id="fEmoji" maxlength="8" value="${esc(it.emoji)}" /></label>
      </div>
      <label class="field"><span>Category</span><input id="fCat" maxlength="24" list="catList" value="${esc(it.category)}" />
        <datalist id="catList">${m.categories.map((c) => `<option value="${esc(c)}">`).join('')}</datalist></label>
      <label class="field"><span>Description</span><input id="fDesc" maxlength="80" value="${esc(it.desc)}" placeholder="Short line under the name" /></label>
      <div class="field"><span>Options for this drink</span>
        <div class="chips">${Object.entries(m.optionGroups).map(([g, o]) => `<button class="chip" data-g="${esc(g)}" aria-pressed="${sel.has(g)}">${esc(o.label)}</button>`).join('')}
          <button class="chip chip-add" id="newOpt">+ New option</button></div>
        <div class="opt-preview" id="optPreview"></div>
      </div>
      <label class="check"><input type="checkbox" id="fHidden" ${it.hidden ? 'checked' : ''} /> Hide from the menu</label>
      <div class="actions flush"><button class="btn primary" id="fSave">Save</button>
        ${id ? '<button class="btn ghost" id="fDelete">Delete drink</button>' : ''}</div>
    </div>
  `, (sheet, close) => {
    // what the selected options look like, so the owner sees choices and extra prices right here
    const preview = () => {
      $('#optPreview', sheet).innerHTML = Object.keys(m.optionGroups).filter((g) => sel.has(g)).map((g) => {
        const o = m.optionGroups[g];
        return `<div><b>${esc(o.label)}</b> ${o.choices.map((c) => esc(c.label) + (c.add ? ` +${fmtPrice(c.add)}` : '')).join(' · ')}
          <button class="link" data-edit-opt="${esc(g)}">Edit</button></div>`;
      }).join('');
      $$('[data-edit-opt]', sheet).forEach((b) => b.onclick = () => goToOption(b.dataset.editOpt));
    };
    const currentDraft = () => ({
      name: $('#fName', sheet).value, price: $('#fPrice', sheet).value, emoji: $('#fEmoji', sheet).value,
      category: $('#fCat', sheet).value, desc: $('#fDesc', sheet).value, options: [...sel], hidden: $('#fHidden', sheet).checked,
    });
    // create or edit an option without leaving the drink: the form is kept and the new option is ticked
    const goToOption = (optId) => {
      const d = currentDraft();
      close();
      editOption(optId, {
        onDone: (savedId) => { if (savedId && d.options.includes(savedId) === false) d.options.push(savedId); editItem(id, d); },
        onBack: () => editItem(id, d),
      });
    };
    $$('.chip[data-g]', sheet).forEach((b) => b.onclick = () => {
      const g = b.dataset.g; sel.has(g) ? sel.delete(g) : sel.add(g);
      b.setAttribute('aria-pressed', sel.has(g)); haptic('tap'); preview();
    });
    $('#newOpt', sheet).onclick = () => goToOption(null);
    preview();
    $('#fSave', sheet).onclick = async () => {
      const body = {
        id, name: $('#fName', sheet).value, price: $('#fPrice', sheet).value.replace(',', '.'), emoji: $('#fEmoji', sheet).value,
        category: $('#fCat', sheet).value, desc: $('#fDesc', sheet).value,
        options: Object.keys(m.optionGroups).filter((g) => sel.has(g)), hidden: $('#fHidden', sheet).checked,
      };
      try { await adminCall('/api/admin/items', 'POST', body); haptic('success'); toast('Saved. Customers see it now.'); close(); renderAdmin(); }
      catch (e) { haptic('error'); toast(e.message); }
    };
    $('#fDelete', sheet)?.addEventListener('click', async () => {
      const ok = await new Promise((r) => tg?.showConfirm ? tg.showConfirm(`Delete ${it.name}?`, r) : r(confirm(`Delete ${it.name}?`)));
      if (!ok) return;
      try { await adminCall(`/api/admin/items/${encodeURIComponent(id)}`, 'DELETE'); toast('Deleted'); close(); renderAdmin(); }
      catch (e) { toast(e.message); }
    });
  });
}

function editOption(id, flow) {
  const m = adminState.menu;
  const g = id ? m.optionGroups[id] : { label: '', default: null, choices: [{ id: '', label: '', add: 0 }] };
  let choices = g.choices.map((c) => ({ ...c }));
  let def = g.default || choices[0]?.id;
  const draw = (sheet) => {
    $('#choices', sheet).innerHTML = choices.map((c, i) => `
      <div class="choice-row">
        <label class="radio" title="Default"><input type="radio" name="def" value="${i}" ${(c.id && c.id === def) || (!def && i === 0) ? 'checked' : ''} /></label>
        <input class="cLabel" data-i="${i}" maxlength="24" value="${esc(c.label)}" placeholder="Choice, e.g. Oat milk" />
        <input class="cAdd" data-i="${i}" inputmode="decimal" value="${c.add ? esc(c.add) : ''}" placeholder="+0.00" />
        <button class="cDel" data-i="${i}" aria-label="Remove choice" ${choices.length === 1 ? 'disabled' : ''}>×</button>
      </div>`).join('');
    $$('.cLabel', sheet).forEach((x) => x.oninput = () => { choices[x.dataset.i].label = x.value; });
    $$('.cAdd', sheet).forEach((x) => x.oninput = () => { choices[x.dataset.i].add = x.value.replace(',', '.'); });
    $$('input[name="def"]', sheet).forEach((x) => x.onchange = () => { const c = choices[x.value]; if (!c.id) c.id = `c${Date.now()}`; def = c.id; });
    $$('.cDel', sheet).forEach((x) => x.onclick = () => { choices.splice(Number(x.dataset.i), 1); draw(sheet); });
  };
  openPanel(`
    <h2 class="panel-title">${id ? 'Edit option' : 'New option'}</h2>
    <div class="form">
      <label class="field"><span>Option name</span><input id="oLabel" maxlength="24" value="${esc(g.label)}" placeholder="e.g. Milk" /></label>
      <div class="field"><span>Choices · extra price · ● default</span><div id="choices"></div>
        <button class="btn" id="addChoice" style="margin-top:8px">+ Add choice</button></div>
      <div class="actions flush"><button class="btn primary" id="oSave">${flow ? 'Save and use for this drink' : 'Save'}</button>
        ${flow ? '<button class="btn" id="oBack">← Back to the drink</button>' : ''}
        ${id && !flow ? '<button class="btn ghost" id="oDelete">Delete option</button>' : ''}</div>
    </div>
  `, (sheet, close) => {
    draw(sheet);
    $('#addChoice', sheet).onclick = () => { if (choices.length < 12) { choices.push({ id: '', label: '', add: 0 }); draw(sheet); } };
    $('#oBack', sheet)?.addEventListener('click', () => { close(); flow.onBack(); });
    $('#oSave', sheet).onclick = async () => {
      choices.forEach((c, i) => { if (!c.id) c.id = `c${Date.now()}${i}`; });
      const checked = $('input[name="def"]:checked', sheet);
      if (checked) def = choices[checked.value]?.id;
      try {
        const res = await adminCall('/api/admin/options', 'POST', { id, label: $('#oLabel', sheet).value, default: def, choices: choices.map((c) => ({ id: c.id, label: c.label, add: Number(c.add) || 0 })) });
        haptic('success'); toast('Option saved'); close(); renderAdmin();
        if (flow) flow.onDone(res.id);
      } catch (e) { haptic('error'); toast(e.message); }
    };
    $('#oDelete', sheet)?.addEventListener('click', async () => {
      const ok = await new Promise((r) => tg?.showConfirm ? tg.showConfirm(`Delete "${g.label}"? It will be removed from every drink.`, r) : r(confirm('Delete?')));
      if (!ok) return;
      try { await adminCall(`/api/admin/options/${encodeURIComponent(id)}`, 'DELETE'); toast('Deleted'); close(); renderAdmin(); }
      catch (e) { toast(e.message); }
    });
  });
}
