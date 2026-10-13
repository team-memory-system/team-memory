// The app's own read-only routes for the folder picker, the project list and the
// dashboard's flow, the folders the memory server can open to a teammate, and the
// hour the nightly backup runs at.
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

import { backupScheduleInvocation, createUiServer } from "../scripts/ui.mjs";

const ENV = ["HONCHO_AGENT_BRIDGE_HOME", "HONCHO_AGENT_BRIDGE_CONFIG", "HONCHO_AGENT_BRIDGE_USER_HOME"];
const saved = {};
let workdir;
let home;
let ui;
let port;

function send(pathname, { method = "GET", body } = {}) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: "127.0.0.1",
      port,
      path: pathname,
      method,
      headers: {
        host: `127.0.0.1:${port}`,
        ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: response.statusCode, body: text ? JSON.parse(text) : null });
      });
    });
    request.on("error", reject);
    request.end(payload);
  });
}

before(async () => {
  for (const name of ENV) saved[name] = process.env[name];
  workdir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-bridge-app-routes-")));
  home = path.join(workdir, "home");
  await fsp.mkdir(path.join(home, "Documents"), { recursive: true });
  await fsp.mkdir(path.join(home, ".config"), { recursive: true });
  process.env.HONCHO_AGENT_BRIDGE_HOME = path.join(workdir, "app");
  delete process.env.HONCHO_AGENT_BRIDGE_CONFIG;
  process.env.HONCHO_AGENT_BRIDGE_USER_HOME = home;
  ui = createUiServer();
  await new Promise((resolve) => ui.listen(0, "127.0.0.1", resolve));
  port = ui.address().port;
});

after(async () => {
  await new Promise((resolve) => ui.close(() => resolve()));
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  await fsp.rm(workdir, { recursive: true, force: true });
});

test("the folder route lists a folder, starts at this user's home, and answers a bad path with its reason", async () => {
  const started = await send("/api/app/folders");
  assert.equal(started.status, 200);
  assert.equal(started.body.ok, true);
  assert.equal(started.body.path, home);
  assert.equal(started.body.parent, workdir);
  assert.deepEqual(started.body.folders, [{ name: "Documents", path: path.join(home, "Documents") }]);
  assert.deepEqual(started.body.roots[0], { kind: "home", path: home });
  assert.equal(started.body.truncated, false);

  const inside = await send(`/api/app/folders?path=${encodeURIComponent(path.join(home, "Documents"))}`);
  assert.equal(inside.body.path, path.join(home, "Documents"));
  assert.equal(inside.body.parent, home);
  assert.deepEqual(inside.body.folders, []);

  const relative = await send("/api/app/folders?path=Documents");
  assert.equal(relative.status, 200);
  assert.equal(relative.body.ok, false);
  assert.equal(relative.body.reason, "not-absolute");

  const missing = await send(`/api/app/folders?path=${encodeURIComponent(path.join(home, "nope"))}`);
  assert.equal(missing.body.reason, "missing");
});

