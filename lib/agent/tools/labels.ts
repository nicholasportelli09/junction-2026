// What Sisu is doing right now, in plain words, for the screen. One line per tool call, sent the moment it starts.
import type { ToolCall } from "../model";
import { parseArgs } from "./types";

const euros = (value: unknown): string => (typeof value === "number" && Number.isFinite(value) ? `€${Math.round(value).toLocaleString("en-US")}` : "the amount");

export function activityLabel(call: ToolCall): string {
  const args = parseArgs(call);
  const text = (key: string): string | null => (typeof args[key] === "string" && args[key] ? String(args[key]).slice(0, 80) : null);
  switch (call.function.name) {
    case "get_spending":
      return `Adding up your ${(text("merchantType") ?? text("category") ?? "spending").toLowerCase()} from ${text("from") ?? "the start"} to ${text("to") ?? "today"}`;
    case "list_bills":
      return "Going through your recurring bills and how they have changed";
    case "get_cash_flow":
      return "Working out your balance from now until payday";
    case "find_patterns":
      return "Scanning twelve months of your transactions for what stands out";
    case "check_affordability":
      return `Checking whether ${euros(args.amountEur)} fits before your next payday`;
    case "run_scenario":
      return `Projecting ${typeof args.years === "number" ? args.years : "the next"} years ahead from your real averages`;
    case "get_mortgage":
      return "Opening your mortgage application";
    case "search_offers":
      return `Searching today's ${text("billType") ?? "bill"} offers with Exa and reading the pages with Context.dev`;
    case "search_flats":
      return `Searching rental listings in ${text("city") ?? "your city"} with Exa and reading them with Context.dev`;
    case "search_prices":
      return `Searching prices for ${text("what") ?? "that"} with Exa and reading the pages with Context.dev`;
    case "web_search":
      return call.function.arguments.includes('"deep":true') || call.function.arguments.includes('"deep": true') ? `Researching across several sources with Exa: ${text("query") ?? "your question"}` : `Searching the web with Exa: ${text("query") ?? "your question"}`;
    case "show_chart":
      return "Drawing a chart from your account";
    case "calculate":
      return `Calculating ${text("what") ?? "the figure"}`;
    case "explain_concept":
      return "Building a short lesson from your own numbers";
    case "prepare_action":
      return args.kind === "switch_contract" ? `Setting up the ${text("billType") ?? "contract"} switch for you to approve` : `Setting up a transfer of ${euros(args.amountEur ?? args.monthlyAmountEur)} for you to approve`;
    case "remember":
      return "Saving that so I remember it next time";
    default:
      return `Running ${call.function.name}`;
  }
}
