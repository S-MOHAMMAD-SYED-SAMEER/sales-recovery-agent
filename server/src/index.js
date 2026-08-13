import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config } from './config/env.js';
import chatRouter from './routes/chat.js';
import { knowledgeBaseRestorer } from './rag/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(__dirname, '../../web');

const app = express();
app.use(express.json());
// Malformed JSON otherwise falls through to Express's default HTML error
// page, which includes a full server-side stack trace (file paths, etc.) —
// not a secret, but not something a client request should be able to pull
// out of the server either. Respond the same way every other input-
// validation failure in this API does: a clean JSON 400.
app.use((err, req, res, next) => {
  if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return res.status(400).json({ error: 'Invalid JSON in request body.' });
  }
  next(err);
});
app.use(express.static(webDir));

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
app.use('/api', chatRouter);

app.listen(config.port, () => {
  console.log(`Server listening on port ${config.port}`);

  // Best-effort demo knowledge-base restore, deliberately after listen() and
  // never awaited: the server must come up and answer health checks whether or
  // not the vector store is reachable yet. If the store is already populated
  // this is a single count() and nothing else. If it isn't reachable at boot —
  // common, since it may still be waking up — this simply fails quietly and
  // the first customer question triggers the same recovery lazily.
  knowledgeBaseRestorer
    .ensurePopulated()
    .catch((err) => console.error('[rag] Startup knowledge-base check failed:', err.message));
});
