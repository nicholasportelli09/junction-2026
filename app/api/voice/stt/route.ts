import { TOO_MANY, allowRequest, jsonError } from "@/lib/agent/http";
import { MAX_AUDIO_BYTES, transcribe } from "@/lib/agent/speech";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!allowRequest(request, "stt", 30)) return TOO_MANY();
  const form = await request.formData().catch(() => null);
  const audio = form?.get("audio");
  if (!(audio instanceof Blob) || audio.size === 0) return jsonError("No recording was received.", 400);
  if (audio.size > MAX_AUDIO_BYTES) return jsonError("That recording is too long. Keep it under a minute, or type your question.", 413);
  try {
    const language = form?.get("language");
    return Response.json(await transcribe(audio, typeof language === "string" ? language : undefined));
  } catch (error) {
    return jsonError((error as Error).message, 502);
  }
}
