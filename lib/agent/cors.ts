// Lets a web page on another address call Sisu's API (a frontend hosted somewhere else than this server).
// Off by default: pages served by this server and native apps need none of it.
// SISU_CORS_ORIGINS names who may call: "*" for anyone, or a comma-separated list of origins
// (https://sisu.example.com,http://localhost:5173).
//
// Cookies are deliberately not part of this. iPhones block cookies between two different sites, so a page on
// another address keeps its visitor session by sending the X-Sisu-Session header it was given (lib/agent/visitor.ts).

const ALLOWED_HEADERS = "Content-Type, X-Sisu-Session, X-Sisu-Reset-Token";
const ALLOWED_METHODS = "GET, POST, DELETE, OPTIONS";

// The headers to add for a request from `origin`, or null when that origin may not call (or CORS is off).
export function corsHeaders(origin: string | null, setting: string | undefined = process.env.SISU_CORS_ORIGINS): Record<string, string> | null {
  const allowed = (setting ?? "")
    .split(",")
    .map((entry) => entry.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  if (!origin || allowed.length === 0) return null;
  const anyone = allowed.includes("*");
  if (!anyone && !allowed.includes(origin.replace(/\/+$/, ""))) return null;
  return {
    "Access-Control-Allow-Origin": anyone ? "*" : origin,
    "Access-Control-Allow-Methods": ALLOWED_METHODS,
    "Access-Control-Allow-Headers": ALLOWED_HEADERS,
    "Access-Control-Expose-Headers": "X-Sisu-Session",
    "Access-Control-Max-Age": "600",
    ...(anyone ? {} : { Vary: "Origin" }),
  };
}
