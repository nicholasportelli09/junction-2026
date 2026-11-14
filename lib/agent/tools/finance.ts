// Tools that read the customer's own bank data. Each runs code in lib/finance and hands back receipts for its numbers.
import { BASKET_ORDER, MCC_LABELS } from "@/lib/finance/baskets";
import { checkAffordability } from "@/lib/finance/affordability";
import { DATA_AS_OF, lastDayOf } from "@/lib/finance/data";
import { fact } from "@/lib/finance/facts";
import { groupBy, round2, sum } from "@/lib/finance/math";
import { mortgageFor } from "@/lib/finance/mortgage";
import { findPatterns } from "@/lib/finance/patterns";
import { FUND_FEE, LIMITS, RETURN_SCENARIOS, cleanInput, runScenario } from "@/lib/finance/scenario";
import { categoryAverages } from "@/lib/finance/categories";
import { basketsVisual, futuresVisual } from "../visuals";
import { CONCEPTS, teachingCard } from "@/lib/finance/teaching";
import { filterTransactions } from "@/lib/finance/transactions";
import { billLabel } from "@/lib/memory";
import type { BasketId, BillType, ConceptId, EvidenceFilter, Fact, Transaction } from "@/lib/types";
import { CATEGORIES, GROUPINGS, MERCHANT_TYPES } from "./schemas";
import { type ToolContext, type ToolOutcome, factsForModel, failure, outcome } from "./types";
import { accountsFor } from "@/lib/actions";
import { buildCashFlow } from "@/lib/finance/cashflow";
import { withCurrentAccount } from "@/lib/actions/bank";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_GROUPS = 12;
const LARGEST_SHOWN = 3;
const PATTERNS_SHOWN = 5;

