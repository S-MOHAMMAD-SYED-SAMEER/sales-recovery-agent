import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from '../src/memory/db.js';
import { createConversationStore } from '../src/memory/conversationStore.js';

function freshStore() {
  return createConversationStore(createDb(':memory:'));
}

test('creates a conversation for a new session', () => {
  const store = freshStore();
  const conversation = store.getOrCreateConversation('session-a');
  assert.equal(conversation.sessionId, 'session-a');
  assert.ok(conversation.id);
});

test('getOrCreateConversation is idempotent for the same session', () => {
  const store = freshStore();
  const first = store.getOrCreateConversation('session-a');
  const second = store.getOrCreateConversation('session-a');
  assert.equal(first.id, second.id);
});

test('saves and retrieves messages in chronological order', () => {
  const store = freshStore();
  store.saveMessage('session-a', 'user', 'hello');
  store.saveMessage('session-a', 'assistant', 'hi there');
  store.saveMessage('session-a', 'user', 'how are you');

  assert.deepEqual(store.getHistory('session-a'), [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi there' },
    { role: 'user', content: 'how are you' },
  ]);
});

test('getHistory returns an empty array for a session that has never sent a message', () => {
  const store = freshStore();
  assert.deepEqual(store.getHistory('never-seen'), []);
});

test('keeps two session histories isolated from each other', () => {
  const store = freshStore();
  store.saveMessage('session-a', 'user', 'from A');
  store.saveMessage('session-b', 'user', 'from B');
  store.saveMessage('session-a', 'assistant', 'reply to A');

  assert.deepEqual(store.getHistory('session-a'), [
    { role: 'user', content: 'from A' },
    { role: 'assistant', content: 'reply to A' },
  ]);
  assert.deepEqual(store.getHistory('session-b'), [{ role: 'user', content: 'from B' }]);
});

test('getHistory keeps only the most recent `limit` messages, still in chronological order', () => {
  const store = freshStore();
  for (let i = 1; i <= 5; i += 1) {
    store.saveMessage('session-a', 'user', `msg-${i}`);
  }

  assert.deepEqual(store.getHistory('session-a', 2), [
    { role: 'user', content: 'msg-4' },
    { role: 'user', content: 'msg-5' },
  ]);
});
