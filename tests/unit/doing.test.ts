import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { AINO, SANNA, call, collect, freshState, ofType, scriptedModel } from "./helpers";
import { approveAction, saveDraft } from "@/lib/actions";
import { buildTransferDraft, impactOf } from "@/lib/actions/drafts";
import { asksForAdvice, asksToMoveMoney, checkSentence, isMetaTalk, withoutMetaTalk } from "@/lib/agent/guards";
import { setMockScript } from "@/lib/agent/mock";
import { runTurn } from "@/lib/agent/orchestrator";
import { buildSystemPrompt, customerSummary } from "@/lib/agent/prompt";
import { calculate, evaluate } from "@/lib/agent/tools/calc";
import { buildCashFlow } from "@/lib/finance/cashflow";
import { buildOverview } from "@/lib/finance/overview";
import { savingRoom } from "@/lib/finance/saving";
import { cleanInput, runScenario } from "@/lib/finance/scenario";
import { getMemory } from "@/lib/memory";
import type { ScenarioInput } from "@/lib/types";

const aino = buildOverview(AINO)!;
const sanna = buildOverview(SANNA)!;
const quiet = { toolsCalledThisTurn: 1, actionPreparedThisTurn: false, earlierActions: { switches: false, transfers: false }, unsourced: [], saidSoFar: "" };

