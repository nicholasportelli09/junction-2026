import { getConfig } from "@/lib/agent/config";
import { jsonError } from "@/lib/agent/http";
import { type ChatMessage, type ToolSchema, streamChat } from "@/lib/agent/model";
import { buildSystemPrompt } from "@/lib/agent/prompt";
import { extractOffers } from "@/lib/agent/research/contextdev";
import { exaSearch } from "@/lib/agent/research/exa";
import { TOOL_SCHEMAS } from "@/lib/agent/tools";
import { buildCashFlow } from "@/lib/finance/cashflow";
import { DEMO_CUSTOMERS } from "@/lib/finance/data";
import { buildOverview } from "@/lib/finance/overview";
import { findPatterns } from "@/lib/finance/patterns";
import { runScenario } from "@/lib/finance/scenario";
import { getMemory } from "@/lib/memory";
import { withVisitor } from "@/lib/agent/visitor";

export const runtime = "nodejs";
export const maxDuration = 120;

// Stage-by-stage timings for the gauntlet (tests/gauntlet/stages.mjs). Development only: it spends model time and
// a few search credits, so it refuses to run in production unless SISU_BENCH=1.
type Sample = { firstTokenMs: number | null; totalMs: number; provider: string; usedBackup: boolean; chars: number; toolCalls: number };

async function once(messages: ChatMessage[], tools: ToolSchema[], maxTokens: number): Promise<Sample> {
  let chars = 0;
  let sample: Sample = { firstTokenMs: null, totalMs: 0, provider: "?", usedBackup: false, chars: 0, toolCalls: 0 };
  for await (const chunk of streamChat({ messages, tools, maxTokens })) {
    if (chunk.type === "delta") chars += chunk.text.length;
    else sample = { firstTokenMs: chunk.firstTokenMs, totalMs: chunk.totalMs, provider: chunk.provider, usedBackup: chunk.usedBackup, chars, toolCalls: chunk.toolCalls.length };
  }
  return sample;
}

const repeat = async <T>(times: number, run: (index: number) => Promise<T>): Promise<T[]> => {
  const results: T[] = [];
  for (let i = 0; i < times; i++) results.push(await run(i));
  return results;
};

function timeSync(run: () => unknown, times = 300): number {
  const started = performance.now();
  for (let i = 0; i < times; i++) run();
  return Math.round(((performance.now() - started) / times) * 1000) / 1000;
}

