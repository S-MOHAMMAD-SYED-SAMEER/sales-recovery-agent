import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleChat } from '../src/routes/chat.js';
import { createDb } from '../src/memory/db.js';
import { createConversationStore } from '../src/memory/conversationStore.js';

function freshStore() {
  return createConversationStore(createDb(':memory:'));
}

// These stubs stand in for generateReply() (the llm/index.js contract:
// { text, toolsUsed }). They deliberately hardcode "if the message looks
// like an order/stock/discount question, report that tool as used" to
// emulate what a real model+tool-loop would decide — this tests the
// chat-route <-> generateReply <-> memory plumbing (contract, toolsUsed
// reporting, memory isolation) deterministically and offline. Whether the
// *real* model actually chooses to call the right tool is verified
// separately, live, against the real Gemini adapter (not something a unit
// test should assert on, since that's real LLM judgment, not our code).
function stubReply(text, toolsUsed = []) {
  return async () => ({ text, toolsUsed });
}

test('rejects a request with an empty message', async () => {
  const store = freshStore();
  const result = await handleChat(
    { sessionId: 's1', message: '  ' },
    { conversationStore: store, generateReply: stubReply('unused') }
  );
  assert.equal(result.status, 400);
});

test('rejects a request with no sessionId', async () => {
  const store = freshStore();
  const result = await handleChat(
    { sessionId: '', message: 'hi' },
    { conversationStore: store, generateReply: stubReply('unused') }
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
    return { text: 'stub reply', toolsUsed: [] };
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

  await handleChat({ sessionId: 'session-x', message: 'hi from X' }, { conversationStore: store, generateReply: stubReply('ok') });
  await handleChat({ sessionId: 'session-y', message: 'hi from Y' }, { conversationStore: store, generateReply: stubReply('ok') });

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
        return { text: 'ok reply', toolsUsed: [] };
      },
    }
  );

  assert.equal(result.status, 200);
  assert.equal(result.body.reply, 'ok reply');
  assert.deepEqual(receivedMessages, [{ role: 'user', content: 'hello' }]);
});

test('a normal question that needs no tool reports an empty toolsUsed', async () => {
  const store = freshStore();
  const result = await handleChat(
    { sessionId: 's1', message: 'What are your store hours?' },
    { conversationStore: store, generateReply: stubReply('We are open 9-5.', []) }
  );

  assert.equal(result.status, 200);
  assert.deepEqual(result.body.toolsUsed, []);
});

test('an order-status question surfaces getOrderStatus in toolsUsed', async () => {
  const store = freshStore();
  const result = await handleChat(
    { sessionId: 's1', message: 'Where is my order 1001?' },
    { conversationStore: store, generateReply: stubReply('Your order has shipped.', ['getOrderStatus']) }
  );

  assert.equal(result.status, 200);
  assert.deepEqual(result.body.toolsUsed, ['getOrderStatus']);
});

test('a stock question surfaces checkStock in toolsUsed', async () => {
  const store = freshStore();
  const result = await handleChat(
    { sessionId: 's1', message: 'Is the Ceramic Mug in stock?' },
    { conversationStore: store, generateReply: stubReply('Yes, 42 in stock.', ['checkStock']) }
  );

  assert.equal(result.status, 200);
  assert.deepEqual(result.body.toolsUsed, ['checkStock']);
});

test('a discount question surfaces checkDiscount in toolsUsed', async () => {
  const store = freshStore();
  const result = await handleChat(
    { sessionId: 's1', message: 'Is WELCOME10 still valid?' },
    { conversationStore: store, generateReply: stubReply('Yes, 10% off.', ['checkDiscount']) }
  );

  assert.equal(result.status, 200);
  assert.deepEqual(result.body.toolsUsed, ['checkDiscount']);
});

test('a tool-using turn does not corrupt conversation memory with tool artifacts', async () => {
  const store = freshStore();
  await handleChat(
    { sessionId: 's1', message: 'Where is my order 1001?' },
    { conversationStore: store, generateReply: stubReply('Your order has shipped.', ['getOrderStatus']) }
  );

  const history = store.getHistory('s1');
  assert.deepEqual(history, [
    { role: 'user', content: 'Where is my order 1001?' },
    { role: 'assistant', content: 'Your order has shipped.' },
  ]);
  // Only plain {role, content} pairs — no tool_use/tool_result/functionCall shapes leaked in.
  for (const turn of history) {
    assert.deepEqual(Object.keys(turn).sort(), ['content', 'role']);
  }
});