test("the project route reads the transcripts the configuration names", async () => {
  const project = path.join(home, "dev", "app");
  await fsp.mkdir(path.join(project, ".git"), { recursive: true });
  await fsp.mkdir(path.join(project, "src"), { recursive: true });
  const claudeRoot = path.join(workdir, "claude-projects");
  await fsp.mkdir(path.join(claudeRoot, "-app"), { recursive: true });
  await fsp.writeFile(path.join(claudeRoot, "-app", "s.jsonl"), `${JSON.stringify({ type: "user", cwd: path.join(project, "src") })}\n`);
  const codexDay = path.join(home, ".codex", "sessions", "2026", "10", "06");
  await fsp.mkdir(codexDay, { recursive: true });
  await fsp.writeFile(path.join(codexDay, "rollout-x.jsonl"), `${JSON.stringify({ type: "session_meta", payload: { cwd: project } })}\n`);
  // Not read: the configuration moves Claude Code's transcripts elsewhere.
  await fsp.mkdir(path.join(home, ".claude", "projects", "-app"), { recursive: true });
  await fsp.writeFile(path.join(home, ".claude", "projects", "-app", "ignored.jsonl"), `${JSON.stringify({ cwd: project })}\n`);

  await fsp.mkdir(process.env.HONCHO_AGENT_BRIDGE_HOME, { recursive: true });
  await fsp.writeFile(path.join(process.env.HONCHO_AGENT_BRIDGE_HOME, "config.json"), JSON.stringify({
    version: 1,
    sources: { claude: { root: claudeRoot } },
  }));

  const response = await send("/api/app/projects");
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.scanned, 2);
  assert.equal(response.body.withoutFolder, 0);
  assert.equal(response.body.projects.length, 1);
  const [listed] = response.body.projects;
  assert.equal(listed.path, project);
  assert.equal(listed.name, "app");
  assert.equal(listed.sessions, 2);
  assert.deepEqual(listed.agents, { claude: 1, codex: 1 });
  assert.equal(listed.exists, true);
  assert.match(listed.lastAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test("the folders to open to a teammate are the memory server's, and one that cannot be read says so", async () => {
  // A stand-in memory server: one folder's sessions from two computers, one of them
  // twice, and a ChatGPT import with no folder, which counts under its app.
  const sessions = [
    { id: "a", created_at: "2026-10-01T00:00:00.000Z", metadata: { cwd: "/Users/someone/dev/flypiano", last_imported_at: "2026-10-07T10:00:00.000Z" } },
    { id: "b", created_at: "2026-10-02T00:00:00.000Z", metadata: { cwd: "/Users/someone/dev/flypiano", last_imported_at: "2026-10-08T10:00:00.000Z" } },
    { id: "c", created_at: "2026-10-03T00:00:00.000Z", metadata: { cwd: "C:\\Users\\someone\\dev\\flypiano" } },
    { id: "d", created_at: "2026-10-04T00:00:00.000Z", metadata: { source: "chatgpt" } },
  ];
  const honcho = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      const url = new URL(request.url, "http://honcho");
      if (request.method !== "POST" || url.pathname !== "/v3/workspaces/memory/sessions/list") {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ items: sessions, total: sessions.length, page: 1, size: 100, pages: 1 }));
    });
  });
  await new Promise((resolve) => honcho.listen(0, "127.0.0.1", resolve));
  await fsp.mkdir(process.env.HONCHO_AGENT_BRIDGE_HOME, { recursive: true });
  await fsp.writeFile(path.join(process.env.HONCHO_AGENT_BRIDGE_HOME, "config.json"), JSON.stringify({
    version: 1,
    honcho: { baseUrl: `http://127.0.0.1:${honcho.address().port}`, workspaceId: "memory" },
  }));

  assert.equal((await send("/api/team/folders")).status, 405);
  const listed = await send("/api/team/folders", { method: "POST", body: {} });
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body, {
    ok: true,
    workspace: "memory",
    sessions: 4,
    noFolder: 1,
    folders: [
      { path: "/Users/someone/dev/flypiano", sessions: 2, lastAt: "2026-10-08T10:00:00.000Z" },
      { path: "C:\\Users\\someone\\dev\\flypiano", sessions: 1, lastAt: "2026-10-03T00:00:00.000Z" },
    ],
    apps: [{ source: "chatgpt", sessions: 1, lastAt: "2026-10-04T00:00:00.000Z" }],
  });

  await new Promise((resolve) => honcho.close(resolve));
  const down = await send("/api/team/folders", { method: "POST", body: {} });
  assert.equal(down.body.ok, false);
  assert.equal(down.body.folders, undefined);
  assert.match(down.body.error, /^기억 서버에서 폴더를 읽지 못했습니다 \(ECONNREFUSED\)\.$/);
});

