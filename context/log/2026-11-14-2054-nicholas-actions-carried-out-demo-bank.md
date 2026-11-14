# Approved actions are carried out in a demo bank: balances move, bills change

**Summary:** Approving an action now does something you can see: a transfer moves the balance in Sisu's demo bank, and Sisu and the screens use the new figures. No real money moves, and the labels still say so.
**Author:** Nicholas (Claude Code) · **Branch:** feat/actions-take-effect · **Lane:** agent

## Done
- `lib/actions/bank.ts`: the demo bank. The ledger is the approved actions themselves, each with a record of what was done (`action.execution`: steps, balances before and after, the standing order, or the contract). `accountsFrom` adds them up; `carryOut` is the one function a real bank's payment API would replace.
- Approval (`lib/actions/index.ts`) carries the action out and can be refused: a one-off transfer the account can no longer cover answers 409 and stays waiting.
- `GET /api/accounts` (type `AccountsView`): the bank data's balance, what was moved, the balance now, standing orders, contracts, with receipts.
- "Can I afford it" and new transfers start from what is left in the current account (`withCurrentAccount`). The overview, baskets, futures and buffer stay the bank data, because money moved to savings is still the customer's.
- Sisu is told the accounts as they stand (`ACCOUNTS NOW` in the prompt) and their figures are receipts, so it can say them.
- Guard (`lib/agent/guards.ts`): "it is waiting for your tap" about something already approved is caught (`wrong-status`), and "I moved 500 euros" is allowed as a report of what was done when the customer is not asking for something new.
- Docs: section 17 of `docs/FRONTEND_INTEGRATION_CONTRACT.md`.
- Measured: 306 unit tests pass (13 new in `tests/unit/bank.test.ts`); typecheck, lint, build pass. Live with Nemotron on our GPU: Eetu moved €2,500, balance €4,183.34 to €1,683.34; "can I afford a €3,000 holiday" went from 469.49 short to 2,969 short; a further €2,000 was refused; asked four times what was done, Sisu gave the right status and balance with every number sourced. Journey and reliability scripts clean; the iOS app's network code 28 of 28.

## Decisions
- No type, status or string changed: `status` is still `executed_simulated`, `simulated` true, `confirmation` the same. `AgentAction.execution` and `Overview.balanceBasis` are new and optional. Affects: nobody has to change code; frontends can show `execution.steps` and `GET /api/accounts`.
- Exa was not used for this. Its API searches, reads and researches; nothing in it can move money or sign a contract. Affects: the pitch should not claim that it does.
- Real money through an outside payment service was not built: it needs an account with that service, and the demo customers have no real accounts. Affects: `carryOut` is where one would plug in.

## Learned / gotchas
- The scripts in `tests/gauntlet` take the server from `SISU_BASE` (default port 3310), not from an argument. Passing a URL as an argument silently tests the default server.
- Two identical waiting transfers are one action (`saveDraft` hands the first back), so a test of "the second is refused" needs two different amounts.

## Next / open questions
- Frontend: show `execution.steps` after Approve and the balance from `GET /api/accounts`.
- The live site is not updated by this branch until it is deployed.
