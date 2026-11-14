// Reads one offer page into typed offers. Context.dev reads first. If it cannot (it allows our key ten page
// reads a minute, and some pages defeat it), Exa reads the page instead with the same question and shape.
// Whoever read it, the result goes through the same cleaning, and the page remembers who read it.
// A page read in the last ten minutes is served from here with its real age, so a second search soon after the
// first costs no page reads at all.
import type { BillType } from "@/lib/types";
import { OFFER_QUESTION, OFFER_SCHEMA, type PageExtraction, cleanOffers, extractOffers } from "./contextdev";
import { exaReadPage } from "./exa";
import type { RawOffer } from "./types";

export type PageReader = "context.dev" | "exa";
export type PageRead = PageExtraction & { reader: PageReader };

const PAGE_REUSE_MS = 10 * 60_000;
const recent: Map<string, { at: number; read: PageRead }> = ((globalThis as unknown as { __sisuPageReads?: Map<string, { at: number; read: PageRead }> }).__sisuPageReads ??= new Map());

const pending = new Map<string, Promise<PageRead>>();

// For tests: start with no remembered pages.
export const forgetRecentPages = (): void => recent.clear();

async function readWithExa(url: string, billType: BillType): Promise<PageRead> {
  const started = Date.now();
  const { data, fromCache } = await exaReadPage<{ offers?: Partial<RawOffer>[] }>(url, OFFER_QUESTION[billType], OFFER_SCHEMA);
  const { offers, dropped } = cleanOffers(data.offers ?? [], url);
  if (!offers.length) throw new Error("Exa found no offers on the page.");
  return { url, offers, dropped, cacheAgeMs: fromCache ? null : 0, tookMs: Date.now() - started, reader: "exa" };
}

export async function readOffers(url: string, billType: BillType): Promise<PageRead> {
  const key = `${billType}:${url}`;
  const kept = recent.get(key);
  if (kept && Date.now() - kept.at < PAGE_REUSE_MS) return { ...kept.read, cacheAgeMs: kept.read.cacheAgeMs === null ? null : kept.read.cacheAgeMs + (Date.now() - kept.at), tookMs: 0 };

  const running = pending.get(key);
  if (running) return running;
  const task = fetchOffers(url, billType).then((read) => {
    recent.set(key, { at: Date.now(), read });
    return read;
  }).finally(() => pending.delete(key));
  pending.set(key, task);
  return task;
}

async function fetchOffers(url: string, billType: BillType): Promise<PageRead> {
  let read: PageRead;
  try {
    read = { ...(await extractOffers(url, billType)), reader: "context.dev" };
    if (!read.offers.length) throw new Error("Context.dev found no offers on the page.");
  } catch (first) {
    try {
      read = await readWithExa(url, billType);
    } catch (second) {
      throw new Error(`${(first as Error).message} Exa could not read it either (${(second as Error).message})`);
    }
  }
  return read;
}
