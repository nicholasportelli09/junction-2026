// The part of a property watch that decides. No network and no state: given a page as it was and as it is now,
// which flats should the customer hear about? Code makes this call, never the model and never the page's own words.
import { listingKey } from "@/lib/agent/research/listings";
import { fact } from "@/lib/finance/facts";
import { round2 } from "@/lib/finance/math";
import { rentFacts, rentFit, withinBudget } from "@/lib/finance/rent";
import type { Listing, Overview, PropertyWatch, WatchNotification } from "@/lib/types";

export type WatchRule = { budgetEur: number; minRooms: number | null };
export type FitEvent = { kind: WatchNotification["kind"]; listing: Listing; previousPriceEur: number | null };

const MAX_EVENTS_PER_PAGE = 5;

// A flat fits when its rent is at or under the budget and, if rooms were asked for, the page states enough of them.
export const fits = (listing: Listing, rule: WatchRule): boolean => withinBudget(listing.pricePerMonthEur, rule.budgetEur) && (rule.minRooms === null || (listing.rooms ?? 0) >= rule.minRooms);

// Compares two readings of the same page. A flat is reported when it fits now AND it is news: it was not on the
// page before, or its rent has come down. A flat that already fitted at the same rent is not reported again, and a
// price drop that still leaves the flat over budget is not reported at all.
export function detectFits(previous: Listing[], current: Listing[], rule: WatchRule): FitEvent[] {
  const before = new Map(previous.map((listing) => [listingKey(listing), listing]));
  const events = current.flatMap((listing): FitEvent[] => {
    if (!fits(listing, rule)) return [];
    const earlier = before.get(listingKey(listing));
    if (!earlier) return [{ kind: "new_listing", listing, previousPriceEur: null }];
    if (listing.pricePerMonthEur < earlier.pricePerMonthEur) return [{ kind: "price_drop", listing, previousPriceEur: earlier.pricePerMonthEur }];
    return [];
  });
  return events.sort((a, b) => a.listing.pricePerMonthEur - b.listing.pricePerMonthEur).slice(0, MAX_EVENTS_PER_PAGE);
}

const describe = (listing: Listing): string =>
  [listing.rooms === null ? null : `${listing.rooms} room${listing.rooms === 1 ? "" : "s"}`, listing.areaM2 === null ? null : `${listing.areaM2} m²`, listing.district].filter(Boolean).join(", ");

// Turns a finding into what the customer is told, with a receipt for every number in it. The rent is checked
// against their own figures (lib/finance/rent), so the message also says what the month would look like.
export function toNotification(watch: PropertyWatch, overview: Overview, event: FitEvent, detectedBy: WatchNotification["detectedBy"], now: Date): WatchNotification {
  const { listing } = event;
  const price = listing.pricePerMonthEur;
  const under = round2(watch.budgetEur - price);
  const fit = rentFit(overview, price);
  const simulated = detectedBy === "simulation";
  const id = crypto.randomUUID();
  const details = describe(listing);
  return {
    id,
    watchId: watch.id,
    customerId: watch.customerId,
    kind: event.kind,
    title: event.kind === "price_drop" ? `Price drop: ${listing.title} is now €${Math.round(price)} a month` : `New listing: ${listing.title} at €${Math.round(price)} a month`,
    summary: [
      `€${Math.round(price)} a month${event.previousPriceEur === null ? "" : `, down from €${Math.round(event.previousPriceEur)}`}: €${Math.round(under)} under your budget of €${Math.round(watch.budgetEur)}.`,
      details ? `${details}.` : null,
      fit.verdict === "over" ? `With this rent an average month would come out about €${Math.round(-fit.leftOverAfterEur)} short on your own figures.` : `With this rent an average month would leave about €${Math.round(fit.leftOverAfterEur)} over.`,
      simulated ? "Simulated for the demo: the page did not really change." : "Check the listing's own page before you act: Sisu read it, it did not contact anyone.",
    ]
      .filter(Boolean)
      .join(" "),
    listing,
    previousPriceEur: event.previousPriceEur,
    budgetEur: watch.budgetEur,
    underBudgetByEur: under,
    leftOverAfterEur: fit.leftOverAfterEur,
    detectedAt: now.toISOString(),
    detectedBy,
    simulated,
    facts: [
      fact(`watch:${id}:rent`, `${listing.title}: rent per month`, price, "EUR/month", simulated ? "made up by the demo's simulate button" : "read from the listing page", simulated ? { source: "assumption" } : { source: "context.dev", url: listing.url }),
      ...(event.previousPriceEur === null ? [] : [fact(`watch:${id}:before`, `${listing.title}: rent per month before`, event.previousPriceEur, "EUR/month", "read from the listing page earlier", { source: "context.dev", url: listing.url })]),
      fact(`watch:${id}:budget`, "Your rent budget per month", watch.budgetEur, "EUR/month", "the budget you gave", { source: "customer-stated" }),
      fact(`watch:${id}:under`, "Under your budget by", under, "EUR/month", "budget minus rent", { source: "calculation" }),
      ...rentFacts(`watch:${id}`, fit, overview),
    ],
  };
}
