// The demo bank: approving an action carries it out. Money moves between the customer's accounts in the ledger,
// a standing order is set up, a bill changes, and Sisu and the screens see the figures as they stand afterwards.
import assert from "node:assert/strict";
import { before, beforeEach, describe, it } from "node:test";
import { AINO, EETU, call, collect, freshState, ofType, scriptedModel } from "./helpers";
import { GET as accountsRoute } from "@/app/api/accounts/route";
import { POST as approveRoute } from "@/app/api/actions/[id]/approve/route";
import { POST as prepareRoute } from "@/app/api/actions/prepare/route";
import { GET as listRoute } from "@/app/api/actions/route";
import { GET as affordabilityRoute } from "@/app/api/coach/affordability/route";
import { POST as resetRoute } from "@/app/api/demo/reset/route";
import { accountsFor, approveAction, declineAction, listActions, saveDraft } from "@/lib/actions";
import { buildTransferDraft, impactOf } from "@/lib/actions/drafts";
import { checkGrounding } from "@/lib/agent/grounding";
import { checkSentence } from "@/lib/agent/guards";
import { setMockScript } from "@/lib/agent/mock";
import { runTurn } from "@/lib/agent/orchestrator";
import { ensureResearch, waitForUsable } from "@/lib/agent/research";
import { buildCashFlow } from "@/lib/finance/cashflow";
import { buildOverview } from "@/lib/finance/overview";
import { auditFor } from "@/lib/store/audit";
import { inSession, newSessionId } from "@/lib/store/session";
import type { AccountsView, ActionList, Affordability, AgentAction } from "@/lib/types";

