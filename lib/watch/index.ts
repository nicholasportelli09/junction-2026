// Watches: started only by an approved action, kept in the visitor's own state, and every change written to the
// audit log. A watch is for flats to rent in a city (topic null) or for anything else with a price (topic = what the
// customer asked for); everything below is the same for both. Context.dev does the watching (one monitor per page,
// plus a search monitor for flats); Sisu polls the monitors' changes, re-reads a page that changed, and code decides
// whether anything now fits the price the customer said.
// If monitors cannot be created, the same pages are re-read on a timer instead, and the watch says so (mode).
import { getConfig } from "@/lib/agent/config";
import { LISTING_SITES, listingKey, readListings } from "@/lib/agent/research/listings";
import { FLAT_PAGE_INSTRUCTIONS, PRICE_PAGE_INSTRUCTIONS, createPageMonitor, createSearchMonitor, deleteMonitor, getMonitor, listChanges, runMonitorNow } from "@/lib/agent/research/monitors";
import { readPrices } from "@/lib/agent/research/prices";
import { buildOverview } from "@/lib/finance/overview";
import { withAudit } from "@/lib/store/audit";
import { type SisuState, readState, updateState } from "@/lib/store/state";
import type { AgentAction, Listing, PropertyWatch, WatchCheck, WatchNotification, WatchPlan, WatchedPage } from "@/lib/types";
import { type FitEvent, detectFits, fits, ruleFor, toNotification } from "./detect";

const MAX_NOTIFICATIONS = 60;
const REREAD_EVERY_MS = 30 * 60_000; // pages without a monitor are read again at most this often
const MAX_NEW_PAGES_PER_CHECK = 2; // pages a search monitor found that Sisu will read in one check

export const listWatches = (customerId: string): PropertyWatch[] => (readState().watches ?? []).filter((watch) => watch.customerId === customerId);
export const listNotifications = (customerId: string): WatchNotification[] => (readState().notifications ?? []).filter((note) => note.customerId === customerId).sort((a, b) => b.detectedAt.localeCompare(a.detectedAt));
// Finds a watch only if it belongs to this customer. Someone else's watch looks exactly like a missing one.
const ownWatch = (customerId: string, watchId: string): PropertyWatch | null => listWatches(customerId).find((watch) => watch.id === watchId) ?? null;
const same = (a: string | null, b: string | null): boolean => (a ?? "").toLowerCase() === (b ?? "").toLowerCase();
export const activeWatch = (customerId: string, plan: Pick<WatchPlan, "city" | "topic" | "budgetEur">): PropertyWatch | null => listWatches(customerId).find((watch) => watch.status === "active" && same(watch.city, plan.city) && same(watch.topic, plan.topic) && watch.budgetEur === plan.budgetEur) ?? null;

export const isWatchKind = (kind: AgentAction["kind"]): boolean => kind === "property_watch" || kind === "price_watch";
// What a watch is for, in a few words: "flats in Helsinki" or the topic the customer named.
export const watchSubject = (watch: Pick<PropertyWatch, "city" | "topic">): string => watch.topic ?? `flats in ${watch.city ?? "your city"}`;

const replaceWatch = (state: SisuState, watch: PropertyWatch): SisuState => ({ ...state, watches: (state.watches ?? []).map((old) => (old.id === watch.id ? watch : old)) });
const hostOf = (url: string): string => new URL(url).hostname.replace(/^www\./, "");

