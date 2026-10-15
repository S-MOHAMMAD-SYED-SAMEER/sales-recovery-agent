import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { handleChat } from '../src/routes/chat.js';
import { createDb } from '../src/memory/db.js';
import { createConversationStore } from '../src/memory/conversationStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, '../scripts/guardrail-fp.js');

const freshStore = () => createConversationStore(createDb(':memory:'));

test('handleChat returns the guardrail verdict and the model draft beside the body, never in it', async () => {
  const blocked = await handleChat(
    { sessionId: 's1', message: 'hello' },
    { conversationStore: freshStore(), generateReply: async () => ({ text: "I'll refund you right away!", toolsUsed: [] }) }
  );
  assert.equal(blocked.guardrail.safe, false);
  assert.equal(blocked.guardrail.draft, "I'll refund you right away!");
  assert.deepEqual(blocked.guardrail.violations.map((v) => v.name), ['no_unsupported_refund_promise']);
  assert.ok(blocked.guardrail.violations[0].reason);
  assert.notEqual(blocked.body.reply, blocked.guardrail.draft); // the customer got the fallback
  assert.deepEqual(Object.keys(blocked.body).sort(), ['reply', 'signals', 'toolsUsed', 'trace']);

  const fine = await handleChat(
    { sessionId: 's2', message: 'hello' },
    { conversationStore: freshStore(), generateReply: async () => ({ text: 'Happy to help.', toolsUsed: [] }) }
  );
  assert.deepEqual(fine.guardrail, { safe: true, violations: [], draft: 'Happy to help.' });
});

test('the benign prompt set is twenty distinct, non-empty customer messages', () => {
  const raw = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../eval/benign-prompts.json'), 'utf-8'));
  assert.equal(raw.prompts.length, 20);
  assert.equal(new Set(raw.prompts.map((p) => p.id)).size, 20);
  assert.ok(raw.prompts.every((p) => typeof p.message === 'string' && p.message.trim().length > 0 && p.message.length <= 2000));
});

function analyze(drafts, labels) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gfp-'));
  try {
    fs.writeFileSync(path.join(dir, 'drafts.json'), JSON.stringify(drafts));
    fs.writeFileSync(path.join(dir, 'labels.json'), JSON.stringify(labels));
    return execFileSync(process.execPath, [SCRIPT, `--analyze=${path.join(dir, 'drafts.json')}`, `--labels=${path.join(dir, 'labels.json')}`], {
      encoding: 'utf-8',
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('--analyze reports false positives and false negatives of the current guardrails against labels made by the AI reviewer', () => {
  const drafts = {
    meta: { model: 'fixture' },
    prompts: [
      // Blocked at capture, and the draft was fine: a false positive under the old rules.
      { id: 'p1', set: 'benign', status: 200, draft: 'You can return it within 30 days.', toolsUsed: ['searchKnowledgeBase'], violations: [{ name: 'no_unverified_discount_claim', reason: 'x' }] },
      // Blocked, and rightly: it promises a refund.
      { id: 'p2', set: 'dataset', status: 200, draft: "I'll refund you right away.", toolsUsed: [], violations: [{ name: 'no_unsupported_refund_promise', reason: 'x' }] },
      // Not blocked, fine.
      { id: 'p3', set: 'benign', status: 200, draft: 'Happy to help.', toolsUsed: [], violations: [] },
      // No answer from the model: not counted.
      { id: 'p4', set: 'benign', status: 502, error: 'x' },
    ],
  };
  const labels = { labels: { p1: { violates: false }, p2: { violates: true }, p3: { violates: false } } };

  const out = analyze(drafts, labels);
  assert.match(out, /Drafts: 3 answered of 4/);
  assert.match(out, /At capture[^\n]*\n[^\n]*false-positive rate: 50\.0% \(1\/2\)\s+\[p1\]/);
  // Today's guardrails do not block p1's draft (the old verdict was recorded, not recomputed).
  assert.match(out, /Current guardrails: blocked 1\/3\n\s+false-positive rate: 0\.0% \(0\/2\)/);
  assert.match(out, /false-negative rate: 0\.0% \(0\/1\)/);
});

test('--analyze flags a draft that nobody has labelled', () => {
  const drafts = { meta: {}, prompts: [{ id: 'p1', set: 'benign', status: 200, draft: 'ok', toolsUsed: [], violations: [] }] };
  assert.match(analyze(drafts, { labels: {} }), /UNLABELLED: p1/);
});
