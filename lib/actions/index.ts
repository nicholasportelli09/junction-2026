// Prepared actions and their approval. The rule this file enforces: nothing is carried out without an explicit
// approval from the user, every step is written to the audit log, and an approved action is carried out only in
// the demo bank (lib/actions/bank.ts): no real money moves and no real contract is signed.
// The agent can PREPARE an action. Only the approve endpoint, called from a button press, can approve one.
import { buildCashFlow } from "@/lib/finance/cashflow";
import { findCustomer } from "@/lib/finance/data";
import { buildOverview } from "@/lib/finance/overview";
import { withAudit } from "@/lib/store/audit";
import { readState, updateState } from "@/lib/store/state";
import type { AccountsView, ActionExecution, ActionStatus, AgentAction, BillType } from "@/lib/types";
import { accountsFrom, carryOut } from "./bank";
import { freedByApprovedSwitches } from "./freed";

const TTL_MS = 30 * 60_000; // offers go stale, so an unanswered action expires and must be prepared again
const MAX_OPEN_PER_CUSTOMER = 5;

export type ActionDraft = Omit<AgentAction, "id" | "customerId" | "status" | "simulated" | "createdAt" | "expiresAt" | "decidedAt" | "impact">;
export type ActionResult = { ok: true; action: AgentAction } | { ok: false; status: 400 | 404 | 409 | 410; reason: string };

const isOpen = (action: AgentAction): boolean => action.status === "awaiting_approval";
const sameAction = (a: AgentAction, draft: ActionDraft): boolean =>
  a.kind === draft.kind && a.billType === draft.billType && a.offer?.provider === draft.offer?.provider && a.offer?.plan === draft.offer?.plan && a.monthlyAmountEur === draft.monthlyAmountEur && a.destination === draft.destination;

// Marks unanswered actions that have passed their time as expired, and logs it.
function expireOld(now: Date): void {
  const overdue = readState().actions.filter((action) => isOpen(action) && action.expiresAt <= now.toISOString());
  if (!overdue.length) return;
  updateState((state) =>
    overdue.reduce(
      (next, old) => withAudit({ ...next, actions: next.actions.map((a) => (a.id === old.id ? { ...a, status: "expired" as ActionStatus, decidedAt: now.toISOString() } : a)) }, { customerId: old.customerId, type: "action_expired", actor: "system", actionId: old.id, detail: `Expired without an answer: ${old.title}` }, now),
      state,
    ),
  );
}

const newestFirst = (a: AgentAction, b: AgentAction): number => (b.decidedAt ?? "").localeCompare(a.decidedAt ?? "");
const approvedFor = (customerId: string): AgentAction[] => readState().actions.filter((action) => action.customerId === customerId && action.status === "executed_simulated").sort(newestFirst);

// The switch this customer has already approved for a bill, if there is one. A bill can be switched once:
// a second switch would be measured against the same old bill, and its saving counted on top of the first.
export function approvedSwitch(customerId: string, billType: BillType | null): AgentAction | null {
  if (!billType) return null;
  return approvedFor(customerId).find((action) => action.kind === "switch_contract" && action.billType === billType) ?? null;
}

export function saveDraft(customerId: string, draft: ActionDraft, now: Date = new Date()): ActionResult {
  if (!findCustomer(customerId)) return { ok: false, status: 404, reason: "We could not find that customer." };
  expireOld(now);
  // Already switched: hand back the approved action, whatever today's cheapest offer is. Callers see its status.
  const switched = draft.kind === "switch_contract" ? approvedSwitch(customerId, draft.billType) : null;
  if (switched) return { ok: true, action: switched };
  const open = readState().actions.filter((action) => action.customerId === customerId && isOpen(action));
  // Asking for the same thing twice returns the action already waiting, so the user never sees duplicates.
  const existing = open.find((action) => sameAction(action, draft));
  if (existing) return { ok: true, action: existing };
  if (open.length >= MAX_OPEN_PER_CUSTOMER) return { ok: false, status: 409, reason: "There are already several actions waiting for your answer. Approve or decline one first." };

  const action: AgentAction = {
    ...draft,
    id: crypto.randomUUID(),
    customerId,
    status: "awaiting_approval",
    simulated: true,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + TTL_MS).toISOString(),
    decidedAt: null,
    impact: null,
  };
  updateState((state) => withAudit({ ...state, actions: [...state.actions, action] }, { customerId, type: "action_prepared", actor: draft.preparedBy, actionId: action.id, detail: `Prepared, awaiting approval: ${action.title}` }, now));
  return { ok: true, action };
}

// For work Sisu repeats on its own, like the money plan run a second time: an identical action the customer has
// already approved is handed back as it is, instead of being set up, approved and counted again. A person who asks
// for the same transfer twice still gets two (use saveDraft).
export function saveDraftOnce(customerId: string, draft: ActionDraft, now: Date = new Date()): ActionResult {
  const approved = approvedFor(customerId).find((action) => sameAction(action, draft));
  return approved ? { ok: true, action: approved } : saveDraft(customerId, draft, now);
}

