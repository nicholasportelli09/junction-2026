// Shared helpers for the agent's API routes: request validation, a small rate limit and the event stream.
import type { AgentRequest, BillType, ChatTurn, SisuEvent } from "@/lib/types";
import { SHARED, currentSession, inSession } from "@/lib/store/session";
import { settleSession } from "@/lib/store/state";
import { languageCode } from "./languages";

const MAX_TEXT_CHARS = 500;
const MAX_HISTORY = 12;
const BILL_TYPES: BillType[] = ["electricity", "mobile", "internet"];
const CUSTOMER_ID = /^CUST\d{5}$/;

export const jsonError = (message: string, status: number) => Response.json({ error: message }, { status });

export function parseBillType(value: unknown): BillType | undefined {
  return BILL_TYPES.includes(value as BillType) ? (value as BillType) : undefined;
}

export function parseCustomerId(value: unknown): string | null {
  return typeof value === "string" && CUSTOMER_ID.test(value) ? value : null;
}

export function parseHistory(value: unknown): ChatTurn[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((turn): turn is ChatTurn => !!turn && (turn.role === "user" || turn.role === "assistant") && typeof turn.content === "string")
    .slice(-MAX_HISTORY)
    .map((turn) => ({ role: turn.role, content: turn.content.slice(0, MAX_TEXT_CHARS * 2) }));
}

// Turns an untrusted request body into an AgentRequest, or returns the message to show.
export function parseAgentRequest(body: unknown, mode: "voice" | "text"): AgentRequest | string {
  const input = (body ?? {}) as Record<string, unknown>;
  const customerId = parseCustomerId(input.customerId);
  if (!customerId) return "Choose a customer first.";
  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (!text) return "Ask Sisu a question.";
  if (text.length > MAX_TEXT_CHARS) return `Please keep questions under ${MAX_TEXT_CHARS} characters.`;
  return {
    customerId,
    text,
    mode: input.mode === "voice" || input.mode === "text" ? input.mode : mode,
    history: parseHistory(input.history),
    focusBill: parseBillType(input.focusBill),
    language: languageCode(input.language) ?? undefined,
  };
}

// The sponsor keys are ours and the demo URL is public, so each visitor gets a sensible ceiling.
const WINDOW_MS = 60_000;
const globalStore = globalThis as unknown as { __sisuHits?: Map<string, number[]> };
const hits: Map<string, number[]> = (globalStore.__sisuHits ??= new Map());

// How many visitors may share one address (a venue's Wi-Fi) before the address itself is slowed down.
const CROWD = 8;

function take(id: string, limitPerMinute: number): boolean {
  const now = Date.now();
  const recent = (hits.get(id) ?? []).filter((time) => now - time < WINDOW_MS);
  if (recent.length >= limitPerMinute) {
    hits.set(id, recent);
    return false;
  }
  hits.set(id, [...recent, now]);
  return true;
}

// The ceiling is per visitor. Where visitors have sessions of their own, each gets the full ceiling and the
// address they come from gets CROWD times as much, because a room full of phones shares one address.
export function allowRequest(request: Request, bucket: string, limitPerMinute: number): boolean {
  const address = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  const session = currentSession();
  if (session === SHARED) return take(`${bucket}:${address}`, limitPerMinute);
  // The visitor first: a request that is over the visitor's own ceiling must not use up the room's allowance.
  return take(`${bucket}:${session}`, limitPerMinute) && take(`${bucket}:address:${address}`, limitPerMinute * CROWD);
}

export const TOO_MANY = () => jsonError("Sisu is getting a lot of questions. Please wait a moment and try again.", 429);

// Sends agent events to the browser as server-sent events, one JSON object per message.
export function eventStream<T = SisuEvent>(events: AsyncGenerator<T>): Response {
  const encoder = new TextEncoder();
  // The stream is read after the route has returned, outside the visitor it was started for. Each step is
  // therefore run as that visitor again, so the tools the agent calls reach the right state.
  const sessionId = currentSession();
  // Set when the browser goes away (a closed tab, an interrupted turn). An event that arrives after that is
  // dropped: writing it to a closed stream throws, which used to be logged as a failure although nothing failed.
  let gone = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await inSession(sessionId, () => events.next());
        if (gone) return;
        if (done) {
          await settleSession(sessionId); // on a hosted site nothing may be left unsaved once the answer ends
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
      } catch (error) {
        if (gone) return;
        console.error("[agent] event stream failed", error);
        await settleSession(sessionId);
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "error", message: "Sisu could not answer just now. Please try again." })}\n\n`));
          controller.close();
        } catch {
          // The stream closed while the error was being reported: there is nobody left to tell.
        }
      }
    },
    async cancel() {
      gone = true;
      await inSession(sessionId, () => events.return(undefined));
      await settleSession(sessionId);
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" },
  });
}