// Starts the watch an approved action describes. Called by the approve routes, straight after the user's approval;
// nothing else calls it, so there is no watch without an approval. Safe to call twice: the second call returns the first watch.
export async function startWatch(customerId: string, action: AgentAction, now: Date = new Date()): Promise<PropertyWatch | null> {
  if (!isWatchKind(action.kind) || action.status !== "executed_simulated" || action.customerId !== customerId || !action.watch) return null;
  const started = listWatches(customerId).find((watch) => watch.actionId === action.id);
  if (started) return started;

  const plan = action.watch;
  const mock = getConfig().isMock;
  const monitorName = plan.topic ? `Sisu price watch: ${plan.topic}` : `Sisu flat watch: ${plan.city}`;
  const monitors = mock ? [] : await Promise.allSettled(plan.urls.map((url) => createPageMonitor(url, monitorName, plan.topic ? PRICE_PAGE_INSTRUCTIONS : FLAT_PAGE_INSTRUCTIONS)));
  // Listings that appear on other sites are looked for by a search monitor. Flats only: the pages it finds are
  // read only if they are on a known rental site, and there is no such list for "anything with a price".
  const search = mock || !plan.city || plan.topic ? null : await createSearchMonitor(plan.city).catch((error: Error) => error);
  const pages: WatchedPage[] = plan.urls.map((url, index) => {
    const monitor = monitors[index];
    return {
      url,
      monitorId: monitor?.status === "fulfilled" ? monitor.value.id : null,
      listings: plan.seen.filter((listing) => listing.pageUrl === url),
      lastReadAt: action.createdAt,
      lastChangeAt: null,
      lastError: monitor?.status === "rejected" ? (monitor.reason as Error).message : null,
    };
  });
  const monitored = pages.filter((page) => page.monitorId).length;
  const watch: PropertyWatch = {
    id: crypto.randomUUID(),
    actionId: action.id,
    customerId,
    city: plan.city,
    topic: plan.topic,
    priceUnit: plan.priceUnit,
    budgetEur: plan.budgetEur,
    minRooms: plan.minRooms,
    status: "active",
    mode: monitored > 0 ? "monitor" : "reread",
    pages,
    searchMonitorId: search && !(search instanceof Error) ? search.id : null,
    createdAt: now.toISOString(),
    lastCheckedAt: null,
    problems: [
      ...(mock ? ["Example data: no key is set, so nothing is being watched on the web."] : []),
      ...(!mock && monitored < pages.length ? [`Context.dev could not start a monitor for ${pages.length - monitored} of ${pages.length} pages; those are re-read on a timer instead.`] : []),
      ...(search instanceof Error ? [`No search monitor for new listings (${search.message})`] : []),
    ],
  };
  const how = watch.mode === "monitor" ? `Context.dev monitors ${[...pages.flatMap((page) => (page.monitorId ? [page.monitorId] : [])), ...(watch.searchMonitorId ? [`${watch.searchMonitorId} (search)`] : [])].join(", ")}` : "the pages are re-read on a timer (no monitor)";
  updateState((state) => withAudit({ ...state, watches: [...(state.watches ?? []), watch] }, { customerId, type: "watch_started", actor: "system", actionId: action.id, detail: `Watching ${pages.length} page${pages.length === 1 ? "" : "s"} for ${watchSubject(plan)} at €${plan.budgetEur}${plan.priceUnit === "EUR/month" ? " a month" : ""} or less: ${how}.` }, now));
  return watch;
}

type PageResult = { page: WatchedPage; events: FitEvent[]; reread: boolean; changes: number; problem: string | null };

// Reads a page again, as it is right now, and compares it with the last reading.
async function reread(watch: PropertyWatch, page: WatchedPage, now: Date): Promise<Pick<PageResult, "page" | "events" | "problem">> {
  try {
    const read = watch.topic ? await readPrices(page.url, watch.topic, { fresh: true }) : await readListings(page.url, { fresh: true, city: watch.city ?? undefined });
    if (!read.listings.length) return { page: { ...page, lastError: "The page had nothing Sisu could read." }, events: [], problem: `${hostOf(page.url)}: nothing could be read` };
    return { page: { ...page, listings: read.listings, lastReadAt: now.toISOString(), lastError: null }, events: detectFits(page.listings, read.listings, ruleFor(watch)), problem: null };
  } catch (error) {
    return { page: { ...page, lastError: (error as Error).message }, events: [], problem: `${hostOf(page.url)}: ${(error as Error).message}` };
  }
}

async function checkPage(watch: PropertyWatch, page: WatchedPage, runNow: boolean, now: Date): Promise<PageResult> {
  if (!page.monitorId) {
    const due = runNow || now.getTime() - Date.parse(page.lastReadAt) >= REREAD_EVERY_MS;
    return due ? { ...(await reread(watch, page, now)), reread: true, changes: 0 } : { page, events: [], reread: false, changes: 0, problem: null };
  }
  try {
    if (runNow) await runMonitorNow(page.monitorId).catch(() => null); // a run already in progress is fine
    const [monitor, changes] = await Promise.all([getMonitor(page.monitorId), listChanges(page.monitorId, page.lastChangeAt ?? watch.createdAt)]);
    const fresh = changes.filter((change) => change.detectedAt > (page.lastChangeAt ?? ""));
    const seen = { ...page, lastError: monitor.lastError };
    if (!fresh.length) return { page: seen, events: [], reread: false, changes: 0, problem: monitor.lastError ? `${hostOf(page.url)}: ${monitor.lastError}` : null };
    // Context.dev says the page changed. What changed is read again by code, not taken from the change's own text.
    const newest = fresh.map((change) => change.detectedAt).sort().at(-1) ?? null;
    const result = await reread(watch, { ...seen, lastChangeAt: newest }, now);
    return { ...result, reread: true, changes: fresh.length };
  } catch (error) {
    return { page, events: [], reread: false, changes: 0, problem: `${hostOf(page.url)}: ${(error as Error).message}` };
  }
}

