const DEFAULT_MAX_ITERATIONS = 3;

// Provider-agnostic agent loop:
//   user message -> model -> tool decision -> tool execution -> tool result -> model -> final response
//
// Each provider adapter supplies:
//   - initialState:        its own conversation representation, seeded from {systemPrompt, messages}
//   - callModel(state):    one model turn, normalized to { text, functionCalls, ...providerExtra }
//   - appendToolExchange(state, modelResult, outcomes): how that provider
//     represents "the model asked for these tools, here is what they
//     returned". Receives the *full* callModel() result (not just
//     text/functionCalls) so a provider can echo back its own raw turn
//     verbatim if it needs to preserve provider-specific metadata attached
//     to that turn (e.g. Gemini's thought signatures on function-call
//     parts) rather than reconstructing it from scratch.
//
// This function drives the iteration itself and is identical for every
// provider — it never touches a Gemini- or Anthropic-shaped object directly,
// which is what keeps callers of generateReply() provider-agnostic.
export async function runToolLoop({
  initialState,
  callModel,
  appendToolExchange,
  executeTool,
  maxIterations = DEFAULT_MAX_ITERATIONS,
}) {
  let state = initialState;
  const toolsUsed = [];

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const modelResult = await callModel(state);
    const { text, functionCalls = [] } = modelResult;

    if (functionCalls.length === 0) {
      return { text, toolsUsed };
    }

    const outcomes = [];
    for (const call of functionCalls) {
      const outcome = await executeTool(call.name, call.args);
      toolsUsed.push(call.name);
      outcomes.push({ call, outcome });
    }

    state = appendToolExchange(state, modelResult, outcomes);
  }

  throw new Error('Exceeded maximum tool-call iterations without a final response.');
}
