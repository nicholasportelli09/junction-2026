import { accountsFor } from "@/lib/actions";
import { withCurrentAccount } from "@/lib/actions/bank";
import { coachContext, stamp } from "@/lib/agent/coach";
import { buildCashFlow } from "@/lib/finance/cashflow";
import { jsonError } from "@/lib/agent/http";
import { checkAffordability } from "@/lib/finance/affordability";
import { withVisitor } from "@/lib/agent/visitor";

export const runtime = "nodejs";

// "Can I afford this?" worked out in code, with every step shown.
// GET /api/coach/affordability?customerId=&amountEur=
export const GET = withVisitor(async function GET(request: Request) {
  const context = coachContext(request);
  if (context instanceof Response) return context;
  const accounts = accountsFor(context.overview.customerId);
  const current = accounts ? withCurrentAccount(context.overview, accounts) : context.overview;
  const result = checkAffordability(current, current === context.overview ? context.cashFlow : buildCashFlow(current), Number(context.params.get("amountEur")));
  if (typeof result === "string") return jsonError(result, 400);
  return Response.json({ ...stamp(context.overview), ...result });
});
