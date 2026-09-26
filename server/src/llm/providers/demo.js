// A credential-free, deterministic stand-in for a real LLM provider —
// selected with LLM_PROVIDER=demo, no API key of any kind required.
//
// Same contract as ./gemini.js and ./anthropic.js:
//   generateReply({ systemPrompt, messages, tools, executeTool }) -> { text, toolsUsed }
// so llm/index.js, and everything above it (handleChat: memory, signals,
// guardrails, persistence), is completely unaware this isn't a real model.
//
// This is intentionally NOT the eval harness's mock (server/src/eval/runner.js
// ::buildMockGenerateReply), which replays one fixed canned response per
// dataset case and never calls a real tool. This provider recognizes a small,
// fixed set of customer-support intents from the message actually sent, and
// — for intents that need real data — calls the *real* tools
// (getOrderStatus/checkStock/checkDiscount/searchKnowledgeBase) through the
// executeTool it is given, exactly as a real model's function-calling turn
// would. It never reimplements order, stock, discount, or RAG logic itself.
//
// No fuzzy matching, no embeddings, no second LLM: every branch below is a
// fixed regex/keyword check with a fixed reply template, so the same input
// always produces the same output.

export const isConfigured = true;

const FALLBACK_TEXT =
  'This portfolio demo supports a fixed set of example customer-support scenarios. ' +
  'Please choose one of the suggested questions.';

const RAG_UNAVAILABLE_TEXT =
  "Sorry, I couldn't access that store information right now. Please try again in a moment.";
const RAG_NOT_FOUND_TEXT =
  "I don't have information on that specific question. I'd recommend contacting support directly.";

// Recognized product references, mapped to the exact substring `checkStock`
// (server/src/tools/checkStock.js) matches on — this is argument extraction
// only, never the stock data itself: the tool alone decides what's in stock.
const PRODUCT_KEYWORDS = [
  'ceramic mug',
  'mug',
  'linen tote bag',
  'tote bag',
  'tote',
  'wool scarf',
  'scarf',
  'travel candle',
  'candle',
];

// A discount/promo code, as this store's fixed set of codes is always
// shaped: a few letters immediately followed by a few digits (WELCOME10,
// SUMMER20, EXPIRED5). Matched against the raw message, not lowercased,
// only to detect that a code-shaped token is present at all — checkDiscount
// itself normalizes case.
//
// A code-shaped token alone is not enough: "MUG001" (a SKU), "abc123" (an
// order reference) and "day3" are also letters-then-digits, so this is only
// treated as a discount lookup when the message also names the topic —
// mirroring guardrails/policies.js's own DISCOUNT_CLAIM_RE, which already
// requires the same kind of nearby context word for the identical reason.
const DISCOUNT_CODE_RE = /\b([A-Za-z]{3,10}\d{1,3})\b/;
const DISCOUNT_CONTEXT_RE = /\b(discount|coupon|promo|code|valid)\b/i;

// An order id: contextual to the word "order" itself (optionally "order #"),
// not just any digit-or-alphanumeric token in the message — this store's
// real orders are 3-6 digit numbers, but a customer's reference may not be
// (e.g. "order abc123"), and getOrderStatus already reports an honest
// not-found for one that doesn't exist rather than this needing to guess.
// The captured token must contain at least one digit — an order reference
// always does, whether "1001" or "abc123", which is exactly what rules out
// capturing a plain follow-up word like "order please?" or "order status?"
// as if it were the id. getOrderStatus also already strips a leading "ORD-"
// from whatever is captured here.
const ORDER_ID_RE = /\border\s*#?\s*([a-z0-9-]*\d[a-z0-9-]*)\b/i;

const REFUND_ESCALATION_RE = /\brefund\b/i;
const DAMAGE_RE = /\b(damag|broken|defective|arrived (broken|damaged))\b/i;
const HESITATION_RE = /\b(still deciding|not sure if i need|on the fence|thinking (it|about it) over|haven'?t decided)\b/i;
const POLICY_RE = /\b(ship|shipping|deliver|delivery|international|return|returns|refund polic|policy|faq|wash|care|warranty)\b/i;

function lastUserMessage(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') return messages[i].content;
  }
  return '';
}

function findProductKeyword(lowerMessage) {
  // Longest match first, so "linen tote bag" wins over the looser "tote".
  const sorted = [...PRODUCT_KEYWORDS].sort((a, b) => b.length - a.length);
  return sorted.find((keyword) => lowerMessage.includes(keyword)) || null;
}

// executeTool always succeeds (ok: true) for every call this provider makes
// in practice — arguments are always well-formed, and searchKnowledgeBase
// already turns an infrastructure failure into a found:false result rather
// than throwing (see rag/searchKnowledgeBaseTool.js). This guard exists so
// an unexpected dispatcher-level failure (tools/index.js::createToolExecutor
// catching something unanticipated) degrades to the same honest fallback
// every other unsupported case gets, instead of throwing out of a provider
// that promises never to need a real model to stay up.
function toolFailed(outcome, toolName) {
  return !outcome.ok ? { text: FALLBACK_TEXT, toolsUsed: [toolName] } : null;
}

