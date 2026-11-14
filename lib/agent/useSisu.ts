"use client";

// One hook for the whole conversation: type or hold-to-talk, streamed answers, spoken replies, interruption.
// Usage is shown in context/frontend-integration.md and app/dev/agent/page.tsx.
import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentAction, BillType, ChatTurn, Citation, CustomerMemory, Fact, Grounding, MemoryItem, PropertyWatch, ResearchResult, Stage, SisuActivity, TeachingCard, ToolTrace, TurnTimings, Visual, WatchCheck, WatchNotification } from "@/lib/types";
import { freedByApprovedSwitches } from "@/lib/actions/freed";
import { IDLE, activity as makeActivity, nextActivity } from "./activity";
import { type Recorder, type Speaker, type VoiceChoice, approveAction, checkWatches as pollWatches, confirmBill as saveBillName, createRecorder, createSpeaker, declineAction, fetchActions, fetchMemory, fetchWatches, simulateWatchDrop, stopWatch as endWatch, streamTurn, warmAgent } from "./client";

const WATCH_CHECK_EVERY_MS = 60_000;

export type SisuStatus = "idle" | "recording" | "thinking" | "speaking";

export type SisuMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  pending: boolean; // still being heard or written
  filler: string | null; // the "let me check" line, if one was said
  startedEarly: BillType | null; // research the server began before the model asked for it
  tools: ToolTrace[];
  research: ResearchResult | null;
  citations: Citation[];
  timings: TurnTimings | null;
  error: string | null;
  // Added 14 Nov (all optional to read; older UI code keeps working):
  visuals: Visual[]; // charts to draw with this answer (see app/visuals/VisualCard.tsx)
  stages: Stage[]; // each step of Sisu's work, typed for drawing as cards (see Stage in lib/types.ts)
  action: AgentAction | null; // an action awaiting approval; show Approve and Decline
  teaching: TeachingCard | null; // ask `question`, show `options`, then reveal `reveal`
  remembered: MemoryItem[]; // things Sisu saved this turn ("Sisu will remember…")
  grounding: Grounding | null; // every number in the answer and whether it has a source
  facts: Fact[]; // the receipts: what each number is, where it came from, how to open its rows
  steps: SisuStep[]; // what Sisu is doing, one line per tool call, in order. Show these live while `pending` is true
};

// One thing Sisu did (or is doing right now) in this turn.
export type SisuStep = { id: string; label: string; done: boolean; ok: boolean; tookMs: number | null; result: string | null };

export type SisuOptions = {
  customerId: string | null;
  focusBill?: BillType; // the bill card the user has open, if any
  speakReplies?: boolean; // default true
  language?: string; // "auto" (default): Sisu hears which language is spoken and answers in it. Or a code such as "fi", "de", "hi"
};

const blank = (role: "user" | "assistant", text = "", pending = true): SisuMessage => ({
  id: crypto.randomUUID(),
  role,
  text,
  pending,
  filler: null,
  startedEarly: null,
  tools: [],
  research: null,
  citations: [],
  timings: null,
  error: null,
  visuals: [],
  stages: [],
  action: null,
  teaching: null,
  remembered: [],
  grounding: null,
  facts: [],
  steps: [],
});