export function getSpending(args: Record<string, unknown>, ctx: ToolContext): ToolOutcome {
  const from = typeof args.from === "string" && DATE_RE.test(args.from) ? args.from : null;
  const to = typeof args.to === "string" && DATE_RE.test(args.to) ? args.to : DATA_AS_OF;
  if (!from || from > to) return failure("finance", "get_spending needs a valid from and to date (YYYY-MM-DD).");

  const category = CATEGORIES.includes(args.category as string) ? (args.category as string) : undefined;
  const basket = BASKET_ORDER.includes(args.basket as BasketId) ? (args.basket as BasketId) : undefined;
  const merchantType = MERCHANT_TYPES.includes(args.merchantType as string) ? (args.merchantType as string) : undefined;
  const grouping = GROUPINGS.includes(args.groupBy as string) ? (args.groupBy as string) : undefined;
  // One merchant type can cover several merchant codes (for example two fuel codes), so they are summed.
  // With no filter at all, the three baskets together are "all spending" (income and savings are left out).
  const filters: EvidenceFilter[] = merchantType
    ? Object.keys(MCC_LABELS).filter((code) => MCC_LABELS[code] === merchantType).map((mcc) => ({ from, to, category, basket, mcc }))
    : category || basket
      ? [{ from, to, category, basket }]
      : BASKET_ORDER.map((id) => ({ from, to, basket: id }));

  // Untruncated rows, so totals, splits and "largest" always cover the whole period.
  const matched: Transaction[] = filters.flatMap((filter) => filterTransactions(ctx.customerId, filter));
  const rows = matched.filter((row) => row.amount < 0);
  const count = rows.length;
  const totalEur = round2(-sum(rows.map((row) => row.amount))); // money out only, the same rows the split and "largest" use
  const what = merchantType ?? category ?? basket ?? "all spending";
  const evidence: EvidenceFilter = filters.length === 1 ? filters[0] : { from, to, category };

  const largest = [...rows].sort((a, b) => a.amount - b.amount).slice(0, LARGEST_SHOWN).map((row) => ({ date: row.date, amount: round2(-row.amount), category: row.category, merchantType: row.mcc ? (MCC_LABELS[row.mcc] ?? null) : null }));
  const keyOf = (row: Transaction): string => (grouping === "month" ? row.date.slice(0, 7) : grouping === "category" ? row.category : (row.mcc && MCC_LABELS[row.mcc]) || "Other");
  const groups = grouping
    ? Object.entries(groupBy(rows, keyOf))
        .map(([key, items]) => ({ key, totalEur: round2(-sum(items.map((row) => row.amount))), transactions: items.length }))
        .sort((a, b) => (grouping === "month" ? a.key.localeCompare(b.key) : b.totalEur - a.totalEur))
        .slice(0, MAX_GROUPS)
    : [];

  // Averages over the period, worked out here so the model never divides.
  const days = Math.max(Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1, 1);
  const perDayEur = round2(totalEur / days);
  const perMonthEur = round2(totalEur / (days / (365 / 12)));
  // An empty period is easy to misread as "you never spend on this". The usual figure is given alongside.
  const usual = category ? ctx.overview.baskets.flatMap((b) => b.categories).find((c) => c.category === category) : undefined;
  const emptyNote = count === 0 && usual ? `Nothing in this period, but the 12-month average for ${category} is ${usual.monthlyAvg} euros a month. Say both.` : undefined;

  const facts: Fact[] = [
    fact("spending:total", `Spent on ${what}, ${from} to ${to}`, totalEur, "EUR", `sum of ${count} transactions`, { evidence }),
    fact("spending:per-day", `${what}, average per day`, perDayEur, "EUR", `total divided by ${days} days`, { source: "calculation", evidence }),
    fact("spending:per-month", `${what}, average per month`, perMonthEur, "EUR/month", `total divided by ${days} days, times an average month`, { source: "calculation", evidence }),
    ...(usual ? [fact("spending:usual", `${category}, 12-month average`, usual.monthlyAvg, "EUR/month", "average of the last 12 months")] : []),
    fact("spending:count", `Transactions on ${what}, ${from} to ${to}`, count, "count", "number of matching transactions", { evidence }),
    ...groups.map((group) => fact(`spending:group:${group.key}`, `${what}, ${group.key}`, group.totalEur, "EUR", `sum of ${group.transactions} transactions`, { evidence: grouping === "month" ? { ...evidence, from: `${group.key}-01`, to: lastDayOf(group.key) } : evidence })),
    ...largest.map((row, index) => fact(`spending:largest:${index + 1}`, `Largest ${index + 1}: ${row.merchantType ?? row.category} on ${row.date}`, row.amount, "EUR", "a single transaction", { evidence })),
  ];

  return outcome({
    content: JSON.stringify({ from, to, filter: what, totalSpentEur: totalEur, transactions: count, daysInPeriod: days, averagePerDayEur: perDayEur, averagePerMonthEur: perMonthEur, ...(emptyNote ? { note: emptyNote } : {}), ...(grouping ? { splitBy: grouping, split: groups } : {}), largest }),
    summary: `€${totalEur.toFixed(2)} on ${what} across ${count} transactions, ${from} to ${to}`,
    facts,
    stages: [{ kind: "evidence", title: `Spending on ${what}`, summary: `€${totalEur.toFixed(2)} across ${count} transactions, ${from} to ${to}`, source: "bank-data", data: { kind: "evidence", filter: evidence, count, totalEur, largest } }],
  });
}