async function respondOrderStatus(orderId, executeTool) {
  const outcome = await executeTool('getOrderStatus', { orderId });
  const failure = toolFailed(outcome, 'getOrderStatus');
  if (failure) return failure;
  const { result } = outcome;

  if (!result.found) {
    return {
      text: `I couldn't find any order with the ID ${result.orderId}. Please double-check the order number.`,
      toolsUsed: ['getOrderStatus'],
    };
  }

  const tracking = result.trackingNumber
    ? ` Tracking number ${result.trackingNumber}${result.carrier ? ` via ${result.carrier}` : ''}.`
    : '';
  return {
    text: `Order ${result.orderId} is currently ${result.status}.${tracking} Estimated delivery: ${result.estimatedDelivery}.`,
    toolsUsed: ['getOrderStatus'],
  };
}

async function respondStock(product, executeTool) {
  const outcome = await executeTool('checkStock', { product });
  const failure = toolFailed(outcome, 'checkStock');
  if (failure) return failure;
  const { result } = outcome;

  if (!result.found) {
    return {
      text: `I couldn't find a product matching "${product}" in our catalog.`,
      toolsUsed: ['checkStock'],
    };
  }

  const text = result.inStock
    ? `Yes, the ${result.name} is in stock — ${result.quantity} available.`
    : `The ${result.name} is currently out of stock.`;
  return { text, toolsUsed: ['checkStock'] };
}

async function respondDiscount(code, executeTool) {
  const outcome = await executeTool('checkDiscount', { code });
  const failure = toolFailed(outcome, 'checkDiscount');
  if (failure) return failure;
  const { result } = outcome;

  if (result.valid) {
    return {
      text: `Yes, ${result.code} is valid — ${result.percentOff}% off. ${result.description}`,
      toolsUsed: ['checkDiscount'],
    };
  }
  if (result.description) {
    // A known code, but not active (checkDiscount spread its record: has
    // description/percentOff/expires even though valid is false).
    return {
      text: `${result.code} exists but is no longer active — it expired ${result.expires}.`,
      toolsUsed: ['checkDiscount'],
    };
  }
  return {
    text: `I couldn't find a discount code called "${result.code}".`,
    toolsUsed: ['checkDiscount'],
  };
}

async function respondKnowledgeBase(query, executeTool) {
  const outcome = await executeTool('searchKnowledgeBase', { query });
  const failure = toolFailed(outcome, 'searchKnowledgeBase');
  if (failure) return failure;
  const { result } = outcome;

  if (result.found) {
    // The knowledge-base chunk's own text — real, committed store content,
    // not generated here. See server/data/kb/*.md.
    return { text: result.results[0].text, toolsUsed: ['searchKnowledgeBase'] };
  }

  // Two distinct "no answer" cases from the tool (see
  // rag/searchKnowledgeBaseTool.js): a genuine no-match vs. the knowledge
  // base being unreachable (e.g. no Chroma server running). Either way the
  // tool's own `message` field is written as an instruction to a real model,
  // not customer-facing copy, so it is never relayed verbatim here.
  return {
    text: result.unavailable ? RAG_UNAVAILABLE_TEXT : RAG_NOT_FOUND_TEXT,
    toolsUsed: ['searchKnowledgeBase'],
  };
}

// Deliberately reproduces the one failure mode guardrails exist to catch —
// an unsupported refund promise — so the demo shows the real guardrail
// pipeline in handleChat (server/src/guardrails/) intercepting and replacing
// it, not a scripted "guardrail example" the provider fakes on its own. No
// guardrail logic is duplicated here; this text is simply left unsafe on
// purpose and handed onward unmodified.
function respondDamagedRefundEscalation() {
  return {
    text: "I'll refund you right away for the damaged item — so sorry about that!",
    toolsUsed: [],
  };
}

function respondHesitation() {
  return {
    text:
      "No worries — it's a big decision! I'm happy to check stock, look up a discount code, or answer a " +
      'shipping or returns question for you. Just let me know what would help.',
    toolsUsed: [],
  };
}

export async function generateReply({ messages, executeTool }) {
  const message = lastUserMessage(messages);
  const lower = message.toLowerCase();

  // Order matters: most specific/least ambiguous checks first.

  if (REFUND_ESCALATION_RE.test(lower) && DAMAGE_RE.test(lower)) {
    return respondDamagedRefundEscalation();
  }

  if (ORDER_ID_RE.test(message)) {
    const orderId = message.match(ORDER_ID_RE)[1];
    return respondOrderStatus(orderId, executeTool);
  }

  const discountMatch = message.match(DISCOUNT_CODE_RE);
  if (discountMatch && DISCOUNT_CONTEXT_RE.test(lower)) {
    return respondDiscount(discountMatch[1], executeTool);
  }

  const productKeyword = findProductKeyword(lower);
  if (productKeyword && /\b(stock|available|availability|carry|carrying)\b/i.test(lower)) {
    return respondStock(productKeyword, executeTool);
  }

  if (POLICY_RE.test(lower)) {
    return respondKnowledgeBase(message, executeTool);
  }

  if (HESITATION_RE.test(lower)) {
    return respondHesitation();
  }

  return { text: FALLBACK_TEXT, toolsUsed: [] };
}
