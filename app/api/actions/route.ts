import { approvedMonthlySaving, listActions } from "@/lib/actions";
import { jsonError, parseCustomerId } from "@/lib/agent/http";
import { findCustomer } from "@/lib/finance/data";
import { auditFor } from "@/lib/store/audit";
import type { ActionList } from "@/lib/types";
import { withVisitor } from "@/lib/agent/visitor";

export const runtime = "nodejs";

// Everything Sisu has prepared for this customer, newest first, with the audit trail behind it.
export const GET = withVisitor(async function GET(request: Request) {
  const customerId = parseCustomerId(new URL(request.url).searchParams.get("customerId"));
  if (!customerId || !findCustomer(customerId)) return jsonError("Choose a customer first.", 400);
  const audit = auditFor(customerId);
  const body: ActionList = { customerId, actions: listActions(customerId), audit: audit.events, auditChainValid: audit.chainValid, approvedMonthlySavingEur: approvedMonthlySaving(customerId) };
  return Response.json(body);
});
