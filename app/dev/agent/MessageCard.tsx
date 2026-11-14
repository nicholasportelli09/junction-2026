import { useState } from "react";
import type { SisuMessage } from "@/lib/agent/useSisu";
import type { AgentAction, TeachingCard } from "@/lib/types";
import { VisualCard } from "@/app/visuals/VisualCard";

const seconds = (ms: number | null | undefined) => (ms === null || ms === undefined ? "–" : `${(ms / 1000).toFixed(2)} s`);
const host = (url: string) => new URL(url).hostname.replace(/^www\./, "");

const SOURCE_LABEL: Record<string, string> = { "bank-data": "bank data", exa: "Exa", "context.dev": "Context.dev", calculation: "calculated", assumption: "assumption", "customer-stated": "you said", nemotron: "Nemotron" };

const ACTION_STATE = { awaiting_approval: "Set up by Sisu · waiting for your approval", executed_simulated: "Done · simulation, no real money moved", declined: "Declined · nothing was done", expired: "Expired · nothing was done" };

// Predict first, then reveal: the answer stays hidden until an option is tapped.
function Teaching({ card }: { card: TeachingCard }) {
  const [picked, setPicked] = useState<number | null>(null);
  return (
    <div className="space-y-2 border-t border-line pt-2 text-sm">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted">Learn: {card.title}</p>
      <p>{card.question}</p>
      <div className="flex flex-wrap gap-2">
        {card.options.map((option, index) => (
          <button key={option} type="button" disabled={picked !== null} onClick={() => setPicked(index)} className={`min-h-11 rounded-xl border px-3 text-sm ${picked === null ? "border-line bg-paper" : index === card.correctIndex ? "border-green bg-green/10 font-semibold" : index === picked ? "border-coral bg-coral/10" : "border-line opacity-50"}`}>
            {option}
          </button>
        ))}
      </div>
      {picked !== null && <p className="text-muted">{card.reveal}</p>}
      {picked !== null && card.revealVisual && <VisualCard visual={card.revealVisual} />}
    </div>
  );
}

function ActionCard({ action, onApprove, onDecline }: { action: AgentAction; onApprove?: (id: string) => void; onDecline?: (id: string) => void }) {
  const waiting = action.status === "awaiting_approval";
  return (
    <div className="space-y-2 rounded-xl border border-amber/60 bg-amber/10 p-3 text-sm">
      <p className="text-xs font-semibold uppercase tracking-wide text-[#8a5f08]">{!action.simulated && action.status === "executed_simulated" ? "Approved · the watch is running (real monitors, no money moved)" : ACTION_STATE[action.status]}</p>
      <p className="font-semibold">{action.title}</p>
      <p className="text-muted">{action.summary}</p>
      {action.warning && <p className="rounded-lg bg-coral/10 p-2 text-coral">{action.warning}</p>}
      <ol className="list-decimal space-y-1 pl-5 text-xs text-muted">{action.checklist.map((step) => <li key={step}>{step}</li>)}</ol>
      {waiting && (
        <div className="flex gap-2">
          <button type="button" onClick={() => onApprove?.(action.id)} className="min-h-11 flex-1 rounded-xl bg-green px-3 font-semibold text-white">{action.simulated ? "Approve (simulation)" : "Approve (starts the watch)"}</button>
          <button type="button" onClick={() => onDecline?.(action.id)} className="min-h-11 flex-1 rounded-xl border border-line bg-card px-3 font-semibold">Decline</button>
        </div>
      )}
      {action.confirmation && <p className="font-semibold text-green">{action.confirmation}</p>}
      {action.impact && <p className="text-green">{action.impact.summary}</p>}
    </div>
  );
}