// New pages a search monitor found. Only pages on the known listing sites are read, so a search result cannot
// steer Sisu to a page of someone's choosing. Flats on them that fit are new listings.
async function checkSearch(watch: PropertyWatch): Promise<{ events: FitEvent[]; changes: number; problem: string | null }> {
  if (!watch.searchMonitorId) return { events: [], changes: 0, problem: null };
  try {
    const since = watch.lastCheckedAt ?? watch.createdAt;
    const changes = (await listChanges(watch.searchMonitorId, since)).filter((change) => change.detectedAt > since);
    const watched = new Set(watch.pages.map((page) => page.url));
    const urls = [...new Set(changes.flatMap((change) => change.matchedUrls))].filter((url) => !watched.has(url) && LISTING_SITES.some((site) => URL.canParse(url) && (hostOf(url) === site || hostOf(url).endsWith(`.${site}`))));
    const known = new Set(watch.pages.flatMap((page) => page.listings.map(listingKey)));
    const reads = await Promise.allSettled(urls.slice(0, MAX_NEW_PAGES_PER_CHECK).map((url) => readListings(url, { fresh: true, city: watch.city ?? undefined })));
    const found = reads.flatMap((read) => (read.status === "fulfilled" ? read.value.listings : []));
    const events = found.filter((listing) => fits(listing, ruleFor(watch)) && !known.has(listingKey(listing))).map((listing): FitEvent => ({ kind: "new_listing", listing, previousPriceEur: null }));
    return { events, changes: changes.length, problem: null };
  } catch (error) {
    return { events: [], changes: 0, problem: `search monitor: ${(error as Error).message}` };
  }
}

// Stores what a check found: the pages as they are now, a notification for each flat that fits, and the audit lines.
function record(watch: PropertyWatch, next: PropertyWatch, notes: WatchNotification[], detail: string | null, now: Date): void {
  updateState((state) => {
    const stored = { ...replaceWatch(state, next), notifications: [...notes, ...(state.notifications ?? [])].slice(0, MAX_NOTIFICATIONS) };
    const checked = detail ? withAudit(stored, { customerId: watch.customerId, type: "watch_checked", actor: "system", actionId: watch.actionId, detail }, now) : stored;
    return notes.reduce((current, note) => withAudit(current, { customerId: watch.customerId, type: "watch_notified", actor: "system", actionId: watch.actionId, detail: `${note.simulated ? "SIMULATED (demo button), not a real change. " : ""}${note.title}, €${Math.round(note.underBudgetByEur)} under the limit of €${Math.round(note.budgetEur)}.` }, now), checked);
  });
}

// Polls every active watch of this customer. `runNow` also asks Context.dev to check each page now instead of
// waiting for its schedule; that run is queued, so its result is picked up by a later check.
export async function checkWatches(customerId: string, options: { runNow?: boolean; now?: Date } = {}): Promise<WatchCheck> {
  const now = options.now ?? new Date();
  const overview = buildOverview(customerId);
  const watches = listWatches(customerId).filter((watch) => watch.status === "active");
  const summary: WatchCheck = { customerId, checked: watches.length, changesSeen: 0, pagesReread: 0, notifications: [], problems: [] };
  if (!overview) return summary;

  for (const watch of watches) {
    const results = await Promise.all(watch.pages.map((page) => checkPage(watch, page, options.runNow === true, now)));
    const search = await checkSearch(watch);
    const seenKeys = new Set<string>();
    const events = [...results.flatMap((result) => result.events), ...search.events].filter((event) => !seenKeys.has(listingKey(event.listing)) && !!seenKeys.add(listingKey(event.listing)));
    const notes = events.map((event) => toNotification(watch, overview, event, watch.mode === "monitor" ? "context.dev monitor" : "context.dev re-read", now));
    const problems = [...results.flatMap((result) => (result.problem ? [result.problem] : [])), ...(search.problem ? [search.problem] : [])];
    const changes = results.reduce((total, result) => total + result.changes, 0) + search.changes;
    const rereadCount = results.filter((result) => result.reread).length;
    const next: PropertyWatch = { ...watch, pages: results.map((result) => result.page), lastCheckedAt: now.toISOString(), problems };
    record(watch, next, notes, rereadCount || changes ? `Checked the watch for ${watchSubject(watch)}: Context.dev reported ${changes} change${changes === 1 ? "" : "s"}, ${rereadCount} page${rereadCount === 1 ? "" : "s"} read again, ${notes.length} within the limit.` : null, now);
    summary.changesSeen += changes;
    summary.pagesReread += rereadCount;
    summary.notifications.push(...notes);
    summary.problems.push(...problems);
  }
  return summary;
}

