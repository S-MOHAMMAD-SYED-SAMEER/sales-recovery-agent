import { Router } from 'express';
import { config, isConfigured } from '../config/env.js';
import { generateReply } from '../llm/index.js';

const router = Router();

// M1 skeleton only: no RAG context, no tools, no persisted memory. Proves the
// request/response wiring (client -> Express -> LLM provider -> client) end to end.
const SYSTEM_PROMPT =
  'You are a helpful customer support assistant for a small online store. ' +
  'Keep answers brief and honest. If you are not sure about something, say so.';

router.post('/chat', async (req, res) => {
  const { sessionId, message } = req.body || {};

  if (!sessionId || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'sessionId and a non-empty message are required.' });
  }

  if (!isConfigured) {
    return res.status(500).json({
      error: `Server is missing the API key for LLM_PROVIDER="${config.llmProvider}". Set it in sales-recovery-agent/server/.env.`,
    });
  }

  try {
    const reply = await generateReply({
      systemPrompt: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: message }],
    });

    res.json({ reply, toolsUsed: [], signals: null });
  } catch (err) {
    console.error('[chat] LLM provider error:', err);
    res.status(502).json({ error: 'Failed to get a response from the assistant. Please try again.' });
  }
});

export default router;