describe("guards: what counts as describing instead of doing", () => {
  it("catches a claim that something was set up when nothing was", () => {
    for (const claim of ["I've set up a one-off transfer of 500 euros.", "I have prepared the switch for you.", "I just moved 200 euros to your savings.", "It's waiting for you to tap Approve.", "I transferred the money."]) assert.equal(checkSentence(claim, quiet)?.kind, "claimed-without-doing", claim);
  });

  it("lets the same sentence through once the action really exists", () => {
    assert.equal(checkSentence("I've set up a one-off transfer of 500 euros.", { ...quiet, actionPreparedThisTurn: true }), null);
    const hasTransfer = { ...quiet, earlierActions: { switches: false, transfers: true } };
    assert.equal(checkSentence("I set that up earlier and it is waiting for your approval.", hasTransfer), null);
    assert.equal(checkSentence("Your transfer of 500 euros is waiting for your tap on Approve.", hasTransfer), null);
    // Regression: live evaluation, 14 Nov. An older transfer existed, so "I've set up the switch" slipped through with no switch set up.
    assert.equal(checkSentence("I've set up the switch for you to approve with one tap.", hasTransfer)?.kind, "claimed-without-doing");
    assert.equal(checkSentence("I've set up a transfer of 200 euros to your savings.", hasTransfer)?.kind, "claimed-without-doing");
    assert.equal(checkSentence("The switch is waiting for your approval.", hasTransfer)?.kind, "claimed-without-doing");
  });

  it("catches an announcement before any tool has run, but not an offer or a 'let me know'", () => {
    const fresh = { ...quiet, toolsCalledThisTurn: 0 };
    for (const announcement of ["Let me scan your full history for what stands out.", "I'll look up current rents in Helsinki.", "I am going to check your bills now."]) assert.equal(checkSentence(announcement, fresh)?.kind, "announced-without-doing", announcement);
    for (const fine of ["Would you like me to look up current water prices?", "Let me know if you want to change the amount.", "You can safely spend 164 euros this week.", "I can set up a transfer once you tell me the amount."]) assert.equal(checkSentence(fine, fresh), null, fine);
    assert.equal(checkSentence("Let me check one more thing for you.", quiet), null); // tools already ran this turn
  });

  // Regression: replay, 14 Nov. "I can't see your rent, but I can search for typical rents. Would you like me to look that up?"
  it("catches declining and then asking permission, or asking the customer for figures, when it could just look it up", () => {
    const fresh = { ...quiet, toolsCalledThisTurn: 0 };
    assert.equal(checkSentence("Would you like me to look that up?", { ...fresh, saidSoFar: "I can't see your rent from your bank data, but I can search for typical rents in Helsinki." })?.kind, "offered-instead-of-doing");
    assert.equal(checkSentence("I can't see your rent, but I can search for typical rents in Helsinki to compare with.", fresh)?.kind, "offered-instead-of-doing");
    assert.equal(checkSentence("If you tell me how many showers you take a week and your water price, I can work out the yearly saving.", { ...fresh, saidSoFar: "I can't see your water bill." })?.kind, "offered-instead-of-doing");
    // An ordinary follow-up suggestion after a real answer is fine.
    assert.equal(checkSentence("Would you like me to look for a cheaper mobile plan?", { ...fresh, saidSoFar: "You can safely spend 164 euros this week." }), null);
    // And so is a plain "I cannot see that" about the customer's own data.
    assert.equal(checkSentence("I cannot see your credit score in the bank data.", fresh), null);
  });

  // Regression: replay, 14 Nov. "I searched for average rent in Helsinki." No search had been made.
  it("catches a claim to have searched or checked when no tool ran in this reply", () => {
    const fresh = { ...quiet, toolsCalledThisTurn: 0 };
    for (const claim of ["I searched for average rent in Helsinki.", "I looked that up for you.", "I've checked your bills.", "I went through your last twelve months.", "I calculated the yearly saving."]) assert.equal(checkSentence(claim, fresh)?.kind, "claimed-without-doing", claim);
    assert.equal(checkSentence("I searched for average rent in Helsinki.", quiet), null); // a tool did run
    assert.equal(checkSentence("Your housing payment is 662 euros a month.", fresh), null);
  });

  it("recognises a request to move money with an amount, and tells it apart from a what-if", () => {
    for (const request of ["Yes. So I will need to transfer 500 euros to my savings account.", "Uh, can you invest my 1,000 that I got for Christmas?", "Move 200 to savings please", "put 50 euros into my investment account every month"]) assert.ok(asksToMoveMoney(request), request);
    for (const other of ["What if I invest 100 euros a month for five years?", "How much would I have if I save 50 euros a month?", "Can I afford a 300 euro phone repair?", "Are you able to make saving transfers for me?", "Should I invest my 1,000 or keep it?", "Transfer my savings somewhere better"]) assert.ok(!asksToMoveMoney(other), other);
  });

  // Regression: 14 Nov, on screen. The sum used 4.5 euros per cubic metre, the answer said "4.5 cents per litre".
  it("reads a thousands comma as thousands and a decimal comma as a decimal, and says how to write a sum", () => {
    assert.equal(evaluate("13,140 / 1000 * 4,5"), 59.13);
    assert.equal(evaluate("1,000,000 / 4"), 250000);
    assert.equal(evaluate("€ 12,5 * 2"), 25);
    assert.throws(() => evaluate("3 min * 8 litres"), /Put units and names in `figures`/);
  });

  it("calculate carries each figure's unit and source through to the model and the screen", () => {
    const outcome = calculate({ expression: "3 * 12 * 365 / 1000 * 4.5", what: "yearly saving", unit: "EUR/year", figures: "3 minutes less (customer); 12 litres a minute (typical shower); 365 showers a year (assumed); 1000 litres in a cubic metre; 4.5 euros per cubic metre (from hsy.fi)" }, {} as never, "c1");
    const content = JSON.parse(outcome.content);
    assert.equal(content.result, 59.13);
    assert.equal(content.figuresUsed.length, 5);
    assert.match(content.figuresUsed[4], /4\.5 euros per cubic metre/);
    assert.match(outcome.summary, /Using: 3 minutes less/);
  });

  // Regression: live evaluation, 14 Nov. After a guard note the model answered the note out loud, in English, in a Finnish answer.
  it("drops a sentence the model addressed to the app instead of the customer", () => {
    const leaked = "Voit käyttää tällä viikolla 164,09 euroa. The customer asked how much they can spend this week, and I already answered 164,09 euros from their bank data. There is no 1.87 anywhere in that data, and I have not said it.";
    assert.equal(withoutMetaTalk(leaked), "Voit käyttää tällä viikolla 164,09 euroa.");
    assert.ok(!isMetaTalk("You can safely spend 164.09 euros this week. Would you like me to move some to savings?"));
    assert.ok(!isMetaTalk("I've set up a transfer of 500 euros, waiting for your tap on Approve."));
  });

  it("recognises an open request for advice, but not a request to be told what to buy", () => {
    for (const request of ["It's important that you are able to give me advice on what I have to do with my money based on all of my data.", "Where does my money go?", "How can I save more?", "What should I do?", "Any recommendations?"]) assert.ok(asksForAdvice(request), request);
    for (const other of ["How much can I spend this week?", "Give me investment advice.", "Which stock should I buy?", "Find me a cheaper electricity deal."]) assert.ok(!asksForAdvice(other), other);
  });

  it("catches a number with no source and tells the model which tools give figures", () => {
    const trip = checkSentence("That adds up to about 4,600 euros.", { ...quiet, unsourced: [4600] });
    assert.equal(trip?.kind, "unsourced-number");
    assert.match(trip?.nudge ?? "", /calculate for arithmetic, run_scenario for projections, or web_search/);
    assert.equal(trip?.forceTool, false);
  });
});

