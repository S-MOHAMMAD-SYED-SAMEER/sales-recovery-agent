import { Router } from 'express';
import { config, isConfigured } from '../config/env.js';
import { generateReply as defaultGenerateReply } from '../llm/index.js';
import { conversationStore as defaultConversationStore } from '../memory/index.js';

const router = Router();

// M4: RAG knowledge-base search added alongside M3's business tools. Still
// no proactive signals or guardrails yet.
const SYSTEM_PROMPT =
  'You are a helpful customer support assistant for a small online store. ' +
  'Keep answers brief and honest. If you are not sure about something, say so. ' +
  'You have tools to look up real order status, product stock, discount code validity, and to ' +
  'search the store\'s knowledge base (shipping policy, returns/refunds, product info, FAQ). ' +
  'Only call a tool when the customer is asking about one of those specific things and you need ' +
  'real information to answer accurately — never call a tool for greetings, small talk, or ' +
  'anything you can already answer from the conversation. ' +
  'Never invent order, stock, or discount information, and never state a store policy or product ' +
  'detail unless it came from the knowledge-base search results — if the search finds nothing ' +
  'relevant, or a tool reports something was not found, say so honestly instead of guessing.';

// Core turn logic, separated from the Express route so it can be unit-tested
// with an injected in-memory store and a stub LLM call — no real DB file,
// network call, or API key required to test it.
export async function handleChat({ sessionId, message }, deps = {}) {
  const generateReply = deps.generateReply || defaultGenerateReply;
  const conversationStore = deps.conversationStore || defaultConversationStore;
  const usingRealProvider = !deps.generateReply;

  if (!sessionId || typeof message !== 'string' || !message.trim()) {
    return { status: 400, body: { error: 'sessionId and a non-empty message are required.' } };
  }

  if (usingRealProvider && !isConfigured) {
    return {
      status: 500,
      body: {
        error: `Server is missing the API key for LLM_PROVIDER="${config.llmProvider}". Set it in sales-recovery-agent/server/.env.`,
      },
    };
  }

  // A history read failure degrades to "no history" rather than failing the
  // request — memory is a continuity nice-to-have, not a hard dependency.
  let history = [];
  try {
    history = conversationStore.getHistory(sessionId);
  } catch (err) {
    console.error('[chat] Failed to load conversation history:', err.message);
  }

  let text;
  let toolsUsed;
  try {
    const result = await generateReply({
      systemPrompt: SYSTEM_PROMPT,
      messages: [...history, { role: 'user', content: message }],
    });
    text = result.text;
    toolsUsed = result.toolsUsed || [];
  } catch (err) {
    console.error('[chat] LLM provider error:', err);
    return { status: 502, body: { error: 'Failed to get a response from the assistant. Please try again.' } };
  }

  // Only the plain user/assistant text is persisted — the tool-call/tool-result
  // exchange that may have happened inside generateReply() is internal to that
  // one turn and never enters conversation memory. Same graceful-degradation
  // rule as the read side: a persistence failure shouldn't stop the user from
  // getting the reply they already paid for.
  try {
    conversationStore.saveMessage(sessionId, 'user', message);
    conversationStore.saveMessage(sessionId, 'assistant', text);
  } catch (err) {
    console.error('[chat] Failed to persist conversation history:', err.message);
  }

  return { status: 200, body: { reply: text, toolsUsed, signals: null } };
}

router.post('/chat', async (req, res) => {
  const { sessionId, message } = req.body || {};
  const result = await handleChat({ sessionId, message });
  res.status(result.status).json(result.body);
});

export default router;
