import { TOO_MANY, allowRequest, jsonError, parseCustomerId } from "@/lib/agent/http";
import { withVisitor } from "@/lib/agent/visitor";
import { stopWatch } from "@/lib/watch";

export const runtime = "nodejs";

// Stops a watch and removes its Context.dev monitors. Body: { customerId }.
export const POST = withVisitor(async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!allowRequest(request, "actions", 30)) return TOO_MANY();
  const { id } = await params;
  const body = ((await request.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  const customerId = parseCustomerId(body.customerId);
  if (!customerId) return jsonError("Choose a customer first.", 400);
  const watch = await stopWatch(customerId, id);
  if (!watch) return jsonError("We could not find that watch.", 404);
  return Response.json({ watch });
});
