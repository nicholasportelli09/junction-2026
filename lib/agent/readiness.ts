// Is the demo ready right now? One real call to every service the flagship flow depends on, all at once:
// the model on our own GPU, its backup, Exa, Context.dev, ElevenLabs, the finance data and the action store.
// /api/health says what is configured; this says what answered. The report is kept for a minute so a status
// light that polls it costs almost nothing: one Exa search, one page read and two one-word model replies a minute
// at most. Never returns keys or addresses.
import { DEMO_CUSTOMERS } from "@/lib/finance/data";
import { buildOverview } from "@/lib/finance/overview";
import { auditFor } from "@/lib/store/audit";
import { storeInfo } from "@/lib/store/state";
import type { ReadinessCheck, ReadinessReport } from "@/lib/types";
import { type ModelEndpoint, getConfig } from "./config";

const KEEP_MS = 60_000;
const MODEL_TIMEOUT_MS = 8_000;
const SERVICE_TIMEOUT_MS = 9_000;
const SPONSOR: Record<string, string> = { verda: "Verda", nvidia: "NVIDIA", gemini: "Google", mock: "none" };

type Probe = { ok: boolean; detail: string };
type Slot = { at: number; report: ReadinessReport };
const holder = globalThis as unknown as { __sisuReadiness?: { last: Slot | null; running: Promise<ReadinessReport> | null } };
const memory = (holder.__sisuReadiness ??= { last: null, running: null });

// For tests: forget the kept report.
export const forgetReadiness = (): void => {
  memory.last = null;
  memory.running = null;
};

const reason = (error: unknown): string => {
  const name = (error as Error)?.name;
  return name === "TimeoutError" || name === "AbortError" ? "did not answer in time" : "could not be reached";
};

async function timed(run: () => Promise<Probe>): Promise<Probe & { latencyMs: number | null }> {
  const started = Date.now();
  try {
    const result = await run();
    return { ...result, latencyMs: Date.now() - started };
  } catch (error) {
    return { ok: false, detail: `It ${reason(error)}.`, latencyMs: null };
  }
}