export function useSisu({ customerId, focusBill, speakReplies = true, language = "auto" }: SisuOptions) {
  const [messages, setMessages] = useState<SisuMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [working, setWorking] = useState<SisuActivity>(IDLE); // the last thing Sisu did in the current turn
  const [moment, setMoment] = useState<SisuActivity | null>(null); // a short celebration or a quiet "left as it was"
  const [server, setServer] = useState<{ mock: boolean; provider: string; model: string } | null>(null);
  const [micError, setMicError] = useState<string | null>(null);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [actions, setActions] = useState<AgentAction[]>([]);
  const [memory, setMemory] = useState<CustomerMemory | null>(null);
  const [watches, setWatches] = useState<PropertyWatch[]>([]);
  const [notifications, setNotifications] = useState<WatchNotification[]>([]);
  const [heardLanguage, setHeardLanguage] = useState<string | null>(null); // the language of the last spoken question, when it was recognised

  const speaker = useRef<Speaker | null>(null);
  const recorder = useRef<Recorder | null>(null);
  const controller = useRef<AbortController | null>(null);
  const history = useRef<ChatTurn[]>([]);
  const pressed = useRef(false); // is the talk button held right now?
  const capturing = useRef(false); // is the microphone actually recording?

  useEffect(() => {
    speaker.current = createSpeaker(setSpeaking, setVoiceError);
    recorder.current = createRecorder();
    warmAgent().then(setServer);
    return () => {
      controller.current?.abort();
      speaker.current?.stop();
      recorder.current?.release();
    };
  }, []);

  const patch = (id: string, change: (message: SisuMessage) => SisuMessage) =>
    setMessages((all) => all.map((message) => (message.id === id ? change(message) : message)));

  // Actions and memory belong to the customer, not to one conversation, so they load when the customer changes.
  const refresh = useCallback(async () => {
    if (!customerId) return;
    const [list, remembered, watching] = await Promise.all([fetchActions(customerId), fetchMemory(customerId), fetchWatches(customerId)]);
    if (list) setActions(list.actions);
    if (remembered) setMemory(remembered);
    if (watching) {
      setWatches(watching.watches);
      setNotifications(watching.notifications);
    }
  }, [customerId]);

  useEffect(() => {
    setActions([]);
    setMemory(null);
    setWatches([]);
    setNotifications([]);
    void refresh();
  }, [refresh]);

  // Property watches. An approved watch is checked here once a minute for as long as the hook is on screen:
  // Sisu asks Context.dev whether a watched page changed, and a flat that now fits arrives in `notifications`.
  const checkWatches = useCallback(
    async (runNow = false): Promise<WatchCheck | null> => {
      if (!customerId) return null;
      const result = await pollWatches(customerId, runNow).catch(() => null);
      await refresh();
      return result;
    },
    [customerId, refresh],
  );
  const stopWatch = useCallback(
    async (watchId: string): Promise<void> => {
      if (!customerId) return;
      await endWatch(customerId, watchId);
      await refresh();
    },
    [customerId, refresh],
  );
  // Demo only: a made-up price drop on a watched flat. The notification it produces says it is simulated.
  const simulatePriceDrop = useCallback(
    async (watchId: string): Promise<WatchNotification | null> => {
      if (!customerId) return null;
      const { notification } = await simulateWatchDrop(customerId, watchId);
      await refresh();
      return notification;
    },
    [customerId, refresh],
  );
  const watching = watches.some((watch) => watch.status === "active");
  useEffect(() => {
    if (!watching) return;
    const timer = setInterval(() => void checkWatches(), WATCH_CHECK_EVERY_MS);
    return () => clearInterval(timer);
  }, [watching, checkWatches]);

  const putAction = (action: AgentAction) => {
    setActions((all) => [action, ...all.filter((existing) => existing.id !== action.id)]);
    setMessages((all) => all.map((message) => (message.action?.id === action.id ? { ...message, action } : message)));
  };

  // Stops whatever Sisu is doing. Used when the user interrupts or switches customer.
  const cancel = useCallback(() => {
    controller.current?.abort();
    controller.current = null;
    speaker.current?.stop();
    setBusy(false);
    setMessages((all) => all.map((message) => (message.pending ? { ...message, pending: false } : message)));
  }, []);

  const reset = useCallback(() => {
    cancel();
    history.current = [];
    setMessages([]);
  }, [cancel]);

  const runTurn = useCallback(
    async (input: { text?: string; audio?: Blob; investigate?: boolean }) => {
      if (!customerId) return;
      cancel();
      const abort = new AbortController();
      controller.current = abort;
      const spoken = speakReplies;
      const user = blank("user", input.text ?? "", !input.text);
      const reply = blank("assistant");
      setMessages((all) => [...all, user, reply]);
      setBusy(true);

      let question = input.text ?? "";
      try {
        // A chosen language is used for the whole turn. In "auto" the voice works out the language from the text,
        // until speech to text reports what was spoken.
        const chosen = language === "auto" ? null : language;
        speaker.current?.setLanguage(chosen);
        const events = streamTurn({ customerId, ...input, mode: spoken ? "voice" : "text", history: input.investigate ? [] : history.current, focusBill, language, signal: abort.signal });
        setMoment(null);
        setWorking(makeActivity("thinking"));
        for await (const event of events) {
          if (abort.signal.aborted) return;
          setWorking((now) => nextActivity(now, event));
          switch (event.type) {
            case "transcript":
              question = event.text;
              patch(user.id, (m) => ({ ...m, text: event.text || "(nothing heard)", pending: false }));
              if (event.language) {
                setHeardLanguage(event.language);
                speaker.current?.setLanguage(event.language); // speak the answer in the language that was spoken
              }
              break;
            case "speculation":
              patch(reply.id, (m) => ({ ...m, startedEarly: event.billType }));
              break;
            case "filler":
              patch(reply.id, (m) => ({ ...m, filler: event.text }));
              if (spoken) speaker.current?.say(event.text);
              break;
            case "delta":
              patch(reply.id, (m) => ({ ...m, text: m.text + event.text }));
              break;
            case "replace": // Sisu threw away a sentence that failed a check; show the answer so far instead
              patch(reply.id, (m) => ({ ...m, text: event.text }));
              break;
            case "sentence":
              if (spoken) speaker.current?.say(event.text);
              break;
            case "tool_start":
              patch(reply.id, (m) => ({ ...m, steps: [...m.steps, { id: event.id, label: event.label ?? event.name, done: false, ok: true, tookMs: null, result: null }] }));
              break;
            case "tool_end":
              patch(reply.id, (m) => ({
                ...m,
                tools: [...m.tools, event.trace],
                steps: m.steps.map((step) => (step.id === event.trace.id ? { ...step, done: true, ok: event.trace.ok, tookMs: event.trace.tookMs, result: event.trace.summary } : step)),
              }));
              break;
            case "research":
              patch(reply.id, (m) => ({ ...m, research: event.result }));
              break;
            case "visual":
              patch(reply.id, (m) => ({ ...m, visuals: [...m.visuals.filter((v) => v.id !== event.visual.id), event.visual] }));
              break;
            case "stage":
              patch(reply.id, (m) => ({ ...m, stages: [...m.stages, event.stage] }));
              break;
            case "action":
              patch(reply.id, (m) => ({ ...m, action: event.action }));
              setActions((all) => [event.action, ...all.filter((existing) => existing.id !== event.action.id)]);
              break;
            case "teaching":
              patch(reply.id, (m) => ({ ...m, teaching: event.card }));
              break;
            case "memory":
              patch(reply.id, (m) => ({ ...m, remembered: [...m.remembered, event.item] }));
              void refresh();
              break;
            case "grounding":
              patch(reply.id, (m) => ({ ...m, grounding: event.grounding, facts: event.facts }));
              break;
            case "done":
              patch(reply.id, (m) => ({ ...m, text: event.text || m.text, pending: false, citations: event.citations, timings: event.timings }));
              history.current = [...history.current, { role: "user" as const, content: question }, { role: "assistant" as const, content: event.text }].slice(-12);
              break;
            case "error":
              patch(user.id, (m) => ({ ...m, pending: false }));
              patch(reply.id, (m) => ({ ...m, pending: false, error: event.message }));
              break;
          }
        }
      } catch (error) {
        if (!abort.signal.aborted) patch(reply.id, (m) => ({ ...m, pending: false, error: (error as Error).message || "The connection dropped. Please try again." }));
      } finally {
        if (controller.current === abort) {
          controller.current = null;
          setBusy(false);
          setMessages((all) => all.map((message) => (message.pending ? { ...message, pending: false } : message)));
        }
      }
    },
    [customerId, focusBill, speakReplies, language, cancel, refresh],
  );

  // Sisu works through a whole case on its own. Watch `stages` on the reply fill in as it goes.
  const investigate = useCallback(() => {
    speaker.current?.unlock();
    setVoiceError(null);
    void runTurn({ text: "Look into my finances and find the best thing I can do.", investigate: true });
  }, [runTurn]);

  // The Approve and Decline buttons. Approval is the only thing that carries an action out, and it is a simulation.
  // Both return the updated action; after an approval `action.impact` holds what it adds up to.
  const approve = useCallback(
    async (actionId: string): Promise<AgentAction | null> => {
      if (!customerId) return null;
      const { action } = await approveAction(customerId, actionId);
      putAction(action);
      setMoment(makeActivity("approved", action.confirmation ?? "Done, as a simulation"));
      if (action.watch) void refresh(); // the approval started a watch: load it
      return action;
    },
    [customerId, refresh],
  );
  const decline = useCallback(
    async (actionId: string): Promise<AgentAction | null> => {
      if (!customerId) return null;
      const { action } = await declineAction(customerId, actionId);
      putAction(action);
      setMoment(makeActivity("declined"));
      return action;
    },
    [customerId],
  );

  // Call when the user confirms or corrects a bill's name. Saves it and starts offer research for that bill.
  const confirmBill = useCallback(
    async (billId: string, name: string, billType?: BillType) => {
      if (!customerId) return;
      setMemory(await saveBillName(customerId, billId, name, billType));
    },
    [customerId],
  );

  const ask = useCallback(
    (text: string) => {
      const question = text.trim();
      if (!question) return;
      speaker.current?.unlock();
      setVoiceError(null);
      void runTurn({ text: question });
    },
    [runTurn],
  );

  // Press: stop Sisu talking and start listening. Release: send what was said.
  const startTalking = useCallback(async () => {
    if (pressed.current) return;
    pressed.current = true;
    cancel();
    speaker.current?.unlock();
    setMicError(null);
    setVoiceError(null);
    try {
      await recorder.current?.start();
    } catch (error) {
      pressed.current = false;
      setMicError((error as Error).message);
      return;
    }
    // The first press shows the browser's permission prompt, and the button is released while it is up.
    if (!pressed.current) {
      await recorder.current?.stop();
      setMicError("The microphone is ready. Hold the button while you speak, then let go.");
      return;
    }
    capturing.current = true;
    setRecording(true);
  }, [cancel]);

  const stopTalking = useCallback(async () => {
    if (!pressed.current) return;
    pressed.current = false;
    if (!capturing.current) return; // still starting; startTalking handles it
    capturing.current = false;
    setRecording(false);
    const audio = await recorder.current?.stop();
    if (audio && audio.size > 2_000) void runTurn({ audio });
    else setMicError("That was too short. Hold the button while you speak, then let go.");
  }, [runTurn]);

  // Tries another ElevenLabs model or voice for everything Sisu says next (test bench only).
  const setVoice = useCallback((choice: VoiceChoice) => speaker.current?.setVoice(choice), []);

  // Says a fixed sentence, to check that sound works on this device.
  const testVoice = useCallback(() => {
    setVoiceError(null);
    speaker.current?.unlock();
    speaker.current?.stop();
    speaker.current?.say("Hi, this is Sisu. I found a cheaper electricity deal that could save you about a hundred and forty euros a year.");
  }, []);

  const status: SisuStatus = recording ? "recording" : busy ? "thinking" : speaking ? "speaking" : "idle";
  // What has been freed so far by approved switches: feed this to the futures chart as the monthly bill saving.
  const approvedMonthlySaving = freedByApprovedSwitches(actions);
  // One value that says what Sisu is doing right now. Map `activity.liito` to the mascot's animation.
  const waiting = actions.find((action) => action.status === "awaiting_approval");
  const activity: SisuActivity = recording
    ? makeActivity("listening")
    : busy
      ? working
      : speaking
        ? makeActivity("speaking")
        : (moment ?? (waiting ? makeActivity("waiting_for_approval", waiting.title, waiting.warning ?? null) : IDLE));
  return { activity, status, messages, server, micError, voiceError, heardLanguage, ask, startTalking, stopTalking, testVoice, setVoice, cancel, reset, investigate, approve, decline, confirmBill, actions, memory, approvedMonthlySaving, refresh, watches, notifications, checkWatches, stopWatch, simulatePriceDrop };
}
