// The app's team routes, through its own HTTP server: the Google login comes back
// to /oauth/callback and finishes only a login this app started; the team routes
// answer a JSON POST (the status alone also a GET) and never a token; the hub's own
// refusals come back with their code. A browser login that came back with an error
// shows in the status at once, starting again is a new login, and a login Access
// stopped refreshing is reported as ended, with which one to log in to again. The
// admin's Jev key goes to the hub, and no route hands it back. The owner opens
// folders and ChatGPT 기록 to a teammate, turns them off for now and on again, and
// the hub's record names what is open. A member's hub login goes on to the servers'
// in the same window, only while this computer has none, and one turned down there
// leaves the hub's in place.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

import { DEFAULT_TOOLS, gateStatePaths, readGateAccess } from "../scripts/gate-access.mjs";
import { fakeTeam, ISSUER_HOST } from "./fake-team.mjs";

const HUB = "team.example.com";
const SERVER = "mate.example.com";
let server;
let port;
let tmp;
let fake;
let realFetch;
const hubSeen = [];
const JEV_KEY = "ts-jev-key-for-tests-0123456789";
// The Jev key the stand-in hub keeps, as { key, setAt, setBy }, or null.
let jev = null;
// Whether the stand-in hub's directory says this person is an admin.
let meAdmin = true;
let meNickname = undefined;
// The servers the stand-in hub's directory lists, and who Access lets in to each app.
let teamServers = [];
const appPeople = { hub: null, servers: null };

async function send(pathname, { method = "GET", body, headers = {}, redirect = "follow" } = {}) {
  const response = await realFetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    redirect,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: response.status, text, json, location: response.headers.get("location") };
}

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "team-app-"));
  process.env.HONCHO_AGENT_BRIDGE_HOME = path.join(tmp, "home");
  process.env.HONCHO_AGENT_TEAM_AUTH = path.join(tmp, "home", "data", "state", "team-auth.json");
  fake = fakeTeam({
    people: appPeople,
    hosts: {
      [SERVER]: { app: "servers", handle: async () => Response.json({ ok: true }) },
      [HUB]: {
        app: "hub",
        handle: async (request, { email, url }) => {
          hubSeen.push({ method: request.method, path: url.pathname, email });
          if (url.pathname === "/api/me" && request.method === "GET") {
            return Response.json({ email, member: email === "me@example.com", admin: true, peer: null, team: { name: "예시 팀", host: HUB }, servers: [] });
          }
          if (url.pathname === "/api/me" && request.method === "POST") return Response.json({ peer: "me" });
          if (url.pathname === "/api/requests" && request.method === "POST") {
            return Response.json({ error: "own_server", detail: "That is your own server" }, { status: 400 });
          }
          if (url.pathname === "/api/admin/jev") {
            if (request.method === "PUT") {
              const { key } = await request.json();
              hubSeen.at(-1).key = key;
              if (key.length < 8) return Response.json({ error: "bad_request", detail: "key takes the Jev API key" }, { status: 400 });
              jev = { key, setAt: "2026-10-07T09:00:00.000Z", setBy: email };
              // A hub that says more than it should: the app passes on only the status.
              return Response.json({ set: true, setAt: jev.setAt, setBy: email, key });
            }
            if (request.method === "DELETE") jev = null;
            return Response.json({ set: Boolean(jev), setAt: jev?.setAt ?? null, setBy: jev?.setBy ?? null, ...(jev ? { key: jev.key } : {}) });
          }
          if (url.pathname === "/api/team" && request.method === "GET") {
            if (email !== "me@example.com") return Response.json({ error: "not_member", detail: `${email} is not on the team's roster` }, { status: 403 });
            return Response.json({
              team: { name: "예시 팀", host: HUB, zone: "example.com" },
              people: [{ email: "me@example.com", peer: "me", admin: meAdmin, nickname: meNickname, joined: true, servers: [] }],
              servers: teamServers,
            });
          }
          if (/^\/api\/requests\/r-[0-9a-f]{16}\/(decide|projects)$/.test(url.pathname) && request.method === "POST") {
            hubSeen.at(-1).body = await request.json();
            return Response.json({ request: { id: url.pathname.split("/")[3], status: "approved" } });
          }
          if (url.pathname.startsWith("/api/admin/people/") && request.method === "PUT") {
            const body = await request.json();
            hubSeen.at(-1).body = body;
            const email = decodeURIComponent(url.pathname.split("/").at(-1)).toLowerCase();
            if ("nickname" in body) return Response.json({ person: { email, nickname: body.nickname || null } });
            if (typeof body.admin !== "boolean") return Response.json({ error: "bad_request", detail: "admin is true or false" }, { status: 400 });
            return Response.json({ person: { email, admin: body.admin } });
          }
          return Response.json({ error: "not_found" }, { status: 404 });
        },
      },
    },
  });
  // The routes run in this process, so their requests to the team go to the stand-in.
  realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.url ?? String(input));
    return url.protocol === "https:" ? fake.fetch(input, init) : realFetch(input, init);
  };
  const { createUiServer } = await import("../scripts/ui.mjs");
  server = createUiServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
});

