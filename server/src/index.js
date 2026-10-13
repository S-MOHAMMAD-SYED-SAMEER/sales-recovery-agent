import { config } from './config/env.js';
import { createApp } from './app.js';
import { knowledgeBaseRestorer } from './rag/index.js';

const app = createApp();

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
