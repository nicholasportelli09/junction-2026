// Sisu's small persistent state: remembered preferences, prepared actions and the audit log.
//
// Two places it can live, chosen by the environment (nothing else in the code knows which):
//   file      One JSON file, written atomically. The default, and what the booth laptop uses.
//   supabase  One row per visitor session in Supabase Postgres, for a hosted site (lib/store/supabase.ts).
//             On when SUPABASE_URL and a Supabase key are set; SISU_STORE=file switches it off.
//
// Reads and writes stay synchronous, so within one server process an update can never interleave with another.
// With Supabase the state is fetched once when a request starts (openSession) and every change is sent as soon
// as it is made; a route waits for that before it answers (settleSession).
//
// State is kept per session (lib/store/session.ts). Without a session it is the one shared state, as before.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { AgentAction, AuditEvent, CustomerMemory } from "@/lib/types";
import { SHARED, currentSession } from "./session";
import { type RemoteStore, loadRemote, saveRemote } from "./supabase";

export type SisuState = {
  version: 1;
  memory: Record<string, CustomerMemory>;
  actions: AgentAction[];
  audit: AuditEvent[];
};

const EMPTY: SisuState = { version: 1, memory: {}, actions: [], audit: [] };
const DEFAULT_FILE = ".sisu/state.json";
const MAX_SAVE_ATTEMPTS = 5; // how often a save is retried on top of a newer state before giving up
const MAX_SESSIONS_IN_MEMORY = 500;

type Change = (state: SisuState) => SisuState;
type Slot = {
  state: SisuState; // what reads see: `base` with every change that is not stored yet applied
  base: SisuState; // the last state known to be stored (Supabase only)
  version: number; // of `base` in the database; 0 for a session that has no row yet
  pending: Change[]; // made here, not stored yet (Supabase only)
  saving: Promise<void> | null;
  persistent: boolean;
};

const globalStore = globalThis as unknown as { __sisuSlots?: Map<string, Slot>; __sisuStoreWarned?: Set<string> };
const slots: Map<string, Slot> = (globalStore.__sisuSlots ??= new Map());
const warned: Set<string> = (globalStore.__sisuStoreWarned ??= new Set());

function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  console.error(`[store] ${message}`);
}

const env = (name: string): string => process.env[name]?.trim() ?? "";
// The names the Supabase dashboard and Vercel's Supabase integration use, most private first.
const KEY_NAMES = ["SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_ANON_KEY", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY"];

export type StoreConfig = { kind: "file" | "supabase"; remote: RemoteStore | null; perVisitor: boolean };

// SISU_STORE: "file" or "supabase". Unset means Supabase when its address and a key are present, else the file.
// SISU_SESSIONS: "visitor" (each visitor has their own state) or "shared" (one state for everyone).
// Unset means "visitor" with Supabase and "shared" with the file, which is what a hosted site and a booth need.
export function storeConfig(): StoreConfig {
  const url = env("SUPABASE_URL") || env("NEXT_PUBLIC_SUPABASE_URL");
  const key = KEY_NAMES.map(env).find(Boolean) ?? "";
  const wanted = env("SISU_STORE").toLowerCase();
  const token = env("SISU_STORE_TOKEN");
  const remote = url && key && wanted !== "file" ? { url, key, ...(token ? { token } : {}) } : null;
  if (wanted === "supabase" && !remote) warnOnce("SISU_STORE=supabase needs SUPABASE_URL and SUPABASE_SECRET_KEY (or SUPABASE_PUBLISHABLE_KEY); using the file store instead");
  const sessions = env("SISU_SESSIONS").toLowerCase();
  return { kind: remote ? "supabase" : "file", remote, perVisitor: sessions === "visitor" || (sessions !== "shared" && !!remote) };
}

function isState(value: unknown): value is SisuState {
  const candidate = value as SisuState | null;
  return !!candidate && candidate.version === 1 && typeof candidate.memory === "object" && Array.isArray(candidate.actions) && Array.isArray(candidate.audit);
}

const newSlot = (state: SisuState): Slot => ({ state, base: state, version: 0, pending: [], saving: null, persistent: true });

function remember(key: string, slot: Slot): Slot {
  if (slots.size >= MAX_SESSIONS_IN_MEMORY) {
    // Oldest first. A session with unsaved changes is never dropped.
    for (const [oldKey, old] of slots) {
      if (slots.size < MAX_SESSIONS_IN_MEMORY) break;
      if (!old.saving && !old.pending.length) slots.delete(oldKey);
    }
  }
  slots.set(key, slot);
  return slot;
}

// ---- File store

// The path is only known at run time, so the bundler is told not to trace it.
const statePath = (): string => resolve(/*turbopackIgnore: true*/ process.cwd(), env("SISU_STATE_FILE") || DEFAULT_FILE);
// A visitor's own state sits next to the shared file, one file per session.
const sessionPath = (sessionId: string): string => (sessionId === SHARED ? statePath() : resolve(`${statePath()}.sessions`, `${sessionId}.json`));

function fileSlot(sessionId: string): { slot: Slot; file: string } {
  const file = sessionPath(sessionId);
  const key = `file|${file}`;
  const known = slots.get(key);
  if (known) return { slot: known, file };
  let state = EMPTY;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (isState(parsed)) state = parsed;
    else console.error("[store] state file had an unexpected shape; starting empty");
  } catch (error) {
    // A missing file is the normal first run. Anything else is worth a log line.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error("[store] could not read state; starting empty:", (error as Error).message);
  }
  return { slot: remember(key, newSlot(state)), file };
}

