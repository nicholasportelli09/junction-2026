// The tools the model may choose from.
import { BASKET_ORDER, MCC_LABELS } from "@/lib/finance/baskets";
import { CONCEPTS } from "@/lib/finance/teaching";
import { CALC_UNITS } from "./calc";
import { CHART_KINDS } from "../visuals";
import type { BillType } from "@/lib/types";
import type { ToolSchema } from "../model";

export const BILL_TYPES: BillType[] = ["electricity", "mobile", "internet"];
export const CATEGORIES = ["Housing", "Utilities", "Health", "Home & Tech", "Groceries", "Restaurants", "Transportation", "Entertainment", "Lifestyle", "Travel"];
export const MERCHANT_TYPES = [...new Set(Object.values(MCC_LABELS))];
export const GROUPINGS = ["month", "category", "merchantType"];
export const MEMORY_KINDS = ["yearly_kwh", "bill_name", "preference", "goal"];
export const ACTION_KINDS = ["switch_contract", "standing_transfer", "one_off_transfer"];
export const DESTINATIONS = ["savings", "investments"];

const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []): ToolSchema => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties, required } },
});

// Every character here is read by the model on every step (about 10 ms per 1,000 characters on our GPU, measured in
// tests/gauntlet/results), so descriptions say when to use the tool and nothing more.
export const TOOL_SCHEMAS: ToolSchema[] = [
  tool(
    "get_spending",
    "Exact spending total and count for any period, optionally by category, merchant type or basket, optionally split. Also returns the largest purchases.",
    {
      from: { type: "string", description: "YYYY-MM-DD" },
      to: { type: "string", description: "YYYY-MM-DD" },
      category: { type: "string", enum: CATEGORIES },
      merchantType: { type: "string", enum: MERCHANT_TYPES },
      basket: { type: "string", enum: BASKET_ORDER },
      groupBy: { type: "string", enum: GROUPINGS },
    },
    ["from", "to"],
  ),
  tool("list_bills", "Recurring bills: yearly cost, change on a year ago, and whether each name is confirmed.", {}),
  tool("get_cash_flow", "Pay cycles: how fast money goes after payday, lowest balance each cycle, bills due before the next payday.", {}),
  tool("find_patterns", "Scans the history for what stands out, ranked by yearly euros. For open questions: where does my money go, what should I change, how can I save.", {}),
  tool("check_affordability", "Can the customer absorb a one-off or unexpected cost now?", { amountEur: { type: "number" }, what: { type: "string" } }, ["amountEur"]),
  tool(
    "run_scenario",
    "Projects three futures (change nothing, keep the cash, invest it). For what-if questions, what a saving or a lump sum adds up to, and how long until a target balance.",
    {
      freedPerMonthEur: { type: "number", description: "euros freed per month by a change, taken from a tool result or the customer (a cheaper contract, a category cut to a figure). 0 if none" },
      category: { type: "string", enum: CATEGORIES, description: "with categoryCutPct: the category the customer wants to cut ('dining out' is Restaurants)" },
      categoryCutPct: { type: "number", description: "the percentage to cut that category by, 1 to 100 ('reduce dining out by 20%' is 20). Code works out the euros from the 12-month average" },
      everydayCutPct: { type: "number", description: "only if the customer names a percentage cut of ALL everyday spending, 0 to 50. Otherwise 0" },
      years: { type: "number", description: "1 to 10. Use 5 if the customer named none" },
      oneOffEur: { type: "number", description: "optional: a lump sum (a gift, a bonus) to see invested against left in the account" },
      targetEur: { type: "number", description: "optional: a balance the customer wants to reach" },
    },
    ["years"],
  ),
  tool("get_mortgage", "The customer's mortgage application on record, beside their income and balance. For questions about buying a home or their mortgage.", {}),
  tool(
    "search_offers",
    "Live search for current Finnish offers for one bill, with the saving computed against the customer's real bill.",
    { billType: { type: "string", enum: BILL_TYPES }, yearlyKwh: { type: "number", description: "electricity only, ONLY if the customer said it" } },
    ["billType"],
  ),
  tool(
    "search_flats",
    "Live search for flats to rent in a city within a monthly budget the customer said. If nothing fits it sets up a price watch for them to approve.",
    { city: { type: "string", description: "the city they named; leave out for where they live" }, budgetEur: { type: "number", description: "the monthly rent they said" }, minRooms: { type: "number", description: "only if they asked for a number of rooms" }, watch: { type: "boolean", description: "true if they asked you to keep watching even though some flats fit" } },
    ["budgetEur"],
  ),
  tool(
    "search_prices",
    "Live search for what something costs today (a phone, a used car, a bike, anything sold online) against a price the customer said. If nothing is at that price it sets up a price watch for them to approve. Not for flats (search_flats) or their bills (search_offers).",
    { what: { type: "string", description: "the thing, in a few plain words: 'iPhone 15', 'used Toyota Corolla'. No amounts" }, maxPriceEur: { type: "number", description: "the most they said they would pay" }, watch: { type: "boolean", description: "true if they asked you to keep watching even though some offers fit" } },
    ["what", "maxPriceEur"],
  ),
  tool("web_search", "Live web search (Exa) for anything in the outside world: rents and prices nearby, typical water or energy use, benefits, rates, rules, a company, how something works. Keep the query general: place and topic, no personal figures.", { query: { type: "string" }, deep: { type: "boolean", description: "true for an open question that needs several sources put together (who can get a benefit, what changes next year, how a rule works for someone like them). Takes a few seconds longer. Leave out for a single fact or price." } }, ["query"]),
  tool(
    "calculate",
    "Does arithmetic for you: an estimate from web figures, or combining amounts. Use it instead of working anything out yourself.",
    {
      expression: { type: "string", description: "numbers with + - * / and brackets, e.g. 3 * 12 * 365 / 1000 * 4.5" },
      figures: { type: "string", description: "every figure in the sum, in order, with its unit and where it came from, separated by ';'. E.g. '3 minutes less (customer); 12 litres a minute (typical shower, from motiva.fi); 365 showers a year (assumed one a day); 1000 litres in a cubic metre; 4.5 euros per cubic metre of water and heating (from hsy.fi)'" },
      what: { type: "string", description: "what the result is, a few words" },
      unit: { type: "string", enum: CALC_UNITS },
    },
    ["expression", "figures", "what"],
  ),
  tool(
    "show_chart",
    "Puts a chart on the customer's screen. baskets = their three baskets (must pay every month, must pay now and then, everyday choices). budget = a ring of where their money goes by category. vs_peers = their categories beside people their age. months = money in and out for each of the last 12 months. safe_to_spend = how safe-to-spend is built up.",
    { chart: { type: "string", enum: CHART_KINDS } },
    ["chart"],
  ),
  tool("explain_concept", "A short lesson from the customer's own numbers, ending in one question to ask them. Only for the ideas in the list. Explain any other idea yourself, in plain words, with no tool.", { concept: { type: "string", enum: CONCEPTS } }, ["concept"]),
  tool(
    "prepare_action",
    "Sets up an action for the customer to approve with one tap: switching a contract (needs search_offers first), or moving money between their own accounts once or every month.",
    {
      kind: { type: "string", enum: ACTION_KINDS, description: "one_off_transfer = move an amount once, now. standing_transfer = every month on payday" },
      billType: { type: "string", enum: BILL_TYPES },
      provider: { type: "string", description: "from search_offers, if the customer chose one" },
      amountEur: { type: "number", description: "transfers: the amount the customer said or agreed to" },
      destination: { type: "string", enum: DESTINATIONS, description: "transfers: savings (default) or their investment account" },
    },
    ["kind"],
  ),
  tool(
    "remember",
    "Saves a lasting fact the customer just told you about themselves.",
    {
      kind: { type: "string", enum: MEMORY_KINDS },
      value: { type: "string", description: "their words; for yearly_kwh the number only" },
      billId: { type: "string", description: "bill_name: e.g. utilities-2" },
      billType: { type: "string", enum: BILL_TYPES },
    },
    ["kind", "value"],
  ),
];
