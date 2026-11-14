// Circuit breaker for the main model. Without it, every model step during an outage waits the full stall limit
// before the backup answers (measured: 4.1 s to the first sentence of a two-step turn). With it, the first failure
// "opens" the breaker and later steps ask the backup first. A cheap background probe checks whether the main
// model is back, so no customer's question waits on it as the test. If the backup is silent too, the model
// client asks the main model again alongside it (see firstToStart in model.ts).
import type { ModelEndpoint } from "./config";

const COOLDOWN_MS = 5_000; // how long to leave the main model alone before probing it. Short, so a false alarm under load costs little.
const PROBE_TIMEOUT_MS = 1_500;

type State = { openedAt: number | null; probing: boolean; lastProbeAt: number; trips: number };
const globalStore = globalThis as unknown as { __sisuBreaker?: Map<string, State> };
const states: Map<string, State> = (globalStore.__sisuBreaker ??= new Map());

const keyOf = (endpoint: ModelEndpoint): string => `${endpoint.provider}|${endpoint.baseUrl}`;
const stateOf = (endpoint: ModelEndpoint): State => {
  const key = keyOf(endpoint);
  if (!states.has(key)) states.set(key, { openedAt: null, probing: false, lastProbeAt: 0, trips: 0 });
  return states.get(key) as State;
};

export function recordFailure(endpoint: ModelEndpoint): void {
  const state = stateOf(endpoint);
  if (state.openedAt === null) state.trips += 1;
  state.openedAt = Date.now();
  state.lastProbeAt = Date.now();
}

export function recordSuccess(endpoint: ModelEndpoint): void {
  stateOf(endpoint).openedAt = null;
}

// Asks the model server for its model list. It answers in milliseconds when healthy and costs nothing.
async function probe(endpoint: ModelEndpoint, state: State): Promise<void> {
  state.probing = true;
  state.lastProbeAt = Date.now();
  try {
    const response = await fetch(`${endpoint.baseUrl}/models`, { headers: { Authorization: `Bearer ${endpoint.apiKey}` }, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    await response.arrayBuffer();
    if (response.ok) {
      state.openedAt = null;
      console.error(`[agent] ${endpoint.provider} model is reachable again; using it for the next question`);
    }
  } catch {
    // still down; try again after the next cooldown
  } finally {
    state.probing = false;
  }
}

// True when the main model should be skipped for this step. Also starts a background probe when one is due.
export function shouldSkip(endpoint: ModelEndpoint): boolean {
  const state = stateOf(endpoint);
  if (state.openedAt === null) return false;
  if (!state.probing && Date.now() - state.lastProbeAt >= COOLDOWN_MS) void probe(endpoint, state);
  return true;
}

export function breakerStatus(endpoint: ModelEndpoint): { open: boolean; sinceMs: number | null; trips: number } {
  const state = stateOf(endpoint);
  return { open: state.openedAt !== null, sinceMs: state.openedAt === null ? null : Date.now() - state.openedAt, trips: state.trips };
}

export function resetBreakers(): void {
  states.clear();
}
