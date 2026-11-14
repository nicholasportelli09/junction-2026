import { coachContext } from "@/lib/agent/coach";
import { jsonError } from "@/lib/agent/http";
import { mortgageFor } from "@/lib/finance/mortgage";
import { withVisitor } from "@/lib/agent/visitor";

export const runtime = "nodejs";

// The customer's mortgage application beside their own income and balance. 404 if they have none.
// GET /api/coach/mortgage?customerId=
export const GET = withVisitor(async function GET(request: Request) {
  const context = coachContext(request);
  if (context instanceof Response) return context;
  const application = mortgageFor(context.overview);
  if (!application) return jsonError("There is no mortgage application on record for this customer.", 404);
  return Response.json({ ...application, dataTimestamp: context.overview.dataTimestamp, currency: "EUR" });
});
