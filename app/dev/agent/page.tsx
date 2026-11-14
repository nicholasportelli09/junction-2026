"use client";

// A live test bench for the agent: talk or type to Sisu and see every step with its timing.
// It is for the team, not the judges. The real UI lives in app/page.tsx and components/.
import { useEffect, useState } from "react";
import { fetchDemoCustomers } from "@/lib/api";
import { type VoiceOptions, fetchVoiceOptions, prefetchOffers } from "@/lib/agent/client";
import { WatchPanel } from "./WatchPanel";
import { useSisu } from "@/lib/agent/useSisu";
import type { DemoCustomer } from "@/lib/types";
import { MessageCard } from "./MessageCard";

const STATUS_LABEL = { idle: "Hold to talk", recording: "Listening… release to send", thinking: "Thinking…", speaking: "Speaking… hold to interrupt" };
const EXAMPLES = ["How much can I safely spend this week?", "Where is my money going? What should I change?", "Can I afford a 300 euro phone repair right now?", "Find me a cheaper electricity deal and prepare the switch.", "What if I save 50 euros a month for five years?", "Explain the three baskets idea to me.", "What is Kela's general housing allowance?"];

export default function AgentBench() {
  const [customers, setCustomers] = useState<DemoCustomer[]>([]);
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [speakReplies, setSpeakReplies] = useState(true);
  const [draft, setDraft] = useState("");
  const [prefetched, setPrefetched] = useState<string | null>(null);
  const [voiceOptions, setVoiceOptions] = useState<VoiceOptions | null>(null);
  const [voice, setVoice] = useState<{ model: string; voiceId: string } | null>(null);
  const [language, setLanguage] = useState("auto");
  const sisu = useSisu({ customerId, speakReplies, language });

  useEffect(() => {
    fetchVoiceOptions().then((options) => {
      setVoiceOptions(options);
      if (options) setVoice(options.current);
    });
  }, []);

  const chooseVoice = (change: Partial<{ model: string; voiceId: string }>) => {
    if (!voice) return;
    const next = { ...voice, ...change };
    setVoice(next);
    sisu.setVoice(next);
  };

  useEffect(() => {
    fetchDemoCustomers().then((list) => {
      setCustomers(list);
      setCustomerId((current) => current ?? list[0]?.customerId ?? null);
    });
  }, []);

  const switchCustomer = (id: string) => {
    sisu.reset();
    setPrefetched(null);
    setCustomerId(id);
  };

  const prefetch = async () => {
    if (!customerId) return;
    const result = await prefetchOffers(customerId, "electricity");
    setPrefetched(result ? `Electricity research ${result.status} (started in the background)` : "Could not start research");
  };

  // Clears actions, memory and the audit log on the server, then the conversation here.
  const resetDemo = async () => {
    await fetch("/api/demo/reset", { method: "POST" });
    sisu.reset();
    void sisu.refresh();
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    sisu.ask(draft);
    setDraft("");
  };

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[560px] flex-col gap-4 bg-paper px-4 pb-48 pt-6">
      <header className="flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-xl font-semibold tracking-tight">Sisu agent test bench</h1>
        {sisu.server?.mock && <span className="rounded-full bg-amber/20 px-2 py-0.5 text-xs font-semibold text-[#8a5f08]">MOCK DATA</span>}
        <span className="rounded-full border border-line bg-card px-2 py-0.5 text-xs text-muted">{sisu.server ? sisu.server.model.split("/").pop() : "connecting…"}</span>
        {/* Stand-in for the mascot: the pose Liito should be in, and what Sisu is doing right now. */}
        <span className="rounded-full bg-green-soft px-2 py-0.5 text-xs font-semibold text-green">Liito: {sisu.activity.liito} · {sisu.activity.label}</span>
      </header>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <label className="flex items-center gap-2">
          <span className="text-muted">Customer</span>
          <select id="customer" value={customerId ?? ""} onChange={(e) => switchCustomer(e.target.value)} className="min-h-11 rounded-xl border border-line bg-card px-3 font-semibold">
            {customers.map((c) => <option key={c.customerId} value={c.customerId}>{c.displayName}, {c.age} · {c.area}</option>)}
          </select>
        </label>
        <label className="flex min-h-11 items-center gap-2">
          <input id="speak" type="checkbox" checked={speakReplies} onChange={(e) => setSpeakReplies(e.target.checked)} className="h-5 w-5 accent-[var(--green)]" />
          Speak replies
        </label>
        <label className="flex items-center gap-2">
          <span className="text-muted">Language</span>
          <select id="language" value={language} onChange={(e) => setLanguage(e.target.value)} className="min-h-11 rounded-xl border border-line bg-card px-3 font-semibold">
            <option value="auto">Auto-detect{sisu.heardLanguage ? ` (heard: ${sisu.heardLanguage})` : ""}</option>
            {(voiceOptions?.languages ?? []).map((l) => <option key={l.code} value={l.code}>{l.nativeName} · {l.name}</option>)}
          </select>
        </label>
        <button type="button" onClick={prefetch} className="min-h-11 rounded-xl border border-line bg-card px-3 font-semibold">Prefetch electricity offers</button>
        <button type="button" onClick={sisu.testVoice} className="min-h-11 rounded-xl border border-line bg-card px-3 font-semibold">Test voice</button>
        <button type="button" onClick={sisu.investigate} disabled={!customerId} className="min-h-11 rounded-xl bg-ink px-3 font-semibold text-white disabled:opacity-40">Investigate for me</button>
        <button type="button" onClick={sisu.reset} className="min-h-11 rounded-xl border border-line bg-card px-3 font-semibold">Clear</button>
        <button type="button" onClick={resetDemo} className="min-h-11 rounded-xl border border-line bg-card px-3 font-semibold">Reset demo</button>
      </div>
      {prefetched && <p className="text-xs text-muted">{prefetched}</p>}
      {(sisu.memory?.items.length || sisu.actions.length) ? (
        <p className="text-xs text-muted">
          Remembered: {sisu.memory?.items.map((item) => `${item.kind.replace("_", " ")} = ${item.value}`).join("; ") || "nothing"} · Actions: {sisu.actions.map((action) => action.status.replace(/_/g, " ")).join(", ") || "none"} · Freed by approved switches: €{sisu.approvedMonthlySaving.toFixed(2)}/month
        </p>
      ) : null}

      {voiceOptions && voice && voiceOptions.voices.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <label className="flex items-center gap-2">
            <span className="text-muted">Voice</span>
            <select id="voice" value={voice.voiceId} onChange={(e) => chooseVoice({ voiceId: e.target.value })} className="min-h-11 max-w-[14rem] rounded-xl border border-line bg-card px-3 font-semibold">
              {voiceOptions.voices.map((v) => <option key={v.id} value={v.id}>{v.name.split(" - ")[0]}{v.accent ? ` · ${v.accent}` : ""}{v.style ? ` · ${v.style.replace(/_/g, " ")}` : ""}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-2">
            <span className="text-muted">Model</span>
            <select id="voice-model" value={voice.model} onChange={(e) => chooseVoice({ model: e.target.value })} className="min-h-11 rounded-xl border border-line bg-card px-3 font-semibold">
              {voiceOptions.models.map((m) => <option key={m} value={m}>{m.replace("eleven_", "").replace(/_/g, " ")}</option>)}
            </select>
          </label>
          <span className="text-xs text-muted">Pick, then tap Test voice. Tell Nicholas&apos;s Claude which pair sounds best.</span>
        </div>
      )}

      {sisu.messages.length === 0 && (
        <ul className="space-y-2">
          {EXAMPLES.map((example) => (
            <li key={example}>
              <button type="button" onClick={() => sisu.ask(example)} className="min-h-11 w-full rounded-2xl border border-line bg-card px-4 py-2 text-left text-sm hover:border-green">{example}</button>
            </li>
          ))}
        </ul>
      )}

      <WatchPanel customerId={customerId} />

      <ol className="space-y-3">
        {sisu.messages.map((message) => <li key={message.id}><MessageCard message={message} onApprove={(id) => void sisu.approve(id)} onDecline={(id) => void sisu.decline(id)} /></li>)}
      </ol>

      <div className="fixed inset-x-0 bottom-0 border-t border-line bg-card/95 px-4 pb-5 pt-3 backdrop-blur">
        <div className="mx-auto flex w-full max-w-[560px] flex-col gap-3">
          {sisu.micError && <p role="alert" className="text-sm text-coral">{sisu.micError}</p>}
          {sisu.voiceError && <p role="alert" className="text-sm text-coral">{sisu.voiceError}</p>}
          <button
            type="button"
            onPointerDown={sisu.startTalking}
            onPointerUp={sisu.stopTalking}
            onPointerLeave={sisu.stopTalking}
            onPointerCancel={sisu.stopTalking}
            onContextMenu={(e) => e.preventDefault()}
            className={`min-h-16 w-full touch-none select-none rounded-2xl text-lg font-semibold text-white transition ${sisu.status === "recording" ? "scale-[0.98] bg-coral" : "bg-green"}`}
          >
            {STATUS_LABEL[sisu.status]}
          </button>
          <form onSubmit={submit} className="flex gap-2">
            <input id="question" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Or type a question" maxLength={500} className="min-h-11 flex-1 rounded-xl border border-line bg-paper px-3" />
            <button type="submit" disabled={!draft.trim()} className="min-h-11 rounded-xl bg-ink px-4 font-semibold text-white disabled:opacity-40">Ask</button>
          </form>
        </div>
      </div>
    </main>
  );
}