describe("calculator: the model writes the sum, code works it out", () => {
  it("handles the four operations, brackets, precedence and decimals", () => {
    assert.equal(evaluate("3 * 12 * 365 / 1000"), 13.14);
    assert.equal(evaluate("(661.70 - 600) * 12"), 740.4000000000005);
    assert.equal(evaluate("2 + 3 * 4"), 14);
    assert.equal(evaluate("-(2 + 3) * 4"), -20);
    assert.equal(evaluate("36 × 365 ÷ 1000"), 13.14);
    assert.equal(evaluate("0,5 * 10"), 5);
  });

  it("refuses anything that is not plain arithmetic", () => {
    for (const bad of ["", "process.exit(1)", "2 ** 8", "1/0", "(2+3", "2 +", "alert(1)", "1e9", "x * 2", "9".repeat(200)]) assert.throws(() => evaluate(bad), Error, bad);
  });

  it("as a tool it returns a receipt, so its result can be said and verified", async () => {
    freshState();
    const { script } = scriptedModel([[call("calculate", { expression: "3 * 12 * 365 / 1000", what: "cubic metres of water a year", unit: "count" })], "That is about 13.14 cubic metres a year, as an estimate."]);
    setMockScript(script);
    const events = await collect(runTurn({ customerId: AINO, text: "How much water would a shorter shower save?", mode: "text" }));
    setMockScript(null);
    assert.equal(ofType(events, "tool_end")[0].trace.ok, true);
    assert.equal(ofType(events, "grounding")[0].grounding.ok, true);
    assert.equal(ofType(events, "stage")[0].stage.kind, "calculation");
    assert.match(ofType(events, "tool_start")[0].label ?? "", /Calculating cubic metres of water a year/);
  });
});

describe("room to save: worked out from the customer's own numbers", () => {
  it("a one-off amount keeps a week of everyday spending in hand, and nothing is offered that is not there", () => {
    for (const overview of [aino, sanna]) {
      const flow = buildCashFlow(overview);
      const room = savingRoom(overview, flow);
      assert.ok(room.nowEur >= 0 && room.perMonthEur >= 0);
      assert.equal(room.nowEur % 10, 0);
      assert.ok(room.nowEur <= Math.max((flow.projectedLowPointEur ?? 0) - room.cushionEur, 0));
      assert.ok(room.perMonthEur <= Math.max(overview.safeToSpend.gapPerMonth, 0));
    }
    assert.equal(savingRoom(aino, buildCashFlow(aino)).perMonthEur, 0); // Aino's average month leaves nothing over
    assert.ok(savingRoom(sanna, buildCashFlow(sanna)).nowEur > 10_000);
  });

  it("the summary shows the working behind safe to spend, and the room to save", () => {
    const summary = JSON.parse(customerSummary(aino, "Helsinki")) as { howSafeToSpendIsWorkedOut: string[]; roomToSave: { couldMoveTodayEur: number; couldMoveEveryMonthEur: number } };
    assert.equal(summary.howSafeToSpendIsWorkedOut.length, 6);
    assert.match(summary.howSafeToSpendIsWorkedOut[0], /Money in per month: 1783\.33/);
    assert.match(summary.howSafeToSpendIsWorkedOut.at(-1) ?? "", /164\.09 per week/);
    assert.deepEqual(Object.keys(summary.roomToSave), ["couldMoveTodayEur", "couldMoveEveryMonthEur", "basis"]);
  });
});

