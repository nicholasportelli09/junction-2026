import { TOO_MANY, allowRequest, eventStream, jsonError, parseAgentRequest } from "@/lib/agent/http";
import { INVESTIGATE_TEXT, runTurn } from "@/lib/agent/orchestrator";
import { warmUp } from "@/lib/agent/warm";
import { withVisitor } from "@/lib/agent/visitor";

export const runtime = "nodejs";
export const maxDuration = 90;

// Sisu works through a whole case on its own: finds what stands out in the customer's history, researches it live,
// works out the saving, teaches the idea behind it and prepares an action for approval. Same event stream as
// /api/agent/query, with a "stage" event for each step. Body: { customerId, mode?, text? }.
export const POST = withVisitor(async function POST(request: Request) {
  if (!allowRequest(request, "investigate", 10)) return TOO_MANY();
  void warmUp();
  const body = ((await request.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  const focus = typeof body.text === "string" && body.text.trim() ? ` Focus on: ${body.text.trim().slice(0, 120)}` : "";
  const parsed = parseAgentRequest({ ...body, text: `${INVESTIGATE_TEXT}${focus}`, history: [] }, "text");
  if (typeof parsed === "string") return jsonError(parsed, 400);
  return eventStream(runTurn({ ...parsed, investigate: true }, request.signal));
});
