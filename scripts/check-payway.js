/**
 * ABA PayWay integration check (sandbox or live, whatever PAYWAY_BASE points to)
 *
 *   npm run check:payway            → creates a 1.00 USD test payment and checks its status
 *   npm run check:payway -- 0.50    → another amount
 *
 * With sandbox credentials no real money moves. Exit code 0 when every check passes.
 */
require('dotenv').config({ quiet: true });
require('../src/secret').loadSecrets();
const payway = require('../src/payway');

const results = [];
const line = (s, label, detail = '') => console.log(`  ${s.padEnd(6)} ${label}${detail ? `\n         ${detail}` : ''}`);
const pass = (l, d) => { results.push(true); line('PASS', l, d); };
function fail(l, d, hint) { results.push(false); line('FAIL', l, d); if (hint) console.log(`         Fix: ${hint}`); summary(); }
function summary() {
  const f = results.filter((r) => r === false).length;
  console.log('\n' + '-'.repeat(60) + `\n  Result: ${f ? `FAILED (${results.length - f} passed, ${f} failed)` : `ALL ${results.length} CHECKS PASSED`}\n` + '-'.repeat(60));
  process.exit(f ? 1 : 0);
}

(async () => {
  const base = process.env.PAYWAY_BASE || 'https://checkout-sandbox.payway.com.kh';
  console.log(`\nABA PayWay integration check\n  Endpoint: ${base} ${base.includes('sandbox') ? '(SANDBOX)' : '(LIVE: real money!)'}\n`);

  const mid = process.env.PAYWAY_MERCHANT_ID, key = process.env.PAYWAY_API_KEY;
  if (!mid) fail('Merchant ID configured', 'PAYWAY_MERCHANT_ID is not set', 'npm run secret:set -- PAYWAY_MERCHANT_ID');
  if (!key) fail('API key configured', 'PAYWAY_API_KEY is not set', 'npm run secret:set -- PAYWAY_API_KEY');
  pass('Credentials configured', `merchant ${mid}, key ${key.slice(0, 4)}… (${key.length} characters)`);

  const amount = Number(process.argv[2] || 1);
  const tranId = `CHK${Date.now().toString(36)}`.slice(0, 20);
  let p;
  try {
    p = await payway.createPayment({ tranId, amount, currency: 'USD', items: [{ name: 'Test', quantity: 1, price: amount }], lifetimeMin: 5 });
  } catch (e) {
    const wrongHash = /hash/i.test(e.message);
    fail('Create payment (purchase)', e.message,
      wrongHash ? 'the hash format differs for your account: send the "Purchase" hash section of ABA\'s docs'
        : 'check merchant ID / key, and that ABA enabled the "abapay_khqr_deeplink" payment option');
  }
  pass('Create payment (purchase)', `tran_id ${tranId}, ${amount.toFixed(2)} USD`);
  pass('KHQR received', `${p.qrString.slice(0, 32)}…`);
  if (p.deeplink) pass('ABA deeplink received', p.deeplink.slice(0, 60) + (p.deeplink.length > 60 ? '…' : ''));
  else line('INFO', 'No ABA deeplink in the answer', 'customers can still scan the KHQR');

  const t = await payway.checkTransaction(tranId).catch((e) => ({ error: e.message }));
  if (t.error) fail('Check transaction', t.error);
  if (t.code !== undefined && String(t.code) !== '00' && /hash/i.test(JSON.stringify(t.raw))) {
    fail('Check transaction', JSON.stringify(t.raw).slice(0, 200), 'send the "Check transaction" hash section of ABA\'s docs');
  }
  pass('Check transaction', `status: ${t.status} (not paid yet is expected)`);

  console.log('\n  Next (sandbox): open the deeplink or scan the KHQR with the ABA sandbox app / PayWay test tools,');
  console.log(`  then run: node -e "require('dotenv').config({quiet:true});require('./src/secret').loadSecrets();require('./src/payway').checkTransaction('${tranId}').then(r=>console.log(r.status, r.paid))"`);
  summary();
})();