// The model must write something, not only list itself: a server can be up with the model unloaded.
async function probeModel(endpoint: ModelEndpoint): Promise<Probe> {
  const response = await fetch(`${endpoint.baseUrl}/chat/completions`, {
    method: "POST",
    signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
    headers: { Authorization: `Bearer ${endpoint.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: endpoint.name, messages: [{ role: "user", content: "Reply with the word ready." }], max_tokens: 4, temperature: 0, stream: false, ...(endpoint.sendsThinkingFlag ? { chat_template_kwargs: { enable_thinking: false } } : {}) }),
  });
  if (!response.ok) return { ok: false, detail: `The model server answered ${response.status}.` };
  const body = (await response.json()) as { choices?: { message?: { content?: string | null } }[]; model?: string };
  const wrote = typeof body.choices?.[0]?.message?.content === "string";
  return wrote ? { ok: true, detail: `${endpoint.name} wrote a reply.` } : { ok: false, detail: "The model server answered without a reply." };
}

async function probeExa(apiKey: string, type: string): Promise<Probe> {
  const response = await fetch("https://api.exa.ai/search", { method: "POST", signal: AbortSignal.timeout(SERVICE_TIMEOUT_MS), headers: { "x-api-key": apiKey, "Content-Type": "application/json" }, body: JSON.stringify({ query: "electricity contract prices Finland", type, numResults: 1 }) });
  if (!response.ok) return { ok: false, detail: `Exa answered ${response.status}.` };
  const found = ((await response.json()) as { results?: unknown[] }).results?.length ?? 0;
  return found ? { ok: true, detail: "A live search returned a result." } : { ok: false, detail: "A live search returned nothing." };
}

// One small public page, read into a fixed shape: the same call the offer pages use. Context.dev may serve its own
// copy of the page (up to a day old), which still proves the key, the quota and the extraction work.
async function probeContextDev(apiKey: string): Promise<Probe> {
  const response = await fetch("https://api.context.dev/v1/web/scrape", {
    method: "POST",
    signal: AbortSignal.timeout(SERVICE_TIMEOUT_MS),
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ url: "https://example.com", formats: { json: true }, jsonParams: { schema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] }, instructions: "The page's title." }, sharedParams: { mainContentOnly: true }, maxAgeMs: 24 * 3_600_000 }),
  });
  if (response.status === 429) return { ok: false, detail: "Context.dev is at its limit of page reads for this minute. It frees up within a minute." };
  if (!response.ok) return { ok: false, detail: `Context.dev answered ${response.status}.` };
  const body = (await response.json()) as { json?: { success?: boolean } };
  return body.json?.success === true ? { ok: true, detail: "A page was read into a fixed shape." } : { ok: false, detail: "Context.dev answered but could not read the test page." };
}

// Costs no credit: asks the account what is left. Some keys may not read the account; then the model list proves the key.
async function probeElevenLabs(apiKey: string): Promise<Probe> {
  const headers = { "xi-api-key": apiKey };
  const account = await fetch("https://api.elevenlabs.io/v1/user/subscription", { headers, signal: AbortSignal.timeout(SERVICE_TIMEOUT_MS) });
  if (account.ok) {
    const body = (await account.json()) as { character_count?: number; character_limit?: number };
    const left = typeof body.character_limit === "number" && typeof body.character_count === "number" ? body.character_limit - body.character_count : null;
    if (left !== null && left <= 0) return { ok: false, detail: "The voice credit is used up." };
    return { ok: true, detail: left === null ? "The voice account answered." : `About ${Math.round(left / 1000).toLocaleString("en-US")} thousand characters of speech left.` };
  }
  const models = await fetch("https://api.elevenlabs.io/v1/models", { headers, signal: AbortSignal.timeout(SERVICE_TIMEOUT_MS) });
  return models.ok ? { ok: true, detail: "The voice service accepted the key." } : { ok: false, detail: `ElevenLabs answered ${models.status}.` };
}

function probeFinance(): Probe {
  const built = DEMO_CUSTOMERS.map((customer) => buildOverview(customer.customerId)).filter((overview) => overview !== null);
  return built.length === DEMO_CUSTOMERS.length && built.length > 0 ? { ok: true, detail: `${built.length} demo customers load, each with baskets, bills and a balance.` } : { ok: false, detail: `${built.length} of ${DEMO_CUSTOMERS.length} demo customers could be loaded.` };
}

function probeStore(): Probe {
  const store = storeInfo();
  const chains = DEMO_CUSTOMERS.every((customer) => auditFor(customer.customerId).chainValid);
  if (!chains) return { ok: false, detail: "The audit log does not verify: an entry was changed or removed. Reset the demo." };
  const where = store.kind === "supabase" ? "in Supabase" : "to this machine";
  const whose = store.perVisitor ? ", separately for each visitor" : "";
  return store.persistent ? { ok: true, detail: `Actions and memory are saved ${where}${whose}; the audit log verifies.` } : { ok: true, detail: "Actions and memory are kept in memory only (they are lost on restart); the audit log verifies." };
}

async function check(): Promise<ReadinessReport> {
  const config = getConfig();
  const mockStatus = (role: string, id: ReadinessCheck["id"], sponsor: string): ReadinessCheck => ({ id, sponsor, role, status: "mock", latencyMs: null, detail: "Example data: this server has MODEL_PROVIDER=mock, so nothing was called.", standIn: null, blocksDemo: false });
  const local = (id: "finance" | "store", sponsor: string, role: string, probe: Probe): ReadinessCheck => ({ id, sponsor, role, status: probe.ok ? "ok" : "down", latencyMs: 0, detail: probe.detail, standIn: null, blocksDemo: !probe.ok });
  const finance = local("finance", "S-Pankki", "The customer's own figures: baskets, bills, safe to spend, patterns", probeFinance());
  const store = local("store", "Sisu", "Approvals, memory and the audit log", probeStore());

  if (config.isMock) {
    const checks = [mockStatus("Reasoning and tool choice", "model", "NVIDIA on Verda"), mockStatus("Live search and research", "exa", "Exa"), mockStatus("Reading offer pages into prices", "context-dev", "Context.dev"), mockStatus("Speech in and out", "elevenlabs", "ElevenLabs"), finance, store];
    const ready = finance.status === "ok" && store.status === "ok";
    return { ready, voiceReady: false, mock: true, headline: ready ? "Ready on example data. No sponsor service is called in mock mode." : "The demo data or the store has a problem.", checks, checkedAt: new Date().toISOString(), ageMs: 0 };
  }

  const service = async (key: string, variable: string, run: () => Promise<Probe>) => (key ? { configured: true, ...(await timed(run)) } : { configured: false, ok: false, detail: `No key on this server (${variable} is empty).`, latencyMs: null });
  const [model, backup, exa, contextDev, eleven] = await Promise.all([
    timed(() => probeModel(config.model)),
    config.fallbackModel ? timed(() => probeModel(config.fallbackModel as ModelEndpoint)) : Promise.resolve(null),
    service(config.exa.apiKey, "EXA_API_KEY", () => probeExa(config.exa.apiKey, config.exa.searchType)),
    service(config.contextDev.apiKey, "CONTEXT_DEV_API_KEY", () => probeContextDev(config.contextDev.apiKey)),
    service(config.eleven.apiKey, "ELEVENLABS_API_KEY", () => probeElevenLabs(config.eleven.apiKey)),
  ]);
  const status = (probe: { ok: boolean; configured?: boolean }): ReadinessCheck["status"] => (probe.configured === false ? "not-configured" : probe.ok ? "ok" : "down");
  const backupOk = backup?.ok === true;
  const mainSponsor = config.provider === "verda" ? "NVIDIA Nemotron on Verda" : (SPONSOR[config.provider] ?? config.provider);

  const checks: ReadinessCheck[] = [
    { id: "model", sponsor: mainSponsor, role: "Reasoning, tool choice and wording", status: status(model), latencyMs: model.latencyMs, detail: model.detail, standIn: config.fallbackModel ? `${SPONSOR[config.fallbackModel.provider] ?? config.fallbackModel.provider} hosted copy of the same model takes over by itself` : null, blocksDemo: !model.ok && !backupOk },
    ...(backup && config.fallbackModel ? [{ id: "model-backup" as const, sponsor: SPONSOR[config.fallbackModel.provider] ?? config.fallbackModel.provider, role: "Backup for the model, used only if our GPU fails or stalls", status: status(backup), latencyMs: backup.latencyMs, detail: backup.detail, standIn: null, blocksDemo: false }] : []),
    { id: "exa", sponsor: "Exa", role: "Live search, research across sources, second page reader", status: status(exa), latencyMs: exa.latencyMs, detail: exa.detail, standIn: "Offer pages Sisu already knows are read directly; open web questions go unanswered", blocksDemo: !exa.ok && !contextDev.ok },
    { id: "context-dev", sponsor: "Context.dev", role: "Reads each offer page into typed prices", status: status(contextDev), latencyMs: contextDev.latencyMs, detail: contextDev.detail, standIn: "Exa reads the page into the same shape", blocksDemo: !contextDev.ok && !exa.ok },
    { id: "elevenlabs", sponsor: "ElevenLabs", role: "Speech to text and Sisu's voice", status: status(eleven), latencyMs: eleven.latencyMs, detail: eleven.detail, standIn: "Typed questions and written answers keep working", blocksDemo: false },
    finance,
    store,
  ];
  const blocked = checks.filter((item) => item.blocksDemo);
  const weak = checks.filter((item) => item.status !== "ok" && !item.blocksDemo);
  const ready = blocked.length === 0;
  const headline = !ready
    ? `Not ready: ${blocked.map((item) => item.sponsor).join(" and ")} ${blocked.length === 1 ? "is" : "are"} down with nothing to stand in.`
    : weak.length
      ? `Ready, with a stand-in for ${weak.map((item) => item.sponsor).join(" and ")}.`
      : "Ready: every service answered.";
  return { ready, voiceReady: eleven.ok, mock: false, headline, checks, checkedAt: new Date().toISOString(), ageMs: 0 };
}

// The kept report if it is under a minute old, otherwise a new one. Callers at the same moment share one check.
export async function readiness(options: { fresh?: boolean } = {}): Promise<ReadinessReport> {
  const kept = memory.last;
  if (!options.fresh && kept && Date.now() - kept.at < KEEP_MS) return { ...kept.report, ageMs: Date.now() - kept.at };
  memory.running ??= check()
    .then((report) => {
      memory.last = { at: Date.now(), report };
      return report;
    })
    .finally(() => {
      memory.running = null;
    });
  return memory.running;
}