export function listBills(ctx: ToolContext): ToolOutcome {
  const patterns = findPatterns(ctx.overview, ctx.cashFlow());
  const bills = ctx.overview.recurringBills.map((bill) => {
    const name = billLabel(bill, ctx.memory);
    const creep = patterns.find((p) => p.id === `bill-creep:${bill.id}`);
    return {
      billId: bill.id,
      name: name.label,
      nameIs: name.confirmed ? "confirmed by the customer" : "Sisu's guess: the bank data has no payee name, so ask the customer to confirm",
      monthlyEur: bill.monthlyAvg,
      yearlyEur: round2(bill.monthlyAvg * 12),
      lowEur: bill.min,
      highEur: bill.max,
      usualDayOfMonth: bill.typicalDay,
      changeOnAYearAgo: creep ? `up ${creep.facts[1]?.value}% (${creep.facts[2]?.value} euros more a year)` : "no notable rise",
      shape: bill.basis,
    };
  });
  const evidence = { from: ctx.overview.windowFrom, to: ctx.overview.windowTo };
  const facts = [
    ...ctx.overview.recurringBills.flatMap((bill) => [
      fact(`${bill.id}:monthly`, `${billLabel(bill, ctx.memory).label}, per month`, bill.monthlyAvg, "EUR/month", `average of ${bill.monthsSeen} payments`, { evidence: { ...evidence, category: bill.category } }),
      fact(`${bill.id}:yearly`, `${billLabel(bill, ctx.memory).label}, per year`, bill.monthlyAvg * 12, "EUR/year", "monthly average times 12", { source: "calculation", evidence: { ...evidence, category: bill.category } }),
      fact(`${bill.id}:low`, `${billLabel(bill, ctx.memory).label}, lowest month`, bill.min, "EUR", "last 12 months"),
      fact(`${bill.id}:high`, `${billLabel(bill, ctx.memory).label}, highest month`, bill.max, "EUR", "last 12 months"),
    ]),
    ...patterns.filter((p) => p.kind === "bill-creep").flatMap((p) => p.facts),
  ];
  const yearlyTotal = round2(sum(bills.map((bill) => bill.yearlyEur)));
  return outcome({
    content: JSON.stringify({ bills, allBillsYearlyEur: yearlyTotal }),
    summary: `${bills.length} recurring bills, €${yearlyTotal.toFixed(0)} a year in total`,
    facts: [...facts, fact("bills:yearly-total", "All recurring bills, per year", yearlyTotal, "EUR/year", "sum of the monthly averages times 12", { source: "calculation" })],
    stages: [{ kind: "evidence", title: "Recurring bills", summary: `${bills.length} bills found in the last 12 months`, source: "bank-data", data: { kind: "evidence", filter: evidence, count: bills.length, totalEur: yearlyTotal, largest: [] } }],
  });
}

export function getCashFlow(ctx: ToolContext): ToolOutcome {
  const flow = ctx.cashFlow();
  const recent = flow.cycles.slice(-6);
  const facts: Fact[] = [
    ...(flow.typicalPayday === null ? [] : [fact("cash:payday", "Usual payday (day of month)", flow.typicalPayday, "days", "the usual salary day in the history")]),
    ...(flow.daysToNextPayday === null ? [] : [fact("cash:days-to-payday", "Days to the next payday", flow.daysToNextPayday, "days", `next payday expected on ${flow.nextPayday}`, { source: "calculation" })]),
    ...(flow.projectedLowPointEur === null ? [] : [fact("cash:projected-low", "Expected balance just before payday", flow.projectedLowPointEur, "EUR", "balance minus bills due and average everyday spending until payday", { source: "calculation" })]),
    fact("cash:daily-everyday", "Everyday spending per day", flow.averageDailyEverydayEur, "EUR", "12-month average"),
    fact("cash:negative-months", "Months with a balance below zero", flow.negativeMonths, "count", "last 12 months", { evidence: { from: ctx.overview.windowFrom, to: ctx.overview.windowTo, negativeBalance: true } }),
    ...(flow.firstWeekShare === null ? [] : [fact("cash:first-week-share", "Share of everyday spending in the week after payday", Math.round(flow.firstWeekShare * 100), "percent", `over ${flow.cycles.length} pay cycles`, { source: "calculation" })]),
    ...flow.steps.map((step, index) => fact(`cash:step:${index}`, step.label, step.amount, "EUR", step.basis, { source: "calculation" })),
    ...flow.billsDueBeforePayday.map((bill) => fact(`cash:due:${bill.billId}`, `${bill.label} due ${bill.expectedOn}`, bill.amount, "EUR", "the bill's 12-month average")),
    ...recent.map((cycle) => fact(`cash:low:${cycle.payday}`, `Lowest balance in the cycle from ${cycle.payday}`, cycle.lowestBalance, "EUR", `on ${cycle.lowestOn}`)),
  ];
  const low = flow.projectedLowPointEur;
  return outcome({
    content: JSON.stringify({
      usualPaydayDayOfMonth: flow.typicalPayday,
      nextPaydayExpected: flow.nextPayday,
      daysToNextPayday: flow.daysToNextPayday,
      balanceTodayEur: ctx.overview.balance,
      billsDueBeforePayday: flow.billsDueBeforePayday.map((bill) => ({ name: bill.label, amountEur: bill.amount, expectedOn: bill.expectedOn })),
      everydaySpendingPerDayEur: flow.averageDailyEverydayEur,
      expectedBalanceJustBeforePaydayEur: low,
      shareOfEverydaySpendingInWeekAfterPaydayPct: flow.firstWeekShare === null ? null : Math.round(flow.firstWeekShare * 100),
      monthsBelowZeroInLast12: flow.negativeMonths,
      lastCycles: recent.map((cycle) => ({ payday: cycle.payday, lowestBalanceEur: cycle.lowestBalance, lowestOn: cycle.lowestOn, daysFromPaydayToLowest: cycle.daysToLowest })),
      thisIsAnEstimate: flow.assumptions,
    }),
    summary: low === null ? "No payday found in the data" : `Next payday ${flow.nextPayday}; expected balance just before it €${low.toFixed(2)}`,
    facts,
    stages: [{ kind: "calculation", title: "Balance before the next payday", summary: low === null ? "No payday found" : `About €${low.toFixed(0)} expected on ${flow.nextPayday}`, source: "calculation", data: { kind: "calculation", steps: flow.steps, resultLabel: "Expected balance just before payday", resultValue: low ?? 0, unit: "EUR", assumptions: flow.assumptions } }],
  });
}

