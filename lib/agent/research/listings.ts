// Rental listings: Exa finds the pages, Context.dev reads each one into typed listings (the same call that reads
// offer pages), and code filters them against the budget. Only a city and the topic ever leave the server: the
// budget is applied here, never sent. Everything a page says is untrusted until it has been through cleanListings.
import type { Listing } from "@/lib/types";
import { getConfig, missingKey } from "../config";
import { safeName } from "../tools/untrusted";
import { exaSearch } from "./exa";

export type ListingPage = { url: string; title: string; listings: Listing[]; dropped: number; cacheAgeMs: number | null; tookMs: number; mock: boolean };
export type ListingSearch = { city: string; query: string; pages: ListingPage[]; found: { url: string; title: string }[]; errors: string[]; retrievedAt: string; tookMs: number; mock: boolean };

const PAGE_TIMEOUT_MS = 16_000; // a page of listings takes Context.dev 7 to 13 seconds
const MAX_LISTINGS_PER_PAGE = 12;
export const MAX_PAGES = 3; // Context.dev allows our key ten page reads a minute
export const RENT_LIMITS: [number, number] = [100, 20_000];
const ROOM_LIMITS: [number, number] = [1, 12];
const AREA_LIMITS: [number, number] = [5, 500];
// Sites that publish Finnish rental listings as ordinary pages. Asking Exa for these keeps blog posts out.
export const LISTING_SITES = ["vuokraovi.com", "asunnot.oikotie.fi", "lumo.fi", "sato.fi", "etuovi.com", "qasa.com", "rentola.fi"];

export const LISTING_SCHEMA = {
  type: "object",
  required: ["listings"],
  properties: {
    listings: {
      type: "array",
      items: {
        type: "object",
        required: ["title", "pricePerMonthEur", "rooms", "areaM2", "district", "city", "availableFrom", "url"],
        properties: {
          title: { type: "string", description: "Street address of the flat, or the listing's short title" },
          pricePerMonthEur: { type: ["number", "null"], description: "Rent per month in euros, as a number" },
          rooms: { type: ["number", "null"], description: "Number of rooms, not counting the kitchen" },
          areaM2: { type: ["number", "null"], description: "Living area in square metres" },
          district: { type: ["string", "null"], description: "District or neighbourhood" },
          city: { type: ["string", "null"], description: "City or municipality the flat is in" },
          availableFrom: { type: ["string", "null"], description: "When the flat is free, as the page states it" },
          url: { type: ["string", "null"], description: "Link to this listing's own page, if the page gives one" },
        },
      },
    },
  },
};
export const LISTING_INSTRUCTIONS = `Flats offered for rent on this page. Use only facts stated on the page. At most ${MAX_LISTINGS_PER_PAGE} listings.`;

type RawListing = Partial<Record<keyof Listing, unknown>>;
type ScrapeResponse = { json?: { success?: boolean | null; data?: { listings?: RawListing[] } | null; message?: string }; cache_metadata?: { age_ms?: number } | null };

const inRange = (value: unknown, [low, high]: [number, number]): number | null => (typeof value === "number" && Number.isFinite(value) && value >= low && value <= high ? value : null);
const hostOf = (url: string): string | null => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.hostname.replace(/^www\./, "") : null;
  } catch {
    return null;
  }
};

// A link taken from a page is followed later (Context.dev reads it), so it must stay on the site it came from.
function ownLink(value: unknown, pageUrl: string): string {
  if (typeof value !== "string" || !value.trim()) return pageUrl;
  try {
    const link = new URL(value.trim(), pageUrl);
    return hostOf(link.href) === hostOf(pageUrl) ? link.href : pageUrl;
  } catch {
    return pageUrl;
  }
}

// Page text is untrusted. A listing is kept only if it has a plausible monthly rent and its title reads like an
// address or a name: short, no links, nothing phrased as an instruction. The rest is dropped and counted.
export function cleanListings(extracted: RawListing[], pageUrl: string): { listings: Listing[]; dropped: number } {
  const candidates = (Array.isArray(extracted) ? extracted : []).slice(0, MAX_LISTINGS_PER_PAGE);
  const listings = candidates.flatMap((raw): Listing[] => {
    const title = safeName(raw?.title, 90);
    const price = inRange(raw?.pricePerMonthEur, RENT_LIMITS);
    if (!title || price === null) return [];
    return [
      {
        title,
        pricePerMonthEur: Math.round(price * 100) / 100,
        rooms: inRange(raw.rooms, ROOM_LIMITS),
        areaM2: inRange(raw.areaM2, AREA_LIMITS),
        district: safeName(raw.district, 50),
        city: safeName(raw.city, 40),
        availableFrom: safeName(raw.availableFrom, 30),
        url: ownLink(raw.url, pageUrl),
        pageUrl,
      },
    ];
  });
  return { listings, dropped: candidates.length - listings.length };
}

// A page for one city often lists flats in its neighbours too. A flat is kept unless the page says it is somewhere else.
export const inCity = (listing: Listing, city: string): boolean => !listing.city || listing.city.toLowerCase().includes(city.toLowerCase()) || city.toLowerCase().includes(listing.city.toLowerCase());

// What makes two readings of a page the same flat: its own link if it has one, otherwise its address and size.
export const listingKey = (listing: Listing): string => (listing.url !== listing.pageUrl ? listing.url : `${listing.pageUrl}#${listing.title.toLowerCase()}|${listing.rooms ?? "?"}|${listing.areaM2 ?? "?"}`);

