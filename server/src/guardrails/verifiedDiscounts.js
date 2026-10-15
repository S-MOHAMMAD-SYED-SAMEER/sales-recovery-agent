// What a reply may say about a discount code that was checked EARLIER in the same conversation.
//
// The discount policy used to trust a tool result from the current turn only. A customer who
// asks "Is WELCOME10 valid?" and then "give me a 50% off code" gets a correct answer that
// mentions WELCOME10 ("the only code I can verify is WELCOME10, which gives 10% off for
// first-time customers"), made in a turn where no tool ran, and the policy blocked it. The
// statement was true and had been checked one turn before.
//
// So a statement about a code is allowed when that code was verified earlier in THIS
// conversation, and only when everything the statement claims matches what the tool returned,
// exactly:
//
//   code         every code named must have been verified here. A code never checked, or checked
//                in another conversation, blocks.
//   percent      every percentage must be the verified code's percentOff.
//   amount       a money amount ("$5 off") can never match: the tool returns percentages only.
//   eligibility  a "for / on / to <who or what>" phrase must be words the tool's own description
//                uses ("for first-time customers"); "for all customers" does not match.
//   validity     "valid / active" needs valid=true, "expired / invalid / not valid" needs valid=false.
//   expiry date  any date named must be the tool's expiry date.
//
// Anything the statement says that this cannot check against the record blocks, which is the
// safe direction: a false block costs a generic reply, a false pass states something untrue.
// The records come only from the tool executor, never from model text or the customer's
// message, and they are stored per conversation by the conversation store.

const CODE_TOKEN_RE = /\b[A-Za-z]{3,}-?\d{1,3}\b/g;
const PERCENT_RE = /(\d{1,3}(?:\.\d+)?)\s*%/g;
const AMOUNT_RE = /[$£€]\s?\d/;
const ELIGIBILITY_RE = /\b(?:for|on|to)\s+((?:[a-z][a-z-]*\s+){0,3}?(?:customers?|members?|shoppers?|users?|orders?|purchases?|items?|products?))\b/gi;
const INVALID_RE =
  /\b(?:isn(?:'|’)?t|is not|aren(?:'|’)?t|are not|no longer|not)\s+(?:currently\s+|still\s+)?(?:valid|active|usable|working)\b|\b(?:expired|invalid|lapsed|inactive)\b|\bdoes(?:n(?:'|’)?t| not) exist\b/gi;
const VALID_RE = /\b(?:valid|active|usable|works|working)\b/i;

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_PATTERN = MONTHS.join('|');
const ISO_DATE_RE = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
const MONTH_DAY_YEAR_RE = new RegExp(`\\b(${MONTH_PATTERN})\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'gi');
const DAY_MONTH_YEAR_RE = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_PATTERN}),?\\s+(\\d{4})\\b`, 'gi');

export function normaliseCode(code) {
  return String(code).toUpperCase().replace(/-/g, '');
}

// Latest record per code. `records` are the checkDiscount results exactly as the tool returned
// them ({ code, valid, percentOff, description, expires, ... }).
export function indexVerified(records) {
  const byCode = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    if (record && typeof record.code === 'string') byCode.set(normaliseCode(record.code), record);
  }
  return byCode;
}

export function codesIn(text) {
  return [...new Set((text.match(CODE_TOKEN_RE) || []).map(normaliseCode))];
}

function normalisePhrase(text) {
  return text.toLowerCase().replace(/-/g, ' ').replace(/\s+/g, ' ').replace(/^(?:the|a|an)\s+/, '').trim();
}

function isoOf(year, monthIndex, day) {
  return `${String(year).padStart(4, '0')}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function datesIn(text) {
  const found = [];
  for (const m of text.matchAll(ISO_DATE_RE)) found.push(`${m[1]}-${m[2]}-${m[3]}`);
  for (const m of text.matchAll(MONTH_DAY_YEAR_RE)) found.push(isoOf(m[3], MONTHS.indexOf(m[1].toLowerCase()), m[2]));
  for (const m of text.matchAll(DAY_MONTH_YEAR_RE)) found.push(isoOf(m[3], MONTHS.indexOf(m[2].toLowerCase()), m[1]));
  return found;
}

// `sentence` is the whole sentence the claim is in, with any phrase that was only a mention (a
// refusal such as "I don't have a 50% off code") already taken out, so what is judged is what the
// reply claims. `replyCodes` are the codes named anywhere in the reply, used when the claim itself
// names none ("It gives 10% off ...").
// Returns { ok: true, codes } (the verified codes the claim was matched against) or { ok: false, why }.
export function checkAgainstVerified({ sentence, replyCodes }, records) {
  const tail = sentence;
  const byCode = indexVerified(records);
  const named = codesIn(sentence);
  const referents = named.length > 0 ? named : replyCodes;

  if (referents.length === 0) return { ok: false, why: 'the claim names no code, so it cannot be tied to a verified one' };
  const unverified = referents.filter((code) => !byCode.has(code));
  if (unverified.length > 0) {
    return { ok: false, why: `${unverified.join(', ')} was not verified by checkDiscount earlier in this conversation` };
  }
  const verified = referents.map((code) => byCode.get(code));

  if (AMOUNT_RE.test(tail)) return { ok: false, why: 'it names a money amount, which checkDiscount does not return' };

  for (const m of tail.matchAll(PERCENT_RE)) {
    const claimed = Number(m[1]);
    if (!verified.some((record) => record.percentOff === claimed)) {
      return { ok: false, why: `it says ${m[1]}% but checkDiscount returned ${verified.map((r) => `${r.percentOff ?? 'no percentage'}% for ${r.code}`).join(' / ')}` };
    }
  }

  for (const m of tail.matchAll(ELIGIBILITY_RE)) {
    const claimed = normalisePhrase(m[1]);
    if (!verified.some((record) => typeof record.description === 'string' && normalisePhrase(record.description).includes(claimed))) {
      return { ok: false, why: `it says "${m[0]}", which is not in the verified description (${verified.map((r) => JSON.stringify(r.description ?? '')).join(' / ')})` };
    }
  }

  const claimsInvalid = new RegExp(INVALID_RE.source, 'i').test(tail);
  const claimsValid = VALID_RE.test(tail.replace(INVALID_RE, ' '));
  for (const record of verified) {
    if (claimsValid && record.valid !== true) return { ok: false, why: `it says ${record.code} is valid but checkDiscount returned valid=${record.valid}` };
    if (claimsInvalid && record.valid === true) return { ok: false, why: `it says ${record.code} is not valid but checkDiscount returned valid=true` };
  }

  for (const date of datesIn(tail)) {
    if (!verified.some((record) => record.expires === date)) {
      return { ok: false, why: `it names the date ${date} but checkDiscount returned expires=${verified.map((r) => r.expires ?? 'none').join(' / ')}` };
    }
  }

  return { ok: true, codes: referents };
}
