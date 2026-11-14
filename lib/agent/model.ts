// Streaming chat client for any OpenAI-compatible endpoint (NVIDIA Build, a Verda vLLM server, Gemini).
import { recordFailure, recordSuccess, shouldSkip } from "./breaker";
import { type ModelEndpoint, getConfig, missingKey } from "./config";
import { mockStream } from "./mock";

export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type ToolSchema = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

export type ModelChunk =
  | { type: "delta"; text: string }
  | { type: "end"; toolCalls: ToolCall[]; model: string; provider: string; usedBackup: boolean; firstTokenMs: number | null; totalMs: number };

// Internal: the first token of any kind has arrived (text or the start of a tool call). The stall timer stops here,
// so a model that is busy writing a long tool call is never mistaken for one that has hung.
type RawChunk = ModelChunk | { type: "started" };

export type StreamOptions = {
  messages: ChatMessage[];
  tools: ToolSchema[];
  maxTokens: number;
  useFastModel?: boolean;
  forceTool?: boolean | string; // true: the reply must be a tool call. A name: it must be that tool. Used when the model described an action instead of taking it
  signal?: AbortSignal;
};

const MODEL_TIMEOUT_MS = 25_000;
// If the main model has produced nothing by now, the backup takes the turn. Measured first tokens on our GPU:
// p50 0.26 s, p95 0.34 s alone, and up to about 1.5 s with twelve turns at once. Two seconds leaves room for a
// busy GPU without making a customer wait long for a dead one. MODEL_FIRST_TOKEN_LIMIT_MS overrides it.
const firstTokenLimitMs = (): number => Number(process.env.MODEL_FIRST_TOKEN_LIMIT_MS) || 2_000;

// MODEL_FORCE_TOOL=off switches forcing off, for a model server that does not support it.
function toolChoice(force: StreamOptions["forceTool"]): unknown {
  if (!force || process.env.MODEL_FORCE_TOOL === "off") return "auto";
  return typeof force === "string" ? { type: "function", function: { name: force } } : "required";
}

type Delta = {
  content?: string | null;
  tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
};

// Yields text as it arrives, then one "end" chunk carrying any tool calls the model asked for.
// Stall protection: if the main model errors or stays silent past the first-token limit, the same request also
// goes to the backup model (the same Nemotron on another host). Whichever host starts first takes the step, and
// the trace says which. A slow main model is not cancelled before the backup has started, so a slow start still
// gets its answer when the backup is down too.
export async function* streamChat(options: StreamOptions): AsyncGenerator<ModelChunk> {
  const config = getConfig();
  if (config.isMock) {
    yield* mockStream(options.messages, options);
    return;
  }
  const backup = config.fallbackModel;
  if (!backup) {
    yield* withoutStarted(streamFrom(config.model, options, options.signal, false));
    return;
  }

  const main: Lane = { endpoint: config.model, isBackup: false };
  const spare: Lane = { endpoint: backup, isBackup: true };
  // During an outage the first failed step opens the breaker; later steps ask the backup first, with no wait.
  const [lead, other] = shouldSkip(config.model) ? [spare, main] : [main, spare];
  yield* withoutStarted(firstToStart(lead, other, options));
}

type Lane = { endpoint: ModelEndpoint; isBackup: boolean };
type Runner = { lane: Lane; cancel: AbortController; chunks: AsyncGenerator<RawChunk>; first: Promise<IteratorResult<RawChunk>> };
type Start = { runner: Runner; first: IteratorResult<RawChunk> };

function begin(lane: Lane, options: StreamOptions): Runner {
  const cancel = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, cancel.signal]) : cancel.signal;
  const chunks = streamFrom(lane.endpoint, options, signal, lane.isBackup);
  const first = chunks.next();
  first.catch(() => undefined); // handled where it is awaited; this stops a late failure being reported twice
  return { lane, cancel, chunks, first };
}

// The breaker only follows the main model: the backup is asked whenever the main one is not answering.
function note(lane: Lane, answered: boolean): void {
  if (lane.isBackup) return;
  if (answered) recordSuccess(lane.endpoint);
  else recordFailure(lane.endpoint);
}

