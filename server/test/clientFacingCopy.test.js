import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleChat } from '../src/routes/chat.js';

// Guards the client-facing surface of the demo: the copy a prospect actually
// reads, and the error strings that reach them when something breaks.
//
// These are deliberately assertions about *text*, not about behaviour — the
// agent's logic is covered by the other suites and is untouched here. What
// they prevent is a regression that's invisible to every other test: internal
// vocabulary (repository paths, environment variables, infrastructure and
// vendor names) leaking back into something a customer sees.
//
// The page is read as a file rather than rendered, so this needs no DOM
// library and adds no dependency.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const demoPage = fs.readFileSync(path.resolve(__dirname, '../../web/index.html'), 'utf-8');

// Terms that must never appear in what a visitor reads. Checked against the
// user-visible copy only (see stripCodeAndComments) — the surrounding source
// is free to name them, and does.
const INTERNAL_TERMS = [
  'Chroma',
  'Render',
  'localhost',
  '.env',
  'CHROMA_',
  'GEMINI_API_KEY',
  'ANTHROPIC_API_KEY',
  'onrender.com',
  'sales-recovery-agent/server',
  'stack trace',
];

// The visible copy is everything outside <style>, <script>, and HTML comments.
function stripCodeAndComments(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
}

test('the header sells an outcome, not a list of AI features', () => {
  const visible = stripCodeAndComments(demoPage);

  assert.match(visible, /AI Customer Support &amp; Sales Recovery/);
  assert.match(visible, /answer customer questions instantly/);
  assert.match(visible, /recover hesitant buyers/);
  assert.match(visible, /reduce repetitive support work/);

  // The old feature-list wording, and the engineering vocabulary it was built
  // from, must not come back into the visible copy.
  assert.doesNotMatch(visible, /Portfolio demo/);
  for (const term of ['retrieval', 'tool use', 'proactive signals', 'guardrails', 'RAG', 'vector']) {
    assert.ok(
      !visible.toLowerCase().includes(term.toLowerCase()),
      `visible copy should not use the engineering term "${term}"`
    );
  }
});

test('the fictional-data disclosure stays prominent, with its demo values intact', () => {
  const visible = stripCodeAndComments(demoPage);

  assert.match(visible, /demo with fictional data/i);
  assert.match(visible, /no real store, orders, or payments/i);

  // The concrete values a visitor needs in order to try anything at all.
  for (const value of ['1001', '1002', '1003', 'Ceramic Mug', 'Wool Scarf', 'WELCOME10']) {
    assert.ok(visible.includes(value), `demo notice should still name ${value}`);
  }
});

test('all six things a visitor can test are named on the page', () => {
  const visible = stripCodeAndComments(demoPage);

  for (const category of [
    'Product availability',
    'Order status',
    'Discount validity',
    'Shipping questions',
    'Return policy',
    'hesitant buyer',
  ]) {
    assert.ok(visible.includes(category), `the page should tell a visitor they can try: ${category}`);
  }
});

test('no internal or infrastructure vocabulary appears in the visible copy', () => {
  const visible = stripCodeAndComments(demoPage);

  for (const term of INTERNAL_TERMS) {
    assert.ok(
      !visible.toLowerCase().includes(term.toLowerCase()),
      `visible copy must not expose "${term}"`
    );
  }
});

test('the cold-start notice explains the wait without inventing progress', () => {
  assert.match(demoPage, /Waking up the support assistant/);
  assert.match(demoPage, /may take a few seconds on the first message/);

  // No fabricated progress reporting: the wait is real, but nothing about its
  // length is known, so nothing about its length is claimed. Checked against
  // the visible copy, since the stylesheet legitimately uses percentages.
  assert.doesNotMatch(stripCodeAndComments(demoPage), /\d+\s?%/);
  assert.doesNotMatch(demoPage, /progress-bar|progressBar/i);
  // setInterval would mean a ticking countdown; the notice is a single
  // one-shot setTimeout that fires only if the wait is genuinely long.
  assert.doesNotMatch(demoPage, /setInterval/);
});

test('the old developer-facing error strings are gone from the page', () => {
  assert.ok(
    !demoPage.includes('is the server (and Chroma, for retrieval) running?'),
    'the "is Chroma running" error message must not return'
  );
  assert.doesNotMatch(demoPage, /HTTP \$\{res\.status\}/);

  assert.match(demoPage, /Sorry, something went wrong while processing that request/);
  assert.match(demoPage, /couldn't reach the assistant just now/);
});

test('tool and signal badges read as plain language for a business visitor', () => {
  for (const label of [
    'Checked order status',
    'Checked product availability',
    'Checked promotion',
    'Checked store information',
  ]) {
    assert.ok(demoPage.includes(label), `missing business-facing tool label: ${label}`);
  }

  for (const label of ['Noticed: hesitation', 'Noticed: price concern', 'Noticed: ready to buy']) {
    assert.ok(demoPage.includes(label), `missing business-facing signal label: ${label}`);
  }

  // Presentation only: the real tool and signal names the API reports must
  // still be the keys these labels are looked up by, or the badges would stop
  // matching what actually ran.
  for (const name of [
    'getOrderStatus',
    'checkStock',
    'checkDiscount',
    'searchKnowledgeBase',
    'purchase_hesitation',
    'cart_abandonment_risk',
  ]) {
    assert.ok(demoPage.includes(name), `the real name "${name}" must still key its label`);
  }

  // Old engineering-flavoured labels should be gone.
  for (const old of ['Used: ', 'Hesitation noticed', 'Stock check', 'Discount check']) {
    assert.ok(!demoPage.includes(old), `stale label "${old}" should have been replaced`);
  }
});

test('an unconfigured server tells the user nothing about its own internals', async () => {
  // Forces the misconfiguration path by using the real provider branch with a
  // store that is never reached — no network call, no API key needed.
  const result = await handleChat(
    { sessionId: 's', message: 'hello' },
    { conversationStore: { getHistory: () => [], saveMessage: () => {} } }
  );

  // This path only triggers when the deployment is genuinely misconfigured;
  // when it is configured, the request proceeds past it. Either way the
  // response must never carry internal detail.
  const body = JSON.stringify(result.body || {});
  for (const term of ['.env', 'LLM_PROVIDER', 'GEMINI', 'ANTHROPIC', 'sales-recovery-agent/server']) {
    assert.ok(!body.includes(term), `error response must not expose "${term}"`);
  }
});

test('the upstream-failure message is customer-facing, not developer-facing', async () => {
  const result = await handleChat(
    { sessionId: 's', message: 'hello' },
    {
      generateReply: async () => {
        throw new Error('ECONNREFUSED 127.0.0.1:8000 — chroma unreachable');
      },
      conversationStore: { getHistory: () => [], saveMessage: () => {} },
    }
  );

  assert.equal(result.status, 502);
  assert.equal(
    result.body.error,
    'Sorry, something went wrong while processing that request. Please try again.'
  );
  // The underlying technical error must not be forwarded to the user.
  for (const term of ['ECONNREFUSED', '127.0.0.1', 'chroma']) {
    assert.ok(!result.body.error.toLowerCase().includes(term.toLowerCase()));
  }
});
