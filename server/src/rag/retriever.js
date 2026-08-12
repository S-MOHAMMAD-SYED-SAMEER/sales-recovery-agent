const DEFAULT_TOP_K = 3;
// Cosine-similarity threshold below which a match is treated as "not
// actually relevant" rather than forced into the model's context anyway.
// Tuned against all-MiniLM-L6-v2: on-topic KB matches for this dataset
// score ~0.5-0.8; off-topic queries (e.g. asking about something the KB
// doesn't cover at all) score well below this. See README for how this was
// checked against real queries.
const DEFAULT_MIN_SCORE = 0.35;

// Factory so tests can retrieve against a throwaway vector store + a fake,
// instant embedder instead of the real Chroma collection + local model.
export function createRetriever({ vectorStore, embedText }) {
  async function retrieve(query, { topK = DEFAULT_TOP_K, minScore = DEFAULT_MIN_SCORE } = {}) {
    const queryEmbedding = await embedText(query);
    const matches = await vectorStore.query(queryEmbedding, { topK });

    return matches
      .filter((match) => typeof match.score === 'number' && match.score >= minScore)
      .map((match) => ({
        source: match.metadata.source,
        heading: match.metadata.heading,
        text: match.text,
        score: match.score,
      }));
  }

  return { retrieve };
}
