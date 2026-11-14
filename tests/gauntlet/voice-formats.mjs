// Voice on a running backend, with real recordings in the formats phones and browsers send.
// It makes its own clips with macOS `say` and `ffmpeg`, so it needs a Mac with ffmpeg installed.
// Bounded spend: about 20 short transcriptions and under 600 characters of speech per full run.
//
//   node tests/gauntlet/voice-formats.mjs [base] [groups]
//   base    default https://sisu-api.vercel.app (or SISU_BASE)
//   groups  any of stt,turn,edge,tts (default all), comma-separated
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.argv[2] ?? process.env.SISU_BASE ?? "https://sisu-api.vercel.app";
const only = (process.argv[3] ?? "stt,turn,edge,tts").split(",");
const dir = mkdtempSync(join(tmpdir(), "sisu-voice-")) + "/";
const ff = (...args) => execFileSync("ffmpeg", ["-loglevel", "error", "-y", ...args], { cwd: dir });
const speak = (out, text, voice) => execFileSync("say", [...(voice ? ["-v", voice] : []), "-o", out, text], { cwd: dir });
// The questions, spoken by the Mac, then encoded the way each kind of client records.
speak("en.aiff", "How much did I spend on eating out last month?");
speak("amount.aiff", "Can I afford a three hundred euro bike this month?");
speak("switch.aiff", "Find me a cheaper electricity contract and set up the switch.");
speak("fi.aiff", "Paljonko käytin ravintoloihin viime kuussa?", "Satu");
speak("sv.aiff", "Hur mycket spenderade jag på restauranger förra månaden?", "Alva");
ff("-i", "en.aiff", "-c:a", "aac", "-b:a", "64k", "en.m4a"); // iPhone Safari, and the iOS app
ff("-i", "en.aiff", "-c:a", "libopus", "-b:a", "32k", "en.webm"); // Chrome and Android
ff("-i", "en.aiff", "-c:a", "libopus", "-b:a", "32k", "en.ogg"); // Firefox
ff("-i", "en.aiff", "-ar", "16000", "-ac", "1", "en.wav");
ff("-i", "en.aiff", "-c:a", "libmp3lame", "-b:a", "64k", "en.mp3");
ff("-i", "amount.aiff", "-c:a", "aac", "-b:a", "64k", "amount.m4a");
ff("-i", "switch.aiff", "-c:a", "libopus", "-b:a", "32k", "switch.webm");
ff("-i", "fi.aiff", "-c:a", "aac", "-b:a", "64k", "fi.m4a");
ff("-i", "sv.aiff", "-c:a", "libopus", "-b:a", "32k", "sv.webm");
ff("-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-t", "2", "-c:a", "aac", "silence.m4a");
ff("-f", "lavfi", "-i", "anoisesrc=d=2:c=pink:a=0.2", "-c:a", "aac", "noise.m4a");
ff("-i", "en.aiff", "-t", "0.25", "-c:a", "aac", "short.m4a");
ff("-f", "lavfi", "-i", "sine=frequency=300:duration=45", "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", "big.wav"); // 4.3 MB: over our limit, under the host's
writeFileSync(dir + "notaudio.m4a", "this is not audio at all");
const file = (name) => readFileSync(dir + name);
let visitor = 0;
const headers = () => ({ "x-forwarded-for": `198.51.100.${++visitor % 250}` });
const rows = [];
const say = (group, name, ok, detail) => { rows.push({ group, name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  [${group}] ${name}: ${detail}`); };

async function stt(name, type, extra = {}) {
  const form = new FormData();
  form.set("audio", new Blob([file(name)], { type }), extra.fileName ?? name);
  if (extra.language) form.set("language", extra.language);
  const started = performance.now();
  const response = await fetch(`${BASE}/api/voice/stt`, { method: "POST", headers: headers(), body: form });
  const text = await response.text();
  let body; try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 120) }; }
  return { status: response.status, ms: Math.round(performance.now() - started), body };
}

async function turn(name, type, customerId = "CUST04974", extra = {}) {
  const form = new FormData();
  form.set("audio", new Blob([file(name)], { type }), extra.fileName ?? name);
  form.set("customerId", customerId);
  if (extra.language) form.set("language", extra.language);
  const started = performance.now();
  const response = await fetch(`${BASE}/api/voice/turn`, { method: "POST", headers: headers(), body: form });
  const out = { status: response.status, events: {}, transcript: null, language: null, done: null, error: null, firstSentenceMs: null, sttMs: null, totalMs: null, contentType: response.headers.get("content-type") };
  if (!response.ok || !out.contentType?.startsWith("text/event-stream")) { out.raw = (await response.text()).slice(0, 200); out.totalMs = Math.round(performance.now() - started); return out; }
  let buffer = "";
  const reader = response.body.getReader(); const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n"); buffer = parts.pop();
    for (const part of parts) {
      if (!part.startsWith("data:")) continue;
      const e = JSON.parse(part.slice(5));
      out.events[e.type] = (out.events[e.type] ?? 0) + 1;
      if (e.type === "transcript") { out.transcript = e.text; out.language = e.language; out.sttMs = e.tookMs; }
      if (e.type === "sentence" && out.firstSentenceMs === null) out.firstSentenceMs = Math.round(performance.now() - started);
      if (e.type === "done") { out.done = e.text; out.timings = e.timings; }
      if (e.type === "error") out.error = e.message;
    }
  }
  out.totalMs = Math.round(performance.now() - started);
  return out;
}

if (only.includes("stt")) {
  const formats = [["en.m4a", "audio/mp4"], ["en.m4a", "audio/mp4;codecs=mp4a.40.2"], ["en.webm", "audio/webm;codecs=opus"], ["en.webm", "audio/webm"], ["en.ogg", "audio/ogg;codecs=opus"], ["en.wav", "audio/wav"], ["en.mp3", "audio/mpeg"], ["en.m4a", ""], ["en.m4a", "application/octet-stream"]];
  for (const [name, type] of formats) {
    const r = await stt(name, type);
    const heard = r.body.text ?? "";
    say("stt", `${name} as "${type || "(no type)"}"`, r.status === 200 && /eating out/i.test(heard) && /last month/i.test(heard), `${r.status} in ${r.ms} ms, heard "${heard || JSON.stringify(r.body).slice(0, 120)}" (${r.body.language ?? "?"})`);
  }
  const amount = await stt("amount.m4a", "audio/mp4");
  say("stt", "an amount in words arrives as digits", amount.status === 200 && /300/.test(amount.body.text ?? ""), `heard "${amount.body.text}"`);
  for (const [name, type, code, word] of [["fi.m4a", "audio/mp4", "fi", /ravintol/i], ["sv.webm", "audio/webm;codecs=opus", "sv", /restaurang/i]]) {
    const auto = await stt(name, type);
    say("stt", `${code}: language detected on its own`, auto.status === 200 && word.test(auto.body.text ?? "") && auto.body.language === code, `${auto.ms} ms, heard "${auto.body.text}" (${auto.body.language}, ${auto.body.languageProbability})`);
    const chosen = await stt(name, type, { language: code });
    say("stt", `${code}: language chosen by the customer`, chosen.status === 200 && word.test(chosen.body.text ?? "") && chosen.body.language === code, `${chosen.ms} ms, heard "${chosen.body.text}"`);
  }
}

if (only.includes("turn")) {
  for (const [name, type, customer, expect] of [["en.m4a", "audio/mp4", "CUST04974", /\d/], ["en.webm", "audio/webm;codecs=opus", "CUST04414", /\d/], ["amount.m4a", "audio/mp4", "CUST04414", /afford|bike|300/i], ["switch.webm", "audio/webm;codecs=opus", "CUST04974", /./]]) {
    const r = await turn(name, type, customer);
    const ok = r.status === 200 && !r.error && !!r.done && expect.test(r.done) && r.events.transcript === 1 && r.events.done === 1;
    say("turn", `${name} for ${customer}`, ok, `heard "${r.transcript}" | stt ${r.sttMs} ms, first sentence ${r.firstSentenceMs} ms, total ${r.totalMs} ms | ${r.error ? "ERROR " + r.error : `"${(r.done ?? "").slice(0, 110)}"`} | events ${Object.entries(r.events).filter(([k]) => k !== "delta").map(([k, v]) => `${k}×${v}`).join(" ")}`);
  }
  for (const [name, type, code] of [["fi.m4a", "audio/mp4", "fi"], ["sv.webm", "audio/webm;codecs=opus", "sv"]]) {
    const r = await turn(name, type, "CUST04974");
    say("turn", `${code}: answered in the language spoken`, r.status === 200 && !r.error && !!r.done && r.language === code, `heard "${r.transcript}" (${r.language}) | first sentence ${r.firstSentenceMs} ms | "${(r.done ?? r.error ?? "").slice(0, 130)}"`);
  }
}

if (only.includes("edge")) {
  const quiet = await turn("silence.m4a", "audio/mp4");
  say("edge", "two seconds of silence", quiet.status === 200 && !!quiet.error && !quiet.done, `transcript "${quiet.transcript}" → "${quiet.error ?? quiet.done ?? quiet.raw}"`);
  const noise = await turn("noise.m4a", "audio/mp4");
  say("edge", "two seconds of noise", noise.status === 200 && (!!noise.error || !!noise.done), `transcript "${noise.transcript}" → "${(noise.error ?? noise.done ?? noise.raw ?? "").slice(0, 120)}"`);
  const short = await turn("short.m4a", "audio/mp4");
  say("edge", "a quarter-second clip", short.status === 200 && (!!short.error || !!short.done), `transcript "${short.transcript}" → "${(short.error ?? short.done ?? short.raw ?? "").slice(0, 120)}"`);
  const junk = await turn("notaudio.m4a", "audio/mp4");
  say("edge", "a file that is not audio", junk.status === 200 ? !!junk.error && !/\{|\bHTTP\b|stack|undefined/i.test(junk.error) : junk.status === 400, `${junk.status} → "${(junk.error ?? junk.raw ?? "").slice(0, 150)}"`);
  const big = await turn("big.wav", "audio/wav");
  say("edge", "a 4.3 MB recording gets our own sentence, not the host's error page", big.status === 413 && /"error"/.test(big.raw ?? "") && /too long/i.test(big.raw ?? ""), `${big.status} ${big.contentType} → "${(big.error ?? big.done ?? big.raw ?? "").slice(0, 150)}"`);
  const none = await fetch(`${BASE}/api/voice/turn`, { method: "POST", headers: headers(), body: (() => { const f = new FormData(); f.set("customerId", "CUST04974"); return f; })() });
  say("edge", "no recording attached", none.status === 400, `${none.status} ${(await none.text()).slice(0, 100)}`);
  const who = new FormData(); who.set("audio", new Blob([file("en.m4a")], { type: "audio/mp4" }), "q.m4a");
  const noCustomer = await fetch(`${BASE}/api/voice/turn`, { method: "POST", headers: headers(), body: who });
  say("edge", "no customer chosen", noCustomer.status === 400, `${noCustomer.status} ${(await noCustomer.text()).slice(0, 100)}`);
  const sttJunk = await stt("notaudio.m4a", "audio/mp4");
  say("edge", "speech to text on a file that is not audio", sttJunk.status >= 400 && typeof sttJunk.body.error === "string" && !/\{|stack|undefined/i.test(sttJunk.body.error), `${sttJunk.status} "${sttJunk.body.error ?? JSON.stringify(sttJunk.body).slice(0, 120)}"`);
}

if (only.includes("tts")) {
  const speak = async (body) => {
    const started = performance.now();
    const response = await fetch(`${BASE}/api/voice/tts`, { method: "POST", headers: { "Content-Type": "application/json", ...headers() }, body: JSON.stringify(body) });
    if (!response.ok) return { status: response.status, error: (await response.text()).slice(0, 140) };
    const reader = response.body.getReader(); let bytes = 0; let firstMs = null;
    for (;;) { const { done, value } = await reader.read(); if (done) break; if (firstMs === null) firstMs = Math.round(performance.now() - started); bytes += value.length; }
    return { status: 200, firstMs, totalMs: Math.round(performance.now() - started), bytes, type: response.headers.get("content-type"), cache: response.headers.get("x-sisu-cache") };
  };
  const stamp = Date.now() % 1000;
  for (const format of ["pcm", "mp3"]) {
    const r = await speak({ text: `You can safely spend about ${150 + stamp} euros this week.`, format });
    say("tts", `${format}, a fresh sentence`, r.status === 200 && r.bytes > 5000, `first audio ${r.firstMs} ms, done ${r.totalMs} ms, ${r.bytes} bytes, ${r.type}`);
  }
  const again = await speak({ text: `You can safely spend about ${150 + stamp} euros this week.`, format: "pcm" });
  say("tts", "the same sentence again comes from the cache", again.status === 200 && again.bytes > 5000, `first audio ${again.firstMs} ms, cache header ${again.cache}`);
  const fi = await speak({ text: "Voit käyttää turvallisesti noin 164 euroa tällä viikolla.", format: "mp3", language: "fi" });
  say("tts", "Finnish", fi.status === 200 && fi.bytes > 5000, `first audio ${fi.firstMs} ms, ${fi.bytes} bytes`);
  const burst = await Promise.all([1, 2, 3, 4, 5].map((n) => speak({ text: `Sentence number ${n} of a longer answer, ${stamp}.`, format: "pcm" })));
  say("tts", "five sentences asked for at once (a whole answer)", burst.every((r) => r.status === 200 && r.bytes > 3000), burst.map((r) => (r.status === 200 ? `${r.totalMs}ms` : `${r.status} ${r.error}`)).join(", "));
  const long = await speak({ text: "word ".repeat(140), format: "mp3" });
  say("tts", "text over the 600 character limit", long.status === 400 || long.status === 413, `${long.status} ${long.error ?? ""}`);
  const empty = await speak({ text: "   ", format: "mp3" });
  say("tts", "empty text", empty.status === 400, `${empty.status} ${empty.error ?? ""}`);
  const options = await (await fetch(`${BASE}/api/voice/tts`, { headers: headers() })).json();
  say("tts", "voice options", Array.isArray(options.languages) && options.languages.length > 5, `${options.languages?.length} languages`);
}

const failed = rows.filter((r) => !r.ok);
console.log(`\n${rows.length - failed.length} of ${rows.length} voice checks passed.`);
for (const f of failed) console.log(`  FAILED: [${f.group}] ${f.name}`);