test('memory keeps working across multiple turns that mix tool and non-tool questions', async () => {
  const store = freshStore();
  const replies = [
    stubReply('Sure, happy to help!', []),
    stubReply('Your order has shipped.', ['getOrderStatus']),
    stubReply('Yes, 42 in stock.', ['checkStock']),
  ];
  let call = 0;
  const generateReply = async (args) => replies[call++](args);

  await handleChat({ sessionId: 's1', message: 'Hi there' }, { conversationStore: store, generateReply });
  await handleChat({ sessionId: 's1', message: 'Where is my order 1001?' }, { conversationStore: store, generateReply });
  await handleChat({ sessionId: 's1', message: 'Is the mug in stock?' }, { conversationStore: store, generateReply });

  const history = store.getHistory('s1');
  assert.equal(history.length, 6);
  assert.deepEqual(
    history.map((m) => m.role),
    ['user', 'assistant', 'user', 'assistant', 'user', 'assistant']
  );
});

// --- M4: RAG knowledge-base search, alongside M3's business tools ---

test('a shipping-policy question surfaces searchKnowledgeBase in toolsUsed', async () => {
  const store = freshStore();
  const result = await handleChat(
    { sessionId: 's1', message: 'Do you ship internationally?' },
    { conversationStore: store, generateReply: stubReply('Yes, we ship to most countries.', ['searchKnowledgeBase']) }
  );

  assert.equal(result.status, 200);
  assert.deepEqual(result.body.toolsUsed, ['searchKnowledgeBase']);
});

test('an unsupported knowledge question is answered honestly instead of fabricated, and still logged as a tool attempt', async () => {
  const store = freshStore();
  // Emulates a real model that called searchKnowledgeBase, got found:false
  // back, and — per the system prompt's instruction — admitted it doesn't
  // know rather than inventing a policy.
  const result = await handleChat(
    { sessionId: 's1', message: 'Do you price-match other stores?' },
    {
      conversationStore: store,
      generateReply: stubReply(
        "I'm not sure — that's not something I have information on. I'd recommend contacting support directly.",
        ['searchKnowledgeBase']
      ),
    }
  );

  assert.equal(result.status, 200);
  assert.deepEqual(result.body.toolsUsed, ['searchKnowledgeBase']);
  assert.match(result.body.reply, /not sure|don't have|do not have/i);
});

test('a RAG-using turn does not corrupt conversation memory with retrieval artifacts', async () => {
  const store = freshStore();
  await handleChat(
    { sessionId: 's1', message: 'What is your return policy?' },
    { conversationStore: store, generateReply: stubReply('You can return items within 30 days.', ['searchKnowledgeBase']) }
  );

  const history = store.getHistory('s1');
  assert.deepEqual(history, [
    { role: 'user', content: 'What is your return policy?' },
    { role: 'assistant', content: 'You can return items within 30 days.' },
  ]);
  for (const turn of history) {
    assert.deepEqual(Object.keys(turn).sort(), ['content', 'role']);
  }
});

test('RAG and business tools coexist correctly within one session, and memory stays isolated across sessions', async () => {
  const storeX = freshStore();
  const replies = [
    stubReply('We ship internationally in 7-12 days.', ['searchKnowledgeBase']),
    stubReply('Order 1001 has shipped.', ['getOrderStatus']),
  ];
  let call = 0;
  const generateReply = async (args) => replies[call++](args);

  await handleChat({ sessionId: 'session-x', message: 'Do you ship internationally?' }, { conversationStore: storeX, generateReply });
  await handleChat({ sessionId: 'session-x', message: 'And where is order 1001?' }, { conversationStore: storeX, generateReply });
  await handleChat(
    { sessionId: 'session-y', message: 'Hi' },
    { conversationStore: storeX, generateReply: stubReply('Hello!', []) }
  );

  const historyX = storeX.getHistory('session-x');
  const historyY = storeX.getHistory('session-y');

  assert.equal(historyX.length, 4);
  assert.equal(historyY.length, 2);
  assert.equal(historyY[0].content, 'Hi');
});
