import { ToolValidationError } from '../tools/errors.js';
import { retriever as defaultRetriever } from './index.js';

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

// Exported as a factory so tests can inject a fake retriever without a real
// Chroma connection or embedding model.
export function buildExecute(retriever) {
  return async function execute(args) {
    const query = args && args.query;

    if (typeof query !== 'string' || !query.trim()) {
      throw new ToolValidationError('query is required and must be a non-empty string.');
    }

    const results = await retriever.retrieve(query);

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

export const execute = buildExecute(defaultRetriever);
