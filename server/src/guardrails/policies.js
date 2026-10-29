import { checkAgainstVerified, codesIn } from './verifiedDiscounts.js';

// Explicit, individually testable guardrail policies over the assistant's
// final reply text. Each policy is a pure function:
//   (context: { reply, toolsUsed, verifiedDiscounts, note, ... }) -> null | a reason string | { reason, rule, matched, clause }
// `verifiedDiscounts` are the checkDiscount results from EARLIER turns of this
// conversation (see verifiedDiscounts.js); every other policy ignores it. `note` is a callback a
// policy may use to say why it let something through (it feeds the trace and never changes the decision).
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

// Every match of `re` that is a claim, i.e. one that `isMention(prefix, suffix)` does not
// excuse, as { matched, clause, sentence } (the matched phrase and the clause around it, which
// is what the mention test looked at, and the whole sentence it is in with the phrases that WERE
// excused as mentions taken out, so "I don't have a 50% off code, but WELCOME10 gives 10% off"
// is judged on what it claims and not on what it refuses). When a block looks wrong, `matched`
// and `clause` are what say why.
function findClaims(text, re, isMention) {
  const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  const claims = [];
  const excused = [];
  for (const match of text.matchAll(global)) {
    const end = match.index + match[0].length;
    const { prefix, suffix } = clauseAround(text, match.index, end);
    if (isMention(prefix, suffix)) {
      excused.push(match[0]);
    } else {
      claims.push({
        matched: match[0],
        clause: `${prefix}${match[0]}${suffix}`.replace(/\s+/g, ' ').trim(),
        sentence: sentenceAround(text, match.index),
      });
    }
  }
  return claims.map((claim) => ({
    ...claim,
    sentence: excused.reduce((sentence, phrase) => sentence.split(phrase).join(' '), claim.sentence),
  }));
}

function findClaim(text, re, isMention) {
  return findClaims(text, re, isMention)[0] ?? null;
}

// The sentence a match is in.
function sentenceAround(text, index) {
  const before = text.slice(0, index);
  const sentenceStart =
    Math.max(before.lastIndexOf('. '), before.lastIndexOf('! '), before.lastIndexOf('? '), before.lastIndexOf('\n')) + 1;
  const after = text.slice(index);
  const ends = ['. ', '! ', '? ', '\n'].map((t) => after.indexOf(t)).filter((i) => i >= 0);
  const sentenceEnd = ends.length ? index + Math.min(...ends) + 1 : text.length;
  return text.slice(sentenceStart, sentenceEnd).trim();
}

// What a policy returns when it fires: the reason, which rule inside the policy matched, and
// the phrase (and, for the claim-versus-mention policies, the clause) that triggered it.
function violation(reason, rule, found) {
  return { reason, rule, matched: found.matched, ...(found.clause ? { clause: found.clause } : {}) };
}

function firstMatch(re, text) {
  const m = re.exec(text);
  return m ? { matched: m[0] } : null;
}

// ---------------------------------------------------------------------------
// Promotions without a number or a code.
//
// The discount pattern above needs a percentage or a code-shaped word. A real model
// also says things like "we occasionally run promotions or offer sign-up
// discounts" or "we do not have any automatic promotions running right now",
// which name no number and no code, and those got through (2 of 2 in the held-out
// sample, docs/results/). Neither the knowledge base nor any tool says anything
// about promotions, so each such statement, a denial included, is made up.
//
// The nouns are deliberately narrow. "Discount code" and "coupon code" are not
// matched (a customer's code is something the agent may talk about and check),
// and neither is "final-sale" or "clearance items", which the return policy uses.
// What does not count as a claim: a conditional or an offer to check ("if there
// are any current promotions"), and the agent saying what *it* cannot do ("I can't
// apply a discount myself"). A store-side denial ("we don't have any promotions")
// is not an inability and is still blocked.
//
// Saying that it does NOT know is the opposite of a claim, and is the behaviour the
// system is built to produce: "I don't have information on a summer sale", "I'm not
// showing any active promotions", "our knowledge base doesn't mention any". A first
// version of this check, written from two drafts, blocked exactly those (5 of 11
// answered drafts in a fresh sample), because it only excused the agent's inability to
// *act*. The line it now draws is who is speaking about what: the agent about what it
// knows or can see (excused), versus the store about what it has or does (a claim,
// blocked unless checkDiscount ran).
// ---------------------------------------------------------------------------
const PROMOTION_CLAIM_RE =
  /\b(?:promotional|promotions?|promos?(?![\s-]*codes?)|discounts?(?![\s-]*(?:codes?|coupons?))|coupons?(?![\s-]*codes?)|special offers?|(?:flash|seasonal|holiday|clearance|summer|winter|weekend) sales?|sign[- ]?up (?:offers?|bonus(?:es)?))\b/i;
