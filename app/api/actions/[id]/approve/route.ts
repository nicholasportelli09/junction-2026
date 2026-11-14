import { approveAction } from "@/lib/actions";
import { impactOf } from "@/lib/actions/drafts";
import { TOO_MANY, allowRequest, jsonError, parseCustomerId } from "@/lib/agent/http";
import { withVisitor } from "@/lib/agent/visitor";

export const runtime = "nodejs";

// The ONLY way an action is approved: a request that names the customer and says confirm: true, sent by the
// Approve button. The agent has no tool that reaches this. Even then the action is simulated, and logged.
export const POST = withVisitor(async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!allowRequest(request, "actions", 30)) return TOO_MANY();
  const { id } = await params;
  const body = ((await request.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  const customerId = parseCustomerId(body.customerId);
  if (!customerId) return jsonError("Choose a customer first.", 400);
  if (body.confirm !== true) return jsonError("Approval needs confirm: true. Nothing was done.", 400);
  const result = approveAction(customerId, id, impactOf);
  if (!result.ok) return jsonError(result.reason, result.status);
  return Response.json({ action: result.action });
});
