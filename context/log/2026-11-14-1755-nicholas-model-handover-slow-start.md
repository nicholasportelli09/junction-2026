# Model handover: a slow start on our GPU no longer fails the turn when the backup is down

**Summary:** When our GPU is slow to start, the backup is now asked alongside it instead of replacing it, and silent hosts are asked once more, so a turn fails only when neither host answers at all.
**Author:** Nicholas (Claude Code) · **Branch:** fix/slow-start-with-backup-down · **Lane:** agent

## Done
- `lib/agent/model.ts`: the first-token limit (2 s) used to cancel our GPU's request and hand the step to the backup. Now the backup is asked as well and whichever host starts first takes the step; the other request is cancelled. If both stay silent for 5 s more (`MODEL_REASK_LIMIT_MS`), each is asked once more.
- The breaker still follows only our GPU. While it is open the backup is asked first, and our GPU joins after the same limit if the backup is silent.
- 7 new tests in `tests/unit/model.test.ts` (20 in the file, 271 in all). The three that cover the live failure fail on the old code, two of them after exactly 25 s.
- Checked with the iOS app's own code: a small Swift program on top of `ios/SisuCore` drove `CoachSession`, `PlanSession` and `CoachClient` against a live backend (data screens, Ask typed and by voice, Approve, the plan, approve all). 24 of 27 checks passed.

## Decisions
- No event, type or endpoint changed. `timings.modelSteps[].usedBackup` still says which host answered. Affects: nobody has to change code.
- In the worst case (both hosts silent) a step now sends four requests instead of two, and gives up about 7 s later than before. Affects: agent lane only.

## Learned / gotchas
- Live, 14 Nov about 17:30: three of four model turns failed after 27 to 57 s with a healthy GPU. Our GPU took over 2 s to start, and NVIDIA's hosted backup was not answering (three readiness checks in a row said so, then it recovered, then one request hung for 25 s and the next took 1 s). Treat the hosted backup as unreliable from this network.
- To reproduce: `MODEL_FIRST_TOKEN_LIMIT_MS=1 NEMOTRON_BASE_URL=http://10.255.255.1:8000/v1 npm run dev`. Old code: every turn fails after about 11 s. New code: four turns answered from our GPU in 0.5 to 4.0 s.
- iOS: `GET /api/agent/visuals` returns a chart of kind `basket_bar` that `Visual.Content` in `ios/SisuCore/Sources/SisuCore/PlanModels.swift` does not know, so the three-baskets chart shows as text only. Every stream event type is known to the app.
- This Mac has no Xcode, so the screens, the microphone and audio playback were not run here.

## Next / open questions
- iOS lane: add `basket_bar` to `Visual.Content`; run the app in the simulator against a live backend once (`-sisu.baseURL`).
- The money plan still has no screen in the iOS app and no link from the web home page.