export function findPatternsTool(ctx: ToolContext): ToolOutcome {
  const billTypeOf = (billId: string, guess: string): BillType | null => {
    const confirmed = ctx.memory.items.find((item) => item.kind === "bill_name" && item.key === billId);
    if (confirmed) return confirmed.billType;
    return ({ Electricity: "electricity", "Home internet": "internet", "Mobile plan": "mobile" } as Record<string, BillType>)[guess] ?? null;
  };
  const patterns = findPatterns(ctx.overview, ctx.cashFlow(), billTypeOf).slice(0, PATTERNS_SHOWN);
  // If two findings with a euro figure concern different things, their total is worked out here, so the model never adds.
  const withEuros = patterns.filter((p) => p.yearlyImpactEur !== null);
  const second = withEuros.find((p) => p.evidence.category !== withEuros[0]?.evidence.category && p.kind !== withEuros[0]?.kind);
  const combined = withEuros[0] && second ? { yearlyEur: round2((withEuros[0].yearlyImpactEur as number) + (second.yearlyImpactEur as number)), of: [withEuros[0].title, second.title] } : null;
  const combinedFact = combined ? [fact("patterns:top-two", "The two largest separate findings, together per year", combined.yearlyEur, "EUR/year", `${combined.of[0]} plus ${combined.of[1]}`, { source: "calculation" })] : [];
  return outcome({
    content: JSON.stringify({
      rankedBy: "yearly euros, largest first",
      important: "Never add amounts together yourself. If a total helps, use twoLargestTogether, which is already worked out.",
      twoLargestTogether: combined,
      threeBaskets: ctx.overview.baskets.map((basket) => ({ basket: basket.label, perMonthEur: round2(basket.monthlyAvg), shareOfSpendingPct: Math.round(basket.share * 100) })),
      framing: "When they ask where their money goes or what kind of spender they are, start from threeBaskets (which basket is biggest, and how large everyday choices are), then give the largest finding.",
      patterns: patterns.map((p) => ({ id: p.id, what: p.title, detail: p.detail, yearlyEur: p.yearlyImpactEur, confidence: p.confidence, canResearchOffersFor: p.billType, usefulNextTools: p.nextSteps, numbers: factsForModel(p.facts) })),
    }),
    summary: patterns.length ? `${patterns.length} patterns found; top: ${patterns[0].title}` : "No notable pattern found",
    facts: [...patterns.flatMap((p) => p.facts), ...combinedFact, ...basketsVisual(ctx.overview).facts],
    stages: [{ kind: "lead", title: "What Sisu noticed", summary: patterns[0]?.title ?? "Nothing notable", source: "bank-data", data: { kind: "lead", patterns } }],
    visual: basketsVisual(ctx.overview), // advice comes with the picture of where the money really goes: the three baskets
  });
}