// Finds an action only if it belongs to this customer. Someone else's action looks exactly like a missing one.
function ownAction(customerId: string, actionId: string): AgentAction | null {
  return readState().actions.find((action) => action.id === actionId && action.customerId === customerId) ?? null;
}

function decide(customerId: string, actionId: string, approve: boolean, impactOf: (action: AgentAction) => AgentAction["impact"], now: Date): ActionResult {
  expireOld(now);
  const action = ownAction(customerId, actionId);
  if (!action) return { ok: false, status: 404, reason: "We could not find that action." };
  if (action.status === "expired") return { ok: false, status: 410, reason: "This action has expired because prices may have changed. Ask Sisu to prepare it again." };
  if (!isOpen(action)) return { ok: false, status: 409, reason: `This action was already ${action.status === "declined" ? "declined" : "approved"}.` };

  if (approve && action.kind === "switch_contract" && approvedSwitch(customerId, action.billType)) {
    return { ok: false, status: 409, reason: "This bill already has an approved simulated switch. Decline this competing offer." };
  }

  // Approving carries the action out in the demo bank (lib/actions/bank.ts): money moves between the customer's
  // accounts there, or the bill changes. The bank can refuse, as a real one would when the money is not there.
  let execution: ActionExecution | null = null;
  const overview = approve ? buildOverview(customerId) : null;
  if (overview) {
    const done = carryOut(action, overview, readState().actions, buildCashFlow(overview).nextPayday, now);
    if (!done.ok) return { ok: false, status: done.status, reason: done.reason };
    execution = done.execution;
  }
  const decided: AgentAction = approve
    ? { ...action, status: "executed_simulated", decidedAt: now.toISOString(), impact: impactOf(action), confirmation: `Done (simulation). Reference SIM-${action.id.slice(0, 8).toUpperCase()}.`, execution }
    : { ...action, status: "declined", decidedAt: now.toISOString() };
  const carried = execution ? `Carried out in the demo bank, no real money moved. ${execution.steps.map((step) => step.detail).join(" ")}` : `Simulated only, nothing was sent or changed: ${action.title}`;

  updateState((state) => {
    const stored = { ...state, actions: state.actions.map((a) => (a.id === action.id ? decided : a)) };
    if (!approve) return withAudit(stored, { customerId, type: "action_declined", actor: "user", actionId, detail: `Declined: ${action.title}` }, now);
    const approved = withAudit(stored, { customerId, type: "action_approved", actor: "user", actionId, detail: `Approved by the user: ${action.title}` }, now);
    return withAudit(approved, { customerId, type: "action_executed_simulated", actor: "system", actionId, detail: carried }, now);
  });
  return { ok: true, action: decided };
}

export function approveAction(customerId: string, actionId: string, impactOf: (action: AgentAction) => AgentAction["impact"], now: Date = new Date()): ActionResult {
  return decide(customerId, actionId, true, impactOf, now);
}

export function declineAction(customerId: string, actionId: string, now: Date = new Date()): ActionResult {
  return decide(customerId, actionId, false, () => null, now);
}

export function listActions(customerId: string, now: Date = new Date()): AgentAction[] {
  expireOld(now);
  return readState()
    .actions.filter((action) => action.customerId === customerId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// Monthly amounts from approved switches. The futures chart and the agent use this as "what has already been freed".
// One switch per bill counts (see ./freed).
// The customer's accounts in the demo bank, as they stand after everything they approved.
export function accountsFor(customerId: string): AccountsView | null {
  const overview = buildOverview(customerId);
  return overview ? accountsFrom(overview, readState().actions) : null;
}

export function approvedMonthlySaving(customerId: string): number {
  return freedByApprovedSwitches(readState().actions.filter((action) => action.customerId === customerId));
}

// Booth reset: removes every action, remembered item and audit entry for the given customers, then logs the reset.
export function resetCustomers(customerIds: string[], now: Date = new Date()): { actions: number; memoryItems: number } {
  const state = readState();
  const actions = state.actions.filter((action) => customerIds.includes(action.customerId)).length;
  const memoryItems = customerIds.reduce((total, id) => total + (state.memory[id]?.items.length ?? 0), 0);
  updateState((current) => {
    const cleared = {
      ...current,
      actions: current.actions.filter((action) => !customerIds.includes(action.customerId)),
      memory: Object.fromEntries(Object.entries(current.memory).filter(([id]) => !customerIds.includes(id))),
      audit: [], // a new chain starts here; the reset itself is its first entry
    };
    return withAudit(cleared, { customerId: "ALL-DEMO", type: "demo_reset", actor: "system", detail: `Demo reset: ${actions} actions and ${memoryItems} remembered items cleared for ${customerIds.length} customers.` }, now);
  });
  return { actions, memoryItems };
}
