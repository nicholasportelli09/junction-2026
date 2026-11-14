import { saveDraft } from "@/lib/actions";
import { buildSwitchDraft, buildTransferDraft } from "@/lib/actions/drafts";
import { TOO_MANY, allowRequest, jsonError, parseBillType, parseCustomerId } from "@/lib/agent/http";
import { findCustomer } from "@/lib/finance/data";
import { withVisitor } from "@/lib/agent/visitor";

export const runtime = "nodejs";

// Prepares an action from a button (for example "Prepare the switch" on an offer card). It is only a draft:
// nothing happens until POST /api/actions/:id/approve.
// Body: { customerId, kind, billType?, provider?, amountEur?, destination? }. (monthlyAmountEur still works for standing_transfer.)
export const POST = withVisitor(async function POST(request: Request) {
  if (!allowRequest(request, "actions", 30)) return TOO_MANY();
  const body = ((await request.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  const customerId = parseCustomerId(body.customerId);
  if (!customerId || !findCustomer(customerId)) return jsonError("Choose a customer first.", 400);

  const billType = parseBillType(body.billType);
  const built =
    body.kind === "switch_contract"
      ? billType
        ? buildSwitchDraft(customerId, billType, { provider: typeof body.provider === "string" ? body.provider.slice(0, 60) : undefined, preparedBy: "user" })
        : null
      : body.kind === "standing_transfer" || body.kind === "one_off_transfer"
        ? buildTransferDraft(customerId, Number(body.amountEur ?? body.monthlyAmountEur), { preparedBy: "user", once: body.kind === "one_off_transfer", destination: body.destination === "investments" ? "investments" : "savings" })
        : null;
  if (!built) return jsonError("Send kind: switch_contract (with billType), or standing_transfer or one_off_transfer (with amountEur and, optionally, destination: savings or investments).", 400);
  if (!built.ok) return jsonError(built.reason, built.status);

  const saved = saveDraft(customerId, built.draft);
  if (!saved.ok) return jsonError(saved.reason, saved.status);
  // 201 for a new action; 200 when the customer had already approved a switch for this bill (it is handed back).
  return Response.json({ action: saved.action }, { status: saved.action.status === "executed_simulated" ? 200 : 201 });
});
