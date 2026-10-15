import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createTrace } from '../src/trace/index.js';

// What the page does with a trace: the chips under an answer and the Operator panel's steps.
//
// The traces below are built with the SERVER's own recorder (src/trace), so the page and the server
// are tested against the same shape rather than against two hand-written copies of it. The DOM is a
// stand-in document that REFUSES innerHTML, so "text nodes only" is enforced here, not claimed.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SraTrace = createRequire(import.meta.url)(path.resolve(__dirname, '../../web/trace.js'));

function fakeDocument() {
  const make = (tag) => {
    const el = {
      tag,
      className: '',
      attrs: {},
      children: [],
      appendChild(child) {
        this.children.push(child);
        return child;
      },
      setAttribute(name, value) {
        this.attrs[name] = String(value);
      },
    };
    let own = '';
    Object.defineProperty(el, 'textContent', {
      get: () => own,
      set(value) {
        own = String(value);
        el.children = own === '' ? [] : [{ text: own }];
      },
    });
    for (const forbidden of ['innerHTML', 'outerHTML', 'insertAdjacentHTML']) {
      Object.defineProperty(el, forbidden, {
        set() {
          throw new Error(`${forbidden} was used`);
        },
      });
    }
    return el;
  };
  return {
    createElement: make,
    createElementNS: (ns, tag) => make(tag),
    createTextNode: (text) => ({ text: String(text) }),
  };
}

/** The visible text of a node tree, one string. */
function textOf(node) {
  if ('text' in node) return node.text;
  return node.children.map(textOf).join(' ');
}
/** Every element with the given class. */
function findAll(node, cls, out = []) {
  if (node.className && node.className.split(' ').includes(cls)) out.push(node);
  for (const child of node.children || []) if (!('text' in child)) findAll(child, cls, out);
  return out;
}

const POLICIES = ['no_unverified_discount_claim', 'no_unsupported_refund_promise', 'no_internal_disclosure'];

// The trace of "I like it, but I'm still deciding", as the server records it.
function hesitationTrace() {
  const t = createTrace({ model: { provider: 'gemini', model: 'gemini-3.5-flash-lite' } });
  t.signal({ type: 'purchase_hesitation', confidence: 0.75, evidence: 'still deciding' });
  t.modelCall({ latencyMs: 640, usage: { inputTokens: 1204, outputTokens: 18, latencyMs: 640 } });
  const done = t.toolStarted('searchKnowledgeBase', { query: 'return policy' });
  t.retrieve({
    query: 'return policy',
    results: [
      { id: 'returns-policy.md#0', source: 'returns-policy.md', heading: 'Return window', text: 'FULL TEXT MUST NOT BE HERE', score: 0.82 },
      { id: 'returns-policy.md#1', source: 'returns-policy.md', heading: 'Conditions', text: 'x', score: 0.6 },
    ],
  });
  done({ ok: true, result: { found: true, results: [{}, {}] } });
  t.modelCall({ latencyMs: 900, usage: { inputTokens: 1500, outputTokens: 80, latencyMs: 900 } });
  for (const policy of POLICIES) t.guardrail({ policy, outcome: 'pass' });
  return t.snapshot();
}

test('chips: tools, store files and signals come from the trace, each once', () => {
  const chips = SraTrace.chipsFor({ reply: 'x', toolsUsed: ['searchKnowledgeBase'], trace: hesitationTrace() });

  assert.deepEqual(chips.tools, ['Checked store information']);
  assert.deepEqual(chips.sources, ['returns-policy.md']);
  assert.deepEqual(chips.signals, ['Noticed: hesitation']);
});

test('chips: a turn that used no tool and fired no signal has none, and a repeated tool is shown once', () => {
  const t = createTrace();
  const a = t.toolStarted('checkStock', { product: 'mug' });
  a({ ok: true, result: { found: true, inStock: true, quantity: 3 } });
  const b = t.toolStarted('checkStock', { product: 'scarf' });
  b({ ok: true, result: { found: true, inStock: false, quantity: 0 } });
  assert.deepEqual(SraTrace.chipsFor({ trace: t.snapshot() }).tools, ['Checked product availability']);

  assert.deepEqual(SraTrace.chipsFor({ trace: createTrace().snapshot() }), { tools: [], sources: [], signals: [], guardrail: null });
});

test('chips: a knowledge base that was down names no source', () => {
  const t = createTrace();
  t.retrieve({ query: 'q', results: [], unavailable: true });
  assert.deepEqual(SraTrace.chipsFor({ trace: t.snapshot() }).sources, []);
});

test('chips: a reply without a trace (an older server) falls back to toolsUsed and signals, and invents no source', () => {
  const chips = SraTrace.chipsFor({ reply: 'x', toolsUsed: ['getOrderStatus', 'mysteryTool'], signals: [{ type: 'price_concern' }] });

  assert.deepEqual(chips, { tools: ['Checked order status', 'mysteryTool'], sources: [], signals: ['Noticed: price concern'], guardrail: null });
  assert.deepEqual(SraTrace.chipsFor(null), { tools: [], sources: [], signals: [], guardrail: null });
});

