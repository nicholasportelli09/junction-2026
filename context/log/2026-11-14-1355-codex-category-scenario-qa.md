# Category savings now agree with futures above €500

**Summary:** Fixed PR #5's category-cut regression: Eetu's €632.33 monthly cut was silently projected as €500.
**Author:** Nicholas (Codex) · **Branch:** qa/independent-judge-audit · **Lane:** agent

## Done
- Reviewed main 5da064c since aa39092 and backend challenge-text commit 3cfdfca; incorporated main into the isolated QA branch.
- Preserved computed category savings after generic input validation in lib/agent/tools/finance.ts; added a failing-before/passing-after regression.
- 257/257 unit tests; lint and webpack build pass; HTTP concurrency/approval checks and Playwright simulated approval flow pass.

## Decisions
- No new UI or shared config/type edits. Generic model-entered savings remain capped; category-derived values use actual spending.

## Learned / gotchas
- Before: receipts €632.33/month, projection €500/month. After: both €632.33, one-year gain €7,587.96.
- No live provider credentials available in these checkouts; this run is scripted/mock evidence only.

## Next / open questions
- PR #4 includes the fix; no merge or deploy. Previous live sponsor, freshness and demo presentation risks remain.
