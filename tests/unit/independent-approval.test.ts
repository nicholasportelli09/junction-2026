import assert from "node:assert/strict";
import { it } from "node:test";
import { AINO, EETU, freshState } from "./helpers";
import { approveAction, declineAction, listActions, saveDraft } from "@/lib/actions";
import { runPlan } from "@/lib/agent/plan";
import { readState } from "@/lib/store/state";
import { POST as approveAll } from "@/app/api/actions/approve-all/route";

async function competingOffers() {
  freshState();
  for await (const event of runPlan(AINO, { fresh: false })) void event;
  const first = listActions(AINO).find((action) => action.kind === "switch_contract")!;
  assert.ok(first);
  const second = saveDraft(AINO, { ...first, offer: { ...first.offer!, provider: "Competing offer" } });
  assert.ok(second.ok);
  return [first, second.action];
}

it("a competing pending switch cannot execute or compute impact after approval; decline and another customer still work", async () => {
  const [first, second] = await competingOffers();
  assert.equal(approveAction(AINO, first.id, () => null).ok, true);
  let impactCalls = 0;
  const rejected = approveAction(AINO, second.id, () => { impactCalls++; return null; });
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.status, 409);
  assert.equal(impactCalls, 0);
  assert.equal(readState().audit.filter((event) => event.type === "action_executed_simulated").length, 1);
  assert.equal(declineAction(AINO, second.id).ok, true);
  const other = saveDraft(EETU, second);
  assert.ok(other.ok);
  assert.equal(approveAction(EETU, other.action.id, () => null).ok, true);
});

it("batch approval executes exactly one of two pending offers for the same bill", async () => {
  const [first, second] = await competingOffers();
  const response = await approveAll(new Request("http://localhost/api/actions/approve-all", {
    method: "POST", headers: { "Content-Type": "application/json", "x-forwarded-for": crypto.randomUUID() },
    body: JSON.stringify({ customerId: AINO, actionIds: [first.id, second.id], confirm: true }),
  }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.approved.length, 1);
  assert.equal(body.failed.length, 1);
  assert.equal(body.failed[0].actionId, second.id);
  assert.equal(readState().audit.filter((event) => event.type === "action_executed_simulated").length, 1);
});
