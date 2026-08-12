import { config } from '../config/env.js';
import { createVectorStore } from './vectorStore.js';
import { createRetriever } from './retriever.js';
import { embedText } from './embeddings.js';

const vectorStore = createVectorStore({
  host: config.chromaHost,
  port: config.chromaPort,
  collectionName: config.chromaCollection,
});

export const retriever = createRetriever({ vectorStore, embedText });

export { vectorStore };