// How long both hosts may stay silent before each is asked once more. A hosted model sometimes hangs on one request
// and answers the next at once (measured live on 14 Nov with our GPU unreachable: one turn failed after 25 s, the
// next was answered in 1 s). MODEL_REASK_LIMIT_MS overrides it.
const reAskLimitMs = (): number => Number(process.env.MODEL_REASK_LIMIT_MS) || 5_000;

type Waited = Start | { silent: true } | { failed: unknown };

// Waits for the first of `runners` to start. `silent` when none has started within `ms` (null waits for as long
// as the requests live); `failed`, with the error of the one asked last, when every one of them has failed.
async function firstOf(runners: Runner[], ms: number | null): Promise<Waited> {
  const anyStart = Promise.any(runners.map((runner) => runner.first.then((first): Start => ({ runner, first })))).catch((error: unknown): Waited => {
    const errors: unknown[] = error instanceof AggregateError ? error.errors : [error];
    return { failed: errors[errors.length - 1] };
  });
  if (ms === null) return anyStart;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const silence = new Promise<Waited>((resolve) => {
    timer = setTimeout(() => resolve({ silent: true }), ms);
  });
  try {
    return await Promise.race([anyStart, silence]);
  } finally {
    clearTimeout(timer);
  }
}

// Asks `leadLane`. If it fails or is silent past the first-token limit, `otherLane` is asked as well, and if both
// then stay silent each is asked once more. Whichever request starts first takes the step; the rest are cancelled.
// Before this, a silent host was cancelled at the limit, so a main model that was merely slow lost its turn to a
// backup that could be down (measured live on 14 Nov: three failed turns of 27 to 57 s with a healthy GPU).
async function* firstToStart(leadLane: Lane, otherLane: Lane, options: StreamOptions): AsyncGenerator<RawChunk> {
  const runners: Runner[] = [begin(leadLane, options)];
  const limit = firstTokenLimitMs();
  let waited = await firstOf(runners, limit);
  if (!("runner" in waited)) {
    if (options.signal?.aborted) throw "failed" in waited ? waited.failed : new DOMException("The request was cancelled.", "AbortError");
    note(leadLane, false);
    const reason = "failed" in waited ? (waited.failed as Error).message : `no reply within ${limit} ms`;
    console.error(`[agent] ${leadLane.endpoint.provider} model failed or stalled (${reason}); asking ${otherLane.endpoint.provider}`);
    runners.push(begin(otherLane, options));
    waited = await firstOf(runners, reAskLimitMs());
    if ("silent" in waited) {
      console.error(`[agent] neither model host has started; asking both once more`);
      runners.push(begin(leadLane, options), begin(otherLane, options));
      waited = await firstOf(runners, null);
    }
  }
  if ("failed" in waited) throw waited.failed;
  if ("silent" in waited) throw new Error("The reasoning model did not answer."); // not reachable: the last wait has no limit
  const started: Start = waited;
  for (const other of runners) if (other !== started.runner) other.cancel.abort();
  if (runners.length > 1 && started.runner === runners[0]) console.error(`[agent] ${leadLane.endpoint.provider} model answered after all; staying with it`);

  const { runner, first } = started;
  if (first.done) return;
  note(runner.lane, true);
  // The host has started. If its connection then breaks before it has said anything to the user (for example
  // while it was still writing a tool call), the other host can take the whole step over unnoticed.
  let saidSomething = false;
  try {
    saidSomething = first.value.type === "delta";
    yield first.value;
    for await (const chunk of runner.chunks) {
      saidSomething ||= chunk.type === "delta";
      yield chunk;
    }
  } catch (error) {
    if (options.signal?.aborted || saidSomething) throw error;
    note(runner.lane, false);
    const takeover = runner.lane === leadLane ? otherLane : leadLane;
    console.error(`[agent] ${runner.lane.endpoint.provider} model broke off mid-step (${(error as Error).message}); switching to ${takeover.endpoint.provider}`);
    yield* streamFrom(takeover.endpoint, options, options.signal, takeover.isBackup);
  }
}