const eetu = buildOverview(EETU)!;
const balance = eetu.balance;
// What is left in the account after `moved` euros, to the cent (the bank rounds the same way).
const left = (moved: number): number => Math.round((balance - moved) * 100) / 100;
let caller = 0;
const request = (path: string, body?: unknown) =>
  new Request(`http://test.local${path}`, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", "x-forwarded-for": `198.51.100.${++caller % 250}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

function transfer(customerId: string, amountEur: number, options: { once?: boolean; destination?: "savings" | "investments" } = { once: true }): AgentAction {
  const draft = buildTransferDraft(customerId, amountEur, { preparedBy: "user", ...options });
  assert.ok(draft.ok, draft.ok ? "" : draft.reason);
  const saved = saveDraft(customerId, draft.draft);
  assert.ok(saved.ok);
  return saved.action;
}
function approve(customerId: string, action: AgentAction): AgentAction {
  const result = approveAction(customerId, action.id, impactOf);
  assert.ok(result.ok, result.ok ? "" : result.reason);
  return result.action;
}

describe("the demo bank: an approved action is carried out", () => {
  before(async () => {
    for (const city of ["Helsinki", "Espoo"]) await waitForUsable(ensureResearch("electricity", city).key, 3_000);
  });
  beforeEach(() => void freshState());

  it("before anything is approved the accounts are the bank data, untouched", () => {
    const accounts = accountsFor(EETU)!;
    assert.deepEqual(accounts.current, { atBankDataEur: balance, movedOutEur: 0, nowEur: balance });
    assert.deepEqual([accounts.savings.movedInEur, accounts.standingOrders.length, accounts.contracts.length, accounts.movements.length], [0, 0, 0, 0]);
    assert.equal(accounts.simulated, true);
    transfer(EETU, 500); // prepared, not approved
    assert.equal(accountsFor(EETU)!.current.nowEur, balance, "preparing moves nothing");
  });

  it("approving a one-off transfer moves the money, and says what it did", () => {
    const done = approve(EETU, transfer(EETU, 500));
    const moved = done.execution?.transfer;
    assert.deepEqual(moved, { amountEur: 500, to: "savings", currentBeforeEur: balance, currentAfterEur: left(500), toBeforeEur: 0, toAfterEur: 500 });
    assert.equal(done.execution?.bank, "sisu-demo-bank");
    assert.deepEqual(done.execution?.steps.map((step) => step.label), ["Checked the account", "Moved the money", "Your accounts now"]);
    assert.match(done.execution!.steps[1].detail, /€500\.00 from your current account to savings/);
    assert.equal(done.status, "executed_simulated");
    assert.equal(done.simulated, true, "it is still labelled a simulation: no real money moved");
    assert.match(done.confirmation ?? "", /^Done \(simulation\)\. Reference SIM-[0-9A-F]{8}\.$/);
    assert.equal(done.execution?.reference, done.confirmation!.match(/SIM-[0-9A-F]{8}/)![0]);

    const accounts = accountsFor(EETU)!;
    assert.deepEqual(accounts.current, { atBankDataEur: balance, movedOutEur: 500, nowEur: left(500) });
    assert.equal(accounts.savings.movedInEur, 500);
    assert.equal(accounts.movements[0].reference, done.execution?.reference);

    const audit = auditFor(EETU);
    assert.ok(audit.chainValid);
    const last = audit.events[audit.events.length - 1];
    assert.equal(last.type, "action_executed_simulated");
    assert.match(last.detail, /Carried out in the demo bank, no real money moved\..*€500\.00 from your current account to savings/);
  });

  it("transfers add up, and the bank refuses one the account can no longer cover", () => {
    approve(EETU, transfer(EETU, 1_000));
    const second = approve(EETU, transfer(EETU, 2_000, { once: true, destination: "investments" }));
    assert.deepEqual([second.execution?.transfer?.currentBeforeEur, second.execution?.transfer?.currentAfterEur], [left(1_000), left(3_000)]);
    const accounts = accountsFor(EETU)!;
    assert.deepEqual([accounts.current.movedOutEur, accounts.savings.movedInEur, accounts.investments.movedInEur], [3_000, 1_000, 2_000]);
    assert.deepEqual(accounts.movements.map((m) => m.amountEur), [2_000, 1_000], "newest first");

    // Two transfers prepared while the money was still there; the second approval comes after the first has taken it.
    const [a, b] = [transfer(EETU, 700), transfer(EETU, 600)];
    approve(EETU, a);
    const refused = approveAction(EETU, b.id, impactOf);
    assert.ok(!refused.ok && refused.status === 409);
    assert.match(refused.ok ? "" : refused.reason, /Only €483\.34 is left in the account .* so €600\.00 cannot be moved\. Nothing was done\./);
    assert.equal(listActions(EETU).find((action) => action.id === b.id)?.status, "awaiting_approval", "the refused transfer is still waiting, not marked done");
    assert.equal(accountsFor(EETU)!.current.nowEur, left(3_700));
  });

  it("a new transfer is checked against what is left, not against the old bank data", () => {
    approve(EETU, transfer(EETU, 4_000));
    const tooMuch = buildTransferDraft(EETU, 500, { preparedBy: "sisu-agent", once: true });
    assert.ok(!tooMuch.ok && tooMuch.status === 409);
    assert.match(tooMuch.ok ? "" : tooMuch.reason, /€500 is more than the €183 in the account/);
    const fits = buildTransferDraft(EETU, 100, { preparedBy: "sisu-agent", once: true });
    assert.ok(fits.ok);
    const said = fits.draft.facts.find((f) => f.id === "transfer:balance")!;
    assert.equal(said.value, left(4_000));
    assert.match(said.basis, /minus €4,000\.00 moved out by transfers you approved/);
  });

  it("a standing transfer becomes a standing order from the next payday, and moves nothing today", () => {
    const done = approve(AINO, transfer(AINO, 60, { once: false }));
    const payday = buildCashFlow(buildOverview(AINO)!).nextPayday;
    assert.deepEqual(done.execution?.standingOrder, { monthlyEur: 60, to: "savings", firstRunOn: payday });
    assert.equal(done.execution?.transfer, undefined);
    const accounts = accountsFor(AINO)!;
    assert.equal(accounts.current.movedOutEur, 0);
    assert.deepEqual(accounts.standingOrders.map((order) => [order.monthlyEur, order.firstRunOn]), [[60, payday]]);
  });

  it("an approved switch changes the bill, with the order page it was read from", async () => {
    const prepared = await prepareRoute(request("/api/actions/prepare", { customerId: AINO, kind: "switch_contract", billType: "electricity" }));
    assert.equal(prepared.status, 201);
    const action = ((await prepared.json()) as { action: AgentAction }).action;
    const response = await approveRoute(request(`/api/actions/${action.id}/approve`, { customerId: AINO, confirm: true }), params(action.id));
    assert.equal(response.status, 200);
    const done = ((await response.json()) as { action: AgentAction }).action;
    const contract = done.execution?.contract;
    assert.ok(contract);
    assert.equal(contract.provider, action.offer?.provider);
    assert.equal(contract.monthlyAfterEur, action.offer?.estimatedMonthlyCostEur);
    assert.equal(Math.round((contract.monthlyBeforeEur - contract.monthlyAfterEur) * 100) / 100, action.monthlyAmountEur, "the bill falls by exactly the saving that was approved");
    assert.equal(contract.orderUrl, action.offer?.sourceUrl);
    assert.deepEqual(done.execution?.steps.map((step) => step.label).slice(0, 2), ["Checked the offer", "Placed the order"]);
    const accounts = accountsFor(AINO)!;
    assert.deepEqual(accounts.contracts.map((c) => [c.billType, c.provider, c.monthlyAfterEur]), [["electricity", contract.provider, contract.monthlyAfterEur]]);
    assert.equal(accounts.current.movedOutEur, 0, "a switch moves no money");
  });

  it("declining does nothing in the bank", () => {
    const action = transfer(EETU, 500);
    const declined = declineAction(EETU, action.id);
    assert.ok(declined.ok && declined.action.status === "declined" && !declined.action.execution);
    assert.equal(accountsFor(EETU)!.current.nowEur, balance);
  });

  it("can I afford it starts from what is left in the account", async () => {
    const amount = 1_500;
    const askRoute = async () => (await (await affordabilityRoute(request(`/api/coach/affordability?customerId=${EETU}&amountEur=${amount}`))).json()) as Affordability;
    const before = await askRoute();
    approve(EETU, transfer(EETU, 3_000));
    const after = await askRoute();
    assert.equal(before.balanceAfterEur, left(amount));
    assert.equal(after.balanceAfterEur, left(3_000 + amount));
    assert.match(after.steps[0].basis, /minus €3,000\.00 moved out by transfers you approved/);
    assert.notEqual(after.verdict, before.verdict, "the answer changes once the money has been moved");
  });

  it("the accounts endpoint shows it, each visitor has their own, and start over clears it", async () => {
    const [anna, ben] = [newSessionId(), newSessionId()];
    const visit = (session: string, path: string, body?: unknown) =>
      new Request(`http://test.local${path}`, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", "x-sisu-session": session, "x-forwarded-for": `198.51.100.${++caller % 250}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    inSession(anna, () => approve(EETU, transfer(EETU, 250)));
    const hers = (await (await accountsRoute(visit(anna, `/api/accounts?customerId=${EETU}`))).json()) as AccountsView;
    const his = (await (await accountsRoute(visit(ben, `/api/accounts?customerId=${EETU}`))).json()) as AccountsView;
    assert.deepEqual([hers.current.nowEur, hers.savings.movedInEur, his.current.nowEur], [left(250), 250, balance]);
    assert.ok(hers.facts.some((f) => f.id === "accounts:current" && f.value === left(250)));
    assert.equal((await accountsRoute(visit(anna, "/api/accounts?customerId=nope"))).status, 400);

    const listed = (await (await listRoute(visit(anna, `/api/actions?customerId=${EETU}`))).json()) as ActionList;
    assert.equal(listed.actions[0].execution?.transfer?.currentAfterEur, left(250), "the action list carries the record too");

    assert.equal((await resetRoute(visit(anna, "/api/demo/reset", {}))).status, 200);
    const cleared = (await (await accountsRoute(visit(anna, `/api/accounts?customerId=${EETU}`))).json()) as AccountsView;
    assert.deepEqual(cleared.current, { atBankDataEur: balance, movedOutEur: 0, nowEur: balance });
  });

  it("Sisu is told the balances as they stand, and may say them", async () => {
    approve(EETU, transfer(EETU, 500));
    const now = left(500);
    const model = scriptedModel([`Your current account holds ${now.toFixed(2)} euros now, after 500 euros went to savings in the demo bank.`]);
    setMockScript(model.script);
    const events = await collect(runTurn({ customerId: EETU, text: "What is my balance now?", mode: "text" }));
    setMockScript(null);

    const system = String(model.seen[0].messages[0].content);
    assert.match(system, /ACCOUNTS NOW, IN THE DEMO BANK/);
    assert.ok(system.includes(`Current account: ${now.toFixed(2)} euros now. The bank data of ${eetu.dataTimestamp} said ${balance.toFixed(2)} euros; 500.00 euros was moved out`));
    assert.match(system, /carried out in the demo bank \(a simulation: no real money moved\)/);

    const done = ofType(events, "done")[0];
    assert.ok(done.text.includes(now.toFixed(2)), "the answer kept the new balance");
    const grounding = ofType(events, "grounding")[0];
    assert.deepEqual(grounding.grounding.unverified, [], "the new balance has a receipt");
    assert.ok(grounding.facts.some((f) => f.id === "accounts:current" && f.value === now));

    const receipts = accountsFor(EETU)!.facts;
    assert.deepEqual(checkGrounding(`You moved 500 euros to savings and ${now.toFixed(2)} euros is left.`, receipts, [], []).unverified, []);
  });

  it("Sisu may say what it did once it is done, and may not call it waiting", () => {
    const base = { toolsCalledThisTurn: 0, actionPreparedThisTurn: false, unsourced: [], saidSoFar: "" };
    const none = { switches: false, transfers: false };
    const transferDone = { ...base, earlierActions: { switches: false, transfers: true, waiting: none, done: { switches: false, transfers: true } } };
    const transferWaiting = { ...base, earlierActions: { switches: false, transfers: true, waiting: { switches: false, transfers: true }, done: none } };

    // Reporting on what was carried out is true, as long as the customer is asking about it.
    assert.equal(checkSentence("I moved 2500 euros to your savings.", { ...transferDone, askedToAct: false }), null);
    // Asked to move more, the same sentence is a claim: the tool has to be called.
    assert.equal(checkSentence("I moved 2000 euros to your savings.", { ...transferDone, askedToAct: true })?.kind, "claimed-without-doing");
    // Nothing is waiting once it has been approved.
    const wrong = checkSentence("I moved 2500 euros to your savings, and it is waiting for your tap to approve.", { ...transferDone, askedToAct: false });
    assert.equal(wrong?.kind, "wrong-status");
    assert.equal(wrong?.forceTool, false, "it must not set the same thing up again");
    // While it really is waiting, saying so is fine.
    assert.equal(checkSentence("The transfer to savings is waiting for your tap on Approve.", { ...transferWaiting, askedToAct: false }), null);
    // And with nothing set up at all, the old rule still holds.
    assert.equal(checkSentence("It is waiting for your approval.", { ...base, earlierActions: { ...none, waiting: none, done: none }, askedToAct: false })?.kind, "claimed-without-doing");
  });

  it("when nothing has been approved the prompt does not mention the demo bank's accounts", async () => {
    const model = scriptedModel(["Hello."]);
    setMockScript(model.script);
    await collect(runTurn({ customerId: EETU, text: "Hi", mode: "text" }));
    setMockScript(null);
    assert.doesNotMatch(String(model.seen[0].messages[0].content), /ACCOUNTS NOW/);
  });

  it("the money plan still approves in one go, and each action is carried out", async () => {
    const actions = [transfer(AINO, 20, { once: false }), transfer(AINO, 30, { once: true })];
    for (const action of actions) approve(AINO, action);
    const accounts = accountsFor(AINO)!;
    assert.deepEqual([accounts.standingOrders.length, accounts.movements.length, accounts.current.movedOutEur], [1, 1, 30]);
    void call; // helper kept for parity with the other suites
  });
});