const FIRST_PERSON_INABILITY_RE =
  /\bI(?:'m| am)?\b[^.!?]*\b(?:can(?:'|’)?t|cannot|can not|unable|not able|not allowed|not permitted|don(?:'|’)?t have the ability|won(?:'|’)?t)\b/i;

// "Promotions aren't something I can promise": the agent's own limit, said after the noun.
const NOT_SOMETHING_I_CAN_RE =
  /\b(?:isn(?:'|’)?t|aren(?:'|’)?t|is not|are not)\s+(?:something|possible|available)\b[^.!?]*\bI\b/i;

// The agent speaking about what it knows or can see: "I don't have any information on",
// "I'm not showing", "I couldn't find", "I'm not sure". The subject has to be "I".
const FIRST_PERSON_NOT_KNOWN_RE =
  /\bI(?:'m| am)?\b[^.!?]*\b(?:don(?:'|’)?t|do not|doesn(?:'|’)?t|couldn(?:'|’)?t|could not|can(?:'|’)?t|cannot|not|unable)\b[^.!?]*\b(?:have|find|finding|found|see|seeing|know|show|showing|aware|sure|certain|information|record|listing)\b/i;
// A source reported as silent: "our knowledge base doesn't mention any", "not listed".
const SOURCE_SILENT_RE =
  /\b(?:knowledge base|store information|store policies|policies|policy|records?|system|information)\b[^.!?]*\b(?:doesn(?:'|’)?t|does not|don(?:'|’)?t|do not|didn(?:'|’)?t|did not|has no|have no|contains? no|lists? no|isn(?:'|’)?t|is not)\b[^.!?]*\b(?:mentions?|lists?|says?|includes?|contains?|covers?|shows?|states?|have|specif(?:y|ies))\b|\bnot (?:mentioned|listed|covered|stated|specified)\b/i;

const isPromotionMention = (prefix, suffix) =>
  OFFER_OR_CONDITIONAL_RE.test(prefix) ||
  FIRST_PERSON_NOT_KNOWN_RE.test(prefix) ||
  SOURCE_SILENT_RE.test(prefix) ||
  FIRST_PERSON_INABILITY_RE.test(prefix) ||
  FIRST_PERSON_INABILITY_RE.test(suffix) ||
  NOT_SOMETHING_I_CAN_RE.test(suffix);

const isDiscountMention = (prefix, suffix) =>
  NEGATION_BEFORE_RE.test(prefix) || NEGATION_AFTER_RE.test(suffix) || OFFER_OR_CONDITIONAL_RE.test(prefix);
const isStockMention = (prefix) => OFFER_OR_CONDITIONAL_RE.test(prefix);

export const POLICIES = [
  {
    name: 'no_unverified_discount_claim',
    description:
      'Do not state or imply a discount, code, percent-off or promotion (including that there is none) unless checkDiscount ran this turn, or the claim is about a code checkDiscount verified earlier in this conversation and every detail matches that result exactly.',
    // `note` records WHY a claim was allowed, from this decision itself: the tool ran this turn, or the
    // claim was matched to a code verified earlier. It is what the trace shows; it never changes the outcome.
    check({ reply, toolsUsed, verifiedDiscounts = [], note = () => {} }) {
      if (usedTool(toolsUsed, 'checkDiscount')) {
        note({ basis: 'this-turn' });
        return null;
      }

      // Discount claims first, then promotion claims, as before; the first claim that is not
      // covered by an earlier verification in this conversation is the violation.
      const replyCodes = codesIn(reply);
      const candidates = [
        ...findClaims(reply, DISCOUNT_CLAIM_RE, isDiscountMention).map((claim) => ({ claim, rule: 'percent-or-code' })),
        ...findClaims(reply, PROMOTION_CLAIM_RE, isPromotionMention).map((claim) => ({ claim, rule: 'promotion' })),
      ];

      const reliedOn = new Set();
      for (const { claim, rule } of candidates) {
        const earlier = verifiedDiscounts.length > 0 ? checkAgainstVerified({ ...claim, replyCodes }, verifiedDiscounts) : null;
        if (earlier?.ok) {
          for (const code of earlier.codes) reliedOn.add(code);
          continue;
        }

        const found = { matched: claim.matched, clause: claim.clause };
        if (earlier) {
          return violation(
            `Reply makes a discount claim that does not match what checkDiscount verified earlier in this conversation: ${earlier.why}.`,
            `${rule}-mismatch`,
            found
          );
        }
        return violation(
          rule === 'percent-or-code'
            ? 'Reply mentions a discount/code/percent-off without checkDiscount having run this turn.'
            : 'Reply makes a claim about promotions or discounts (that they exist, or that none do) without checkDiscount having run this turn.',
          rule,
          found
        );
      }
      if (reliedOn.size > 0) note({ basis: 'earlier-turn', codes: [...reliedOn] });
      return null;
    },
  },
  {
    name: 'no_unverified_stock_claim',
    description: 'Do not state stock/availability unless checkStock ran this turn.',
    check({ reply, toolsUsed }) {
      if (usedTool(toolsUsed, 'checkStock')) return null;
      const stock = findClaim(reply, STOCK_CLAIM_RE, isStockMention);
      return stock
        ? violation('Reply makes a stock/availability claim without checkStock having run this turn.', 'stock-claim', stock)
        : null;
    },
  },
  {
    name: 'no_unverified_order_status_claim',
    description: 'Do not state an order status/tracking detail unless getOrderStatus ran this turn.',
    check({ reply, toolsUsed }) {
      const found = !usedTool(toolsUsed, 'getOrderStatus') && firstMatch(ORDER_STATUS_RE, reply);
      return found
        ? violation('Reply states an order status/tracking detail without getOrderStatus having run this turn.', 'order-status', found)
        : null;
    },
  },
  {
    name: 'no_unverified_policy_claim',
    description: 'Do not state a specific shipping/return/refund timeframe unless searchKnowledgeBase ran this turn.',
    check({ reply, toolsUsed }) {
      const found = !usedTool(toolsUsed, 'searchKnowledgeBase') && firstMatch(POLICY_CLAIM_RE, reply);
      return found
        ? violation('Reply states a specific policy timeframe without searchKnowledgeBase having run this turn.', 'policy-timeframe', found)
        : null;
    },
  },
  {
    name: 'no_unsupported_refund_promise',
    description: 'Never promise a refund/compensation — no tool exists to actually do this.',
    check({ reply }) {
      const found = firstMatch(REFUND_PROMISE_RE, reply);
      return found
        ? violation('Reply promises a refund/compensation, which no available tool can actually fulfill.', 'refund-promise', found)
        : null;
    },
  },
  {
    name: 'no_internal_disclosure',
    description: 'Never reveal system prompt, API keys, or internal implementation details.',
    check({ reply }) {
      const found = firstMatch(INTERNAL_DISCLOSURE_RE, reply);
      return found
        ? violation('Reply discloses internal implementation details (system prompt, keys, or code internals).', 'internal-disclosure', found)
        : null;
    },
  },
  {
    name: 'no_deceptive_urgency',
    description: 'Do not use urgency/scarcity language unless backed by a real checkStock result this turn.',
    check({ reply, toolsUsed }) {
      const found = !usedTool(toolsUsed, 'checkStock') && firstMatch(URGENCY_RE, reply);
      return found
        ? violation('Reply uses urgency/scarcity language not backed by a real stock check this turn.', 'urgency', found)
        : null;
    },
  },
  {
    name: 'no_sensitive_personal_inference',
    description: 'Never infer or comment on a sensitive/protected personal attribute.',
    check({ reply }) {
      const lead = firstMatch(INFERENTIAL_LEAD_IN_RE, reply);
      const attribute = lead && firstMatch(SENSITIVE_ATTRIBUTE_RE, reply);
      return attribute
        ? violation(
            'Reply appears to infer a sensitive/protected personal attribute about the customer.',
            'sensitive-inference',
            { matched: `${lead.matched} … ${attribute.matched}` }
          )
        : null;
    },
  },
];