function saveFile(slot: Slot, file: string): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(slot.state, null, 2));
    renameSync(temporary, file); // atomic on one filesystem: readers see the old file or the new one, never half
    slot.persistent = true;
  } catch (error) {
    if (slot.persistent) console.error("[store] cannot write state to disk; keeping it in memory only:", (error as Error).message);
    slot.persistent = false;
  }
}

// ---- Supabase store

const remoteKey = (remote: RemoteStore, sessionId: string): string => `supabase|${remote.url}|${sessionId}`;

function remoteSlot(remote: RemoteStore, sessionId: string): Slot {
  const key = remoteKey(remote, sessionId);
  const known = slots.get(key);
  if (known) return known;
  // Reached without openSession: the route is not wrapped in withVisitor. The state starts empty in memory and
  // the first save finds out what is really stored (the version check replays the change on top of it).
  warnOnce("state was used before the session was opened; wrap the route in withVisitor (lib/agent/visitor.ts)");
  return remember(key, newSlot(EMPTY));
}

// Sends what is pending. If the database holds a newer version (another server instance saved in between),
// the pending changes are replayed on top of it and sent again, so no instance overwrites another's work.
async function push(remote: RemoteStore, sessionId: string, slot: Slot): Promise<void> {
  try {
    for (let attempt = 0; slot.pending.length > 0; attempt += 1) {
      if (attempt >= MAX_SAVE_ATTEMPTS) throw new Error(`gave up after ${MAX_SAVE_ATTEMPTS} attempts on top of newer versions`);
      const sent = slot.state;
      const count = slot.pending.length;
      const answer = await saveRemote(remote, sessionId, sent, slot.version);
      if (answer.ok) {
        slot.base = sent;
        slot.version = answer.version;
        slot.pending = slot.pending.slice(count); // changes made while the save was on its way stay pending
        slot.persistent = true;
        attempt = -1;
      } else {
        slot.base = isState(answer.state) ? answer.state : EMPTY;
        slot.version = answer.version;
        slot.state = slot.pending.reduce((state, change) => change(state), slot.base);
      }
    }
  } catch (error) {
    if (slot.persistent) console.error("[store] cannot save state to Supabase; keeping it in memory for now:", (error as Error).message);
    slot.persistent = false;
  }
}

function startSaving(remote: RemoteStore, sessionId: string, slot: Slot): void {
  if (slot.saving || slot.pending.length === 0) return;
  const run = push(remote, sessionId, slot).finally(() => {
    if (slot.saving === run) slot.saving = null;
  });
  slot.saving = run;
}

// Call when a request starts (withVisitor does). With Supabase it fetches the session's stored state, so the
// synchronous reads that follow see what any other server instance has saved. With the file store it does nothing.
export async function openSession(sessionId: string = currentSession()): Promise<void> {
  const { remote } = storeConfig();
  if (!remote) return;
  const key = remoteKey(remote, sessionId);
  const slot = slots.get(key) ?? remember(key, newSlot(EMPTY));
  if (slot.saving || slot.pending.length) return; // this instance is ahead of the database
  try {
    const loaded = await loadRemote(remote, sessionId);
    if (slot.saving || slot.pending.length || loaded.version < slot.version) return; // changed here meanwhile
    slot.state = slot.base = isState(loaded.state) ? loaded.state : EMPTY;
    slot.version = loaded.version;
    slot.persistent = true;
  } catch (error) {
    if (slot.persistent) console.error("[store] cannot read state from Supabase; using what is in memory:", (error as Error).message);
    slot.persistent = false;
  }
}

// Call before a request answers (withVisitor and eventStream do). Waits until every change has been stored.
export async function settleSession(sessionId: string = currentSession()): Promise<void> {
  const { remote } = storeConfig();
  if (!remote) return;
  const slot = slots.get(remoteKey(remote, sessionId));
  if (!slot) return;
  startSaving(remote, sessionId, slot); // picks up changes left over from a save that failed
  while (slot.saving) await slot.saving;
}

// ---- What the rest of the code uses

export function readState(): SisuState {
  const { remote } = storeConfig();
  const sessionId = currentSession();
  return remote ? remoteSlot(remote, sessionId).state : fileSlot(sessionId).slot.state;
}

// Applies a change and saves it. `change` must return a new object, never edit the one it was given, and must
// work on any state: with Supabase it can be applied a second time, on top of a newer stored state.
export function updateState(change: Change): SisuState {
  const { remote } = storeConfig();
  const sessionId = currentSession();
  if (remote) {
    const slot = remoteSlot(remote, sessionId);
    slot.state = change(slot.state);
    slot.pending = [...slot.pending, change];
    startSaving(remote, sessionId, slot);
    return slot.state;
  }
  const { slot, file } = fileSlot(sessionId);
  slot.state = change(slot.state);
  saveFile(slot, file);
  return slot.state;
}

export function storeInfo(): { persistent: boolean; path: string | null; kind: "file" | "supabase"; perVisitor: boolean } {
  const { remote, kind, perVisitor } = storeConfig();
  const sessionId = currentSession();
  if (remote) return { persistent: slots.get(remoteKey(remote, sessionId))?.persistent ?? true, path: null, kind, perVisitor };
  const { slot } = fileSlot(sessionId);
  return { persistent: slot.persistent, path: slot.persistent ? env("SISU_STATE_FILE") || DEFAULT_FILE : null, kind, perVisitor };
}

// For tests: forget every state held in memory, so the next read loads from the file or the database again.
export function forgetStoredState(): void {
  slots.clear();
  warned.clear();
}
