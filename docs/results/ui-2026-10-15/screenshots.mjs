// Screenshots of the real page (served by the live stack on :3000, with its real /api/mode), showing the
// recorded replies and traces of the one real rehearsal run. No model request is made: POST /api/chat is
// answered from the recorded rows, nothing else is changed.
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const OUT = process.argv[2];
const REC = process.argv[3];
const URL = 'http://localhost:3000/';
fs.mkdirSync(OUT, { recursive: true });
const rec = JSON.parse(fs.readFileSync(REC, 'utf8'));
const rows = rec.rows;

const b = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });

async function replay(page) {
  let i = 0;
  await page.route('**/api/chat', async (route) => {
    const row = rows[i++];
    await route.fulfill({
      json: {
        reply: row.finalReply,
        toolsUsed: row.toolsUsed,
        signals: row.signals.map((type) => ({ type, confidence: 0.75, evidence: '' })),
        trace: row.trace,
      },
    });
  });
  for (const row of rows) {
    await page.fill('#message', row.message);
    await page.press('#message', 'Enter');
    await page.waitForFunction((n) => document.querySelectorAll('.turn.assistant .bubble').length >= n, rows.indexOf(row) + 1);
    await page.waitForTimeout(150);
  }
}

// 1. desktop, light, Customer view
const d = await b.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
await d.goto(URL);
await d.waitForTimeout(500);
console.log('tag:', await d.$eval('#mode-tag', (e) => e.textContent));
await replay(d);
await d.waitForTimeout(300);
await d.screenshot({ path: `${OUT}/desktop-light.png` });

// 2. desktop, dark, Operator view on the "still deciding" reply
await d.click('#theme-toggle');
await d.click('#view-operator');
await d.click('.turn.assistant >> nth=3 >> .bubble');
await d.evaluate(() => document.querySelector('.turn.assistant.selected').scrollIntoView({ block: 'center' }));
await d.waitForTimeout(300);
console.log('panel:', JSON.stringify(await d.$$eval('#panel-body .step-label', (els) => els.map((e) => e.textContent))));
await d.screenshot({ path: `${OUT}/desktop-dark-operator.png` });
await d.close();

// 3. 375px mobile (light, Customer), and the Operator sheet
const m = await b.newPage({ viewport: { width: 375, height: 740 }, deviceScaleFactor: 2, colorScheme: 'light' });
await m.goto(URL);
await m.waitForTimeout(500);
await replay(m);
await m.waitForTimeout(300);
const overflow = await m.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
console.log('375px horizontal overflow px:', overflow);
await m.screenshot({ path: `${OUT}/mobile-375.png` });
await m.click('#view-operator');
// The sheet opens on the latest reply and covers the chat; close it to pick another reply.
await m.click('#panel-close');
await m.waitForTimeout(400);
await m.click('.turn.assistant >> nth=3 >> .trace-btn');
await m.waitForTimeout(500);
await m.screenshot({ path: `${OUT}/mobile-375-operator-sheet.png` });
await m.close();
await b.close();
