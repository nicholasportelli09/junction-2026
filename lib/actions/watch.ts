// Builds a watch for approval, from data the SERVER holds: the pages Sisu has just read and the customer's own
// figures. The model passes only a city or a topic, a price limit and a room count; the limit must be one the
// customer said (the tool checks that), and what it would do to their money is worked out here.
// One builder for both kinds: flats to rent (a rent per month) and anything else with a price (paid once).
import type { ListingSearch } from "@/lib/agent/research/listings";
import { checkAffordability } from "@/lib/finance/affordability";
import { buildCashFlow } from "@/lib/finance/cashflow";
import { fact } from "@/lib/finance/facts";
import { buildOverview } from "@/lib/finance/overview";
import { RENT_BUDGET_LIMITS, rentFacts, rentFit } from "@/lib/finance/rent";
import { activeWatch } from "@/lib/watch";
import { fits, ruleFor } from "@/lib/watch/detect";
import type { AgentAction, Fact, Overview } from "@/lib/types";
import type { DraftResult } from "./drafts";

// city: flats, where. topic: anything else, what (the search carries it). Exactly one of them is set.
export type WatchRequest = { city: string | null; topic?: string | null; budgetEur: number; minRooms: number | null; search: ListingSearch; preparedBy: AgentAction["preparedBy"] };

const ONE_OFF_LIMITS: [number, number] = [5, 100_000];

// The limit the customer gave, checked against their own figures: a warning to show, and the receipts behind it.
function checkLimit(overview: Overview, budget: number, monthly: boolean): { warning: string | null; facts: Fact[] } {
  if (monthly) {
    const fit = rentFit(overview, budget);
    const warning =
      fit.verdict === "over"
        ? `A rent of €${budget} is €${Math.round(fit.changePerMonthEur)} a month more than housing costs you today, and an average month would come out about €${Math.round(-fit.leftOverAfterEur)} short. The watch still uses the budget you gave.`
        : fit.verdict === "tight"
          ? `A rent of €${budget} would be ${Math.round(fit.shareOfIncomePct ?? 0)}% of your average income, which is high. The watch still uses the budget you gave.`
          : null;
    return { warning, facts: rentFacts("watch", fit, overview) };
  }
  const afford = checkAffordability(overview, buildCashFlow(overview), budget);
  if (typeof afford === "string") return { warning: null, facts: [] };
  const low = afford.projectedLowPointEur ?? afford.balanceAfterEur;
  const warning =
    afford.verdict === "not-yet"
      ? `Paying €${budget} today would leave your account about €${Math.round(-low)} below zero just before payday. The watch still uses the price you gave.`
      : afford.verdict === "tight"
        ? `After paying €${budget} you would have about €${Math.round(low)} just before payday, less than a month of must-pay costs. The watch still uses the price you gave.`
        : null;
  return { warning, facts: [fact("watch:balance", "Balance today", overview.balance, "EUR", `account balance on ${overview.dataTimestamp}`), fact("watch:after", "Expected balance just before payday, after paying the price you set", low, "EUR", "payday projection minus the price", { source: "calculation" })] };
}

