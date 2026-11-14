import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { sse, stubFetch } from "./helpers";
import { breakerStatus, resetBreakers } from "@/lib/agent/breaker";
import { getConfig } from "@/lib/agent/config";
import { type ModelChunk, streamChat } from "@/lib/agent/model";

const VERDA = "http://verda.test/v1";
const NVIDIA = "http://nvidia.test/v1";
const text = (content: string) => ({ choices: [{ delta: { content } }] });
const toolPart = (index: number, part: { id?: string; name?: string; arguments?: string }) => ({ choices: [{ delta: { tool_calls: [{ index, id: part.id, function: { name: part.name, arguments: part.arguments } }] } }] });

async function run(): Promise<{ text: string; end: Extract<ModelChunk, { type: "end" }> }> {
  let said = "";
  let end: Extract<ModelChunk, { type: "end" }> | null = null;
  for await (const chunk of streamChat({ messages: [{ role: "user", content: "Hi" }], tools: [], maxTokens: 50 })) {
    if (chunk.type === "delta") said += chunk.text;
    else end = chunk;
  }
  assert.ok(end, "the stream ended with a summary chunk");
  return { text: said, end };
}

// A response whose body sends some lines and then breaks, as a dropped connection does.
function breaksAfter(lines: unknown[]): Response {
  const encoder = new TextEncoder();
  let sent = false;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) return controller.error(new Error("connection reset"));
        sent = true;
        controller.enqueue(encoder.encode(lines.map((line) => `data: ${JSON.stringify(line)}\n\n`).join("")));
      },
    }),
  );
}

// A host that accepts the request and never answers. It only ends when the request is cancelled.
function hangs(init: RequestInit | undefined, onCancel: () => void = () => {}): Promise<Response> {
  return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => (onCancel(), reject(new DOMException("aborted", "AbortError")))));
}

// A host that answers after `ms`, unless the request is cancelled first.
function after(ms: number, answer: () => Response, init: RequestInit | undefined, onCancel: () => void = () => {}): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const timer = setTimeout(() => resolve(answer()), ms);
    init?.signal?.addEventListener("abort", () => (clearTimeout(timer), onCancel(), reject(new DOMException("aborted", "AbortError"))));
  });
}

