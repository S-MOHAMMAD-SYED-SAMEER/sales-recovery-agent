// Browser evidence for the glyph fix and the cold-start flag (not part of `npm test`). Needs `playwright-core` and a system
// Chrome, and two servers on the DEMO provider (it sends real messages through the page):
//   PORT=3112 LLM_PROVIDER=demo node src/index.js                              (SHOW_COLD_START_NOTICE unset: off)
//   PORT=3113 LLM_PROVIDER=demo SHOW_COLD_START_NOTICE=true node src/index.js  (on)
//   node headless-check-notice-and-glyph.mjs http://localhost:3112 http://localhost:3113
// Checks: the guardrail chip's ::before is a check mark (and, on a blocked reply, a cross), as computed by the browser; the
// "Waking up" notice never appears with the flag off, however slow the first reply, and appears with it on only for a slow
// FIRST reply (removed with the reply, never on a later message, never when the first reply is fast).
import { chromium } from 'playwright-core';

const [OFF, ON] = process.argv.slice(2);
const b = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const fails = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`);
  if (!ok) fails.push(name);
};

async function glyphs(url) {
  const p = await b.newPage({ viewport: { width: 1200, height: 800 } });
  await p.goto(url);
  await p.fill('#message', 'order 1001 status');
  await p.press('#message', 'Enter');
  await p.waitForFunction(() => document.querySelectorAll('.turn.assistant .bubble').length >= 1);
  await p.fill('#message', 'My order arrived damaged, can you refund me?');
  await p.press('#message', 'Enter');
  await p.waitForFunction(() => document.querySelectorAll('.turn.assistant .bubble').length >= 2);
  const g = await p.$$eval('.badge.guardrail', (els) => els.map((e) => ({ text: e.textContent, before: getComputedStyle(e, '::before').content, blocked: e.classList.contains('blocked') })));
  console.log('  guardrail chips:', JSON.stringify(g));
  check('passed reply: the chip starts with a check mark', g[0] && g[0].before === '"\u2713"' && g[0].text === 'Guardrail checked');
  check('blocked reply: the chip starts with a cross', g[1] && g[1].before === '"\u2715"' && g[1].text === 'Guardrail: blocked');
  check('no superscript look-alike anywhere in the chips', !g.some((x) => /[\u00b9\u00b2\u00b3]/.test(x.before)));
  await p.screenshot({ path: new URL('./guardrail-chip-glyphs.png', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1') });
  await p.close();
}

async function notice(url, delayFirst, delaySecond) {
  const q = await b.newPage({ viewport: { width: 1000, height: 800 } });
  let n = 0;
  await q.route('**/api/chat', async (r) => {
    n += 1;
    await new Promise((x) => setTimeout(x, n === 1 ? delayFirst : delaySecond));
    await r.continue();
  });
  await q.goto(url);
  await q.waitForTimeout(500); // /api/mode has answered
  const watch = async (ms) => {
    const t0 = Date.now();
    let shown = false;
    while (Date.now() - t0 < ms) {
      if (await q.locator('.turn.system .bubble.info').count()) shown = true;
      await q.waitForTimeout(100);
    }
    return shown;
  };
  await q.fill('#message', 'order 1001 status');
  await q.press('#message', 'Enter');
  const midFirst = await watch(Math.max(delayFirst - 300, 200));
  await q.waitForFunction(() => document.querySelectorAll('.turn.assistant .bubble').length >= 1);
  const afterFirst = await q.locator('.turn.system .bubble.info').count();
  await q.fill('#message', 'Is WELCOME10 valid?');
  await q.press('#message', 'Enter');
  const secondShown = await watch(Math.max(delaySecond - 300, 200));
  await q.waitForFunction(() => document.querySelectorAll('.turn.assistant .bubble').length >= 2);
  await q.close();
  return { midFirst, afterFirst, secondShown };
}

console.log('--- glyphs');
await glyphs(OFF);
console.log('--- flag OFF (default)');
const off = await notice(OFF, 4200, 3500);
console.log(' ', JSON.stringify(off));
check('flag off: no notice on a slow first reply (4.2 s)', off.midFirst === false && off.afterFirst === 0 && off.secondShown === false);
console.log('--- flag ON');
const on = await notice(ON, 4200, 3500);
console.log(' ', JSON.stringify(on));
check('flag on: notice appears on a slow FIRST reply', on.midFirst === true);
check('flag on: removed when the reply arrives', on.afterFirst === 0);
check('flag on: never on a later slow message', on.secondShown === false);
const fast = await notice(ON, 600, 600);
check('flag on: no notice when the first reply is fast', fast.midFirst === false);
await b.close();
console.log(fails.length ? `\nFAILED: ${fails.join('; ')}` : '\nALL PASS');
process.exit(fails.length ? 1 : 0);
