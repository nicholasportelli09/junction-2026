import { getConfig, missingKey } from "../config";

export type ExaResult = { title: string; url: string; highlights: string[] };

const EXA_TIMEOUT_MS = 4_000;

type ExaResponse = { results?: { title?: string; url?: string; highlights?: string[] }[] };

// Exa "lite" search: about 0.2 s without page contents, about 0.5 s with highlights.
export async function exaSearch(
  query: string,
  options: { numResults: number; highlights: boolean; signal?: AbortSignal; includeDomains?: string[] },
): Promise<ExaResult[]> {
  const { exa } = getConfig();
  if (!exa.apiKey) throw missingKey("Exa search", "EXA_API_KEY");

  const timeout = AbortSignal.timeout(EXA_TIMEOUT_MS);
  const response = await fetch("https://api.exa.ai/search", {
    method: "POST",
    signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    headers: { "x-api-key": exa.apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      query,
      type: exa.searchType,
      numResults: options.numResults,
      ...(options.highlights ? { contents: { highlights: true } } : {}),
      ...(options.includeDomains?.length ? { includeDomains: options.includeDomains } : {}),
    }),
  });
  if (!response.ok) {
    console.error(`[agent] Exa returned ${response.status}: ${(await response.text().catch(() => "")).slice(0, 200)}`);
    throw new Error(`Exa search failed (${response.status}).`);
  }
  const body = (await response.json()) as ExaResponse;
  return (body.results ?? [])
    .filter((r): r is { title?: string; url: string; highlights?: string[] } => typeof r.url === "string")
    .map((r) => ({ title: r.title ?? r.url, url: r.url, highlights: r.highlights ?? [] }));
}

// --- Reading pages and deeper research. Exa does more than find links: it can read a page into a fixed shape
// (so it stands in when the first page reader is busy), and it can research an open question across several
// sources and write up what it found, with the sources it used. ---

type ContentsResponse = {
  results?: { url?: string; title?: string; summary?: string }[];
  statuses?: { id?: string; status?: string; source?: string; error?: { tag?: string; httpStatusCode?: number } | null }[];
};

const EXA_READ_TIMEOUT_MS = 9_000;
const EXA_DEEP_TIMEOUT_MS = 25_000;

async function post<T>(path: string, body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  const { exa } = getConfig();
  if (!exa.apiKey) throw missingKey("Exa", "EXA_API_KEY");
  const timeout = AbortSignal.timeout(timeoutMs);
  const response = await fetch(`https://api.exa.ai${path}`, { method: "POST", signal: signal ? AbortSignal.any([signal, timeout]) : timeout, headers: { "x-api-key": exa.apiKey, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) {
    console.error(`[agent] Exa ${path} returned ${response.status}: ${(await response.text().catch(() => "")).slice(0, 200)}`);
    throw new Error(`Exa could not do that (${response.status}).`);
  }
  return (await response.json()) as T;
}

// Exa's schemas take one type per field, so "a string or null" becomes "a string that may be left out".
type Json = Record<string, unknown>;
export function singleTypes(schema: Json): Json {
  const properties = schema.properties as Record<string, Json> | undefined;
  const optional = new Set(Object.entries(properties ?? {}).filter(([, value]) => Array.isArray(value.type)).map(([key]) => key));
  return {
    ...schema,
    ...(Array.isArray(schema.type) ? { type: (schema.type as string[]).find((type) => type !== "null") ?? "string" } : {}),
    ...(properties ? { properties: Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, singleTypes(value)])) } : {}),
    ...(schema.items ? { items: singleTypes(schema.items as Json) } : {}),
    ...(Array.isArray(schema.required) ? { required: (schema.required as string[]).filter((key) => !optional.has(key)) } : {}),
  };
}

// Reads one page and returns what it says in the shape of `schema`. Exa writes the summary; nothing here is
// trusted until the caller has cleaned it. A copy up to 15 minutes old is accepted, like the first reader.
export async function exaReadPage<T>(url: string, question: string, schema: Record<string, unknown>, signal?: AbortSignal): Promise<{ data: T; fromCache: boolean; tookMs: number }> {
  const started = Date.now();
  const body = await post<ContentsResponse>("/contents", { urls: [url], summary: { query: question, schema: singleTypes(schema) }, maxAgeHours: 1, livecrawlTimeout: 7_000 }, EXA_READ_TIMEOUT_MS, signal);
  const status = body.statuses?.[0];
  if (status?.status === "error") throw new Error(`Exa could not read the page (${status.error?.tag ?? "unknown reason"}).`);
  const summary = body.results?.[0]?.summary;
  if (!summary) throw new Error("Exa read the page but found nothing to report.");
  try {
    return { data: JSON.parse(summary) as T, fromCache: status?.source === "cached", tookMs: Date.now() - started };
  } catch {
    throw new Error("Exa's reading of the page was not in the expected shape.");
  }
}

type DeepResponse = {
  results?: { title?: string; url?: string; highlights?: string[]; publishedDate?: string | null }[];
  output?: { content?: unknown; grounding?: { citations?: { url?: string; title?: string }[] }[] } | null;
};

export type ExaResearch = { answer: string; sources: { title: string; url: string }[]; excerpts: string[]; tookMs: number; type: string };

// Researches an open question across several sources and writes up what it found. Slower than a search
// (about four seconds, more for the full "deep" type), so it is used only when a question needs it.
export async function exaResearch(query: string, signal?: AbortSignal): Promise<ExaResearch> {
  const { exa } = getConfig();
  const started = Date.now();
  const body = await post<DeepResponse>("/search", { query, type: exa.deepType, numResults: 6, outputSchema: { type: "text", description: "A short, factual answer in plain words, with figures and dates where the sources give them." }, contents: { highlights: { maxCharacters: 1_500 } } }, EXA_DEEP_TIMEOUT_MS, signal);
  const answer = typeof body.output?.content === "string" ? body.output.content : "";
  const cited = (body.output?.grounding ?? []).flatMap((entry) => entry.citations ?? []);
  const listed = (body.results ?? []).map((result) => ({ url: result.url, title: result.title }));
  const seen = new Set<string>();
  const sources = [...cited, ...listed]
    .filter((source): source is { url: string; title?: string } => typeof source.url === "string" && !seen.has(source.url) && !!seen.add(source.url))
    .slice(0, 5)
    .map((source) => ({ url: source.url, title: source.title ?? source.url }));
  if (!answer && !sources.length) throw new Error("Exa found nothing on that.");
  const excerpts = (body.results ?? []).flatMap((result) => result.highlights ?? []);
  return { answer, sources, excerpts, tookMs: Date.now() - started, type: exa.deepType };
}