test('the panel lists the steps in the order they ran, with the labels an operator reads', () => {
  const view = SraTrace.buildView(hesitationTrace());

  assert.deepEqual(
    view.rows.map((r) => r.label),
    [
      'Signal: hesitation',
      'Model call',
      'Searched knowledge base',
      'Sources: returns-policy.md',
      'Model call',
      'Guardrail: passed',
    ]
  );
  assert.deepEqual(
    view.rows.map((r) => r.kind),
    ['signal', 'model', 'tool', 'retrieve', 'model', 'guardrail']
  );
  assert.equal(typeof view.totalMs, 'number');
});

test('each row carries the facts of its step: the match, the model and tokens, the query, the chunk ids', () => {
  const rows = SraTrace.buildView(hesitationTrace()).rows;

  assert.deepEqual(rows[0].detail, ['Matched “still deciding”', 'Confidence 0.75']);
  assert.deepEqual(rows[1].detail.slice(0, 3), ['gemini · gemini-3.5-flash-lite', '640 ms', '1,204 tokens in · 18 out']);
  assert.ok(rows[2].detail.includes('query: “return policy”'));
  assert.ok(rows[2].detail.includes('2 passage(s)'));
  assert.deepEqual(
    rows[3].items.map((i) => i.text),
    ['returns-policy.md#0 · Return window · relevance 0.82', 'returns-policy.md#1 · Conditions · relevance 0.6']
  );
  assert.equal(rows[5].items.length, POLICIES.length);
  assert.ok(rows[5].items.every((i) => i.tone === 'ok'));
});

test('a tool is "Called <name>" with its arguments and a summary of what it returned', () => {
  const t = createTrace();
  const done = t.toolStarted('getOrderStatus', { orderId: '1001' });
  done({ ok: true, result: { found: true, status: 'shipped', carrier: 'DHL' } });

  const [row] = SraTrace.buildView(t.snapshot()).rows;
  assert.equal(row.label, 'Called getOrderStatus');
  assert.equal(row.tone, 'ok');
  assert.ok(row.detail.includes('orderId: “1001”'));
  assert.ok(row.detail.includes('found · shipped · via DHL'));
});

test('a failed tool is shown as a failure', () => {
  const t = createTrace();
  const done = t.toolStarted('getOrderStatus', { orderId: '1' });
  done({ ok: false, error: 'getOrderStatus failed to execute.' });

  const [row] = SraTrace.buildView(t.snapshot()).rows;
  assert.equal(row.tone, 'fail');
  assert.ok(row.detail.includes('failed: getOrderStatus failed to execute.'));
});

test('a blocked draft is "Guardrail: blocked", names the policy and its reason, and says what the customer saw', () => {
  const t = createTrace();
  t.guardrail({ policy: 'no_unverified_discount_claim', outcome: 'pass' });
  t.guardrail({ policy: 'no_unsupported_refund_promise', outcome: 'block', reason: 'The reply promises a refund.', rule: 'refund-promise' });
  t.guardrail({ policy: 'no_internal_disclosure', outcome: 'pass' });

  const view = SraTrace.buildView(t.snapshot());
  assert.equal(view.rows.length, 1, 'the policies are one row');
  const [row] = view.rows;
  assert.equal(row.label, 'Guardrail: blocked');
  assert.equal(row.tone, 'fail');
  assert.deepEqual(row.detail, ['no unsupported refund promise: The reply promises a refund.', 'The customer saw the safe fallback reply']);
  assert.deepEqual(row.items.map((i) => i.mark), ['pass', 'block', 'pass']);

  const doc = fakeDocument();
  const container = doc.createElement('div');
  SraTrace.renderTrace(doc, container, t.snapshot());
  const items = findAll(container, 'step-item').map(textOf);
  // The outcome is in the words, not only the colour.
  assert.deepEqual(items, ['✓ no unverified discount claim', '✕ no unsupported refund promise', '✓ no internal disclosure']);
});

test('the demo provider\'s step is labelled as scripted, not as a model call', () => {
  const t = createTrace();
  t.scriptedProvider({ provider: 'demo', latencyMs: 3 });
  const [row] = SraTrace.buildView(t.snapshot()).rows;

  assert.equal(row.label, 'Demo assistant');
  assert.ok(row.detail.includes('Scripted replies: no model was called'));
  assert.ok(!row.detail.some((d) => /token/.test(d)));
});

test('a knowledge base that was down is shown as unavailable', () => {
  const t = createTrace();
  t.retrieve({ query: 'q', results: [], unavailable: true });
  const [row] = SraTrace.buildView(t.snapshot()).rows;

  assert.equal(row.label, 'Knowledge base unavailable');
  assert.equal(row.tone, 'fail');
});

