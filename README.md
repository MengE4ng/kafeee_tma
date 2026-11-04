# kafee_tma — Coffee Shop Telegram Mini App (KHQR)

Customers order inside Telegram, pay with a KHQR code, and the barista group
gets the order the moment Bakong confirms the money arrived.

## Payment modes

Set `PAYMENT_MODE` in `.env`:

- **manual** (default): the app shows your own merchant QR (`MERCHANT_KHQR`) with the exact amount to type. The customer pays and taps "I've paid". The barista group gets **✅ Payment received / ❌ Not received** buttons; after ✅ the order gets its pickup number. No Bakong token needed. Tip: turn on ABA payment alerts to the same Telegram group so the barista sees the money arrive next to the order.
- **bakong**: a fixed-amount QR is generated per order and the payment is detected automatically (needs `BAKONG_ACCOUNT_ID` and `BAKONG_TOKEN`). The flow below describes this mode.

## Flow

1. Customer opens the bot → taps **Order** (menu button) → mini app opens
2. Browses menu → picks size / sugar / ice → adds to cart
3. Reviews order, adds a note → **Pay with KHQR**
4. Server re-prices the cart (client prices are never trusted), saves the order,
   generates a dynamic KHQR (fixed amount, expires in 10 min) with `bakong-khqr`
5. Customer pays: scans with another phone, **saves the QR and uses "scan from gallery"**,
   or taps **Open my banking app** (Bakong deeplink, when available)
6. Server polls Bakong `check_transaction_by_md5` every 4 s for unpaid orders
7. Paid → order gets a daily pickup number (#001, #002…), amount is verified,
   barista group gets a message with buttons, customer gets a Telegram message
8. Barista taps **Start making → Ready → Picked up**; each step updates the
   customer's screen and sends them a message when it's ready
9. QR expired? Customer can get a new one or cancel

## Setup

1. **Bot**: talk to @BotFather → `/newbot` → copy the token.
2. **Bakong**
   - `BAKONG_ACCOUNT_ID`: your Bakong account ID (e.g. `name@aclb`, `name@wing`) — find it in your bank app's KHQR/Bakong section.
   - `BAKONG_TOKEN`: register at https://api-bakong.nbc.gov.kh to get an API token. It expires (roughly every 90 days) — put a reminder in your calendar to renew it. When it expires, payments will stop being detected and you'll see a "token rejected" error in the logs.
3. **Barista group**: create a Telegram group, add your bot, send `/chatid` → put the number in `BARISTA_CHAT_ID`.
4. **HTTPS URL**: Telegram mini apps require HTTPS.
   - Local testing: `cloudflared tunnel --url http://localhost:3000` or `ngrok http 3000`, then put that URL in `WEBAPP_URL`.
5. Run:
   ```bash
   cp .env.example .env    # fill it in
   npm install
   npm start
   ```
   On startup the bot sets its menu button to open the app.

## Barista commands (in the barista group)

| Command | What it does |
|---|---|
| `/open`, `/close` | Allow / block new orders |
| `/menu` | List items with their IDs and stock status |
| `/soldout latte`, `/restock latte` | Mark an item sold out / back |

## Hiding the bot token in .env

Run `node scripts/obfuscate-token.js` and paste the token when asked (it's hidden while you type).
`.env` then contains `BOT_TOKEN_ENC=v1....` (unreadable) instead of `BOT_TOKEN=...`. The decryption key is
stored outside the project in `~/.kafee_secret.key`. Run the script on each machine (Mac, server) separately.
This protects against screenshots / accidental sharing, not against someone who has full access to the server.

## Customize

- Menu, prices, options: `src/menu.js`
- KHQR logo: download the official white KHQR logo from the National Bank of Cambodia's KHQR guideline / brand kit and save it as `public/khqr-logo.svg`. Until then the card shows the word KHQR in its place.
- Logo: replace `public/logo.webp` and `public/logo-small.webp`
- Brand colors and fonts: the `:root` block at the top of `public/index.html`
- Currency: `CURRENCY=USD` or `KHR` (set menu prices in that currency)
- QR lifetime: `QR_TTL_MIN`

## Things to know before going live

- **Host in Cambodia if you can.** The Bakong Open API has been reported to reject
  requests from non-Cambodian IPs. If payment checks fail with 403, host the server on
  a Cambodian VPS/provider or route Bakong calls through one.
- **Same-phone problem.** Most customers order on the phone they pay with, so they
  can't scan their own screen. That's why the app has "Save QR to photos" (bank apps
  support scanning from gallery) and the deeplink button.
- **Amount check.** If the received amount/currency doesn't match the order, the barista
  message shows a ⚠️ warning so you can check before making the drink.
- **Database**: SQLite file (`data.db`). Back it up; it's your sales record.
- **Scaling**: one process with polling is fine for a small shop. For many orders, switch
  to `check_transaction_by_md5_list` (batch) and run the bot via webhook.
- **Testing in a browser** without Telegram: set `DEV_SKIP_AUTH=1` (never in production).

## Files

```
src/server.js        Express API, order creation, payment watcher
src/khqr.js          KHQR generation (bakong-khqr) + Bakong API calls
src/bot.js           Barista notifications, status buttons, commands
src/db.js            SQLite storage (Node built-in, no compiling needed)
src/telegramAuth.js  Verifies Telegram initData so orders can't be faked
src/menu.js          Your menu
public/index.html    The mini app page (just the layout; loads the files below)
public/css/styles.css  All styles
public/js/core.js      Telegram setup, helpers, API calls, Telegram buttons
public/js/cart.js      Cart helpers (prices, options, totals)
public/js/router.js    Switching screens with transitions
public/js/menu.js      Menu screen and drink sheet
public/js/checkout.js  Cart screen and placing the order
public/js/pay.js       Pay screens, cancel, payment polling
public/js/status.js    Pickup ticket / order status
public/js/shop.js      Find us card, contact buttons, Need help? panel
public/js/main.js      Start-up
public/logo.webp     Kafee logo (transparent background); logo-small.webp for icons
```
