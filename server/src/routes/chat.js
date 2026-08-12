import { Router } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { config, isConfigured } from '../config/env.js';

const router = Router();

const anthropic = isConfigured ? new Anthropic({ apiKey: config.anthropicApiKey }) : null;

// M1 skeleton only: no RAG context, no tools, no persisted memory. Proves the
// request/response wiring (client -> Express -> Claude -> client) end to end.
const SYSTEM_PROMPT =
  'You are a helpful customer support assistant for a small online store. ' +
  'Keep answers brief and honest. If you are not sure about something, say so.';

router.post('/chat', async (req, res) => {
  const { sessionId, message } = req.body || {};

  if (!sessionId || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'sessionId and a non-empty message are required.' });
  }

  if (!anthropic) {
    return res.status(500).json({
      error: 'Server is missing ANTHROPIC_API_KEY. Set it in sales-recovery-agent/server/.env.',
    });
  }

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: message }],
    });

    const reply = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');

    res.json({ reply, toolsUsed: [], signals: null });
  } catch (err) {
    console.error('[chat] Claude API error:', err);
    res.status(502).json({ error: 'Failed to get a response from the assistant. Please try again.' });
  }
});

export default router;
