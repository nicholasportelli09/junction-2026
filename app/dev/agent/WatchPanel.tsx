"use client";

import { useState } from "react";
import type { PropertyWatch, WatchCheck, WatchNotification } from "@/lib/types";

const host = (url: string) => new URL(url).hostname.replace(/^www\./, "");
const time = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString() : "not yet");

type Props = {
  watches: PropertyWatch[];
  notifications: WatchNotification[];
  onCheck: (runNow: boolean) => Promise<WatchCheck | null>;
  onStop: (watchId: string) => Promise<void>;
  onSimulate: (watchId: string) => Promise<WatchNotification | null>;
};

// A property watch on screen: what is being watched, what Context.dev last said, and what was found.
// Everything it shows comes from useSisu (watches, notifications, checkWatches, stopWatch, simulatePriceDrop),
// which also checks an active watch once a minute. Copy this card into the real UI as it is.
export function WatchPanel({ watches, notifications, onCheck, onStop, onSimulate }: Props) {
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (work: () => Promise<string | null>) => {
    setBusy(true);
    try {
      setNote(await work());
    } catch (error) {
      setNote((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const checkNow = () =>
    run(async () => {
      const result = await onCheck(true);
      if (!result) return "The check did not go through. Please try again.";
      return `Checked at ${new Date().toLocaleTimeString()}: Context.dev reported ${result.changesSeen} change(s), ${result.pagesReread} page(s) read again, ${result.notifications.length} new notification(s). A fresh check of each page is queued at Context.dev; check again in a minute.${result.problems.length ? ` Problems: ${result.problems.join("; ")}` : ""}`;
    });

  if (!watches.length && !notifications.length) return null;
  return (
    <section aria-label="Watches" className="space-y-2 rounded-2xl border border-line bg-card p-3 text-sm">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted">Watching for you</p>
      {watches.map((watch) => (
        <div key={watch.id} className="space-y-1">
          <p className="font-semibold">
            {watch.topic ?? `Flats in ${watch.city}`}: €{watch.budgetEur}{watch.priceUnit === "EUR/month" ? " a month" : ""} or less{watch.minRooms ? `, ${watch.minRooms}+ rooms` : ""} · {watch.status}
          </p>
          <p className="text-xs text-muted">
            {watch.mode === "monitor" ? "Watched by Context.dev monitors; Sisu polls their changes." : "No monitor: Sisu re-reads the pages on a timer."} Last checked: {time(watch.lastCheckedAt)}.
          </p>
          <ul className="text-xs text-muted">
            {watch.pages.map((page) => (
              <li key={page.url}>
                {host(page.url)} · {page.listings.length} {watch.topic ? "offers" : "flats"} read · {page.monitorId ?? "no monitor"}
                {page.lastChangeAt ? ` · changed ${time(page.lastChangeAt)}` : ""}
                {page.lastError ? ` · ${page.lastError}` : ""}
              </li>
            ))}
            {watch.searchMonitorId && <li>new listings elsewhere · {watch.searchMonitorId} (search monitor)</li>}
          </ul>
          {watch.problems.length > 0 && <p className="text-xs text-coral">{watch.problems.join(" ")}</p>}
          {watch.status === "active" && (
            <div className="flex flex-wrap gap-2">
              <button type="button" disabled={busy} onClick={() => void checkNow()} className="min-h-11 rounded-xl border border-line bg-paper px-3 font-semibold disabled:opacity-40">Check now</button>
              <button type="button" disabled={busy} onClick={() => void run(async () => ((await onSimulate(watch.id)), null))} className="min-h-11 rounded-xl border border-line bg-paper px-3 font-semibold disabled:opacity-40">Simulate a price drop</button>
              <button type="button" disabled={busy} onClick={() => void run(async () => ((await onStop(watch.id)), null))} className="min-h-11 rounded-xl border border-line bg-paper px-3 font-semibold disabled:opacity-40">Stop watching</button>
            </div>
          )}
        </div>
      ))}
      {note && <p className="text-xs text-muted">{note}</p>}
      {notifications.map((notification) => (
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
