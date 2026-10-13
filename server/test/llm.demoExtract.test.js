import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractAnswer, unitsOf } from '../src/llm/providers/demoExtract.js';
import { chunkMarkdown } from '../src/rag/chunker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KB_DIR = path.resolve(__dirname, '../data/kb');

// The real knowledge-base documents, chunked by the real chunker. Retrieval is
// not run here (it needs Chroma and an embedding model), so each test hands the
// extractor the chunks the retriever returns for that question, in that order,
// as observed against the real store.
function chunksOf(file) {
  const markdown = fs.readFileSync(path.join(KB_DIR, file), 'utf-8');
  return chunkMarkdown(markdown).map((chunk) => ({ source: file, ...chunk }));
}

function pick(file, headingEnd) {
  const chunk = chunksOf(file).find((c) => c.heading.endsWith(headingEnd));
  assert.ok(chunk, `no chunk "${headingEnd}" in ${file}`);
  return chunk;
}

const SHIPPING_RESULTS = [
  pick('shipping-policy.md', 'International Shipping'),
  pick('shipping-policy.md', 'Domestic Shipping'),
  pick('shipping-policy.md', 'Delivery Times'),
];
const RETURN_RESULTS = [pick('returns-policy.md', 'Return Window'), pick('returns-policy.md', 'Exchanges')];

const squash = (text) => text.replace(/\s+/g, ' ').trim();

// Every sentence of `answer` must be a sentence of one of the retrieved chunks.
function assertVerbatim(answer, results) {
  const corpus = squash(results.map((r) => r.text).join(' '));
  const sentences = answer.split('\n').flatMap((line) => unitsOf(line).map((u) => u.text));
  assert.ok(sentences.length > 0, 'the answer has no sentences');
  for (const sentence of sentences) {
    assert.ok(corpus.includes(squash(sentence)), `not found verbatim in the retrieved text: "${sentence}"`);
  }
}

test('the shipping chip answers its own question: the international transit times', () => {
  const answer = extractAnswer('How long does international shipping take?', SHIPPING_RESULTS);
  assert.match(answer, /7-12 business days/);
  assert.match(answer, /10-18 business days/);
  assert.doesNotMatch(answer, /3-5/);
  assert.doesNotMatch(answer, /domestic/i);
  assertVerbatim(answer, SHIPPING_RESULTS);
});

test('a domestic question gets the domestic answer, not the international one', () => {
  const answer = extractAnswer('Is there a shipping fee for domestic orders?', SHIPPING_RESULTS);
  assert.match(answer, /\$4\.99/);
  assert.doesNotMatch(answer, /international/i);
  assertVerbatim(answer, SHIPPING_RESULTS);
});

test('the returns chip is answered with the return window, word for word', () => {
  const answer = extractAnswer('What is your return policy?', RETURN_RESULTS);
  assert.match(answer, /within 30 days of the delivery date/);
  assertVerbatim(answer, RETURN_RESULTS);
});

test('a narrower question gets the narrower sentence', () => {
  const answer = extractAnswer('Can I return something after 30 days?', RETURN_RESULTS);
  assert.match(answer, /unable to accept returns after the 30-day window/);
  assert.doesNotMatch(answer, /Items can be returned/);
});

test('a product-care question gets the care instruction for that product', () => {
  const results = [pick('product-info.md', 'Wool Scarf (SCARF-003)')];
  const answer = extractAnswer('How should I wash the wool scarf?', results);
  assert.match(answer, /Hand wash cold/);
  assert.match(answer, /merino/);
  assertVerbatim(answer, results);
});

test('the chunk heading, list markers and markdown never appear in the answer', () => {
  for (const [question, results] of [
    ['How long does international shipping take?', SHIPPING_RESULTS],
    ['What is your return policy?', RETURN_RESULTS],
  ]) {
    const answer = extractAnswer(question, results);
    assert.doesNotMatch(answer, />/);
    assert.doesNotMatch(answer, /Shipping Policy|Returns & Refunds Policy/);
    assert.doesNotMatch(answer, /^\s*[-*#]/m);
    assert.doesNotMatch(answer, /\r/);
  }
});

test('a question that shares nothing with the passages gets the opening of the best passage', () => {
  const answer = extractAnswer('zzz qqq', RETURN_RESULTS);
  assert.match(answer, /^Items can be returned within 30 days/);
  assertVerbatim(answer, RETURN_RESULTS);
});

test('at most three sentences are returned', () => {
  const answer = extractAnswer('shipping delivery days international domestic', SHIPPING_RESULTS);
  assert.ok(unitsOf(answer.replace(/\n/g, '\n\n')).length <= 3);
});

test('nothing to extract from gives null', () => {
  assert.equal(extractAnswer('anything', []), null);
  assert.equal(extractAnswer('anything', undefined), null);
  assert.equal(extractAnswer('anything', [{ heading: 'H', text: 'H\n\n' }]), null);
});

test('CRLF text gives the same answer as LF text', () => {
  const crlf = SHIPPING_RESULTS.map((r) => ({ ...r, text: r.text.replace(/\n/g, '\r\n') }));
  assert.equal(
    extractAnswer('How long does international shipping take?', crlf),
    extractAnswer('How long does international shipping take?', SHIPPING_RESULTS)
  );
});

test('unitsOf splits prose into sentences, keeps list items whole, and drops headings and markers', () => {
  const units = unitsOf('## A heading\n\nFirst sentence. Second\nsentence continues here.\n\n- Item one: 3-5 days.\n- Item two.\n');
  assert.deepEqual(units, [
    { text: 'First sentence.', kind: 'sentence' },
    { text: 'Second sentence continues here.', kind: 'sentence' },
    { text: 'Item one: 3-5 days.', kind: 'item' },
    { text: 'Item two.', kind: 'item' },
  ]);
});
