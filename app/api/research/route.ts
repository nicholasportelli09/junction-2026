import { TOO_MANY, allowRequest, jsonError, parseBillType, parseCustomerId } from "@/lib/agent/http";
import { KWH_LIMITS, toResult } from "@/lib/agent/research/compare";
import { ensureResearch, peekResearch, waitForUsable } from "@/lib/agent/research";
import { findCustomer } from "@/lib/finance/data";
import { buildOverview } from "@/lib/finance/overview";
import { billFor, getMemory, statedYearlyKwh } from "@/lib/memory";
import type { BillType } from "@/lib/types";
import { withVisitor } from "@/lib/agent/visitor";

export const runtime = "nodejs";
export const maxDuration = 30;

const WAIT_LIMIT_MS = 9_000;

// The customer's own bill of this type. A name they confirmed wins over Sisu's guess.
function baselineFor(customerId: string, billType: BillType): number | null {
  const overview = buildOverview(customerId);
  return overview ? (billFor(overview, getMemory(customerId), billType)?.bill.monthlyAvg ?? null) : null;
}

// Their yearly kWh, if they have told Sisu before.
const rememberedKwh = (customerId: string, billType: BillType): number | null => (billType === "electricity" ? statedYearlyKwh(getMemory(customerId)) : null);

// Starts (or joins) offer research. The frontend calls this with wait:false the moment a user confirms
// a bill, so the offers are usually ready before they ask. See context/orchestration.md, rule 2.
export const POST = withVisitor(async function POST(request: Request) {
  if (!allowRequest(request, "research", 20)) return TOO_MANY();
  const body = ((await request.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  const customerId = parseCustomerId(body.customerId);
  const billType = parseBillType(body.billType);
  const customer = customerId ? findCustomer(customerId) : null;
  if (!customerId || !customer) return jsonError("Choose a customer first.", 400);
  if (!billType) return jsonError("billType must be electricity, mobile or internet.", 400);

  const { key } = ensureResearch(billType, customer.area);
  const raw = body.wait === false ? peekResearch(key) : await waitForUsable(key, WAIT_LIMIT_MS, request.signal);
  if (!raw) return jsonError("Research could not start.", 500);
  const stated = typeof body.yearlyKwh === "number" && body.yearlyKwh >= KWH_LIMITS[0] && body.yearlyKwh <= KWH_LIMITS[1] ? body.yearlyKwh : rememberedKwh(customerId, billType);
  return Response.json(toResult(raw, baselineFor(customerId, billType), stated));
});

// The current snapshot, for polling while pages are still arriving.
export const GET = withVisitor(async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const customerId = parseCustomerId(params.get("customerId"));
  const billType = parseBillType(params.get("billType"));
  const customer = customerId ? findCustomer(customerId) : null;
  if (!customerId || !customer || !billType) return jsonError("Send a customerId and a billType.", 400);
  const raw = peekResearch(`${billType}:${customer.area.toLowerCase()}`);
  if (!raw) return jsonError("No research has been started for this bill yet.", 404);
  return Response.json(toResult(raw, baselineFor(customerId, billType), rememberedKwh(customerId, billType)));
});
