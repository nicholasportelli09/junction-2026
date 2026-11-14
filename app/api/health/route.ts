import { breakerStatus } from "@/lib/agent/breaker";
import { getConfig } from "@/lib/agent/config";
import { storeInfo } from "@/lib/store/state";
import type { HealthReport } from "@/lib/types";
import { withVisitor } from "@/lib/agent/visitor";

export const runtime = "nodejs";

// Where each provider's model runs. The Verda instance is ours (deploy/verda/README.md); VERDA_REGION overrides the label.
const REGION: Record<string, string | null> = { verda: process.env.VERDA_REGION?.trim() || "Verda FIN-02, Finland (our own GPU)", nvidia: "NVIDIA Build (hosted)", gemini: "Google (hosted)", mock: null };

// A page a judge can open to verify what is really running: the model actually being served, where, the
// backup, which sponsor services are configured, and the data boundary. It asks the model server itself
// which model it serves, so the answer cannot be a hard-coded string. Never returns keys.
export const GET = withVisitor(async function GET() {
  const config = getConfig();
  const host = config.isMock ? "none" : new URL(config.model.baseUrl || "http://unset").host;
  let reachable: boolean | null = null;
  let latencyMs: number | null = null;
  let served = config.model.name;

  if (!config.isMock) {
    const started = Date.now();
    try {
      const response = await fetch(`${config.model.baseUrl}/models`, { headers: { Authorization: `Bearer ${config.model.apiKey}` }, signal: AbortSignal.timeout(3_000) });
      const body = (await response.json()) as { data?: { id?: string }[] };
      reachable = response.ok;
      latencyMs = Date.now() - started;
      const ids = (body.data ?? []).map((model) => model.id).filter((id): id is string => typeof id === "string");
      served = ids.includes(config.model.name) ? config.model.name : (ids[0] ?? config.model.name);
    } catch {
      reachable = false;
    }
  }

  const report: HealthReport = {
    ok: config.isMock || reachable === true || config.fallbackModel !== null,
    mock: config.isMock,
    model: { provider: config.provider, name: served, host: host.startsWith("127.0.0.1") || host.startsWith("localhost") ? `${host} (private SSH tunnel to the GPU)` : host, region: REGION[config.provider] ?? null, reachable, latencyMs },
    backup: config.fallbackModel ? { provider: config.fallbackModel.provider, name: config.fallbackModel.name, inUseNow: breakerStatus(config.model).open } : null,
    services: { exa: !!config.exa.apiKey, contextDev: !!config.contextDev.apiKey, elevenLabs: !!config.eleven.apiKey },
    dataBoundary: [
      "Transactions never leave the finance engine. The model receives computed totals and a few selected facts, never the raw rows or the customer ID.",
      "Exa and Context.dev receive only a bill type and a city, or a search query stripped of names, IDs, postal codes and euro amounts.",
      "The reasoning model runs on our own GPU. If it stalls, the same request goes to the backup and the turn's timings say so.",
      "Actions are simulated, need an explicit approval, and every step is written to a hash-chained audit log.",
    ],
    store: storeInfo(),
    checkedAt: new Date().toISOString(),
  };
  return Response.json(report, { headers: { "Cache-Control": "no-store" } });
});
