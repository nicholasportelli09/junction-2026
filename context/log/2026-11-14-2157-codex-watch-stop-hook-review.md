# Property-watch stop race fixed; shared hook customer race confirmed

**Summary:** QA prevents a pending check from reviving a stopped watch; the new shared hook still accepts stale customer responses.
**Author:** Codex · **Branch:** qa/independent-judge-audit · **Lane:** agent

## Done
- Reviewed main `0e37d22`, merged PR14 `9170350`, and its new client/useSisu/WatchPanel changes; backend and landing/native heads otherwise unchanged. Read challenge export, context, and available relevant thread; no current builder thread visible.
- Integrated main into this QA branch. Added stop/check regression: failed before (`active`), passes after (`stopped`). Guard is inside the state reducer too, for hosted replay. No authored UI/shared-config/types changes.
- 346/346 unit tests, lint, webpack production build pass. At 390×844: mock bill search → explicit simulated approval → €2.01/month saving and five-year impact; no captured console errors. Screenshot inspected: browser-screenshot-127-0-0-1-mwgtsdhu-564904c6.png. Existing absent utility styling prevents visual sign-off.
- Controlled browser response fixture proves late Aino watch refresh overwrites Eetu's panel AND restores Aino's real local mock approved-saving summary. Handoff to PR14: guard refresh generations at lib/agent/useSisu.ts:108-125. No UI edits.

## Decisions
- Only local/mock/scripted evidence: no .env.local in QA/shared checkout; no live calls, real monitor changes, or native runtime check. Native/landing unchanged, costly checks not repeated there.

## Next / open questions
- PR4 awaiting integration; concurrent watch starts, failed monitor-delete retry, real-monitor success label, and hosted approval CAS replay remain open. Preserve three-basket/teaching flow alongside property-watch demo; main/native watch presentation still absent.
