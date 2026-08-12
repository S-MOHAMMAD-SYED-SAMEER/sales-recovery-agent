import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkMarkdown } from '../src/rag/chunker.js';

test('splits a document into one chunk per H2 section, prefixed with title > heading', () => {
  const markdown = [
    '# Shipping Policy',
    '',
    '## Domestic Shipping',
    '',
    'Ships in 3-5 days.',
    '',
    '## International Shipping',
    '',
    'Ships in 7-12 days.',
  ].join('\n');

  const chunks = chunkMarkdown(markdown);

  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].heading, 'Shipping Policy > Domestic Shipping');
  assert.equal(chunks[0].text, 'Shipping Policy > Domestic Shipping\n\nShips in 3-5 days.');
  assert.equal(chunks[1].heading, 'Shipping Policy > International Shipping');
  assert.match(chunks[1].text, /Ships in 7-12 days\.$/);
});

test('keeps content between the H1 and the first H2 as an Overview chunk instead of dropping it', () => {
  const markdown = ['# FAQ', '', 'General info before any section.', '', '## Payments', '', 'We take cards.'].join('\n');

  const chunks = chunkMarkdown(markdown);

  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].heading, 'FAQ > Overview');
  assert.match(chunks[0].text, /General info before any section\./);
  assert.equal(chunks[1].heading, 'FAQ > Payments');
});

test('returns nothing for an empty document', () => {
  assert.deepEqual(chunkMarkdown(''), []);
  assert.deepEqual(chunkMarkdown('# Just a title, no sections'), []);
});

test('drops an H2 heading with no body text under it', () => {
  const markdown = ['# Doc', '', '## Empty Section', '', '## Real Section', '', 'Has content.'].join('\n');
  const chunks = chunkMarkdown(markdown);

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].heading, 'Doc > Real Section');
});

test('splits a long section into multiple overlapping chunks that all keep the same heading', () => {
  const paragraph = 'Sentence about policy details. '.repeat(40); // long enough to exceed maxChars
  const markdown = ['# Long Doc', '', '## Big Section', '', paragraph.trim(), '', paragraph.trim()].join('\n');

  const chunks = chunkMarkdown(markdown, { maxChars: 200, overlapChars: 30 });

  assert.ok(chunks.length > 1, 'expected the long section to be split into more than one chunk');
  for (const chunk of chunks) {
    assert.equal(chunk.heading, 'Long Doc > Big Section');
  }
});
