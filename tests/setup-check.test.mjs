// The end of first setup (views/setup.js) and of 대화 수집's 수정 window
// (views/settings.js): 적용's last row is 점검 (lib/check.js), and the window then
// shows what it found beside what is left to do. What matters: doctor's checks, and
// `server verify` for a server on this computer, become the rows 대화 모으기, 기억
// 서버 and 임베딩, each passing one with what it runs and each failed one with what
// is wrong and what to press (고치기, 서버 켜기, 명령 복사, 대화 수집 수정, and always
// 다시 점검), never the terminal's `fix` line; a row that follows another (임베딩 when
// Ollama is not there) is no failure of its own; a 고치기 that makes the server again
// says so before it is pressed, and its rows come from fix.json, also once the app
// started again and ended its request; an agent whose missing plugin its row copies
// the commands for is not a to-do too; a setup that stores nothing looks at the
// team's logins alone; Docker Desktop's own window is spelled out only for a plan
// that installs it, read again on a window opened again; what the window keeps holds
// no secret, nor what an address has after its path, and comes back at 적용, the
// rows done kept done, running nothing until 이어서 하기, also as the app starts on a
// computer set up since; 수정's 적용 drops it; and a computer that collects joins a
// team alone, its peer name made the team's first when its setup has another.
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import test, { afterEach } from "node:test";
import { fileURLToPath } from "node:url";

import { DEFAULT_MARKETPLACE, DEFAULT_SOURCE, manualCommands } from "../scripts/host-plugins.mjs";
import { checkRows, failures, fixLines, fixOutcome, INSTALL_COMMANDS, missingPlugins, REBUILD_NOTE, runFix, teamCheckRows } from "../ui/lib/check.js";
import { collectDraft, dockerSteps, remoteUrlProblem, teamServers, todoAgents } from "../ui/lib/collect.js";
import { resumeAtBoot } from "../ui/lib/landing.js";
import { applyRows, endButton, joinsAlone, peerChange, restoreSetup, resumable, setupSnapshot } from "../ui/views/setup.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL = "http://127.0.0.1:8001";
const MINE = "https://memory-me.example.com";
const HUB = "team.example.com";
const HERE = { configured: true, localServer: { apiUrl: LOCAL }, honcho: { url: LOCAL }, team: null, targets: [] };
const AWAY = { configured: true, localServer: null, honcho: { url: MINE }, team: null, targets: [] };
// What doctor's probe gives for a server that does not answer at all.
const NO_ANSWER = { ok: false, status: undefined, error: "fetch failed" };

const read = (file) => fsp.readFile(path.join(ROOT, file), "utf8");

/** Doctor on a computer that collects into `url` from both agents, every check passing, then `changes` by name. */
function doctor(changes = {}, url = LOCAL) {
  const checks = [
    { name: "configuration", ok: true, state: "valid" },
    { name: "runtime", ok: true, expectedVersion: "0.8.14", actualVersion: "0.8.14", configuredVersion: "0.8.14", missingFiles: [] },
    { name: "server-version", ok: true },
    { name: "honcho-health", ok: true, status: 200, url },
    { name: "honcho-workspaces", ok: true, status: 200, url },
    { name: "mcp", ok: true },
    { name: "claude-plugin", ok: true, installed: true, enabled: true, pluginIds: ["team-memory@team-memory"] },
    { name: "claude-hook", ok: true },
    { name: "codex-plugin", ok: true, installed: true, enabled: true, pluginId: "team-memory@team-memory" },
    { name: "codex-hook", ok: true },
    { name: "app", ok: true, version: "0.8.14" },
  ];
  return { ok: true, version: "0.8.14", checks: checks.map((check) => (changes[check.name] ? { ...check, ...changes[check.name] } : check)) };
}

/** `server verify` without a model call, every check passing, then `changes` by name. */
function verify(changes = {}) {
  const checks = {
    status: { ok: true, installed: true, running: true, docker: { installed: true, running: true }, host: { running: true, routerHealthy: true, gatewayLoggedIn: true, ollamaHealthy: true, embeddingResident: true } },
    embedding: { ok: true, status: 200, model: "bge-m3", promptLongEnough: true, dimensionsMatch: true },
    containerHost: { ok: true, ollama: { ok: true, status: 200 }, router: { ok: true, status: 200 } },
    honcho: { ok: true, status: 200 },
    completion: { ok: true, skipped: true },
  };
  for (const [name, change] of Object.entries(changes)) checks[name] = { ...checks[name], ...change };
  return { ok: Object.values(checks).every((check) => check.ok), profile: "personal", liveCompletion: false, checks };
}

const row = (rows, name) => rows.find((item) => item.name === name);
const buttons = (item) => item.actions.map((action) => action.label);
const shown = (rows) => rows.map(({ name, ok, value }) => ({ name, ok, value }));
const lines = (tasks) => tasks.map((task) => task.label || `${task.key}: ${task.title}${task.sub ? ` · ${task.sub}` : ""}`);

/** A function of openSetup in views/setup.js, up to the next one. */
function setupPart(setup, name) {
  const from = setup.indexOf(`  ${name}`);
  assert.ok(from >= 0, `setup.js has no ${name}`);
  return setup.slice(from, setup.indexOf("\n  function ", from + 1));
}

/** A function a module exports, to its closing brace. */
function exported(source, name) {
  const from = source.search(new RegExp(`export (?:async )?function ${name}\\(`));
  assert.ok(from >= 0, `no export ${name}`);
  return source.slice(from, source.indexOf("\n}\n", from) + 2);
}

/** A computer that collects into its own server, from both agents, as peer `chen`. */
const COLLECTS = { ...HERE, user: { peerId: "chen" }, agents: { claude: true, codex: true }, team: { hub: null, localHost: null, computer: "studio" } };

/** First setup's state after a team's login, on a computer that joins it alone. */
function joining(context, { peer = "chen-example-com", server = "here" } = {}) {
  return {
    path: "link",
    joinOnly: true,
    verify: false,
    team: { hub: HUB, name: "우리 팀", me: { member: true, email: "chen@example.com", peer, servers: [] }, directory: { people: [], servers: [] } },
    draft: { ...collectDraft(context), server },
    models: { chosen: new Set(["codex"]), counts: { codex: 1, claude: 1 } },
    mates: new Set(),
    requested: [],
    tasks: [],
  };
}

const saved = globalThis.fetch;
afterEach(() => { globalThis.fetch = saved; });

