import { coachContext, stamp } from "@/lib/agent/coach";
import { findPatterns } from "@/lib/finance/patterns";
import { withVisitor } from "@/lib/agent/visitor";

export const runtime = "nodejs";

// What stands out in this customer's history, ranked by yearly euros. Pure code, no model: instant and repeatable.
// GET /api/coach/patterns?customerId=
export const GET = withVisitor(async function GET(request: Request) {
  const context = coachContext(request);
  if (context instanceof Response) return context;
  return Response.json({ ...stamp(context.overview), patterns: findPatterns(context.overview, context.cashFlow) });
});
