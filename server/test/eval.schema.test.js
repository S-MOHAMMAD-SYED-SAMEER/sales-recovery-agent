import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateDataset, EvalDatasetError } from '../src/eval/schema.js';

function validCase(overrides = {}) {
  return {
    id: 'case-1',
    category: 'rag',
    message: 'How long does shipping take?',
    expected: { tools: ['searchKnowledgeBase'] },
    ...overrides,
  };
}

test('accepts a well-formed dataset and returns it unchanged', () => {
  const dataset = { version: '1.0.0', cases: [validCase()] };
  assert.equal(validateDataset(dataset), dataset);
});

test('rejects a dataset missing a version', () => {
  assert.throws(() => validateDataset({ cases: [validCase()] }), EvalDatasetError);
});

test('rejects a dataset with an empty cases array', () => {
  assert.throws(() => validateDataset({ version: '1.0.0', cases: [] }), EvalDatasetError);
});

test('rejects a dataset with no cases array at all', () => {
  assert.throws(() => validateDataset({ version: '1.0.0' }), EvalDatasetError);
});

test('rejects a case missing an id', () => {
  const dataset = { version: '1.0.0', cases: [validCase({ id: undefined })] };
  assert.throws(() => validateDataset(dataset), /id.*required/i);
});

test('rejects a case missing a category', () => {
  const dataset = { version: '1.0.0', cases: [validCase({ category: undefined })] };
  assert.throws(() => validateDataset(dataset), /category.*required/i);
});

test('rejects a case missing a message', () => {
  const dataset = { version: '1.0.0', cases: [validCase({ message: '' })] };
  assert.throws(() => validateDataset(dataset), /message.*required/i);
});

test('rejects a case with no expected object', () => {
  const dataset = { version: '1.0.0', cases: [validCase({ expected: undefined })] };
  assert.throws(() => validateDataset(dataset), /expected.*required/i);
});

test('rejects a case whose expected object has no fields at all', () => {
  const dataset = { version: '1.0.0', cases: [validCase({ expected: {} })] };
  assert.throws(() => validateDataset(dataset), /at least one expectation/i);
});

test('rejects a case with an unknown expected field', () => {
  const dataset = { version: '1.0.0', cases: [validCase({ expected: { notARealField: true } })] };
  assert.throws(() => validateDataset(dataset), /unknown expected field/i);
});

test('rejects duplicate case ids', () => {
  const dataset = { version: '1.0.0', cases: [validCase({ id: 'dup' }), validCase({ id: 'dup' })] };
  assert.throws(() => validateDataset(dataset), /duplicate id/i);
});

test('rejects malformed priorTurns entries', () => {
  const dataset = {
    version: '1.0.0',
    cases: [validCase({ priorTurns: [{ role: 'not-a-role', content: 'hi' }] })],
  };
  assert.throws(() => validateDataset(dataset), /priorTurns/);
});

test('rejects a malformed mockResponse', () => {
  const dataset = { version: '1.0.0', cases: [validCase({ mockResponse: { text: 'ok' } })] };
  assert.throws(() => validateDataset(dataset), /mockResponse/);
});

test('accepts a case with valid priorTurns and mockResponse', () => {
  const dataset = {
    version: '1.0.0',
    cases: [
      validCase({
        priorTurns: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }],
        mockResponse: { text: 'ok', toolsUsed: [] },
      }),
    ],
  };
  assert.doesNotThrow(() => validateDataset(dataset));
});

test('collects every problem found, not just the first', () => {
  const dataset = {
    cases: [validCase({ id: undefined, category: undefined })],
  };
  try {
    validateDataset(dataset);
    assert.fail('expected validateDataset to throw');
  } catch (err) {
    assert.ok(err instanceof EvalDatasetError);
    assert.ok(err.problems.length >= 3); // missing version + missing id + missing category
  }
});

test('the real shipped dataset is itself schema-valid', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const raw = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../eval/dataset.json'), 'utf-8'));
  assert.doesNotThrow(() => validateDataset(raw));
});