async function* withoutStarted(chunks: AsyncGenerator<RawChunk>): AsyncGenerator<ModelChunk> {
  for await (const chunk of chunks) if (chunk.type !== "started") yield chunk;
}

async function* streamFrom(endpoint: ModelEndpoint, options: StreamOptions, outerSignal: AbortSignal | undefined, usedBackup: boolean): AsyncGenerator<RawChunk> {
  const { thinking } = getConfig();
  const prefix = { nvidia: "NEMOTRON", verda: "VERDA", gemini: "GEMINI", mock: "" }[endpoint.provider];
  if (!endpoint.baseUrl) throw missingKey("The reasoning model", `${prefix}_BASE_URL`);
  if (!endpoint.apiKey) throw missingKey("The reasoning model", `${prefix}_API_KEY`);

  const model = options.useFastModel && endpoint.fastName ? endpoint.fastName : endpoint.name;
  const started = Date.now();
  const timeout = AbortSignal.timeout(MODEL_TIMEOUT_MS);
  const signal = outerSignal ? AbortSignal.any([outerSignal, timeout]) : timeout;

  const response = await fetch(`${endpoint.baseUrl}/chat/completions`, {
    method: "POST",
    signal,
    headers: { Authorization: `Bearer ${endpoint.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: options.messages,
      stream: true,
      max_tokens: options.maxTokens,
      temperature: 0.3,
      ...(options.tools.length ? { tools: options.tools, tool_choice: toolChoice(options.forceTool) } : {}),
      ...(endpoint.sendsThinkingFlag ? { chat_template_kwargs: { enable_thinking: thinking } } : {}),
    }),
  });
  if (!response.ok || !response.body) {
    const detail = (await response.text().catch(() => "")).slice(0, 300);
    console.error(`[agent] ${endpoint.provider} model ${model} returned ${response.status}: ${detail}`);
    throw new Error(`The reasoning model returned an error (${response.status}).`);
  }

  const calls = new Map<number, { id: string; name: string; args: string }>();
  let firstTokenMs: number | null = null;
  let buffer = "";
  const decoder = new TextDecoder();

  for await (const bytes of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(bytes, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const delta = parseDelta(line);
      if (!delta) continue;
      if (firstTokenMs === null && (delta.content || delta.tool_calls?.length)) {
        firstTokenMs = Date.now() - started;
        yield { type: "started" };
      }
      if (delta.content) yield { type: "delta", text: delta.content };
      for (const part of delta.tool_calls ?? []) {
        const current = calls.get(part.index) ?? { id: "", name: "", args: "" };
        calls.set(part.index, {
          id: part.id || current.id,
          name: current.name + (part.function?.name ?? ""),
          args: current.args + (part.function?.arguments ?? ""),
        });
      }
    }
  }

  const toolCalls: ToolCall[] = [...calls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, call]) => ({
      id: call.id || `call_${index}`,
      type: "function",
      function: { name: call.name, arguments: call.args || "{}" },
    }));
  yield { type: "end", toolCalls, model, provider: endpoint.provider, usedBackup, firstTokenMs, totalMs: Date.now() - started };
}

function parseDelta(line: string): Delta | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return null;
  const payload = trimmed.slice(5).trim();
  if (!payload || payload === "[DONE]") return null;
  try {
    const parsed = JSON.parse(payload) as { choices?: { delta?: Delta }[] };
    return parsed.choices?.[0]?.delta ?? null;
  } catch {
    return null; // a partial or keep-alive line; the stream carries on
  }
}

// Sends the prompt once and throws the answer away. vLLM keeps the processed prompt in its cache, so the
// user's first real question skips about 2 s of prompt reading. Only the main model is primed.
export async function primeModel(messages: ChatMessage[], tools: ToolSchema[]): Promise<void> {
  const config = getConfig();
  if (config.isMock) return;
  try {
    for await (const chunk of streamFrom(config.model, { messages, tools, maxTokens: 1 }, undefined, false)) void chunk;
  } catch (error) {
    console.error(`[agent] could not prime the ${config.model.provider} model:`, (error as Error).message);
  }
}
