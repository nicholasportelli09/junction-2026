// The tools the model may call. Each runs our own code; the model only chooses and words the result.
import type { ToolCall } from "../model";
import { prepareAction, rememberTool } from "./act";
import { calculate } from "./calc";
import { showChart } from "./chart";
import { searchFlats } from "./flats";
import { checkAffordabilityTool, explainConcept, findPatternsTool, getCashFlow, getMortgage, getSpending, listBills, runScenarioTool } from "./finance";
import { type ToolContext, type ToolOutcome, failure, parseArgs } from "./types";
import { searchOffers, webSearch } from "./web";

export { TOOL_SCHEMAS } from "./schemas";
export { billTypeOf } from "./web";
export { parseArgs } from "./types";
export type { StageDraft, ToolContext, ToolOutcome } from "./types";

export async function executeTool(call: ToolCall, ctx: ToolContext): Promise<ToolOutcome> {
  const args = parseArgs(call);
  switch (call.function.name) {
    case "get_spending":
      return getSpending(args, ctx);
    case "list_bills":
      return listBills(ctx);
    case "get_cash_flow":
      return getCashFlow(ctx);
    case "find_patterns":
      return findPatternsTool(ctx);
    case "check_affordability":
      return checkAffordabilityTool(args, ctx);
    case "run_scenario":
      return runScenarioTool(args, ctx);
    case "get_mortgage":
      return getMortgage(ctx);
    case "search_offers":
      return searchOffers(args, ctx);
    case "search_flats":
      return searchFlats(args, ctx);
    case "web_search":
      return webSearch(args, ctx);
    case "calculate":
      return calculate(args, ctx, call.id);
    case "show_chart":
      return showChart(args, ctx);
    case "explain_concept":
      return explainConcept(args, ctx);
    case "prepare_action":
      return prepareAction(args, ctx);
    case "remember":
      return rememberTool(args, ctx);
    default:
      return failure("finance", `Unknown tool: ${call.function.name}`);
  }
}
