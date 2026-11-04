// Renders the full KHQR card (red header, merchant, amount, dashed line, QR with
// currency mark) as a PNG, so "Save QR to photos" saves the whole official-looking card.
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const { Resvg } = require('@resvg/resvg-js');

const FONT_DIR = path.join(__dirname, '..', 'fonts');
const FONTS = ['NunitoSans-Regular.ttf', 'NunitoSans-ExtraBold.ttf', 'NotoSansKhmer-Bold.ttf']
  .map((f) => path.join(FONT_DIR, f)).filter((f) => fs.existsSync(f));
// Optional official KHQR logo (white, transparent background): public/khqr-logo.svg or public/khqr-logo.png
const LOGO_FILES = ['khqr-logo.svg', 'khqr-logo.png'].map((f) => path.join(__dirname, '..', 'public', f));
const MIME = { '.svg': 'image/svg+xml', '.png': 'image/png' };
// Optional official center emblem for the QR (round): public/khqr-center.svg or public/khqr-center.png
const CENTER_FILES = ['khqr-center.svg', 'khqr-center.png'].map((f) => path.join(__dirname, '..', 'public', f));

const RED = '#E1232E';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

async function renderKhqrCard({ qr, merchant, amount, currency = 'USD', fixedAmount = true }) {
  // Proportions measured from the official Bakong KHQR card. Card width 600 → 1% = 6px, height 145% = 870px.
  const u = 6;
  const W = 100 * u, H = 145 * u, PAD = 48;
  const HEADER = 17.6 * u, FOLD_W = 9.7 * u, FOLD_H = 10.2 * u, RADIUS = 6.2 * u;
  const SIDE = 14.5 * u;
  const NAME_BASE = 30.3 * u, NAME_SIZE = 5.3 * u;
  const AMOUNT_BASE = 40.9 * u, AMOUNT_SIZE = 8.4 * u, CUR_SIZE = 4.8 * u;
  const SEP_Y = (fixedAmount ? 49.5 : 40) * u;
  const QR_SIZE = 70.9 * u, QR_Y = (fixedAmount ? 61.3 : 57) * u, QR_X = SIDE;
  const MARK_R = (QR_SIZE * 0.195) / 2;
  const LOGO_H = 6 * u, LOGO_W = LOGO_H * (70 / 18);

  const amountText = amount == null ? '' : currency === 'USD' ? Number(amount).toFixed(2) : Number(amount).toLocaleString('en-US');
  const footer = fixedAmount ? 70 : 120;
  const CW = W + PAD * 2, CH = H + PAD * 2 + footer;

  const qrSvg = (await QRCode.toString(qr, { type: 'svg', margin: 0, errorCorrectionLevel: 'Q' }))
    .replace('<svg ', `<svg x="${QR_X}" y="${QR_Y}" width="${QR_SIZE}" height="${QR_SIZE}" `);

  const logoFile = LOGO_FILES.find((f) => fs.existsSync(f));
  const logo = logoFile
    ? `<image href="data:${MIME[path.extname(logoFile)]};base64,${fs.readFileSync(logoFile).toString('base64')}" x="${(W - LOGO_W) / 2}" y="${(HEADER - LOGO_H) / 2}" width="${LOGO_W}" height="${LOGO_H}" preserveAspectRatio="xMidYMid meet"/>`
    : `<text x="${W / 2}" y="${HEADER / 2 + 7 * u * 0.36}" text-anchor="middle" font-family="Kafee Card" font-weight="800" font-size="${7 * u}" fill="#fff" letter-spacing="2">KHQR</text>`;

  const info = fixedAmount
    ? `<text x="${SIDE}" y="${NAME_BASE}" font-family="Kafee Card, Kafee Card Khmer" font-size="${NAME_SIZE}" letter-spacing="${NAME_SIZE * 0.02}" fill="#000">${esc(merchant)}</text>
       <text x="${SIDE}" y="${AMOUNT_BASE}" font-family="Kafee Card" font-weight="800" font-size="${AMOUNT_SIZE}" fill="#000">${esc(amountText)}<tspan font-weight="400" font-size="${CUR_SIZE}" dx="${2.2 * u}" dy="${-0.4 * u}" letter-spacing="${CUR_SIZE * 0.02}">${esc(currency)}</tspan></text>`
    : `<text x="${W / 2}" y="${NAME_BASE}" text-anchor="middle" font-family="Kafee Card, Kafee Card Khmer" font-size="${NAME_SIZE}" letter-spacing="${NAME_SIZE * 0.02}" fill="#000">${esc(merchant)}</text>`;

  const markGlyph = currency === 'KHR'
    ? `<text x="${W / 2}" y="${QR_Y + QR_SIZE / 2 + MARK_R * 0.36}" text-anchor="middle" font-family="Kafee Card Khmer" font-weight="700" font-size="${MARK_R * 1.05}" fill="#fff">៛</text>`
    : `<text x="${W / 2}" y="${QR_Y + QR_SIZE / 2 + MARK_R * 0.36}" text-anchor="middle" font-family="Kafee Card" font-weight="800" font-size="${MARK_R * 1.05}" fill="#fff">$</text>`;

  function centerMark() {
    const file = CENTER_FILES.find((f) => fs.existsSync(f));
    const cx = W / 2, cy = QR_Y + QR_SIZE / 2;
    if (file) {
      const data = fs.readFileSync(file).toString('base64');
      const r = MARK_R + 1.2 * u; // the emblem includes its own white ring
      return `<image href="data:${MIME[path.extname(file)]};base64,${data}" x="${cx - r}" y="${cy - r}" width="${r * 2}" height="${r * 2}" preserveAspectRatio="xMidYMid meet"/>`;
    }
    return `<circle cx="${cx}" cy="${cy}" r="${MARK_R}" fill="#000"/>${markGlyph}`;
  }

  const below = fixedAmount
    ? `<text x="${CW / 2}" y="${PAD + H + 52}" text-anchor="middle" font-family="Kafee Card" font-size="22" fill="#6b6b6b">Scan with any KHQR banking app</text>`
    : `<text x="${CW / 2}" y="${PAD + H + 60}" text-anchor="middle" font-family="Kafee Card" font-weight="800" font-size="34" fill="#1b1410">Pay exactly ${esc(currency === 'USD' ? '$' + amountText : amountText + ' ៛')}</text>
       <text x="${CW / 2}" y="${PAD + H + 98}" text-anchor="middle" font-family="Kafee Card" font-size="22" fill="#6b6b6b">Scan with any KHQR banking app and type this amount</text>`;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CW}" height="${CH}" viewBox="0 0 ${CW} ${CH}">
  <defs>
    <filter id="sh" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="6" stdDeviation="16" flood-color="#000" flood-opacity="0.13"/></filter>
    <clipPath id="card"><rect width="${W}" height="${H}" rx="${RADIUS}"/></clipPath>
  </defs>
  <rect width="${CW}" height="${CH}" fill="#F3F3F3"/>
  <g transform="translate(${PAD} ${PAD})">
    <rect width="${W}" height="${H}" rx="${RADIUS}" fill="#fff" filter="url(#sh)"/>
    <g clip-path="url(#card)">
      <rect width="${W}" height="${HEADER}" fill="${RED}"/>
      <polygon points="${W - FOLD_W},${HEADER} ${W},${HEADER} ${W},${HEADER + FOLD_H}" fill="${RED}"/>
    </g>
    ${logo}
    ${info}
    <line x1="0" y1="${SEP_Y}" x2="${W}" y2="${SEP_Y}" stroke="#9b9b9b" stroke-width="${0.4 * u}" stroke-dasharray="${1.8 * u} ${1.1 * u}"/>
    ${qrSvg}
    <circle cx="${W / 2}" cy="${QR_Y + QR_SIZE / 2}" r="${MARK_R + 1.2 * u}" fill="#fff"/>
    ${centerMark()}
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
