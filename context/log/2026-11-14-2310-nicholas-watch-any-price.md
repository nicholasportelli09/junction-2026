# Watch any price: the property watch is now general, and Nemotron chooses what to watch

**Summary:** A second tool, `search_prices`, lets Sisu price and watch anything the customer names (a phone, a used car), on the same watch machinery as flats. Nothing in the code knows what the thing is: the model supplies the topic, code reads, compares and asks for approval.
**Author:** Nicholas (Claude Code) · **Branch:** feat/watch-any-price · **Lane:** agent (touches `lib/types.ts` and the approve routes again, see Decisions)

## Done
- `lib/agent/research/prices.ts`: Exa finds pages that offer the topic ("<topic> hinta osta Suomi"), Context.dev reads each into offers (name, price, details, link). `cleanTopic` and `cleanItems` do the cleaning.
- `lib/agent/tools/prices.ts`: the tool `search_prices` (`what`, `maxPriceEur`, `watch?`), its schema, label and one prompt line. The price must be one the customer said.
- One watch for both: `lib/actions/watch.ts`, `lib/watch/` and `lib/watch/detect.ts` now take a `topic` (null for flats) and a `priceUnit`. New action kind `price_watch`. A flat is checked against the month (`lib/finance/rent.ts`), a one-off price against the balance before payday (`lib/finance/affordability.ts`).
- `scrapeJson` in `lib/agent/research/listings.ts` is the one Context.dev page read both kinds use.
- Tests: 7 more in `tests/unit/watch.test.ts` (35 there, 341 in all). `tsc`, `eslint`, `npm run build` clean.
- Live with Nemotron on `/dev/agent`: "Tell me when an iPhone 15 is under 450 euros" (nothing fits, watch offered, two real page monitors on approval), "Find me a used Toyota Corolla under 12000 euros" (one found, 9,900), and the flat question still goes to `search_flats`.

## Decisions
- Why a tool at all: Nemotron already picks the tool and the arguments. A watch has to exist for days, hold monitors and be checked when nobody is talking, and every number has to come from code; a model turn cannot do either. What is general now is the tool, so a new kind of thing needs no new code.
- `lib/types.ts`, again additive except one rename: `Listing.pricePerMonthEur` is now `Listing.priceEur` (merged 90 minutes earlier; nothing outside the dev page reads it). `ActionKind` gains `price_watch`; `WatchPlan` and `PropertyWatch` gain `topic` and `priceUnit` and `city` may be null; `WatchNotification.leftOverAfterEur` may be null and `balanceAfterEur` is new. Frontend notes are in `docs/FRONTEND_INTEGRATION_CONTRACT.md` ("Any price, not only flats").
- A price watch has no search monitor. For flats, pages a search monitor finds are read only on known rental sites; there is no such list for "anything", so it is left out rather than reading arbitrary pages.
- An offer under 30% of the price limit is taken to be a part or an accessory and is not reported (a phone case on a page of phones). The action's assumptions say so.

## Learned / gotchas
- General pages read faster than listing pages (4 to 8 seconds). A product page often yields one offer; a comparison page (hintaseuranta.fi, autouncle.fi) yields several.
- Some shop pages answer 404 to Context.dev (one gigantti.fi URL did); the page is reported in `problems` and the watch uses the pages that could be read.
- Renaming the flats schema key to `priceEur` did not change what Context.dev extracts.

## Next / open questions
- As before: no real price change has been seen end to end; the demo's drop is the labelled simulation.
- The accessory rule and the "shares a word with the topic" rule are heuristics. A cheap genuine bargain under 30% of the limit would be missed.
- Not on `main` yet.