test("a setup whose checks pass shows 대화 모으기, 기억 서버 and 임베딩 with what each runs, and no button", () => {
  const rows = checkRows(doctor(), verify(), { context: HERE, expected: LOCAL });
  assert.deepEqual(shown(rows), [
    { name: "대화 모으기", ok: true, value: "0.8.14" },
    { name: "기억 서버", ok: true, value: "127.0.0.1:8001" },
    { name: "임베딩", ok: true, value: "" },
  ]);
  assert.ok(rows.every((item) => !item.problems.length && !item.actions.length));
  assert.equal(failures(rows), 0);
  // A server on another computer has no verify, so no 임베딩 row.
  assert.deepEqual(shown(checkRows(doctor({}, MINE), null, { context: AWAY, expected: MINE })), [
    { name: "대화 모으기", ok: true, value: "0.8.14" },
    { name: "기억 서버", ok: true, value: "memory-me.example.com" },
  ]);
  // The other servers some folders go to are a row each; the app, only when it is behind.
  const company = doctor();
  company.checks.push({ name: "target-company", ok: true, url: "https://memory.example.com", health: { ok: true }, workspace: { ok: true } });
  const withTarget = checkRows(company, null, { context: { ...HERE, targets: [{ id: "company", label: "회사", url: "https://memory.example.com" }] }, expected: LOCAL });
  assert.deepEqual(withTarget.map((item) => item.name), ["대화 모으기", "기억 서버", "회사"]);
});

test("a failed row says what is wrong and offers what to press, and 다시 점검 every time", () => {
  const FIX = "/team-memory doctor";
  // Behind this version: 고치기, which runs doctor --fix. The `fix` line itself is never shown.
  const behind = checkRows(doctor({
    runtime: { ok: false, actualVersion: "0.8.13", fix: FIX },
    "server-version": { ok: false, fix: FIX },
    app: { ok: false, version: "0.8.13", fix: FIX },
  }), verify(), { context: HERE, expected: LOCAL });
  assert.deepEqual(row(behind, "대화 모으기").problems, ["대화 모으기가 옛 판(0.8.13)입니다."]);
  assert.deepEqual(buttons(row(behind, "대화 모으기")), ["고치기", "다시 점검"]);
  assert.deepEqual(row(behind, "기억 서버").problems, ["기억 서버가 옛 판입니다."]);
  assert.deepEqual(buttons(row(behind, "기억 서버")), ["고치기", "다시 점검"]);
  assert.deepEqual(shown([behind.at(-1)]), [{ name: "앱", ok: false, value: "0.8.13" }]);
  assert.deepEqual(buttons(behind.at(-1)), ["고치기", "다시 점검"]);
  assert.equal(JSON.stringify(behind.map((item) => item.problems)).includes(FIX), false);
  assert.deepEqual(row(checkRows(doctor({ runtime: { ok: false, missingFiles: ["mcp-server.mjs"], fix: FIX } }), null, { context: HERE }), "대화 모으기").problems, ["대화 모으기 파일이 빠졌습니다."]);

  // The server here not answering: 서버 켜기, once, however many checks saw it.
  const down = checkRows(doctor({ "honcho-health": NO_ANSWER, "honcho-workspaces": NO_ANSWER }), verify({
    status: { ok: false },
    honcho: { ok: false, status: null },
  }), { context: HERE, expected: LOCAL });
  assert.deepEqual(row(down, "기억 서버").problems, ["기억 서버가 답하지 않습니다."]);
  assert.deepEqual(buttons(row(down, "기억 서버")), ["서버 켜기", "다시 점검"]);
  assert.deepEqual(row(checkRows(doctor({ "honcho-health": NO_ANSWER }), null, { context: HERE }), "기억 서버").problems, ["기억 서버가 답하지 않습니다."]);
  const stopped = checkRows(doctor({ "honcho-health": NO_ANSWER }), verify({ status: { ok: false, running: false, docker: { installed: true, running: false } } }), { context: HERE });
  assert.deepEqual(row(stopped, "기억 서버").problems, ["Docker Desktop이 꺼져 있습니다."]);
  assert.deepEqual(buttons(row(stopped, "기억 서버")), ["서버 켜기", "다시 점검"]);
  // One on another computer is started where it runs.
  const away = checkRows(doctor({ "honcho-health": NO_ANSWER }, MINE), null, { context: AWAY, expected: MINE });
  assert.deepEqual(row(away, "기억 서버").problems, ["기억 서버가 답하지 않습니다. 서버를 둔 컴퓨터에서 서버를 켜세요."]);
  assert.deepEqual(buttons(row(away, "기억 서버")), ["다시 점검"]);

  // A server that refuses this computer, or one that is not the server chosen: 대화 수집 수정.
  const refused = checkRows(doctor({ "honcho-health": { ok: false, status: 302, access: true } }, MINE), null, { context: AWAY, expected: MINE });
  assert.deepEqual(row(refused, "기억 서버").problems, ["기억 서버가 이 컴퓨터의 요청을 막았습니다."]);
  assert.deepEqual(buttons(row(refused, "기억 서버")), ["대화 수집 수정", "다시 점검"]);
  const elsewhere = checkRows(doctor(), verify(), { context: HERE, expected: MINE });
  assert.deepEqual(row(elsewhere, "기억 서버").problems, ["대화가 memory-me.example.com 대신 127.0.0.1:8001에 쌓이게 돼 있습니다."]);
  assert.deepEqual(row(elsewhere, "기억 서버").actions[0], { kind: "collect", label: "대화 수집 수정" });

  // A plugin setup could not install: 명령 복사 with the commands setup gave, both agents' in one.
  const done = { nextSteps: [
    { agent: "claude", action: "install-plugin", commands: ["claude plugin marketplace add team-memory-system/team-memory", "claude plugin install team-memory@team-memory --scope user"] },
    { agent: "codex", action: "install-plugin", commands: ["codex plugin marketplace add team-memory-system/team-memory"] },
    { agent: "codex", action: "approve-hook" },
  ] };
  const missing = { "claude-plugin": { ok: false, installed: false, enabled: false, pluginIds: [] }, "claude-hook": { ok: false }, "codex-plugin": { ok: false, installed: false, enabled: false } };
  const plugins = row(checkRows(doctor(missing), null, { context: HERE, done }), "대화 모으기");
  assert.deepEqual(plugins.problems, ["Claude Code에 팀 메모리 플러그인이 없습니다.", "Codex에 팀 메모리 플러그인이 없습니다."]);
  assert.deepEqual(plugins.actions, [
    { kind: "copy", label: "명령 복사", text: [...done.nextSteps[0].commands, ...done.nextSteps[1].commands].join("\n") },
    { kind: "recheck", label: "다시 점검" },
  ]);
  // One turned off in Claude Code: the command that turns it on.
  const off = row(checkRows(doctor({ "claude-plugin": { ok: false, enabled: false }, "claude-hook": { ok: false } }), null, { context: HERE }), "대화 모으기");
  assert.deepEqual(off.problems, ["Claude Code에 팀 메모리 플러그인이 꺼져 있습니다."]);
  assert.equal(off.actions[0].text, "claude plugin enable team-memory@team-memory");

  // The embedding model not answering, and verify that could not run.
  const embedding = row(checkRows(doctor(), verify({ embedding: { ok: false, status: null, error: "Ollama embedding request failed" } }), { context: HERE }), "임베딩");
  assert.deepEqual(embedding.problems, ["임베딩 모델(Ollama)이 답하지 않습니다."]);
  assert.deepEqual(buttons(embedding), ["서버 켜기", "다시 점검"]);
  assert.deepEqual(row(checkRows(doctor(), { ok: false, error: "spawn failed" }, { context: HERE }), "임베딩").problems, ["임베딩을 점검하지 못했습니다."]);
  // Doctor that did not answer.
  assert.deepEqual(checkRows(null, null).map(({ name, ok, problems }) => ({ name, ok, problems })), [{ name: "점검", ok: false, problems: ["점검하지 못했습니다."] }]);

  for (const rows of [behind, down, away, refused, elsewhere, [plugins, off, embedding]]) {
    for (const item of rows) {
      assert.equal(item.ok, !item.problems.length);
      if (!item.ok) assert.equal(buttons(item).at(-1), "다시 점검", `${item.name} ends with 다시 점검`);
      else assert.deepEqual(item.actions, []);
    }
  }
});

