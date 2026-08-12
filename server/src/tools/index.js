import * as getOrderStatus from './getOrderStatus.js';
import * as checkStock from './checkStock.js';
import * as checkDiscount from './checkDiscount.js';
import { ToolValidationError } from './errors.js';

const TOOLS = [getOrderStatus, checkStock, checkDiscount];

// Exported so llm/index.js can combine these with the RAG knowledge-search
// tool into one combined tool list for the agent loop, without this module
// needing to know that RAG exists.
export { TOOLS as businessTools };

export function getToolDefinitions(toolList = TOOLS) {
  return toolList.map(({ name, description, parameters }) => ({ name, description, parameters }));
}

// Factory so tests can build a dispatcher over a fake tool list (e.g. one
// whose execute() deliberately throws) without touching the real registry.
export function createToolExecutor(toolList) {
  const byName = Object.fromEntries(toolList.map((tool) => [tool.name, tool]));

  return async function executeTool(name, args) {
    const tool = byName[name];

    if (!tool) {
      return { ok: false, error: `Unknown tool "${name}".` };
    }

    try {
      const result = await tool.execute(args || {});
      return { ok: true, result };
    } catch (err) {
      if (err instanceof ToolValidationError) {
        return { ok: false, error: `Invalid arguments for ${name}: ${err.message}` };
      }
      console.error(`[tools] ${name} execution failed:`, err.message);
      return { ok: false, error: `${name} failed to execute.` };
    }
  };
}

export const executeTool = createToolExecutor(TOOLS);

export { ToolValidationError };
