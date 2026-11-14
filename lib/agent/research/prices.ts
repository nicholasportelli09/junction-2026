// Prices for anything the customer names (a phone, a used car, a bike): Exa finds pages that offer it, Context.dev
// reads each page into typed offers, and code decides what fits the price they said. Nothing here is specific to
// one kind of thing: the model supplies the topic in the customer's words, and the same reading, cleaning and
// comparing work for all of them. Only the topic leaves the server, after it has been stripped of anything personal.
import type { Listing } from "@/lib/types";
import { getConfig } from "../config";
import { looksLikeInstructions, safeName } from "../tools/untrusted";
import { exaSearch } from "./exa";
import { type ListingPage, type ListingSearch, MAX_PAGES, hostName, scrapeJson } from "./listings";

const MAX_OFFERS_PER_PAGE = 12;
export const PRICE_LIMITS: [number, number] = [5, 100_000];
const MAX_TOPIC_CHARS = 60;

export const ITEM_SCHEMA = {
  type: "object",
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        required: ["name", "priceEur", "details", "url"],
        properties: {
          name: { type: "string", description: "Name of the item offered" },
          priceEur: { type: ["number", "null"], description: "Its price in euros, as a number" },
          details: { type: ["string", "null"], description: "A few words that tell this offer apart: model, size, year, seller" },
          url: { type: ["string", "null"], description: "Link to this offer's own page, if the page gives one" },
        },
      },
    },
  },
};
export const itemInstructions = (topic: string): string => `Offers for "${topic}" on this page, each with its price in euros. Only the item itself, not accessories, parts, insurance or monthly instalments. Use only facts stated on the page. At most ${MAX_OFFERS_PER_PAGE} offers.`;

type RawItem = { name?: unknown; priceEur?: unknown; details?: unknown; url?: unknown };

// What the customer wants a price for, safe to send to a search engine: a few plain words. Euro amounts, long
// figures (a balance, a salary), customer ids and anything phrased as an instruction are taken out or refused.
export function cleanTopic(value: unknown, alsoRemove: string[] = []): string | null {
  if (typeof value !== "string") return null;
  const stripped = alsoRemove
    .filter(Boolean)
    .reduce((text, word) => text.split(new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i")).join(" "), value)
    .replace(/CUST\d+/gi, "")
    .replace(/(€\s?\d[\d.,]*|\d[\d.,]*\s?(€|eur|euros?)\b)/gi, "")
    .replace(/\b(?!20\d{2}\b)\d{4,}(?:[.,]\d+)?\b/g, "");
  const topic = safeName(stripped, MAX_TOPIC_CHARS);
  return topic && topic.length >= 2 && !looksLikeInstructions(topic) ? topic : null;
}

const wordsOf = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];
// An offer is about the topic if it shares at least one real word with it. A page of phones also lists chargers
// and cases; this, the instructions above and the price floor in lib/watch/detect.ts keep most of those out.
export const aboutTopic = (listing: Pick<Listing, "title" | "details">, topic: string): boolean => {
  const said = new Set(wordsOf(`${listing.title} ${listing.details ?? ""}`));
  return wordsOf(topic).some((word) => said.has(word));
};

const ownLink = (value: unknown, pageUrl: string): string => {
  if (typeof value !== "string" || !value.trim()) return pageUrl;
  try {
    const link = new URL(value.trim(), pageUrl);
    return hostName(link.href) === hostName(pageUrl) && /^https?:$/.test(link.protocol) ? link.href : pageUrl;
  } catch {
    return pageUrl;
  }
};

// Page text is untrusted. An offer is kept only if it has a plausible price, a name that reads like a name
// (short, no links, nothing phrased as an instruction) and is about the topic. The rest is dropped and counted.
export function cleanItems(extracted: RawItem[], pageUrl: string, topic: string): { listings: Listing[]; dropped: number } {
  const candidates = (Array.isArray(extracted) ? extracted : []).slice(0, MAX_OFFERS_PER_PAGE);
  const listings = candidates.flatMap((raw): Listing[] => {
    const title = safeName(raw?.name, 90);
    const price = typeof raw?.priceEur === "number" && Number.isFinite(raw.priceEur) && raw.priceEur >= PRICE_LIMITS[0] && raw.priceEur <= PRICE_LIMITS[1] ? raw.priceEur : null;
    if (!title || price === null) return [];
    const listing: Listing = { title, priceEur: Math.round(price * 100) / 100, rooms: null, areaM2: null, district: null, city: null, availableFrom: null, details: safeName(raw.details, 80), url: ownLink(raw.url, pageUrl), pageUrl };
    return aboutTopic(listing, topic) ? [listing] : [];
  });
  return { listings, dropped: candidates.length - listings.length };
}

export async function readPrices(url: string, topic: string, options: { fresh?: boolean; signal?: AbortSignal } = {}): Promise<ListingPage> {
  const read = await scrapeJson<{ items?: RawItem[] }>(url, ITEM_SCHEMA, itemInstructions(topic), options);
  const { listings, dropped } = cleanItems(read.data?.items ?? [], url, topic);
  return { url, title: hostName(url), listings, dropped, cacheAgeMs: read.cacheAgeMs, tookMs: read.tookMs, mock: false };
}

export const priceQuery = (topic: string): string => `${topic} hinta osta Suomi`;

// Example offers for mock mode (tests, and a laptop with no keys). Labelled as examples wherever they are shown.
function mockSearch(topic: string): ListingSearch {
  const pageUrl = "https://example.com/offers";
  const listings: Listing[] = [649, 729, 899].map((priceEur, index) => ({ title: `${topic} (example offer ${index + 1})`, priceEur, rooms: null, areaM2: null, district: null, city: null, availableFrom: null, details: "example seller", url: `${pageUrl}/${index + 1}`, pageUrl }));
  return { city: null, topic, query: priceQuery(topic), pages: [{ url: pageUrl, title: "example.com", listings, dropped: 0, cacheAgeMs: null, tookMs: 0, mock: true }], found: [{ url: pageUrl, title: "Example offers" }], errors: [], retrievedAt: new Date().toISOString(), tookMs: 0, mock: true };
}

// Finds pages that offer the topic with Exa and reads the first few with Context.dev, side by side.
// One page per site, so three reads cover three different sellers or comparison sites.
export async function searchPrices(topic: string, signal?: AbortSignal): Promise<ListingSearch> {
  if (getConfig().isMock) return mockSearch(topic);
  const started = Date.now();
  const query = priceQuery(topic);
  const results = await exaSearch(query, { numResults: 8, highlights: false, signal });
  const seenHosts = new Set<string>();
  const found = results.filter((result) => URL.canParse(result.url) && !seenHosts.has(hostName(result.url)) && !!seenHosts.add(hostName(result.url)));
  const reads = await Promise.allSettled(found.slice(0, MAX_PAGES).map((page) => readPrices(page.url, topic, { signal })));
  const pages = reads.flatMap((read, index) => (read.status === "fulfilled" && read.value.listings.length ? [{ ...read.value, title: found[index].title }] : []));
  const errors = reads.flatMap((read, index) => (read.status === "rejected" ? [`${hostName(found[index].url)}: ${(read.reason as Error).message}`] : read.value.listings.length ? [] : [`${hostName(found[index].url)}: no offers could be read`]));
  return { city: null, topic, query, pages, found: found.map((page) => ({ url: page.url, title: page.title })), errors, retrievedAt: new Date().toISOString(), tookMs: Date.now() - started, mock: false };
}
