// Sisu's demo bank: where an approved action is carried out.
//
// The bank data in this demo is a dated copy, and there is no real account behind it. So that approving something
// still DOES something, approved actions are carried out here: a one-off transfer moves money out of the current
// account into savings, a standing transfer becomes a standing order from the next payday, and a contract switch
// replaces the bill's price. The ledger is not a separate table: it is the approved actions themselves, each with
// the record of what was done (`action.execution`), kept with the visitor's state. Reading the ledger is adding
// those records up.
//
// What a real bank needs to take this place: `carryOut` returning the same record after calling its payment API.
// Nothing here moves real money, and the approval rule is unchanged: only the customer's tap on Approve gets here.
import { fact } from "@/lib/finance/facts";
import { round2 } from "@/lib/finance/math";
import type { AccountsView, ActionExecution, AgentAction, Overview } from "@/lib/types";

const BANK = "sisu-demo-bank" as const;
const NOTE = "A demo bank: these balances show what your approved actions did. No real money moved and no contract was signed.";

const euro = (value: number): string => `€${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const host = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};
const carriedOut = (actions: AgentAction[], customerId: string): AgentAction[] =>
  actions.filter((action) => action.customerId === customerId && action.status === "executed_simulated" && !!action.execution).sort((a, b) => (a.execution!.at < b.execution!.at ? -1 : 1));

// The accounts as they stand: the bank data's balance, then every approved action in the order it was carried out.
export function accountsFrom(overview: Overview, actions: AgentAction[]): AccountsView {
  const done = carriedOut(actions, overview.customerId);
  const transfers = done.filter((action) => action.execution?.transfer);
  const moved = (to: "savings" | "investments") => round2(transfers.filter((a) => a.execution!.transfer!.to === to).reduce((sum, a) => sum + a.execution!.transfer!.amountEur, 0));
  const savings = moved("savings");
  const investments = moved("investments");
  const movedOut = round2(savings + investments);
  const now = round2(overview.balance - movedOut);
  const standingOrders = done.filter((a) => a.execution?.standingOrder).map((a) => ({ actionId: a.id, ...a.execution!.standingOrder!, reference: a.execution!.reference }));
  // One contract per bill: the newest switch is the one in force.
  const newestSwitch = new Map<string, AgentAction>();
  for (const action of done) if (action.execution?.contract) newestSwitch.set(action.execution.contract.billType, action);
  const contracts = [...newestSwitch.values()].map((a) => {
    const { billType, provider, plan, monthlyBeforeEur, monthlyAfterEur } = a.execution!.contract!;
    return { actionId: a.id, billType, provider, plan, monthlyBeforeEur, monthlyAfterEur, reference: a.execution!.reference };
  });
  const standingMonthly = round2(standingOrders.reduce((sum, order) => sum + order.monthlyEur, 0));
  const basis = `bank data of ${overview.dataTimestamp}, then the transfers you approved in the demo bank`;
  return {
    customerId: overview.customerId,
    bank: BANK,
    simulated: true,
    bankDataDate: overview.dataTimestamp,
    current: { atBankDataEur: overview.balance, movedOutEur: movedOut, nowEur: now },
    savings: { movedInEur: savings },
    investments: { movedInEur: investments },
    standingOrders,
    contracts,
    movements: [...transfers].reverse().map((a) => ({ actionId: a.id, at: a.execution!.at, amountEur: a.execution!.transfer!.amountEur, to: a.execution!.transfer!.to, currentAfterEur: a.execution!.transfer!.currentAfterEur, reference: a.execution!.reference })),
    facts: [
      fact("accounts:current", "Current account now", now, "EUR", movedOut > 0 ? basis : `account balance on ${overview.dataTimestamp}`, { source: movedOut > 0 ? "calculation" : undefined }),
      ...(movedOut > 0 ? [fact("accounts:moved-out", "Moved out of the current account", movedOut, "EUR", "the one-off transfers you approved", { source: "calculation" })] : []),
      ...(savings > 0 ? [fact("accounts:savings", "Moved to savings", savings, "EUR", "the one-off transfers to savings you approved", { source: "calculation" })] : []),
      ...(investments > 0 ? [fact("accounts:investments", "Moved to your investment account", investments, "EUR", "the one-off transfers to investments you approved", { source: "calculation" })] : []),
      ...(standingMonthly > 0 ? [fact("accounts:standing", "Standing orders each payday", standingMonthly, "EUR/month", "the standing transfers you approved", { source: "calculation" })] : []),
      ...contracts.flatMap((c) => [
        fact(`accounts:contract:${c.billType}:before`, `${c.billType} bill before the switch`, c.monthlyBeforeEur, "EUR/month", "your bill when the switch was approved", { source: "calculation" }),
        fact(`accounts:contract:${c.billType}:after`, `${c.billType} bill with ${c.provider}`, c.monthlyAfterEur, "EUR/month", "the offer you approved", { source: "calculation" }),
      ]),
    ],
    note: NOTE,
  };
}

// The overview as the current account stands now. Use it where "the balance" means money that can be spent or
// moved today (can I afford this, how much can be moved). The futures and the buffer keep the bank data's figure:
// money moved to savings is still the customer's money.
export function withCurrentAccount(overview: Overview, accounts: AccountsView): Overview {
  if (accounts.current.movedOutEur === 0) return overview;
  return { ...overview, balance: accounts.current.nowEur, balanceBasis: `account balance on ${overview.dataTimestamp} minus ${euro(accounts.current.movedOutEur)} moved out by transfers you approved` };
}

export type CarriedOut = { ok: true; execution: ActionExecution } | { ok: false; status: 409; reason: string };

// Carries an approved action out in the demo bank and says exactly what was done.
// `actions` is every action of the visitor as it stands before this one is approved.
export function carryOut(action: AgentAction, overview: Overview, actions: AgentAction[], nextPayday: string | null, now: Date): CarriedOut {
  const reference = `SIM-${action.id.slice(0, 8).toUpperCase()}`;
  const at = now.toISOString();
  const before = accountsFrom(overview, actions);
  const amount = round2(action.monthlyAmountEur);
  const to = action.destination ?? "savings";
  const where = to === "investments" ? "your investment account" : "savings";

  if (action.kind === "one_off_transfer") {
    if (amount > before.current.nowEur) {
      return { ok: false, status: 409, reason: `Only ${euro(Math.max(before.current.nowEur, 0))} is left in the account after the transfers you already approved, so ${euro(amount)} cannot be moved. Nothing was done.` };
    }
    const toBefore = to === "investments" ? before.investments.movedInEur : before.savings.movedInEur;
    const transfer = { amountEur: amount, to, currentBeforeEur: before.current.nowEur, currentAfterEur: round2(before.current.nowEur - amount), toBeforeEur: toBefore, toAfterEur: round2(toBefore + amount) };
    return {
      ok: true,
      execution: {
        bank: BANK,
        reference,
        at,
        transfer,
        steps: [
          { label: "Checked the account", detail: `${euro(transfer.currentBeforeEur)} was available.` },
          { label: "Moved the money", detail: `${euro(amount)} from your current account to ${where}.` },
          { label: "Your accounts now", detail: `Current account ${euro(transfer.currentAfterEur)}. Moved to ${where} through Sisu: ${euro(transfer.toAfterEur)}.` },
        ],
      },
    };
  }

  if (action.kind === "standing_transfer") {
    return {
      ok: true,
      execution: {
        bank: BANK,
        reference,
        at,
        standingOrder: { monthlyEur: amount, to, firstRunOn: nextPayday },
        steps: [
          { label: "Set up a standing order", detail: `${euro(amount)} a month from your current account to ${where}.` },
          { label: "First run", detail: nextPayday ? `On your next payday, ${nextPayday}, before everyday spending starts. Nothing moves today.` : "On your next payday. Nothing moves today." },
        ],
      },
    };
  }

  const offer = action.offer;
  if (!offer || !action.billType) return { ok: false, status: 409, reason: "This switch has no offer attached, so it cannot be carried out. Ask Sisu to prepare it again." };
  const monthlyAfter = round2(offer.estimatedMonthlyCostEur ?? 0);
  const contract = { billType: action.billType, provider: offer.provider, plan: offer.plan, monthlyBeforeEur: round2(monthlyAfter + amount), monthlyAfterEur: monthlyAfter, orderUrl: offer.sourceUrl || null };
  const read = action.sources.find((source) => source.url === offer.sourceUrl) ?? action.sources[0];
  return {
    ok: true,
    execution: {
      bank: BANK,
      reference,
      at,
      contract,
      steps: [
        { label: "Checked the offer", detail: `${[offer.provider, offer.plan].filter(Boolean).join(", ")} at ${euro(monthlyAfter)} a month${read ? `, as read on ${host(read.url)}` : ""}.` },
        { label: "Placed the order", detail: `With ${offer.provider}, in the demo bank. Reference ${reference}.` },
        ...(action.draftMessage ? [{ label: "Notice to your current provider", detail: "The message Sisu drafted was filed with the order." }] : []),
        { label: "Your bill", detail: `${euro(contract.monthlyBeforeEur)} a month becomes ${euro(contract.monthlyAfterEur)}, ${euro(amount)} less each month.` },
      ],
    },
  };
}
