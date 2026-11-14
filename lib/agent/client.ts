// Browser side of the agent. No React here, so any UI can use it.
// It does three things: reads the event stream, records the microphone, and plays speech in order.
import type { VoiceLanguage } from "./languages";
import type { ActionList, AgentAction, BillPhotoResult, BillType, ChatTurn, CustomerMemory, MemoryKind, PropertyWatch, ResearchResult, SisuEvent, WatchCheck, WatchList, WatchNotification } from "@/lib/types";

export type TurnInput = {
  customerId: string;
  text?: string; // typed question
  audio?: Blob; // or a recording
  mode?: "voice" | "text";
  history?: ChatTurn[];
  focusBill?: BillType;
  investigate?: boolean; // true = run a whole investigation instead of answering `text`
  language?: string; // "auto" (default) or a code such as "fi", "de", "hi": the language to listen for and answer in
  signal?: AbortSignal;
};

async function readError(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? "Sisu could not answer just now. Please try again.";
}

// Sends one question (typed or recorded) and yields each event as the server produces it.
export async function* streamTurn(input: TurnInput): AsyncGenerator<SisuEvent> {
  const response = input.audio
    ? await fetch("/api/voice/turn", { method: "POST", signal: input.signal, body: voiceForm(input) })
    : await fetch(input.investigate ? "/api/agent/investigate" : "/api/agent/query", {
        method: "POST",
        signal: input.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerId: input.customerId, text: input.text, mode: input.mode ?? "text", history: input.history, focusBill: input.focusBill, language: input.language }),
      });
  if (!response.ok || !response.body) {
    yield { type: "error", message: await readError(response) };
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    const messages = buffer.split("\n\n");
    buffer = messages.pop() ?? "";
    for (const message of messages) {
      if (message.startsWith("data: ")) yield JSON.parse(message.slice(6)) as SisuEvent;
    }
  }
}

function voiceForm(input: TurnInput): FormData {
  const form = new FormData();
  form.set("audio", input.audio as Blob, "speech");
  form.set("customerId", input.customerId);
  form.set("history", JSON.stringify(input.history ?? []));
  if (input.focusBill) form.set("focusBill", input.focusBill);
  form.set("language", input.language ?? "auto");
  return form;
}

// Call when the app opens: opens the server's connections and says whether it is in mock mode.
export async function warmAgent(): Promise<{ mock: boolean; provider: string; model: string } | null> {
  const response = await fetch("/api/agent/warm").catch(() => null);
  return response?.ok ? ((await response.json()) as { mock: boolean; provider: string; model: string }) : null;
}

// Call when the user confirms a bill's name, so offers are ready before they ask.
export async function prefetchOffers(customerId: string, billType: BillType): Promise<ResearchResult | null> {
  const response = await fetch("/api/research", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ customerId, billType, wait: false }),
  }).catch(() => null);
  return response?.ok ? ((await response.json()) as ResearchResult) : null;
}

async function postJson<T>(url: string, body: unknown, method = "POST"): Promise<T> {
  const response = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const parsed = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!response.ok || !parsed) throw new Error(parsed?.error ?? "Something went wrong. Please try again.");
  return parsed;
}

// --- Actions: the user approves or declines what Sisu prepared. Nothing happens without approveAction. ---
export const approveAction = (customerId: string, actionId: string) => postJson<{ action: AgentAction }>(`/api/actions/${actionId}/approve`, { customerId, confirm: true });
export const declineAction = (customerId: string, actionId: string) => postJson<{ action: AgentAction }>(`/api/actions/${actionId}/decline`, { customerId });
export async function fetchActions(customerId: string): Promise<ActionList | null> {
  const response = await fetch(`/api/actions?customerId=${customerId}`).catch(() => null);
  return response?.ok ? ((await response.json()) as ActionList) : null;
}

// --- Property watches: what Sisu is watching for this visitor, and what it has found. ---
export async function fetchWatches(customerId: string): Promise<WatchList | null> {
  const response = await fetch(`/api/watch?customerId=${customerId}`).catch(() => null);
  return response?.ok ? ((await response.json()) as WatchList) : null;
}
// Asks Context.dev whether a watched page changed. runNow also queues a fresh check of every page there.
export const checkWatches = (customerId: string, runNow = false) => postJson<WatchCheck>("/api/watch/check", { customerId, runNow });
export const stopWatch = (customerId: string, watchId: string) => postJson<{ watch: PropertyWatch }>(`/api/watch/${watchId}/stop`, { customerId });
// Demo only: a made-up price drop, labelled as simulated in the notification and in the audit log.
export const simulateWatchDrop = (customerId: string, watchId: string) => postJson<{ notification: WatchNotification }>(`/api/watch/${watchId}/simulate-drop`, { customerId });

