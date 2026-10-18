// 컴퓨터 고르기: this computer's app shows the owner's server computer's whole app
// through its gate. What matters: every request reaches the gate's /team-memory/app
// with this computer's team login and device key, as the browser sent it, and only
// after the checks this computer's own app makes; /api/viewer is answered here; a
// server computer that cannot be shown gets a page that says why instead of a blank
// window; the server computer's app refuses what would cut the way the page came;
// and a long answer to the other computer begins before Cloudflare gives up on it.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ApiError, request } from "../ui/lib/api.js";
import { answerLate, json, rejectUnsafeRequest, restartServer } from "../scripts/ui.mjs";
import { DEVICE_HEADER, finishLogin, registerDevice, startLogin, teamAuthPaths } from "../scripts/team-auth.mjs";
import { createViewServer, forgetProbes, hereOnly, serverOrigin, shortName, unreachablePage, VIEWER_HEADER, viewerInfo, viewerOf } from "../scripts/viewer.mjs";
import { fakeTeam } from "./fake-team.mjs";

const SERVER = "memory-me.example.com";
const ORIGIN = `https://${SERVER}`;
const REDIRECT = "http://127.0.0.1:4180/oauth/callback";
const HOME = "http://127.0.0.1:4180/";

async function tempPaths(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "viewer-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return teamAuthPaths(null, { HONCHO_AGENT_TEAM_AUTH: path.join(dir, "state", "team-auth.json") });
}

/**
 * The owner's server behind its gate: what reached /team-memory/app, and an answer
 * set by `answer(path, request)`, or the app's own when it returns nothing.
 */
async function ownersServer(t, answer = () => null) {
  const seen = [];
  const fake = fakeTeam({
    hosts: {
      [SERVER]: {
        app: "servers",
        handle: async (request, { url }) => {
          if (url.pathname === "/team-memory/devices") {
            return new Response(JSON.stringify({ id: "d-0123456789abcdef", key: `d-0123456789abcdef.${"k".repeat(43)}`, name: "MacBook" }), { status: 201 });
          }
          const body = request.method === "GET" ? "" : await request.text();
          seen.push({ method: request.method, path: `${url.pathname}${url.search}`, device: request.headers.get(DEVICE_HEADER.toLowerCase()), type: request.headers.get("content-type"), body });
          const given = await answer(url.pathname, request);
          if (given) return given;
          if (url.pathname === "/team-memory/app/api/app/context") {
            return Response.json({ ok: true, version: "0.8.2", computer: "김아람의 Mac Studio" });
          }
          if (url.pathname.startsWith("/team-memory/app/api/")) return Response.json({ ok: true, got: body || null });
          return new Response("<!doctype html><title>팀 메모리</title>", { headers: { "content-type": "text/html; charset=utf-8", "set-cookie": "x=1" } });
        },
      },
    },
  });
  const paths = await tempPaths(t);
  const started = await startLogin({ host: SERVER, kind: "servers", redirectUri: REDIRECT, paths, fetchImpl: fake.fetch });
  const back = new URL(fake.browserLogin(started.url));
  await finishLogin({ state: back.searchParams.get("state"), code: back.searchParams.get("code"), error: back.searchParams.get("error"), paths, fetchImpl: fake.fetch });
  await registerDevice(SERVER, { name: "MacBook", paths, fetchImpl: fake.fetch });
  forgetProbes();
  return { fake, paths, seen };
}

async function viewer(t, server, origin = ORIGIN) {
  const listener = createViewServer({ reject: rejectUnsafeRequest, homeUrl: HOME, viewUrl: "http://127.0.0.1:4181/", fetchImpl: server.fake.fetch, paths: server.paths, origin });
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => listener.close(resolve)));
  return listener.address().port;
}

