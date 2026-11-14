import { TOO_MANY, allowRequest, eventStream, jsonError, parseAgentRequest } from "@/lib/agent/http";
import { runTurn } from "@/lib/agent/orchestrator";
import { warmUp } from "@/lib/agent/warm";
import { withVisitor } from "@/lib/agent/visitor";

export const runtime = "nodejs";
export const maxDuration = 60;

// One typed (or already transcribed) question in, a stream of agent events out.
export const POST = withVisitor(async function POST(request: Request) {
  if (!allowRequest(request, "agent", 30)) return TOO_MANY();
  void warmUp(); // no-op after the first request
  const body = await request.json().catch(() => null);
  const parsed = parseAgentRequest(body, "text");
  if (typeof parsed === "string") return jsonError(parsed, 400);
  return eventStream(runTurn(parsed, request.signal));
});
