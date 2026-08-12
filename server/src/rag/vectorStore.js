import { ChromaClient } from 'chromadb';

// We always supply precomputed embeddings ourselves (see embeddings.js), so
// Chroma never needs to compute one — this satisfies the JS client's
// requirement that a collection have *some* embedding function configured,
// without pulling in an extra package or a remote embedding provider.
class ExternalEmbeddingFunction {
  name = 'external';

  async generate() {
    throw new Error('ExternalEmbeddingFunction.generate() should never be called — embeddings are always supplied explicitly.');
  }

  getConfig() {
    return {};
  }

  validateConfigUpdate() {}

  static buildFromConfig() {
    return new ExternalEmbeddingFunction();
  }
}

// Thin wrapper over the Chroma JS client, scoped to one collection. Factory
// (not a module-level singleton) so tests can point it at a throwaway
// collection instead of the real knowledge-base one — same pattern as
// createConversationStore(db) in memory/conversationStore.js.
export function createVectorStore({ host, port, collectionName }) {
  const client = new ChromaClient({ host, port });
  let collectionPromise;

  function getCollection() {
    if (!collectionPromise) {
      collectionPromise = client.getOrCreateCollection({
        name: collectionName,
        // Cosine distance makes the returned "distance" directly usable as
        // a relevance score (score = 1 - distance) for threshold filtering.
        metadata: { 'hnsw:space': 'cosine' },
        embeddingFunction: new ExternalEmbeddingFunction(),
      });
    }
    return collectionPromise;
  }

  return {
    // records: [{ id, embedding, text, metadata }]. upsert (not add) so
    // re-running ingestion with the same deterministic ids replaces the
    // existing chunk instead of creating a duplicate.
    async upsert(records) {
      if (records.length === 0) return;
      const collection = await getCollection();
      await collection.upsert({
        ids: records.map((r) => r.id),
        embeddings: records.map((r) => r.embedding),
        documents: records.map((r) => r.text),
        metadatas: records.map((r) => r.metadata),
      });
    },

    async query(queryEmbedding, { topK = 5 } = {}) {
      const collection = await getCollection();
      const count = await collection.count();
      if (count === 0) return [];

      const result = await collection.query({
        queryEmbeddings: [queryEmbedding],
        nResults: Math.min(topK, count),
      });

      const ids = result.ids?.[0] || [];
      const documents = result.documents?.[0] || [];
      const metadatas = result.metadatas?.[0] || [];
      const distances = result.distances?.[0] || [];

      return ids.map((id, i) => ({
        id,
        text: documents[i],
        metadata: metadatas[i] || {},
        distance: distances[i],
        score: distances[i] === undefined ? undefined : 1 - distances[i],
      }));
    },

    async count() {
      const collection = await getCollection();
      return collection.count();
    },

    // Deletes every chunk previously ingested from a given source file.
    // Ingestion calls this before re-adding a file's chunks so that if a
    // document shrinks (fewer chunks than last time), the old extra chunks
    // don't linger as orphaned, stale entries — upsert-by-id alone only
    // prevents duplicates, not that kind of drift.
    async deleteBySource(source) {
      const collection = await getCollection();
      await collection.delete({ where: { source } });
    },

    // Test-only: wipe and recreate the collection so each test starts clean.
    async reset() {
      try {
        await client.deleteCollection({ name: collectionName });
      } catch {
        // collection didn't exist yet — nothing to clean up
      }
      collectionPromise = undefined;
    },
  };
}
