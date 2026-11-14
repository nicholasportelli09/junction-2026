"use client";

import { useCallback, useEffect, useState } from "react";
import type { WatchCheck, WatchList } from "@/lib/types";

const LIST_EVERY_MS = 5_000; // reads Sisu's own state only
const CHECK_EVERY_MS = 60_000; // asks Context.dev whether a watched page changed
const host = (url: string) => new URL(url).hostname.replace(/^www\./, "");
const time = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString() : "not yet");

async function post<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(result?.error ?? "That did not work. Please try again.");
  return result as T;
}

// Development view of a property watch: what is being watched, what Context.dev last said, and what was found.
export function WatchPanel({ customerId }: { customerId: string | null }) {
  const [list, setList] = useState<WatchList | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!customerId) return;
    const response = await fetch(`/api/watch?customerId=${customerId}`).catch(() => null);
    if (response?.ok) setList((await response.json()) as WatchList);
  }, [customerId]);

  const check = useCallback(
    async (runNow: boolean) => {
      if (!customerId) return;
      setBusy(true);
      try {
        const result = await post<WatchCheck>("/api/watch/check", { customerId, runNow });
        setNote(`Checked at ${new Date().toLocaleTimeString()}: Context.dev reported ${result.changesSeen} change(s), ${result.pagesReread} page(s) read again, ${result.notifications.length} new notification(s).${runNow ? " A fresh check of each page is queued at Context.dev; check again in a minute." : ""}${result.problems.length ? ` Problems: ${result.problems.join("; ")}` : ""}`);
      } catch (error) {
        setNote((error as Error).message);
      } finally {
        setBusy(false);
        void load();
      }
    },
    [customerId, load],
  );

  const act = async (path: string) => {
    if (!customerId) return;
    setBusy(true);
    try {
      await post(path, { customerId });
      setNote(null);
    } catch (error) {
      setNote((error as Error).message);
    } finally {
      setBusy(false);
      void load();
    }
  };

  const hasActive = list?.watches.some((watch) => watch.status === "active") ?? false;
  useEffect(() => {
    const first = setTimeout(() => void load(), 0);
    const timer = setInterval(() => void load(), LIST_EVERY_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [load]);
  useEffect(() => {
    if (!hasActive) return;
    const timer = setInterval(() => void check(false), CHECK_EVERY_MS);
    return () => clearInterval(timer);
  }, [hasActive, check]);

  if (!list || (!list.watches.length && !list.notifications.length)) return null;
  return (
    <section aria-label="Property watch" className="space-y-2 rounded-2xl border border-line bg-card p-3 text-sm">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted">Property watch</p>
      {list.watches.map((watch) => (
        <div key={watch.id} className="space-y-1">
          <p className="font-semibold">
            {watch.city}: €{watch.budgetEur} a month or less{watch.minRooms ? `, ${watch.minRooms}+ rooms` : ""} · {watch.status}
          </p>
          <p className="text-xs text-muted">
            {watch.mode === "monitor" ? "Watched by Context.dev monitors; Sisu polls their changes." : "No monitor: Sisu re-reads the pages on a timer."} Last checked: {time(watch.lastCheckedAt)}.
          </p>
          <ul className="text-xs text-muted">
            {watch.pages.map((page) => (
              <li key={page.url}>
                {host(page.url)} · {page.listings.length} flats read · {page.monitorId ?? "no monitor"}
                {page.lastChangeAt ? ` · changed ${time(page.lastChangeAt)}` : ""}
                {page.lastError ? ` · ${page.lastError}` : ""}
              </li>
            ))}
            {watch.searchMonitorId && <li>new listings elsewhere · {watch.searchMonitorId} (search monitor)</li>}
          </ul>
          {watch.problems.length > 0 && <p className="text-xs text-coral">{watch.problems.join(" ")}</p>}
          {watch.status === "active" && (
            <div className="flex flex-wrap gap-2">
              <button type="button" disabled={busy} onClick={() => void check(true)} className="min-h-11 rounded-xl border border-line bg-paper px-3 font-semibold disabled:opacity-40">Check now</button>
              <button type="button" disabled={busy} onClick={() => void act(`/api/watch/${watch.id}/simulate-drop`)} className="min-h-11 rounded-xl border border-line bg-paper px-3 font-semibold disabled:opacity-40">Simulate a price drop</button>
              <button type="button" disabled={busy} onClick={() => void act(`/api/watch/${watch.id}/stop`)} className="min-h-11 rounded-xl border border-line bg-paper px-3 font-semibold disabled:opacity-40">Stop watching</button>
            </div>
          )}
        </div>
      ))}
      {note && <p className="text-xs text-muted">{note}</p>}
      {list.notifications.map((notification) => (
        <div key={notification.id} role="status" className="space-y-1 rounded-xl border border-green bg-green/10 p-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-green">
            {notification.simulated ? "Notification · simulated for the demo" : `Notification · ${notification.detectedBy}`} · {time(notification.detectedAt)}
          </p>
          <p className="font-semibold">{notification.title}</p>
          <p className="text-muted">{notification.summary}</p>
          <a href={notification.listing.url} target="_blank" rel="noreferrer" className="text-xs underline">{host(notification.listing.url)}</a>
        </div>
      ))}
    </section>
  );
}
