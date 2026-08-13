// Restores the demo knowledge base when the vector store comes back empty.
//
// Why this is needed: the demo's Chroma runs on a free hosting tier with an
// ephemeral filesystem, so an idle period can leave it running and healthy but
// with the collection emptied or gone. That state is worse than an outage —
// nothing throws, retrieval simply returns no matches, and the agent tells the
// customer the store has no shipping or return policy. Both documents are
// sitting in the repository the whole time.
//
// Scope is deliberately narrow: this re-ingests the four committed fictional
// demo documents so a portfolio visitor gets a working demo days later with
// nobody on hand. It is not a general data-ingestion or sync system, and the
// markdown files in data/kb remain the only source of truth.

const DEFAULT_RETRY_COOLDOWN_MS = 60_000;

export function createKnowledgeBaseRestorer({
  vectorStore,
  ingester,
  retryCooldownMs = DEFAULT_RETRY_COOLDOWN_MS,
  now = () => Date.now(),
}) {
  // Once a populated store has been seen, every later call is an in-memory
  // boolean check — no count(), no network. This is what keeps the normal,
  // healthy path exactly as cheap as it was before.
  let knownPopulated = false;
  // The one in-progress attempt. Concurrent callers await it rather than
  // starting their own, so a burst of messages can never ingest in parallel.
  let inFlight = null;
  // Set after a failure so a persistently broken store isn't re-attempted on
  // every single message. This is the bound that makes an infinite retry loop
  // structurally impossible.
  let nextAttemptAllowedAt = 0;

  async function attempt() {
    // Check before ingesting: a populated store must never be re-ingested,
    // and this is the only call made in the common case.
    const count = await vectorStore.count();
    if (count > 0) {
      knownPopulated = true;
      return { restored: false, reason: 'already-populated', count };
    }

    const { filesIngested, chunksIngested } = await ingester.ingestAll();
    knownPopulated = chunksIngested > 0;
    console.log(
      `[rag] Demo knowledge base restored: ${chunksIngested} chunk(s) from ${filesIngested} file(s).`
    );
    return { restored: knownPopulated, reason: 'restored', filesIngested, chunksIngested };
  }

  // Never throws. Returns why it did or didn't act, so the caller can tell a
  // restorable empty store apart from a store it couldn't reach at all.
  async function ensurePopulated() {
    if (knownPopulated) return { restored: false, reason: 'already-populated' };
    if (inFlight) return inFlight;
    if (now() < nextAttemptAllowedAt) return { restored: false, reason: 'cooling-down' };

    inFlight = (async () => {
      try {
        return await attempt();
      } catch (err) {
        // Operator detail to the logs, never to the customer — err.message
        // only, the same convention used across this codebase.
        console.error('[rag] Demo knowledge-base restore failed:', err.message);
        nextAttemptAllowedAt = now() + retryCooldownMs;
        return { restored: false, reason: 'failed' };
      } finally {
        // Cleared once settled so a later request can try again after the
        // cooldown. Callers already awaiting this promise still get its value.
        inFlight = null;
      }
    })();

    return inFlight;
  }

  return { ensurePopulated };
}
