// Which visitor the code that is running right now belongs to.
// On a laptop at the booth everyone shares one state (the "shared" session), exactly as before. On a hosted
// site every visitor gets a session of their own, so two people who scan the QR code never see each other's
// approvals, memory or audit log. The session travels with the request (see lib/agent/visitor.ts); the store
// reads it from here, so no function between the route and the store has to pass it along.
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export const SHARED = "shared";

// Kept on globalThis so the dev server's hot reload does not end up with two separate contexts.
const globalStore = globalThis as unknown as { __sisuSession?: AsyncLocalStorage<{ sessionId: string }> };
const context: AsyncLocalStorage<{ sessionId: string }> = (globalStore.__sisuSession ??= new AsyncLocalStorage());

export const currentSession = (): string => context.getStore()?.sessionId ?? SHARED;

// Runs `work` as the given visitor. Everything it starts (awaits, timers, streams it reads) stays that visitor.
export const inSession = <T>(sessionId: string, work: () => T): T => context.run({ sessionId }, work);

// A session id is a capability: whoever holds it reads and writes that visitor's state. So ids are long,
// random and made of a small alphabet that is safe in a file name, a header and a database key.
export const isSessionId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(value);

export const newSessionId = (): string => randomUUID().replaceAll("-", "");
