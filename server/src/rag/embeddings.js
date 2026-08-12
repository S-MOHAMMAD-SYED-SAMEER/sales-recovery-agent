import { pipeline } from '@huggingface/transformers';

const MODEL = 'Xenova/all-MiniLM-L6-v2';

// Local, in-process embeddings — no external API, no API key, no per-call
// cost. Model weights (~90MB) download once from the Hugging Face Hub on
// first use and are cached under the OS cache dir afterward. Same reasoning
// as the M1 architecture proposal: avoids adding a second paid vendor for a
// knowledge base of a handful of short documents, where a hosted embeddings
// API's quality edge wouldn't be visible.
let embedderPromise;
function getEmbedder() {
  if (!embedderPromise) {
    embedderPromise = pipeline('feature-extraction', MODEL);
  }
  return embedderPromise;
}

export async function embedText(text) {
  const embedder = await getEmbedder();
  const output = await embedder(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

export async function embedBatch(texts) {
  const embedder = await getEmbedder();
  const vectors = [];
  for (const text of texts) {
    const output = await embedder(text, { pooling: 'mean', normalize: true });
    vectors.push(Array.from(output.data));
  }
  return vectors;
}
