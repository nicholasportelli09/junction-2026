// The hosted store: one row per visitor session in Supabase Postgres, reached through two database functions
// (deploy/supabase/sisu_sessions.sql). No Supabase library: two small HTTPS calls are all it takes.
// A save names the version it was based on. If another server instance saved in between, the database answers
// with the newer state instead of overwriting it, and the caller replays its changes on top (lib/store/state.ts).
import type { SisuState } from "./state";

// `token` is the server's own password for the two functions (SISU_STORE_TOKEN). The key alone is public by design.
export type RemoteStore = { url: string; key: string; token?: string };
export type Loaded = { state: SisuState | null; version: number };
export type Saved = { ok: true; version: number } | { ok: false; state: SisuState; version: number };

const TIMEOUT_MS = 4_000;

async function rpc<T>(store: RemoteStore, name: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${store.url.replace(/\/+$/, "")}/rest/v1/rpc/${name}`, {
    method: "POST",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { apikey: store.key, Authorization: `Bearer ${store.key}`, "Content-Type": "application/json", ...(store.token ? { "X-Sisu-Store-Token": store.token } : {}) },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 200);
    throw new Error(`Supabase ${name} returned ${response.status}: ${detail}`);
  }
  return (await response.json()) as T;
}

// The stored state of a session, or `state: null` with version 0 when the visitor is new.
export async function loadRemote(store: RemoteStore, sessionId: string): Promise<Loaded> {
  const row = await rpc<{ state: SisuState; version: number } | null>(store, "sisu_load", { p_session: sessionId });
  return row ? { state: row.state, version: row.version } : { state: null, version: 0 };
}

// Stores `state` if the session is still at `expectedVersion` (0 for a new visitor).
export async function saveRemote(store: RemoteStore, sessionId: string, state: SisuState, expectedVersion: number): Promise<Saved> {
  return rpc<Saved>(store, "sisu_save", { p_session: sessionId, p_state: state, p_expected: expectedVersion });
}
