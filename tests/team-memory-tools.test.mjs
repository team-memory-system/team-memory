// The team-memory MCP server's tools: who can be asked, and one teammate's memory,
// read through their server's MCP bridge with the owner's own tools and this
// computer's own team login. What matters: the hub's people and each server's whoami
// make the member list, with the tools each opened; a name finds one member; every
// call carries the question and only the arguments its tool takes; the bridge's
// session is kept and opened again once when it forgets it; and a refusal, or a
// server too old for a tool, reaches the agent in words it can pass on.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { finishLogin, setTeam, startLogin, teamAuthPaths } from "../scripts/team-auth.mjs";
import { OPENABLE_TOOLS } from "../scripts/openable-tools.mjs";
import { answerIn, findMember, membersOf, ownMemoryInstructions, ownTeamName, TEAM_TOOLS, teamMemory } from "../scripts/team-memory-tools.mjs";
import { fakeTeam } from "./fake-team.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HUB = "team.example.com";
const BOB = "memory-bob.example.com";
const CAROL = "memory-carol.example.com";
const MINE = "memory-me.example.com";
const REDIRECT = "http://127.0.0.1:4180/oauth/callback";

const DIRECTORY = {
  team: { name: "AI 코어", host: HUB, zone: "example.com" },
  people: [
    { email: "me@example.com", peer: "me", nickname: "나", admin: true, joined: true, servers: [MINE] },
    { email: "bob@example.com", peer: "bob", nickname: "밥", admin: false, joined: true, servers: [BOB] },
    { email: "carol@example.com", peer: "carol", admin: false, joined: true, servers: [CAROL] },
    { email: "dave@example.com", peer: "dave", admin: false, joined: false, servers: [] },
  ],
  servers: [
    { host: MINE, label: "me", owner: "me@example.com", ownerPeer: "me", company: false },
    { host: BOB, label: "bob", owner: "bob@example.com", ownerPeer: "bob", company: false },
    { host: CAROL, label: "carol", owner: "carol@example.com", ownerPeer: "carol", company: false },
  ],
};

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const sse = (message, headers = {}) => new Response(`event: message\ndata: ${JSON.stringify(message)}\n\n`, { status: 200, headers: { "content-type": "text/event-stream", ...headers } });

/** Bob's MCP bridge, as FastMCP's streamable HTTP answers: a session, results as Server-Sent Events. */
function bridge() {
  const state = { sessions: new Set(), initialized: 0, calls: [], forgetNext: false };
  // FastMCP wraps a list as {result}.
  const answers = {
    search: (args) => (args.session_id === "nope"
      ? { isError: true, text: "Error calling tool 'search': No conversation with that id is open to you on this MCP server" }
      : { result: [{ id: "m-1", session_id: "s-1", peer_id: "bob", content: "위노라 OCR은 PaddleOCR로", created_at: "2026-10-12T00:20:00Z" }] }),
    list_sessions: () => ({ items: [{ id: "s-1", metadata: { cwd: "/Users/bob/dev/app" } }], total: 1, page: 1, pages: 1 }),
    get_session_messages: () => ({ items: [{ id: "m-0", peer_id: "bob", content: "OCR 엔진을 바꾸자" }], total: 1, page: 1, pages: 1 }),
    query_conclusions: () => ({ result: [{ id: "c-1", session_id: "s-1", content: "bob uses PaddleOCR" }] }),
    chat: () => ({ isError: true, text: "Error calling tool 'chat': chat is not open to you on this MCP server; use search, list_sessions" }),
  };
  async function handle(request, { email }) {
    const url = new URL(request.url);
    if (url.pathname === "/team-memory/whoami") {
      return json(200, { email, owner: false, chat: { folders: [{ path: "/Users/bob/dev/app", subfolders: true }], sources: ["chatgpt"], off: false, tools: ["search", "list_sessions", "get_session_messages", "query_conclusions"] }, collect: false, device: null });
    }
    if (url.pathname !== "/mcp") return json(404, { error: "not_found" });
    const message = await request.json();
    const session = request.headers.get("mcp-session-id");
    if (message.method === "initialize") {
      state.initialized += 1;
      const id = `session-${state.initialized}`;
      state.sessions.add(id);
      return json(200, { jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "honcho", version: "1" } } }, { "mcp-session-id": id });
    }
    if (!state.sessions.has(session)) return json(404, { jsonrpc: "2.0", error: { code: -32600, message: "Session not found" } });
    if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (state.forgetNext) {
      state.forgetNext = false;
      state.sessions.clear();
      return json(404, { jsonrpc: "2.0", error: { code: -32600, message: "Session not found" } });
    }
    const { name, arguments: args } = message.params;
    state.calls.push({ name, args, email, session });
    if (!answers[name]) return sse({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: `Unknown tool: '${name}'` }], isError: true } });
    const value = answers[name](args);
    if (value.isError) return sse({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: value.text }], isError: true } });
    return sse({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value, isError: false } });
  }
  return { state, handle };
}

