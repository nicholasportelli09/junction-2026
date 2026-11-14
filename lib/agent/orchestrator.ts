// One conversation turn, as a stream of events. The rules it follows are in context/orchestration.md.
import { buildCashFlow } from "@/lib/finance/cashflow";
import { findCustomer } from "@/lib/finance/data";
import { buildOverview } from "@/lib/finance/overview";
import { findPatterns } from "@/lib/finance/patterns";
import { accountsFor, listActions } from "@/lib/actions";
import { getMemory } from "@/lib/memory";
import type { AgentRequest, CashFlow, Citation, Fact, NumberCorrection, SisuEvent, Stage, ToolTrace, TurnTimings } from "@/lib/types";
import { getConfig } from "./config";
import { investigationFiller, offerFiller, researchFiller } from "./fillers";
import { APP_NOTE, BROKEN_TOOL_CALL, BROKEN_TRIP, type Trip, asksForAdvice, asksForChart, asksToMoveMoney, checkSentence, isMetaTalk, withoutMetaTalk } from "./guards";
import { type Sources, checkGrounding, correctNames, correctNumbers, numbersIn, overviewFacts, spelledToDigits } from "./grounding";
import { type ChatMessage, type ToolCall, streamChat } from "./model";
import { buildSystemPrompt, customerSummary } from "./prompt";
import { ensureResearch, isResearchReady } from "./research";
import { createSentenceSplitter, forSpeech } from "./sentences";
import { speculate } from "./speculate";
import { TOOL_SCHEMAS, type ToolContext, type ToolOutcome, billTypeOf, executeTool, parseArgs } from "./tools";
import { activityLabel } from "./tools/labels";
import { failure } from "./tools/types";
import { FORGED_NOTE, looksForged } from "./tools/untrusted";

