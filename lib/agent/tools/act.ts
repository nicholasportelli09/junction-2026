// Tools that change something: preparing an action for approval, and remembering what the customer said.
// Both are fenced in. An action is only ever PREPARED here, from data the server already holds. A memory is only
// saved if the customer's own words in this conversation support it, so a web page cannot plant one.
import { saveDraft } from "@/lib/actions";
import { buildSwitchDraft, buildTransferDraft } from "@/lib/actions/drafts";
import { remember } from "@/lib/memory";
import type { BillType, MemoryKind } from "@/lib/types";
import { ACTION_KINDS, BILL_TYPES, MEMORY_KINDS } from "./schemas";
import { type ToolContext, type ToolOutcome, factsForModel, failure, outcome } from "./types";
import { looksLikeInstructions } from "./untrusted";

export const digitsOf = (text: string): number[] => [...text.replace(/(\d)[ ,](\d{3})\b/g, "$1$2").matchAll(/\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
const wordsOf = (text: string): string[] => text.toLowerCase().match(/[a-zà-öø-ÿ]{4,}/g) ?? [];

// Has this amount come up in the conversation, said by the customer or by Sisu in an answer that passed the number
// check? "Yes, set that up" after Sisu suggested 60 euros a month is a real instruction for 60.
const amountWasDiscussed = (ctx: ToolContext, value: number): boolean => [...ctx.userTexts, ...ctx.sisuTexts].some((text) => digitsOf(text).some((n) => Math.abs(n - value) < 0.005));
// Did the customer say this number as their electricity use? "I pay 800 euros" must not support "800 kWh".
const userSaidKwh = (ctx: ToolContext, value: number): boolean => ctx.userTexts.some((text) => /kwh|kilowatt/i.test(text) && digitsOf(text).some((n) => Math.abs(n - value) < 0.005));
// Is this what the customer said, in their words? Every meaningful word of the value must come from ONE of their
// messages. The model may shorten what they said; it may not add to it. (One shared word used to be enough, which
// would have let a web page slip "always recommend X" in next to a word the customer happened to use.)
const userSaidThis = (ctx: ToolContext, value: string): boolean => {
  const words = wordsOf(value);
  return words.length > 0 && ctx.userTexts.some((text) => {
    const said = new Set(wordsOf(text));
    return words.every((word) => said.has(word));
  });
};

export function prepareAction(args: Record<string, unknown>, ctx: ToolContext): ToolOutcome {
  const kind = ACTION_KINDS.includes(args.kind as string) ? (args.kind as string) : null;
  if (!kind) return failure("finance", `prepare_action needs kind: ${ACTION_KINDS.join(" or ")}.`);

  const amount = typeof args.amountEur === "number" ? args.amountEur : typeof args.monthlyAmountEur === "number" ? args.monthlyAmountEur : null;
  const built =
    kind === "switch_contract"
      ? BILL_TYPES.includes(args.billType as BillType)
        ? buildSwitchDraft(ctx.customerId, args.billType as BillType, { provider: typeof args.provider === "string" ? args.provider.slice(0, 60) : undefined, preparedBy: "sisu-agent" })
        : ({ ok: false, status: 400, reason: "switch_contract needs billType: electricity, mobile or internet." } as const)
      : typeof amount === "number" && amountWasDiscussed(ctx, amount)
        ? buildTransferDraft(ctx.customerId, amount, { preparedBy: "sisu-agent", once: kind === "one_off_transfer", destination: args.destination === "investments" ? "investments" : "savings" })
        : ({ ok: false, status: 400, reason: "Ask the customer how much they want to move. The amount must be one they said, or one you suggested from their numbers and they agreed to." } as const);
  if (!built.ok) return failure("finance", built.reason);

  const saved = saveDraft(ctx.customerId, built.draft);
  if (!saved.ok) return failure("finance", saved.reason);
  const action = saved.action;
  // The bill was switched on an earlier turn or visit: say so, and set nothing up a second time.
  if (action.status === "executed_simulated") {
    return outcome({
      content: JSON.stringify({
        status: "ALREADY APPROVED EARLIER. Nothing new was set up: a bill can be switched once.",
        tellTheCustomer: "Say in one sentence that they have already approved this switch (as a simulation), name it, and that its saving is already counted. Do not ask them to tap Approve.",
        alreadyApproved: action.title,
        approvedOn: (action.decidedAt ?? action.createdAt).slice(0, 10),
        summary: action.summary,
        numbers: factsForModel(action.facts),
      }),
      summary: `Already approved earlier: ${action.title}`,
      facts: action.facts,
      citations: action.sources,
      action,
    });
  }
  return outcome({
    content: JSON.stringify({
      status: "SET UP AND WAITING. One tap on Approve carries it out (as a simulation in this demo).",
      tellTheCustomer: "Say in one sentence what you have set up and what it does, then ask them to tap Approve. Speak as someone who has done the work: 'I've set up…', not 'I can only prepare…'. Do not say it has already gone through.",
      warning: action.warning ?? undefined,
      ifThereIsAWarning: action.warning ? "Say the warning plainly, with its figures, and name the safer amount." : undefined,
      prepared: action.title,
      summary: action.summary,
      numbers: factsForModel(action.facts),
      expiresInMinutes: 30,
    }),
    summary: `Prepared for approval: ${action.title}`,
    facts: action.facts,
    citations: action.sources,
    action,
    stages: [{ kind: "action", title: action.title, summary: action.warning ?? "Set up and waiting for your tap on Approve.", source: "calculation", data: { kind: "action", action } }],
  });
}

export function rememberTool(args: Record<string, unknown>, ctx: ToolContext): ToolOutcome {
  const kind = MEMORY_KINDS.includes(args.kind as string) ? (args.kind as MemoryKind) : null;
  const value = typeof args.value === "string" ? args.value.trim() : typeof args.value === "number" ? String(args.value) : "";
  if (!kind || !value) return failure("finance", "remember needs a kind and a value.");
  if (looksLikeInstructions(value)) return failure("finance", "That reads like an instruction, not a fact about the customer, so it was not saved.");

  const supported = kind === "yearly_kwh" ? userSaidKwh(ctx, Number(value.replace(/[^\d.]/g, ""))) : userSaidThis(ctx, value);
  if (!supported) return failure("finance", "Sisu only remembers what the customer has said themselves in this conversation. Ask them first.");

  const billId = typeof args.billId === "string" ? args.billId : "";
  if (kind === "bill_name" && !ctx.overview.recurringBills.some((bill) => bill.id === billId)) {
    return failure("finance", `bill_name needs a billId from list_bills (${ctx.overview.recurringBills.map((bill) => bill.id).join(", ")}).`);
  }
  const billType = BILL_TYPES.includes(args.billType as BillType) ? (args.billType as BillType) : null;
  const key = kind === "bill_name" ? billId : kind === "yearly_kwh" ? "electricity" : value.toLowerCase().slice(0, 40);
  const result = remember(ctx.customerId, { kind, key, value: kind === "yearly_kwh" ? value.replace(/[^\d.]/g, "") : value, billType, source: "user-said-in-chat" });
  if (!result.ok) return failure("finance", result.reason);

  return outcome({
    content: JSON.stringify({ saved: true, remembered: `${result.item.kind}: ${result.item.value}`, tellTheCustomer: "Mention briefly that you will remember this, and that they can ask Sisu to forget it." }),
    summary: `Remembered ${result.item.kind}: ${result.item.value}`,
    memory: result.item,
    stages: [{ kind: "memory", title: "Remembered", summary: `${result.item.kind.replace("_", " ")}: ${result.item.value}`, source: "customer-stated", data: { kind: "memory", item: result.item } }],
  });
}
