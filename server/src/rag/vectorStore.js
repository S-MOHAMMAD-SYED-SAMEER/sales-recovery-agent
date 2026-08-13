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
// `ssl` defaults to false: the Chroma JS client builds its base URL as
// `${ssl ? 'https' : 'http'}://${host}:${port}`, and local dev talks plain
// HTTP to `chroma run`. A hosted Chroma behind TLS (see config/env.js's
// chromaSsl) sets it to true — the client offers no way to infer the scheme
// from the host, so it has to be passed explicitly.
// `client` is injectable purely so tests can drive the retry logic below
// without a running Chroma server; production callers never pass it and get
// a real ChromaClient built from host/port/ssl.
export function createVectorStore({
  host,
  port,
  ssl = false,
  collectionName,
  client = new ChromaClient({ host, port, ssl }),
}) {
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

  // Why this exists: Chroma on a free hosting tier runs in an ephemeral
  // container. When it restarts it comes back with the same collection *name*
  // but a brand-new collection *id* — and the memoized handle above keeps
  // addressing the old, now-deleted id. Every subsequent RAG call then fails
  // for the entire life of the app process, even after the knowledge base has
  // been fully re-ingested. Observed in production: retrieval stayed broken
  // through a complete re-ingestion and only an app restart would have cleared
  // it. So: run the operation, and if it fails, throw the handle away, fetch a
  // fresh one, and try exactly once more.
  //
  // The retry deliberately fires on *any* error rather than trying to
  // recognise a stale-collection error specifically. Chroma's error shape for
  // a missing collection isn't part of its documented API and has changed
  // between client versions, so matching on it would be brittle and would
  // silently stop self-healing after a dependency upgrade. Every operation
  // here is idempotent — deterministic upsert ids, delete-by-source, and two
  // read-only calls — so a second attempt is always safe. A transient network
  // blip getting one more chance is a side benefit, not the purpose.
  //
  // Exactly one retry, enforced structurally: there is no loop here, so this
  // cannot retry indefinitely no matter how persistently Chroma fails.
  async function withCollection(operation) {
    try {
      return await operation(await getCollection());
    } catch (firstError) {
      console.warn(
        `[vectorStore] Chroma operation failed (${firstError.message}) — ` +
          'refreshing the collection handle and retrying once.'
      );
      collectionPromise = undefined;
      try {
        return await operation(await getCollection());
      } catch (retryError) {
        // Drop the handle again so the next caller starts clean instead of
        // inheriting a poisoned (rejected) memoized promise. Then let the
        // error propagate untouched — callers above already treat a thrown
        // retrieval error as "no knowledge available," which the agent
        // reports honestly rather than answering from guesswork.
        collectionPromise = undefined;
        throw retryError;
      }
    }
  }

  return {
    // records: [{ id, embedding, text, metadata }]. upsert (not add) so
    // re-running ingestion with the same deterministic ids replaces the
    // existing chunk instead of creating a duplicate.
    async upsert(records) {
      if (records.length === 0) return;
      await withCollection((collection) =>
        collection.upsert({
          ids: records.map((r) => r.id),
          embeddings: records.map((r) => r.embedding),
          documents: records.map((r) => r.text),
          metadatas: records.map((r) => r.metadata),
        })
      );
    },

    async query(queryEmbedding, { topK = 5 } = {}) {
      // Both calls live inside one retried unit: either can be the one that
      // trips over a stale handle, and re-running count() against the fresh
      // collection is what keeps nResults consistent with it.
      const result = await withCollection(async (collection) => {
        const count = await collection.count();
        if (count === 0) return null;

        return collection.query({
          queryEmbeddings: [queryEmbedding],
          nResults: Math.min(topK, count),
        });
      });

      if (result === null) return [];

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
      return withCollection((collection) => collection.count());
    },

    // Deletes every chunk previously ingested from a given source file.
    // Ingestion calls this before re-adding a file's chunks so that if a
    // document shrinks (fewer chunks than last time), the old extra chunks
    // don't linger as orphaned, stale entries — upsert-by-id alone only
    // prevents duplicates, not that kind of drift.
    async deleteBySource(source) {
      await withCollection((collection) => collection.delete({ where: { source } }));
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
