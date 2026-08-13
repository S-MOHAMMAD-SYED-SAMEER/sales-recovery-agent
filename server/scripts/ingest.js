import { config } from '../src/config/env.js';
import { createVectorStore } from '../src/rag/vectorStore.js';
import { createIngester } from '../src/rag/ingest.js';
import { embedBatch } from '../src/rag/embeddings.js';

const vectorStore = createVectorStore({
  host: config.chromaHost,
  port: config.chromaPort,
  ssl: config.chromaSsl,
  collectionName: config.chromaCollection,
});

const ingester = createIngester({ vectorStore, embedBatch, kbDir: config.kbDir });

const result = await ingester.ingestAll();
console.log(
  `Ingested ${result.chunksIngested} chunk(s) from ${result.filesIngested} file(s) into ` +
    `Chroma collection "${config.chromaCollection}" at ` +
    `${config.chromaSsl ? 'https' : 'http'}://${config.chromaHost}:${config.chromaPort}.`
);
