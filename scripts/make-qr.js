// Makes a KHQR with an amount from your merchant QR, straight from the terminal.
//
//   node scripts/make-qr.js 2.25          → USD 2.25
//   node scripts/make-qr.js 2.25 card     → also saves the full KHQR card image
//
// Saves the image to your Desktop and prints the QR text.
require('dotenv').config({ quiet: true });
require('../src/secret').loadSecrets(); // works with encrypted .env too
const fs = require('fs');
const os = require('os');
const path = require('path');
const QRCode = require('qrcode');
const { BakongKHQR } = require('bakong-khqr');
const { addAmountToKhqr } = require('../src/khqr');
const { renderKhqrCard } = require('../src/khqrCard');

(async () => {
  const amount = Number(process.argv[2]);
  const withCard = process.argv[3] === 'card';
  if (Number.isFinite(amount) === false || amount <= 0) {
    console.log('Usage: node scripts/make-qr.js <amount> [card]   e.g. node scripts/make-qr.js 2.25 card');
    process.exit(1);
  }
  const merchant = (process.env.MERCHANT_KHQR || '').trim();
  if (merchant === '') { console.error('MERCHANT_KHQR is missing in .env'); process.exit(1); }

  const qr = addAmountToKhqr(merchant, amount, { expiresAt: Date.now() + 24 * 3600 * 1000 }); // valid for 24 hours
  if (BakongKHQR.verify(qr).isValid === false) { console.error('Generated QR failed validation'); process.exit(1); }
  const d = BakongKHQR.decode(qr).data;
  const currency = d.transactionCurrency === '116' ? 'KHR' : 'USD';

  const name = `KHQR-${String(amount).replace('.', '_')}${currency}`;
  const out = path.join(os.homedir(), 'Desktop', `${name}.png`);
  if (withCard) {
    fs.writeFileSync(out, await renderKhqrCard({ qr, merchant: d.merchantName, amount, currency, fixedAmount: true }));
  } else {
    await QRCode.toFile(out, qr, { width: 720, margin: 2, errorCorrectionLevel: 'Q' });
  }

  console.log(`Merchant: ${d.merchantName}`);
  console.log(`Amount:   ${d.transactionAmount} ${currency}`);
  console.log(`Expires:  ${new Date(Number(d.expirationTimestamp)).toLocaleString()}`);
  console.log(`Saved:    ${out}`);
  console.log(`QR text:  ${qr}`);
})();