async function setup(t, { servers = true } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "team-memory-tools-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const paths = teamAuthPaths(null, { HONCHO_AGENT_TEAM_AUTH: path.join(dir, "state", "team-auth.json") });
  const bob = bridge();
  const fake = fakeTeam({
    hosts: {
      [HUB]: { app: "hub", handle: (request) => (new URL(request.url).pathname === "/api/team" ? json(200, DIRECTORY) : json(404, { error: "not_found" })) },
      [BOB]: { app: "servers", handle: bob.handle },
      [CAROL]: {
        app: "servers",
        handle: (request, { email }) => (new URL(request.url).pathname === "/team-memory/whoami"
          ? json(200, { email, owner: false, chat: null, collect: false, device: null })
          : json(403, { error: "forbidden", detail: "This server's owner has not opened its memory to you." })),
      },
      [MINE]: { app: "servers", handle: () => json(500, { error: "should not be asked" }) },
    },
  });
  const login = async (host, kind) => {
    const started = await startLogin({ host, kind, redirectUri: REDIRECT, paths, fetchImpl: fake.fetch });
    const back = new URL(fake.browserLogin(started.url));
    await finishLogin({ state: back.searchParams.get("state"), code: back.searchParams.get("code"), paths, fetchImpl: fake.fetch });
  };
  await setTeam({ hub: HUB, email: "me@example.com" }, { paths });
  await login(HUB, "hub");
  if (servers) await login(BOB, "servers");
  return { paths, fake, bob, team: teamMemory({ paths, fetchImpl: fake.fetch }) };
}

test("member lists who can be asked, what each opened, and leaves this person out", async (t) => {
  const { team, fake } = await setup(t);
  const text = await team.call("member", {});
  assert.match(text, /Team "AI 코어"/);
  assert.match(text, /- 밥 \(bob@example\.com · memory-bob\.example\.com\): open to you: folders ~\/dev\/app; ChatGPT records\. Tools you may use: search, list_sessions, get_session_messages, query_conclusions/);
  assert.match(text, /- carol \(carol@example\.com · memory-carol\.example\.com\): not open to you/);
  assert.match(text, /- dave \(dave@example\.com\): has no memory server/);
  assert.match(text, /^Your user is 나 \(me@example\.com\); their own memory is in the honcho tools, not here\.$/m);
  assert.doesNotMatch(text, /^- .*me@example\.com/m);
  // This person's own server is never asked.
  assert.equal(fake.state.requests.some((request) => new URL(request.url).hostname === MINE), false);
});

