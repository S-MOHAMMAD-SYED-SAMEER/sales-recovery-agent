// Browser evidence for the follow-up to the UI upgrade (not part of `npm test`). Run against a server on :3112 with
// the DEMO provider (it sends real messages through the page):
//   PORT=3112 LLM_PROVIDER=demo node src/index.js   then   node headless-check-u4b.mjs <screenshot-dir>
// Checks: the "Guardrail checked" and "Guardrail: blocked" chips, the "verified by checkDiscount" note in the Operator
// panel, the cold-start notice (only when the FIRST reply is slow; removed with the reply; never on a later message or a
// fast first one), and the quick-start row at 375 px (first chip keeps the gutter; all five reachable by keyboard).
import { chromium } from 'playwright-core';
const URL = 'http://localhost:3112/';
const b = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const fails = [];
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`); if (!ok) fails.push(name); };
const send = async (p, text, n) => { await p.fill('#message', text); await p.press('#message', 'Enter'); await p.waitForFunction((k) => document.querySelectorAll('.turn.assistant .bubble').length >= k, n); await p.waitForTimeout(150); };

// 1. guardrail chip, and the verification note in the panel
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto(URL);
await send(p, 'Is WELCOME10 valid?', 1);
let chips = await p.$$eval('.turn.assistant:last-of-type .meta .badge', (e) => e.map((x) => x.className + '|' + x.textContent));
console.log('  chips after WELCOME10:', JSON.stringify(chips));
check('Guardrail checked chip on a passed reply', chips.some((c) => c === 'badge guardrail|Guardrail checked'));
await send(p, 'My order arrived damaged, can you refund me?', 2);
chips = await p.$$eval('.turn.assistant:last-of-type .meta .badge', (e) => e.map((x) => x.className + '|' + x.textContent));
console.log('  chips after refund:', JSON.stringify(chips));
check('Guardrail: blocked chip on a blocked reply', chips.some((c) => c === 'badge guardrail blocked|Guardrail: blocked'));
await send(p, 'Hello there', 3);
await p.click('#view-operator');
await p.click('.turn.assistant >> nth=0 >> .bubble');
await p.waitForTimeout(200);
const items = await p.$$eval('#panel-body .step-item', (e) => e.map((x) => x.textContent));
console.log('  panel items for the WELCOME10 reply:', JSON.stringify(items.filter((t) => /discount/.test(t))));
check('panel shows "verified by checkDiscount on this turn"', items.some((t) => t === '✓ no unverified discount claim — WELCOME10: verified by checkDiscount on this turn'));
await p.screenshot({ path: process.argv[2] + '/guardrail-note.png' });
await p.close();

// 2. cold-start notice: only when the first reply is genuinely slow
async function notice(delayFirst, delaySecond) {
  const q = await b.newPage({ viewport: { width: 1000, height: 800 } });
  let n = 0;
  await q.route('**/api/chat', async (r) => { n += 1; await new Promise((x) => setTimeout(x, n === 1 ? delayFirst : delaySecond)); await r.continue(); });
  await q.goto(URL);
  const seen = [];
  const watch = async (ms) => { const t0 = Date.now(); let shown = false; while (Date.now() - t0 < ms) { if (await q.locator('.turn.system .bubble.info').count()) shown = true; await q.waitForTimeout(100); } return shown; };
  await q.fill('#message', 'order 1001 status'); await q.press('#message', 'Enter');
  const midFirst = await watch(Math.max(delayFirst - 300, 200));
  await q.waitForFunction(() => document.querySelectorAll('.turn.assistant .bubble').length >= 1);
  const afterFirst = await q.locator('.turn.system .bubble.info').count();
  await q.fill('#message', 'Is WELCOME10 valid?'); await q.press('#message', 'Enter');
  const secondShown = await watch(Math.max(delaySecond - 300, 200));
  await q.waitForFunction(() => document.querySelectorAll('.turn.assistant .bubble').length >= 2);
  const text = await q.evaluate(() => { const e = document.querySelector('.turn.system .bubble.info'); return e ? e.textContent : null; });
  await q.close();
  return { midFirst, afterFirst, secondShown };
}
const slow = await notice(4200, 3500);
console.log('  slow first message:', JSON.stringify(slow));
check('notice appears when the FIRST reply is slow (4.2 s)', slow.midFirst === true);
check('notice is removed when the reply arrives', slow.afterFirst === 0);
check('notice never appears on a later message, even a slow one', slow.secondShown === false);
const fast = await notice(600, 600);
console.log('  fast first message:', JSON.stringify(fast));
check('no notice when the first reply is fast', fast.midFirst === false);

// 3. chip row at 375 px
const m = await b.newPage({ viewport: { width: 375, height: 740 }, deviceScaleFactor: 2 });
await m.goto(URL);
await m.waitForTimeout(300);
const geo = await m.evaluate(() => {
  const row = document.getElementById('suggestions');
  const chips = [...row.querySelectorAll('.suggestion-chip')];
  const r = row.getBoundingClientRect();
  return { rowLeft: r.left, rowRight: r.right, scrollable: row.scrollWidth > row.clientWidth, firstLeft: chips[0].getBoundingClientRect().left, n: chips.length };
});
console.log('  chip row:', JSON.stringify(geo));
check('first chip is fully visible, with the page gutter (not cut at the left)', geo.firstLeft >= 15);
check('row scrolls sideways on its own (page does not)', geo.scrollable && (await m.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)));
// every chip can be reached by keyboard and ends up fully inside the row
const reached = [];
await m.focus('.suggestion-chip >> nth=0');
for (let i = 0; i < 5; i++) {
  await m.waitForTimeout(400);
  const box = await m.evaluate(() => { const a = document.activeElement; const r = a.getBoundingClientRect(); const row = document.getElementById('suggestions').getBoundingClientRect(); return { text: a.textContent, inside: r.left >= row.left - 1 && r.right <= row.right + 1 }; });
  reached.push(box);
  await m.keyboard.press('Tab');
}
console.log('  keyboard walk:', JSON.stringify(reached));
check('all 5 chips reachable by keyboard and scrolled fully into view', reached.length === 5 && reached.every((x) => x.inside));
await m.close();
await b.close();
console.log(fails.length ? `\nFAILED: ${fails.join('; ')}` : '\nALL PASS');
process.exit(fails.length ? 1 : 0);
