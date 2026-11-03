// Renders the full KHQR card (red header, merchant, amount, dashed line, QR with
// currency mark) as a PNG, so "Save QR to photos" saves the whole official-looking card.
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const { Resvg } = require('@resvg/resvg-js');

const FONT_DIR = path.join(__dirname, '..', 'fonts');
const FONTS = ['NunitoSans-Regular.ttf', 'NunitoSans-ExtraBold.ttf', 'NotoSansKhmer-Bold.ttf']
  .map((f) => path.join(FONT_DIR, f)).filter((f) => fs.existsSync(f));
const LOGO = path.join(__dirname, '..', 'public', 'khqr-logo.svg'); // optional official logo (white)

const RED = '#E1232E';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

async function renderKhqrCard({ qr, merchant, amount, currency = 'USD', fixedAmount = true }) {
  // Card is 20:29, like the KHQR guideline. Sizes are % of the card width (600).
  const W = 600, H = 870, PAD = 48, HEADER = 104, FOLD = 48;
  const amountText = amount == null ? '' : currency === 'USD' ? Number(amount).toFixed(2) : Number(amount).toLocaleString('en-US');
  const sepY = fixedAmount ? 290 : 230;
  const qrSize = 480, qrX = (W - qrSize) / 2, qrY = sepY + (H - sepY - qrSize) / 2;
  const footer = fixedAmount ? 70 : 120;
  const CW = W + PAD * 2, CH = H + PAD * 2 + footer;

  const qrSvg = (await QRCode.toString(qr, { type: 'svg', margin: 0, errorCorrectionLevel: 'Q' }))
    .replace('<svg ', `<svg x="${qrX}" y="${qrY}" width="${qrSize}" height="${qrSize}" `);

  const logo = fs.existsSync(LOGO)
    ? `<image href="data:image/svg+xml;base64,${fs.readFileSync(LOGO).toString('base64')}" x="${W / 2 - 90}" y="${HEADER / 2 - 21}" width="180" height="42" preserveAspectRatio="xMidYMid meet"/>`
    : `<text x="${W / 2}" y="${HEADER / 2 + 16}" text-anchor="middle" font-family="Kafee Card" font-weight="800" font-size="45" fill="#fff" letter-spacing="2">KHQR</text>`;

  const info = fixedAmount
    ? `<text x="60" y="174" font-family="Kafee Card, Kafee Card Khmer" font-size="28" fill="#000">${esc(merchant)}</text>
       <text x="60" y="240" font-family="Kafee Card" font-weight="800" font-size="57" fill="#000">${esc(amountText)}<tspan font-weight="400" font-size="28" dx="10">${esc(currency)}</tspan></text>`
    : `<text x="${W / 2}" y="184" text-anchor="middle" font-family="Kafee Card, Kafee Card Khmer" font-size="30" letter-spacing="1" fill="#000">${esc(merchant)}</text>`;

  const mark = currency === 'KHR'
    ? `<text x="${W / 2}" y="${qrY + qrSize / 2 + 14}" text-anchor="middle" font-family="Kafee Card Khmer" font-weight="700" font-size="40" fill="#fff">៛</text>`
    : `<text x="${W / 2}" y="${qrY + qrSize / 2 + 14}" text-anchor="middle" font-family="Kafee Card" font-weight="800" font-size="40" fill="#fff">$</text>`;

  const below = fixedAmount
    ? `<text x="${CW / 2}" y="${PAD + H + 52}" text-anchor="middle" font-family="Kafee Card" font-size="22" fill="#6b6b6b">Scan with any KHQR banking app</text>`
    : `<text x="${CW / 2}" y="${PAD + H + 60}" text-anchor="middle" font-family="Kafee Card" font-weight="800" font-size="34" fill="#1b1410">Pay exactly ${esc(currency === 'USD' ? '$' + amountText : amountText + ' ៛')}</text>
       <text x="${CW / 2}" y="${PAD + H + 98}" text-anchor="middle" font-family="Kafee Card" font-size="22" fill="#6b6b6b">Scan with any KHQR banking app and type this amount</text>`;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CW}" height="${CH}" viewBox="0 0 ${CW} ${CH}">
  <defs>
    <filter id="sh" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="6" stdDeviation="16" flood-color="#000" flood-opacity="0.13"/></filter>
    <clipPath id="card"><rect width="${W}" height="${H}" rx="39"/></clipPath>
  </defs>
  <rect width="${CW}" height="${CH}" fill="#F3F3F3"/>
  <g transform="translate(${PAD} ${PAD})">
    <rect width="${W}" height="${H}" rx="39" fill="#fff" filter="url(#sh)"/>
    <g clip-path="url(#card)">
      <rect width="${W}" height="${HEADER}" fill="${RED}"/>
      <polygon points="${W - FOLD},${HEADER} ${W},${HEADER} ${W},${HEADER + FOLD}" fill="${RED}"/>
    </g>
    ${logo}
    ${info}
    <line x1="0" y1="${sepY}" x2="${W}" y2="${sepY}" stroke="#000" stroke-opacity="0.45" stroke-width="3.6" stroke-dasharray="12 9"/>
    ${qrSvg}
    <circle cx="${W / 2}" cy="${qrY + qrSize / 2}" r="44" fill="#fff"/>
    <circle cx="${W / 2}" cy="${qrY + qrSize / 2}" r="36" fill="#000"/>
    ${mark}
  </g>
  ${below}
</svg>`;

  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: CW * 2 }, // 2x for sharp scanning
    font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: 'Kafee Card' },
  });
  return resvg.render().asPng();
}

module.exports = { renderKhqrCard };
