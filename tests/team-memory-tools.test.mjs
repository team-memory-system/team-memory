// The team-memory MCP server's tools: who can be asked, and one teammate's opened
// conversations, read through their server's MCP bridge with this computer's own
// team login. What matters: the hub's people and each server's whoami make the
// member list, a name finds one member, every call carries the question, a bare date
// is a whole day here, the bridge's session is kept and opened again once when it
// forgets it, and a refusal reaches the agent in words it can pass on.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { finishLogin, setTeam, startLogin, teamAuthPaths } from "../scripts/team-auth.mjs";
import { answerIn, findMember, localTime, membersOf, teamMemory, timeBound } from "../scripts/team-memory-tools.mjs";
import { fakeTeam } from "./fake-team.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HUB = "team.example.com";
const BOB = "memory-bob.example.com";
const CAROL = "memory-carol.example.com";
const MINE = "memory-me.example.com";
const REDIRECT = "http://127.0.0.1:4180/oauth/callback";
const ZONE = "Asia/Seoul";

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
  const answers = {
    list_conversations: () => ({
      conversations: [{ id: "s-1", started_at: "2026-10-12T00:14:00Z", last_at: "2026-10-12T02:02:00Z", messages: 48, folder: "/Users/bob/dev/app", app: "claude", project: "app", branch: "main", opening: "OCR 엔진을 바꾸자" }],
      total: 1,
      shown: 1,
    }),
    search_messages: (args) => (args.conversation_id === "nope"
      ? { isError: true, text: "Error calling tool 'search_messages': No conversation with that id is open to you on this MCP server" }
      : { messages: [{ conversation_id: "s-1", at: "2026-10-12T00:20:00Z", speaker: "bob", content: "위노라 OCR은 PaddleOCR로" }, { conversation_id: "s-1", at: "2026-10-12T00:21:00Z", speaker: "assistant_claude", content: "바꿨습니다" }] }),
    read_conversation: () => ({ id: "s-1", folder: "/Users/bob/dev/app", app: "claude", total: 2, page: 1, pages: 1, newest_first: false, messages: [{ at: "2026-10-12T00:14:00Z", speaker: "bob", content: "OCR 엔진을 바꾸자" }] }),
    search_conclusions: () => ({ conclusions: [{ conversation_id: "s-1", conversation_last_at: "2026-10-12T02:02:00Z", content: "bob uses PaddleOCR" }] }),
  };
  async function handle(request, { email }) {
    const url = new URL(request.url);
    if (url.pathname === "/team-memory/whoami") {
      return json(200, { email, owner: false, chat: { folders: [{ path: "/Users/bob/dev/app", subfolders: true }], sources: ["chatgpt"], off: false }, collect: false, device: null });
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
  return { paths, fake, bob, team: teamMemory({ paths, fetchImpl: fake.fetch, timeZone: ZONE }) };
}

test("member lists who can be asked, what each opened, and leaves this person out", async (t) => {
  const { team, fake } = await setup(t);
  const text = await team.call("member", {});
  assert.match(text, /Team "AI 코어"/);
  assert.match(text, /- 밥 \(bob@example\.com · memory-bob\.example\.com\): open to you: folders ~\/dev\/app; ChatGPT records/);
  assert.match(text, /- carol \(carol@example\.com · memory-carol\.example\.com\): not open to you/);
  assert.match(text, /- dave \(dave@example\.com\): has no memory server/);
  assert.doesNotMatch(text, /me@example\.com/);
  // This person's own server is never asked.
  assert.equal(fake.state.requests.some((request) => new URL(request.url).hostname === MINE), false);
});

test("a search goes to the member's bridge with the question, a whole local day, and one session", async (t) => {
  const { team, bob } = await setup(t);
  const found = await team.call("search_messages", { member: "밥", question: "밥이 OCR 뭐로 바꿨어?", query: "OCR 엔진", since: "2026-10-12", until: "2026-10-12" });
  assert.deepEqual(bob.state.calls[0].args, {
    question: "밥이 OCR 뭐로 바꿨어?",
    query: "OCR 엔진",
    since: "2026-10-11T15:00:00.000Z",
    until: "2026-10-12T14:59:59.999Z",
  });
  assert.equal(bob.state.calls[0].email, "me@example.com");
  assert.match(found, /2 messages matched "OCR 엔진"\. Times are Asia\/Seoul\./);
  assert.match(found, /\[1\] conversation s-1 · 2026-10-12 09:20 · bob \(밥\)\n위노라 OCR은 PaddleOCR로/);
  assert.match(found, /assistant_claude \(their agent\)/);

  // By email or peer it is the same member, and the session stays open.
  const listed = await team.call("list_conversations", { member: "bob@example.com", question: "밥 대화 목록", limit: 5 });
  assert.match(listed, /s-1 \| 2026-10-12 09:14 → 2026-10-12 11:02 \| 48 messages \| ~\/dev\/app · claude · project app · branch main\n  opens with: OCR 엔진을 바꾸자/);
  const read = await team.call("read_conversation", { member: "bob", question: "그 대화 읽어 줘", conversation_id: "s-1" });
  assert.match(read, /밥 · conversation s-1 · ~\/dev\/app · claude · page 1 of 1 \(2 messages, oldest first\)/);
  const facts = await team.call("search_conclusions", { member: "memory-bob", question: "밥 OCR", query: "OCR" });
  assert.match(facts, /- bob uses PaddleOCR \(conversation s-1, last active 2026-10-12 11:02\)/);
  assert.equal(bob.state.initialized, 1);
  assert.deepEqual(bob.state.calls.map((call) => call.args.question), ["밥이 OCR 뭐로 바꿨어?", "밥 대화 목록", "그 대화 읽어 줘", "밥 OCR"]);
});

test("a session the bridge forgot is opened again, once", async (t) => {
  const { team, bob } = await setup(t);
  await team.call("search_conclusions", { member: "bob", question: "q", query: "OCR" });
  bob.state.forgetNext = true;
  const facts = await team.call("search_conclusions", { member: "bob", question: "q", query: "OCR" });
  assert.match(facts, /PaddleOCR/);
  assert.equal(bob.state.initialized, 2);
});

test("a refusal reaches the agent in the member's name and the bridge's words", async (t) => {
  const { team } = await setup(t);
  await assert.rejects(
    team.call("search_messages", { member: "bob", question: "q", query: "x", conversation_id: "nope" }),
    { message: "밥: No conversation with that id is open to you on this MCP server" },
  );
  await assert.rejects(
    team.call("search_messages", { member: "carol", question: "q", query: "x" }),
    { message: "carol: This server's owner has not opened its memory to you." },
  );
  await assert.rejects(team.call("search_messages", { member: "dave", question: "q", query: "x" }), /dave has no memory server/);
  await assert.rejects(team.call("search_messages", { member: "bob", query: "x" }), /question is required/);
  for (const member of ["me", "ME@example.com", "나"]) {
    await assert.rejects(team.call("search_messages", { member, question: "q", query: "x" }), /use the honcho tools/, member);
  }
  await assert.rejects(team.call("search_messages", { member: "zed", question: "q", query: "x" }), /No teammate is called "zed"\. Teammates: 밥 \(bob@example\.com\), carol/);
});

test("without the servers login the tools say where to log in", async (t) => {
  const { team } = await setup(t, { servers: false });
  await assert.rejects(team.call("member", {}), /팀 서버 로그인/);
  await assert.rejects(team.call("search_messages", { member: "bob", question: "q", query: "x" }), /팀 서버 로그인/);
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

test("a bare date is a whole day in the given time zone, across a clock change", () => {
  assert.equal(timeBound("2026-03-08", "since", { timeZone: "America/New_York" }), "2026-03-08T05:00:00.000Z");
  assert.equal(timeBound("2026-03-08", "until", { end: true, timeZone: "America/New_York" }), "2026-03-09T03:59:59.999Z");
  assert.equal(timeBound("2026-10-12T09:00:00+09:00", "since", { timeZone: ZONE }), "2026-10-12T00:00:00.000Z");
  assert.equal(timeBound("", "since"), undefined);
  assert.throws(() => timeBound("2026-02-30", "since"), /since is not a date/);
  assert.throws(() => timeBound("yesterday", "until"), /until takes a date/);
  assert.equal(localTime("2026-10-12T00:14:00Z", ZONE), "2026-10-12 09:14");
  assert.equal(localTime(null, ZONE), "?");
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
  assert.deepEqual(tools.map((item) => item.name), ["member", "list_conversations", "search_messages", "read_conversation", "search_conclusions"]);
  assert.ok(tools.slice(1).every((item) => item.inputSchema.required.includes("question") && item.annotations.readOnlyHint));
});
