// Hosting: every visitor has their own state, and the state can live in Supabase instead of a file.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { AINO, freshState, stubFetch } from "./helpers";
import { POST as prepare } from "@/app/api/actions/prepare/route";
import { GET as listRoute } from "@/app/api/actions/route";
import { POST as reset } from "@/app/api/demo/reset/route";
import { GET as health } from "@/app/api/health/route";
import { listActions, saveDraft } from "@/lib/actions";
import { buildTransferDraft } from "@/lib/actions/drafts";
import { corsHeaders } from "@/lib/agent/cors";
import { allowRequest, eventStream } from "@/lib/agent/http";
import { SESSION_COOKIE, withVisitor } from "@/lib/agent/visitor";
import { remember } from "@/lib/memory";
import { auditFor } from "@/lib/store/audit";
import { SHARED, currentSession, inSession, isSessionId, newSessionId } from "@/lib/store/session";
import { type SisuState, forgetStoredState, openSession, readState, settleSession, storeConfig, storeInfo } from "@/lib/store/state";
import type { ActionList, AgentAction, HealthReport } from "@/lib/types";

const STORE_ENV = ["SISU_STORE", "SISU_STORE_TOKEN", "SISU_SESSIONS", "SUPABASE_URL", "SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_ANON_KEY", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SISU_RESET_TOKEN"];
const saved = { ...process.env };
function restoreEnv(): void {
  for (const key of [...STORE_ENV, "NODE_ENV"]) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
}

let caller = 0;
const request = (path: string, options: { body?: unknown; session?: string; cookie?: string; address?: string } = {}) =>
  new Request(`https://sisu.test${path}`, {
    method: options.body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      "x-forwarded-for": options.address ?? `198.51.100.${++caller % 250}`,
      ...(options.session ? { "x-sisu-session": options.session } : {}),
      ...(options.cookie ? { cookie: `theme=dark; ${SESSION_COOKIE}=${options.cookie}` } : {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
const transfer = (amountEur = 25) => ({ customerId: AINO, kind: "one_off_transfer", amountEur, destination: "savings" });
const actionsOf = async (response: Response) => ((await response.json()) as ActionList).actions;
const cookieOf = (response: Response) => /sisu_session=([A-Za-z0-9_-]+)/.exec(response.headers.get("set-cookie") ?? "")?.[1] ?? null;

function addTransfer(amountEur = 25): AgentAction {
  const draft = buildTransferDraft(AINO, amountEur, { preparedBy: "user" });
  assert.ok(draft.ok);
  const result = saveDraft(AINO, draft.draft);
  assert.ok(result.ok);
  return result.action;
}

describe("hosting: every visitor has their own state", () => {
  beforeEach(() => {
    restoreEnv();
    forgetStoredState();
    freshState();
  });
  afterEach(restoreEnv);

  it("without a session everything is the one shared state, as on the booth laptop", () => {
    assert.equal(currentSession(), SHARED);
    assert.deepEqual(storeConfig(), { kind: "file", remote: null, perVisitor: false });
    addTransfer();
    assert.equal(listActions(AINO).length, 1);
  });

  it("two visitors never see each other's actions, memory or audit log", () => {
    const [anna, ben] = [newSessionId(), newSessionId()];
    inSession(anna, () => {
      addTransfer(25);
      remember(AINO, { kind: "bill_name", key: "utilities-1", value: "Helen", billType: "electricity", source: "user-confirmed-in-app" });
    });
    inSession(ben, () => {
      assert.equal(listActions(AINO).length, 0);
      assert.equal(readState().memory[AINO], undefined);
      assert.equal(auditFor(AINO).events.length, 0);
      addTransfer(40);
      addTransfer(60);
    });
    assert.equal(inSession(anna, () => listActions(AINO).length), 1);
    assert.equal(inSession(ben, () => listActions(AINO).length), 2);
    assert.equal(listActions(AINO).length, 0, "the shared state is untouched");
    assert.ok(inSession(anna, () => auditFor(AINO).chainValid) && inSession(ben, () => auditFor(AINO).chainValid));
  });

  it("a visitor's state survives a restart of the server", () => {
    const anna = newSessionId();
    const action = inSession(anna, () => addTransfer());
    forgetStoredState(); // a new process: the next read comes from disk
    assert.deepEqual(inSession(anna, () => listActions(AINO).map((a) => a.id)), [action.id]);
  });

  it("session ids are long and random, and anything else is refused", () => {
    assert.ok(isSessionId(newSessionId()));
    assert.notEqual(newSessionId(), newSessionId());
    for (const bad of ["", "short", "../../etc/passwd", "a".repeat(65), "has space 0123456789", null, undefined, 42]) assert.equal(isSessionId(bad), false, String(bad));
  });

  it("on the booth laptop a leftover cookie does not move a browser off the shared state", async () => {
    const response = await prepare(request("/api/actions/prepare", { body: transfer(), cookie: newSessionId() }));
    assert.equal(response.status, 201);
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(response.headers.get("x-sisu-session"), null);
    assert.equal(listActions(AINO).length, 1, "it went to the shared state");
  });

  it("a client that names its session in the X-Sisu-Session header gets its own state anywhere", async () => {
    const mine = newSessionId();
    const response = await prepare(request("/api/actions/prepare", { body: transfer(), session: mine }));
    assert.equal(response.status, 201);
    assert.equal(response.headers.get("x-sisu-session"), mine);
    assert.equal((await actionsOf(await listRoute(request(`/api/actions?customerId=${AINO}`, { session: mine })))).length, 1);
    assert.equal((await actionsOf(await listRoute(request(`/api/actions?customerId=${AINO}`, { session: newSessionId() })))).length, 0);
    assert.equal((await actionsOf(await listRoute(request(`/api/actions?customerId=${AINO}`)))).length, 0);
  });

  it("where visitors are kept apart, the first request hands out a session as a cookie and a header", async () => {
    process.env.SISU_SESSIONS = "visitor";
    const first = await prepare(request("/api/actions/prepare", { body: transfer() }));
    const session = cookieOf(first);
    assert.ok(isSessionId(session), "a session cookie was set");
    assert.equal(first.headers.get("x-sisu-session"), session);
    assert.match(first.headers.get("set-cookie") ?? "", /HttpOnly; SameSite=Lax; Secure$/);
    assert.equal(first.status, 201);

    const again = await listRoute(request(`/api/actions?customerId=${AINO}`, { cookie: session! }));
    assert.equal(again.headers.get("set-cookie"), null, "the cookie is handed out once");
    assert.equal((await actionsOf(again)).length, 1, "the same browser sees what it prepared");

    const stranger = await listRoute(request(`/api/actions?customerId=${AINO}`));
    assert.notEqual(cookieOf(stranger), session);
    assert.equal((await actionsOf(stranger)).length, 0, "another phone starts empty");
  });

  it("an answer that is still streaming keeps working for the visitor who asked", async () => {
    const mine = newSessionId();
    const seen: string[] = [];
    async function* answer() {
      seen.push(currentSession());
      yield { type: "delta", text: "one" };
      await new Promise((resolve) => setTimeout(resolve, 5));
      addTransfer(); // what a tool does in the middle of an answer
      seen.push(currentSession());
      yield { type: "delta", text: "two" };
    }
    const route = withVisitor(async () => eventStream(answer()));
    const response = await route(request("/api/agent/query", { body: {}, session: mine }));
    assert.equal(currentSession(), SHARED, "the test itself reads the stream outside any session");
    assert.equal((await response.text()).split("\n\n").filter(Boolean).length, 2);
    assert.deepEqual(seen, [mine, mine]);
    assert.equal(inSession(mine, () => listActions(AINO).length), 1);
    assert.equal(listActions(AINO).length, 0, "nothing leaked into the shared state");
  });

  it("start over clears only the visitor's own state, and needs no token on a deployed site", async () => {
    Object.assign(process.env, { SISU_SESSIONS: "visitor", NODE_ENV: "production" });
    const [anna, ben] = [newSessionId(), newSessionId()];
    inSession(anna, () => addTransfer());
    inSession(ben, () => addTransfer());
    const response = await reset(request("/api/demo/reset", { body: {}, cookie: anna }));
    assert.equal(response.status, 200);
    assert.equal(inSession(anna, () => listActions(AINO).length), 0);
    assert.equal(inSession(ben, () => listActions(AINO).length), 1, "the other visitor keeps theirs");
  });

  it("wiping the one shared state on a deployed site still needs the token", async () => {
    Object.assign(process.env, { NODE_ENV: "production", SISU_RESET_TOKEN: "booth-token" });
    addTransfer();
    assert.equal((await reset(request("/api/demo/reset", { body: {} }))).status, 403);
    assert.equal(listActions(AINO).length, 1);
  });

  it("a room full of phones on one Wi-Fi address: each visitor gets the full ceiling", () => {
    const venue = "203.0.113.77";
    const ask = (session: string) => inSession(session, () => allowRequest(request("/api/agent/query", { address: venue }), "crowd-test", 3));
    const [anna, ben] = [newSessionId(), newSessionId()];
    assert.deepEqual([ask(anna), ask(anna), ask(anna), ask(anna)], [true, true, true, false], "one visitor is held to the ceiling");
    assert.deepEqual([ask(ben), ask(ben), ask(ben)], [true, true, true], "the next visitor is not slowed down by the first");
    // 3 a minute each, 24 a minute for the whole address: the ninth visitor's first request is the 25th from this address
    for (let visitor = 0; visitor < 6; visitor += 1) {
      const session = newSessionId();
      assert.deepEqual([ask(session), ask(session), ask(session)], [true, true, true]);
    }
    assert.equal(ask(newSessionId()), false, "the address as a whole has a ceiling too");
  });
});

// A stand-in for the two database functions in deploy/supabase/sisu_sessions.sql, with the same rules.
function fakeSupabase() {
  const rows = new Map<string, { state: SisuState; version: number }>();
  const calls: string[] = [];
  let down = false;
  const restore = stubFetch(async (url, init) => {
    const name = url.split("/rpc/")[1] ?? "";
    calls.push(name);
    if (down) throw new TypeError("fetch failed");
    assert.equal(new Headers(init?.headers).get("apikey"), "test-key");
    if (process.env.SISU_STORE_TOKEN && new Headers(init?.headers).get("x-sisu-store-token") !== process.env.SISU_STORE_TOKEN) return Response.json({ code: "42501", message: "sisu: this call needs the server's store token" }, { status: 403 });
    const body = JSON.parse(String(init?.body)) as { p_session: string; p_state?: SisuState; p_expected?: number };
    const row = rows.get(body.p_session);
    if (name === "sisu_load") return Response.json(row ? structuredClone(row) : null);
    if (row ? row.version !== body.p_expected : false) return Response.json({ ok: false, ...structuredClone(row) });
    const version = (row?.version ?? 0) + 1;
    rows.set(body.p_session, { state: structuredClone(body.p_state!), version });
    return Response.json({ ok: true, version });
  });
  return { rows, calls, restore, setDown: (value: boolean) => (down = value) };
}

describe("hosting: state in Supabase", () => {
  let supabase = fakeSupabase();
  beforeEach(() => {
    restoreEnv();
    forgetStoredState();
    freshState();
    Object.assign(process.env, { SUPABASE_URL: "https://project.supabase.test/", SUPABASE_PUBLISHABLE_KEY: "test-key" });
    supabase = fakeSupabase();
  });
  afterEach(() => {
    supabase.restore();
    restoreEnv();
    forgetStoredState();
  });

  it("the address and a key switch it on, with a session for every visitor; SISU_STORE=file switches it off", () => {
    assert.deepEqual(storeConfig(), { kind: "supabase", remote: { url: "https://project.supabase.test/", key: "test-key" }, perVisitor: true });
    process.env.SUPABASE_SECRET_KEY = "secret-key";
    assert.equal(storeConfig().remote?.key, "secret-key", "the private key is preferred when both are set");
    process.env.SISU_SESSIONS = "shared";
    assert.equal(storeConfig().perVisitor, false);
    process.env.SISU_STORE = "file";
    assert.deepEqual(storeConfig(), { kind: "file", remote: null, perVisitor: false });
  });

  it("what one server instance stores, another instance reads", async () => {
    const anna = newSessionId();
    await openSession(anna);
    const action = inSession(anna, () => addTransfer());
    await settleSession(anna);
    assert.equal(supabase.rows.get(anna)?.state.actions[0].id, action.id);

    forgetStoredState(); // another instance: nothing in memory
    await openSession(anna);
    assert.deepEqual(inSession(anna, () => listActions(AINO).map((a) => a.id)), [action.id]);
    assert.ok(inSession(anna, () => auditFor(AINO).chainValid));
  });

  it("two instances changing the same visitor's state both keep their change", async () => {
    const anna = newSessionId();
    await openSession(anna);
    const first = inSession(anna, () => addTransfer(25));
    await settleSession(anna);

    // Another instance approves nothing but adds its own transfer and saves first.
    const theirs = structuredClone(supabase.rows.get(anna)!);
    const other: AgentAction = { ...theirs.state.actions[0], id: "from-the-other-instance" };
    supabase.rows.set(anna, { state: { ...theirs.state, actions: [...theirs.state.actions, other] }, version: theirs.version + 1 });

    const second = inSession(anna, () => addTransfer(40)); // based on a state that is now out of date
    await settleSession(anna);
    const stored = supabase.rows.get(anna)!.state.actions.map((a) => a.id);
    assert.deepEqual(stored, [first.id, "from-the-other-instance", second.id], "nobody's change was overwritten");
    assert.deepEqual(inSession(anna, () => readState().actions.map((a) => a.id)), stored, "and this instance now sees all of it");
  });

  it("a route answers only after the change is stored, and the visitor is told which session they have", async () => {
    const response = await prepare(request("/api/actions/prepare", { body: transfer() }));
    assert.equal(response.status, 201);
    const session = cookieOf(response)!;
    assert.equal(supabase.rows.get(session)?.state.actions.length, 1, "stored before the response came back");
    assert.deepEqual(supabase.calls, ["sisu_load", "sisu_save"]);
    forgetStoredState();
    assert.equal((await actionsOf(await listRoute(request(`/api/actions?customerId=${AINO}`, { cookie: session })))).length, 1);
  });

  it("a stream stores the visitor's state before it closes", async () => {
    const mine = newSessionId();
    async function* answer() {
      yield { type: "delta", text: "working" };
      addTransfer();
      yield { type: "delta", text: "done" };
    }
    const response = await withVisitor(async () => eventStream(answer()))(request("/api/agent/query", { body: {}, session: mine }));
    await response.text();
    assert.equal(supabase.rows.get(mine)?.state.actions.length, 1);
  });

  it("if Supabase cannot be reached the visitor keeps working, and it is stored once it is back", async () => {
    const anna = newSessionId();
    supabase.setDown(true);
    await openSession(anna);
    const action = inSession(anna, () => addTransfer());
    await settleSession(anna);
    assert.equal(inSession(anna, () => listActions(AINO).length), 1, "still there, from memory");
    assert.equal(inSession(anna, () => storeInfo().persistent), false, "and the health page says it is not stored");
    assert.equal(supabase.rows.size, 0);

    supabase.setDown(false);
    await settleSession(anna);
    assert.equal(supabase.rows.get(anna)?.state.actions[0].id, action.id);
    assert.equal(inSession(anna, () => storeInfo().persistent), true);
  });

  it("the server's store token goes with every call, so the public key alone is not enough", async () => {
    process.env.SISU_STORE_TOKEN = "only-the-server-knows";
    assert.equal(storeConfig().remote?.token, "only-the-server-knows");
    const anna = newSessionId();
    await openSession(anna);
    inSession(anna, () => addTransfer());
    await settleSession(anna);
    assert.equal(supabase.rows.get(anna)?.state.actions.length, 1, "stored, because the token was sent");
    assert.equal(inSession(anna, () => storeInfo().persistent), true);
  });

  it("the health page says where the state lives", async () => {
    const report = (await (await health(request("/api/health"))).json()) as HealthReport;
    assert.deepEqual(report.store, { persistent: true, path: null, kind: "supabase", perVisitor: true });
  });
});

describe("hosting: a frontend on another address", () => {
  it("is not let in unless SISU_CORS_ORIGINS names it", () => {
    assert.equal(corsHeaders("https://elsewhere.example", undefined), null);
    assert.equal(corsHeaders("https://elsewhere.example", ""), null);
    assert.equal(corsHeaders("https://elsewhere.example", "https://sisu.example"), null);
    assert.equal(corsHeaders(null, "*"), null, "a request from this server's own pages needs nothing");
  });

  it("a named origin may call, send its session header and read the one it is given", () => {
    const headers = corsHeaders("https://sisu.example", "https://other.example, https://sisu.example/");
    assert.equal(headers?.["Access-Control-Allow-Origin"], "https://sisu.example");
    assert.equal(headers?.Vary, "Origin");
    assert.match(headers?.["Access-Control-Allow-Headers"] ?? "", /X-Sisu-Session/);
    assert.equal(headers?.["Access-Control-Expose-Headers"], "X-Sisu-Session");
    assert.equal(headers?.["Access-Control-Allow-Credentials"], undefined, "no cookies across sites: iPhones block them");
  });

  it("a star lets any page call", () => {
    assert.equal(corsHeaders("https://anything.example", "*")?.["Access-Control-Allow-Origin"], "*");
  });
});
