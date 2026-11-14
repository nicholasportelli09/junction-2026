# Independent QA: hosting merged with known approval conflict

**Summary:** Main bed4138 merges previously reviewed PRs #9 and #11 unchanged; the reported P1 hosted approval conflict remains unresolved.
**Author:** Codex · **Branch:** qa/independent-judge-audit · **Lane:** agent

## Done
- Fetched and reviewed main 48af231 → bed4138; store/actions/visitor/hosting tests match reviewed PR #11 exactly.
- Compared web app/components/hooks/iOS against last reviewed main: no changes. Frontend 0488829, landing PR #10 7e512df and native PR #12 ae98865 unchanged.
- Read current PR status/comments, relevant available threads, build/orchestration context and challenge text export. No new confirmed defect or alignment drift.

## Decisions
- Do not duplicate PR #11 handoff. Cross-instance approval needs committed-result handling, not a reducer-only no-op; reproduction and exact guidance remain in docs/QA_PR11_CONFLICT_REPRO.md.
- No implementation changes or repeated costly checks on already reviewed code. No fresh browser, native runtime, Supabase or sponsor-provider evidence.

## Next / open questions
- Resolve the known P1 stale approval conflict now present on main; integrate PR #4 fixes separately.
- Native runtime remains unverified here (XCTest unavailable in prior run); previous frontend disclosure/styling findings remain open.
