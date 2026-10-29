const DEFAULT_TOP_K = 3;
// Cosine-similarity threshold below which a match is treated as "not
// actually relevant" rather than forced into the model's context anyway.
// Set with all-MiniLM-L6-v2 in mind: on-topic KB matches for this dataset
// score ~0.5-0.8; off-topic queries (e.g. asking about something the KB
// doesn't cover at all) score well below this. The value was chosen by hand from those scores; no
// separate tuning experiment is recorded in the repository or its docs.
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
        ...(match.id !== undefined ? { id: match.id } : {}),
        source: match.metadata.source,
        heading: match.metadata.heading,
        text: match.text,
        score: match.score,
      }));
  }

  return { retrieve };
}