export function buildWatchDraft(customerId: string, request: WatchRequest): DraftResult {
  const overview = buildOverview(customerId);
  if (!overview) return { ok: false, status: 404, reason: "We could not find that customer." };
  const { city, minRooms, search } = request;
  const topic = request.topic ?? null;
  const monthly = topic === null;
  const budget = Math.round(request.budgetEur);
  const limits = monthly ? RENT_BUDGET_LIMITS : ONE_OFF_LIMITS;
  if (!Number.isFinite(budget) || budget < limits[0] || budget > limits[1]) return { ok: false, status: 400, reason: `${monthly ? "A monthly rent budget" : "A price to watch for"} must be between €${limits[0]} and €${limits[1].toLocaleString("en-US")}.` };
  if (!search.pages.length) return { ok: false, status: 409, reason: "No page could be read just now, so there is nothing to watch yet. Try the search again." };
  const subject = topic ?? `flats in ${city}`;
  if (activeWatch(customerId, { city, topic, budgetEur: budget })) return { ok: false, status: 409, reason: `Sisu is already watching ${subject} at €${budget} or less.` };

  const unit = monthly ? ("EUR/month" as const) : ("EUR" as const);
  const seen = search.pages.flatMap((page) => page.listings);
  const rule = ruleFor({ budgetEur: budget, minRooms, topic });
  const fitting = seen.filter((listing) => fits(listing, rule));
  // The nearest miss: the cheapest thing read that is a real candidate (enough rooms, not an accessory).
  const cheapest = [...seen].filter((listing) => listing.priceEur >= (rule.floorEur ?? 0) && (minRooms === null || (listing.rooms ?? 0) >= minRooms)).sort((a, b) => a.priceEur - b.priceEur)[0] ?? null;
  const checked = checkLimit(overview, budget, monthly);
  const what = monthly ? `${minRooms ? `flats with ${minRooms} rooms or more` : "flats"} in ${city} at €${budget} a month or less` : `${topic} at €${budget} or less`;
  const things = monthly ? "flats" : "offers";
  return {
    ok: true,
    draft: {
      kind: monthly ? "property_watch" : "price_watch",
      title: monthly ? `Watch rents in ${city} and tell me when a ${minRooms ? `flat with ${minRooms}+ rooms` : "flat"} is €${budget} or less` : `Watch prices for ${topic} and tell me when one is €${budget} or less`,
      summary: `${fitting.length ? `${fitting.length} of the ${seen.length} ${things} read today fit` : `None of the ${seen.length} ${things} read today fit`} (${what}). Once you approve, Context.dev checks ${search.pages.length} page${search.pages.length === 1 ? "" : "s"} every 6 hours and Sisu tells you when a ${monthly ? "rent" : "price"} drops to your limit or a new ${monthly ? "flat" : "offer"} fits. The watching is real${search.mock ? " (example data here: no key is set)" : ""}; nothing is ${monthly ? "rented, booked" : "bought, ordered"} or paid, and no one is contacted.`,
      checklist: [
        `Approve, and Sisu starts watching ${search.pages.map((page) => new URL(page.url).hostname.replace(/^www\./, "")).join(", ")}.`,
        `When a page changes, Sisu reads it again and compares each ${monthly ? "rent" : "price"} with your limit in code.`,
        `You get a notification only when ${monthly ? "a flat" : "an offer"} fits. Check its own page before you ${monthly ? "contact anyone" : "buy"}.`,
        "Stop the watch whenever you like; its monitors are removed.",
      ],
      draftMessage: null,
      billType: null,
      offer: null,
      monthlyAmountEur: monthly ? budget : 0,
      warning: checked.warning,
      watch: { city, topic, priceUnit: unit, budgetEur: budget, minRooms, urls: search.pages.map((page) => page.url), seen },
      facts: [
        fact("watch:budget", monthly ? "Your rent budget per month" : "The price you set", budget, unit, "the figure you gave", { source: "customer-stated" }),
        fact("watch:read", `${monthly ? "Flats" : "Offers"} read from the pages today`, seen.length, "count", `read with Context.dev at ${search.retrievedAt}`, { source: "context.dev" }),
        fact("watch:fitting", `${monthly ? "Flats" : "Offers"} that fit today`, fitting.length, "count", monthly ? "rent at or under the budget, with the rooms asked for" : "price at or under the limit, leaving out likely accessories", { source: "calculation" }),
        ...(cheapest ? [fact("watch:cheapest", `Lowest ${monthly ? "rent" : "price"} found today (${cheapest.title})`, cheapest.priceEur, unit, "read from the page", { source: "context.dev", url: cheapest.url })] : []),
        ...(cheapest && cheapest.priceEur > budget ? [fact("watch:gap", `Lowest ${monthly ? "rent" : "price"} found is over your limit by`, cheapest.priceEur - budget, unit, "lowest found minus your limit", { source: "calculation" })] : []),
        ...checked.facts,
      ],
      sources: search.pages.map((page) => ({ title: page.title, url: page.url, retrievedAt: search.retrievedAt, cacheAgeMs: page.cacheAgeMs, readBy: "context.dev" as const })),
      assumptions: [
        `${monthly ? "Rents" : "Prices"} are as the pages state them; Sisu has not checked them with the ${monthly ? "landlord" : "seller"}.`,
        monthly ? "Housing today and what a month leaves over are 12-month averages from your bank data." : `An offer under €${Math.round(rule.floorEur ?? 0)} is taken to be a part or an accessory and is not reported.`,
        ...(search.errors.length ? [`Not every page could be read: ${search.errors.join("; ")}.`] : []),
      ],
      preparedBy: request.preparedBy,
    },
  };
}
