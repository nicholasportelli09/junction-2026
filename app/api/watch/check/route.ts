import { TOO_MANY, allowRequest, jsonError, parseCustomerId } from "@/lib/agent/http";
import { withVisitor } from "@/lib/agent/visitor";
import { findCustomer } from "@/lib/finance/data";
import { checkWatches } from "@/lib/watch";

export const runtime = "nodejs";
export const maxDuration = 60;

// Polls Context.dev for changes on this visitor's watched pages. A page that changed is read again, each rent is
// compared with the budget in code, and a notification is stored for every flat that now fits.
// Body: { customerId, runNow? }. runNow: true also asks Context.dev to check each page now instead of waiting for
// its schedule; that run is queued, so call this again a little later to pick up what it found.
// Call it on a timer from the page that shows notifications (the dev page does, once a minute).
export const POST = withVisitor(async function POST(request: Request) {
  if (!allowRequest(request, "watch-check", 12)) return TOO_MANY();
  const body = ((await request.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  const customerId = parseCustomerId(body.customerId);
  if (!customerId || !findCustomer(customerId)) return jsonError("Choose a customer first.", 400);
  return Response.json(await checkWatches(customerId, { runNow: body.runNow === true }));
});
