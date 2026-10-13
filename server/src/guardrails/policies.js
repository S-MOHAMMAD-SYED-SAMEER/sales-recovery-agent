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
// fact-checking is the evaluation harness's job, not a runtime guardrail's.

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

// ---------------------------------------------------------------------------
// Claim versus mention.
//
// The first real-model run showed the two policies below firing on replies that
// claimed nothing: a refusal that repeated the customer's own words ("I don't
// have the ability to provide a 50% off discount code") and an offer ("I can
// check if something is in stock"). Both contain the risky words and neither
// asserts anything. So for those two policies a match only counts when the
// clause it sits in is not a refusal, an offer to check, or a conditional.
//
// A clause is the part of the sentence around the match, cut at a comma,
// semicolon, colon, dash, bracket, or one of and / but / however / though /
// while / so / because / then. The cut is what keeps a refusal from excusing a
// claim made right beside it: "I can't promise it will last, but use SAVE20 for
// 20% off" is still blocked, because "can't" is on the other side of the "but".
// ---------------------------------------------------------------------------
const CLAUSE_BREAK_RE = /[,;:—–()]|\s(?:and|but|however|though|while|so|because|then)\s/gi;
const NEGATION_BEFORE_RE =
  /\b(?:can(?:'|’)?t|cannot|can not|don(?:'|’)?t|do not|doesn(?:'|’)?t|does not|didn(?:'|’)?t|won(?:'|’)?t|unable|not able|no|not|never|nothing|without|isn(?:'|’)?t|aren(?:'|’)?t)\b/i;
const NEGATION_AFTER_RE =
  /\b(?:isn(?:'|’)?t|aren(?:'|’)?t|is not|are not|not (?:something|possible|available|offered|valid)|can(?:'|’)?t|cannot|won(?:'|’)?t|unavailable)\b/i;
const OFFER_OR_CONDITIONAL_RE =
  /\b(?:if|whether)\b|\b(?:can|could|will|would|let me|happy to|glad to|able to|want me to|going to)\s+(?:also\s+)?(?:check|look(?:\s+up)?|see|find out|verify|validate|confirm)\b/i;

function clauseAround(text, start, end) {
  const before = text.slice(0, start);
  const sentenceStart =
    Math.max(before.lastIndexOf('. '), before.lastIndexOf('! '), before.lastIndexOf('? '), before.lastIndexOf('\n')) + 1;
  let prefix = before.slice(sentenceStart);
  let lastBreakEnd = 0;
  for (const m of prefix.matchAll(CLAUSE_BREAK_RE)) lastBreakEnd = m.index + m[0].length;
  prefix = prefix.slice(lastBreakEnd);

  const after = text.slice(end);
  const sentenceEnds = ['. ', '! ', '? ', '\n'].map((t) => after.indexOf(t)).filter((i) => i >= 0);
  let suffix = sentenceEnds.length ? after.slice(0, Math.min(...sentenceEnds)) : after;
  const firstBreak = suffix.search(new RegExp(CLAUSE_BREAK_RE.source, 'i'));
  if (firstBreak >= 0) suffix = suffix.slice(0, firstBreak);
  return { prefix, suffix };
}

// True if the text has at least one match of `re` that is a claim, i.e. one that
// `isMention(prefix, suffix)` does not excuse.
function hasClaim(text, re, isMention) {
  const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  for (const match of text.matchAll(global)) {
    const { prefix, suffix } = clauseAround(text, match.index, match.index + match[0].length);
    if (!isMention(prefix, suffix)) return true;
  }
  return false;
}

const isDiscountMention = (prefix, suffix) =>
  NEGATION_BEFORE_RE.test(prefix) || NEGATION_AFTER_RE.test(suffix) || OFFER_OR_CONDITIONAL_RE.test(prefix);
const isStockMention = (prefix) => OFFER_OR_CONDITIONAL_RE.test(prefix);

export const POLICIES = [
  {
    name: 'no_unverified_discount_claim',
    description: 'Do not state or imply a discount/code/percent-off unless checkDiscount ran this turn.',
    check({ reply, toolsUsed }) {
      if (!usedTool(toolsUsed, 'checkDiscount') && hasClaim(reply, DISCOUNT_CLAIM_RE, isDiscountMention)) {
        return 'Reply mentions a discount/code/percent-off without checkDiscount having run this turn.';
      }
      return null;
    },
  },
  {
    name: 'no_unverified_stock_claim',
    description: 'Do not state stock/availability unless checkStock ran this turn.',
    check({ reply, toolsUsed }) {
      if (!usedTool(toolsUsed, 'checkStock') && hasClaim(reply, STOCK_CLAIM_RE, isStockMention)) {
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
