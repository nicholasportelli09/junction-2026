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
