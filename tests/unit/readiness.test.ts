// The readiness check: one real call per service, an honest verdict, and no secrets in the answer.
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { freshState, stubFetch } from "./helpers";
import { GET as readyRoute } from "@/app/api/health/ready/route";
import { forgetReadiness, readiness } from "@/lib/agent/readiness";
import type { ReadinessReport } from "@/lib/types";

const LIVE_ENV = { MODEL_PROVIDER: "verda", MODEL_FALLBACK: "nvidia", VERDA_BASE_URL: "http://gpu.test/v1", VERDA_API_KEY: "verda-secret-key", NEMOTRON_BASE_URL: "http://backup.test/v1", NEMOTRON_API_KEY: "nvidia-secret-key", EXA_API_KEY: "exa-secret-key", CONTEXT_DEV_API_KEY: "context-secret-key", ELEVENLABS_API_KEY: "eleven-secret-key" };
const saved: Record<string, string | undefined> = {};
function useLiveEnv(overrides: Record<string, string> = {}) {
  for (const [name, value] of Object.entries({ ...LIVE_ENV, ...overrides })) {
    saved[name] = process.env[name];
    process.env[name] = value;
  }
  forgetReadiness();
}
let restoreFetch = () => {};
afterEach(() => {
  restoreFetch();
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  forgetReadiness();
});

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
// Every service answers well unless `down` names it.
function services(down: string[] = [], calls: string[] = []) {
  return stubFetch((url) => {
    calls.push(url);
    const name = url.includes("gpu.test") ? "model" : url.includes("backup.test") ? "backup" : url.includes("exa.ai") ? "exa" : url.includes("context.dev") ? "context" : url.includes("elevenlabs") ? "eleven" : "other";
    if (down.includes(name)) return reply({ error: "down" }, 503);
    if (name === "model" || name === "backup") return reply({ choices: [{ message: { content: "ready" } }] });
    if (name === "exa") return reply({ results: [{ url: "https://example.com", title: "x" }] });
    if (name === "context") return reply({ json: { success: true, data: { title: "Example" } } });
    if (name === "eleven") return reply({ character_count: 1_000, character_limit: 127_000 });
    return reply({}, 404);
  });
}
const byId = (report: ReadinessReport, id: string) => report.checks.find((check) => check.id === id);

