# Independent QA: model failover and landing privacy disclosure

**Summary:** PR #9 model tests pass; PR #10 needs precise sponsor-data disclosure.
**Author:** Codex · **Branch:** qa/independent-judge-audit · **Lane:** agent

## Done
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
