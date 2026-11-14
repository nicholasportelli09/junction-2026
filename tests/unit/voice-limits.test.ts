// Voice uploads: a recording that is too long gets a sentence a person can read, never the host's own error page.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AINO } from "./helpers";
import { POST as stt } from "@/app/api/voice/stt/route";
import { POST as turn } from "@/app/api/voice/turn/route";
import { MAX_AUDIO_BYTES } from "@/lib/agent/speech";

// The host refuses a request body over 4.5 MB before our code runs, and answers in plain text.
const HOST_BODY_LIMIT = 4.5 * 1024 * 1024;
let caller = 0;
function upload(path: string, bytes: number, fields: Record<string, string> = {}): Request {
  const form = new FormData();
  form.set("audio", new Blob([new Uint8Array(bytes)], { type: "audio/mp4" }), "speech.m4a");
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return new Request(`http://test.local${path}`, { method: "POST", headers: { "x-forwarded-for": `198.51.100.${++caller % 250}` }, body: form });
}

describe("voice: recordings that are too long", () => {
  it("our own limit sits under the host's, with room for the rest of the form", () => {
    assert.ok(MAX_AUDIO_BYTES + 64 * 1024 < HOST_BODY_LIMIT, "a recording at our limit must still reach our code");
  });

  it("a recording over the limit gets a readable sentence from both voice routes", async () => {
    for (const [name, response] of [
      ["stt", await stt(upload("/api/voice/stt", MAX_AUDIO_BYTES + 1))],
      ["turn", await turn(upload("/api/voice/turn", MAX_AUDIO_BYTES + 1, { customerId: AINO }))],
    ] as const) {
      assert.equal(response.status, 413, name);
      assert.match(response.headers.get("content-type") ?? "", /application\/json/, name);
      assert.match(((await response.json()) as { error: string }).error, /too long.*under a minute/i, name);
    }
  });

  it("a recording just under the limit is taken", async () => {
    const response = await stt(upload("/api/voice/stt", MAX_AUDIO_BYTES - 1024));
    assert.equal(response.status, 200);
    assert.equal(typeof ((await response.json()) as { text: string }).text, "string");
  });

  it("an empty recording and a missing one are refused with a sentence", async () => {
    assert.equal((await turn(upload("/api/voice/turn", 0, { customerId: AINO }))).status, 400);
    const none = new Request("http://test.local/api/voice/turn", { method: "POST", headers: { "x-forwarded-for": "198.51.100.251" }, body: (() => { const form = new FormData(); form.set("customerId", AINO); return form; })() });
    const response = await turn(none);
    assert.equal(response.status, 400);
    assert.match(((await response.json()) as { error: string }).error, /No recording/);
  });
});
