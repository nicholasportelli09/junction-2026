// Builds a property watch for approval, from data the SERVER holds: the listing pages Sisu has just read and the
// customer's own figures. The model passes only a city, a budget and a room count; the budget must be one the
// customer said (the tool checks that), and what it would do to their month is worked out here.
import type { ListingSearch } from "@/lib/agent/research/listings";
import { fact } from "@/lib/finance/facts";
import { buildOverview } from "@/lib/finance/overview";
import { RENT_BUDGET_LIMITS, rentFacts, rentFit } from "@/lib/finance/rent";
import { activeWatch } from "@/lib/watch";
import { fits } from "@/lib/watch/detect";
import type { AgentAction } from "@/lib/types";
import type { DraftResult } from "./drafts";

export type WatchRequest = { city: string; budgetEur: number; minRooms: number | null; search: ListingSearch; preparedBy: AgentAction["preparedBy"] };

export function buildWatchDraft(customerId: string, request: WatchRequest): DraftResult {
  const overview = buildOverview(customerId);
  if (!overview) return { ok: false, status: 404, reason: "We could not find that customer." };
  const { city, minRooms, search } = request;
  const budget = Math.round(request.budgetEur);
  if (!Number.isFinite(budget) || budget < RENT_BUDGET_LIMITS[0] || budget > RENT_BUDGET_LIMITS[1]) return { ok: false, status: 400, reason: `A monthly rent budget must be between €${RENT_BUDGET_LIMITS[0]} and €${RENT_BUDGET_LIMITS[1].toLocaleString("en-US")}.` };
  if (!search.pages.length) return { ok: false, status: 409, reason: "No listing page could be read just now, so there is nothing to watch yet. Try the search again." };
  if (activeWatch(customerId, city, budget)) return { ok: false, status: 409, reason: `Sisu is already watching ${city} for flats at €${budget} or less.` };

  const seen = search.pages.flatMap((page) => page.listings);
  const rule = { budgetEur: budget, minRooms };
  const fitting = seen.filter((listing) => fits(listing, rule));
  const cheapest = [...seen].filter((listing) => minRooms === null || (listing.rooms ?? 0) >= minRooms).sort((a, b) => a.pricePerMonthEur - b.pricePerMonthEur)[0] ?? null;
  const fit = rentFit(overview, budget);
  const what = `${minRooms ? `flats with ${minRooms} rooms or more` : "flats"} in ${city} at €${budget} a month or less`;
  const warning =
    fit.verdict === "over"
      ? `A rent of €${budget} is €${Math.round(fit.changePerMonthEur)} a month more than housing costs you today, and an average month would come out about €${Math.round(-fit.leftOverAfterEur)} short. The watch still uses the budget you gave.`
      : fit.verdict === "tight"
        ? `A rent of €${budget} would be ${Math.round(fit.shareOfIncomePct ?? 0)}% of your average income, which is high. The watch still uses the budget you gave.`
        : null;
  return {
    ok: true,
    draft: {
      kind: "property_watch",
      title: `Watch rents in ${city} and tell me when a ${minRooms ? `flat with ${minRooms}+ rooms` : "flat"} is €${budget} or less`,
      summary: `${fitting.length ? `${fitting.length} of the ${seen.length} flats read today fit` : `None of the ${seen.length} flats read today fit`} (${what}). Once you approve, Context.dev checks ${search.pages.length} listing page${search.pages.length === 1 ? "" : "s"} every 6 hours and Sisu tells you when a rent drops into your budget or a new flat fits. The watching is real${search.mock ? " (example data here: no key is set)" : ""}; nothing is rented, booked or paid, and no one is contacted.`,
      checklist: [
        `Approve, and Sisu starts watching ${search.pages.map((page) => new URL(page.url).hostname.replace(/^www\./, "")).join(", ")}.`,
        "When a page changes, Sisu reads it again and compares each rent with your budget in code.",
        "You get a notification only when a flat fits. Check the listing's own page before you contact anyone.",
        "Stop the watch whenever you like; its monitors are removed.",
      ],
      draftMessage: null,
      billType: null,
      offer: null,
      monthlyAmountEur: budget,
      warning,
      watch: { city, budgetEur: budget, minRooms, urls: search.pages.map((page) => page.url), seen },
      facts: [
        fact("watch:budget", "Your rent budget per month", budget, "EUR/month", "the budget you gave", { source: "customer-stated" }),
        fact("watch:read", "Flats read from the listing pages today", seen.length, "count", `read with Context.dev at ${search.retrievedAt}`, { source: "context.dev" }),
        fact("watch:fitting", "Flats that fit today", fitting.length, "count", "rent at or under the budget, with the rooms asked for", { source: "calculation" }),
        ...(cheapest ? [fact("watch:cheapest", `Lowest rent found today (${cheapest.title})`, cheapest.pricePerMonthEur, "EUR/month", "read from the listing page", { source: "context.dev", url: cheapest.url })] : []),
        ...(cheapest && cheapest.pricePerMonthEur > budget ? [fact("watch:gap", "Lowest rent found is over your budget by", cheapest.pricePerMonthEur - budget, "EUR/month", "lowest rent minus budget", { source: "calculation" })] : []),
        ...rentFacts("watch", fit, overview),
      ],
      sources: search.pages.map((page) => ({ title: page.title, url: page.url, retrievedAt: search.retrievedAt, cacheAgeMs: page.cacheAgeMs, readBy: "context.dev" as const })),
      assumptions: ["Rents are as the listing pages state them; Sisu has not checked them with the landlord.", "Housing today and what a month leaves over are 12-month averages from your bank data.", ...(search.errors.length ? [`Not every page could be read: ${search.errors.join("; ")}.`] : [])],
      preparedBy: request.preparedBy,
    },
  };
}