export function checkAffordabilityTool(args: Record<string, unknown>, ctx: ToolContext): ToolOutcome {
  // After an approved transfer the money is no longer in the current account, so the answer starts from what is left.
  const accounts = accountsFor(ctx.overview.customerId);
  const current = accounts ? withCurrentAccount(ctx.overview, accounts) : ctx.overview;
  const result = checkAffordability(current, current === ctx.overview ? ctx.cashFlow() : buildCashFlow(current), Number(args.amountEur));
  if (typeof result === "string") return failure("finance", result);
  const what = typeof args.what === "string" ? args.what.slice(0, 60) : "this cost";
  const verdictText = { comfortable: "affordable now with a buffer left", tight: "possible, but it leaves less than a month of must-pay costs before payday", "not-yet": "not affordable now without going below zero before payday" }[result.verdict];
  const facts: Fact[] = [
    fact("afford:amount", `Cost of ${what}`, result.amountEur, "EUR", "the amount asked about", { source: "customer-stated" }),
    fact("afford:balance-after", "Balance straight after paying", result.balanceAfterEur, "EUR", "balance minus the cost", { source: "calculation" }),
    ...(result.projectedLowPointEur === null ? [] : [fact("afford:low", "Expected balance just before payday", result.projectedLowPointEur, "EUR", "after the cost, bills due and usual spending", { source: "calculation" })]),
    fact("afford:buffer", "Months of must-pay costs still covered", result.bufferMonthsAfter, "months", "expected low point divided by monthly must-pay costs", { source: "calculation" }),
    ...(result.monthsToSaveUp === null ? [] : [fact("afford:save-up", "Months of saving needed", result.monthsToSaveUp, "months", "shortfall divided by the average monthly surplus", { source: "calculation" })]),
    ...result.steps.map((step, index) => fact(`afford:step:${index}`, step.label, step.amount, "EUR", step.basis, { source: "calculation" })),
  ];
  return outcome({
    content: JSON.stringify({ what, amountEur: result.amountEur, verdict: result.verdict, verdictMeans: verdictText, balanceStraightAfterEur: result.balanceAfterEur, expectedBalanceJustBeforePaydayEur: result.projectedLowPointEur, monthsOfMustPayCostsStillCovered: result.bufferMonthsAfter, monthsOfSavingNeededFirst: result.monthsToSaveUp, workings: result.steps, thisIsAnEstimate: result.assumptions }),
    summary: `€${result.amountEur.toFixed(0)} for ${what}: ${verdictText}`,
    facts,
    stages: [{ kind: "calculation", title: `Can you afford €${result.amountEur.toFixed(0)}?`, summary: verdictText, source: "calculation", data: { kind: "calculation", steps: result.steps, resultLabel: "Expected balance just before payday", resultValue: result.projectedLowPointEur ?? result.balanceAfterEur, unit: "EUR", assumptions: result.assumptions } }],
  });
}

const DEFAULT_CUT_YEARS = 5; // "how much could I save if I cut X by 20%?" names no horizon

