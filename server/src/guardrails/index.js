import { POLICIES } from './policies.js';

// A safe, honest, non-fabricated fallback — never invents anything, and
// offers a concrete next step, matching the "when unavailable, say so and
// offer the safest useful next step" requirement. Used whenever the
// generated reply fails any guardrail policy.
export const SAFE_FALLBACK_REPLY =
  "I want to make sure I give you accurate information, and I'm not confident that answer is " +
  'correct. Let me connect you with our support team, who can help directly.';

// The verifications a policy relied on, as { code, basis, turn }: the code, whether the tool ran on this
// turn or on an earlier one, and which turn of the conversation that was (null when it is not known: a
// row from before turns were recorded, or a store that does not record them). Built from the policy's
// own notes; the turn numbers are what the conversation store kept when the tool ran.
function provenance(notes, { verifiedTurns = {}, verifiedThisTurn = [] }) {
  const out = [];
  for (const n of notes) {
    if (n.basis === 'this-turn') {
      const codes = verifiedThisTurn.length > 0 ? verifiedThisTurn : [null];
      for (const code of codes) out.push({ code, basis: 'this-turn', turn: null });
    } else if (n.basis === 'earlier-turn') {
      for (const code of n.codes) out.push({ code, basis: 'earlier-turn', turn: verifiedTurns[code] ?? null });
    }
  }
  return out;
}

// Runs every policy against the reply produced this turn. Returns
// { safe: true } or { safe: false, violations: [{ name, description, reason, rule?, matched?, clause? }] }
// — never throws, so a bug in one policy can't take down the whole request;
// see validateReply's own try/catch for that.
function checkPolicies(context) {
  const violations = [];
  // Every policy that ran and what it decided, in order, for the turn's trace.
  const checks = [];

  for (const policy of POLICIES) {
    let result;
    // What the policy says it relied on to let something through (see `note` in policies.js).
    const notes = [];
    try {
      result = policy.check({ ...context, note: (n) => notes.push(n) });
    } catch (err) {
      // A policy itself misbehaving is treated as a violation, not a
      // silent pass — failing safe applies to the guardrail code too.
      result = { reason: `Guardrail check "${policy.name}" threw: ${err.message}`, rule: 'policy-threw' };
    }
    checks.push({ policy: policy.name, outcome: result ? 'block' : 'pass', verified: provenance(notes, context) });
    if (result) {
      // A policy returns a bare reason string, or { reason, rule, matched, clause }: which rule
      // inside the policy fired and the phrase that triggered it.
      const detail = typeof result === 'string' ? { reason: result } : result;
      violations.push({ name: policy.name, description: policy.description, ...detail });
    }
  }

  return violations.length === 0 ? { safe: true, violations: [], checks } : { safe: false, violations, checks };
}

// context: { reply, toolsUsed, verifiedDiscounts, verifiedTurns, verifiedThisTurn }. `verifiedDiscounts` are the
// checkDiscount results from earlier turns of the SAME conversation (never another one); `verifiedTurns` says which
// turn each code was verified on ({ CODE: turn }) and `verifiedThisTurn` lists the codes checkDiscount checked on
// this turn. The last two only feed the explanation of a decision (`checks[].verified`), never the decision. Returns { safe, violations, finalReply }.
// finalReply is the reply text that should actually be shown to the user
// and persisted to memory — the original reply when safe, the fallback
// when not. Callers should never fall back to the original reply text
// themselves on an unsafe result; use finalReply.
export function validateReply({ reply, toolsUsed = [], verifiedDiscounts = [], verifiedTurns = {}, verifiedThisTurn = [] }) {
  const result = checkPolicies({ reply, toolsUsed, verifiedDiscounts, verifiedTurns, verifiedThisTurn });

  // `checks` is one { policy, outcome: 'pass' | 'block' } per policy that ran: the trace shows them.
  const checks = result.checks.map(({ policy, outcome, verified }) => ({ policy, outcome, verified }));
  if (result.safe) {
    return { safe: true, violations: [], checks, finalReply: reply };
  }

  return { safe: false, violations: result.violations, checks, finalReply: SAFE_FALLBACK_REPLY };
}

export { POLICIES };