test('with no trace the panel says so, and shows nothing it was not told', () => {
  for (const missing of [undefined, null, {}, { steps: 'nope' }]) {
    const doc = fakeDocument();
    const container = doc.createElement('div');
    SraTrace.renderTrace(doc, container, missing);
    assert.equal(textOf(container), 'No steps were recorded for this reply.');
  }
  const empty = fakeDocument();
  const box = empty.createElement('div');
  SraTrace.renderTrace(empty, box, { steps: [], totalMs: 5 });
  assert.equal(textOf(box), 'No steps were recorded for this reply.');
});

test('the steps are drawn as an ordered list of text, and re-drawing replaces what was there', () => {
  const doc = fakeDocument();
  const container = doc.createElement('div');
  SraTrace.renderTrace(doc, container, hesitationTrace());
  SraTrace.renderTrace(doc, container, hesitationTrace());

  assert.equal(container.children.filter((c) => c.tag === 'ol').length, 1);
  assert.equal(findAll(container, 'step').length, 6);
  const text = textOf(container);
  assert.match(text, /Signal: hesitation/);
  assert.match(text, /Searched knowledge base/);
  assert.match(text, /Guardrail: passed/);
  assert.match(text, /Total \d+ ms/);
  // The passage text was never in the trace, so it cannot be on the page.
  assert.ok(!text.includes('FULL TEXT MUST NOT BE HERE'));
});

test('words from a customer (a matched phrase, a tool argument) are shown as text and never become markup', () => {
  const attack = '<img src=x onerror=alert(1)> <script>alert(1)</script> "><svg onload=alert(1)>';
  const t = createTrace();
  t.signal({ type: 'purchase_hesitation', confidence: 0.7, evidence: attack });
  const done = t.toolStarted('getOrderStatus', { orderId: attack });
  done({ ok: true, result: { found: false } });

  const doc = fakeDocument(); // throws if innerHTML is ever assigned
  const container = doc.createElement('div');
  SraTrace.renderTrace(doc, container, t.snapshot());

  const tags = new Set();
  (function walk(node) {
    if (node.tag) tags.add(node.tag);
    for (const c of node.children || []) walk(c);
  })(container);
  assert.deepEqual([...tags].sort(), ['div', 'li', 'ol', 'p', 'path', 'span', 'svg'].sort());
  // What got through is the (capped, single-line) text itself.
  assert.match(textOf(container), /<img src=x onerror=alert\(1\)>/);
});

test('icons are decorative: hidden from assistive technology', () => {
  const doc = fakeDocument();
  const container = doc.createElement('div');
  SraTrace.renderTrace(doc, container, hesitationTrace());
  const svgs = [];
  (function walk(node) {
    if (node.tag === 'svg') svgs.push(node);
    for (const c of node.children || []) walk(c);
  })(container);

  assert.ok(svgs.length >= 6);
  assert.ok(svgs.every((s) => s.attrs['aria-hidden'] === 'true' && s.attrs.focusable === 'false'));
});

test('chip: "Guardrail checked" when the guardrails ran and passed the reply, from the trace', () => {
  assert.deepEqual(SraTrace.chipsFor({ trace: hesitationTrace() }).guardrail, { label: 'Guardrail checked', blocked: false });
});

test('chip: "Guardrail: blocked" when a policy blocked the reply; nothing at all when no guardrail step was recorded', () => {
  const t = createTrace();
  t.guardrail({ policy: 'no_unverified_discount_claim', outcome: 'pass' });
  t.guardrail({ policy: 'no_unsupported_refund_promise', outcome: 'block', reason: 'x', rule: 'refund-promise' });
  assert.deepEqual(SraTrace.chipsFor({ trace: t.snapshot() }).guardrail, { label: 'Guardrail: blocked', blocked: true });

  const noGuardrail = createTrace();
  noGuardrail.signal({ type: 'price_concern', confidence: 0.8, evidence: 'too expensive' });
  assert.equal(SraTrace.chipsFor({ trace: noGuardrail.snapshot() }).guardrail, null);
  // There is no "rewritten" state: a policy that objects replaces the whole reply.
  assert.ok(!JSON.stringify(SraTrace.chipsFor({ trace: t.snapshot() })).includes('rewritten'));
});

test('the panel shows what a policy relied on, as the server recorded it, next to that policy', () => {
  const t = createTrace();
  t.guardrail({ policy: 'no_unverified_discount_claim', outcome: 'pass', verified: [{ code: 'WELCOME10', basis: 'earlier-turn', turn: 2 }] });
  t.guardrail({ policy: 'no_unverified_stock_claim', outcome: 'pass' });

  const [row] = SraTrace.buildView(t.snapshot()).rows;
  assert.deepEqual(
    row.items.map((i) => i.text),
    ['no unverified discount claim — WELCOME10: verified by checkDiscount on turn 2 of this conversation', 'no unverified stock claim']
  );
});
