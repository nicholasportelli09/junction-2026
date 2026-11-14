import { TOO_MANY, allowRequest, jsonError, parseCustomerId } from "@/lib/agent/http";
import { withVisitor } from "@/lib/agent/visitor";
import { simulatePriceDrop } from "@/lib/watch";

export const runtime = "nodejs";

// For the demo: pretends the cheapest watched flat that is over budget dropped to just under it, and runs that
// through the same comparison a real change goes through. The notification and its audit line say "simulated".
// Real listing pages do not change on cue, so this is how the notification step is shown. Body: { customerId }.
export const POST = withVisitor(async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!allowRequest(request, "actions", 30)) return TOO_MANY();
  const { id } = await params;
  const body = ((await request.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  const customerId = parseCustomerId(body.customerId);
  if (!customerId) return jsonError("Choose a customer first.", 400);
  const result = simulatePriceDrop(customerId, id);
  if (!result.ok) return jsonError(result.reason, result.status);
  return Response.json({ notification: result.notification });
});