export type SimulationResult = { ok: true; notification: WatchNotification } | { ok: false; status: 404 | 409; reason: string };

// For the demo: pretends one watched offer's price fell to just under the limit and runs it through the same
// comparison a real change goes through. The notification and the audit line are both marked as simulated, and
// the stored reading of the page is left as it really is.
export function simulatePriceDrop(customerId: string, watchId: string, now: Date = new Date()): SimulationResult {
  const watch = ownWatch(customerId, watchId);
  const overview = buildOverview(customerId);
  if (!watch || !overview) return { ok: false, status: 404, reason: "We could not find that watch." };
  if (watch.status !== "active") return { ok: false, status: 409, reason: "This watch has been stopped." };
  const enoughRooms = (listing: Listing): boolean => watch.minRooms === null || (listing.rooms ?? 0) >= watch.minRooms;
  // The cheapest watched flat that is over the budget, wherever it is listed.
  const target = watch.pages.flatMap((candidate) => candidate.listings).filter((listing) => listing.priceEur > watch.budgetEur && enoughRooms(listing)).sort((a, b) => a.priceEur - b.priceEur)[0];
  const page = target ? watch.pages.find((candidate) => candidate.listings.includes(target)) : undefined;
  if (!page || !target) return { ok: false, status: 409, reason: "Nothing being watched is over the limit, so there is no price to drop." };
  const already = listNotifications(customerId).find((note) => note.simulated && note.watchId === watch.id && listingKey(note.listing) === listingKey(target));
  if (already) return { ok: true, notification: already };

  const droppedTo = Math.floor((watch.budgetEur * 0.97) / 5) * 5;
  const pretend = page.listings.map((listing) => (listing === target ? { ...listing, priceEur: droppedTo } : listing));
  const [event] = detectFits(page.listings, pretend, ruleFor(watch));
  if (!event) return { ok: false, status: 409, reason: "The simulated price did not come in under the budget." };
  const notification = toNotification(watch, overview, event, "simulation", now);
  record(watch, watch, [notification], null, now);
  return { ok: true, notification };
}

// Stops a watch and removes its Context.dev monitors, so nothing keeps running (or costing credits) after it.
export async function stopWatch(customerId: string, watchId: string, now: Date = new Date()): Promise<PropertyWatch | null> {
  const watch = ownWatch(customerId, watchId);
  if (!watch) return null;
  if (watch.status === "stopped") return watch;
  const ids = [...watch.pages.flatMap((page) => (page.monitorId ? [page.monitorId] : [])), ...(watch.searchMonitorId ? [watch.searchMonitorId] : [])];
  const removed = await Promise.allSettled(ids.map((id) => deleteMonitor(id)));
  const failed = removed.filter((result) => result.status === "rejected").length;
  const stopped: PropertyWatch = { ...watch, status: "stopped", problems: failed ? [`${failed} Context.dev monitor${failed === 1 ? "" : "s"} could not be removed.`] : [] };
  updateState((state) => withAudit(replaceWatch(state, stopped), { customerId, type: "watch_stopped", actor: "user", actionId: watch.actionId, detail: `Stopped watching ${watchSubject(watch)}; ${ids.length - failed} of ${ids.length} Context.dev monitors removed.` }, now));
  return stopped;
}

// Before a demo reset: stop every watch of these customers so their monitors do not outlive the state that knew them.
export async function stopAllWatches(customerIds: string[]): Promise<number> {
  const active = (readState().watches ?? []).filter((watch) => customerIds.includes(watch.customerId) && watch.status === "active");
  await Promise.all(active.map((watch) => stopWatch(watch.customerId, watch.id)));
  return active.length;
}
