// Turns shared market data into one customer's comparison. All arithmetic lives here, never in the model.
import type { BillType, Offer, ResearchResult } from "@/lib/types";
import type { RawOffer, RawResearch } from "./types";

// Used only when the customer has no bill to estimate from.
const DEFAULT_KWH_PER_YEAR = 2_000;
export const KWH_LIMITS: [number, number] = [500, 30_000];
const PLAUSIBLE_CENTS_PER_KWH: [number, number] = [1, 40];
const PLAUSIBLE_MONTHLY_EUR: [number, number] = [0, 200];
const SPOT_PATTERN = /spot|pörssi|market|hourly/i;

const round2 = (x: number) => Math.round(x * 100) / 100;
const within = (x: number, [lo, hi]: [number, number]) => x >= lo && x <= hi;
const clamp = (x: number, [lo, hi]: [number, number]) => Math.min(Math.max(x, lo), hi);

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function isSpot(offer: RawOffer): boolean {
  return SPOT_PATTERN.test(`${offer.contractType ?? ""} ${offer.plan ?? ""}`);
}

// Can this offer's price be compared fairly? A spot contract's listed price is only the margin on top
// of a market price that changes hourly, so it cannot.
function isComparable(offer: RawOffer, billType: BillType): boolean {
  if (offer.setupFeeEur !== null && (!Number.isFinite(offer.setupFeeEur) || offer.setupFeeEur < 0)) return false;
  if (offer.monthlyPriceEur === null || !Number.isFinite(offer.monthlyPriceEur) || !within(offer.monthlyPriceEur, PLAUSIBLE_MONTHLY_EUR)) return false;
  if (billType === "electricity") {
    return !isSpot(offer) && offer.energyPriceCentsPerKwh !== null && within(offer.energyPriceCentsPerKwh, PLAUSIBLE_CENTS_PER_KWH);
  }
  return offer.monthlyPriceEur !== null && within(offer.monthlyPriceEur, PLAUSIBLE_MONTHLY_EUR);
}

function monthlyCost(offer: RawOffer, billType: BillType, yearlyKwh: number): number | null {
  if (!isComparable(offer, billType)) return null;
  if (billType === "electricity") {
    return round2((yearlyKwh / 12) * ((offer.energyPriceCentsPerKwh as number) / 100) + (offer.monthlyPriceEur ?? 0) + (offer.setupFeeEur ?? 0) / 12);
  }
  return round2((offer.monthlyPriceEur as number) + (offer.setupFeeEur ?? 0) / 12);
}

