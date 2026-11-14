# Independent judge QA — 14 November 2026

Base: `origin/main` at `aa39092`. Branch: `qa/independent-judge-audit`. No UI, shared configuration, credentials or infrastructure changed.

## Reproduced and fixed

| Severity | Judge scenario / failure on main | Fix and evidence |
|---|---|---|
| P1 | Compare 2,000 kWh/year: 8 c/kWh + €4/month + €120 setup versus 9 c/kWh + €4/month, no setup. Main recommends the first by omitting €120. | First-year monthly equivalent is €27.33 versus €19; the no-setup offer wins. |
| P1 | A page returns negative setup fees (mobile/internet) or negative electricity base fees. Invalid prices can inflate the saving beyond the entire current bill. | Reject negative/nonfinite fees and invalid base prices before ranking or estimating typical usage. |
| P2 | Electricity price is known but its base fee is missing. Main silently assumes free. | Keep the offer visible but unranked, with no claimed saving. Known setup fees included; unknown setup fees remain a disclosed zero assumption. |
| P2 | Twelve callers request the same uncached page simultaneously. Main makes 12 upstream reads, enough to overwhelm the documented 10/minute Context.dev allowance. | Share the pending read: 12 callers now make 1 request. Failed reads can be retried. |
| P2 | Reuse a page with unknown upstream cache age. Main converts unknown age into apparent freshness. | Preserve null rather than inventing an age. Known ages still advance. |
| P2 | Abort a plan before it begins. Main still creates one draft. | Cancellation checks prevent subsequent drafting. Regression also aborts after account scan and page results. Existing drafts are not rolled back; shared research may finish in background. |

Electricity fees and cancellation/cache concerns had also appeared in earlier independent review notes, but were still unfixed on main. This is an integrated patch, not a claim that every finding is new. Invalid fee ranking and the measured 12-caller amplification extend that evidence.

## Executed evidence

- Baseline `npm test`: **248/248**.
- First four new tests against main: **0/4**. Cancellation test separately failed (one unexpected draft).
- Final `npm test`: **253/253**, including scripted reasoning/tool selection, injected web text, approval guards, customer scoping, model fallback, and new judge cases.
- `npm run lint`: clean. `npm run build -- --webpack`: passed including TypeScript.
- Running isolated production server: `SISU_BASE=http://127.0.0.1:3348 node tests/gauntlet/judge-audit.mjs`: 12 concurrent scenario turns completed; foreign-customer approval 404; missing confirmation 400; three simultaneous approvals produced 200/409/409.
- Browser core flow: Aino → Sort out my money → four draft actions with warning and explicit simulation label → Approve all (see session evidence). Mock sources explicitly labelled as examples.
- Browser limitation: Turbopack dev preview did not hydrate the customer selector; webpack production flow was functional but lacked utility styling. No visual sign-off. Frontend/config owner must verify the actual demo build.
- No live credentials were found in available project checkouts. No fresh live Nemotron, Exa, Context.dev or ElevenLabs calls were executed. Scripted/mock passing tests do not certify live reasoning, Finnish speech, live price extraction or booth latency.

Reproduce: `npm test`; start an isolated server with `MODEL_PROVIDER=mock SISU_STATE_FILE=/tmp/sisu-qa/state.json npm run start -- --port 3348`, then run the HTTP script above. State-changing HTTP smoke explicitly refuses a non-mock server.

## Challenge alignment and lane handoff