test("a plugin to install copies its own repository's commands when setup gave none, and is no to-do too", async () => {
  // The same two commands scripts/host-plugins.mjs gives a person.
  for (const host of ["claude", "codex"]) {
    assert.deepEqual(INSTALL_COMMANDS[host], manualCommands(host, { source: DEFAULT_SOURCE, marketplace: DEFAULT_MARKETPLACE }));
  }
  const missing = { "claude-plugin": { ok: false, installed: false, enabled: false, pluginIds: [] }, "codex-plugin": { ok: false, installed: false, enabled: false } };
  const rows = checkRows(doctor(missing), null, { context: HERE });
  assert.deepEqual(row(rows, "대화 모으기").actions, [
    { kind: "copy", label: "명령 복사", text: [...INSTALL_COMMANDS.claude, ...INSTALL_COMMANDS.codex].join("\n") },
    { kind: "recheck", label: "다시 점검" },
  ]);
  assert.deepEqual([...missingPlugins(rows)], ["claude", "codex"]);
  assert.deepEqual([...missingPlugins(checkRows(doctor(), null, { context: HERE }))], []);
  assert.equal(missingPlugins(checkRows(null, null)), null, "a check that could not be made tells nothing");

  // The to-dos after 적용: the install, until 점검 says; then not for an agent its row copies the commands for,
  // and an agent 점검 found the plugin in has only what comes after an install.
  const done = { nextSteps: [{ agent: "claude", action: "install-plugin", commands: INSTALL_COMMANDS.claude }] };
  const agents = new Set(["claude", "codex"]);
  assert.deepEqual(todoAgents(done, agents), [{ name: "claude", commands: INSTALL_COMMANDS.claude }, { name: "codex", commands: [] }]);
  assert.deepEqual(todoAgents(done, agents, { missing: new Set(["claude"]) }), [{ name: "codex", commands: [] }]);
  assert.deepEqual(todoAgents(done, agents, { missing: new Set() }), [{ name: "claude", commands: [] }, { name: "codex", commands: [] }]);
  // The end screen asks with what 점검 found.
  const finish = setupPart(await read("ui/views/setup.js"), "function finish(");
  assert.match(finish, /agentTodo\(state\.applied, state\.draft\.agents, \{ missing: missingPlugins\(rows\) \}\)/);
  assert.match(finish, /const failed = failures\(rows\);\n\s*const count = items\.length \+ failed;/);
});

test("임베딩 follows 기억 서버 when that row says Ollama is not there, and is no failure of its own", () => {
  const OLLAMA_DOWN = { running: true, routerHealthy: true, gatewayLoggedIn: true, ollamaHealthy: false, embeddingResident: false };
  const cases = [
    [verify({ status: { ok: false, host: OLLAMA_DOWN }, embedding: { ok: false, status: null } }), "Ollama가 응답하지 않습니다."],
    [verify({ status: { ok: false, host: { ...OLLAMA_DOWN, ollamaHealthy: true } }, embedding: { ok: false, status: null } }), "Ollama가 아직 임베딩 모델을 불러오지 못했습니다."],
    [verify({ containerHost: { ok: false, ollama: { ok: false, status: null } }, embedding: { ok: false, status: null } }), "기억 서버가 Ollama를 부르지 못합니다."],
  ];
  for (const [verified, said] of cases) {
    const rows = checkRows(doctor({ "honcho-health": verified.checks.status.ok ? {} : NO_ANSWER }), verified, { context: HERE, expected: LOCAL });
    assert.deepEqual(row(rows, "기억 서버").problems, [said]);
    assert.deepEqual(buttons(row(rows, "기억 서버")), ["서버 켜기", "다시 점검"]);
    const embedding = row(rows, "임베딩");
    assert.deepEqual({ ok: embedding.ok, follows: embedding.follows, problems: embedding.problems, actions: embedding.actions }, { ok: false, follows: true, problems: [], actions: [] });
    assert.equal(failures(rows), 1, said);
  }
  // With Ollama there, an embedding that fails is its own row's failure.
  const own = checkRows(doctor(), verify({ embedding: { ok: false, status: 500 } }), { context: HERE, expected: LOCAL });
  assert.equal(row(own, "임베딩").follows, undefined);
  assert.equal(failures(own), 1);
});

