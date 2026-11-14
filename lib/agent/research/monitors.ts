// Context.dev monitors: Context.dev keeps a baseline of a page, checks it again on a schedule and records a change
// when it differs. Sisu creates one monitor per watched listing page (and one search monitor for listings that
// appear elsewhere), then polls each monitor's changes. Docs: https://docs.context.dev/monitors/overview
// Nothing about the customer is sent: a monitor holds a public URL or a city-and-topic query, and a generic name.
import { getConfig, missingKey } from "../config";

const API = "https://api.context.dev/v1";
const TIMEOUT_MS = 10_000;
const CHECK_EVERY_HOURS = 6;
const TAGS = ["sisu", "property-watch"];

export type MonitorChange = { id: string; url: string | null; title: string; summary: string; detectedAt: string; matchedUrls: string[] };
export type MonitorState = { id: string; status: string; lastRunAt: string | null; lastChangeAt: string | null; nextRunAt: string | null; lastError: string | null; baselineReady: boolean };

type Json = Record<string, unknown>;
const text = (value: unknown): string | null => (typeof value === "string" && value ? value : null);

async function call(method: "GET" | "POST" | "DELETE", path: string, body?: Json, signal?: AbortSignal): Promise<Json> {
  const { contextDev } = getConfig();
  if (!contextDev.apiKey) throw missingKey("Context.dev", "CONTEXT_DEV_API_KEY");
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const response = await fetch(`${API}${path}`, {
    method,
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    headers: { Authorization: `Bearer ${contextDev.apiKey}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 200);
    console.error(`[agent] Context.dev monitors ${method} ${path.split("?")[0]} returned ${response.status}: ${detail}`);
    throw new Error(`Context.dev monitors answered ${response.status}.`);
  }
  return response.status === 204 ? {} : (((await response.json().catch(() => ({}))) ?? {}) as Json);
}

const schedule = { type: "interval", frequency: CHECK_EVERY_HOURS, unit: "hours" };

// Watches one listing page. With instructions, Context.dev's judge reports only differences that matter to a renter.
export async function createPageMonitor(url: string, city: string, signal?: AbortSignal): Promise<{ id: string; initialRunId: string | null }> {
  const created = await call(
    "POST",
    "/monitors",
    {
      name: `Sisu flat watch: ${city}`.slice(0, 200),
      target: { type: "page", url, instructions: "Report a change to the monthly rent of any flat, and flats added to or removed from the list. Ignore adverts, counters, sorting, dates and navigation." },
      schedule,
      tags: TAGS,
    },
    signal,
  );
  const id = text(created.id);
  if (!id) throw new Error("Context.dev created no monitor.");
  return { id, initialRunId: text(created.initial_run_id) };
}

// Watches the web for rental listings in the city that were not there before. Every new result is reported
// ("exact"); code decides afterwards which of them it will read (lib/watch).
export async function createSearchMonitor(city: string, signal?: AbortSignal): Promise<{ id: string }> {
  const created = await call("POST", "/monitors", { name: `Sisu new flats: ${city}`.slice(0, 200), target: { type: "search", query: `vuokra-asunto ${city} vuokrattavana` }, change_detection: { type: "exact" }, schedule, tags: TAGS }, signal);
  const id = text(created.id);
  if (!id) throw new Error("Context.dev created no monitor.");
  return { id };
}

export async function getMonitor(id: string, signal?: AbortSignal): Promise<MonitorState> {
  const monitor = await call("GET", `/monitors/${encodeURIComponent(id)}`, undefined, signal);
  const error = monitor.last_error as { message?: unknown } | null | undefined;
  return { id, status: text(monitor.status) ?? "unknown", lastRunAt: text(monitor.last_run_at), lastChangeAt: text(monitor.last_change_at), nextRunAt: text(monitor.next_run_at), lastError: text(error?.message), baselineReady: !!monitor.baseline };
}

// The changes Context.dev has recorded for a monitor since a moment in time, newest first.
export async function listChanges(id: string, since: string | null, signal?: AbortSignal): Promise<MonitorChange[]> {
  const query = new URLSearchParams({ limit: "20", ...(since ? { since } : {}) });
  const body = await call("GET", `/monitors/${encodeURIComponent(id)}/changes?${query}`, undefined, signal);
  const rows = Array.isArray(body.data) ? (body.data as Json[]) : [];
  return rows.flatMap((row): MonitorChange[] => {
    const changeId = text(row.id);
    if (!changeId) return [];
    const matched = Array.isArray(row.matched_urls) ? row.matched_urls.filter((url): url is string => typeof url === "string") : [];
    return [{ id: changeId, url: text(row.url), title: text(row.title) ?? "", summary: text(row.summary) ?? "", detectedAt: text(row.detected_at) ?? new Date().toISOString(), matchedUrls: matched }];
  });
}

// Asks Context.dev to check the page now instead of waiting for the schedule. The run is queued; its result shows
// up in listChanges a little later.
export async function runMonitorNow(id: string, signal?: AbortSignal): Promise<{ runId: string | null }> {
  const queued = await call("POST", `/monitors/${encodeURIComponent(id)}/run`, undefined, signal);
  return { runId: text(queued.run_id) };
}

export async function deleteMonitor(id: string, signal?: AbortSignal): Promise<void> {
  await call("DELETE", `/monitors/${encodeURIComponent(id)}`, undefined, signal);
}
