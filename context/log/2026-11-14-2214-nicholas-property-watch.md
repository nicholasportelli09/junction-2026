# Property watch: Sisu looks for a flat, and if none fits it watches the listing pages with Context.dev monitors

**Summary:** "Find me a three-room flat in Helsinki under 700 euros" now runs a live listing search; when nothing fits, Sisu sets up a watch that starts only on Approve, creates real Context.dev monitors, and stores a notification for that visitor when a flat fits. The price drop shown in the demo is a labelled simulation.
**Author:** Nicholas (Claude Code) · **Branch:** feat/property-watch · **Lane:** agent (touches the approve routes and `lib/types.ts`, see Decisions)

## Done
- Listing search: `lib/agent/research/listings.ts`. Exa finds listing pages on known rental sites (city and topic only in the query), Context.dev `/v1/web/scrape` reads each into typed listings (rent, rooms, m², district, city, available from, link), with the `json.success` check and `cleanListings`.
- Monitors client: `lib/agent/research/monitors.ts` (`POST /v1/monitors` page and search targets, `GET /v1/monitors/{id}`, `GET /v1/monitors/{id}/changes?since=`, `POST /v1/monitors/{id}/run`, `DELETE /v1/monitors/{id}`).
- The watch: new action kind `property_watch` (`lib/actions/watch.ts`), started by the approve routes through `lib/watch/index.ts`, kept per visitor in the state (`watches`, `notifications`), every step in the audit log (`watch_started`, `watch_checked`, `watch_notified`, `watch_stopped`).
- The decision is code: `lib/watch/detect.ts` and `lib/finance/rent.ts` (rent at or under the budget the customer said; what that rent leaves over from their own figures).
- Routes: `GET /api/watch`, `POST /api/watch/check` (poll; `runNow: true` queues a fresh run), `POST /api/watch/:id/stop`, `POST /api/watch/:id/simulate-drop`.
- Agent: one tool, `search_flats` (`lib/agent/tools/flats.ts`), its label and one prompt line. Dev page: `app/dev/agent/WatchPanel.tsx`.
- Tests: `tests/unit/watch.test.ts` (28). `npm test` 321 pass, `tsc` and `eslint` clean.

## Decisions
- Polling, not webhooks. A webhook needs a public address, and its URL would have to carry the visitor's session id to a third party. The page polls `POST /api/watch/check`. Affects: frontend (call it on a timer where notifications are shown).
- `lib/types.ts` changed on this branch, additively: `ActionKind` gains `property_watch`, `AgentAction.simulated` is now `boolean` (false only for a watch) and gains `watch`, four audit event types, and the watch types at the end. A client with a closed enum for action kinds (the Swift app) must add the new kind before it lists actions. Not on `main` yet: say if this should be done differently.
- A watch is the one action that is not a simulation: approving it creates real monitors. It keeps the status `executed_simulated` so existing screens treat it as approved; `simulated: false` and the confirmation text say what is real.
- Stopping a watch and "Reset demo" delete its monitors, so nothing keeps running on the team key.

## Learned / gotchas
- Monitors work on our free key (5,000 allowed). A page run costs 1 credit, a search run 2, a re-read with JSON 5. Baseline is ready within seconds; "run now" completes in under a minute.
- A real change record was checked against a page that changes every second: fields `id, detected_at, url, title, summary, diff`; `since` is inclusive, so the code also filters on the last change it handled.
- Live data does not match the pitch line: "a flat in Helsinki under 900 euros" finds about twenty today (small studios, mostly on rentola.fi and SATO). Nothing fits for "three rooms under 700". Use that wording in the demo, or the slide is wrong.
- A page for Helsinki lists Vantaa and Espoo flats (SATO). Listings the page places in another city are left out.
- A listing page takes Context.dev 7 to 13 seconds; three are read side by side, so the tool takes about 8 to 10 seconds.

## Next / open questions
- No real rent change has been seen end to end yet: real pages did not change during testing. The path from a reported change to a notification is covered by tests with a stubbed API and by the simulate button.
- The main app (`app/page.tsx`, iOS) does not show watches or notifications yet; only the dev page does.
- The search monitor for new listings is created and polled, but what it reports for this query has not been observed.