test("a 고치기 that makes the server again says so before it is pressed, and its rows read as fix.json gives them", async () => {
  // The update's own words for the same rebuild (scripts/update.mjs).
  assert.ok((await read("scripts/update.mjs")).includes(`"${REBUILD_NOTE}"`));
  const FIX = "/team-memory doctor";
  const rebuild = checkRows(doctor({ runtime: { ok: false, actualVersion: "0.8.13", fix: FIX }, "server-version": { ok: false, fix: FIX } }), verify(), { context: HERE, expected: LOCAL });
  const fixes = rebuild.flatMap((item) => item.actions).filter((action) => action.kind === "fix");
  assert.equal(fixes.length, 2);
  for (const action of fixes) assert.equal(action.note, REBUILD_NOTE, "one 고치기 fixes all that is behind, the server too");
  const runtimeOnly = checkRows(doctor({ runtime: { ok: false, actualVersion: "0.8.13", fix: FIX } }), verify(), { context: HERE, expected: LOCAL });
  assert.equal(row(runtimeOnly, "대화 모으기").actions[0].note, undefined);

  // fix.json's rows, as the box draws them while 고치기 runs.
  assert.deepEqual(fixLines(null), [{ label: "고치는 중" }, { state: "run", title: "고치기" }]);
  assert.deepEqual(fixLines({ kind: "fix", state: "running", rows: [
    { id: "runtime", title: "대화 모으기", state: "ok" },
    { id: "server", title: "기억 서버 다시 만들기", sub: "몇 분에서 10분 넘게 걸립니다.", state: "run" },
    { id: "app", title: "앱 다시 켜기", state: "wait" },
  ] }), [
    { label: "고치는 중" },
    { state: "ok", title: "대화 모으기", sub: undefined },
    { state: "run", title: "기억 서버 다시 만들기", sub: "몇 분에서 10분 넘게 걸립니다." },
    { state: "wait", title: "앱 다시 켜기", sub: undefined },
  ]);
  assert.deepEqual(fixLines({ kind: "fix", state: "login", rows: [{ id: "login", title: "구독 계정 로그인", state: "login", error: "구독 계정의 로그인이 풀려 있습니다." }] })[1],
    { state: "bad", title: "구독 계정 로그인", sub: "구독 계정의 로그인이 풀려 있습니다." });
  assert.deepEqual(fixLines({ kind: "fix", state: "failed", rows: [{ id: "server", title: "기억 서버 다시 만들기", sub: "몇 분", state: "bad", error: "Docker Desktop is not running" }] })[1],
    { state: "bad", title: "기억 서버 다시 만들기", sub: "Docker Desktop is not running" });

  // What it says after: doctor --fix's answer, a refusal, or fix.json's once the request ended with the app.
  assert.deepEqual(fixOutcome({ ok: true, checks: [], fixed: { ok: true, steps: ["runtime"] }, said: "대화 모으기를 0.8.14로 바꿨습니다." }, null), { text: "대화 모으기를 0.8.14로 바꿨습니다.", bad: false });
  assert.deepEqual(fixOutcome({ ok: true, checks: [], fixed: { ok: false, steps: [] }, said: "기억 서버를 새 판으로 다시 시작하지 못했습니다." }, null), { text: "기억 서버를 새 판으로 다시 시작하지 못했습니다.", bad: true });
  assert.deepEqual(fixOutcome({ ok: false, code: "updating", said: "업데이트가 도는 중입니다." }, null), { text: "업데이트가 도는 중입니다.", bad: true });
  assert.equal(fixOutcome({ ok: true, checks: [] }, null), null, "nothing to fix says nothing");
  assert.deepEqual(fixOutcome(null, { state: "done", said: "앱을 새 판으로 다시 켰습니다." }), { text: "앱을 새 판으로 다시 켰습니다.", bad: false });
  assert.deepEqual(fixOutcome(null, { state: "failed", said: "기억 서버를 다시 만들지 못했습니다: Docker Desktop is not running" }), { text: "기억 서버를 다시 만들지 못했습니다: Docker Desktop is not running", bad: true });
  assert.deepEqual(fixOutcome(null, null), { text: "고치지 못했습니다.", bad: true });
});

test("고치기 cut off by the app starting again reads its rows and what it did from fix.json, not as a failure", async () => {
  const json = (body) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  const rows = [{ id: "runtime", title: "대화 모으기", state: "ok" }, { id: "app", title: "앱 다시 켜기", state: "run" }];
  const before = { kind: "fix", state: "done", startedAt: "2026-10-18T00:00:00.000Z", rows: [], said: "지난번" };
  const running = { kind: "fix", state: "running", startedAt: "2026-10-19T09:00:00.000Z", rows };
  const finished = { ...running, state: "done", rows: rows.map((item) => ({ ...item, state: "ok" })), said: "대화 모으기를 0.8.14로 바꾸고 앱을 새 판으로 다시 켰습니다." };
  // The app goes down with the request, says nothing for a read, then answers from fix.json.
  const reads = [before, "down", running, finished];
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push(`${init.method || "GET"} ${url}`);
    if (url === "/api/doctor/fix") throw new TypeError("fetch failed");
    const next = reads.length > 1 ? reads.shift() : reads[0];
    if (next === "down") throw new TypeError("fetch failed");
    return json({ ok: true, progress: next });
  };
  const drawn = [];
  const outcome = await runFix((lines) => drawn.push(lines), { every: 1 });
  assert.deepEqual(outcome, { text: finished.said, bad: false });
  assert.equal(calls.filter((call) => call === "POST /api/doctor/fix").length, 1);
  assert.deepEqual(drawn.map((lines) => lines.slice(1).map((line) => `${line.title} ${line.state}`)), [
    ["고치기 run"],
    ["대화 모으기 ok", "앱 다시 켜기 run"],
    ["대화 모으기 ok", "앱 다시 켜기 ok"],
  ], "the fix before this one is never drawn");

  // A request that answers: its answer, with fix.json's rows drawn while it went.
  const answer = { ok: true, checks: [], fixed: { ok: true, steps: ["runtime"] }, said: "대화 모으기를 0.8.14로 바꿨습니다." };
  let release;
  const answered = new Promise((resolve) => { release = resolve; });
  const statuses = [{ ok: true, progress: null }, { ok: true, progress: running }];
  globalThis.fetch = async (url) => {
    if (url === "/api/doctor/fix") { await answered; return json(answer); }
    const next = statuses.length > 1 ? statuses.shift() : statuses[0];
    if (next.progress === running) release();
    return json(next);
  };
  const seen = [];
  assert.deepEqual(await runFix((lines) => seen.push(lines.length), { every: 1 }), { text: answer.said, bad: false });
  assert.ok(seen.includes(3), "fix.json's two rows under 고치는 중");

  // Refused because a 고치기 runs already (one this request was sent again into, after the app
  // started again): that one's rows, and what it did, from fix.json.
  const other = { ...running, startedAt: "2026-10-19T08:59:00.000Z" };
  const states = [{ ok: true, progress: other }, { ok: true, progress: other }, { ok: true, progress: { ...other, state: "done", said: finished.said } }];
  globalThis.fetch = async (url) => {
    if (url === "/api/doctor/fix") return json({ ok: false, code: "fixing", said: "고치기가 이미 도는 중입니다. 끝나기를 기다리세요.", checks: [] });
    return json(states.length > 1 ? states.shift() : states[0]);
  };
  assert.deepEqual(await runFix(() => {}, { every: 1 }), { text: finished.said, bad: false });

  // The app never answering again ends the wait with what is known.
  globalThis.fetch = async () => { throw new TypeError("fetch failed"); };
  assert.deepEqual(await runFix(() => {}, { every: 1 }), { text: "고치지 못했습니다.", bad: true });
  // Another refusal says why.
  globalThis.fetch = async (url) => json(url === "/api/doctor/fix" ? { ok: false, code: "updating", said: "업데이트가 도는 중입니다.", checks: [] } : { ok: true, progress: null });
  assert.deepEqual(await runFix(() => {}, { every: 1 }), { text: "업데이트가 도는 중입니다.", bad: true });
});

