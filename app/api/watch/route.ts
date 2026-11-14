import { jsonError, parseCustomerId } from "@/lib/agent/http";
import { withVisitor } from "@/lib/agent/visitor";
import { findCustomer } from "@/lib/finance/data";
import type { WatchList } from "@/lib/types";
import { listNotifications, listWatches } from "@/lib/watch";

export const runtime = "nodejs";

// This visitor's property watches and what they have found, newest first. Reads only: it asks Context.dev nothing.
// To look for changes, call POST /api/watch/check.
export const GET = withVisitor(async function GET(request: Request) {
  const customerId = parseCustomerId(new URL(request.url).searchParams.get("customerId"));
  if (!customerId || !findCustomer(customerId)) return jsonError("Choose a customer first.", 400);
  const body: WatchList = { customerId, watches: listWatches(customerId), notifications: listNotifications(customerId) };
  return Response.json(body);
});