function call(port, target, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: target, method, headers: { host: `127.0.0.1:${port}`, ...headers }, agent: false }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("the server computer's page and its API come through its gate, with this computer's login and device key", async (t) => {
  const server = await ownersServer(t);
  const port = await viewer(t, server);

  const page = await call(port, "/");
  assert.equal(page.status, 200);
  assert.match(page.text, /팀 메모리/);
  assert.match(page.headers["content-type"], /text\/html/);
  assert.equal(page.headers["set-cookie"], undefined, "nothing of the server computer's is kept in this browser");
  assert.equal(server.seen.at(-1).path, "/team-memory/app/");
  assert.equal(server.seen.at(-1).device, `d-0123456789abcdef.${"k".repeat(43)}`);

  const body = JSON.stringify({ profile: "personal" });
  const saved = await call(port, "/api/server/status?x=a%20b", { method: "POST", headers: { "content-type": "application/json", origin: `http://127.0.0.1:${port}` }, body });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.got, body);
  assert.equal(server.seen.at(-1).path, "/team-memory/app/api/server/status?x=a%20b");
  assert.equal(server.seen.at(-1).type, "application/json");
});

test("started as the app starts it, with no login file given, the viewer uses this computer's own", async (t) => {
  const server = await ownersServer(t);
  const kept = process.env.HONCHO_AGENT_TEAM_AUTH;
  process.env.HONCHO_AGENT_TEAM_AUTH = server.paths.authFile;
  t.after(() => { if (kept === undefined) delete process.env.HONCHO_AGENT_TEAM_AUTH; else process.env.HONCHO_AGENT_TEAM_AUTH = kept; });
  const listener = createViewServer({ reject: rejectUnsafeRequest, homeUrl: HOME, viewUrl: "http://127.0.0.1:4181/", fetchImpl: server.fake.fetch, origin: ORIGIN });
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => listener.close(resolve)));
  const port = listener.address().port;

  const info = await call(port, "/api/viewer");
  assert.equal(info.json.computers[1].ok, true);
  assert.equal(info.json.computers[1].name, "Mac Studio");
  const page = await call(port, "/");
  assert.equal(page.status, 200);
  assert.equal(server.seen.at(-1).path, "/team-memory/app/");
});

test("the viewer makes the same checks as this computer's own app before anything goes out", async (t) => {
  const server = await ownersServer(t);
  const port = await viewer(t, server);
  const before = server.seen.length;
  for (const [what, options] of [
    ["another host name", { headers: { host: "memory.example.com" } }],
    ["another site's page", { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: "{}" }],
    ["a form post", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "a=1" }],
  ]) {
    const answer = await call(port, "/api/server/stop", options);
    assert.ok([403, 415].includes(answer.status), what);
  }
  assert.equal(server.seen.length, before, "nothing refused reached the server computer");
});

test("/api/viewer is answered here: this computer and the server computer, and which one the window shows", async (t) => {
  const server = await ownersServer(t);
  const port = await viewer(t, server);
  const answer = await call(port, "/api/viewer");
  assert.equal(answer.status, 200);
  assert.equal(answer.json.current, "server");
  const [here, shown] = answer.json.computers;
  assert.deepEqual([here.id, here.here, here.url], ["here", true, HOME]);
  assert.deepEqual([shown.id, shown.name, shown.host, shown.url, shown.ok, shown.version], ["server", "Mac Studio", SERVER, "http://127.0.0.1:4181/", true, "0.8.2"]);
  assert.ok(!server.seen.some((seen) => seen.path.includes("/api/viewer")), "the server computer is asked only for its context");

  // On this computer's own port the same list, showing this computer.
  const home = await viewerInfo({ homeUrl: HOME, viewUrl: "http://127.0.0.1:4181/", origin: ORIGIN, fetchImpl: server.fake.fetch, paths: server.paths });
  assert.equal(home.current, "here");
  assert.equal(home.computers.length, 2);
  // With no server computer, only this one: the box is not shown.
  assert.deepEqual((await viewerInfo({ homeUrl: HOME, origin: null })).computers.map((computer) => computer.id), ["here"]);
});

