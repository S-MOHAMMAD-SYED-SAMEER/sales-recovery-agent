// Extractive answer shaping for the credential-free demo provider.
//
// The demo provider has no language model, so it cannot write a reply. What it
// can do, and still be provably "from the knowledge base", is pick the sentence
// or two out of the retrieved passages that best answer the question and hand
// them over word for word. Nothing here generates text: every returned sentence
// is a sentence of a retrieved chunk (whitespace re-flowed, list markers and
// headings dropped), and test/llm.demoExtract.test.js checks exactly that.
//
// Scoring is deliberately plain: the question's content words, weighted so a
// rarer word (international) counts for more than a common one (shipping), plus
// a bonus for a sentence that states a duration when the question asks how long.
// It is a heuristic for choosing among passages that already passed retrieval,
// not a second retriever.

const STOPWORDS = new Set([
  'the', 'and', 'for', 'you', 'your', 'are', 'was', 'were', 'what', 'how', 'does', 'did', 'can',
  'could', 'would', 'should', 'will', 'with', 'this', 'that', 'there', 'have', 'has', 'any',
  'about', 'from', 'into', 'out', 'our', 'its', 'who', 'why', 'when', 'where', 'which', 'long',
  'take', 'takes', 'much', 'many', 'tell', 'please', 'know', 'want', 'need', 'get', 'got',
  'item', 'items', 'order', 'orders',
]);

const CONTRASTS = [['domestic', 'international']];

const TIME_QUESTION_RE = /\b(how long|how many days|how fast|how soon|how quickly|when (will|do|does|can)|take|takes)\b/i;
const DURATION_RE = /\b\d+\s*(?:[-–]\s*\d+\s*)?(?:business\s+|working\s+)?(?:days?|weeks?|hours?)\b/i;
const LIST_MARKER_RE = /^\s*(?:[-*+]|\d+[.)])\s+/;
const HEADING_RE = /^\s*#{1,6}\s/;

// Enough of a stemmer that ship / ships / shipped / shipping, and return /
// returns / returned, meet at one form: drop a common ending, then a doubled
// final letter (shipp -> ship). Applied to both sides, so it only has to be
// consistent, not linguistically right.
function stem(word) {
  return word.replace(/(?:ing|ed|es|s)$/, '').replace(/(.)$/, '$1');
}

function contentStems(text) {
  const words = text.toLowerCase().match(/[a-z]{3,}/g) || [];
  return [...new Set(words.filter((w) => !STOPWORDS.has(w)).map(stem))];
}

// A chunk's text is "<heading>\n\n<body>"; the heading is retrieval metadata,
// not an answer, so it is dropped.
function bodyOf(chunk) {
  const text = String(chunk.text ?? '').replace(/\r\n?/g, '\n');
  const heading = chunk.heading ? String(chunk.heading) : null;
  if (heading && text.startsWith(`${heading}\n`)) return text.slice(heading.length + 1);
  return text;
}

function splitSentences(paragraph) {
  return paragraph
    .split(/(?<=[.!?])\s+(?=[A-Z0-9("'“])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Units of one chunk body, in order: each list item is one unit; consecutive
// prose lines are re-flowed into a paragraph and split into sentences.
export function unitsOf(body) {
  const units = [];
  let prose = [];

  const flushProse = () => {
    if (prose.length === 0) return;
    for (const sentence of splitSentences(prose.join(' ').replace(/\s+/g, ' '))) {
      units.push({ text: sentence, kind: 'sentence' });
    }
    prose = [];
  };

  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (!line) {
      flushProse();
    } else if (HEADING_RE.test(line)) {
      flushProse();
    } else if (LIST_MARKER_RE.test(line)) {
      flushProse();
      units.push({ text: line.replace(LIST_MARKER_RE, '').replace(/\s+/g, ' '), kind: 'item' });
    } else {
      prose.push(line);
    }
  }
  flushProse();
  return units;
}

// results: the `results` array of a found searchKnowledgeBase outcome, best
// match first: [{ source, heading, text, relevance }]. Returns a string of one
// to `maxUnits` retrieved sentences, or null if there is nothing to extract.
export function extractAnswer(question, results, { maxUnits = 3 } = {}) {
  const candidates = [];
  (results || []).forEach((chunk, rank) => {
    unitsOf(bodyOf(chunk)).forEach((unit, position) => {
      candidates.push({
        ...unit,
        rank,
        position,
        lower: unit.text.toLowerCase(),
        stems: new Set(contentStems(unit.text)),
      });
    });
  });
  if (candidates.length === 0) return null;

  // The store's two kinds of delivery are described side by side in the same
  // passages. A question about one must not be answered with a sentence about
  // the other, which word overlap alone cannot tell apart. This is the one piece
  // of knowledge about the demo store in here.
  const asked = question.toLowerCase();
  for (const [a, b] of CONTRASTS) {
    const [wanted, other] = asked.includes(a) && !asked.includes(b) ? [a, b] : asked.includes(b) && !asked.includes(a) ? [b, a] : [];
    if (!wanted) continue;
    const kept = candidates.filter((c) => !(c.lower.includes(other) && !c.lower.includes(wanted)));
    if (kept.length > 0) candidates.splice(0, candidates.length, ...kept);
  }

  const questionStems = contentStems(question);
  // A word found in few candidate sentences says more than one found in most.
  const weight = (word) => {
    const df = candidates.filter((c) => c.stems.has(word)).length;
    return df === 0 ? 0 : Math.log(1 + candidates.length / df);
  };
  const weights = new Map(questionStems.map((w) => [w, weight(w)]));
  const asksDuration = TIME_QUESTION_RE.test(question);

  for (const c of candidates) {
    let score = 0;
    for (const w of questionStems) if (c.stems.has(w)) score += weights.get(w);
    if (asksDuration && DURATION_RE.test(c.text)) score += 1.5;
    c.score = score;
  }

  const best = Math.max(...candidates.map((c) => c.score));
  let chosen;
  if (best <= 0) {
    // Nothing in the passages overlaps the question; the opening of the best
    // passage is the least-bad answer.
    chosen = candidates.filter((c) => c.rank === 0).slice(0, 2);
  } else {
    chosen = candidates
      .filter((c) => c.score >= best * 0.7)
      .sort((a, b) => b.score - a.score || a.rank - b.rank || a.position - b.position)
      .slice(0, maxUnits)
      .sort((a, b) => a.rank - b.rank || a.position - b.position);
  }

  return chosen.reduce((out, unit, i) => {
    if (i === 0) return unit.text;
    return `${out}${unit.kind === 'item' ? '\n' : ' '}${unit.text}`;
  }, '');
}