test("a call goes to the member's bridge with the question and only what its tool takes, in one session", async (t) => {
  const { team, bob } = await setup(t);
  const found = await team.call("search", { member: "밥", question: "밥이 OCR 뭐로 바꿨어?", query: "OCR 엔진", limit: 5, workspace_id: "other" });
  assert.deepEqual(bob.state.calls[0].args, { question: "밥이 OCR 뭐로 바꿨어?", query: "OCR 엔진", limit: 5 }, "nothing past its schema");
  assert.equal(bob.state.calls[0].email, "me@example.com");
  assert.match(found, /^밥 \(peer bob\) · search:\n/);
  assert.match(found, /"content": "위노라 OCR은 PaddleOCR로"/);

  // By email or peer it is the same member, and the session stays open.
  assert.match(await team.call("list_sessions", { member: "bob@example.com", question: "밥 대화 목록", size: 5 }), /"cwd": "\/Users\/bob\/dev\/app"/);
  assert.match(await team.call("get_session_messages", { member: "bob", question: "그 대화 읽어 줘", session_id: "s-1" }), /OCR 엔진을 바꾸자/);
  assert.match(await team.call("query_conclusions", { member: "memory-bob", question: "밥 OCR", query: "OCR", observer_id: "bob", observed_id: "bob" }), /bob uses PaddleOCR/);
  assert.equal(bob.state.initialized, 1);
  assert.deepEqual(bob.state.calls.map((call) => [call.name, call.args.question]), [
    ["search", "밥이 OCR 뭐로 바꿨어?"], ["list_sessions", "밥 대화 목록"], ["get_session_messages", "그 대화 읽어 줘"], ["query_conclusions", "밥 OCR"],
  ]);
  await assert.rejects(team.call("get_session_messages", { member: "bob", question: "q" }), /session_id is required/);
});

test("a session the bridge forgot is opened again, once", async (t) => {
  const { team, bob } = await setup(t);
  const ask = { member: "bob", question: "q", query: "OCR", observer_id: "bob", observed_id: "bob" };
  await team.call("query_conclusions", ask);
  bob.state.forgetNext = true;
  const facts = await team.call("query_conclusions", ask);
  assert.match(facts, /PaddleOCR/);
  assert.equal(bob.state.initialized, 2);
});

test("a refusal reaches the agent in the member's name and the bridge's words", async (t) => {
  const { team } = await setup(t);
  await assert.rejects(
    team.call("search", { member: "bob", question: "q", query: "x", session_id: "nope" }),
    { message: "밥: No conversation with that id is open to you on this MCP server" },
  );
  await assert.rejects(
    team.call("chat", { member: "bob", question: "q", query: "x" }),
    { message: "밥: chat is not open to you on this MCP server; use search, list_sessions" },
  );
  // A server from before the owner's tools could be opened.
  await assert.rejects(
    team.call("get_peer_card", { member: "bob", question: "q", peer_id: "bob" }),
    { message: "밥's server runs an older Team Memory without get_peer_card. Ask them to update (/team-memory doctor)." },
  );
  await assert.rejects(
    team.call("search", { member: "carol", question: "q", query: "x" }),
    { message: "carol: This server's owner has not opened its memory to you." },
  );
  await assert.rejects(team.call("search", { member: "dave", question: "q", query: "x" }), /dave has no memory server/);
  await assert.rejects(team.call("search", { member: "bob", query: "x" }), /question is required/);
  await assert.rejects(team.call("search_messages", { member: "bob", question: "q", query: "x" }), /Unknown tool: search_messages/);
  for (const member of ["me", "ME@example.com", "나"]) {
    await assert.rejects(team.call("search", { member, question: "q", query: "x" }), /use the honcho tools/, member);
  }
  await assert.rejects(team.call("search", { member: "zed", question: "q", query: "x" }), /No teammate is called "zed"\. Teammates: 밥 \(bob@example\.com\), carol/);
});

test("without the servers login the tools say where to log in", async (t) => {
  const { team } = await setup(t, { servers: false });
  await assert.rejects(team.call("member", {}), /팀 서버 로그인/);
  await assert.rejects(team.call("search", { member: "bob", question: "q", query: "x" }), /팀 서버 로그인/);
});

test("a name finds one member: exactly first, then by its start; two are named back", () => {
  const members = membersOf({
    people: [
      { email: "me@example.com", peer: "me" },
      { email: "kim.a@example.com", peer: "kim-a", nickname: "김가" },
      { email: "kim.b@example.com", peer: "kim-b" },
    ],
    servers: [
      { host: "memory-kim-a.example.com", owner: "kim.a@example.com" },
      { host: "memory-kim-b.example.com", owner: "kim.b@example.com" },
      { host: "memory-office.example.com", owner: "me@example.com", company: true, label: "office" },
    ],
  }, "me@example.com");
  assert.deepEqual(members.map((member) => member.name), ["김가", "kim-b"]);
  assert.equal(findMember(members, "KIM-A").email, "kim.a@example.com");
  assert.equal(findMember(members, "kim.b").email, "kim.b@example.com");
  assert.equal(findMember(members, "김").email, "kim.a@example.com");
  assert.throws(() => findMember(members, "kim"), /"kim" could be 김가 .* or kim-b/);
});

