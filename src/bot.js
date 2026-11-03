const { Bot, InlineKeyboard } = require('grammy');
const db = require('./db');
const menu = require('./menu');

const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

const STATUS_LABEL = {
  paid: '🟡 Paid — waiting',
  preparing: '🔵 Preparing',
  ready: '🟢 Ready for pickup',
  picked_up: '⚪️ Picked up',
  cancelled: '⚫️ Cancelled',
};

function createBot({ token, baristaChatId, baristaTopicId, webAppUrl, formatMoney, manualTtlMs = 15 * 60 * 1000, shop = {} }) {
  // Send into a specific topic when the barista group has topics turned on
  const topic = baristaTopicId ? { message_thread_id: Number(baristaTopicId) } : {};
  const bot = new Bot(token);
  const isBaristaChat = (ctx) => String(ctx.chat?.id) === String(baristaChatId);

  const openAppKeyboard = () => {
    const kb = new InlineKeyboard().webApp('☕ Order a drink', webAppUrl);
    if (shop.mapsUrl) kb.row().url('📍 Find us', shop.mapsUrl);
    if (shop.telegram) kb.row().url('💬 Chat with the barista', `https://t.me/${String(shop.telegram).replace(/^@/, '')}`);
    return kb;
  };

  function baristaText(o) {
    const lines = o.items.map((it) => {
      const opts = Object.values(it.options).join(', ');
      return `<b>${it.qty}×</b> ${esc(it.name)}${opts ? `\n     <i>${esc(opts)}</i>` : ''}`;
    });
    const who = o.username ? `${esc(o.user_name)} (@${esc(o.username)})` : esc(o.user_name);
    const time = new Date(o.paid_at || o.created_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    return [
      `<b>Order #${o.code}</b>   ${time}`,
      `👤 ${who}`,
      '',
      ...lines,
      o.note ? `\n📝 ${esc(o.note)}` : null,
      '',
      o.tx_hash
        ? `💵 ${formatMoney(o.total, o.currency)} paid via KHQR\n<code>${esc(o.tx_hash.slice(0, 16))}</code>`
        : `💵 ${formatMoney(o.total, o.currency)} · ${esc(o.tx_from || 'confirmed manually')}`,
      o.amount_ok ? null : '⚠️ <b>Amount received does not match the order total — check your bank app!</b>',
      '',
      `<b>${STATUS_LABEL[o.status] || o.status}</b>`,
    ].filter((l) => l !== null).join('\n');
  }

  function baristaKeyboard(o) {
    const kb = new InlineKeyboard();
    if (o.status === 'paid') kb.text('▶️ Start making', `st:${o.id}:preparing`).text('✅ Ready', `st:${o.id}:ready`);
    else if (o.status === 'preparing') kb.text('✅ Ready for pickup', `st:${o.id}:ready`);
    else if (o.status === 'ready') kb.text('📦 Picked up', `st:${o.id}:picked_up`);
    return kb;
  }

  async function notifyBaristaNewOrder(order) {
    const msg = await bot.api.sendMessage(baristaChatId, `🆕 ${baristaText(order)}`, {
      ...topic,
      parse_mode: 'HTML',
      reply_markup: baristaKeyboard(order),
    });
    db.setBaristaMsg(order.id, msg.message_id);
  }

  const CUSTOMER_MSG = {
    paid: (o) => `✅ Payment received!\nYour pickup number is <b>#${o.code}</b>. We'll message you when it's ready.`,
    preparing: (o) => `☕ Your order <b>#${o.code}</b> is being made.`,
    ready: (o) => `🔔 Order <b>#${o.code}</b> is ready! Show this number at the counter.`,
  };

  // Manual mode: customer says they paid → barista checks the bank app and confirms
  function itemsText(o) {
    return o.items.map((it) => {
      const opts = Object.values(it.options).join(', ');
      return `<b>${it.qty}×</b> ${esc(it.name)}${opts ? ` <i>(${esc(opts)})</i>` : ''}`;
    }).join('\n');
  }
  async function notifyBaristaClaim(o) {
    const who = o.username ? `${esc(o.user_name)} (@${esc(o.username)})` : esc(o.user_name);
    const text = [
      `💰 <b>CHECK PAYMENT: ${formatMoney(o.total, o.currency)}</b>`,
      `👤 ${who} says they paid.`,
      o.rejected_count ? `<i>(attempt ${o.rejected_count + 1})</i>` : null,
      '',
      itemsText(o),
      o.note ? `\n📝 ${esc(o.note)}` : null,
      '',
      'Check your ABA app for this amount, then tap a button.',
    ].filter((l) => l !== null).join('\n');
    const kb = new InlineKeyboard().text('✅ Payment received', `pay:${o.id}:ok`).text('❌ Not received', `pay:${o.id}:no`);
    const msg = await bot.api.sendMessage(baristaChatId, text, { ...topic, parse_mode: 'HTML', reply_markup: kb });
    db.setBaristaMsg(o.id, msg.message_id);
  }

  async function messageCustomer(userId, text) {
    try { await bot.api.sendMessage(userId, text, { parse_mode: 'HTML' }); }
    catch (e) { console.warn(`Could not message user ${userId}:`, e.description || e.message); }
  }

  // Customer pressed "Report a problem" in the app
  async function notifyBaristaReport(o, message) {
    const who = `<a href="tg://user?id=${o.user_id}">${esc(o.user_name || 'Customer')}</a>` + (o.username ? ` (@${esc(o.username)})` : '');
    const label = o.code ? `Order #${o.code}` : `Order (unpaid, ref ${o.id})`;
    const text = [
      `🆘 <b>Help request: ${label}</b>`,
      `👤 ${who}`,
      `💵 ${formatMoney(o.total, o.currency)} · status: ${esc(o.status.replace(/_/g, ' '))}`,
      '',
      `💬 ${esc(message)}`,
      '',
      '<i>Tap the name to message them.</i>',
    ].join('\n');
    await bot.api.sendMessage(baristaChatId, text, { ...topic, parse_mode: 'HTML' });
  }

  async function notifyCustomer(order) {
    const make = CUSTOMER_MSG[order.status];
    if (!make) return;
    try {
      await bot.api.sendMessage(order.user_id, make(order), { parse_mode: 'HTML' });
      if (order.status === 'ready' && shop.lat != null && shop.lng != null) {
        await bot.api.sendVenue(order.user_id, shop.lat, shop.lng, 'Pick up here ☕', shop.address || 'Kafee');
      }
    } catch (e) {
      // Happens if the user never started the bot / blocked it. The app still shows live status.
      console.warn(`Could not message user ${order.user_id}:`, e.description || e.message);
    }
  }

  // ---- Customer side ----
  bot.command('start', (ctx) =>
    ctx.reply('Welcome! Tap below to see the menu and order ahead. 🧋', { reply_markup: openAppKeyboard() }));

  // Handy during setup: tells you the chat ID to put in BARISTA_CHAT_ID
  bot.command('chatid', (ctx) => {
    const t = ctx.msg.is_topic_message ? ctx.msg.message_thread_id : null;
    return ctx.reply(
      `Chat ID: <code>${ctx.chat.id}</code>` + (t ? `\nTopic ID: <code>${t}</code>` : ''),
      { parse_mode: 'HTML' });
  });

  // ---- Barista group commands ----
  bot.command('open', async (ctx) => {
    if (!isBaristaChat(ctx)) return;
    db.setOpen(true);
    await ctx.reply('🟢 Shop is OPEN. Customers can order.');
  });
  bot.command('close', async (ctx) => {
    if (!isBaristaChat(ctx)) return;
    db.setOpen(false);
    await ctx.reply('🔴 Shop is CLOSED. New orders are blocked.');
  });
  // Re-send payment checks that the barista group missed (e.g. bot was not in the group)
  bot.command('pending', async (ctx) => {
    if (!isBaristaChat(ctx)) return;
    const list = db.awaitingConfirmation();
    if (!list.length) return ctx.reply('No payments waiting for confirmation. ✅');
    for (const o of list) await notifyBaristaClaim(o);
  });

  bot.command('menu', async (ctx) => {
    if (!isBaristaChat(ctx)) return;
    const so = db.soldOut();
    const list = menu.items.map((i) => `${so.has(i.id) ? '❌' : '✅'} ${esc(i.name)} — <code>${i.id}</code>`).join('\n');
    await ctx.reply(`${list}\n\n/soldout &lt;id&gt; or /restock &lt;id&gt;`, { parse_mode: 'HTML' });
  });
  for (const [cmd, value] of [['soldout', true], ['restock', false]]) {
    bot.command(cmd, async (ctx) => {
      if (!isBaristaChat(ctx)) return;
      const id = ctx.match.trim();
      const item = menu.items.find((i) => i.id === id);
      if (!item) return ctx.reply('Unknown item. Send /menu to see IDs.');
      db.setSoldOut(id, value);
      await ctx.reply(value ? `❌ ${item.name} marked sold out` : `✅ ${item.name} is back`);
    });
  }

  // ---- Barista status buttons ----
  const NEXT = { paid: ['preparing', 'ready'], preparing: ['ready'], ready: ['picked_up'] };
  bot.callbackQuery(/^st:(\d+):(\w+)$/, async (ctx) => {
    if (!isBaristaChat(ctx)) return ctx.answerCallbackQuery('Not allowed');
    const [, id, next] = ctx.match;
    const order = db.getOrder(Number(id));
    if (!order || !(NEXT[order.status] || []).includes(next)) {
      return ctx.answerCallbackQuery('Already updated');
    }
    db.setStatus(order.id, next);
    const updated = db.getOrder(order.id);
    const by = ctx.from.first_name;
    await ctx.editMessageText(`${baristaText(updated)}\n<i>by ${esc(by)}</i>`, {
      parse_mode: 'HTML',
      reply_markup: baristaKeyboard(updated),
    });
    await ctx.answerCallbackQuery(STATUS_LABEL[next]);
    await notifyCustomer(updated);
  });

  bot.callbackQuery(/^pay:(\d+):(ok|no)$/, async (ctx) => {
    if (!isBaristaChat(ctx)) return ctx.answerCallbackQuery('Not allowed');
    const [, id, answer] = ctx.match;
    const order = db.getOrder(Number(id));
    if (!order || order.status !== 'awaiting_confirmation') return ctx.answerCallbackQuery('Already handled');
    const by = ctx.from.first_name;

    if (answer === 'ok') {
      db.markPaid(order.id, { hash: null, fromAccountId: `confirmed by ${by}`, amountOk: true });
      const paid = db.getOrder(order.id);
      await ctx.editMessageText(`🆕 ${baristaText(paid)}`, { parse_mode: 'HTML', reply_markup: baristaKeyboard(paid) });
      await ctx.answerCallbackQuery(`Order #${paid.code}`);
      await notifyCustomer(paid);
    } else {
      db.rejectPayment(order.id, manualTtlMs);
      await ctx.editMessageText(
        `❌ Payment of ${formatMoney(order.total, order.currency)} from ${esc(order.user_name)} <b>not received</b>\n<i>marked by ${esc(by)}. The customer was asked to check and try again.</i>`,
        { parse_mode: 'HTML' });
      await ctx.answerCallbackQuery('Customer notified');
      await messageCustomer(order.user_id,
        `⚠️ We couldn't find your payment of <b>${formatMoney(order.total, order.currency)}</b> yet.\nPlease check your bank app, then open the app and tap “I've paid” again, or talk to the barista.`);
    }
  });

  bot.catch((err) => console.error('Bot error:', err.error));

  return { bot, notifyBaristaNewOrder, notifyBaristaClaim, notifyBaristaReport, notifyCustomer };
}

module.exports = { createBot };