test("a server computer that cannot be shown gets a page that says why, and its API calls say so in JSON", async (t) => {
  const cases = [
    ["off", 502, { error: "upstream_unavailable" }, /앱이 꺼져 있습니다/],
    ["old", 404, { error: "not_found" }, /옛 판입니다/],
    ["owner", 403, { error: "forbidden", detail: "Only this server's owners see its app." }, /주인 컴퓨터로 등록되어 있지 않습니다/],
  ];
  for (const [reason, status, body, words] of cases) {
    const server = await ownersServer(t, () => Response.json(body, { status }));
    const port = await viewer(t, server);
    const page = await call(port, "/");
    assert.equal(page.status, 200, reason);
    assert.match(page.text, words, reason);
    assert.match(page.text, /href="http:\/\/127\.0\.0\.1:4180\/styles\.css"/, "in this computer's look");
    assert.match(page.text, /href="http:\/\/127\.0\.0\.1:4180\/#\/dashboard"/, "with the way back");
    const api = await call(port, "/api/app/context");
    assert.equal(api.status, 502, reason);
    assert.deepEqual([api.json.unreachable, api.json.reason], [true, reason]);
  }

  // The app's own refusals are the app's answers, and go through as they are.
  const refusing = await ownersServer(t, (pathname) => (pathname.endsWith("/api/server/stop") ? Response.json({ ok: false, hereOnly: true, error: "이 일은 그 컴퓨터 앞에서 하세요." }, { status: 403 }) : null));
  const port = await viewer(t, refusing);
  const stop = await call(port, "/api/server/stop", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(stop.status, 403);
  assert.equal(stop.json.hereOnly, true);

  // No server computer at all.
  const lone = await viewer(t, refusing, null);
  assert.equal((await call(lone, "/api/app/context")).json.reason, "owner");
});

test("a page shown on another computer cannot stop the server, turn sharing off, update or open a window on its screen", () => {
  const from = (method, headers = {}) => ({ method, headers });
  const elsewhere = { "x-team-memory-viewer": encodeURIComponent("chenjing의 MacBook Pro") };
  assert.equal(viewerOf(from("GET", elsewhere)), "chenjing의 MacBook Pro");
  assert.equal(viewerOf(from("GET")), null);
  assert.equal(viewerOf(from("GET", { "x-team-memory-viewer": "%E0%A4%A" })), null);
  for (const pathname of ["/api/server/stop", "/api/server/share/disable", "/api/team/login", "/api/team/logout", "/api/gateway/open", "/api/past/chatgpt", "/api/update/start", "/api/update/retry"]) {
    const refused = hereOnly(from("POST", elsewhere), pathname);
    assert.equal(refused?.status, 403, pathname);
    assert.equal(refused.body.hereOnly, true);
    assert.match(refused.body.error, /그 컴퓨터 앞에서/);
    assert.equal(hereOnly(from("POST"), pathname), null, `${pathname} on its own computer`);
  }
  assert.equal(hereOnly(from("POST", elsewhere), "/api/update/start").body.error, "이 일은 그 컴퓨터 앞에서 하세요. 업데이트하는 동안 이 화면으로 오는 길이 끊깁니다.");
  // 고치기 restarts what 다시 시작 does, and the way comes back the same way; 팀 주소 다시
  // 올리기 deploys the hub, not this computer's way.
  for (const pathname of ["/api/server/start", "/api/server/restart", "/api/server/share/rotate", "/api/doctor/fix", "/api/team/redeploy"]) {
    assert.equal(hereOnly(from("POST", elsewhere), pathname), null, `${pathname}: the way comes back by itself`);
  }
  assert.equal(hereOnly(from("GET", elsewhere), "/api/server/stop"), null);
});

test("the server computer is the https memory server this computer sends to, with a device key there", async (t) => {
  const server = await ownersServer(t);
  assert.equal(await serverOrigin({ config: { honcho: { baseUrl: `${ORIGIN}/` } }, paths: server.paths }), ORIGIN);
  assert.equal(await serverOrigin({ config: { honcho: { baseUrl: "http://127.0.0.1:8001" } }, paths: server.paths }), null, "a computer with its own server");
  assert.equal(await serverOrigin({ config: { honcho: { baseUrl: "https://memory-bob.example.com" } }, paths: server.paths }), null, "no device key there");
  assert.equal(await serverOrigin({ config: null, paths: server.paths }), null);
});

test("the page in place of an unreachable one escapes what it is given", () => {
  const page = unreachablePage({ name: "<b>x</b>", reason: "unreachable", homeUrl: HOME, here: "a\"b" });
  assert.ok(!page.includes("<b>x</b>"));
  assert.match(page, /&#60;b&#62;x/);
  assert.match(page, /잠자거나 꺼져 있거나/);
});

test("다시 시작 stops the server and starts it again, once at a time, and says how it went", async () => {
  const calls = [];
  let release;
  const run = async (args) => {
    calls.push(args.join(" "));
    if (args[1] === "stop") await new Promise((resolve) => { release = resolve; });
    return { ok: true };
  };
  const first = restartServer(["--profile", "personal"], run);
  const second = restartServer(["--profile", "personal"], run);
  assert.equal(first, second, "a second press waits for the same one");
  await new Promise((resolve) => setImmediate(resolve));
  release();
  assert.deepEqual(await first, { ok: true });
  assert.deepEqual(calls, ["server stop --profile personal", "server start --profile personal"]);

  // A stop that fails starts nothing.
  const failed = await restartServer([], async (args) => (calls.push(args.join(" ")), args[1] === "stop" ? { ok: false, error: "docker is not running" } : { ok: true }));
  assert.deepEqual(failed, { ok: false, error: "docker is not running" });
  assert.equal(calls.at(-1), "server stop");
});

test("a computer goes by its name without whose it is", () => {
  assert.equal(shortName("김아람의 Mac Studio"), "Mac Studio");
  assert.equal(shortName("chenjing의 MacBook Pro"), "MacBook Pro");
  assert.equal(shortName("Ana’s iMac"), "iMac");
  assert.equal(shortName("gim-alam-ui-MacStudio"), "gim-alam-ui-MacStudio");
  assert.equal(shortName("회의실 의자 옆 PC"), "회의실 의자 옆 PC", "의 inside a word is not whose");
  assert.equal(shortName("의 "), "의");
});

/** What a request to `port` gets, and how long its headers and its end took. */
function timedGet(port, pathname, { viewer = true } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const asked = http.get({ hostname: "127.0.0.1", port, path: pathname, headers: viewer ? { [VIEWER_HEADER]: encodeURIComponent("MacBook") } : {} }, (response) => {
      const headersAt = Date.now() - started;
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, headersAt, endAt: Date.now() - started, text }));
    });
    asked.on("error", reject);
  });
}