// Reads one page of rental listings with Context.dev. `fresh` asks for the page as it is now (a watch re-reading a
// page that changed); otherwise a copy up to 15 minutes old is accepted and its age is reported.
export async function readListings(url: string, options: { fresh?: boolean; signal?: AbortSignal; city?: string } = {}): Promise<ListingPage> {
  const { contextDev } = getConfig();
  if (!contextDev.apiKey) throw missingKey("Context.dev", "CONTEXT_DEV_API_KEY");
  const started = Date.now();
  const timeout = AbortSignal.timeout(PAGE_TIMEOUT_MS);
  const response = await fetch("https://api.context.dev/v1/web/scrape", {
    method: "POST",
    signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    headers: { Authorization: `Bearer ${contextDev.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ url, formats: { json: true }, jsonParams: { schema: LISTING_SCHEMA, instructions: LISTING_INSTRUCTIONS }, sharedParams: { mainContentOnly: true }, maxAgeMs: options.fresh ? 0 : 15 * 60_000 }),
  });
  if (!response.ok) {
    console.error(`[agent] Context.dev returned ${response.status}: ${(await response.text().catch(() => "")).slice(0, 200)}`);
    throw new Error(response.status === 429 ? "Context.dev is at its limit of page reads for this minute." : `Context.dev could not read the page (${response.status}).`);
  }
  const body = (await response.json()) as ScrapeResponse;
  // A 200 response can still carry a failed output, so the success flag is checked on its own.
  if (body.json?.success !== true) throw new Error(body.json?.message ?? "Context.dev found no listings on the page.");
  const cleaned = cleanListings(body.json.data?.listings ?? [], url);
  const { city } = options;
  const listings = city ? cleaned.listings.filter((listing) => inCity(listing, city)) : cleaned.listings;
  const dropped = cleaned.dropped;
  const age = body.cache_metadata?.age_ms;
  return { url, title: hostOf(url) ?? url, listings, dropped, cacheAgeMs: typeof age === "number" ? age : null, tookMs: Date.now() - started, mock: false };
}

// A city name the customer said, safe to put in a search query: letters, spaces and hyphens only.
export function cleanCity(value: unknown): string | null {
  const name = safeName(value, 40);
  return name && /^[\p{L}][\p{L} -]*$/u.test(name) ? name : null;
}

export const listingQuery = (city: string): string => `vuokra-asunnot ${city} vapaat vuokrattavat asunnot`;

// Example listings for mock mode (tests, and a laptop with no keys). Labelled as examples wherever they are shown.
function mockSearch(city: string): ListingSearch {
  const pageUrl = `https://example.com/vuokra-asunnot/${city.toLowerCase()}`;
  const listings = [
    { title: "Esimerkkikatu 4 A", pricePerMonthEur: 1_040, rooms: 1, areaM2: 31, district: "Kallio" },
    { title: "Mallitie 12 B", pricePerMonthEur: 1_180, rooms: 2, areaM2: 44, district: "Vallila" },
    { title: "Testikuja 7", pricePerMonthEur: 965, rooms: 1, areaM2: 27, district: "Malmi" },
  ].map((listing, index) => ({ ...listing, city, availableFrom: null, url: `${pageUrl}/${index + 1}`, pageUrl }));
  return { city, query: listingQuery(city), pages: [{ url: pageUrl, title: "example.com", listings, dropped: 0, cacheAgeMs: null, tookMs: 0, mock: true }], found: [{ url: pageUrl, title: "Example listings" }], errors: [], retrievedAt: new Date().toISOString(), tookMs: 0, mock: true };
}

// Finds rental listing pages for a city with Exa and reads the first few with Context.dev, side by side.
// The query holds the city and the topic, nothing else. A page that cannot be read is reported, not hidden.
export async function searchListings(city: string, signal?: AbortSignal): Promise<ListingSearch> {
  if (getConfig().isMock) return mockSearch(city);
  const started = Date.now();
  const query = listingQuery(city);
  const results = await exaSearch(query, { numResults: 8, highlights: false, signal, includeDomains: LISTING_SITES });
  const seenHosts = new Set<string>();
  // A site's first page of results before its later ones (new flats appear there), then one page per site, so
  // three reads cover three different sources.
  const deepPage = (url: string): number => Number(/[?&]page=(?!1(?:\D|$))\d/.test(url));
  const found = [...results].sort((a, b) => deepPage(a.url) - deepPage(b.url)).filter((result) => {
    const host = hostOf(result.url);
    return !!host && !seenHosts.has(host) && !!seenHosts.add(host);
  });
  const reads = await Promise.allSettled(found.slice(0, MAX_PAGES).map((page) => readListings(page.url, { signal, city })));
  const pages = reads.flatMap((read, index) => (read.status === "fulfilled" && read.value.listings.length ? [{ ...read.value, title: found[index].title }] : []));
  const errors = reads.flatMap((read, index) => (read.status === "rejected" ? [`${hostOf(found[index].url)}: ${(read.reason as Error).message}`] : read.value.listings.length ? [] : [`${hostOf(found[index].url)}: no listings could be read`]));
  return { city, query, pages, found: found.map((page) => ({ url: page.url, title: page.title })), errors, retrievedAt: new Date().toISOString(), tookMs: Date.now() - started, mock: false };
}
