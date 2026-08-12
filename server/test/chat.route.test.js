import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleChat } from '../src/routes/chat.js';
import { createDb } from '../src/memory/db.js';
import { createConversationStore } from '../src/memory/conversationStore.js';

function freshStore() {
  return createConversationStore(createDb(':memory:'));
}

test('rejects a request with an empty message', async () => {
  const store = freshStore();
  const result = await handleChat(
    { sessionId: 's1', message: '  ' },
    { conversationStore: store, generateReply: async () => 'unused' }
  );
  assert.equal(result.status, 400);
});

test('rejects a request with no sessionId', async () => {
  const store = freshStore();
  const result = await handleChat(
    { sessionId: '', message: 'hi' },
    { conversationStore: store, generateReply: async () => 'unused' }
  );
  assert.equal(result.status, 400);
});

test('passes prior conversation history to generateReply and persists the new turn', async () => {
  const store = freshStore();
  store.saveMessage('s1', 'user', 'earlier question');
  store.saveMessage('s1', 'assistant', 'earlier answer');

  let receivedMessages;
  const stubGenerateReply = async ({ messages }) => {
    receivedMessages = messages;
    return 'stub reply';
  };

  const result = await handleChat(
    { sessionId: 's1', message: 'new question' },
    { conversationStore: store, generateReply: stubGenerateReply }
  );

  assert.equal(result.status, 200);
  assert.equal(result.body.reply, 'stub reply');
  assert.deepEqual(receivedMessages, [
    { role: 'user', content: 'earlier question' },
    { role: 'assistant', content: 'earlier answer' },
    { role: 'user', content: 'new question' },
  ]);

  assert.deepEqual(store.getHistory('s1'), [
    { role: 'user', content: 'earlier question' },
    { role: 'assistant', content: 'earlier answer' },
    { role: 'user', content: 'new question' },
    { role: 'assistant', content: 'stub reply' },
  ]);
});

test('two sessions calling /api/chat do not see each other\'s history', async () => {
  const store = freshStore();
  const stubGenerateReply = async () => 'ok';

  await handleChat({ sessionId: 'session-x', message: 'hi from X' }, { conversationStore: store, generateReply: stubGenerateReply });
  await handleChat({ sessionId: 'session-y', message: 'hi from Y' }, { conversationStore: store, generateReply: stubGenerateReply });

  const historyX = store.getHistory('session-x');
  const historyY = store.getHistory('session-y');

  assert.equal(historyX.length, 2);
  assert.equal(historyY.length, 2);
  assert.equal(historyX[0].content, 'hi from X');
  assert.equal(historyY[0].content, 'hi from Y');
});

test('returns 502 and does not persist a partial turn when the LLM provider fails', async () => {
  const store = freshStore();
  const result = await handleChat(
    { sessionId: 's1', message: 'hello' },
    {
      conversationStore: store,
      generateReply: async () => {
        throw new Error('provider unavailable');
      },
    }
  );

  assert.equal(result.status, 502);
  assert.deepEqual(store.getHistory('s1'), []);
});

test('degrades gracefully and still answers when the conversation store fails', async () => {
  const brokenStore = {
    getHistory: () => {
      throw new Error('disk error');
    },
    saveMessage: () => {
      throw new Error('disk error');
    },
  };

  let receivedMessages;
  const result = await handleChat(
    { sessionId: 's1', message: 'hello' },
    {
      conversationStore: brokenStore,
      generateReply: async ({ messages }) => {
        receivedMessages = messages;
        return 'ok reply';
      },
    }
  );

  assert.equal(result.status, 200);
  assert.equal(result.body.reply, 'ok reply');
  assert.deepEqual(receivedMessages, [{ role: 'user', content: 'hello' }]);
});
