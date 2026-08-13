import { config } from '../config/env.js';
import { createVectorStore } from './vectorStore.js';
import { createRetriever } from './retriever.js';
import { createIngester } from './ingest.js';
import { createKnowledgeBaseRestorer } from './demoKnowledgeBase.js';
import { embedText, embedBatch } from './embeddings.js';

const vectorStore = createVectorStore({
  host: config.chromaHost,
  port: config.chromaPort,
  ssl: config.chromaSsl,
  collectionName: config.chromaCollection,
});

export const retriever = createRetriever({ vectorStore, embedText });

// Same ingester the `npm run ingest` script uses, over the same committed
// demo documents — the restorer re-runs the existing pipeline rather than
// introducing a second way to load the knowledge base.
const ingester = createIngester({ vectorStore, embedBatch, kbDir: config.kbDir });

export const knowledgeBaseRestorer = createKnowledgeBaseRestorer({ vectorStore, ingester });

export { vectorStore };