const MAX_MODEL_STEPS = { chat: 6, investigate: 10 };
const MAX_GUARD_RETRIES = 2; // how many times one turn may be sent back to redo a step
const TOOL_TAG = /<\/?tool_call|<\|/; // the start of tool-call markup that sometimes leaks into the text
const MAX_TOOLS_PER_STEP = 4;
const MAX_HISTORY_TURNS = 8;
const MAX_TOKENS = { voice: 220, text: 420, investigate: 520 };
const MAX_NUDGES = 2;
// A short reply that promises to do something instead of doing it. "I can only search for..." is a refusal, not a promise.
export const PROMISE_PATTERN = /\b(i can(?!not|'t| only| not)|i could(?! not|n't)|i'll|i will|let me|shall i)\b[^.?!]*\b(run|check|look|find|search|calculate|work out|pull)\b/i;
const PROMISE_MAX_CHARS = 120;
export const INVESTIGATE_TEXT = "Look into my finances on your own and come back with the one best thing I can do, checked and ready for me to approve.";

type Settled = { call: ToolCall; outcome: ToolOutcome; startedAtMs: number; tookMs: number };

// Yields each tool result the moment it finishes, whatever order the tools were started in.
async function* inCompletionOrder<T>(tasks: Promise<T>[]): AsyncGenerator<T> {
  const pending = new Map(tasks.map((task, index) => [index, task.then((value) => ({ index, value }))]));
  while (pending.size) {
    const { index, value } = await Promise.race(pending.values());
    pending.delete(index);
    yield value;
  }
}

// In an investigation the model should not stop halfway. This names the step it skipped, if any.
function missingInvestigationStep(called: Set<string>, offerFound: boolean, researched: boolean): string | null {
  if (!called.has("find_patterns")) return "find_patterns";
  if (researched && offerFound && !called.has("run_scenario")) return "run_scenario (use the monthly saving search_offers reported, over 5 years)";
  if (!called.has("explain_concept")) return "explain_concept";
  if (researched && offerFound && !called.has("prepare_action")) return "prepare_action (kind switch_contract)";
  return null;
}

export async function* runTurn(request: AgentRequest, signal?: AbortSignal, sttMs: number | null = null): AsyncGenerator<SisuEvent> {
  const turnStarted = Date.now();
  const sinceStart = () => Date.now() - turnStarted;
  const config = getConfig();
  const customer = findCustomer(request.customerId);
  const overview = buildOverview(request.customerId);
  if (!customer || !overview) {
    yield { type: "error", message: "We could not find that customer." };
    return;
  }
  const investigate = request.investigate === true;
  const turnId = crypto.randomUUID();
  const memory = getMemory(request.customerId);
  let cashFlowCache: CashFlow | null = null;
  const cashFlow = () => (cashFlowCache ??= buildCashFlow(overview));

  yield { type: "start", turnId, provider: config.provider, model: config.model.name, mock: config.isMock };

  // Rule 1: start slow research now if the words suggest it. Nothing here is awaited.
  // An investigation almost always ends at a bill, so it starts research for the strongest bill lead at once.
  const leadBill = investigate ? (findPatterns(overview, cashFlow()).find((p) => p.billType)?.billType ?? null) : null;
  const guess = leadBill ? { billType: leadBill, reason: `An investigation usually needs live ${leadBill} offers, so research started early.` } : speculate(request.text, request.focusBill);
  if (guess) {
    ensureResearch(guess.billType, customer.area);
    yield { type: "speculation", billType: guess.billType, reason: guess.reason };
  }

  const openingLine = investigate ? investigationFiller(overview.displayName, request.language) : null;
  if (openingLine) yield { type: "filler", text: openingLine };

  const history = (request.history ?? []).slice(-MAX_HISTORY_TURNS);
  // Text dressed up as a tool result or system message is labelled for the model, and its numbers stop counting as "the user said so".
  const forged = looksForged(request.text);
  const userTexts = forged ? [] : [...history.filter((turn) => turn.role === "user").map((turn) => turn.content), request.text];
  const sisuTexts = forged ? [] : history.filter((turn) => turn.role === "assistant").map((turn) => turn.content);
  const context: ToolContext = { customerId: request.customerId, overview, city: customer.area, memory, cashFlow, userTexts, sisuTexts, signal };
  // The demo bank's balances after what the customer approved. Their figures are receipts like any other.
  const accounts = accountsFor(request.customerId);
  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt({ overview, city: customer.area, mode: request.mode, memory, investigate, language: request.language, actions: listActions(request.customerId), accounts }) },
    ...history.map((turn) => ({ role: turn.role, content: turn.content })),
    { role: "user", content: forged ? `${request.text}\n\n${FORGED_NOTE}` : request.text },
  ];

  const splitter = createSentenceSplitter();
  const timings: TurnTimings = { sttMs, firstTokenMs: null, firstSentenceMs: null, totalMs: 0, modelSteps: [] };
  const citations: Citation[] = [];
  const toolFacts: Fact[] = [];
  const toolContents: string[] = [];
  const called = new Set<string>();
  const maxSteps = MAX_MODEL_STEPS[investigate ? "investigate" : "chat"];
  let answer = "";
  let sentenceIndex = 0;
  let stageIndex = 0;
  let fillerSent = investigate;
  // "Transfer 500 euros to my savings": the customer asked for an action and named the amount, so the first reply
  // must be the action itself, not a conversation about it. (Not when the message was dressed up as something else.)
  // The same goes for an open request for advice: it starts with a look through their history.
  // A message dressed up as a tool result gets no web search or sums to build on its made-up figures.
  const offered = forged ? TOOL_SCHEMAS.filter((schema) => schema.function.name !== "web_search" && schema.function.name !== "calculate") : TOOL_SCHEMAS;
  const firstMove = investigate || forged ? null : asksToMoveMoney(request.text) ? "prepare_action" : asksForChart(request.text) ? "show_chart" : asksForAdvice(request.text) ? "find_patterns" : null;
  let forceToolNext: boolean | string = firstMove ?? false;
  let nudges = 0;
  let offerFound = false;
  let researched = false;

  // Everything the answer's numbers may be checked against. Tool results are added as they arrive.
  const summaryFacts = [...overviewFacts(overview), ...(accounts?.facts ?? [])];
  const summaryText = customerSummary(overview, customer.area);
  const sources = (): Sources => ({ facts: [...toolFacts, ...summaryFacts], contextTexts: [summaryText, ...toolContents, ...memory.items.map((item) => item.value)], userTexts });
  const corrections: NumberCorrection[] = [];
  const providerNames: string[] = []; // every provider the offer research returned this turn
  const nameCorrections: { said: string; corrected: string }[] = [];
  const fixSlips = (text: string): string => {
    const numbers = correctNumbers(text, sources());
    const names = correctNames(numbers.text, providerNames);
    corrections.push(...numbers.corrections);
    nameCorrections.push(...names.corrections);
    return names.text;
  };

  // A sentence is checked the moment it is complete, before it is shown as a sentence or spoken.
  // A figure copied with a slipped digit is replaced by the receipt's value. A sentence that claims an action
  // that was not taken, announces work instead of doing it, or carries a number with no source trips a guard:
  // it is thrown away and the model redoes the step (see lib/agent/guards.ts).
  const standing = listActions(request.customerId).filter((action) => action.status === "awaiting_approval" || action.status === "executed_simulated");
  const kindsOf = (actions: typeof standing) => ({ switches: actions.some((action) => action.kind === "switch_contract"), transfers: actions.some((action) => action.kind !== "switch_contract") });
  const earlierActions = { ...kindsOf(standing), waiting: kindsOf(standing.filter((action) => action.status === "awaiting_approval")), done: kindsOf(standing.filter((action) => action.status === "executed_simulated")) };
  // Whether this message asks for something to be set up. If not, "I moved 500 euros" can only be a report of what was done.
  const askedToAct = asksToMoveMoney(request.text) || /\b(switch|set (it |that |this |one )?up|prepare|arrange|go ahead|do it|move|transfer)\b/i.test(request.text);
  const guard = { trip: null as Trip | null, retriesLeft: MAX_GUARD_RETRIES, accepted: [] as string[], prepared: false, toolsCalled: 0 };
  function* emitSentences(sentences: string[]): Generator<SisuEvent> {
    for (const sentence of sentences) {
      if (guard.trip) return;
      if (isMetaTalk(sentence)) continue; // meant for the app, not the customer: never shown as a sentence or spoken
      const fixed = fixSlips(sentence);
      if (guard.retriesLeft > 0) {
        const { facts, contextTexts } = sources();
        const inThisSentence = numbersIn(spelledToDigits(fixed));
        const unsourced = checkGrounding(`${guard.accepted.join(" ")} ${fixed}`, facts, contextTexts, userTexts).unverified.filter((value) => inThisSentence.includes(value));
        guard.trip = checkSentence(fixed, { toolsCalledThisTurn: guard.toolsCalled, actionPreparedThisTurn: guard.prepared, earlierActions, askedToAct, unsourced, saidSoFar: guard.accepted.join(" ") });
        if (guard.trip) return;
      }
      guard.accepted.push(fixed);
      const text = request.mode === "voice" ? forSpeech(fixed) : fixed;
      if (!text) continue;
      timings.firstSentenceMs ??= sinceStart();
      yield { type: "sentence", index: sentenceIndex++, text };
    }
  }
  const joined = (before: string, more: string): string => (before && more && !/\s$/.test(before) && !/^\s/.test(more) ? `${before} ${more}` : before + more);

  try {
    for (let step = 0; step < maxSteps; step++) {
      let toolCalls: ToolCall[] = [];
      let stepText = "";
      const isLastStep = step === maxSteps - 1;
      const stepAbort = new AbortController();
      let muted = false;
      guard.accepted = [];

      for await (const chunk of streamChat({
        messages,
        tools: isLastStep ? [] : offered, // the last step must answer in words
        maxTokens: investigate ? MAX_TOKENS.investigate : MAX_TOKENS[request.mode],
        useFastModel: step === 0,
        forceTool: isLastStep ? false : forceToolNext,
        signal: signal ? AbortSignal.any([signal, stepAbort.signal]) : stepAbort.signal,
      })) {
        if (chunk.type === "delta") {
          timings.firstTokenMs ??= sinceStart();
          // Text from an earlier step is already on screen; keep the two apart.
          const gap = !stepText && answer && !/\s$/.test(answer) && !/^\s/.test(chunk.text) ? " " : "";
          if (muted) continue; // tool-call markup has started; what follows is not for the customer
          const combined = stepText + chunk.text;
          if (BROKEN_TOOL_CALL.test(combined) && guard.retriesLeft > 0) {
            stepText = combined.split("<|")[0];
            guard.trip = BROKEN_TRIP;
            break;
          }
          const tagAt = combined.search(TOOL_TAG);
          const shown = tagAt === -1 ? chunk.text : combined.slice(stepText.length, tagAt);
          muted = tagAt !== -1;
          stepText += shown;
          if (!shown) continue;
          yield { type: "delta", text: gap + shown };
          yield* emitSentences(splitter.push(gap + shown));
          if (guard.trip) break;
        } else {
          toolCalls = chunk.toolCalls.slice(0, MAX_TOOLS_PER_STEP);
          timings.modelSteps = [...timings.modelSteps, { model: chunk.model, provider: chunk.provider, usedBackup: chunk.usedBackup, firstTokenMs: chunk.firstTokenMs, totalMs: chunk.totalMs }];
        }
      }
      forceToolNext = false;
      if (!guard.trip) yield* emitSentences(splitter.flush()); // the last sentence of the step is checked too

      // A guard tripped: stop this step, keep only the sentences that passed, and send the model back to do it properly.
      if (guard.trip) {
        const trip = guard.trip;
        stepAbort.abort();
        splitter.flush();
        guard.trip = null;
        guard.retriesLeft -= 1;
        forceToolNext = trip.forceTool;
        const kept = guard.accepted.join(" ");
        answer = joined(answer, kept);
        timings.retries = [...(timings.retries ?? []), trip.kind];
        console.error(`[agent] guard tripped (${trip.kind}); redoing the step`);
        yield { type: "replace", text: answer };
        // What passed has already been shown or spoken, so the model is told to carry on from it, not start again.
        messages.push({ role: "assistant", content: kept || "(nothing said yet)" }, { role: "user", content: kept ? `${APP_NOTE} ${trip.nudge} The customer has already heard: "${kept}". Do not say that again; carry on from there.` : `${APP_NOTE} ${trip.nudge}` });
        continue;
      }
      answer = joined(answer, stepText);

      // Rule 4: no tool calls means the model had what it needed. The turn ends here,
      // and any speculative research simply stays in the cache.
      if (!toolCalls.length) {
        const missing = investigate && !isLastStep && nudges < MAX_NUDGES ? missingInvestigationStep(called, offerFound, researched) : null;
        if (missing) {
          nudges += 1;
          yield* emitSentences(splitter.flush());
          messages.push({ role: "assistant", content: stepText || "(working)" }, { role: "user", content: `Keep going with the investigation: call ${missing} now, then continue.` });
          continue;
        }
        // Guard: sometimes the model says "I can run that for you" and stops. Make it follow through once.
        // The same goes when the question was clearly about a better deal and it answered without searching.
        const promised = stepText.length < PROMISE_MAX_CHARS && PROMISE_PATTERN.test(stepText);
        if (!investigate && step === 0 && (promised || guess)) {
          yield* emitSentences(splitter.flush());
          messages.push({ role: "assistant", content: stepText }, { role: "user", content: guess ? `Go ahead: call search_offers for ${guess.billType} now, then answer with the result.` : "Go ahead: call the tool now, then answer with the result." });
          continue;
        }
        break;
      }

      yield* emitSentences(splitter.flush());
      messages.push({ role: "assistant", content: stepText || null, tool_calls: toolCalls });

      // Rule 6: if offer research was asked for and is not ready, say so at once instead of going quiet.
      for (const call of toolCalls) {
        const args = parseArgs(call);
        called.add(call.function.name);
        guard.toolsCalled += 1;
        yield { type: "tool_start", id: call.id, name: call.function.name, args, label: activityLabel(call) };
        // Deeper research takes a few seconds: say so, so a voice conversation never goes quiet.
        if (call.function.name === "web_search" && args.deep === true && !fillerSent && !stepText.trim()) {
          fillerSent = true;
          const line = researchFiller(request.language);
          if (line) yield { type: "filler", text: line };
        }
        const billType = call.function.name === "search_offers" ? billTypeOf(args) : null;
        if (!billType) continue;
        const { key } = ensureResearch(billType, customer.area);
        if (!fillerSent && !stepText.trim() && !isResearchReady(key)) {
          fillerSent = true;
          const line = offerFiller(billType, customer.area, request.language);
          if (line) yield { type: "filler", text: line };
        }
      }

      // Rule 7: every tool the model asked for in this step runs at the same time.
      const tasks = toolCalls.map(async (call): Promise<Settled> => {
        const startedAtMs = sinceStart();
        const outcome = await executeTool(call, context).catch((error): ToolOutcome => {
          console.error(`[agent] tool ${call.function.name} threw`, error);
          return failure("finance", "That tool hit an unexpected problem.");
        });
        return { call, outcome, startedAtMs, tookMs: sinceStart() - startedAtMs };
      });

      const results = new Map<string, ToolOutcome>();
      for await (const { call, outcome, startedAtMs, tookMs } of inCompletionOrder(tasks)) {
        results.set(call.id, outcome);
        citations.push(...outcome.citations.filter((c) => !citations.some((seen) => seen.url === c.url)));
        toolFacts.push(...outcome.facts);
        toolContents.push(outcome.content);
        if (outcome.research) {
          providerNames.push(...outcome.research.offers.map((offer) => offer.provider));
          researched = true;
          offerFound ||= outcome.research.best !== null;
        }
        const trace: ToolTrace = { id: call.id, name: call.function.name, args: parseArgs(call), source: outcome.source, startedAtMs, tookMs, ok: outcome.ok, summary: outcome.summary, joinedPrefetch: outcome.joinedPrefetch };
        yield { type: "tool_end", trace };
        if (outcome.research) yield { type: "research", result: outcome.research };
        for (const draft of outcome.stages) {
          const stage: Stage = { ...draft, id: `${turnId}:${stageIndex++}`, toolCallId: call.id, atMs: sinceStart(), facts: draft.facts ?? outcome.facts };
          yield { type: "stage", stage };
        }
        if (outcome.visual) yield { type: "visual", visual: outcome.visual };
        if (outcome.teaching) yield { type: "teaching", card: outcome.teaching };
        if (outcome.action) {
          guard.prepared = true;
          yield { type: "action", action: outcome.action };
        }
        if (outcome.memory) yield { type: "memory", item: outcome.memory };
      }
      // Tool results go back in the order the model asked for them.
      messages.push(...toolCalls.map((call): ChatMessage => ({ role: "tool", tool_call_id: call.id, content: results.get(call.id)?.content ?? "{}" })));
      if (stepText.trim()) messages.push({ role: "user", content: "(Note from the app: the customer has already heard what you said before the tool ran. Do not repeat it. Carry on from the result.)" });
    }

    yield* emitSentences(splitter.flush());

    // Every number in the answer is checked against the receipts before the turn is declared done.
    const finalText = correctNames(correctNumbers(isMetaTalk(answer) ? withoutMetaTalk(answer.split("<|")[0]) : answer.split("<|")[0], sources()).text, providerNames).text;
    const { facts: allFacts, contextTexts } = sources();
    const grounding = { ...checkGrounding(finalText, allFacts, contextTexts, userTexts, corrections), ...(nameCorrections.length ? { nameCorrections } : {}) };
    if (corrections.length) console.error(`[agent] corrected slipped figures: ${corrections.map((c) => `${c.said} -> ${c.corrected}`).join(", ")}`);
    const usedIds = new Set(grounding.numbers.map((n) => n.factId));
    const facts = [...toolFacts, ...summaryFacts.filter((f) => usedIds.has(f.id))].filter((f, index, all) => all.findIndex((other) => other.id === f.id) === index);
    if (!grounding.ok) console.error(`[agent] ungrounded numbers in answer: ${grounding.unverified.join(", ")}`);
    yield { type: "grounding", grounding, facts };

    timings.totalMs = sinceStart();
    yield { type: "done", text: finalText.trim(), citations, timings };
  } catch (error) {
    if (signal?.aborted) return; // the user interrupted; nothing to report
    console.error("[agent] turn failed", error);
    yield { type: "error", message: (error as Error).message || "Sisu could not answer just now. Please try again." };
  }
}
