import { coachContext, stamp } from "@/lib/agent/coach";
import { jsonError } from "@/lib/agent/http";
import { CONCEPTS, teachingCard } from "@/lib/finance/teaching";
import type { ConceptId } from "@/lib/types";
import { withVisitor } from "@/lib/agent/visitor";

export const runtime = "nodejs";

// Teaching cards built from the customer's own numbers. With ?concept= one card; without it, all of them.
// GET /api/coach/teaching?customerId=&concept=
export const GET = withVisitor(async function GET(request: Request) {
  const context = coachContext(request);
  if (context instanceof Response) return context;
  const concept = context.params.get("concept");
  if (concept && !CONCEPTS.includes(concept as ConceptId)) return jsonError(`Unknown concept. Use one of: ${CONCEPTS.join(", ")}.`, 400);
  const cards = (concept ? [concept as ConceptId] : CONCEPTS).map((id) => teachingCard(id, context.overview));
  return Response.json({ ...stamp(context.overview), cards });
});
