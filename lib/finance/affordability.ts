// "Can I afford this?" and "what if an unexpected bill arrives?", answered from the pay-cycle projection.
import type { Affordability, AffordabilityVerdict, CalcStep, CashFlow, Overview } from "@/lib/types";
import { round2 } from "./math";

export const AMOUNT_LIMITS: [number, number] = [1, 100_000];
const COMFORT_BUFFER_MONTHS = 1; // keeping at least a month of must-pay costs afterwards counts as comfortable

export function checkAffordability(overview: Overview, cashFlow: CashFlow, amountEur: number): Affordability | string {
  if (!Number.isFinite(amountEur) || amountEur < AMOUNT_LIMITS[0] || amountEur > AMOUNT_LIMITS[1]) return "Give an amount in euros between 1 and 100,000.";
  const amount = round2(amountEur);
  const balanceAfterEur = round2(overview.balance - amount);
  const projectedLowPointEur = cashFlow.projectedLowPointEur === null ? null : round2(cashFlow.projectedLowPointEur - amount);
  const lowPoint = projectedLowPointEur ?? balanceAfterEur;
  const bufferMonthsAfter = overview.monthlyMandatory > 0 ? round2(Math.max(lowPoint, 0) / overview.monthlyMandatory) : 0;
  // What is left over in an average month after all spending and existing savings.
  const monthlySurplus = round2(overview.monthlyIncome - overview.monthlySpending - overview.monthlySaved);

  const verdict: AffordabilityVerdict = lowPoint < 0 ? "not-yet" : bufferMonthsAfter >= COMFORT_BUFFER_MONTHS ? "comfortable" : "tight";
  const shortfall = lowPoint < 0 ? -lowPoint : 0;
  const monthsToSaveUp = verdict === "not-yet" && monthlySurplus > 0 ? Math.ceil(shortfall / monthlySurplus) : null;

  const steps: CalcStep[] = [
    { label: "Balance today", amount: overview.balance, basis: overview.balanceBasis ?? `account balance on ${overview.dataTimestamp}` },
    { label: "This cost", amount: -amount, basis: "the amount asked about" },
    ...cashFlow.steps.slice(1, 3),
    { label: "Expected balance just before payday", amount: lowPoint, basis: cashFlow.nextPayday ? `next payday expected on ${cashFlow.nextPayday}` : "no payday found in the data" },
    { label: "Must-pay costs in a month", amount: overview.monthlyMandatory, basis: "regular plus now-and-then baskets, 12-month average" },
  ];

  return {
    amountEur: amount,
    verdict,
    balanceAfterEur,
    projectedLowPointEur,
    bufferMonthsAfter,
    monthsToSaveUp,
    steps,
    assumptions: [
      ...cashFlow.assumptions,
      `"Comfortable" means at least ${COMFORT_BUFFER_MONTHS} month of must-pay costs is still covered just before payday. "Tight" means the balance stays above zero but below that.`,
      monthlySurplus > 0 ? `An average month leaves €${monthlySurplus.toFixed(2)} after all spending and existing savings.` : "An average month leaves nothing over after spending, so saving up would need a change first.",
    ],
  };
}