export const GET = withVisitor(async function GET(request: Request) {
  if (process.env.NODE_ENV === "production" && process.env.SISU_BENCH !== "1") return jsonError("The benchmark route is switched off here.", 404);
  const params = new URL(request.url).searchParams;
  const part = params.get("part") ?? "finance";
  const runs = Math.min(Math.max(Number(params.get("runs")) || 5, 1), 12);
  const customer = DEMO_CUSTOMERS[0];
  const overview = buildOverview(customer.customerId);
  if (!overview) return jsonError("No demo customer.", 500);
  const system = buildSystemPrompt({ overview, city: customer.area, mode: "voice", memory: getMemory(customer.customerId) });
  const config = getConfig();

  if (part === "finance") {
    const cashFlow = buildCashFlow(overview);
    return Response.json({
      part,
      unit: "ms per call, mean of 300",
      buildOverview: timeSync(() => buildOverview(customer.customerId)),
      buildCashFlow: timeSync(() => buildCashFlow(overview)),
      findPatterns: timeSync(() => findPatterns(overview, cashFlow)),
      runScenario: timeSync(() => runScenario(overview, { billSavingPerMonth: 10, everydayCutPct: 5, years: 5 })),
      systemPromptChars: system.length,
      toolSchemaChars: JSON.stringify(TOOL_SCHEMAS).length,
    });
  }

  if (part === "model") {
    const question: ChatMessage = { role: "user", content: "How much can I safely spend this week?" };
    const toolQuestion: ChatMessage = { role: "user", content: "How much did I spend on restaurants in June 2026?" }; // not in the summary, so a tool is needed
    // "Cold" defeats the model server's prefix cache with a unique first line, so the whole prompt is read again.
    const cold = await repeat(Math.min(runs, 3), (i) => once([{ role: "system", content: `Session ${crypto.randomUUID()} ${i}\n${system}` }, question], TOOL_SCHEMAS, 60));
    const warm = await repeat(runs, () => once([{ role: "system", content: system }, question], TOOL_SCHEMAS, 60));
    const warmNoTools = await repeat(runs, () => once([{ role: "system", content: system }, question], [], 60));
    const toolChoice = await repeat(runs, () => once([{ role: "system", content: system }, toolQuestion], TOOL_SCHEMAS, 120));
    const long = await once([{ role: "system", content: system.replace("one or two short sentences", "about one hundred and fifty words") }, { role: "user", content: "Explain the three baskets idea and how my own spending fits into it." }], [], 300);
    return Response.json({ part, provider: config.provider, model: config.model.name, cold, warm, warmNoTools, toolChoice, long: { ...long, charsPerSecond: long.firstTokenMs === null ? null : Math.round(long.chars / ((long.totalMs - long.firstTokenMs) / 1000)) } });
  }

  if (part === "sizes") {
    // Separates two possible costs of offering tools: more prompt to read, or the server holding back the first words
    // while it checks whether a tool call is starting.
    const question: ChatMessage = { role: "user", content: "How much can I safely spend this week?" };
    const padding = `\nReference notes (ignore): ${"The customer can ask about spending, bills, payday and offers. ".repeat(110)}`.slice(0, JSON.stringify(TOOL_SCHEMAS).length);
    const variants: [string, ChatMessage[], ToolSchema[]][] = [
      ["no tools", [{ role: "system", content: system }, question], []],
      ["no tools, prompt padded by the size of the tool list", [{ role: "system", content: system + padding }, question], []],
      ["one small tool", [{ role: "system", content: system }, question], TOOL_SCHEMAS.filter((t) => t.function.name === "list_bills")],
      ["all tools", [{ role: "system", content: system }, question], TOOL_SCHEMAS],
    ];
    const results = [];
    for (const [label, messages, tools] of variants) results.push({ label, firstTokenMs: (await repeat(runs, () => once(messages, tools, 40))).map((s) => s.firstTokenMs) });
    return Response.json({ part, results });
  }

  if (part === "search") {
    const exa = await repeat(runs, async () => {
      const started = Date.now();
      const results = await exaSearch("cheapest electricity contract Helsinki Finland price comparison", { numResults: 8, highlights: false });
      return { ms: Date.now() - started, results: results.length, firstUrl: results[0]?.url ?? null };
    });
    const exaHighlights = await repeat(Math.min(runs, 3), async () => {
      const started = Date.now();
      const results = await exaSearch("Kela general housing allowance 2026", { numResults: 4, highlights: true });
      return { ms: Date.now() - started, results: results.length };
    });
    return Response.json({ part, exa, exaHighlights });
  }

  if (part === "web") {
    // What a web search hands the model for a question, to see whether a figure it quoted was really on the page.
    const results = await exaSearch(params.get("query") ?? "ECB deposit facility rate", { numResults: 4, highlights: true });
    return Response.json({ part, results: results.map((r) => ({ url: r.url, title: r.title, highlights: r.highlights.join(" ").slice(0, 700) })) });
  }

  if (part === "extract") {
    const urls = (params.get("urls") ?? "").split(",").filter((url) => /^https:\/\//.test(url)).slice(0, 3);
    if (!urls.length) return jsonError("Pass urls=https://...,https://... (up to 3).", 400);
    const pages = await Promise.all(
      urls.map(async (url) => {
        const started = Date.now();
        try {
          const page = await extractOffers(url, "electricity");
          return { host: new URL(url).hostname, ok: true, ms: Date.now() - started, offers: page.offers.length, cacheAgeMs: page.cacheAgeMs, dropped: page.dropped };
        } catch (error) {
          return { host: new URL(url).hostname, ok: false, ms: Date.now() - started, error: (error as Error).message };
        }
      }),
    );
    return Response.json({ part, pages });
  }
  return jsonError("part must be finance, model, search or extract.", 400);
});
