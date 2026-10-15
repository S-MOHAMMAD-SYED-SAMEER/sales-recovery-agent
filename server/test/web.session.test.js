import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createDb } from '../src/memory/db.js';
import { createConversationStore } from '../src/memory/conversationStore.js';

// Every page load starts a new conversation. The chat on screen is empty at load, so the server must not
// continue an older conversation: the model and the guardrails would use questions and verified discount
// codes the viewer cannot see (which is how a "question 16" appeared for a viewer who had asked 7).

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(__dirname, '../../web');
const SraSession = createRequire(import.meta.url)(path.join(webDir, 'session.js'));
const app = fs.readFileSync(path.join(webDir, 'app.js'), 'utf8');
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function fakeStorage(initial = {}) {
  const data = { ...initial };
  const writes = [];
  return {
    data,
    writes,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      writes.push(k);
      data[k] = String(v);
    },
    removeItem: (k) => {
      delete data[k];
    },
  };
}

test('a page load gets a new session id even when an old one is in storage, and the old one is deleted', () => {
  const storage = fakeStorage({ sra_session_id: 'old-conversation', sra_view: 'operator', sra_theme: 'dark' });
  const id = SraSession.startSession(storage, randomUUID);

  assert.notEqual(id, 'old-conversation');
  assert.match(id, /^[A-Za-z0-9_-]{1,64}$/, 'an id the server accepts');
  assert.equal(storage.getItem('sra_session_id'), null);
  // Only what is not conversation state survives: the view and the theme.
  assert.deepEqual(Object.keys(storage.data).sort(), ['sra_theme', 'sra_view']);
  assert.deepEqual(storage.writes, [], 'nothing is written');
});

test('two loads never share an id', () => {
  const storage = fakeStorage();
  const ids = new Set(Array.from({ length: 50 }, () => SraSession.startSession(storage, randomUUID)));
  assert.equal(ids.size, 50);
});

test('storage that is missing or throws does not stop a session starting', () => {
  const throwing = {
    removeItem() {
      throw new Error('blocked');
    },
  };
  assert.match(SraSession.startSession(throwing, randomUUID), /^[0-9a-f-]{36}$/);
  assert.match(SraSession.startSession(null, randomUUID), /^[0-9a-f-]{36}$/);
  assert.match(SraSession.startSession(undefined, randomUUID), /^[0-9a-f-]{36}$/);
});

test('the page keeps no conversation id in browser storage: it only reads and writes the view and the theme', () => {
  const code = stripComments(app);

  assert.doesNotMatch(code, /sra_session_id/, 'the old key is only named inside session.js, to delete it');
  assert.match(code, /SraSession\.startSession\(window\.localStorage, newSessionId\)/);
  // newSessionId makes an id and stores nothing.
  assert.match(code, /const newSessionId = \(\) => crypto\.randomUUID\(\);/);
  // Every key the page touches in storage.
  const keys = [...code.matchAll(/(?:readStored|writeStored)\((\w+)/g)].map((m) => m[1]).filter((k) => k !== 'key'); // `key` is the helpers' own parameter
  assert.ok(keys.length > 0);
  assert.deepEqual([...new Set(keys)].sort(), ['THEME_KEY', 'VIEW_KEY']);
  assert.match(code, /const THEME_KEY = 'sra_theme';/);
  assert.match(code, /const VIEW_KEY = 'sra_view';/);
  assert.doesNotMatch(code, /localStorage\.(getItem|setItem)\(\s*['"]sra_session/);
});

test('the "New conversation" button and a page load use the same way to get an id', () => {
  const code = stripComments(app);
  const uses = [...code.matchAll(/sessionId = (.+?);/g)].map((m) => m[1]);
  assert.deepEqual(uses, ['SraSession.startSession(window.localStorage, newSessionId)', 'newSessionId()']);
});

test('what a reload changes on the server: the new conversation has no history and no verified codes', () => {
  // The same store, two "page loads" (two session ids): the second knows nothing of the first.
  const store = createConversationStore(createDb(':memory:'));
  const first = SraSession.startSession(fakeStorage(), randomUUID);
  store.saveMessage(first, 'user', 'Is WELCOME10 valid?');
  store.saveMessage(first, 'assistant', 'Yes.');
  store.saveVerifiedDiscount(first, { code: 'WELCOME10', valid: true }, 1, 'Is WELCOME10 valid?');
  assert.equal(store.getVerifiedDiscounts(first).length, 1);

  const second = SraSession.startSession(fakeStorage({ sra_session_id: first }), randomUUID);
  assert.notEqual(second, first);
  assert.deepEqual(store.getHistory(second), []);
  assert.deepEqual(store.getVerifiedDiscounts(second), []);
  assert.equal(store.countUserMessages(second), 0);
});
