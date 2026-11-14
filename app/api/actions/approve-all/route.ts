import { approveAction } from "@/lib/actions";
import { impactOf } from "@/lib/actions/drafts";
import { TOO_MANY, allowRequest, jsonError, parseCustomerId } from "@/lib/agent/http";
import type { AgentAction } from "@/lib/types";
import { withVisitor } from "@/lib/agent/visitor";

export const runtime = "nodejs";
const MAX_AT_ONCE = 6;

// One tap for a whole plan. The same rule as a single approval: the request must name the customer and say
// confirm: true, and it comes from the Approve button, never from the agent. Each action is approved, simulated
// and logged on its own, so the audit trail shows every one.
// Body: { customerId, actionIds: string[], confirm: true }.
export const POST = withVisitor(async function POST(request: Request) {
  if (!allowRequest(request, "actions", 30)) return TOO_MANY();
  const body = ((await request.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  const customerId = parseCustomerId(body.customerId);
  if (!customerId) return jsonError("Choose a customer first.", 400);
  if (body.confirm !== true) return jsonError("Approval needs confirm: true. Nothing was done.", 400);
  const ids = Array.isArray(body.actionIds) ? [...new Set(body.actionIds.filter((id): id is string => typeof id === "string"))] : [];
  if (!ids.length || ids.length > MAX_AT_ONCE) return jsonError(`Name between one and ${MAX_AT_ONCE} actions to approve. Nothing was done.`, 400);

  const approved: AgentAction[] = [];
  const failed: { actionId: string; reason: string }[] = [];
  for (const id of ids) {
    const result = approveAction(customerId, id, impactOf);
    if (result.ok) approved.push(result.action);
    else failed.push({ actionId: id, reason: result.reason });
  }
  return Response.json({ approved, failed }, { status: approved.length ? 200 : 409 });
});