describe("demo readiness", () => {
  it("mock mode is ready on example data and calls nothing", async () => {
    freshState();
    forgetReadiness();
    const calls: string[] = [];
    restoreFetch = services([], calls);
    const report = await readiness({ fresh: true });
    assert.equal(report.ready, true);
    assert.equal(report.mock, true);
    assert.equal(report.voiceReady, false);
    assert.equal(calls.length, 0, "no service is called in mock mode");
    assert.ok(report.checks.filter((check) => ["model", "exa", "context-dev", "elevenlabs"].includes(check.id)).every((check) => check.status === "mock"));
    assert.equal(byId(report, "finance")?.status, "ok");
  });

  it("every service answering means ready, with one real call each and no key in the answer", async () => {
    freshState();
    useLiveEnv();
    const calls: string[] = [];
    restoreFetch = services([], calls);
    const report = await readiness({ fresh: true });
    assert.equal(report.ready, true);
    assert.equal(report.voiceReady, true);
    assert.equal(report.headline, "Ready: every service answered.");
    assert.deepEqual(report.checks.map((check) => check.id), ["model", "model-backup", "exa", "context-dev", "elevenlabs", "finance", "store"]);
    assert.ok(report.checks.every((check) => check.status === "ok" && !check.blocksDemo));
    assert.equal(calls.length, 5);
    const text = JSON.stringify(report);
    for (const secret of Object.values(LIVE_ENV).filter((value) => value.includes("secret"))) assert.ok(!text.includes(secret), "no key in the report");
    assert.ok(!text.includes("gpu.test") && !text.includes("backup.test"), "no server address in the report");
    assert.match(byId(report, "elevenlabs")?.detail ?? "", /126 thousand characters/);
  });

  it("our GPU down with the backup up is still ready, and says who stands in", async () => {
    freshState();
    useLiveEnv();
    restoreFetch = services(["model"]);
    const report = await readiness({ fresh: true });
    assert.equal(report.ready, true);
    assert.equal(byId(report, "model")?.status, "down");
    assert.equal(byId(report, "model")?.blocksDemo, false);
    assert.match(report.headline, /stand-in for NVIDIA Nemotron on Verda/);
  });

  it("both models down is not ready; one page reader down is; both readers down is not", async () => {
    freshState();
    useLiveEnv();
    restoreFetch = services(["model", "backup"]);
    const noModel = await readiness({ fresh: true });
    assert.equal(noModel.ready, false);
    assert.equal(byId(noModel, "model")?.blocksDemo, true);
    assert.match(noModel.headline, /^Not ready/);

    restoreFetch();
    restoreFetch = services(["context"]);
    const oneReader = await readiness({ fresh: true });
    assert.equal(oneReader.ready, true, "Exa reads the pages when Context.dev cannot");
    assert.equal(byId(oneReader, "context-dev")?.status, "down");

    restoreFetch();
    restoreFetch = services(["context", "exa"]);
    assert.equal((await readiness({ fresh: true })).ready, false);
  });

  it("voice down leaves the demo ready and says typed questions still work; a missing key is named as such", async () => {
    freshState();
    useLiveEnv({ CONTEXT_DEV_API_KEY: "" });
    restoreFetch = services(["eleven"]);
    const report = await readiness({ fresh: true });
    assert.equal(report.ready, true);
    assert.equal(report.voiceReady, false);
    assert.match(byId(report, "elevenlabs")?.standIn ?? "", /Typed questions/);
    assert.equal(byId(report, "context-dev")?.status, "not-configured");
  });

  it("a report is reused for a minute, callers at once share one check, and the route always answers 200", async () => {
    freshState();
    useLiveEnv();
    const calls: string[] = [];
    restoreFetch = services([], calls);
    const [first, second] = await Promise.all([readiness({ fresh: true }), readiness({ fresh: true })]);
    assert.equal(calls.length, 5, "two callers, one check");
    assert.equal(first.checkedAt, second.checkedAt);
    const again = await readiness();
    assert.equal(calls.length, 5, "the kept report costs no calls");
    assert.equal(again.checkedAt, first.checkedAt);

    restoreFetch();
    restoreFetch = services(["model", "backup", "exa", "context", "eleven"]);
    const response = await readyRoute(new Request("http://localhost/api/health/ready?fresh=1", { headers: { "x-forwarded-for": crypto.randomUUID() } }));
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as ReadinessReport).ready, false);
  });
});

for (const content of ["", "   "]) {
  it(`blank model output ${JSON.stringify(content)} cannot pass readiness on either provider`, async () => {
    freshState();
    useLiveEnv();
    restoreFetch = services();
    const normal = globalThis.fetch;
    globalThis.fetch = (async (input, init) => String(input).includes("/chat/completions")
      ? reply({ choices: [{ message: { content } }] }) : normal(input, init)) as typeof fetch;
    const report = await readiness({ fresh: true });
    assert.equal(report.ready, false);
    assert.equal(byId(report, "model")?.status, "down");
    assert.equal(byId(report, "model-backup")?.status, "down");
  });
}

it("Gemini fallback is named accurately and discloses aggregate transfer", async () => {
  freshState();
  useLiveEnv({ MODEL_FALLBACK: "gemini", GEMINI_BASE_URL: "http://backup.test/v1", GEMINI_MODEL: "gemini-test" });
  restoreFetch = services(["model"]);
  const report = await readiness({ fresh: true });
  assert.equal(report.ready, true);
  const standIn = byId(report, "model")?.standIn ?? "";
  assert.match(standIn, /Google \(gemini-test\)/);
  assert.match(standIn, /aggregates are sent to that provider/);
  assert.doesNotMatch(standIn, /same model/);
});
