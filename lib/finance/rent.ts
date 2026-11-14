// A rent checked against the customer's own figures. The budget is what the customer said; this says what that rent
// would do to an average month, so a watch never tells them a flat "fits" when their numbers say it would not.
import type { CalcStep, Fact, Overview } from "@/lib/types";
import { fact } from "./facts";
import { round2 } from "./math";

export const RENT_BUDGET_LIMITS: [number, number] = [200, 10_000];
const HIGH_SHARE_OF_INCOME_PCT = 40; // a common rule of thumb; above it the rent is called tight even if the month still adds up

export type RentFit = {
  rentEur: number;
  currentHousingEur: number; // what they pay for housing today, 12-month average
  changePerMonthEur: number; // positive = the new rent costs more than housing does today
  leftOverNowEur: number;
  leftOverAfterEur: number;
  shareOfIncomePct: number | null;
  verdict: "fits" | "tight" | "over";
  steps: CalcStep[];
};

// The one comparison a watch makes. A listing fits when its rent is at or under the budget, and it has the rooms asked for.
export const withinBudget = (priceEur: number, budgetEur: number): boolean => Number.isFinite(priceEur) && priceEur > 0 && priceEur <= budgetEur;

export function currentHousing(overview: Overview): number {
  const housing = overview.baskets.flatMap((basket) => basket.categories).find((category) => category.category === "Housing");
  return round2(housing?.monthlyAvg ?? 0);
}

// What an average month looks like if housing cost `rentEur` instead of what it costs today.
export function rentFit(overview: Overview, rentEur: number): RentFit {
  const rent = round2(rentEur);
  const housing = currentHousing(overview);
  const change = round2(rent - housing);
  const leftOverNow = round2(overview.safeToSpend.gapPerMonth);
  const leftOverAfter = round2(leftOverNow - change);
  const share = overview.monthlyIncome > 0 ? round2((rent / overview.monthlyIncome) * 100) : null;
  const verdict = leftOverAfter < 0 ? "over" : share !== null && share > HIGH_SHARE_OF_INCOME_PCT ? "tight" : "fits";
  return {
    rentEur: rent,
    currentHousingEur: housing,
    changePerMonthEur: change,
    leftOverNowEur: leftOverNow,
    leftOverAfterEur: leftOverAfter,
    shareOfIncomePct: share,
    verdict,
    steps: [
      { label: "Left over in an average month today", amount: leftOverNow, basis: "safe to spend minus actual everyday spending, 12-month average" },
      { label: "Housing today", amount: housing, basis: "Housing payments, 12-month average" },
      { label: "This rent", amount: -rent, basis: "the monthly rent being checked" },
      { label: "Left over in an average month with this rent", amount: leftOverAfter, basis: "left over today, plus housing today, minus this rent" },
    ],
  };
}

export function rentFacts(prefix: string, fit: RentFit, overview: Overview): Fact[] {
  return [
    fact(`${prefix}:housing-now`, "Housing cost per month today", fit.currentHousingEur, "EUR/month", "Housing payments, 12-month average", { evidence: { from: overview.windowFrom, to: overview.windowTo, category: "Housing" } }),
    fact(`${prefix}:left-over-now`, "Left over in an average month today", fit.leftOverNowEur, "EUR/month", "safe to spend minus actual everyday spending", { source: "calculation" }),
    fact(`${prefix}:left-over-after`, "Left over in an average month with this rent", fit.leftOverAfterEur, "EUR/month", "left over today, plus housing today, minus the rent", { source: "calculation" }),
    ...(fit.shareOfIncomePct === null ? [] : [fact(`${prefix}:share`, "This rent as a share of income", fit.shareOfIncomePct, "percent", "rent divided by average monthly income", { source: "calculation" })]),
  ];
}
