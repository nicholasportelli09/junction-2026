import { TOO_MANY, allowRequest, jsonError, parseCustomerId } from "@/lib/agent/http";
import { peekResearch } from "@/lib/agent/research";
import { toResult } from "@/lib/agent/research/compare";
import { IMAGE_TYPES, MAX_IMAGE_BYTES, readBill } from "@/lib/agent/vision";
import { findCustomer } from "@/lib/finance/data";
import { fact } from "@/lib/finance/facts";
import { buildOverview } from "@/lib/finance/overview";
import { billFor, getMemory } from "@/lib/memory";
import type { BillPhotoResult, Fact } from "@/lib/types";
import { withVisitor } from "@/lib/agent/visitor";

export const runtime = "nodejs";
export const maxDuration = 30;

// A photo of the customer's own bill in, the figures printed on it out, read by Nemotron's vision on our own GPU.
// Nothing is saved here. Show `toConfirm`, and when the user agrees call POST /api/memory { kind: "yearly_kwh", value }.
// Body: multipart form with `image` (png, jpeg or webp, up to 4 MB) and `customerId`.
export const POST = withVisitor(async function POST(request: Request) {
  if (!allowRequest(request, "bill-photo", 10)) return TOO_MANY();
  const form = await request.formData().catch(() => null);
  const customerId = parseCustomerId(form?.get("customerId"));
  const customer = customerId ? findCustomer(customerId) : null;
  const overview = customerId ? buildOverview(customerId) : null;
  if (!customerId || !customer || !overview) return jsonError("Choose a customer first.", 400);
  const image = form?.get("image");
  if (!(image instanceof Blob) || image.size === 0) return jsonError("No photo was received.", 400);
  if (!IMAGE_TYPES.includes(image.type)) return jsonError("Send a PNG, JPEG or WebP photo.", 415);
  if (image.size > MAX_IMAGE_BYTES) return jsonError("That photo is too large. Keep it under 4 MB.", 413);

  let reading;
  try {
    reading = await readBill(image);
  } catch (error) {
    return jsonError((error as Error).message, 502);
  }

  const read = (id: string, label: string, value: number | null, unit: Fact["unit"]): Fact[] => (value === null ? [] : [fact(`bill-photo:${id}`, label, value, unit, "printed on the bill you photographed", { source: "customer-stated" })]);
  const facts = [...read("kwh", "Yearly electricity use", reading.yearlyKwh, "kWh/year"), ...read("price", "Energy price you pay now", reading.energyPriceCentsPerKwh, "c/kWh"), ...read("fee", "Monthly fee you pay now", reading.monthlyFeeEur, "EUR/month"), ...read("total", "Total of this bill", reading.billTotalEur, "EUR")];

  // If today's offers are already in, compare them straight away using the bill's real kWh.
  const billType = reading.billType ?? "electricity";
  const raw = peekResearch(`${billType}:${customer.area.toLowerCase()}`);
  const baseline = billFor(overview, getMemory(customerId), billType)?.bill.monthlyAvg ?? null;
  const comparison = raw && raw.status === "done" ? toResult(raw, baseline, billType === "electricity" ? reading.yearlyKwh : null) : null;

  const seen = [reading.provider, reading.yearlyKwh === null ? null : `${reading.yearlyKwh} kWh a year`, reading.energyPriceCentsPerKwh === null ? null : `${reading.energyPriceCentsPerKwh} c/kWh`].filter(Boolean);
  const body: BillPhotoResult = {
    customerId,
    reading,
    facts,
    comparison,
    toConfirm: seen.length ? `Sisu read: ${seen.join(", ")}. Is that right? Nothing is saved until you confirm.` : "Sisu could not read the key figures. Try a sharper photo, or type your yearly kWh.",
  };
  return Response.json(body);
});