test("a company server goes by its label, even its owner's", () => {
  const members = membersOf({
    people: [{ email: "boss@example.com", peer: "boss" }],
    servers: [
      { host: "memory-boss.example.com", owner: "boss@example.com" },
      { host: "memory-office.example.com", owner: "boss@example.com", company: true, label: "office" },
    ],
  }, "me@example.com");
  assert.deepEqual(members.map((member) => [member.name, member.company]), [["boss", false], ["office", true]]);
});

test("an answer is found in JSON or in Server-Sent Events", () => {
  const message = { jsonrpc: "2.0", id: 7, result: { ok: true } };
  assert.deepEqual(answerIn(JSON.stringify(message), "application/json", 7), message);
  const events = `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress" })}\n\nevent: message\ndata: ${JSON.stringify(message)}\n\n`;
  assert.deepEqual(answerIn(events, "text/event-stream; charset=utf-8", 7), message);
  assert.equal(answerIn(events, "text/event-stream", 8), null);
});

test("the stdio server offers no tools before this computer joins a team", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "team-mcp-server-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const child = spawn(process.execPath, [path.join(ROOT, "scripts", "team-mcp-server.mjs")], {
    env: { ...process.env, HONCHO_AGENT_BRIDGE_HOME: path.join(dir, "app"), HONCHO_AGENT_TEAM_AUTH: path.join(dir, "state", "team-auth.json") },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => child.kill());
  const lines = readline.createInterface({ input: child.stdout });
  const answers = new Map();
  const waiting = new Map();
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    if (waiting.has(message.id)) waiting.get(message.id)(message);
    else answers.set(message.id, message);
  });
  const rpc = (id, method, params = {}) => new Promise((resolve) => {
    waiting.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  const init = await rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  assert.match(init.result.instructions, /honcho tools/);
  assert.deepEqual((await rpc(2, "tools/list")).result.tools, []);
  await setTeam({ hub: HUB, email: "me@example.com" }, { paths: teamAuthPaths(null, { HONCHO_AGENT_TEAM_AUTH: path.join(dir, "state", "team-auth.json") }) });
  const tools = (await rpc(3, "tools/list")).result.tools;
  assert.deepEqual(tools.map((item) => item.name), TEAM_TOOLS);
  assert.deepEqual(TEAM_TOOLS, ["member", ...Object.values(OPENABLE_TOOLS).flat()], "the owner's tools that read, and no other");
  assert.ok(tools.slice(1).every((item) => item.inputSchema.required.includes("question") && item.annotations.readOnlyHint));
  assert.ok(tools.every((item) => !("workspace_id" in item.inputSchema.properties) && !("filters" in item.inputSchema.properties)), "the team's bridge takes neither");
});

test("the honcho tools say whose memory it is, by the name the team calls them", async (t) => {
  const { paths, team, fake } = await setup(t);
  assert.equal(await ownTeamName({ paths }), null, "nothing is asked of the hub to find it");
  const asked = fake.state.requests.length;
  await team.call("member", {});
  assert.ok(fake.state.requests.length > asked);
  assert.equal(await ownTeamName({ paths }), "나", "the name the hub's list gave is kept in the login file");

  const text = ownMemoryInstructions({ peer: "user_chen", name: "김아람" });
  assert.match(text, /The user is 김아람 \(peer user_chen\): a question about 김아람 is about this memory and peer user_chen/);
  assert.match(ownMemoryInstructions({ peer: "user_chen" }), /The user is peer user_chen\.$/);
  assert.doesNotMatch(ownMemoryInstructions({}), /The user is/);
});
