import { resetCustomers } from "@/lib/actions";
import { TOO_MANY, allowRequest, jsonError } from "@/lib/agent/http";
import { DEMO_CUSTOMERS } from "@/lib/finance/data";
import { withVisitor } from "@/lib/agent/visitor";
import { SHARED, currentSession } from "@/lib/store/session";
import { stopAllWatches } from "@/lib/watch";

export const runtime = "nodejs";

// Reset: clears actions, remembered items and the audit log for the demo customers.
// A visitor with a session of their own (a hosted site) clears only their own state, so it is always allowed:
// call it for "start over". On the one shared state it wipes everyone: open on a laptop (development), so the
// booth's reset button just works, and on a deployed site only with the token in SISU_RESET_TOKEN, sent as the
// x-sisu-reset-token header.
export const POST = withVisitor(async function POST(request: Request) {
  if (!allowRequest(request, "reset", 10)) return TOO_MANY();
  const token = process.env.SISU_RESET_TOKEN?.trim();
  const deployed = process.env.NODE_ENV === "production";
  const ownStateOnly = currentSession() !== SHARED;
  if (deployed && !ownStateOnly && (!token || request.headers.get("x-sisu-reset-token") !== token)) return jsonError("Resetting the demo is switched off on this site.", 403);
  const customerIds = DEMO_CUSTOMERS.map((customer) => customer.customerId);
  await stopAllWatches(customerIds); // so no Context.dev monitor outlives the state that knew about it
  const cleared = resetCustomers(customerIds);
  return Response.json({ ok: true, cleared });
});