after(async () => {
  globalThis.fetch = realFetch;
  server?.closeAllConnections?.();
  await new Promise((resolve) => server?.close(resolve) ?? resolve());
  await fs.rm(tmp, { recursive: true, force: true });
});

test("a callback for a login this app never started does nothing", async () => {
  const answer = await send("/oauth/callback?state=made-up&code=stolen");
  assert.equal(answer.status, 400);
  assert.match(answer.text, /로그인하지 못했습니다/);
  assert.equal(await fs.stat(process.env.HONCHO_AGENT_TEAM_AUTH).then(() => true, () => false), false, "nothing was saved");
});

test("the hub login: started by a POST, finished by the browser coming back, then who this is", async () => {
  const started = await send("/api/team/login", { method: "POST", body: { kind: "hub", hub: HUB } });
  assert.equal(started.json.ok, true);
  const authorize = new URL(started.json.url);
  assert.equal(authorize.searchParams.get("redirect_uri"), `http://127.0.0.1:${port}/oauth/callback`);
  const back = new URL(fake.browserLogin(started.json.url));
  const done = await send(`${back.pathname}${back.search}`);
  assert.equal(done.status, 200);
  assert.match(done.text, /로그인됐습니다/);

  const status = await send("/api/team/status");
  assert.equal(status.json.hubLogin.signedIn, true);
  for (const secret of ["oauth:", "refresh-", "accessToken", "refreshToken"]) assert.equal(status.text.includes(secret), false, `${secret} must not reach the page`);

  const me = await send("/api/team/me", { method: "POST", body: { hub: HUB } });
  assert.equal(me.json.ok, true);
  assert.equal(me.json.member, true);
  assert.equal(me.json.peer, "me");
  const again = await send("/api/team/status");
  assert.equal(again.json.email, "me@example.com");
  assert.equal(again.json.peer, "me");
  assert.equal(again.json.team, "예시 팀");
});

test("a team route answers a JSON POST only, the status alone a GET too", async () => {
  assert.equal((await send("/api/team/requests")).status, 405);
  assert.equal((await send("/api/team/decide")).status, 405);
  assert.equal((await send("/api/team/status")).status, 200);
  // A form post from another page is refused before any route runs.
  assert.equal((await send("/api/team/request", { method: "POST", body: {}, headers: { "content-type": "text/plain" } })).status, 415);
});

test("the hub's own refusal comes back with its code", async () => {
  const refused = await send("/api/team/request", { method: "POST", body: { kind: "chat", server: "memory.example.com" } });
  assert.equal(refused.json.ok, false);
  assert.equal(refused.json.code, "own_server");
  assert.equal(refused.json.status, 400);
});

test("a callback that came back with an error shows in the status at once; starting again is a new login", async () => {
  const first = await send("/api/team/login", { method: "POST", body: { kind: "hub", hub: HUB } });
  assert.equal(first.json.ok, true);
  assert.deepEqual(first.json.logouts, [`https://${HUB}/cdn-cgi/access/logout`, "https://example-team.cloudflareaccess.com/cdn-cgi/access/logout"]);
  // Reloading the consent page: Access sends the browser back with an error.
  const state = new URL(first.json.url).searchParams.get("state");
  const back = await send(`/oauth/callback?state=${encodeURIComponent(state)}&error=invalid_request&error_description=${encodeURIComponent("Consent request is malformed")}`);
  assert.equal(back.status, 400);
  const status = await send("/api/team/status");
  const failed = status.json.failed.find((item) => item.id === first.json.id);
  assert.equal(failed?.error, "refused");
  assert.equal(failed?.detail, "Consent request is malformed");
  assert.equal(status.text.includes(state), false, "the state itself never reaches the page");

  // 브라우저 다시 열기: a new login, which the page then waits for, and which works.
  const second = await send("/api/team/login", { method: "POST", body: { kind: "hub", hub: HUB } });
  assert.notEqual(second.json.id, first.json.id);
  assert.notEqual(new URL(second.json.url).searchParams.get("state"), state);
  const done = new URL(fake.browserLogin(second.json.url));
  assert.equal((await send(`${done.pathname}${done.search}`)).status, 200);
  const after = await send("/api/team/status");
  assert.equal(after.json.hubLogin.signedIn, true);
  assert.equal(after.json.failed.some((item) => item.id === second.json.id), false);
});

