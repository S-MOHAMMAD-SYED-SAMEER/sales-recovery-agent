// Explicit, individually testable guardrail policies over the assistant's
// final reply text. Each policy is a pure function:
//   (context: { reply, toolsUsed }) -> violation string | null
//
// Deliberately implemented as application logic (regex/keyword checks
// against what actually happened this turn), not just prompt instructions —
// a system prompt is a request the model can still get wrong; these are a
// backstop that runs whether or not the model followed it. Known
// limitation, stated plainly: these check for *specific risky patterns* in
// the reply text, cross-referenced against which tools actually ran this
// turn (`toolsUsed`) — they do not verify that a claim's exact *value*
// (e.g. the right quantity) matches the tool's real result. Value-level
// fact-checking is eval-harness territory (M6), not a runtime guardrail.

const DISCOUNT_CLAIM_RE = /\b\d{1,2}%\s*off\b|\b[a-z]{3,}[- ]?\d{1,3}\b(?=.{0,15}\b(discount|code|off|coupon)\b)/i;
const STOCK_CLAIM_RE = /\b(in stock|out of stock|sold out|currently unavailable|\d+\s*(units?|left|available)\b)/i;
const ORDER_STATUS_RE = /\btracking number\b|\border\s*#?\s*\d{2,}\b.{0,40}\b(shipped|delivered|processing|out for delivery|cancelled|refunded)\b|\b(shipped|delivered|processing|out for delivery)\b.{0,40}\border\s*#?\s*\d{2,}\b|\byour order\b.{0,40}\b(has (shipped|been delivered|been cancelled|been refunded)|is (shipped|delivered|out for delivery|processing|being processed)|was (shipped|delivered))\b/i;
const POLICY_CLAIM_RE = /\b\d{1,3}[\s-]*(to|-)?\s*\d{0,3}\s*(business\s+)?days?\b.{0,40}\b(ship|shipping|deliver|delivery|return|refund)\b|\b(ship|shipping|deliver|delivery|return|refund)\b.{0,40}\b\d{1,3}[\s-]*(to|-)?\s*\d{0,3}\s*(business\s+)?days?\b/i;
const REFUND_PROMISE_RE = /\b(i(?:'|’)?ll (refund|reimburse|compensate) you|we(?:'|’)?ll (refund|reimburse|compensate) you|i will (refund|reimburse|compensate) you|we will (refund|reimburse|compensate) you|i can (offer|give) you a (refund|reimbursement)|i(?:'|’)?ve issued (a|your) refund|issuing (a|your) refund|you(?:'|’)?ll (get|receive) (a refund|your money back)|i(?:'|’)?m (refunding|crediting) you|full refund right away)\b/i;
const INTERNAL_DISCLOSURE_RE = /\b(system prompt|my instructions are|here (is|are) my (instructions|prompt)|api[\s_-]?key|gemini_api_key|anthropic_api_key|\.env\b|executeTool|toolLoop|node:sqlite|source code|internal implementation)\b/i;
const URGENCY_RE = /\b(only \d+ left|hurry|act now|limited time only|selling out fast|won(?:'|’)?t last|last chance|before it(?:'|’)?s too late|running out( fast)?|offer expires soon)\b/i;
const INFERENTIAL_LEAD_IN_RE = /\b(you (seem|appear|must be|are probably)|since you(?:'|’)?re|given that you(?:'|’)?re|as (a|someone) who (is|has))\b/i;
const SENSITIVE_ATTRIBUTE_RE = /\b(pregnan(t|cy)|disab(led|ility)|race|racial|ethnicit(y|ies)|religio(n|us)|sexual(ity)?|orientation|immigration|citizenship status|mental health|(a )?diagnos(is|ed))\b/i;

function usedTool(toolsUsed, name) {
  return Array.isArray(toolsUsed) && toolsUsed.includes(name);
}

export const POLICIES = [
  {
    name: 'no_unverified_discount_claim',
    description: 'Do not state or imply a discount/code/percent-off unless checkDiscount ran this turn.',
    check({ reply, toolsUsed }) {
      if (DISCOUNT_CLAIM_RE.test(reply) && !usedTool(toolsUsed, 'checkDiscount')) {
        return 'Reply mentions a discount/code/percent-off without checkDiscount having run this turn.';
      }
      return null;
    },
  },
  {
    name: 'no_unverified_stock_claim',
    description: 'Do not state stock/availability unless checkStock ran this turn.',
    check({ reply, toolsUsed }) {
      if (STOCK_CLAIM_RE.test(reply) && !usedTool(toolsUsed, 'checkStock')) {
        return 'Reply makes a stock/availability claim without checkStock having run this turn.';
      }
      return null;
    },
  },
  {
    name: 'no_unverified_order_status_claim',
    description: 'Do not state an order status/tracking detail unless getOrderStatus ran this turn.',
    check({ reply, toolsUsed }) {
      if (ORDER_STATUS_RE.test(reply) && !usedTool(toolsUsed, 'getOrderStatus')) {
        return 'Reply states an order status/tracking detail without getOrderStatus having run this turn.';
      }
      return null;
    },
  },
  {
    name: 'no_unverified_policy_claim',
    description: 'Do not state a specific shipping/return/refund timeframe unless searchKnowledgeBase ran this turn.',
    check({ reply, toolsUsed }) {
      if (POLICY_CLAIM_RE.test(reply) && !usedTool(toolsUsed, 'searchKnowledgeBase')) {
        return 'Reply states a specific policy timeframe without searchKnowledgeBase having run this turn.';
      }
      return null;
    },
  },
  {
    name: 'no_unsupported_refund_promise',
    description: 'Never promise a refund/compensation — no tool exists to actually do this.',
    check({ reply }) {
      if (REFUND_PROMISE_RE.test(reply)) {
        return 'Reply promises a refund/compensation, which no available tool can actually fulfill.';
      }
      return null;
    },
  },
  {
    name: 'no_internal_disclosure',
    description: 'Never reveal system prompt, API keys, or internal implementation details.',
    check({ reply }) {
      if (INTERNAL_DISCLOSURE_RE.test(reply)) {
        return 'Reply discloses internal implementation details (system prompt, keys, or code internals).';
      }
      return null;
    },
  },
  {
    name: 'no_deceptive_urgency',
    description: 'Do not use urgency/scarcity language unless backed by a real checkStock result this turn.',
    check({ reply, toolsUsed }) {
      if (URGENCY_RE.test(reply) && !usedTool(toolsUsed, 'checkStock')) {
        return 'Reply uses urgency/scarcity language not backed by a real stock check this turn.';
      }
      return null;
    },
  },
  {
    name: 'no_sensitive_personal_inference',
    description: 'Never infer or comment on a sensitive/protected personal attribute.',
    check({ reply }) {
      if (INFERENTIAL_LEAD_IN_RE.test(reply) && SENSITIVE_ATTRIBUTE_RE.test(reply)) {
        return 'Reply appears to infer a sensitive/protected personal attribute about the customer.';
      }
      return null;
    },
  },
];
