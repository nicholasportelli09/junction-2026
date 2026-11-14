import { TOO_MANY, allowRequest, jsonError, parseBillType, parseCustomerId } from "@/lib/agent/http";
import { ensureResearch } from "@/lib/agent/research";
import { findCustomer } from "@/lib/finance/data";
import { buildOverview } from "@/lib/finance/overview";
import { forget, getMemory, remember, setConsent } from "@/lib/memory";
import type { MemoryKind } from "@/lib/types";
import { withVisitor } from "@/lib/agent/visitor";

export const runtime = "nodejs";

const KINDS: MemoryKind[] = ["bill_name", "yearly_kwh", "preference", "goal"];

export const GET = withVisitor(async function GET(request: Request) {
  const customerId = parseCustomerId(new URL(request.url).searchParams.get("customerId"));
  if (!customerId || !findCustomer(customerId)) return jsonError("Choose a customer first.", 400);
  return Response.json(getMemory(customerId));
});

// Saves one thing the user confirmed in the app, or switches remembering on or off.
// Body: { customerId, consent } or { customerId, kind, key?, value, billType? }.
export const POST = withVisitor(async function POST(request: Request) {
  if (!allowRequest(request, "memory", 60)) return TOO_MANY();
  const body = ((await request.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  const customerId = parseCustomerId(body.customerId);
  const customer = customerId ? findCustomer(customerId) : null;
  if (!customerId || !customer) return jsonError("Choose a customer first.", 400);
  if (typeof body.consent === "boolean") return Response.json(setConsent(customerId, body.consent));

  const kind = KINDS.includes(body.kind as MemoryKind) ? (body.kind as MemoryKind) : null;
  const value = typeof body.value === "string" || typeof body.value === "number" ? String(body.value) : "";
  if (!kind || !value.trim()) return jsonError("Send a kind (bill_name, yearly_kwh, preference or goal) and a value.", 400);
  const key = typeof body.key === "string" && body.key.trim() ? body.key : kind === "yearly_kwh" ? "electricity" : value;
  if (kind === "bill_name" && !buildOverview(customerId)?.recurringBills.some((bill) => bill.id === key)) return jsonError("That bill does not exist for this customer.", 400);

  const billType = parseBillType(body.billType) ?? null;
  const result = remember(customerId, { kind, key, value, billType, source: "user-confirmed-in-app" });
  if (!result.ok) return jsonError(result.reason, 409);
  // Rule 2 of the orchestration: the moment a bill is confirmed, start looking for offers so they are ready when asked.
  if (kind === "bill_name" && billType) ensureResearch(billType, customer.area);
  return Response.json(getMemory(customerId));
});

// Forgets one item (itemId) or everything for this customer.
export const DELETE = withVisitor(async function DELETE(request: Request) {
  const params = new URL(request.url).searchParams;
  const customerId = parseCustomerId(params.get("customerId"));
  if (!customerId || !findCustomer(customerId)) return jsonError("Choose a customer first.", 400);
  forget(customerId, params.get("itemId"));
  return Response.json(getMemory(customerId));
});