export function runScenarioTool(args: Record<string, unknown>, ctx: ToolContext): ToolOutcome {
  // "Reduce dining out by 20%": the euros come from the category's 12-month average, worked out here. Using one
  // month's figure (a model's first instinct) can be several times off when that month was unusual.
  const cutPct = Number(args.categoryCutPct);
  const cutCategory = typeof args.category === "string" && Number.isFinite(cutPct) && cutPct > 0 && cutPct <= 100 ? categoryAverages(ctx.overview).find((entry) => entry.category === args.category) : undefined;
  if (typeof args.category === "string" && args.categoryCutPct !== undefined && !cutCategory) return failure("finance", `There is no spending in ${args.category} in the last ${ctx.overview.windowMonths} months, or the percentage is not between 1 and 100.`);
  const fromCategory = cutCategory ? round2((cutCategory.monthly * cutPct) / 100) : 0;
  const freed = cutCategory ? fromCategory : Number(args.freedPerMonthEur ?? args.billSavingPerMonth ?? 0);
  const input = cleanInput({ billSavingPerMonth: Number.isFinite(freed) ? freed : 0, everydayCutPct: Number(args.everydayCutPct ?? 0) || 0, years: Number(args.years) || (cutCategory ? DEFAULT_CUT_YEARS : NaN), oneOffEur: typeof args.oneOffEur === "number" ? args.oneOffEur : 0 });
  if (typeof input === "string") return failure("finance", input);
  const result = runScenario(ctx.overview, input);
  const branches = result.branches.map((b) => ({ future: b.label, endTotalEur: b.endTotal, lowEur: b.endLow, highEur: b.endHigh, monthsOfMustPayCostsCoveredAfterYear1: b.runwayMonthsAtYear1 }));
  const end = (id: string) => result.branches.find((b) => b.id === id)?.endTotal ?? 0;
  const gain = round2(end("save") - end("nothing"));
  // What the lump sum itself would be worth at the end, in each scenario: the same growth rule the projection uses.
  const grown = (rate: number): number => round2((input.oneOffEur ?? 0) * (1 + (rate - FUND_FEE) / 12) ** (input.years * 12));
  const lumpBecomes = { middleScenario: grown(RETURN_SCENARIOS.mid), lowScenario: grown(RETURN_SCENARIOS.low), highScenario: grown(RETURN_SCENARIOS.high) };
  const facts: Fact[] = [
    fact("scenario:freed", "Freed per month", result.freedPerMonth, "EUR/month", "bill saving plus the trimmed share of everyday spending", { source: "calculation" }),
    fact("scenario:years", "Years ahead", input.years, "years", "the horizon asked for", { source: "customer-stated" }),
    ...(cutCategory
      ? [
          fact("scenario:category-avg", `${cutCategory.category}, average per month`, cutCategory.monthly, "EUR/month", `average of the last ${ctx.overview.windowMonths} months`, { evidence: { from: ctx.overview.windowFrom, to: ctx.overview.windowTo, category: cutCategory.category } }),
          fact("scenario:category-cut-pct", "Cut asked for", cutPct, "percent", "the percentage the customer named", { source: "customer-stated" }),
          fact("scenario:category-freed", `Cutting ${cutCategory.category} by ${cutPct}% frees, per month`, fromCategory, "EUR/month", `${cutPct}% of the monthly average`, { source: "calculation" }),
          fact("scenario:category-freed-yearly", `Cutting ${cutCategory.category} by ${cutPct}% frees, per year`, round2(fromCategory * 12), "EUR/year", "the monthly figure times 12", { source: "calculation" }),
        ]
      : []),
    fact("scenario:gain", "Extra after the period if the money is kept", gain, "EUR", "'keep the cash' minus 'change nothing'", { source: "calculation" }),
    ...(input.oneOffEur
      ? [
          fact("scenario:one-off", "Lump sum", input.oneOffEur, "EUR", "the amount the customer named", { source: "customer-stated" }),
          fact("scenario:one-off-mid", "Lump sum after the period, middle scenario", lumpBecomes.middleScenario, "EUR", `${RETURN_SCENARIOS.mid * 100}% a year less the fund fee, compounded monthly`, { source: "calculation" }),
          fact("scenario:one-off-low", "Lump sum after the period, low scenario", lumpBecomes.lowScenario, "EUR", `${RETURN_SCENARIOS.low * 100}% a year less the fund fee`, { source: "calculation" }),
          fact("scenario:one-off-high", "Lump sum after the period, high scenario", lumpBecomes.highScenario, "EUR", `${RETURN_SCENARIOS.high * 100}% a year less the fund fee`, { source: "calculation" }),
        ]
      : []),
    ...result.branches.flatMap((b) => [
      fact(`scenario:${b.id}:end`, `${b.label}: total at the end`, b.endTotal, "EUR", "projected from 12-month averages", { source: "calculation" }),
      fact(`scenario:${b.id}:low`, `${b.label}: low case`, b.endLow, "EUR", "1% a year scenario", { source: "calculation" }),
      fact(`scenario:${b.id}:high`, `${b.label}: high case`, b.endHigh, "EUR", "8% a year scenario", { source: "calculation" }),
    ]),
  ];
  // "How long until I have X?": the first month each future reaches the target, searched over the longest horizon.
  const target = typeof args.targetEur === "number" && Number.isFinite(args.targetEur) && args.targetEur > 0 ? round2(args.targetEur) : null;
  const longRun = target === null ? null : runScenario(ctx.overview, { ...input, years: LIMITS.years[1] });
  const reach = (longRun?.branches ?? []).map((b) => ({ future: b.label, id: b.id, monthsToReachTarget: b.points.find((point) => point.total >= (target as number))?.month ?? null }));
  const targetFacts = target === null ? [] : [
    fact("scenario:target", "Target balance", target, "EUR", "the amount the customer named", { source: "customer-stated" }),
    ...reach.flatMap((r) => (r.monthsToReachTarget === null ? [] : [fact(`scenario:${r.id}:months-to-target`, `${r.future}: months to reach the target`, r.monthsToReachTarget, "months", "first month the projected total reaches the target", { source: "calculation" })])),
  ];
  const impact = { monthlyEur: result.freedPerMonth, yearlyEur: round2(result.freedPerMonth * 12), horizonYears: input.years, branches: result.branches.map((b) => ({ id: b.id, label: b.label, endTotal: b.endTotal, endLow: b.endLow, endHigh: b.endHigh })), gainVsNothingEur: gain, summary: `About €${Math.round(gain)} more after ${input.years} years if the freed money is kept.` };
  return outcome({
    content: JSON.stringify({
      input,
      ...(cutCategory
        ? { categoryCut: { category: cutCategory.category, averagePerMonthEur: cutCategory.monthly, cutPct, freesPerMonthEur: fromCategory, freesPerYearEur: round2(fromCategory * 12), basis: `the ${ctx.overview.windowMonths}-month average, not any single month`, say: "Lead with what the cut frees per month and per year, say it is based on their average, then what it adds up to." } }
        : {}),
      freedPerMonthEur: result.freedPerMonth,
      extraAfterPeriodIfKeptEur: gain,
      ...(input.oneOffEur
        ? {
            lumpSumEur: input.oneOffEur,
            lumpSumCouldBecomeEur: lumpBecomes,
            forTheLumpSumSay: `The ${input.oneOffEur} euros could become about ${lumpBecomes.middleScenario} after ${input.years} years, between ${lumpBecomes.lowScenario} and ${lumpBecomes.highScenario}. Left in the account it stays ${input.oneOffEur}. These are scenarios, not forecasts, and investments can lose value. Do not quote the branch totals below for the lump sum: they are the whole account.`,
          }
        : {}),
      branches,
      ...(target === null ? {} : { targetEur: target, timeToReachTarget: reach.map((r) => ({ future: r.future, months: r.monthsToReachTarget ?? `not within ${LIMITS.years[1]} years` })) }),
      assumptions: result.assumptions,
    }),
    summary: target === null ? `€${result.freedPerMonth.toFixed(0)} a month freed, projected over ${input.years} years` : `Target €${target.toFixed(0)}: ${reach[0]?.monthsToReachTarget ?? "not reached"} months if nothing changes`,
    facts: [...facts, ...targetFacts],
    stages: [{ kind: "impact", title: `${input.years} years ahead`, summary: impact.summary, source: "calculation", data: { kind: "impact", impact } }],
    visual: futuresVisual(result, input.years),
  });
}