test("a login Access stopped refreshing is reported as ended, and the routes say which login to do again", async () => {
  // The team switched Google logins: the refresh token is refused once the access token runs out.
  const file = process.env.HONCHO_AGENT_TEAM_AUTH;
  const auth = JSON.parse(await fs.readFile(file, "utf8"));
  auth.logins.hub.expiresAt = 0;
  await fs.writeFile(file, JSON.stringify(auth));
  fake.state.refresh.clear();

  const refused = await send("/api/team/directory", { method: "POST", body: {} });
  assert.equal(refused.json.ok, false);
  assert.equal(refused.json.code, "login_needed");
  assert.equal(refused.json.kind, "hub");
  assert.equal(refused.json.host, HUB);
  const status = await send("/api/team/status");
  assert.equal(status.json.hubLogin.signedIn, false);
  assert.equal(status.json.hubLogin.ended.email, "me@example.com");
  assert.equal(status.json.hubLogin.ended.host, HUB);
  // Every later call says the same, with the same login to do again.
  const again = await send("/api/team/requests", { method: "POST", body: {} });
  assert.deepEqual([again.json.code, again.json.kind, again.json.host], ["login_needed", "hub", HUB]);

  // 다시 로그인: the same browser login for the hub; the ended login is gone.
  const started = await send("/api/team/login", { method: "POST", body: { kind: "hub", hub: HUB } });
  const back = new URL(fake.browserLogin(started.json.url));
  await send(`${back.pathname}${back.search}`);
  const after = await send("/api/team/status");
  assert.equal(after.json.hubLogin.signedIn, true);
  assert.equal(after.json.hubLogin.ended, undefined);
});

test("the admin's Jev key goes to the hub, and no route hands it back", async () => {
  const none = await send("/api/team/admin/jev", { method: "POST", body: {} });
  assert.deepEqual(none.json, { ok: true, jev: { set: false, setAt: null, setBy: null } });

  const saved = await send("/api/team/admin/jev/set", { method: "POST", body: { key: `  ${JEV_KEY}  ` } });
  assert.deepEqual(saved.json, { ok: true, jev: { set: true, setAt: "2026-10-07T09:00:00.000Z", setBy: "me@example.com" } });
  assert.deepEqual(hubSeen.at(-1), { method: "PUT", path: "/api/admin/jev", email: "me@example.com", key: JEV_KEY }, "trimmed, to the hub alone");
  assert.equal(saved.text.includes(JEV_KEY), false);
  const status = await send("/api/team/admin/jev", { method: "POST", body: {} });
  assert.deepEqual(status.json, { ok: true, jev: { set: true, setAt: "2026-10-07T09:00:00.000Z", setBy: "me@example.com" } });
  assert.equal(status.text.includes(JEV_KEY), false, "not even when the hub sends it");

  // An empty key never leaves the app; one the hub turns down comes back with its code.
  const asked = hubSeen.length;
  const empty = await send("/api/team/admin/jev/set", { method: "POST", body: { key: "   " } });
  assert.equal(empty.json.ok, false);
  assert.equal(hubSeen.length, asked);
  const refused = await send("/api/team/admin/jev/set", { method: "POST", body: { key: "short" } });
  assert.deepEqual([refused.json.ok, refused.json.code, refused.json.status], [false, "bad_request", 400]);

  const cleared = await send("/api/team/admin/jev/clear", { method: "POST", body: {} });
  assert.deepEqual(cleared.json, { ok: true, jev: { set: false, setAt: null, setBy: null } });
  assert.equal(hubSeen.at(-1).method, "DELETE");

  for (const route of ["/api/team/admin/jev", "/api/team/admin/jev/set", "/api/team/admin/jev/clear"]) {
    assert.equal((await send(route)).status, 405, `${route} takes a JSON POST only`);
  }
});

