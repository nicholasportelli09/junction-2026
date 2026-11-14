# Price-watch incremental review

**Summary:** New general price watch accepts the wrong model, retains email addresses in topics, and breaks legacy stored watch prices/units.
**Author:** Codex · **Branch:** qa/independent-judge-audit · **Lane:** agent

## Done
- Reviewed voice PR15 bb1e35b and price-watch PR16 4c6cb30, merged main 8656750; read challenge export and visible relevant thread. No current watch-builder/frontend thread is visible.
- Reviewed WatchPanel, useSisu, API/contracts and new research/watch/approval logic. Landing PR10, native PR12 and frontend branch heads unchanged.
- 39/39 existing watch/voice tests pass. Scripted reproductions: iPhone 12 accepted for iPhone 15; email survives cleanTopic; legacy rent 900/budget 700 loads but simulated drop returns 409 and priceUnit is undefined.
- Exact files, reproductions and minimal fixes handed to PR16. No customer-facing UI, shared types/config or overlapping watch code edited.
- 390x844 dev-browser attempt blocked at connecting: HMR errors and font HTTP403; screenshot inspected (browser-screenshot-127-0-0-1-mwguuh7n-af32ace4.png). No core-flow pass, live-provider or native runtime claim.

## Decisions
- Preserve lane ownership; hand off active watch/schema changes together rather than introduce a conflicting migration. No merge or deploy.

## Next / open questions
- Correct matching/privacy and migrate stored state before demo. Previous approval concurrency and stale-customer findings remain open; preserve three-basket teaching alongside watches.