test("the flow route counts what waits to go and what went, for the agents that collect", async () => {
  const appHome = process.env.HONCHO_AGENT_BRIDGE_HOME;
  const dataDir = path.join(appHome, "data");
  await fsp.mkdir(appHome, { recursive: true });
  await fsp.writeFile(path.join(appHome, "config.json"), JSON.stringify({ version: 1, agents: { claude: true, codex: false } }));
  const write = async (file, value) => {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, typeof value === "string" ? value : JSON.stringify(value));
  };
  await write(path.join(dataDir, "spool", "claude", "pending", "a.json"), {});
  await write(path.join(dataDir, "spool", "claude", "pending", "b.json"), {});
  await write(path.join(dataDir, "spool", "claude", "pending", "c.tmp"), "");
  await write(path.join(dataDir, "state", "claude.json"), { version: 1, sessions: {
    one: { last_imported_at: "2026-10-06T10:00:00.000Z" },
    two: { last_imported_at: "2026-10-07T01:30:00.000Z" },
  } });
  // Codex does not collect here, so its leftovers are not counted.
  await write(path.join(dataDir, "spool", "codex", "pending", "x.json"), {});
  await write(path.join(dataDir, "state", "codex.json"), { version: 1, sessions: { three: { last_imported_at: "2026-10-08T00:00:00.000Z" } } });

  const response = await send("/api/app/flow");
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { ok: true, collect: { pending: 2, sessions: 2, lastSentAt: "2026-10-07T01:30:00.000Z" }, targets: [], past: null, rederive: null });

  // A state caught mid-write counts as nothing sent until it is whole again.
  await write(path.join(dataDir, "state", "claude.json"), "{\"version\":1,\"sess");
  assert.deepEqual((await send("/api/app/flow")).body.collect, { pending: 2, sessions: 0, lastSentAt: null });

  // 지난 대화 on their way: a run still going says how far it got and the new turns
  // it holds; a run whose process is gone counts as not running, how the last one
  // ended stays, and the failures are those the ledger still has.
  await write(path.join(dataDir, "past", "status.json"), {
    version: 1,
    running: { pid: process.pid, startedAt: "2026-10-07T02:00:00.000Z", total: 40, done: 12, sent: 11, failed: 1, month: 1704103200000, from: "here", etaSec: 90 },
    last: null,
  });
  await write(path.join(dataDir, "spool", "hold.json"), { version: 1, by: "run", pid: process.pid, at: "2026-10-07T02:00:00.000Z" });
  await write(path.join(dataDir, "past", "ledger.jsonl"), [
    { k: "claude:a", o: "sent", from: "here", start: 1, last: 1, at: "2026-10-07T02:00:01.000Z" },
    { k: "claude:b", o: "failed", r: "unreadable", from: "here", start: 2, last: 2, at: "2026-10-07T02:00:02.000Z" },
  ].map((entry) => `${JSON.stringify(entry)}\n`).join(""));
  const going = (await send("/api/app/flow")).body.past;
  assert.equal(going.running.done, 12);
  assert.equal(going.running.total, 40);
  assert.equal(going.holding, true);
  assert.deepEqual(going.held, { turns: 3, conversations: 0 }, "every turn waiting is held, whichever agent's");
  assert.equal(going.failed, 1);
  await write(path.join(dataDir, "past", "status.json"), {
    version: 1,
    running: { pid: 2 ** 22 + 7, startedAt: "2026-10-07T02:00:00.000Z" },
    last: { finishedAt: "2026-10-06T02:05:00.000Z", total: 5, done: 5, sent: 5, failed: 0 },
  });
  await fsp.rm(path.join(dataDir, "spool", "hold.json"));
  const ended = (await send("/api/app/flow")).body.past;
  assert.equal(ended.running, null);
  assert.equal(ended.last.sent, 5);
  assert.equal(ended.holding, false);
});

test("the app's read-only routes answer only GET", async () => {
  for (const route of ["/api/app/folders", "/api/app/projects", "/api/app/flow"]) {
    const posted = await send(route, { method: "POST", body: {} });
    assert.equal(posted.status, 405, route);
    assert.equal(posted.body.ok, false);
  }
});

test("the backup schedule passes an hour only when it is one", async () => {
  assert.deepEqual(backupScheduleInvocation({ on: true }), ["backup", "schedule", "on"]);
  assert.deepEqual(backupScheduleInvocation({}), ["backup", "schedule", "off"]);
  assert.deepEqual(backupScheduleInvocation(undefined), ["backup", "schedule", "off"]);
  assert.deepEqual(backupScheduleInvocation({ on: "true" }), ["backup", "schedule", "off"], "only true turns it on");
  assert.deepEqual(backupScheduleInvocation({ on: true, hour: 0 }), ["backup", "schedule", "on", "--hour=0"]);
  assert.deepEqual(backupScheduleInvocation({ on: false, hour: 23 }), ["backup", "schedule", "off", "--hour=23"]);
  assert.deepEqual(backupScheduleInvocation({ on: true, hour: null }), ["backup", "schedule", "on"]);
  for (const hour of [24, -1, 1.5, "5", "--hour=1", true, Number.NaN]) {
    assert.equal(backupScheduleInvocation({ on: true, hour }), null, String(hour));
  }

  const refused = await send("/api/backup/schedule", { method: "POST", body: { on: true, hour: 24 } });
  assert.equal(refused.status, 200);
  assert.deepEqual(refused.body, { ok: false, error: "Choose an hour from 0 to 23." });
});