test("an admin makes a teammate an admin or takes it away through the hub, and the directory keeps whether this person still is one", async () => {
  const made = await send("/api/team/admin/set-admin", { method: "POST", body: { email: "Bob@Example.com", admin: true } });
  assert.deepEqual(made.json, { ok: true, person: { email: "bob@example.com", admin: true } });
  assert.deepEqual(hubSeen.at(-1), { method: "PUT", path: "/api/admin/people/Bob%40Example.com", email: "me@example.com", body: { admin: true } });
  // admin goes as the page sent it, and the hub turns down anything but true or false.
  const odd = await send("/api/team/admin/set-admin", { method: "POST", body: { email: "bob@example.com", admin: "yes" } });
  assert.deepEqual([odd.json.ok, odd.json.code, odd.json.status], [false, "bad_request", 400]);
  assert.equal((await send("/api/team/admin/set-admin")).status, 405, "a JSON POST only");

  // A nickname goes trimmed, and an empty one takes it away.
  const named = await send("/api/team/admin/nickname", { method: "POST", body: { email: "bob@example.com", nickname: "  김밥 " } });
  assert.deepEqual(named.json, { ok: true, person: { email: "bob@example.com", nickname: "김밥" } });
  assert.deepEqual(hubSeen.at(-1).body, { nickname: "김밥" });
  await send("/api/team/admin/nickname", { method: "POST", body: { email: "bob@example.com" } });
  assert.deepEqual(hubSeen.at(-1).body, { nickname: "" });
  assert.equal((await send("/api/team/admin/nickname")).status, 405, "a JSON POST only");

  // Another admin took it away from this person: the next directory says so, and the status follows.
  assert.equal((await send("/api/team/status")).json.admin, true);
  meAdmin = false;
  assert.equal((await send("/api/team/directory", { method: "POST", body: {} })).json.ok, true);
  assert.equal((await send("/api/team/status")).json.admin, false);
  meAdmin = true;
  await send("/api/team/directory", { method: "POST", body: {} });
  assert.equal((await send("/api/team/status")).json.admin, true);

  // The name the admin gave this person is kept for the honcho MCP, which reads it offline.
  const kept = async () => JSON.parse(await fs.readFile(process.env.HONCHO_AGENT_TEAM_AUTH, "utf8")).me.nickname;
  meNickname = "김아람";
  await send("/api/team/directory", { method: "POST", body: {} });
  assert.equal(await kept(), "김아람");
  meNickname = undefined;
  await send("/api/team/directory", { method: "POST", body: {} });
  assert.equal(await kept(), null);
});

test("the owner opens folders, ChatGPT 기록 and MCP tools to a teammate, turns them off and on, and the hub names what is open", async () => {
  const REQUEST = "r-0123456789abcdef";
  const HONCHO = { path: "/Users/me/dev/honcho", subfolders: true };
  const chatOf = async () => (await readGateAccess(gateStatePaths())).people["mate@example.com"]?.chat;
  const post = async (route, body) => (await send(route, { method: "POST", body })).json;
  const asked = hubSeen.length;

  // Nothing chosen opens nothing, and the hub hears nothing.
  const approve = { id: REQUEST, approve: true, kind: "chat", email: "mate@example.com", peer: "mate" };
  assert.deepEqual(await post("/api/team/decide", { ...approve, folders: [], sources: ["Not An App"] }), { ok: false, error: "폴더나 ChatGPT 기록을 하나 이상 고르세요." });
  assert.equal(hubSeen.length, asked);
  assert.equal(await chatOf(), undefined);

  assert.equal((await post("/api/team/decide", { ...approve, folders: [HONCHO], sources: ["chatgpt"] })).ok, true);
  assert.deepEqual(await chatOf(), { folders: [HONCHO], sources: ["chatgpt"], tools: [...DEFAULT_TOOLS], since: (await chatOf()).since });
  assert.deepEqual(hubSeen.at(-1), { method: "POST", path: `/api/requests/${REQUEST}/decide`, email: "me@example.com", body: { approve: true, projects: ["ChatGPT 기록", "~/dev/honcho"] } });

  // Off for now, with what is open kept, and still off while the folders change.
  assert.deepEqual(await post("/api/team/grant", { email: "Mate@Example.com", off: true }), { ok: true, off: true });
  assert.equal((await chatOf()).off, true);
  assert.equal((await post("/api/team/grant", { email: "mate@example.com", request: REQUEST, folders: [HONCHO], sources: [] })).ok, true);
  assert.deepEqual([(await chatOf()).sources, (await chatOf()).off], [undefined, true]);
  assert.deepEqual(hubSeen.at(-1).body, { projects: ["~/dev/honcho"] });
  assert.deepEqual(await post("/api/team/grant", { email: "mate@example.com", off: false }), { ok: true, off: false });
  assert.equal((await chatOf()).off, undefined);

  // A teammate chat was never opened to is not turned on here, and closing takes 끊기.
  assert.match((await post("/api/team/grant", { email: "nobody@example.com", off: false })).error, /요청을 승인하면 열립니다/);
  assert.equal((await post("/api/team/grant", { email: "mate@example.com", folders: [], sources: [] })).error, "폴더나 ChatGPT 기록을 하나 이상 고르세요. 모두 닫으려면 끊기를 누르세요.");
  assert.deepEqual((await chatOf()).folders, [HONCHO]);

  // MCP tools: for this teammate, or ticked for every teammate, and the 모든 팀원 도구 window.
  assert.match((await post("/api/team/grant", { email: "mate@example.com", folders: [HONCHO], tools: ["delete_session"] })).error, /MCP 도구를 하나 이상 켜세요/);
  assert.equal((await post("/api/team/grant", { email: "mate@example.com", folders: [HONCHO], tools: ["search", "chat"] })).ok, true);
  assert.deepEqual((await chatOf()).tools, ["search", "chat"]);
  assert.deepEqual(await post("/api/team/tools", {}), { ok: true, tools: [...DEFAULT_TOOLS] }, "not set for all yet");
  assert.equal((await post("/api/team/grant", { email: "mate@example.com", folders: [HONCHO], tools: ["search", "get_peer_card"], allTools: true })).ok, true);
  assert.deepEqual(await post("/api/team/tools", {}), { ok: true, tools: ["search", "get_peer_card"] });
  assert.deepEqual(await post("/api/team/tools", { tools: ["list_sessions"] }), { ok: true, tools: ["list_sessions"] });
  assert.deepEqual((await chatOf()).tools, ["list_sessions"]);
  assert.match((await post("/api/team/tools", { tools: [] })).error, /하나 이상/);
});

