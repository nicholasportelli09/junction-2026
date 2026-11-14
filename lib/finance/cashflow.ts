// Pay-cycle analysis: when money arrives, how fast it goes, and where the balance is likely to be just before the next payday.
// Everything is arithmetic on the customer's own rows. The projection is an estimate and says what it assumes.
import type { CalcStep, CashFlow, Overview, PayCycle, Transaction } from "@/lib/types";
import { basketOf } from "./baskets";
import { DATA_AS_OF, transactionsFor } from "./data";
import { median, round2, sum } from "./math";

const CYCLES_TO_KEEP = 12;
const FIRST_WEEK_DAYS = 7;
const DAY_MS = 86_400_000;

const toDate = (iso: string): Date => new Date(`${iso}T00:00:00Z`);
const toIso = (date: Date): string => date.toISOString().slice(0, 10);
const daysBetween = (from: string, to: string): number => Math.round((toDate(to).getTime() - toDate(from).getTime()) / DAY_MS);
const addDays = (iso: string, days: number): string => toIso(new Date(toDate(iso).getTime() + days * DAY_MS));
const isEveryday = (row: Transaction): boolean => row.amount < 0 && basketOf(row.category)?.basket === "everyday";
const spent = (rows: Transaction[]): number => round2(-sum(rows.map((row) => row.amount)));

// The first date after `after` that falls on `day` of a month (clamped to the month's length).
export function nextDayOfMonth(after: string, day: number): string {
  const start = toDate(after);
  for (let monthOffset = 0; monthOffset < 3; monthOffset++) {
    const year = start.getUTCFullYear();
    const month = start.getUTCMonth() + monthOffset;
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const candidate = toIso(new Date(Date.UTC(year, month, Math.min(day, lastDay))));
    if (candidate > after) return candidate;
  }
  return addDays(after, 30);
}

function buildCycles(rows: Transaction[], paydays: string[]): PayCycle[] {
  return paydays.slice(0, -1).map((payday, index) => {
    const end = paydays[index + 1];
    const inCycle = rows.filter((row) => row.date >= payday && row.date < end);
    const lowest = inCycle.reduce((low, row) => (row.balanceAfter < low.balanceAfter ? row : low), inCycle[0]);
    const firstWeekEnd = addDays(payday, FIRST_WEEK_DAYS);
    return {
      payday,
      income: round2(sum(inCycle.filter((row) => row.category === "Salary").map((row) => row.amount))),
      lowestBalance: lowest?.balanceAfter ?? 0,
      lowestOn: lowest?.date ?? payday,
      daysToLowest: lowest ? daysBetween(payday, lowest.date) : 0,
      spentInFirstWeek: spent(inCycle.filter((row) => isEveryday(row) && row.date < firstWeekEnd)),
      spentInCycle: spent(inCycle.filter(isEveryday)),
    };
  });
}

export function buildCashFlow(overview: Overview): CashFlow {
  const rows = transactionsFor(overview.customerId);
  const paydays = [...new Set(rows.filter((row) => row.category === "Salary").map((row) => row.date))].sort();
  const cycles = buildCycles(rows, paydays).slice(-CYCLES_TO_KEEP);
  const typicalPayday = paydays.length ? Math.round(median(paydays.map((date) => Number(date.slice(8, 10))))) : null;
  const nextPayday = typicalPayday === null ? null : nextDayOfMonth(DATA_AS_OF, typicalPayday);
  const daysToNextPayday = nextPayday ? daysBetween(DATA_AS_OF, nextPayday) : null;
  const averageDailyEverydayEur = round2((overview.monthlyEveryday * 12) / 365);

  const billsDueBeforePayday = nextPayday
    ? overview.recurringBills
        .map((bill) => ({ billId: bill.id, label: bill.guessLabel, amount: bill.monthlyAvg, expectedOn: nextDayOfMonth(DATA_AS_OF, bill.typicalDay) }))
        .filter((bill) => bill.expectedOn < nextPayday)
    : [];
  const billsTotal = round2(sum(billsDueBeforePayday.map((bill) => bill.amount)));
  const everydayUntilPayday = daysToNextPayday === null ? 0 : round2(averageDailyEverydayEur * daysToNextPayday);
  const projectedLowPointEur = nextPayday ? round2(overview.balance - billsTotal - everydayUntilPayday) : null;

  const cycleSpend = sum(cycles.map((cycle) => cycle.spentInCycle));
  const firstWeekShare = cycleSpend > 0 ? round2(sum(cycles.map((cycle) => cycle.spentInFirstWeek)) / cycleSpend) : null;

  const steps: CalcStep[] = nextPayday
    ? [
        { label: "Balance today", amount: overview.balance, basis: overview.balanceBasis ?? `account balance on ${DATA_AS_OF}` },
        { label: `Bills expected before payday (${billsDueBeforePayday.length})`, amount: -billsTotal, basis: "each bill's 12-month average, on its usual day of the month" },
        { label: `Everyday spending for ${daysToNextPayday} days`, amount: -everydayUntilPayday, basis: `€${averageDailyEverydayEur.toFixed(2)} a day, the 12-month average` },
        { label: "Expected balance just before payday", amount: projectedLowPointEur ?? 0, basis: `next payday expected on ${nextPayday}` },
      ]
    : [];

  return {
    customerId: overview.customerId,
    dataTimestamp: DATA_AS_OF,
    typicalPayday,
    nextPayday,
    daysToNextPayday,
    cycles,
    averageDailyEverydayEur,
    billsDueBeforePayday,
    projectedLowPointEur,
    firstWeekShare,
    negativeMonths: new Set(rows.filter((row) => row.balanceAfter < 0 && row.date >= overview.windowFrom).map((row) => row.date.slice(0, 7))).size,
    steps,
    assumptions: [
      `Payday is taken as day ${typicalPayday ?? "?"} of the month, the usual day in this customer's history.`,
      "The projection assumes bills and everyday spending follow their 12-month averages. A large one-off purchase would change it.",
      "Only this account is visible. Money held elsewhere is not counted.",
    ],
  };
}