// --- Memory: what Sisu remembers between sessions. ---
export async function fetchMemory(customerId: string): Promise<CustomerMemory | null> {
  const response = await fetch(`/api/memory?customerId=${customerId}`).catch(() => null);
  return response?.ok ? ((await response.json()) as CustomerMemory) : null;
}
// Call when the user confirms or corrects a bill's name on its card.
export const confirmBill = (customerId: string, billId: string, name: string, billType?: BillType) =>
  postJson<CustomerMemory>("/api/memory", { customerId, kind: "bill_name" satisfies MemoryKind, key: billId, value: name, billType });
export const setMemoryConsent = (customerId: string, consent: boolean) => postJson<CustomerMemory>("/api/memory", { customerId, consent });
export const forgetMemory = (customerId: string, itemId?: string) => postJson<CustomerMemory>(`/api/memory?customerId=${customerId}${itemId ? `&itemId=${itemId}` : ""}`, {}, "DELETE");

// A photo of the customer's own bill in, the figures printed on it out. Nothing is saved: show `toConfirm`,
// and when the user agrees call rememberKwh with the figure.
export async function readBillPhoto(customerId: string, photo: Blob): Promise<BillPhotoResult> {
  const form = new FormData();
  form.set("image", photo, "bill");
  form.set("customerId", customerId);
  const response = await fetch("/api/agent/bill-photo", { method: "POST", body: form });
  const parsed = (await response.json().catch(() => null)) as (BillPhotoResult & { error?: string }) | null;
  if (!response.ok || !parsed) throw new Error(parsed?.error ?? "Sisu could not read that photo.");
  return parsed;
}
export const rememberKwh = (customerId: string, yearlyKwh: number) => postJson<CustomerMemory>("/api/memory", { customerId, kind: "yearly_kwh" satisfies MemoryKind, value: String(yearlyKwh) });

export type VoiceChoice = { model?: string; voiceId?: string };

export type Speaker = {
  say: (text: string) => void; // queue a sentence; its audio is requested at once and played in order
  stop: () => void; // drop everything, used when the user interrupts
  unlock: () => void; // call inside a tap or click so the browser allows sound
  setVoice: (choice: VoiceChoice) => void; // try a different model or voice (test bench)
  setLanguage: (language: string | null) => void; // the language of what is said next (ISO 639-1), or null to let the voice work it out
  whenQuiet: () => Promise<void>; // resolves when the queue has finished playing
};

type AudioContextClass = typeof AudioContext;
type Clip = { response: Promise<Response | null>; abort: AbortController };

const SAMPLE_RATE = 24_000; // must match PCM_SAMPLE_RATE on the server
const LEAD_SECONDS = 0.04; // tiny cushion so the first chunk is not clipped

