import { TOO_MANY, allowRequest, eventStream, jsonError, parseCustomerId } from "@/lib/agent/http";
import { runPlan } from "@/lib/agent/plan";
import { warmUp } from "@/lib/agent/warm";
import type { PlanEvent } from "@/lib/types";
import { withVisitor } from "@/lib/agent/visitor";

export const runtime = "nodejs";
export const maxDuration = 90;

// "Sort out my money": Sisu scans the last twelve months, searches today's offers for every bill it can compare,
// works out what each finding is worth, and sets up the actions. Streams a PlanEvent for each real step, so the
// screen can show the work as it happens. Nothing is approved here.
// Body: { customerId, fresh?: boolean (default true: search the web now, do not reuse an earlier search), language? }.
export const POST = withVisitor(async function POST(request: Request) {
  if (!allowRequest(request, "plan", 6)) return TOO_MANY();
  void warmUp();
  const body = ((await request.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  const customerId = parseCustomerId(body.customerId);
  if (!customerId) return jsonError("Choose a customer first.", 400);
  const language = typeof body.language === "string" ? body.language.slice(0, 12) : undefined;
  return eventStream<PlanEvent>(runPlan(customerId, { fresh: body.fresh !== false, language }, request.signal));
});
