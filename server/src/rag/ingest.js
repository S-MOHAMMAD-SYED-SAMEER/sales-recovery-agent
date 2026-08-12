import fs from 'node:fs';
import path from 'node:path';
import { chunkMarkdown } from './chunker.js';

// Factory so tests can ingest into a throwaway vector store with a fake,
// instant embedder instead of the real Chroma collection + local model —
// same pattern as the rest of the codebase (createConversationStore(db),
// createToolExecutor(toolList)).
export function createIngester({ vectorStore, embedBatch, kbDir }) {
  async function ingestFile(file) {
    const fullPath = path.join(kbDir, file);
    const markdown = fs.readFileSync(fullPath, 'utf-8');
    const chunks = chunkMarkdown(markdown);

    // Clear this file's previous chunks first so re-ingesting a document
    // that now produces fewer chunks doesn't leave stale orphans behind —
    // upsert-by-id alone only guards against duplicates, not that.
    await vectorStore.deleteBySource(file);

    if (chunks.length === 0) return 0;

    const embeddings = await embedBatch(chunks.map((c) => c.text));
    const records = chunks.map((chunk, index) => ({
      id: `${file}::${index}`,
      embedding: embeddings[index],
      text: chunk.text,
      metadata: { source: file, heading: chunk.heading, chunkIndex: index },
    }));

    await vectorStore.upsert(records);
    return records.length;
  }

  async function ingestAll() {
    const files = fs.readdirSync(kbDir).filter((f) => f.endsWith('.md'));
    let chunksIngested = 0;

    for (const file of files) {
      chunksIngested += await ingestFile(file);
    }

    return { filesIngested: files.length, chunksIngested };
  }

  return { ingestFile, ingestAll };
}