// Plays Sisu's sentences one after another, starting each as soon as its first audio arrives.
// The server streams raw samples, and each chunk is scheduled on the Web Audio clock right behind
// the previous one, so nothing waits for a whole clip to download or decode. Web Audio also keeps
// working in Safari and on phones once one tap has unlocked it.
export function createSpeaker(onSpeakingChange?: (speaking: boolean) => void, onError?: (message: string) => void): Speaker {
  let context: AudioContext | null = null;
  let queue: Clip[] = [];
  let playing: AudioBufferSourceNode[] = [];
  let generation = 0; // bumping this cancels a playback loop in progress
  let running: Promise<void> | null = null;
  let lastSaid = "";
  let voice: VoiceChoice = {};
  let language: string | null = null;

  function audio(): AudioContext | null {
    if (context) return context;
    const Context: AudioContextClass | undefined = window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioContextClass }).webkitAudioContext;
    if (!Context) {
      onError?.("This browser cannot play Sisu's voice. The answer is shown as text.");
      return null;
    }
    context = new Context();
    return context;
  }

  function request(text: string, previousText: string): Clip {
    const abort = new AbortController();
    const response = fetch("/api/voice/tts", {
      method: "POST",
      signal: abort.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, format: "pcm", previousText, ...voice, ...(language ? { language } : {}) }),
    })
      .then(async (res) => {
        if (res.ok && res.body) return res;
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        onError?.(body?.error ?? "Sisu's voice is unavailable right now. The answer is shown as text.");
        return null;
      })
      .catch(() => {
        if (!abort.signal.aborted) onError?.("Sisu's voice could not be loaded. The answer is shown as text.");
        return null;
      });
    return { response, abort };
  }

  // Reads one sentence's audio as it streams in and schedules each chunk. Resolves when it has finished playing.
  async function playStream(ctx: AudioContext, response: Response, mine: number): Promise<void> {
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    let leftover: Uint8Array = new Uint8Array(0); // a sample can be split across two network chunks
    let playAt = 0;
    let lastSource: AudioBufferSourceNode | null = null;

    for (;;) {
      const { done, value } = await reader.read();
      if (mine !== generation) {
        void reader.cancel().catch(() => undefined);
        return;
      }
      if (done) break;
      const bytes = new Uint8Array(leftover.length + value.length);
      bytes.set(leftover);
      bytes.set(value, leftover.length);
      const usable = bytes.length - (bytes.length % 2);
      leftover = bytes.slice(usable);
      if (!usable) continue;

      const samples = new Int16Array(bytes.buffer, 0, usable / 2);
      const buffer = ctx.createBuffer(1, samples.length, SAMPLE_RATE);
      const channel = buffer.getChannelData(0);
      for (let i = 0; i < samples.length; i++) channel[i] = samples[i] / 32768;

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      playAt = Math.max(playAt, ctx.currentTime + LEAD_SECONDS);
      source.start(playAt);
      playAt += buffer.duration;
      playing = [...playing, source];
      source.onended = () => {
        playing = playing.filter((node) => node !== source);
      };
      lastSource = source;
    }
    const finalSource = lastSource;
    if (finalSource && playing.includes(finalSource)) {
      await new Promise<void>((resolve) => finalSource.addEventListener("ended", () => resolve(), { once: true }));
    }
  }

  async function drain(mine: number): Promise<void> {
    onSpeakingChange?.(true);
    while (queue.length && mine === generation) {
      const clip = queue[0];
      const response = await clip.response;
      if (mine !== generation) break;
      queue = queue.slice(1);
      const ctx = audio();
      if (!response || !ctx) continue;
      if (ctx.state === "suspended") await ctx.resume().catch(() => undefined);
      if (ctx.state !== "running") {
        onError?.("Your browser is blocking sound. Tap anywhere on the page, then ask again.");
        continue;
      }
      await playStream(ctx, response, mine);
    }
    if (mine === generation) {
      running = null;
      onSpeakingChange?.(false);
    }
  }

  return {
    say(text) {
      queue = [...queue, request(text, lastSaid)];
      lastSaid = text;
      running ??= drain(generation);
    },
    stop() {
      generation += 1;
      queue.forEach((clip) => clip.abort.abort());
      queue = [];
      running = null;
      lastSaid = "";
      playing.forEach((source) => {
        try {
          source.stop();
        } catch {
          // already stopped
        }
      });
      playing = [];
      onSpeakingChange?.(false);
    },
    unlock() {
      void audio()?.resume().catch(() => undefined);
    },
    setVoice(choice) {
      voice = choice;
    },
    setLanguage(next) {
      language = next;
    },
    whenQuiet: () => running ?? Promise.resolve(),
  };
}

export type VoiceOptions = { voices: { id: string; name: string; accent: string | null; style: string | null }[]; models: string[]; current: { model: string; voiceId: string }; languages: VoiceLanguage[] };

export async function fetchVoiceOptions(): Promise<VoiceOptions | null> {
  const response = await fetch("/api/voice/tts").catch(() => null);
  return response?.ok ? ((await response.json()) as VoiceOptions) : null;
}

export type Recorder = { start: () => Promise<void>; stop: () => Promise<Blob | null>; release: () => void };

const RECORDING_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];

// Push-to-talk recording. start() on press, stop() on release. The microphone stays open between
// presses so the second question has no permission delay; release() closes it.
export function createRecorder(): Recorder {
  let stream: MediaStream | null = null;
  let recorder: MediaRecorder | null = null;
  let chunks: Blob[] = [];

  return {
    async start() {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("This browser cannot record audio. Type your question instead.");
      stream ??= await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }).catch(() => {
        throw new Error("Sisu needs microphone access. Allow it in the browser, or type your question.");
      });
      const mimeType = RECORDING_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
      chunks = [];
      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunks = [...chunks, event.data];
      };
      recorder.start();
    },
    stop() {
      return new Promise((resolve) => {
        const active = recorder;
        if (!active || active.state === "inactive") return resolve(null);
        active.onstop = () => resolve(chunks.length ? new Blob(chunks, { type: active.mimeType }) : null);
        active.stop();
      });
    },
    release() {
      stream?.getTracks().forEach((track) => track.stop());
      stream = null;
    },
  };
}
