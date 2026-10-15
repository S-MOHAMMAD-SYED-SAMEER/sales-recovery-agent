import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config } from './config/env.js';
import defaultChatRouter from './routes/chat.js';
import { createRateLimiter } from './middleware/rateLimiter.js';
import { describeMode } from './routes/mode.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(__dirname, '../../web');

// A chat message is capped at 2,000 characters (routes/chat.js), which is at
// most a few KB of JSON even in a multi-byte script. 16 KB leaves room for the
// envelope and rejects anything larger before it is parsed or reaches a model.
export const JSON_BODY_LIMIT = '16kb';

// Every error leaves this API as a short JSON body. Express's own default
// handler answers with an HTML page that includes the stack trace — file paths
// and all — whenever NODE_ENV isn't "production", which is the case for anyone
// who just runs `npm start`. Only err.message is ever logged, the same
// convention the rest of the server uses.
function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return res.status(400).json({ error: 'Invalid JSON in request body.' });
  }
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body is too large.' });
  }

  console.error('[http] Unhandled error:', err?.message);
  return res.status(500).json({ error: 'Something went wrong. Please try again.' });
}

// Built by a function, not at import time, so tests can start the real app on
// an ephemeral port with a small rate limit or a deliberately failing router,
// and `src/index.js` stays the only place that listens on a port.
export function createApp({
  chatRouter = defaultChatRouter,
  rateLimiter = createRateLimiter({ limit: config.rateLimitMax, windowMs: config.rateLimitWindowMs }),
} = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: JSON_BODY_LIMIT }));
  app.use(express.static(webDir));

  app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
  // Which kind of model answers, for the page's header tag. Provider and model name only.
  app.get('/api/mode', (req, res) => res.json(describeMode()));
  // Scoped to /api/chat only — /api/health above is registered first and is
  // never routed through this, by construction, not by an exclusion check.
  app.use('/api/chat', rateLimiter);
  app.use('/api', chatRouter);

  app.use(errorHandler);
  return app;
}