function dedupe(offers: RawOffer[]): RawOffer[] {
  const seen = new Set<string>();
  return offers.filter((o) => {
    const id = `${o.provider}|${o.plan ?? ""}|${o.contractMonths ?? ""}`.toLowerCase();
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

type Usage = { yearlyKwh: number; source: NonNullable<ResearchResult["usageSource"]>; typicalCentsPerKwh: number | null; typicalFeeEur: number };

// If the bill is far more than that much electricity normally costs, part of it is something else
// (grid fees, other charges). Only the energy part can be saved by switching, so the comparison
// counts at most this multiple of today's typical price.
const MAX_PRICE_RATIO = 1.5;

function energyPartOfBill(baselineMonthlyEur: number, usage: Usage): { amount: number; capped: boolean } {
  if (usage.typicalCentsPerKwh === null) return { amount: baselineMonthlyEur, capped: false };
  const ceiling = usage.typicalFeeEur + (usage.yearlyKwh / 12) * ((usage.typicalCentsPerKwh * MAX_PRICE_RATIO) / 100);
  return baselineMonthlyEur > ceiling ? { amount: round2(ceiling), capped: true } : { amount: baselineMonthlyEur, capped: false };
}

// How much electricity does this customer use? We never see a meter reading, so:
// 1. use the figure the customer gave, if any;
// 2. otherwise work it out from their own bill, assuming they pay today's typical fixed price.
//    A bigger bill then means more use, not a bigger saving, which keeps the estimate modest;
// 3. with no bill at all, fall back to a small flat's use.
function estimateUsage(offers: RawOffer[], baselineMonthlyEur: number | null, statedYearlyKwh: number | null): Usage {
  const fixed = offers.filter((o) => isComparable(o, "electricity"));
  const typicalCentsPerKwh = fixed.length ? round2(median(fixed.map((o) => o.energyPriceCentsPerKwh as number))) : null;
  const typicalFeeEur = fixed.length ? median(fixed.map((o) => o.monthlyPriceEur ?? 0)) : 0;
  if (statedYearlyKwh !== null) return { yearlyKwh: Math.round(clamp(statedYearlyKwh, KWH_LIMITS)), source: "stated", typicalCentsPerKwh, typicalFeeEur };
  if (baselineMonthlyEur === null || typicalCentsPerKwh === null) return { yearlyKwh: DEFAULT_KWH_PER_YEAR, source: "default", typicalCentsPerKwh, typicalFeeEur };

  const monthlyKwh = Math.max(baselineMonthlyEur - typicalFeeEur, 0) / (typicalCentsPerKwh / 100);
  return { yearlyKwh: Math.round(clamp(monthlyKwh * 12, KWH_LIMITS)), source: "estimated-from-bill", typicalCentsPerKwh, typicalFeeEur };
}

function assumptionsFor(billType: BillType, baseline: number | null, usage: Usage | null, energyPart: { amount: number; capped: boolean } | null): string[] {
  const shared = [
    "Known setup fees are spread over the first 12 months. An unlisted setup fee is assumed zero; confirm it and any exit fees before switching. Offers missing a monthly price or base fee cannot be ranked.",
    "Prices are as stated on the linked pages at the time shown. Check the provider's own page before switching.",
    baseline === null
      ? "No current bill was found for this customer, so savings cannot be calculated."
      : `Savings compare each offer with your average bill of €${baseline.toFixed(2)} a month over the last 12 months.`,
    "The bank data has no payee names, so which bill this is rests on the name you confirmed.",
  ];
  if (billType !== "electricity" || !usage) return [...shared, "A setup fee is spread over the first 12 months."];

  const usageLine = {
    stated: `Electricity use is the ${usage.yearlyKwh} kWh a year you told us.`,
    "estimated-from-bill": `Your electricity use is not in the bank data. We estimate about ${usage.yearlyKwh} kWh a year from your bill, assuming you now pay today's typical fixed price (${usage.typicalCentsPerKwh} c/kWh). Tell Sisu your real yearly kWh, printed on your bill, for an exact figure.`,
    default: `Electricity cost assumes ${usage.yearlyKwh} kWh a year, typical for a small flat.`,
  }[usage.source];
  return [
    ...shared,
    usageLine,
    ...(energyPart?.capped
      ? [`Your bill is higher than ${usage.yearlyKwh} kWh a year would normally cost, so part of it is probably grid fees or other charges. The saving counts only the energy part, about €${energyPart.amount.toFixed(2)} a month.`]
      : []),
    "If your bill also covers grid (distribution) fees, the real saving is smaller: those fees do not change when you switch seller.",
    "Spot-price contracts are listed but not ranked, because their price changes every hour.",
  ];
}

export function toResult(raw: RawResearch, baselineMonthlyEur: number | null, statedYearlyKwh: number | null = null): ResearchResult {
  const unique = dedupe(raw.offers);
  const usage = raw.billType === "electricity" ? estimateUsage(unique, baselineMonthlyEur, statedYearlyKwh) : null;

  const energyPart = usage && baselineMonthlyEur !== null ? energyPartOfBill(baselineMonthlyEur, usage) : null;
  const compareAgainst = energyPart?.amount ?? baselineMonthlyEur;

  const offers: Offer[] = unique
    .map((offer) => {
      const cost = monthlyCost(offer, raw.billType, usage?.yearlyKwh ?? 0);
      const saving = cost !== null && compareAgainst !== null ? round2((compareAgainst - cost) * 12) : null;
      return { ...offer, comparable: cost !== null, estimatedMonthlyCostEur: cost, estimatedYearlySavingEur: saving };
    })
    .sort((a, b) => (a.estimatedMonthlyCostEur ?? Infinity) - (b.estimatedMonthlyCostEur ?? Infinity));

  const cheapest = offers.find((o) => o.comparable) ?? null;
  const best = cheapest && (cheapest.estimatedYearlySavingEur ?? 0) > 0 ? cheapest : null;
  const end = raw.finishedAt ?? Date.now();

  return {
    key: raw.key,
    billType: raw.billType,
    city: raw.city,
    status: raw.status,
    mock: raw.mock,
    query: raw.query,
    startedAt: new Date(raw.startedAt).toISOString(),
    finishedAt: raw.finishedAt ? new Date(raw.finishedAt).toISOString() : null,
    tookMs: end - raw.startedAt,
    pagesDone: raw.pagesDone,
    pagesTotal: raw.pagesTotal,
    baselineMonthlyEur,
    assumedYearlyKwh: usage?.yearlyKwh ?? null,
    usageSource: usage?.source ?? null,
    offers,
    best,
    citations: raw.citations,
    assumptions: assumptionsFor(raw.billType, baselineMonthlyEur, usage, energyPart),
    errors: raw.errors,
  };
}
