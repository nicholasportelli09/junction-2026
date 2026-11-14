import { accountsFor } from "@/lib/actions";
import { jsonError, parseCustomerId } from "@/lib/agent/http";
import { withVisitor } from "@/lib/agent/visitor";
import { findCustomer } from "@/lib/finance/data";

export const runtime = "nodejs";

// The customer's accounts in the demo bank: the bank data's balance, then everything their approved actions did.
// GET /api/accounts?customerId=   (type AccountsView)
export const GET = withVisitor(async function GET(request: Request) {
  const customerId = parseCustomerId(new URL(request.url).searchParams.get("customerId"));
  const accounts = customerId && findCustomer(customerId) ? accountsFor(customerId) : null;
  if (!accounts) return jsonError("Choose a customer first.", 400);
  return Response.json(accounts, { headers: { "Cache-Control": "no-store" } });
});