export function getMortgage(ctx: ToolContext): ToolOutcome {
  const m = mortgageFor(ctx.overview);
  if (!m) return outcome({ content: JSON.stringify({ onRecord: false, say: "There is no mortgage application on record for this customer. Say so; do not estimate one." }), summary: "No mortgage application on record" });
  const facts: Fact[] = [
    fact("mortgage:price", "Property price", m.propertyPriceEur, "EUR", "mortgage application"),
    fact("mortgage:loan", "Loan", m.loanEur, "EUR", "mortgage application"),
    fact("mortgage:own-money", "Own money in the application", m.ownMoneyEur, "EUR", "property price minus the loan"),
    fact("mortgage:collateral", "Collateral value", m.collateralValueEur, "EUR", "bank's valuation in the application"),
    fact("mortgage:ltv", "Loan to value", m.loanToValuePct, "percent", "loan divided by property price"),
    fact("mortgage:required-income", "Monthly income the application required", m.requiredMonthlyIncomeEur, "EUR/month", "mortgage application"),
    fact("mortgage:income", "Your monthly income", m.monthlyIncomeEur, "EUR/month", "12-month average from the bank data"),
    fact("mortgage:income-margin", "Income above what was required", m.incomeMarginEur, "EUR/month", "your income minus the required income", { source: "calculation" }),
    fact("mortgage:still-needed", "Own money not covered by this account", m.ownMoneyStillNeededEur, "EUR", "own money minus this account's balance", { source: "calculation" }),
    ...m.fees.map((fee, index) => fact(`mortgage:fee:${index}`, `Fee: ${fee.type}`, fee.amountEur, "EUR", `recorded on ${fee.on}`)),
  ];
  return outcome({
    content: JSON.stringify({
      onRecord: true,
      decision: m.decision,
      decidedOn: m.decidedOn,
      applicationStartedOn: m.startedOn,
      propertyType: m.propertyType,
      propertyPriceEur: m.propertyPriceEur,
      loanEur: m.loanEur,
      ownMoneyEur: m.ownMoneyEur,
      loanToValuePct: m.loanToValuePct,
      collateralValueEur: m.collateralValueEur,
      requiredMonthlyIncomeEur: m.requiredMonthlyIncomeEur,
      yourMonthlyIncomeEur: m.monthlyIncomeEur,
      incomeAboveRequirementEur: m.incomeMarginEur,
      balanceInThisAccountEur: m.balanceEur,
      ownMoneyNotCoveredByThisAccountEur: m.ownMoneyStillNeededEur,
      feesRecorded: m.fees,
      stepsSoFar: m.timeline.length,
      keepInMind: m.assumptions,
    }),
    summary: `Mortgage application ${m.decision}: €${m.loanEur.toLocaleString("en-US")} loan on a €${m.propertyPriceEur.toLocaleString("en-US")} ${m.propertyType ?? "home"}`,
    facts,
    stages: [{ kind: "calculation", title: `Mortgage application: ${m.decision}`, summary: `Loan €${m.loanEur.toLocaleString("en-US")}, own money €${m.ownMoneyEur.toLocaleString("en-US")}`, source: "bank-data", data: { kind: "calculation", steps: m.steps, resultLabel: "Own money not covered by this account", resultValue: m.ownMoneyStillNeededEur, unit: "EUR", assumptions: m.assumptions } }],
  });
}

export function explainConcept(args: Record<string, unknown>, ctx: ToolContext): ToolOutcome {
  const concept = CONCEPTS.includes(args.concept as ConceptId) ? (args.concept as ConceptId) : null;
  if (!concept) return failure("finance", `explain_concept needs one of: ${CONCEPTS.join(", ")}.`);
  const card = teachingCard(concept, ctx.overview);
  return outcome({
    content: JSON.stringify({
      howToUse: "Explain the idea in one or two sentences, then ask the question (in the customer's language, same meaning) and STOP. You do not know the answer: the app reveals it after the customer guesses, so do not state or hint at any figure.",
      title: card.title,
      idea: card.explanation,
      questionToAsk: card.question,
    }),
    summary: `Lesson: ${card.title}`,
    // The receipts go to the app with the card, not to the model, so they are not offered as numbers it may say.
    facts: [],
    teaching: concept === "three-baskets" ? { ...card, revealVisual: basketsVisual(ctx.overview) } : card,
    stages: [{ kind: "teaching", title: card.title, summary: card.question, source: "bank-data", facts: card.facts, data: { kind: "teaching", card } }],
  });
}