test("a slow answer to another computer begins at once and keeps going, so Cloudflare does not end it at 100 s", async (t) => {
  // The app's own routes, with the minutes a 다시 준비 takes shrunk to 300 ms.
  const app = http.createServer((req, res) => {
    answerLate(req, res, { firstMs: 30, everyMs: 30 });
    const quick = req.url === "/api/quick";
    setTimeout(() => json(res, quick ? 403 : 500, { ok: false, error: "서버를 준비하지 못했습니다" }), quick ? 0 : 300);
  });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  t.after(() => app.close());
  const port = app.address().port;

  const slow = await timedGet(port, "/api/slow");
  assert.equal(slow.status, 200, "the status went out before the answer was known");
  assert.ok(slow.headersAt < slow.endAt - 100, `headers after ${slow.headersAt} ms, the answer after ${slow.endAt} ms`);
  assert.match(slow.text, /^ {2,}\{/, "spaces until the answer");
  assert.deepEqual(JSON.parse(slow.text), { ok: false, error: "서버를 준비하지 못했습니다", lateStatus: 500 });

  const here = await timedGet(port, "/api/slow", { viewer: false });
  assert.equal(here.status, 500, "a page on this computer waits for the real status");
  assert.equal(here.text, JSON.stringify({ ok: false, error: "서버를 준비하지 못했습니다" }));

  const quick = await timedGet(port, "/api/quick");
  assert.equal(quick.status, 403, "an answer in time keeps its status");
  assert.equal(quick.text, JSON.stringify({ ok: false, error: "서버를 준비하지 못했습니다" }));
});

test("the page reads a late answer past its spaces, and a late failure as the failure it is", async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  const answers = ['   {"ok":true,"ready":true}', '    {"ok":false,"error":"서버를 준비하지 못했습니다","lateStatus":500}'];
  globalThis.fetch = async () => new Response(answers.shift(), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
  assert.deepEqual(await request("/api/server/prepare", { method: "POST", body: {} }), { ok: true, ready: true });
  await assert.rejects(request("/api/server/prepare", { method: "POST", body: {} }),
    (error) => error instanceof ApiError && error.status === 500 && error.message === "서버를 준비하지 못했습니다");
});
