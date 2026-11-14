// Gives every request its visitor. Wrap a route that reads or writes Sisu's state (actions, memory, the audit
// log) in withVisitor and it sees that visitor's state, wherever it is stored.
//
// How a visitor is recognised, in this order:
//   1. the X-Sisu-Session request header  (a native app, or a web page on another address)
//   2. the sisu_session cookie            (a web page on this address, or anything with a cookie jar: nothing to do)
//   3. neither: when visitors are kept apart, a new session is made, set as the cookie and returned in the
//      X-Sisu-Session response header.
// When everyone shares one state (the booth laptop), only the header is honoured, so a leftover cookie cannot
// quietly move one browser off the shared state.
import { SHARED, inSession, isSessionId, newSessionId } from "@/lib/store/session";
import { openSession, settleSession, storeConfig } from "@/lib/store/state";

export const SESSION_HEADER = "x-sisu-session";
export const SESSION_COOKIE = "sisu_session";
const COOKIE_DAYS = 2;

export type Visitor = { sessionId: string; isNew: boolean };

function cookieValue(request: Request, name: string): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

export function visitorOf(request: Request | undefined): Visitor {
  const fromHeader = request?.headers.get(SESSION_HEADER)?.trim();
  if (isSessionId(fromHeader)) return { sessionId: fromHeader, isNew: false };
  if (!request || !storeConfig().perVisitor) return { sessionId: SHARED, isNew: false };
  const fromCookie = cookieValue(request, SESSION_COOKIE);
  if (isSessionId(fromCookie)) return { sessionId: fromCookie, isNew: false };
  return { sessionId: newSessionId(), isNew: true };
}

const isStream = (response: Response): boolean => response.headers.get("content-type")?.startsWith("text/event-stream") ?? false;

// Tells the client which session it is in. The cookie covers browsers on this address; the header covers the rest.
function withSessionHeaders(request: Request | undefined, response: Response, visitor: Visitor): Response {
  if (visitor.sessionId === SHARED) return response;
  const headers = new Headers(response.headers);
  headers.set("X-Sisu-Session", visitor.sessionId);
  if (visitor.isNew) {
    const secure = request && new URL(request.url).protocol === "https:" ? "; Secure" : "";
    headers.append("Set-Cookie", `${SESSION_COOKIE}=${visitor.sessionId}; Path=/; Max-Age=${COOKIE_DAYS * 86_400}; HttpOnly; SameSite=Lax${secure}`);
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

type Handler<Rest extends unknown[]> = (request: Request, ...rest: Rest) => Response | Promise<Response>;

// The route runs as the visitor: the state is fetched first, and stored before the answer leaves.
// A stream answers before its work is done, so eventStream (lib/agent/http.ts) does the storing when it ends.
export function withVisitor<Rest extends unknown[]>(handler: Handler<Rest>): (request?: Request, ...rest: Rest) => Promise<Response> {
  return async (request, ...rest) => {
    const visitor = visitorOf(request);
    await openSession(visitor.sessionId);
    const response = await inSession(visitor.sessionId, () => handler(request as Request, ...rest));
    if (!isStream(response)) await settleSession(visitor.sessionId);
    return withSessionHeaders(request, response, visitor);
  };
}