export function MessageCard({ message, onApprove, onDecline }: { message: SisuMessage; onApprove?: (id: string) => void; onDecline?: (id: string) => void }) {
  if (message.role === "user") {
    return <p className="ml-auto w-fit max-w-[85%] rounded-2xl bg-green px-4 py-2 text-white">{message.pending ? "Listening…" : message.text}</p>;
  }
  const { research, timings } = message;

  return (
    <article className="space-y-2 rounded-2xl border border-line bg-card p-4">
      {message.startedEarly && <p className="text-xs text-muted">Started {message.startedEarly} research early, before the model asked.</p>}
      {message.filler && <p className="text-sm italic text-muted">“{message.filler}”</p>}
      {message.text && <p className="leading-relaxed">{message.text}</p>}
      {message.pending && !message.text && <p className="text-muted">Thinking…</p>}
      {message.error && <p className="rounded-xl bg-coral/10 p-3 text-sm text-coral">{message.error}</p>}

      {message.visuals.map((visual) => <VisualCard key={visual.id} visual={visual} />)}

      {message.steps.length > 0 && (
        <div className="border-t border-line pt-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">{message.pending ? "What Sisu is doing" : `What Sisu did (${message.steps.length} ${message.steps.length === 1 ? "step" : "steps"})`}</p>
          <ol className="mt-1 space-y-1 text-sm">
            {message.steps.map((step) => (
              <li key={step.id} className="grid grid-cols-[1rem_1fr] items-baseline gap-x-2">
                <span aria-hidden className={`font-semibold ${!step.done ? "animate-pulse text-amber" : step.ok ? "text-green" : "text-coral"}`}>{!step.done ? "…" : step.ok ? "✓" : "×"}</span>
                <span>
                  <span className={step.done ? "" : "font-semibold"}>{step.label}</span>
                  {step.done && <span className="tabular ml-2 text-xs text-muted">{seconds(step.tookMs)}</span>}
                  {step.result && <span className="block text-xs text-muted">{step.result}</span>}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {message.stages.length > 0 && (
        <ol className="space-y-1 border-t border-line pt-2 text-xs">
          {message.stages.map((stage, index) => (
            <li key={stage.id} className="flex flex-wrap gap-x-2">
              <span className="tabular text-muted">{index + 1}.</span>
              <span className="font-semibold">{stage.title}</span>
              <span className="text-muted">{SOURCE_LABEL[stage.source] ?? stage.source} · {seconds(stage.atMs)}</span>
              <span className="w-full text-muted">{stage.summary}</span>
            </li>
          ))}
        </ol>
      )}

      {research && research.offers.length > 0 && (
        <div className="overflow-x-auto border-t border-line pt-2">
          <p className="text-xs text-muted">
            {research.mock ? "Example offers (mock)" : `Live offers, retrieved ${new Date(research.citations[0]?.retrievedAt ?? research.startedAt).toLocaleTimeString()}`} · your bill €{research.baselineMonthlyEur?.toFixed(0) ?? "?"}/mo · pages {research.pagesDone}/{research.pagesTotal}
          </p>
          <table className="tabular mt-1 w-full min-w-[420px] text-left text-xs">
            <thead><tr className="text-muted"><th className="py-1 font-medium">Offer</th><th className="font-medium">Est. €/mo</th><th className="font-medium">Saves €/yr</th><th className="font-medium">Source</th></tr></thead>
            <tbody>
              {research.offers.slice(0, 6).map((offer) => (
                <tr key={`${offer.provider}-${offer.plan}-${offer.sourceUrl}`} className={offer === research.best ? "font-semibold text-green" : ""}>
                  <td className="py-1 pr-2">{offer.provider} {offer.plan ?? ""}</td>
                  <td>{offer.comparable ? offer.estimatedMonthlyCostEur?.toFixed(2) : "not ranked"}</td>
                  <td>{offer.estimatedYearlySavingEur?.toFixed(0) ?? "–"}</td>
                  <td><a href={offer.sourceUrl} target="_blank" rel="noreferrer" className="underline">{host(offer.sourceUrl)}</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {message.citations.length > 0 && !research && (
        <p className="border-t border-line pt-2 text-xs text-muted">
          Sources: {message.citations.map((c, i) => <a key={c.url} href={c.url} target="_blank" rel="noreferrer" className="underline">{i ? ", " : ""}{host(c.url)}</a>)}
        </p>
      )}

      {message.teaching && <Teaching card={message.teaching} />}
      {message.action && <ActionCard action={message.action} onApprove={onApprove} onDecline={onDecline} />}
      {message.remembered.map((item) => <p key={item.id} className="text-xs text-muted">Sisu will remember: {item.kind.replace("_", " ")} = {item.value}</p>)}

      {message.grounding && message.grounding.checked > 0 && (
        <p className={`border-t border-line pt-2 text-xs ${message.grounding.ok ? "text-muted" : "text-coral"}`}>
          {message.grounding.ok ? (message.grounding.checked === 1 ? "The 1 number has a source" : `All ${message.grounding.checked} numbers have a source`) : `No source for: ${message.grounding.unverified.join(", ")}`}
          {message.grounding.corrections.length > 0 && ` · ${message.grounding.corrections.length} slipped digit corrected`}
          {message.facts.length > 0 && ` · ${[...new Set(message.facts.map((f) => SOURCE_LABEL[f.source] ?? f.source))].join(", ")}`}
        </p>
      )}

      {timings && (
        <p className="tabular border-t border-line pt-2 text-xs text-muted">
          {timings.sttMs !== null && <>heard in {seconds(timings.sttMs)} · </>}first word {seconds(timings.firstTokenMs)} · first sentence {seconds(timings.firstSentenceMs)} · done {seconds(timings.totalMs)} · {timings.modelSteps.length} model {timings.modelSteps.length === 1 ? "step" : "steps"} on {[...new Set(timings.modelSteps.map((step) => step.provider))].join(" + ")}{timings.modelSteps.some((step) => step.usedBackup) ? " (backup took over)" : ""}
        </p>
      )}
    </article>
  );
}
