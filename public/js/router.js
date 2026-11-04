// Switching between screens with transitions
// ---------- Routing with transitions ----------
const ORDER = { menu: 0, cart: 1, pay: 2, status: 3 };
function go(view, dir) {
  const from = state.view;
  dir = dir || (from == null ? 'up' : ORDER[view] >= ORDER[from] ? 'fwd' : 'back');
  state.view = view; stopTimers();
  // leaving the screen closes any open sheet and unfreezes the page
  if (document.body.classList.contains('locked')) {
    unlockScroll(); clearTimeout(sheetHideTimer);
    ['#sheet', '#scrim'].forEach((q) => { $(q).classList.remove('show'); $(q).classList.add('hidden'); });
  }
  const run = () => {
    render();
    window.scrollTo(0, 0);
    const app = $('#app');
    app.classList.remove('enter-fwd', 'enter-back', 'enter-up');
    void app.offsetWidth;
    if (!reduceMotion) app.classList.add('enter-' + dir);
  };
  run();
}
function render() { ({ menu: renderMenu, cart: renderCart, pay: renderPay, status: renderStatus })[state.view](); }
