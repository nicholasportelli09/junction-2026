# Independent QA: hosted approval conflict

**Summary:** PR #11 can replay a stale approval over a committed decline; PR #12 core Swift builds, but native tests need Xcode.
**Author:** Codex · **Branch:** qa/independent-judge-audit · **Lane:** agent

## Done
- Reviewed PR #11 284df5f and native PR #12 ae98865; main and earlier reviewed frontend refs unchanged.
- Hosting tests 22/22 pass; additional scripted CAS-conflict regression fails. See docs/QA_PR11_CONFLICT_REPRO.md and PR #11 handoff.
- PR #12 SisuCore build passes; XCTest compilation unavailable (CommandLineTools). No app/simulator runtime evidence.

## Decisions
- No overlapping store edits or frontend edits. Owner should validate approval inside each CAS retry and return the committed outcome.
- No repeated web smoke on unchanged UI; no fresh live provider/database calls. Existing coverage remains historical.

## Next / open questions
- Resolve PR #11 stale approval before relying on multi-instance approval safety; integrate existing PR #4 fixes.
- Native fallback notice and real runtime verification remain open; no deployment or merge performed.