describe("transfers: once or monthly, to savings or investments, with honest warnings", () => {
  beforeEach(() => void freshState());

  it("a one-off transfer that would leave the account short is still set up, with a warning and the safer amount", () => {
    const built = buildTransferDraft(AINO, 500, { preparedBy: "sisu-agent", once: true });
    assert.ok(built.ok);
    assert.equal(built.draft.kind, "one_off_transfer");
    assert.equal(built.draft.title, "Move €500 to savings now");
    assert.match(built.draft.warning ?? "", /below zero just before payday on 2026-10-15\. About €\d+ could be moved today without that\./);
  });

  it("a one-off transfer that fits carries no warning", () => {
    const built = buildTransferDraft(SANNA, 500, { preparedBy: "sisu-agent", once: true });
    assert.ok(built.ok && built.draft.warning === null);
  });

  it("more than the balance cannot be moved at all", () => {
    const built = buildTransferDraft(AINO, 5_000, { preparedBy: "sisu-agent", once: true });
    assert.ok(!built.ok && /more than the €1220 in the account/.test(built.reason));
  });

  it("a monthly transfer above what a month leaves over says by how much spending would have to fall", () => {
    const built = buildTransferDraft(AINO, 100, { preparedBy: "sisu-agent" });
    assert.ok(built.ok);
    assert.match(built.draft.warning ?? "", /more than the €0 an average month leaves over/);
  });

  it("to investments: Sisu does not pick what to buy, and warns when the buffer is thin", () => {
    const thin = buildTransferDraft(AINO, 100, { preparedBy: "sisu-agent", once: true, destination: "investments" });
    assert.ok(thin.ok);
    assert.equal(thin.draft.title, "Move €100 to your investment account now");
    assert.match(thin.draft.warning ?? "", /A buffer of about three months .* usually comes before investing/);
    assert.ok(thin.draft.checklist.some((line) => /does not pick funds or shares/.test(line)));
    const ready = buildTransferDraft(SANNA, 1_000, { preparedBy: "sisu-agent", once: true, destination: "investments" });
    assert.ok(ready.ok && ready.draft.warning === null);
  });

  it("once approved, an investment transfer shows a range, not a promise, and a confirmation reference", () => {
    const built = buildTransferDraft(SANNA, 1_000, { preparedBy: "sisu-agent", once: true, destination: "investments" });
    assert.ok(built.ok);
    const saved = saveDraft(SANNA, built.draft);
    assert.ok(saved.ok);
    const approved = approveAction(SANNA, saved.action.id, impactOf);
    assert.ok(approved.ok);
    assert.match(approved.action.confirmation ?? "", /^Done \(simulation\)\. Reference SIM-[0-9A-F]{8}\.$/);
    assert.match(approved.action.impact?.summary ?? "", /with a range from €\d+ to €\d+\. It can also lose value\./);
    assert.ok((approved.action.impact?.gainVsNothingEur ?? 0) > 0);
  });

  it("the agent can set up a one-off transfer for an amount the customer said, and one it suggested and they accepted", async () => {
    const first = scriptedModel([[call("prepare_action", { kind: "one_off_transfer", amountEur: 500 })], "Tap Approve to carry it out."]);
    setMockScript(first.script);
    const said = await collect(runTurn({ customerId: SANNA, text: "Transfer 500 euros to my savings account.", mode: "text" }));
    assert.equal(ofType(said, "action")[0].action.kind, "one_off_transfer");

    const second = scriptedModel([[call("prepare_action", { kind: "standing_transfer", amountEur: 60 })], "Tap Approve to carry it out."]);
    setMockScript(second.script);
    const agreed = await collect(runTurn({ customerId: SANNA, text: "Yes, set that up.", mode: "text", history: [{ role: "user", content: "How much could I save each month?" }, { role: "assistant", content: "You could move about 60 euros a month. Shall I set that up?" }] }));
    setMockScript(null);
    assert.equal(ofType(agreed, "action")[0].action.monthlyAmountEur, 60);
  });

  it("the prompt tells Sisu what has already been set up and decided", () => {
    const built = buildTransferDraft(SANNA, 500, { preparedBy: "sisu-agent", once: true });
    assert.ok(built.ok);
    const saved = saveDraft(SANNA, built.draft);
    assert.ok(saved.ok);
    const waiting = buildSystemPrompt({ overview: sanna, city: "Helsinki", mode: "text", memory: getMemory(SANNA), actions: [saved.action] });
    assert.match(waiting, /ACTIONS SO FAR \(newest first\):\n- Move €500 to savings now: set up, waiting for the customer's tap on Approve\./);
    const approved = approveAction(SANNA, saved.action.id, impactOf);
    assert.ok(approved.ok);
    assert.match(buildSystemPrompt({ overview: sanna, city: "Helsinki", mode: "text", memory: getMemory(SANNA), actions: [approved.action] }), /approved by the customer and carried out in the demo bank \(a simulation: no real money moved\)/);
    assert.match(buildSystemPrompt({ overview: sanna, city: "Helsinki", mode: "text", memory: getMemory(SANNA) }), /ACTIONS SO FAR: none\./);
  });
});

describe("scenarios: a lump sum, and money freed from one category", () => {
  it("a lump sum only changes the 'invest it' future, and its range brackets the middle", () => {
    const input = cleanInput({ billSavingPerMonth: 0, everydayCutPct: 0, years: 5, oneOffEur: 1_000 }) as ScenarioInput;
    const result = runScenario(sanna, input);
    const [nothing, save, invest] = result.branches;
    assert.equal(nothing.endTotal, save.endTotal);
    assert.ok(invest.endLow < invest.endTotal && invest.endTotal < invest.endHigh);
    assert.ok(invest.endTotal > nothing.endTotal);
    assert.equal(invest.points[0].invested, 1_000);
    assert.equal(invest.points[0].total, sanna.balance); // moving money does not create money on day one
    assert.ok(result.assumptions.some((line) => /€1000 is moved from the account into investments on day one/.test(line)));
  });

  it("without a lump sum nothing changed for existing callers", () => {
    const before = runScenario(aino, { billSavingPerMonth: 20, everydayCutPct: 10, years: 5 });
    const after = runScenario(aino, { billSavingPerMonth: 20, everydayCutPct: 10, years: 5, oneOffEur: 0 });
    assert.deepEqual(before.branches, after.branches);
  });

  // Regression: the model answered "cutting restaurants" by halving ALL everyday spending (362 euros a month).
  it("the scenario tool takes a monthly figure from a finding, and defaults the percentage cut to none", async () => {
    freshState();
    const { script, seen } = scriptedModel([[call("run_scenario", { freedPerMonthEur: 64, years: 5 })], "Keeping 64 euros a month adds up to about 3,840 euros over 5 years."]);
    setMockScript(script);
    const events = await collect(runTurn({ customerId: AINO, text: "Show me how cutting restaurants would add up.", mode: "text" }));
    setMockScript(null);
    const result = JSON.parse(String(seen.at(-1)!.messages.find((m) => m.role === "tool")!.content)) as { freedPerMonthEur: number; extraAfterPeriodIfKeptEur: number; input: ScenarioInput };
    assert.deepEqual([result.freedPerMonthEur, result.input.everydayCutPct, result.extraAfterPeriodIfKeptEur], [64, 0, 3840]);
    assert.equal(ofType(events, "grounding")[0].grounding.ok, true);
  });
});
