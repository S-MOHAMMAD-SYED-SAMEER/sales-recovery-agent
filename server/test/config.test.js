import { test } from 'node:test';
import assert from 'node:assert/strict';

// Load dotenv here, before anything imports config/env.js. dotenv only fills
// in variables that aren't already set and its module is cached after the
// first import, so once this has run, the assignments below are the only
// thing deciding what config/env.js sees — the test can't be broken by
// whatever a developer happens to have in their local .env.
import 'dotenv/config';

// config/env.js reads process.env once at module load, so each case needs a
// fresh module instance. A unique query string defeats the ESM module cache.
let loadCount = 0;
async function loadConfig(vars) {
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const mod = await import(`../src/config/env.js?config-test=${loadCount++}`);
  return mod.config;
}

test('chromaSsl defaults to false when CHROMA_SSL is unset', async () => {
  const config = await loadConfig({ CHROMA_SSL: undefined });
  assert.equal(config.chromaSsl, false);
});

test('chromaSsl is true when CHROMA_SSL is "true"', async () => {
  const config = await loadConfig({ CHROMA_SSL: 'true' });
  assert.equal(config.chromaSsl, true);
});

test('chromaSsl tolerates surrounding whitespace and mixed case', async () => {
  for (const value of ['TRUE', ' true ', 'True']) {
    const config = await loadConfig({ CHROMA_SSL: value });
    assert.equal(config.chromaSsl, true, `expected "${value}" to enable SSL`);
  }
});

test('chromaSsl is false for "false", an empty string, and any other value', async () => {
  for (const value of ['false', '', '1', 'yes', 'no']) {
    const config = await loadConfig({ CHROMA_SSL: value });
    assert.equal(config.chromaSsl, false, `expected "${value}" not to enable SSL`);
  }
});

test('chromaSsl is always a boolean, never a raw string', async () => {
  for (const value of [undefined, 'true', 'false', 'banana']) {
    const config = await loadConfig({ CHROMA_SSL: value });
    assert.equal(typeof config.chromaSsl, 'boolean');
  }
});

test('the existing Chroma defaults are unchanged by the CHROMA_SSL addition', async () => {
  const config = await loadConfig({
    CHROMA_SSL: undefined,
    CHROMA_HOST: undefined,
    CHROMA_PORT: undefined,
    CHROMA_COLLECTION: undefined,
  });
  assert.equal(config.chromaHost, 'localhost');
  assert.equal(config.chromaPort, 8000);
  assert.equal(config.chromaCollection, 'sales_recovery_kb');
});

test('explicit Chroma host/port/collection still override the defaults', async () => {
  const config = await loadConfig({
    CHROMA_HOST: 'sales-recovery-chroma.onrender.com',
    CHROMA_PORT: '443',
    CHROMA_SSL: 'true',
    CHROMA_COLLECTION: 'sales_recovery_kb',
  });
  assert.equal(config.chromaHost, 'sales-recovery-chroma.onrender.com');
  assert.equal(config.chromaPort, 443);
  assert.equal(config.chromaSsl, true);
  assert.equal(config.chromaCollection, 'sales_recovery_kb');
});
