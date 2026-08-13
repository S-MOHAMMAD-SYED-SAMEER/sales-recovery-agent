import { ToolValidationError } from '../tools/errors.js';
import { retriever as defaultRetriever, knowledgeBaseRestorer as defaultRestorer } from './index.js';

// Registered as a tool (same shape as the M3 business tools: name,
// description, parameters, execute) so it flows through the exact same
// tool-calling loop — the model decides when it needs stable/reference
// knowledge the same way it decides when it needs live business data,
// through one mechanism. It lives in rag/, not tools/, because its
// implementation (embeddings, vector search) has nothing in common with
// the mock-business-data tools; only the calling convention is shared.
export const name = 'searchKnowledgeBase';

export const description =
  "Search the store's knowledge base — shipping policy, returns/refunds, product info, FAQ — " +
  "for information to answer a customer's question. Only call this for questions about store " +
  'policies, products, or general information. Do not call it for order status, stock levels, ' +
  'or discount codes — those have their own tools.';

export const parameters = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: "The customer's question, or the key topic to search for.",
    },
  },
  required: ['query'],
};

// Two different "no answer" outcomes, kept distinct on purpose:
//
//   found: false                     the knowledge base answered, and has
//                                    nothing relevant — an honest, final
//                                    answer to give the customer.
//   found: false, unavailable: true  the knowledge base could not be
//                                    consulted at all — a temporary failure,
//                                    where "we don't have that information"
//                                    would be a false statement about the
//                                    store rather than about this moment.
//
// Collapsing them would make the agent tell a customer the store has no
// return policy because a lookup happened to fail.
const UNAVAILABLE_MESSAGE =
  'Store information could not be retrieved for this question right now. This is temporary — do ' +
  'not tell the customer the information does not exist, do not guess or invent a policy, and do ' +
  'not describe the cause or name any system, service, or tool. Reply with exactly: "Sorry, I ' +
  'couldn\'t access that store information right now. Please try again in a moment."';

// Exported as a factory so tests can inject a fake retriever without a real
// Chroma connection or embedding model. `restorer` is optional — omitted, the
// tool behaves exactly as it did before demo-KB recovery existed.
export function buildExecute(retriever, restorer) {
  return async function execute(args) {
    const query = args && args.query;

    if (typeof query !== 'string' || !query.trim()) {
      throw new ToolValidationError('query is required and must be a non-empty string.');
    }

    // Handled here, at the tool boundary, rather than by letting the error
    // propagate: the dispatcher's generic catch already keeps the raw message
    // away from the model, but it can only say "searchKnowledgeBase failed to
    // execute", which leaves the model to invent its own customer-facing
    // wording for an infrastructure failure. Returning a controlled result
    // instead means the sentence the customer reads is one this codebase
    // chose. The real error is logged for whoever operates the service, with
    // err.message only — the same convention the rest of the codebase uses.
    let results;
    try {
      results = await retriever.retrieve(query);

      // No matches has two very different causes: the knowledge base answered
      // and genuinely holds nothing relevant, or it came back empty because
      // the demo's store was wiped by a restart. Only the second is worth
      // acting on, and the restorer tells them apart — on a populated store
      // this is an in-memory boolean check costing nothing.
      if (results.length === 0 && restorer) {
        const outcome = await restorer.ensurePopulated();

        if (outcome.restored) {
          // Retry once, so the customer whose question triggered the restore
          // still gets a properly grounded answer instead of being told to
          // come back later. They see nothing of this.
          results = await retriever.retrieve(query);
        } else if (outcome.reason === 'failed') {
          // Retrieval worked a moment ago but the store can't be read or
          // written now — that is an outage, not an empty policy shelf, and
          // must not be reported to the customer as "we have no such policy".
          return { found: false, unavailable: true, message: UNAVAILABLE_MESSAGE };
        }
      }
    } catch (err) {
      console.error('[rag] Knowledge-base retrieval failed:', err.message);
      return { found: false, unavailable: true, message: UNAVAILABLE_MESSAGE };
    }

    if (results.length === 0) {
      return {
        found: false,
        message:
          'No relevant store information was found for this question. Do not guess or invent ' +
          'a policy — tell the customer honestly that you do not have this information.',
      };
    }

    return {
      found: true,
      results: results.map((r) => ({
        source: r.source,
        heading: r.heading,
        text: r.text,
        relevance: Number(r.score.toFixed(3)),
      })),
    };
  };
}

export const execute = buildExecute(defaultRetriever, defaultRestorer);
