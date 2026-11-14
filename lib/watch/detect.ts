// The part of a watch that decides. No network and no state: given a page as it was and as it is now, which
// offers should the customer hear about? Code makes this call, never the model and never the page's own words.
// The same rule serves a flat to rent and anything else with a price.
import { listingKey } from "@/lib/agent/research/listings";
import { checkAffordability } from "@/lib/finance/affordability";
import { buildCashFlow } from "@/lib/finance/cashflow";
import { fact } from "@/lib/finance/facts";
import { round2 } from "@/lib/finance/math";
import { rentFacts, rentFit, withinBudget } from "@/lib/finance/rent";
import type { Fact, Listing, Overview, PropertyWatch, WatchNotification } from "@/lib/types";

export type WatchRule = { budgetEur: number; minRooms: number | null; floorEur?: number };
export type FitEvent = { kind: WatchNotification["kind"]; listing: Listing; previousPriceEur: number | null };

const MAX_EVENTS_PER_PAGE = 5;
// For a price watch: an offer at under this share of the price limit is almost always a part or an accessory
// (a phone case on a page of phones), so it is not reported. Flats have no floor.
export const ACCESSORY_SHARE = 0.3;

export const ruleFor = (watch: Pick<PropertyWatch, "budgetEur" | "minRooms" | "topic">): WatchRule => ({ budgetEur: watch.budgetEur, minRooms: watch.minRooms, floorEur: watch.topic ? round2(watch.budgetEur * ACCESSORY_SHARE) : 0 });

// An offer fits when its price is at or under the limit (and not under the floor) and, if rooms were asked for,
// the page states enough of them.
export const fits = (listing: Listing, rule: WatchRule): boolean => withinBudget(listing.priceEur, rule.budgetEur) && listing.priceEur >= (rule.floorEur ?? 0) && (rule.minRooms === null || (listing.rooms ?? 0) >= rule.minRooms);

// Compares two readings of the same page. An offer is reported when it fits now AND it is news: it was not on the
// page before, or its price has come down. One that already fitted at the same price is not reported again, and a
// price drop that still leaves it over the limit is not reported at all.
export function detectFits(previous: Listing[], current: Listing[], rule: WatchRule): FitEvent[] {
  const before = new Map(previous.map((listing) => [listingKey(listing), listing]));
  const events = current.flatMap((listing): FitEvent[] => {
    if (!fits(listing, rule)) return [];
    const earlier = before.get(listingKey(listing));
    if (!earlier) return [{ kind: "new_listing", listing, previousPriceEur: null }];
    if (listing.priceEur < earlier.priceEur) return [{ kind: "price_drop", listing, previousPriceEur: earlier.priceEur }];
    return [];
  });
  return events.sort((a, b) => a.listing.priceEur - b.listing.priceEur).slice(0, MAX_EVENTS_PER_PAGE);
}

const describe = (listing: Listing): string =>
  [listing.rooms === null ? null : `${listing.rooms} room${listing.rooms === 1 ? "" : "s"}`, listing.areaM2 === null ? null : `${listing.areaM2} m²`, listing.district, listing.details].filter(Boolean).join(", ");

type Checked = { sentence: string; leftOverAfterEur: number | null; balanceAfterEur: number | null; facts: Fact[] };