test("a setup that stores nothing looks at the team login and the teammates' servers login alone", async () => {
  const SERVER = "memory-bob.example.com";
  const status = { ok: true, hub: HUB, email: "me@example.com", hubLogin: { signedIn: true }, serversLogin: { signedIn: true, host: SERVER } };
  assert.deepEqual(shown(teamCheckRows(status, { host: SERVER })), [
    { name: "팀 로그인", ok: true, value: "me@example.com" },
    { name: "팀 서버 로그인", ok: true, value: "" },
  ]);
  const notYet = teamCheckRows({ ...status, serversLogin: { signedIn: false } }, { host: SERVER });
  assert.deepEqual(notYet[1].problems, ["팀원 기억을 읽으려면 팀 서버 로그인이 한 번 필요합니다."]);
  assert.deepEqual(notYet[1].actions, [{ kind: "login", login: "servers", host: SERVER, label: "팀 서버 로그인" }, { kind: "recheck", label: "다시 점검" }]);
  const ended = teamCheckRows({ ...status, hubLogin: { signedIn: false, ended: { email: "me@example.com" } } }, { host: SERVER });
  assert.deepEqual(ended[0].problems, ["me@example.com 계정의 팀 로그인이 끝났습니다. 다시 로그인하세요."]);
  assert.deepEqual(buttons(ended[0]), ["다시 로그인", "다시 점검"]);
  // A team with no teammate's server yet has no servers login to ask for.
  assert.deepEqual(teamCheckRows({ ...status, serversLogin: { signedIn: false } }).map((item) => item.name), ["팀 로그인"]);
  assert.deepEqual(teamCheckRows(null).map(({ name, problems }) => ({ name, problems })), [{ name: "점검", problems: ["점검하지 못했습니다."] }]);

  // The window asks the team's status for it, and neither doctor nor verify: with nothing
  // collected, doctor's setup and runtime checks always fail.
  const setup = await read("ui/views/setup.js");
  const check = setupPart(setup, "function checkAll(");
  const none = check.slice(check.indexOf('if (state.draft.server === "none") {'), check.indexOf("\n    }\n"));
  assert.match(none, /return checkTeam\(\{ host \}\);/);
  assert.match(check, /return checkHere\(\{ verify: state\.verify, expected: expectedServer\(\), done: state\.applied \}\);/);
  const team = exported(await read("ui/lib/check.js"), "checkTeam");
  assert.match(team, /teamCheckRows\(await teamStatus\(\)/);
  assert.equal(/\/api\/status|\/api\/server\/verify/.test(team), false);
});

test("Docker Desktop's window is spelled out for a plan that installs Docker, and only for one", () => {
  const plan = (operations) => ({ ok: true, ready: true, operations, warnings: [] });
  assert.equal(dockerSteps(plan([{ type: "install-ollama" }, { type: "write-environment" }])), null);
  assert.equal(dockerSteps(plan([{ type: "start-docker-desktop", app: "/Applications/Docker.app" }])), null);
  assert.equal(dockerSteps({ ok: false, issues: ["Docker CLI is not installed"] }), null);
  assert.equal(dockerSteps(null), null);
  const mac = dockerSteps(plan([{ type: "install-docker-desktop", url: "https://desktop.docker.com/mac/main/arm64/Docker.dmg", download: "/Users/me/Library/Application Support/TeamMemory/runtime/downloads/Docker.dmg" }]));
  assert.equal(mac.length, 3);
  for (const words of [/약관에 동의/, /Use recommended settings/, /Mac 암호/, /로그인과 설문은 건너뛰세요/]) assert.match(mac[0], words);
  assert.match(mac[1], /직원 250명 이상이거나 연 매출 1천만 달러 이상인 회사와 정부 기관에서는 유료 구독이 필요합니다/);
  assert.match(mac[2], /구독 게이트웨이는 Mac에 로그인할 때 저절로 켜집니다/);
  // Windows's installer accepts Docker's terms itself: the line says so, and asks for the approval.
  const windows = dockerSteps(plan([{ type: "install-docker-desktop", url: "https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe", download: "C:\\Users\\me\\Docker Desktop Installer.exe" }]));
  assert.match(windows[0], /Windows가 묻는 창에서 예를 누르세요/);
  assert.match(windows[1], /^설치하면 Docker Desktop 약관에 동의합니다\. .*유료 구독이 필요합니다\.$/);
  assert.match(windows[2], /Windows에 로그인할 때/);
  assert.equal(windows.some((line) => /Mac/.test(line)), false);
});

test("what the window keeps holds no secret, and opened again it is back at 적용 with the rows done kept done", () => {
  const SECRETS = ["tok-SECRET-1", "cid-SECRET-2", "csec-SECRET-3", "extra-SECRET-4", "cf-SECRET-5", "applied-SECRET-6", "query-SECRET-7"];
  const context = { configured: false, localServer: null, honcho: { url: "" }, user: { peerId: "" }, team: null, targets: [] };
  const draft = collectDraft(context);
  Object.assign(draft, {
    server: "remote",
    // An address with something after its path: kept as its origin and path only.
    remoteUrl: `${MINE}/?token=${SECRETS[6]}#${SECRETS[6]}`,
    apiToken: SECRETS[0],
    accessClientId: SECRETS[1],
    accessClientSecret: SECRETS[2],
    userPeer: "me",
    agents: new Set(["claude", "codex"]),
    checked: new Set(["/Users/me/dev/app"]),
    projects: [{ path: "/Users/me/dev/app", name: "app", count: 12, display: "~/dev/app" }, { path: "/Users/me/tmp", name: "tmp", count: 2 }],
  });
  draft.extra.apiToken = SECRETS[3];
  draft.past.totals = { put: 3, dupes: 1 };
  draft.past.scan = { running: false, chatgpt: [{ id: "f1", name: "conversations.json", applied: true, size: 10 }] };
  const steps = [{ agent: "codex", action: "approve-hook", message: "Open a new Codex session." }];
  const state = {
    path: "solo",
    joinOnly: false,
    verify: false,
    docker: ["Docker Desktop 창에서 약관에 동의하세요."],
    team: { hub: "", name: "", me: null, directory: null, apiToken: SECRETS[4], email: "" },
    login: { phase: "idle", tab: null },
    draft,
    models: { chosen: new Set(["claude"]), counts: { codex: 1, claude: 2 } },
    roles: { deriver: { model: "claude-opus-4-6", effort: "high" } },
    picked: new Set(["deriver.model"]),
    mates: new Set(),
    requested: [],
    applied: { ok: true, nextSteps: steps, config: { honcho: { token: SECRETS[5] } } },
    plan: { total: 3, considered: 4 },
    filling: false,
    tasks: [
      { label: "기억 서버" },
      { key: "reach", title: "내 서버 연결", sub: "memory-me.example.com", state: "ok" },
      { label: "에이전트" },
      { key: "plugin", first: true, title: "Claude Code에 플러그인 설치", state: "bad", error: "설정하지 못했습니다." },
      { key: "plugin", first: false, title: "Codex에 플러그인 설치", state: "wait" },
      { label: "점검" },
      { key: "check", title: "점검", sub: "대화 모으기, 기억 서버", state: "wait" },
    ],
  };
  state.tasks[1].extra = { nodeName: "DIV" };
  const kept = JSON.parse(JSON.stringify(setupSnapshot(state)));
  const text = JSON.stringify(kept);
  for (const secret of SECRETS) assert.equal(text.includes(secret), false, `${secret} is kept`);
  for (const name of ["apiToken", "accessClientId", "accessClientSecret", "extra", "docker"]) assert.equal(text.includes(`"${name}"`), false, `${name} is kept`);
  assert.equal(kept.draft.remoteUrl, MINE);

  const back = restoreSetup(kept, context);
  assert.deepEqual(back.tasks.map((task) => task.label || `${task.key} ${task.state}`), ["기억 서버", "reach ok", "에이전트", "plugin wait", "plugin wait", "점검", "check wait"]);
  assert.equal(back.tasks[3].error, null);
  assert.equal(back.path, "solo");
  assert.equal(back.draft.server, "remote");
  assert.equal(back.draft.remoteUrl, MINE);
  assert.equal(back.draft.apiToken, "");
  assert.deepEqual([...back.draft.agents], ["claude", "codex"]);
  assert.deepEqual([...back.draft.checked], ["/Users/me/dev/app"]);
  assert.deepEqual(back.draft.projects.map((project) => project.path), ["/Users/me/dev/app", "/Users/me/tmp"]);
  assert.deepEqual(back.draft.past.totals, { put: 3, dupes: 1 });
  assert.deepEqual(back.draft.past.scan.chatgpt, [{ id: "f1", applied: true }]);
  assert.deepEqual([...back.models.chosen], ["claude"]);
  assert.equal(back.models.counts.claude, 2);
  assert.deepEqual([...back.picked], ["deriver.model"]);
  assert.deepEqual(back.applied, { nextSteps: steps });
  assert.deepEqual(back.plan, { total: 3, considered: 4 });
  // Docker Desktop's window is read from the plan again: a restart may have installed it.
  assert.equal(back.docker, undefined);
  assert.equal(restoreSetup({ ...kept, docker: ["옛 안내"] }, context).docker, undefined, "one kept by the version before");
  // Nothing kept, a kept setup this app does not know, or another team's link: the window starts anew.
  assert.equal(resumable(kept), true);
  for (const nothing of [null, { ...kept, version: 0 }, { ...kept, tasks: [] }]) {
    assert.equal(resumable(nothing), false);
    assert.equal(restoreSetup(nothing, context), null);
  }
  const joined = { ...kept, path: "link", team: { ...kept.team, hub: HUB } };
  assert.equal(restoreSetup(joined, context, { link: "team.other.example" }), null);
  assert.equal(restoreSetup(joined, context, { link: HUB }).path, "link");
});

test("my server's address takes no login, query or fragment: the token has its own field", () => {
  assert.equal(remoteUrlProblem(MINE), null);
  assert.equal(remoteUrlProblem(`${MINE}/`), null);
  assert.equal(remoteUrlProblem("http://192.168.0.10:8001"), null);
  for (const value of [`${MINE}/?token=abc`, `${MINE}#abc`, "https://me:pw@memory-me.example.com"]) {
    assert.equal(remoteUrlProblem(value), "기억 서버 주소에 아이디·비밀번호·물음표 뒤 값을 넣지 마세요. token은 서버 token 칸에 넣습니다.", value);
  }
  for (const value of ["", "memory-me.example.com", "ftp://memory-me.example.com"]) {
    assert.equal(remoteUrlProblem(value), "다른 컴퓨터 서버의 주소를 http:// 나 https:// 로 시작하게 넣으세요.", value);
  }
});

test("a window opened again runs nothing by itself: its rows wait for 이어서 하기, and 처음부터 starts anew", async () => {
  const setup = await read("ui/views/setup.js");
  assert.match(setup, /const resumed = restoreSetup\(kept, app\.context, \{ link \}\);/);
  assert.match(setup, /let paused = Boolean\(resumed\);/);
  // Opened again: at 적용, drawn, not run.
  const opened = setup.slice(setup.indexOf("  if (resumed) {"), setup.indexOf("  win.open();\n  return win;"));
  assert.match(opened, /^ {2}if \(resumed\) \{\n(?:\s*\/\/[^\n]*\n)*\s*at = stepKeys\(\)\.length - 1;\n\s*win\.steps\(stepper\(stepKeys\(\)\.map\(\(key\) => LABELS\[key\]\), "done"\)\);\n\s*draw\(\);\n\s*\} else \{\n\s*begin\(\);\n\s*\}\n$/);
  assert.equal(opened.includes("run()"), false);
  // Its two buttons, in place of the failed row's.
  const draw = setupPart(setup, "function draw(");
  assert.match(draw, /h\("h3", \{\}, "적용 중"\)/);
  assert.match(draw, /if \(paused\) \{\n\s*win\.foot\(button\("처음부터", \{ kind: "quiet", onClick: restart \}\), button\("이어서 하기", \{ kind: "primary", onClick: \(\) => \{ paused = false; run\(\); \} \}\)\);\n\s*return;\n\s*\}/);
  assert.ok(draw.indexOf("if (paused)") < draw.indexOf("설정으로 돌아가기"));
  // 처음부터: what was kept goes, and the first step again, a team link's login or the start cards.
  const restart = setupPart(setup, "function restart(");
  assert.match(restart, /dropSetup\(\);\n\s*paused = false;\n\s*state = startState\(link, app\.context\);\n\s*at = 0;\n\s*begin\(\);/);
  const begin = setupPart(setup, "function begin(");
  assert.match(begin, /if \(link\) \{\n\s*choose\("link"\);\n\s*drawStep\(\);\n\s*\} else \{\n\s*drawStart\(\);\n\s*\}/);
  // The rows 이어서 하기 runs: the ones left, the done ones skipped.
  assert.match(setupPart(setup, "async function run("), /if \(task\.label \|\| task\.state === "ok"\) continue;/);
});

test("a setup kept half way opens its window as the app starts, also on a computer set up since", async () => {
  // Not set up, every address opens first setup's window, which carries on by itself.
  assert.equal(resumeAtBoot("dashboard", { setUp: false, kept: true }), false);
  // Set up since (the server that setup installed answers): the window opens over the screen.
  assert.equal(resumeAtBoot("dashboard", { setUp: true, kept: true }), true);
  assert.equal(resumeAtBoot("", { setUp: true, kept: true }), true);
  assert.equal(resumeAtBoot("team", { setUp: true, kept: true }), true);
  assert.equal(resumeAtBoot("dashboard", { setUp: true, kept: false }), false);
  // `start` opens it anyway; a window an address opens is left to it, and its 적용 drops what was kept.
  assert.equal(resumeAtBoot("start", { setUp: true, kept: true }), false);
  assert.equal(resumeAtBoot("computer/collect", { setUp: true, kept: true }), false);
  assert.equal(resumeAtBoot("computer/past", { setUp: true, kept: true, configured: true }), false);
  assert.equal(resumeAtBoot("computer", { setUp: true, kept: true }), true);
  // An address naming a window that does not open here opens this one: 지난 대화 on a
  // computer in a team that does not collect, or a name that is no window.
  assert.equal(resumeAtBoot("computer/past", { setUp: true, kept: true, configured: false }), true);
  assert.equal(resumeAtBoot("computer/tools", { setUp: true, kept: true }), true);
  assert.equal(resumeAtBoot("computer/nope", { setUp: true, kept: true, configured: true }), true);

  const shell = await read("ui/app.js");
  const boot = shell.slice(shell.indexOf("async function boot()"));
  // The address read first: a screen a change in status shows on the way takes a window's name off it.
  assert.match(boot, /^async function boot\(\) \{\n(?:\s*\/\/[^\n]*\n)*\s*const bootPath = movedTo\(\) \|\| hashParts\(\)\.path;\n/);
  assert.match(boot, /await show\(\);\n(?:\s*\/\/[^\n]*\n)*\s*if \(resumeAtBoot\(bootPath, \{ setUp: setupDone\(\), kept: resumable\(keptSetup\(\)\), configured: app\.context\?\.configured \}\) && !setupWindow\) showSetup\(\{ firstRun: false \}\);/);
});

test("대화 수집's 수정 window drops a first setup kept half way once it applies, and ends with 점검", async () => {
  const settings = await read("ui/views/settings.js");
  const apply = settings.slice(settings.indexOf("  const apply = (control) =>"), settings.indexOf("  function showCheck("));
  assert.match(apply, /const outcome = await applySetup\(setupBody\(draft, context\)\);\n\s*if \(!outcome\.ok\) \{[^\n]*return; \}\n(?:\s*\/\/[^\n]*\n)*\s*dropSetup\(\);/);
  assert.match(apply, /onApplied\?\.\(\);\n\s*showCheck\(outcome\.result\);\n\s*\}\);/);
  assert.equal(apply.includes('win.close("ok")'), false, "the window stays for 점검");
  const show = settings.slice(settings.indexOf("  function showCheck("), settings.indexOf("  function draw("));
  assert.match(show, /checkBox\(\{\n\s*check: \(\) => checkHere\(\{ verify, expected, done \}\),/);
  assert.match(show, /onCollect: \(\) => goTo\(0\),/);
  assert.match(show, /heading\.textContent = failed \? `할 일 \$\{failed\}개` : "다 됐습니다";/);
  assert.match(show, /win\.foot\(null, button\("닫기", \{ kind: "primary", onClick: \(\) => win\.close\("ok"\) \}\)\);/);
  // First setup's end uses the same box.
  const finish = setupPart(await read("ui/views/setup.js"), "function finish(");
  assert.match(finish, /const check = checkBox\(\{\n\s*check: checkAll,/);
});

test("적용 ends with 점검, the end screen has its box, and every row runs something", async () => {
  const setup = await read("ui/views/setup.js");
  const build = exported(setup, "applyRows");
  assert.match(build, /tasks\.push\(\{ label: "점검" \}, \{ key: "check", title: "점검", sub: checkSub\(state\) \}\);\n\s*return tasks\.map/);
  const runs = setup.match(/const RUNS = \{([\s\S]*?)\n {2}\};/)[1];
  for (const key of new Set([...build.matchAll(/key: "([A-Za-z]+)"/g)].map((match) => match[1]))) {
    assert.match(runs, new RegExp(`^\\s*${key}[,:]`, "m"), `the ${key} row runs nothing`);
  }
  const finish = setupPart(setup, "function finish(");
  assert.match(finish, /"팀원 더하기로 팀원 이메일을 넣고, 팀 주소 줄의 복사를 눌러 초대 문구를 보내세요\."/);
  assert.match(finish, /win\.foot\(null, button\(nextLabel, \{ kind: "primary", onClick: \(\) => \{ win\.close\("done"\); onDone\?\.\(nextScreen\); \} \}\)\);/);
  // A computer that joins a team alone has the login and 팀원 steps alone.
  assert.match(setup, /state\.joinOnly\n\s*\? \[\.\.\.\(state\.path === "join" \? \["team"\] : \[\]\), "login", "mates"\]/);
  assert.match(setup, /state\.joinOnly = !firstRun && \["join", "link"\]\.includes\(path\) && joinsAlone\(app\.context, \{ mode: app\.prefs\.mode, answers: app\.status\?\.honcho\?\.state === "on" \}\);/);
  // The end's button.
  assert.deepEqual(endButton({ path: "solo", joinOnly: false, draft: { server: "here" } }), ["대시보드 열기", "dashboard"]);
  assert.deepEqual(endButton({ path: "make", joinOnly: false, draft: { server: "here" } }), ["관리자 탭 열기", "admin"]);
  assert.deepEqual(endButton({ path: "join", joinOnly: false, draft: { server: "none" } }), ["팀 화면 열기", "team"]);
});

test("only a computer that collects, or one in a team that stores nothing, joins a team alone", () => {
  const team = { hub: HUB, signedIn: true, loginEnded: null };
  assert.equal(joinsAlone(COLLECTS), true);
  assert.equal(joinsAlone({ ...AWAY, team: null }), true);
  // 쌓지 않기 in a team, first setup done here.
  assert.equal(joinsAlone({ configured: false, localServer: null, team }, { mode: "join" }), true);
  assert.equal(joinsAlone({ configured: false, localServer: null, team: { ...team, signedIn: false, loginEnded: { email: "me@example.com" } } }, { mode: "join" }), true);
  // A server installed but not collecting, a Honcho this app did not make answering, or no first setup here: every step.
  assert.equal(joinsAlone({ configured: false, localServer: { apiUrl: LOCAL }, team }, { mode: "join" }), false);
  assert.equal(joinsAlone({ configured: false, localServer: null, team: null }, { answers: true }), false);
  assert.equal(joinsAlone({ configured: false, localServer: null, team }, { mode: "join", answers: true }), false);
  assert.equal(joinsAlone({ configured: false, localServer: null, team }, { mode: "" }), false);
});

test("joining alone, the team's peer name goes into this computer's setup first, only when it is another", async () => {
  // The team names this person chen-example-com; this computer's setup says chen.
  const state = joining(COLLECTS);
  assert.deepEqual(peerChange(state, COLLECTS), { from: "chen", to: "chen-example-com" });
  const rows = applyRows(state, COLLECTS);
  assert.deepEqual(lines(rows), [
    "대화 수집",
    "peer: peer 이름 바꾸기 · chen → chen-example-com",
    "기억 서버",
    "share: 팀에 내 서버 열기 · 팀원이 승인을 받아 물을 수 있는 내 서버 주소를 만듭니다.",
    "점검",
    "check: 점검 · 대화 모으기, 기억 서버",
  ]);
  assert.ok(rows.every((task) => task.label || task.state === "wait"));
  // No plugin or past rows: the computer goes on collecting as it does.
  assert.equal(rows.some((task) => ["install", "reach", "found", "plugin", "line", "dupes", "onServer", "fill"].includes(task.key)), false);
  assert.deepEqual(endButton(state), ["팀 화면 열기", "team"]);

  // The same name: no row.
  const same = joining(COLLECTS, { peer: "chen" });
  assert.equal(peerChange(same, COLLECTS), null);
  assert.deepEqual(lines(applyRows(same, COLLECTS)), ["기억 서버", "share: 팀에 내 서버 열기 · 팀원이 승인을 받아 물을 수 있는 내 서버 주소를 만듭니다.", "점검", "check: 점검 · 대화 모으기, 기억 서버"]);
  // Collecting into a server on another computer: the peer row, and no server of this computer to open.
  const away = { ...AWAY, user: { peerId: "chen" }, agents: { claude: true }, team: { hub: null, localHost: null, computer: "studio" } };
  assert.deepEqual(lines(applyRows(joining(away, { server: "remote" }), away)), ["대화 수집", "peer: peer 이름 바꾸기 · chen → chen-example-com", "점검", "check: 점검 · 대화 모으기, 기억 서버"]);
  // Storing nothing: no setup to rename, the team's logins checked.
  const none = { configured: false, localServer: null, honcho: { url: "" }, user: { peerId: "" }, team: { hub: HUB, signedIn: true }, targets: [] };
  const storesNothing = joining(none, { server: "none" });
  assert.equal(peerChange(storesNothing, none), null);
  assert.deepEqual(lines(applyRows(storesNothing, none)), ["점검", "check: 점검 · 팀 로그인, 팀 서버 로그인"]);
  assert.deepEqual(endButton(storesNothing), ["팀 화면 열기", "team"]);
  // Every step's way has no peer row: its setup takes the team's name with the rest.
  assert.equal(peerChange({ ...state, joinOnly: false }, COLLECTS), null);

  // The row runs setup apply with the peer name alone, which keeps the server, the folders and the agents.
  const setup = await read("ui/views/setup.js");
  const rename = setupPart(setup, "async function renamePeer(");
  assert.match(rename, /const peer = peerChange\(state, app\.context\);\n\s*if \(!peer\) return;\n\s*const outcome = await applySetup\(\{ userPeer: peer\.to \}\);/);
  assert.match(setup.match(/const RUNS = \{([\s\S]*?)\n {2}\};/)[1], /^\s*peer: renamePeer,$/m);
});

test("the move to another team names the servers it stops collecting into, or nothing when it cannot tell", async () => {
  const team = { hub: HUB, localHost: null };
  assert.deepEqual(teamServers({ configured: true, honcho: { url: MINE }, team, targets: [] }), ["내 서버 memory-me.example.com"]);
  assert.deepEqual(teamServers({
    configured: true,
    honcho: { url: LOCAL },
    team,
    targets: [
      { id: "company", label: "회사", url: "https://memory.example.com", team: true, enabled: true },
      { id: "lab", label: "연구실", url: "https://memory.lab.org", team: false, enabled: true },
      { id: "waiting", label: "다른 회사", url: "https://memory-x.example.com", team: true, enabled: false },
    ],
  }), ["회사 memory.example.com"]);
  // A server reached with a token of its own does not go by the team's login.
  assert.deepEqual(teamServers({ configured: true, honcho: { url: MINE, hasToken: true }, team, targets: [] }), []);
  assert.deepEqual(teamServers({ configured: true, honcho: { url: "https://memory.other.org" }, team, targets: [] }), []);
  assert.deepEqual(teamServers({ configured: true, honcho: { url: MINE }, team: null, targets: [] }), []);

  const setup = await read("ui/views/setup.js");
  const step = setupPart(setup, "function loginStep(");
  assert.equal(step.includes("한 컴퓨터는 팀 하나에만 들어갑니다."), false);
  assert.match(step, /stops\.length \? h\("div", \{ class: "hint" \}, `옮기면 지금 팀을 거쳐 쌓던 서버에는 더 쌓지 않습니다: \$\{stops\.join\(", "\)\}`\) : null/);
});