test("a member's hub login goes on to the servers' in the same window, once, and only for a member", async () => {
  const hubLogin = async () => {
    const started = await send("/api/team/login", { method: "POST", body: { kind: "hub", hub: HUB } });
    const back = new URL(fake.browserLogin(started.json.url));
    return send(`${back.pathname}${back.search}`, { redirect: "manual" });
  };
  const status = async () => (await send("/api/team/status")).json;
  teamServers = [{ host: SERVER, label: "", owner: "mate@example.com", ownerPeer: "mate", workspace: "memory", company: false }];
  assert.equal((await status()).serversLogin.signedIn, false);

  // Back from the hub's login, the browser goes on to the servers' (Access knows the
  // person by now and asks only to allow it), and comes back here once more.
  const hop = await hubLogin();
  assert.equal(hop.status, 302);
  const authorize = new URL(hop.location);
  assert.equal(authorize.hostname, ISSUER_HOST);
  assert.equal(authorize.searchParams.get("resource"), `https://${SERVER}`);
  assert.equal(authorize.searchParams.get("redirect_uri"), `http://127.0.0.1:${port}/oauth/callback`);
  const back = new URL(fake.browserLogin(authorize.toString()));
  const done = await send(`${back.pathname}${back.search}`, { redirect: "manual" });
  assert.equal(done.status, 200);
  assert.match(done.text, /로그인됐습니다/);
  const both = await status();
  assert.equal(both.hubLogin.signedIn, true);
  assert.deepEqual([both.serversLogin.signedIn, both.serversLogin.host], [true, SERVER]);

  // With the servers login kept, the hub's comes back alone.
  assert.equal((await hubLogin()).status, 200);

  // Turned down at Access: the hub login stays, and the page says the rest waits.
  const file = process.env.HONCHO_AGENT_TEAM_AUTH;
  const auth = JSON.parse(await fs.readFile(file, "utf8"));
  delete auth.logins.servers;
  await fs.writeFile(file, JSON.stringify(auth));
  appPeople.servers = ["mate@example.com"];
  try {
    const denied = await hubLogin();
    assert.equal(denied.status, 302);
    const refused = new URL(fake.browserLogin(denied.location));
    assert.equal(refused.searchParams.get("error"), "access_denied");
    const page = await send(`${refused.pathname}${refused.search}`, { redirect: "manual" });
    assert.equal(page.status, 200);
    assert.match(page.text, /팀원 서버 로그인은 하지 않았습니다/);
    const left = await status();
    assert.deepEqual([left.hubLogin.signedIn, left.serversLogin.signedIn], [true, false]);
  } finally {
    appPeople.servers = null;
  }

  // Someone the hub does not know never goes on, nor does a member of a team with no server yet.
  fake.state.loginAs = "stranger@example.com";
  try {
    assert.equal((await hubLogin()).status, 200);
  } finally {
    fake.state.loginAs = "me@example.com";
  }
  teamServers = [];
  assert.equal((await hubLogin()).status, 200);
  assert.equal((await status()).serversLogin.signedIn, false);
});
