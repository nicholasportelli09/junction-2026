# Hosted approval conflict reproduction

P1: version-conflict replay can overwrite an already-declined action with a stale approval (reviewed head `284df5f`).

`lib/store/state.ts:159` replays the pending reducer on the newer database row. In `lib/actions/index.ts:93-97`, that reducer captures `decided` after checking status outside the reducer, then replaces the newer action unconditionally. Two instances reading awaiting_approval can therefore commit decline then approval; both operations report success and the final audit contains action_declined followed by action_approved/action_executed_simulated.

Scripted reproduction using this PR's fake Supabase: save a draft, capture its pending snapshot, decline and persist, open a fresh local slot on the captured snapshot, restore the declined remote row, then approve and settle. Actual: responseOk=true, final status=executed_simulated. Expected: preserve decline and return a conflict to the stale caller. Existing hosting tests: 22/22; added regression: fails as described. No real Supabase or provider calls.

Minimal correction: revalidate the action's pending status, ownership, expiry and same-bill approval rule against the state being committed, including every CAS retry; return the committed result/conflict only after persistence. Merely making the replay a no-op is insufficient if the HTTP response still claims approval. Cover approve/decline and duplicate approvals across instances. The existing PR #4 same-bill check alone does not solve this new cross-instance replay path. Handing off rather than overlapping your active store work.

Apply this test patch on this PR and run `npx tsx --test tests/unit/hosting.test.ts`:

```diff
diff --git a/tests/unit/hosting.test.ts b/tests/unit/hosting.test.ts
index 4c7dc5d..f8d98bb 100644
--- a/tests/unit/hosting.test.ts
+++ b/tests/unit/hosting.test.ts
@@ -6,7 +6,7 @@ import { POST as prepare } from "@/app/api/actions/prepare/route";
 import { GET as listRoute } from "@/app/api/actions/route";
 import { POST as reset } from "@/app/api/demo/reset/route";
 import { GET as health } from "@/app/api/health/route";
-import { listActions, saveDraft } from "@/lib/actions";
+import { listActions, saveDraft, approveAction, declineAction } from "@/lib/actions";
 import { buildTransferDraft } from "@/lib/actions/drafts";
 import { corsHeaders } from "@/lib/agent/cors";
 import { allowRequest, eventStream } from "@/lib/agent/http";
@@ -264,6 +264,27 @@ describe("hosting: state in Supabase", () => {
     assert.deepEqual(inSession(anna, () => readState().actions.map((a) => a.id)), stored, "and this instance now sees all of it");
   });
 
+  it("QA: a stale approval cannot overwrite another instance's decline", async () => {
+    const anna = newSessionId();
+    await openSession(anna);
+    const action = inSession(anna, () => addTransfer());
+    await settleSession(anna);
+    const stale = structuredClone(supabase.rows.get(anna)!);
+    inSession(anna, () => declineAction(AINO, action.id));
+    await settleSession(anna);
+    const declined = structuredClone(supabase.rows.get(anna)!);
+    // Load the older snapshot to model a second instance that read before the decline.
+    supabase.rows.set(anna, stale);
+    forgetStoredState();
+    await openSession(anna);
+    supabase.rows.set(anna, declined);
+    const result = inSession(anna, () => approveAction(AINO, action.id, () => null));
+    await settleSession(anna);
+    const stored = supabase.rows.get(anna)!.state;
+    console.log("QA_CONFLICT", JSON.stringify({responseOk:result.ok, status:stored.actions[0].status, audit:stored.audit.map(e=>e.type)}));
+    assert.equal(stored.actions[0].status, "declined");
+  });
+
   it("a route answers only after the change is stored, and the visitor is told which session they have", async () => {
     const response = await prepare(request("/api/actions/prepare", { body: transfer() }));
     assert.equal(response.status, 201);

```
