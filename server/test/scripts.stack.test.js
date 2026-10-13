import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describeProvider, missingKeyMessage } from '../scripts/lib/stack.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(__dirname, '..');

const KEY = 'AQ.not-a-real-key-just-a-test-value';

test('the startup line names the provider and model, and says whether a key is set, never its value', () => {
  const line = describeProvider({ llmProvider: 'gemini', geminiModel: 'gemini-3.5-flash-lite', geminiApiKey: KEY });
  assert.equal(line, '[live] Provider: gemini, model: gemini-3.5-flash-lite (API key is set).');
  assert.ok(!line.includes(KEY));
  assert.ok(!line.includes('AQ.'));

  const anthropic = describeProvider({ llmProvider: 'anthropic', anthropicModel: 'claude-x', anthropicApiKey: KEY });
  assert.match(anthropic, /Provider: anthropic, model: claude-x/);
  assert.ok(!anthropic.includes(KEY));

  assert.match(describeProvider({ llmProvider: 'demo' }), /demo \(a deterministic stand-in, no model, no key\)/);
});

test('a real provider without its key has a clear reason not to start; the demo and a keyed provider do not', () => {
  assert.match(missingKeyMessage({ llmProvider: 'gemini', geminiApiKey: '' }), /GEMINI_API_KEY is not set.*npm run demo/);
  assert.match(missingKeyMessage({ llmProvider: 'gemini', geminiApiKey: undefined }), /GEMINI_API_KEY/);
  assert.match(missingKeyMessage({ llmProvider: 'anthropic', anthropicApiKey: '' }), /ANTHROPIC_API_KEY/);
  assert.equal(missingKeyMessage({ llmProvider: 'gemini', geminiApiKey: KEY }), null);
  assert.equal(missingKeyMessage({ llmProvider: 'demo' }), null);
});

// An empty GEMINI_API_KEY in the environment wins over a real one in server/.env (dotenv never
// overrides a variable that is already set), so this test cannot be changed by whatever a
// developer keeps in their own .env, and it never touches a real key.
test('npm run live refuses to start without a key: exit 1, a clear message, and nothing else started', () => {
  const started = Date.now();
  const result = spawnSync(process.execPath, ['scripts/live.js'], {
    cwd: serverDir,
    env: { ...process.env, GEMINI_API_KEY: '', LLM_PROVIDER: 'anthropic' }, // a stray provider must not matter
    encoding: 'utf-8',
    timeout: 20_000,
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /\[live\] Provider: gemini, model: gemini-3\.5-flash-lite \(API key is NOT set\)/);
  assert.match(result.stderr, /Not starting: GEMINI_API_KEY is not set/);
  assert.doesNotMatch(result.stdout + result.stderr, /Starting a local Chroma|Ingesting|Starting the app|Server listening/);
  assert.ok(Date.now() - started < 15_000, 'it should refuse at once, not after trying Chroma');
});

test('the package scripts: demo and live both exist, and live is the one that needs a key', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(serverDir, 'package.json'), 'utf-8'));
  assert.equal(pkg.scripts.demo, 'node scripts/demo.js');
  assert.equal(pkg.scripts.live, 'node scripts/live.js');
  assert.match(fs.readFileSync(path.join(serverDir, 'scripts/live.js'), 'utf-8'), /provider: 'gemini'/);
  assert.match(fs.readFileSync(path.join(serverDir, 'scripts/demo.js'), 'utf-8'), /provider: 'demo'/);
});
