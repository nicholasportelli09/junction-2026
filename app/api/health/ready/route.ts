import { TOO_MANY, allowRequest } from "@/lib/agent/http";
import { readiness } from "@/lib/agent/readiness";
import { withVisitor } from "@/lib/agent/visitor";

export const runtime = "nodejs";
export const maxDuration = 30;

// "Is the demo ready right now?" One real call to each service the flow depends on (see lib/agent/readiness.ts).
// GET /api/health/ready           the report, at most a minute old
// GET /api/health/ready?fresh=1   check again now (at most 6 a minute per visitor)
// Always 200: `ready` and each check's `status` carry the answer, so a status light never has to parse an error.
export const GET = withVisitor(async function GET(request: Request) {
  const fresh = new URL(request.url).searchParams.get("fresh") === "1";
  if (fresh && !allowRequest(request, "ready", 6)) return TOO_MANY();
  return Response.json(await readiness({ fresh }), { headers: { "Cache-Control": "no-store" } });
});