describe("model client: failover between our GPU and the backup", () => {
  let restore = () => {};
  const saved = { ...process.env };
  beforeEach(() => {
    Object.assign(process.env, { MODEL_PROVIDER: "verda", MODEL_FALLBACK: "nvidia", VERDA_BASE_URL: VERDA, VERDA_API_KEY: "test", NEMOTRON_BASE_URL: NVIDIA, NEMOTRON_API_KEY: "test", MODEL_FIRST_TOKEN_LIMIT_MS: "120" });
    resetBreakers();
  });
  afterEach(() => {
    restore();
    for (const key of ["MODEL_PROVIDER", "MODEL_FALLBACK", "VERDA_BASE_URL", "VERDA_API_KEY", "NEMOTRON_BASE_URL", "NEMOTRON_API_KEY", "MODEL_FIRST_TOKEN_LIMIT_MS", "MODEL_REASK_LIMIT_MS"]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("uses our own GPU when it answers, with thinking switched off", async () => {
    const calls: string[] = [];
    let body: Record<string, unknown> = {};
    restore = stubFetch((url, init) => {
      calls.push(url);
      body = JSON.parse(String(init?.body));
      return sse([text("Hello "), text("there."), "[DONE]"]);
    });
    const { text: said, end } = await run();
    assert.equal(said, "Hello there.");
    assert.deepEqual([end.provider, end.usedBackup], ["verda", false]);
    assert.deepEqual(calls, [`${VERDA}/chat/completions`]);
    assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
    assert.equal(body.stream, true);
  });

  it("switches to the backup when our GPU returns an error", async () => {
    restore = stubFetch((url) => (url.startsWith(VERDA) ? new Response("overloaded", { status: 503 }) : sse([text("Backup here."), "[DONE]"])));
    const { text: said, end } = await run();
    assert.equal(said, "Backup here.");
    assert.deepEqual([end.provider, end.usedBackup], ["nvidia", true]);
  });

  it("switches to the backup when our GPU cannot be reached at all", async () => {
    restore = stubFetch((url) => {
      if (url.startsWith(VERDA)) throw new TypeError("fetch failed");
      return sse([text("Backup here."), "[DONE]"]);
    });
    assert.equal((await run()).end.usedBackup, true);
  });

  it("switches to the backup when our GPU accepts the request and then says nothing", async () => {
    let verdaAborted = false;
    restore = stubFetch(
      (url, init) =>
        url.startsWith(VERDA)
          ? new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => ((verdaAborted = true), reject(new DOMException("aborted", "AbortError")))))
          : sse([text("Backup here."), "[DONE]"]),
    );
    const started = Date.now();
    const { end } = await run();
    assert.equal(end.usedBackup, true);
    assert.ok(Date.now() - started < 1_000, "the switch happens at the stall limit, not at the long timeout");
    assert.equal(verdaAborted, true, "the stalled request is cancelled, not left running");
  });

  it("does NOT switch while our GPU is busy writing a long tool call", async () => {
    const encoder = new TextEncoder();
    const calls: string[] = [];
    restore = stubFetch((url) => {
      calls.push(url);
      const parts = [toolPart(0, { id: "c1", name: "search_offers", arguments: '{"bill' }), toolPart(0, { arguments: 'Type":"elec' }), toolPart(0, { arguments: 'tricity"}' })];
      let index = 0;
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (index >= parts.length) return controller.close();
            if (index > 0) await new Promise((resolve) => setTimeout(resolve, 150)); // slower than the stall limit, but alive
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(parts[index++])}\n\n`));
          },
        }),
      );
    });
    const { end } = await run();
    assert.deepEqual(calls, [`${VERDA}/chat/completions`]);
    assert.equal(end.usedBackup, false);
    assert.deepEqual(end.toolCalls, [{ id: "c1", type: "function", function: { name: "search_offers", arguments: '{"billType":"electricity"}' } }]);
  });

  it("hands a step to the backup if our GPU's connection breaks before it has said anything", async () => {
    restore = stubFetch((url) => (url.startsWith(VERDA) ? breaksAfter([toolPart(0, { id: "c1", name: "get_spending", arguments: '{"from":' })]) : sse([toolPart(0, { id: "b1", name: "get_spending", arguments: '{"from":"2026-09-01","to":"2026-09-30"}' }), "[DONE]"])));
    const { end } = await run();
    assert.equal(end.usedBackup, true);
    assert.equal(end.toolCalls[0].id, "b1");
    assert.doesNotThrow(() => JSON.parse(end.toolCalls[0].function.arguments));
  });

  it("does not replay an answer the user has already started hearing", async () => {
    restore = stubFetch((url) => (url.startsWith(VERDA) ? breaksAfter([text("You can spend ")]) : sse([text("Backup."), "[DONE]"])));
    await assert.rejects(run());
  });

  // Regression: live stall test. Every model step waited the full stall limit, so a two-step turn took over 4 s.
  it("after one failure, later steps go straight to the backup without waiting on the dead host", async () => {
    const calls: string[] = [];
    restore = stubFetch((url, init) => {
      calls.push(url);
      if (url.startsWith(VERDA)) return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
      return sse([text("Backup."), "[DONE]"]);
    });
    await run(); // pays the stall limit once
    const started = Date.now();
    const second = await run();
    const third = await run();
    assert.ok(Date.now() - started < 100, "no waiting on the later steps");
    assert.deepEqual([second.end.usedBackup, third.end.usedBackup], [true, true]);
    assert.equal(calls.filter((url) => url === `${VERDA}/chat/completions`).length, 1, "the dead host is asked once, not on every step");
    assert.equal(breakerStatus(getConfig().model).open, true);
  });

  it("goes back to our own GPU once it answers again", async () => {
    let verdaUp = false;
    restore = stubFetch((url) => {
      if (url.startsWith(VERDA) && !verdaUp) return new Response("down", { status: 503 });
      return sse([text(url.startsWith(VERDA) ? "Own GPU." : "Backup."), "[DONE]"]);
    });
    assert.equal((await run()).end.provider, "nvidia");
    verdaUp = true;
    resetBreakers(); // stands in for the background probe finding the host healthy after its cooldown
    assert.equal((await run()).end.provider, "verda");
    assert.equal(breakerStatus(getConfig().model).open, false);
  });

  // Regression: 14 Nov, live. Our GPU took over 2 s to start a few times while NVIDIA's hosted backup was down.
  // The slow request was cancelled at the limit and the turn waited 25 s on the dead backup, then failed.
  it("a slow start on our GPU still gets its answer when the backup says nothing", async () => {
    let backupCancelled = false;
    restore = stubFetch((url, init) => (url.startsWith(VERDA) ? after(300, () => sse([text("Own GPU, a bit late."), "[DONE]"]), init) : hangs(init, () => (backupCancelled = true))));
    const started = Date.now();
    const { text: said, end } = await run();
    assert.equal(said, "Own GPU, a bit late.");
    assert.deepEqual([end.provider, end.usedBackup], ["verda", false]);
    assert.ok(Date.now() - started < 1_500, "answered when the GPU started, not at the long timeout");
    assert.equal(backupCancelled, true, "the backup request is cancelled once the GPU has answered");
    assert.equal(breakerStatus(getConfig().model).open, false, "the GPU counts as healthy again");
  });

  it("a slow start on our GPU still gets its answer when the backup returns an error", async () => {
    restore = stubFetch((url, init) => (url.startsWith(VERDA) ? after(300, () => sse([text("Own GPU."), "[DONE]"]), init) : new Response("down", { status: 503 })));
    const { text: said, end } = await run();
    assert.equal(said, "Own GPU.");
    assert.equal(end.usedBackup, false);
  });

  it("when our GPU is slow and the backup is quicker, the backup takes the step and the slow request is cancelled", async () => {
    let verdaCancelled = false;
    restore = stubFetch((url, init) => (url.startsWith(VERDA) ? after(2_000, () => sse([text("Too late."), "[DONE]"]), init, () => (verdaCancelled = true)) : sse([text("Backup."), "[DONE]"])));
    const started = Date.now();
    const { text: said, end } = await run();
    assert.equal(said, "Backup.");
    assert.equal(end.usedBackup, true);
    assert.ok(Date.now() - started < 1_000);
    assert.equal(verdaCancelled, true);
  });

  it("while the backup is in charge and then goes down, our GPU is asked again instead of failing the turn", async () => {
    let verdaUp = false;
    restore = stubFetch((url, init) => {
      if (url.startsWith(VERDA)) return verdaUp ? sse([text("Own GPU."), "[DONE]"]) : hangs(init);
      return verdaUp ? hangs(init) : sse([text("Backup."), "[DONE]"]);
    });
    assert.equal((await run()).end.provider, "nvidia"); // the GPU stalls: the breaker opens and the backup leads
    assert.equal(breakerStatus(getConfig().model).open, true);
    verdaUp = true; // now the other way round: the backup is silent and the GPU is back
    const { text: said, end } = await run();
    assert.equal(said, "Own GPU.");
    assert.deepEqual([end.provider, end.usedBackup], ["verda", false]);
    assert.equal(breakerStatus(getConfig().model).open, false);
  });

  it("stops both requests when the customer leaves during a slow start", async () => {
    const cancelled: string[] = [];
    restore = stubFetch((url, init) => hangs(init, () => cancelled.push(url.startsWith(VERDA) ? "verda" : "nvidia")));
    const leave = new AbortController();
    const turn = (async () => {
      for await (const chunk of streamChat({ messages: [{ role: "user", content: "Hi" }], tools: [], maxTokens: 50, signal: leave.signal })) void chunk;
    })();
    await new Promise((resolve) => setTimeout(resolve, 250)); // past the stall limit: both hosts have been asked
    leave.abort();
    await assert.rejects(turn);
    assert.deepEqual(cancelled.sort(), ["nvidia", "verda"]);
  });

  // Regression: 14 Nov, live, with our GPU unreachable. One request to the hosted backup hung and the turn failed
  // after 25 s; the very next request was answered in 1 s.
  it("with our GPU unreachable, a backup request that hangs is asked once more and that attempt answers", async () => {
    process.env.MODEL_REASK_LIMIT_MS = "150";
    let backupCalls = 0;
    let firstCancelled = false;
    restore = stubFetch((url, init) => {
      if (url.startsWith(VERDA)) throw new TypeError("fetch failed");
      backupCalls += 1;
      return backupCalls === 1 ? hangs(init, () => (firstCancelled = true)) : sse([text("Backup, second attempt."), "[DONE]"]);
    });
    const started = Date.now();
    const { text: said, end } = await run();
    assert.equal(said, "Backup, second attempt.");
    assert.equal(end.usedBackup, true);
    assert.ok(Date.now() - started < 1_500, "answered at the second attempt, not at the long timeout");
    assert.equal(backupCalls, 2, "asked once more, not in a loop");
    assert.equal(firstCancelled, true, "the hung request is cancelled");
  });

  it("when both hosts hang on the first request, the second attempt at our GPU answers", async () => {
    process.env.MODEL_REASK_LIMIT_MS = "150";
    const calls: string[] = [];
    restore = stubFetch((url, init) => {
      calls.push(url.startsWith(VERDA) ? "verda" : "nvidia");
      return calls.length <= 2 ? hangs(init) : url.startsWith(VERDA) ? sse([text("Own GPU, second attempt."), "[DONE]"]) : hangs(init);
    });
    const { text: said, end } = await run();
    assert.equal(said, "Own GPU, second attempt.");
    assert.equal(end.usedBackup, false);
    assert.deepEqual(calls, ["verda", "nvidia", "verda", "nvidia"]);
  });

  it("fails clearly when both hosts are down", async () => {
    restore = stubFetch(() => new Response("down", { status: 500 }));
    await assert.rejects(run(), /reasoning model returned an error/);
  });

  it("puts several tool calls back together and ignores malformed stream lines", async () => {
    restore = stubFetch(() => sse([": keep-alive", "{not json", toolPart(1, { id: "b", name: "list_bills", arguments: "{}" }), toolPart(0, { id: "a", name: "get_cash_flow" }), toolPart(0, { arguments: "{}" }), { choices: [] }, "[DONE]"]));
    const { end } = await run();
    assert.deepEqual(end.toolCalls.map((c) => [c.id, c.function.name, c.function.arguments]), [["a", "get_cash_flow", "{}"], ["b", "list_bills", "{}"]]);
  });

  it("without a backup configured, an error is reported instead of hidden", async () => {
    delete process.env.MODEL_FALLBACK;
    restore = stubFetch(() => new Response("down", { status: 500 }));
    await assert.rejects(run());
  });

  it("names the missing setting, never a key value, when a host is not configured", async () => {
    delete process.env.MODEL_FALLBACK;
    process.env.VERDA_API_KEY = "";
    restore = stubFetch(() => sse(["[DONE]"]));
    await assert.rejects(run(), /VERDA_API_KEY is empty/);
  });
});