Source: [Nicholas's concrete challenge brief](https://docs.google.com/document/d/1A0Rtb7WddaoytJldIhIOQ1m1YGD4eMTCqnGFKZYdzyY/edit). Reviewed build plan, orchestration, recent logs, merged PRs #2/#3 and open concept PR #1. Visible T3 inventory had no other running project agent at review time; this is a snapshot, not continuous monitoring of teammates' machines.

| Owner | Drift / evidence | Stay within the challenge |
|---|---|---|
| Frontend | `/plan` automates a fixed sequence but has no teaching question or arbitrary follow-up on that screen. S-Pankki scores financial literacy and mobile clarity at 20% each. | Demonstrate three baskets, one predict-before-reveal lesson and a typed/voice follow-up using personal transactions. Keep warnings, receipts and simulation labels. Do not spend the remaining time adding more galleries. |
| Orchestration | Plan selection is code-driven; Nemotron mainly words its summary. NVIDIA requires meaningful Super VL work, not just a logo or narration. | Include a live free-form chat/investigation with visible model-selected tools, exact served model and provider trace. A Gemini fallback is useful resilience, not proof of Nemotron participation in that turn. |
| Research | Exa fallback is useful, but an all-Exa run does not demonstrate Context.dev's core contribution. Cached reads are not evidence of reacting to a new web change. | Show at least one Context.dev extraction changing a compared price; show reader, source, retrieval time and freshness uncertainty. For Exa accept a judge's changed requirement and finish with a usable draft. |
| Finance/actions | Missing fees, uncertain bill identity, unknown current exit charges and plan equivalence can overstate savings. | Confirm the guessed bill, state consumption/fees assumptions, distinguish recurring savings from moving existing money, keep approval and audit. Never claim a contract actually switched. |
| Voice/compute/submission | Concept PR #1 says Gemini or ElevenLabs and makes Nemotron optional; housing monitoring is only proposed. | Use ElevenLabs audio and Super VL as committed in the build plan; show actual Verda inference, document provider fallback privacy honestly, prepare the required sponsor write-ups/Verda process summary. Present monitors as future work. |

Alignment guidance was posted directly on PR #1. Do not build new monitors, alternative model stacks or additional product surfaces before the core flow and live sponsor evidence are ready.

## Remaining demo risks

1. **Live service evidence missing in this audit.** Run an unfamiliar multi-step Finnish question and one cold offer search with the actual provider configuration before judging; record source, model and latency.
2. **Calculator provenance / grounding:** arithmetic is deterministic, but model-chosen operands are not validated against receipts. Units and multilingual numerals also need stronger checking. Existing grounding success rates are not a proof of financial correctness.
3. **Research fallback deadline:** Context.dev's 8-second timeout plus Exa fallback can exceed the tool's 8.5-second wait. Failed watched research can trigger another unreported search. Page coalescing fixes duplicate reads, not duplicate watched searches or that deadline.
4. **No authentication, single-file state:** customer-scoped functions and approval races pass within one process; this is not multi-user authorization or multi-instance persistence. Stay on synthetic data and one demo server.
5. **Incomplete pricing:** unlisted setup fees still assume zero (now explicit); current-contract exit fees, promotion expiry and like-for-like speed/coverage are not represented. Avoid presenting these estimates as guaranteed savings.
6. **UI/demo build:** dev hydration and webpack styling observations need the frontend/config owner. No UI files changed by this QA branch.


## Incremental audit — 14 November, 13:55 EET

Reviewed main `5da064c` (PR #5, head `3c48685`) against the previous `aa39092` baseline, plus the backend branch's challenge-text-only commit `3cfdfca`. Re-read the supplied challenge Doc. PR #5 improves S-Pankki alignment: basket teaching and conditional telecom savings are now explicit. Earlier alignment guidance is unchanged and was not reposted.

**New P1: category savings and futures disagreed above €500/month.** Eetu's Entertainment average is €632.33. A 100% category cut produced a €632.33 receipt but the generic bill-saving slider limit truncated the scenario to €500; the one-year cash improvement was €6,000 instead of €7,587.96. `runScenarioTool` now preserves the code-computed category saving after validating other scenario inputs. Model-supplied generic savings retain their existing limit. No shared types/config or UI were edited by this fix.

- Added regression failed before the fix (`500 !== 632.33`), then passed. The integrated baseline with PR #5 had 256 passing tests; final suite: **257/257**.
- Lint and webpack production build passed. HTTP mock judge audit: 12/12 concurrent turns, cross-customer approval 404, absent confirmation 400, simultaneous approvals 200/409/409.
- Playwright production smoke on isolated port 3351: Aino → Sort out my money → three-way savings split and four waiting actions → Approve all → four explicit simulated completions and futures. Screenshot: `.playwright-mcp/sisu-qa-nov14-approved.png` in the tool output directory. No automated e2e smoke spec exists in this checkout.
- Tests used scripted/mock providers only. Neither the QA nor shared checkout contains `.env.local`; no fresh live provider calls or voice checks were executed. Earlier live-service and presentation risks remain unverified.

## Incremental integration audit — 14 November, 14:30 EET

Reviewed main `9750ce3` (merged PR #6) against `5da064c`; backend remains `3cfdfca`. No changes in `app/`, `lib/`, `tests/`, package manifest or lockfile. Integrated main into the isolated QA branch without conflicts; existing QA fixes remain pending in PR #4. Read the challenge Doc again and reviewed the new iOS client endpoints, teaching models, cancellation and replay transport. The iOS teaching path, three baskets, explicit simulated approval and free-form Ask support the brief. No new backend defect confirmed.

**New static P2 handoff, iOS core:** `PlanSession.approveAll()` does not call `noteFallback()` in either its success or error path. With a `liveWithSampleFallback` client, an offline approval POST makes `FallbackTransport.send()` permanently switch to bundled recordings. `dataLabel` changes to sample, but the promised `fallbackNotice` remains nil; an unknown live action ID can yield a sample error with no explanation of the transition. The method's comment also assumes server-side logging even if the answer is now replayed. Minimal correction: invoke `noteFallback()` after the awaited approval request on both paths (for example `defer { noteFallback() }`); test a live plan followed by an offline approval and assert sample label plus notice, without claiming server execution. This is a conditional core-client path, not a reproduced phone-screen failure. Handed to PR #6; no frontend code edited.

Validation attempt: `sh ios/scripts/test-core.sh` could not compile tests: `no such module 'XCTest'`. Active developer directory is CommandLineTools; no Xcode app found. Thus the merge author's 205 passing Swift tests were not independently reproduced. Existing backend build/browser checks were not repeated on byte-identical backend code. No `.env.local` in QA/shared checkouts; no live sponsor calls executed.

## PR #7 independent delta audit — 14 November, 16:00 EET

Reviewed main `c22dba8` (iOS-only delta from `9750ce3`) and backend PR #7 `442c777`. Backend `3cfdfca` and the other previously reviewed backend heads are unchanged. Temporarily combined #7 with QA `04579f3` only in the isolated QA worktree, then aborted that local integration. Existing unit suite: **270/270**, 22.4 s. No live calls, new browser check or native runtime verification; no production code changed in this audit.

New scripted findings, handed to the active PR owner rather than overlapping their files:

- **P1: the one-switch-per-bill rule is checked only when drafting.** Prepare two distinct offers for the same customer and bill while both are pending; approve the first, then the second. Both return success and two actions are `executed_simulated`. The new total deduplication hides this in the web total but does not prevent contradictory approvals (native clients can still sum both). Minimal fix: in `decide`, before computing impact or writing approval, reject an approval of a switch when another approved switch exists for this customer/bill, with 409. Keep decline possible. Regression: two pending different offers, then single approvals and approve-all; exactly one execution/audit execution for that bill, and another customer remains independent.
- **P2: empty model output is reported healthy.** Both providers returning `choices: [{message: {content: ""}}]` produce `ready: true` and “wrote a reply”. Require trimmed nonempty content; test empty and whitespace content for primary and backup. This probe still does not prove tool selection.
- **P2: Gemini fallback is misidentified.** With `MODEL_FALLBACK=gemini`, the returned stand-in says “Google hosted copy of the same model”. Name the configured fallback provider AND model; only claim the same model when names actually match. State that hosted fallback sends aggregates outside the Verda deployment. This matters for NVIDIA's Super VL requirement and Verda's hosting story.

ElevenLabs readiness currently checks account/model metadata, not STT/TTS; do not present `voiceReady` as executed audio coverage. Existing teammate live results remain attributed to that teammate. No keys found in QA/shared `.env.local` files.

### Reproduction (scripted, no network)

On PR #7 plus PR #4, save the following as `tests/qa-pr7-review.ts`, run `npx tsx tests/qa-pr7-review.ts`, then remove it. It uses test-only isolated state and stubbed fetch; the alternate draft models a changed offer between two preparations.

```typescript
import { freshState, AINO, stubFetch } from './unit/helpers';
import { runPlan } from '../lib/agent/plan';
import { saveDraft, approveAction, listActions } from '../lib/actions';
import { forgetReadiness, readiness } from '../lib/agent/readiness';
async function main() {
 freshState();
 for await (const event of runPlan(AINO, {fresh:false})) { void event; }
 const first = listActions(AINO).find(a => a.kind === 'switch_contract')!;
 const second = saveDraft(AINO, {...first, offer:{...first.offer!, provider:'Alternative provider'}, monthlyAmountEur:first.monthlyAmountEur + 1});
 if (!second.ok) throw new Error(second.reason);
 const one=approveAction(AINO, first.id,()=>null);
 const two=approveAction(AINO, second.action.id,()=>null);
 console.log(JSON.stringify({case:'two different offers prepared before approval',firstApproved:one.ok,secondApproved:two.ok,executedForSameBill:listActions(AINO).filter(a=>a.billType===first.billType&&a.status==='executed_simulated').length}));
 Object.assign(process.env,{MODEL_PROVIDER:'verda',MODEL_FALLBACK:'gemini',VERDA_BASE_URL:'http://gpu.test/v1',GEMINI_BASE_URL:'http://backup.test/v1',EXA_API_KEY:'test',CONTEXT_DEV_API_KEY:'test',ELEVENLABS_API_KEY:'test'});
 const restore=stubFetch(url=>new Response(JSON.stringify(url.includes('/chat/completions')?{choices:[{message:{content:''}}]}:url.includes('exa.ai')?{results:[{url:'https://example.com'}]}:url.includes('context.dev')?{json:{success:true,data:{title:'Example'}}}:{character_count:0,character_limit:100}),{status:200}));
 forgetReadiness();
 const report=await readiness({fresh:true});
 console.log(JSON.stringify({case:'empty model replies with Gemini backup',ready:report.ready,model:report.checks.find(c=>c.id==='model')}));
 restore();
}
main();
```


## Post-merge audit — 14 November, 17:57 EET

Main `48af231` merged the previously reviewed PR #7 unchanged. Integrated it into the isolated QA branch and fixed its three reported defects now that the implementation branch is merged:

- Competing pending offers for the same customer/bill: previously both executed; now the second approval returns 409 before computing impact or writing execution events. Declining remains possible; another customer remains independent. Batch approval executes exactly one of the competing switches.
- Empty and whitespace-only primary/backup replies now fail readiness instead of reporting ready.
- Fallback disclosure names the actual configured provider/model and says customer aggregates are sent there; Gemini is no longer described as the same model.

Validation: **275/275 unit tests**, including five new regressions; lint and webpack production build passed. Mock HTTP audit: 12 concurrent turns completed, cross-customer approval 404, missing confirmation 400, repeated approval race 200/409/409. Browser at 390×844: Aino → plan → approve four → simulated completions and futures, no captured console errors. Screenshot inspected: `browser-screenshot-127-0-0-1-mwgl8rk6-7546be71.png` in local T3 browser artifacts. Existing missing webpack utility styling remains; no visual sign-off and no duplicate frontend comment.

Frontend review: PR #7 hook saving deduplication and readiness page inspected; customer-facing web paths and iOS are otherwise unchanged from reviewed main `c22dba8` / frontend `0488829`. No customer-facing UI edited. Previously reported native fallback notice remains open. Native tests not repeated: active developer directory remains CommandLineTools, with prior XCTest compilation unavailable. Web evidence does not validate native UI.

Read the challenge brief through its text export (web open failed). Existing sponsor/teaching guidance remains applicable and was not reposted. No fresh live calls: QA/shared `.env.local` absent. Readiness is still a bounded service probe, not proof of real tool choice or executed ElevenLabs audio. No merge or deployment performed.


## Incremental review — 14 November, 18:24 EET

- Main 48af231 and native/frontend 0488829 unchanged; reviewed PR #9 287bc90 and landing PR #10 7e512df independently.
- PR #9: 20/20 existing model tests passed in 2.51 s, scripted providers only; no new backend failure confirmed.
- PR #10: 390×844 static landing smoke, nine steps and 19 pickers; no horizontal overflow; screenshot inspected. No console entries captured; missing favicon 404 only.
- P2 privacy copy handoff: backup also receives prompts when GPU is slow; Exa receives free-form queries; ElevenLabs receives answer text. Posted exact locations/corrections on PR #10.
- Read available relevant T3 threads and new branch context; no visible frontend builder thread. Re-read challenge via text export.

## Decisions
- No UI/config edits or branch integration; temporary detached reviews only in our isolated worktree, now restored to QA branch.
- Existing backend builds and approval smoke not repeated on unchanged app code. No fresh live-provider or native runtime evidence; Xcode selection remains CommandLineTools.

## Next / open questions
- PR #4 fixes still await integration; existing native fallback notice, basket_bar support and demo styling risks remain.

Handoff: https://github.com/Junction-2026-NMA/junction-2026/pull/10#issuecomment-6880605317
Screenshot: `/Users/nicholasportelli/.t3/userdata/browser-artifacts/browser-screenshot-127-0-0-1-mwgm8ii6-59bce186.png`. This landing smoke does not validate backend approvals or native iOS.


## Incremental audit — 14 November, 19:30 EET

- Main `48af231`, prior web/native/PR9/10 heads unchanged. Reviewed new hosting PR #11 `284df5f` and native PR #12 `ae98865`; no customer-facing UI changes made.
- **P1, PR #11:** Supabase version-conflict replay overrides a committed decline with a stale approval. Existing hosting tests 22/22; additional scripted regression fails. Reproduction and minimal correction: `docs/QA_PR11_CONFLICT_REPRO.md`. Handoff on PR #11; active storage implementation left to its owner.
- PR #12: basket_bar decoding/presentation, hosted default, timeout and cookie transport reviewed. `swift build --package-path ios/SisuCore` passes (6.37 s). `swift test` fails to compile: no such module XCTest; active developer directory is CommandLineTools. App target, simulator, mobile readability and native voice/approval runtime were not validated. No new static defect confirmed; earlier fallback-notice handoff remains applicable.
- No web UI delta; previous browser results remain historical, not fresh coverage of hosted persistence. No fresh live sponsor/remote database calls; neither checkout has .env.local. No full lint/build repeated because no implementation changed.
- Challenge text export re-read. Basket chart support strengthens S-Pankki alignment; prior live sponsor evidence requirements remain. Available relevant threads read; no visible current hosting/native builder thread.


# Demo bank and property watch incremental QA

**Summary:** Fixed the hosted route build signature; new property-watch lifecycle/UI findings handed to PR #14.
**Author:** Codex · **Branch:** qa/independent-judge-audit · **Lane:** agent

## Done
- Reviewed main `25c559f` (PR13 `2c9f1b5`) and PR14 `3b50d6d`; prior web/landing/native heads unchanged. Read challenge export, branch context and available relevant thread; no visible active builder thread.
- Integrated latest main into QA, retaining the competing-switch guard. `withVisitor` now requires Request in its public route signature; updated the existing health-route test to supply it. Before: webpack build failed ParamCheck on optional Request. After: build/typecheck/lint pass; 317/317 unit tests, final route tests 14/14.
- PR14 existing tests 334/334. Scripted lifecycle reproductions: concurrent starts created 2 watches/4 upstream monitor calls; pending check after stop restored active status. No live calls.
- Handoff: https://github.com/Junction-2026-NMA/junction-2026/pull/14#issuecomment-6882990286 (races, failed-delete retry, stale customer panel, false real-monitor success label).
- Production mobile smoke 390x844: Aino -> plan -> approve four -> simulated completions and futures; no captured console errors. Screenshot inspected: browser-screenshot-127-0-0-1-mwgstj0k-d8b6ddb9.png. Existing missing utility styling remains.

## Decisions
- No authored UI/shared config/types edits. Watch code remains with active PR14 owner. Context.dev monitoring strengthens change-over-time alignment; simulated drop is not evidence of a real rental change.

## Learned / gotchas
- PR14 dev-browser smoke blocked at empty customer selector/connecting (HMR errors, font 403); not a successful watch flow. Production QA smoke above excludes PR14.
- Native ActionKind is an OpenEnum, contrary to PR14's closed-enum warning; native presentation remains unverified. No new iOS changes or runtime checks. No .env.local found in either checkout.

## Next / open questions
- PR4 remains unmerged; hosted CAS approval replay and prior sponsor/live/native/styling risks remain. No deploy or remote merge performed.