// The price checked against the customer's own figures: a rent against what an average month leaves over, a price
// paid once against the balance expected just before payday.
function checkAgainstFigures(id: string, monthly: boolean, price: number, overview: Overview): Checked {
  if (monthly) {
    const fit = rentFit(overview, price);
    return {
      sentence: fit.verdict === "over" ? `With this rent an average month would come out about €${Math.round(-fit.leftOverAfterEur)} short on your own figures.` : `With this rent an average month would leave about €${Math.round(fit.leftOverAfterEur)} over.`,
      leftOverAfterEur: fit.leftOverAfterEur,
      balanceAfterEur: null,
      facts: rentFacts(`watch:${id}`, fit, overview),
    };
  }
  const afford = checkAffordability(overview, buildCashFlow(overview), price);
  if (typeof afford === "string") return { sentence: "", leftOverAfterEur: null, balanceAfterEur: null, facts: [] };
  const low = afford.projectedLowPointEur ?? afford.balanceAfterEur;
  return {
    sentence: afford.verdict === "not-yet" ? `Paying it now would leave your account about €${Math.round(-low)} below zero just before payday, on your own figures.` : `After paying it you would have about €${Math.round(low)} just before payday${afford.verdict === "tight" ? ", which is less than a month of must-pay costs" : ""}.`,
    leftOverAfterEur: null,
    balanceAfterEur: low,
    facts: [fact(`watch:${id}:balance`, "Balance today", overview.balance, "EUR", `account balance on ${overview.dataTimestamp}`), fact(`watch:${id}:after`, "Expected balance just before payday, after paying this", low, "EUR", "payday projection minus the price", { source: "calculation" })],
  };
}

// Turns a finding into what the customer is told, with a receipt for every number in it.
export function toNotification(watch: PropertyWatch, overview: Overview, event: FitEvent, detectedBy: WatchNotification["detectedBy"], now: Date): WatchNotification {
  const { listing } = event;
  const monthly = watch.priceUnit === "EUR/month";
  const per = monthly ? " a month" : "";
  const price = listing.priceEur;
  const under = round2(watch.budgetEur - price);
  const simulated = detectedBy === "simulation";
  const id = crypto.randomUUID();
  const checked = checkAgainstFigures(id, monthly, price, overview);
  const details = describe(listing);
  const limit = monthly ? "your budget" : "the price you set";
  const what = monthly ? "rent per month" : "price";
  return {
    id,
    watchId: watch.id,
    customerId: watch.customerId,
    kind: event.kind,
    title: event.kind === "price_drop" ? `Price drop: ${listing.title} is now €${Math.round(price)}${per}` : `New ${monthly ? "listing" : "offer"}: ${listing.title} at €${Math.round(price)}${per}`,
    summary: [
      `€${Math.round(price)}${per}${event.previousPriceEur === null ? "" : `, down from €${Math.round(event.previousPriceEur)}`}: €${Math.round(under)} under ${limit} of €${Math.round(watch.budgetEur)}.`,
      details ? `${details}.` : null,
      checked.sentence || null,
      simulated ? "Simulated for the demo: the page did not really change." : `Check the ${monthly ? "listing" : "offer"}'s own page before you act: Sisu read it, it did not contact anyone.`,
    ]
      .filter(Boolean)
      .join(" "),
    listing,
    previousPriceEur: event.previousPriceEur,
    budgetEur: watch.budgetEur,
    underBudgetByEur: under,
    leftOverAfterEur: checked.leftOverAfterEur,
    balanceAfterEur: checked.balanceAfterEur,
    detectedAt: now.toISOString(),
    detectedBy,
    simulated,
    facts: [
      fact(`watch:${id}:price`, `${listing.title}: ${what}`, price, watch.priceUnit, simulated ? "made up by the demo's simulate button" : "read from the page", simulated ? { source: "assumption" } : { source: "context.dev", url: listing.url }),
      ...(event.previousPriceEur === null ? [] : [fact(`watch:${id}:before`, `${listing.title}: ${what} before`, event.previousPriceEur, watch.priceUnit, "read from the page earlier", { source: "context.dev", url: listing.url })]),
      fact(`watch:${id}:budget`, monthly ? "Your rent budget per month" : "The price you set", watch.budgetEur, watch.priceUnit, "the figure you gave", { source: "customer-stated" }),
      fact(`watch:${id}:under`, `Under ${limit} by`, under, watch.priceUnit, "limit minus price", { source: "calculation" }),
      ...checked.facts,
    ],
  };
}
