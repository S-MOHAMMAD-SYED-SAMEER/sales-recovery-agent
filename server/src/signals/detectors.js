// Deterministic, keyword/pattern-based signal detection — deliberately not
// an LLM classifier. Reasoning (same as M1's original proactive-signal
// design and unchanged since): a handful of regexes are free, instant,
// 100% reproducible, and easy for a human to read and explain end to end.
// Known limitation, stated plainly: this only catches fairly direct
// phrasing in English — it will miss paraphrases, sarcasm, or indirect
// hints a human (or an LLM) would catch. That tradeoff is intentional for
// this stage; see the README for when it would be worth revisiting.
//
// Each pattern carries a fixed confidence (0-1) reflecting how unambiguous
// that specific phrasing is, chosen by hand, not learned.
const PATTERNS = {
  purchase_intent: [
    { re: /\b(add (it|this|that) to (my )?cart|how do i (buy|order|purchase|check ?out)|i(?:'|’)?d like to (buy|order|purchase) (it|this|that)?|ready to (buy|order|check ?out)|want to (buy|order|purchase) (this|it|that)( now)?)\b/i, confidence: 0.85 },
    { re: /\b(buy (this|it) now|place (my|an) order)\b/i, confidence: 0.8 },
  ],
  purchase_hesitation: [
    { re: /\bnot (totally |completely )?sure (if|whether|about) i (need|want|should (buy|get))\b/i, confidence: 0.75 },
    { re: /\b(still deciding|on the fence|haven(?:'|’)?t decided|thinking (it over|about it))\b/i, confidence: 0.75 },
    { re: /\bi(?:'|’)?m (hesitant|undecided|unsure|not (totally |completely )?sure)\b/i, confidence: 0.65 },
  ],
  shipping_concern: [
    { re: /\b(worried|concerned) about (shipping|delivery|the delivery)\b/i, confidence: 0.8 },
    { re: /\b(shipping|delivery) (takes|is) too (long|slow)\b/i, confidence: 0.75 },
    { re: /\b(hasn(?:'|’)?t (arrived|shipped)|still hasn(?:'|’)?t (shipped|arrived)|won(?:'|’)?t arrive in time|tracking (isn(?:'|’)?t|not) updat(ing|ed))\b/i, confidence: 0.75 },
    { re: /\bshipping (cost|fee)s? (is |are )?(too )?(high|expensive)\b/i, confidence: 0.7 },
  ],
  price_concern: [
    { re: /\b(too expensive|can(?:'|’)?t afford|out of (my )?budget|over (my )?budget|a bit pricey|kind of pricey|cheaper (elsewhere|somewhere else))\b/i, confidence: 0.8 },
    { re: /\bthe price is (too )?(high|steep)\b/i, confidence: 0.75 },
  ],
  return_concern: [
    { re: /\bwhat if (it doesn(?:'|’)?t fit|i don(?:'|’)?t like it|it doesn(?:'|’)?t work out)\b/i, confidence: 0.75 },
    { re: /\bworried about (returning|the return process|returns)\b/i, confidence: 0.75 },
    { re: /\bnot sure (if )?i can return\b/i, confidence: 0.7 },
  ],
  cart_abandonment_risk: [
    {
      re: /\b(maybe later|i(?:'|’)?ll think about it|not (right now|today)|i(?:'|’)?ll come back (to it|later)|let me think (about it|it over)|gonna pass|never ?mind|i(?:'|’)?m not (going to|gonna) (buy|order) (it|this)( right now| today)?)\b/i,
      confidence: 0.7,
    },
  ],
};

// Runs every pattern for every signal type against one message. Deliberately
// scoped to a single message (the current turn), not the whole
// conversation — see signals/index.js for why.
export function detectFromMessage(message) {
  const signals = [];

  for (const [type, patterns] of Object.entries(PATTERNS)) {
    for (const { re, confidence } of patterns) {
      const match = message.match(re);
      if (match) {
        signals.push({ type, confidence, evidence: match[0].trim() });
        break; // one signal per type per message is enough
      }
    }
  }

  return signals;
}
