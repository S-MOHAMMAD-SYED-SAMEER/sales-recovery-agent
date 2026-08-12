// Hand-written dataset validation — no schema library, consistent with the
// rest of this codebase (see tools/errors.js's ToolValidationError). Small
// and dependency-free is preferable to a validation library for a dataset
// this size and this stable a shape.
export class EvalDatasetError extends Error {
  constructor(problems) {
    super(`Invalid evaluation dataset:\n- ${problems.join('\n- ')}`);
    this.name = 'EvalDatasetError';
    this.problems = problems;
  }
}

const VALID_EXPECTED_KEYS = new Set([
  'tools',
  'signals',
  'grounded',
  'evidenceKeywords',
  'honestyRequired',
  'mustNotContain',
]);

function validateCase(evalCase, index, problems, seenIds) {
  const where = `case[${index}]`;

  if (!evalCase || typeof evalCase !== 'object') {
    problems.push(`${where}: must be an object`);
    return;
  }

  if (typeof evalCase.id !== 'string' || !evalCase.id.trim()) {
    problems.push(`${where}: "id" is required and must be a non-empty string`);
  } else if (seenIds.has(evalCase.id)) {
    problems.push(`${where}: duplicate id "${evalCase.id}"`);
  } else {
    seenIds.add(evalCase.id);
  }

  if (typeof evalCase.category !== 'string' || !evalCase.category.trim()) {
    problems.push(`${where} (${evalCase.id || '?'}): "category" is required and must be a non-empty string`);
  }

  if (typeof evalCase.message !== 'string' || !evalCase.message.trim()) {
    problems.push(`${where} (${evalCase.id || '?'}): "message" is required and must be a non-empty string`);
  }

  if (evalCase.priorTurns !== undefined) {
    if (!Array.isArray(evalCase.priorTurns)) {
      problems.push(`${where} (${evalCase.id || '?'}): "priorTurns" must be an array when present`);
    } else {
      evalCase.priorTurns.forEach((turn, i) => {
        if (!turn || (turn.role !== 'user' && turn.role !== 'assistant') || typeof turn.content !== 'string') {
          problems.push(`${where}.priorTurns[${i}]: must be { role: "user"|"assistant", content: string }`);
        }
      });
    }
  }

  if (!evalCase.expected || typeof evalCase.expected !== 'object') {
    problems.push(`${where} (${evalCase.id || '?'}): "expected" is required and must be an object`);
  } else {
    const keys = Object.keys(evalCase.expected);
    if (keys.length === 0) {
      problems.push(`${where} (${evalCase.id || '?'}): "expected" must define at least one expectation`);
    }
    for (const key of keys) {
      if (!VALID_EXPECTED_KEYS.has(key)) {
        problems.push(`${where} (${evalCase.id || '?'}): unknown expected field "${key}"`);
      }
    }
    if (evalCase.expected.tools !== undefined && !Array.isArray(evalCase.expected.tools)) {
      problems.push(`${where} (${evalCase.id || '?'}): expected.tools must be an array when present`);
    }
    if (evalCase.expected.signals !== undefined && !Array.isArray(evalCase.expected.signals)) {
      problems.push(`${where} (${evalCase.id || '?'}): expected.signals must be an array when present`);
    }
    if (evalCase.expected.evidenceKeywords !== undefined && !Array.isArray(evalCase.expected.evidenceKeywords)) {
      problems.push(`${where} (${evalCase.id || '?'}): expected.evidenceKeywords must be an array when present`);
    }
    if (evalCase.expected.mustNotContain !== undefined && !Array.isArray(evalCase.expected.mustNotContain)) {
      problems.push(`${where} (${evalCase.id || '?'}): expected.mustNotContain must be an array when present`);
    }
  }

  if (evalCase.mockResponse !== undefined) {
    if (
      !evalCase.mockResponse ||
      typeof evalCase.mockResponse.text !== 'string' ||
      !Array.isArray(evalCase.mockResponse.toolsUsed)
    ) {
      problems.push(`${where} (${evalCase.id || '?'}): mockResponse must be { text: string, toolsUsed: string[] } when present`);
    }
  }
}

// Throws EvalDatasetError (collecting *all* problems found, not just the
// first) on any structural issue. Returns the dataset unchanged when valid,
// so this can be used inline: `const dataset = validateDataset(raw)`.
export function validateDataset(dataset) {
  const problems = [];

  if (!dataset || typeof dataset !== 'object') {
    throw new EvalDatasetError(['dataset must be an object']);
  }
  if (typeof dataset.version !== 'string' || !dataset.version.trim()) {
    problems.push('"version" is required and must be a non-empty string');
  }
  if (!Array.isArray(dataset.cases) || dataset.cases.length === 0) {
    problems.push('"cases" is required and must be a non-empty array');
  } else {
    const seenIds = new Set();
    dataset.cases.forEach((evalCase, index) => validateCase(evalCase, index, problems, seenIds));
  }

  if (problems.length > 0) {
    throw new EvalDatasetError(problems);
  }

  return dataset;
}
