// The end of first setup (views/setup.js): 적용's last row is 점검, and the window
// then shows what it found beside what is left to do. What matters: doctor's checks,
// and `server verify` for a server on this computer, become the rows 대화 모으기,
// 기억 서버 and 임베딩, each passing one with what it runs and each failed one with
// what is wrong and what to press (고치기, 서버 켜기, 명령 복사, 대화 수집 수정, and
// always 다시 점검), never the terminal's `fix` line; a setup that stores nothing
// looks at the team's logins alone; Docker Desktop's own window is spelled out only
// for a plan that installs it; and what the window keeps for opening again holds no
// secret and comes back at 적용, the rows done kept done.
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { checkRows, collectDraft, dockerSteps, teamCheckRows, teamServers } from "../ui/lib/collect.js";
import { restoreSetup, setupSnapshot } from "../ui/views/setup.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL = "http://127.0.0.1:8001";
const MINE = "https://memory-me.example.com";
const HERE = { configured: true, localServer: { apiUrl: LOCAL }, honcho: { url: LOCAL }, team: null, targets: [] };
const AWAY = { configured: true, localServer: null, honcho: { url: MINE }, team: null, targets: [] };
// What doctor's probe gives for a server that does not answer at all.
const NO_ANSWER = { ok: false, status: undefined, error: "fetch failed" };

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

/** A function of openSetup in views/setup.js, up to the next one. */
function setupPart(setup, name) {
  const from = setup.indexOf(`  ${name}`);
  assert.ok(from >= 0, `setup.js has no ${name}`);
  return setup.slice(from, setup.indexOf("\n  function ", from + 1));
}

test("a setup whose checks pass shows 대화 모으기, 기억 서버 and 임베딩 with what each runs, and no button", () => {
  const rows = checkRows(doctor(), verify(), { context: HERE, expected: LOCAL });
  assert.deepEqual(shown(rows), [
    { name: "대화 모으기", ok: true, value: "0.8.14" },
    { name: "기억 서버", ok: true, value: "127.0.0.1:8001" },
    { name: "임베딩", ok: true, value: "" },
  ]);
  assert.ok(rows.every((item) => !item.problems.length && !item.actions.length));
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
  assert.deepEqual(buttons(row(checkRows(doctor(missing), null, { context: HERE }), "대화 모으기")), ["다시 점검"]);
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

test("a setup that stores nothing looks at the team login and the teammates' servers login alone", async () => {
  const SERVER = "memory-bob.example.com";
  const status = { ok: true, hub: "team.example.com", email: "me@example.com", hubLogin: { signedIn: true }, serversLogin: { signedIn: true, host: SERVER } };
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
  const setup = await fsp.readFile(path.join(ROOT, "ui", "views", "setup.js"), "utf8");
  const check = setup.slice(setup.indexOf("  async function checkAll("), setup.indexOf("\n  }\n", setup.indexOf("  async function checkAll(")));
  const none = check.slice(check.indexOf('if (state.draft.server === "none") {'), check.indexOf("return;"));
  assert.match(none, /teamCheckRows\(await teamStatus\(\)/);
  assert.equal(/\/api\/status|\/api\/server\/verify/.test(none), false);
  assert.ok(check.indexOf("return;") < check.indexOf('"/api/status"'));
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
  const SECRETS = ["tok-SECRET-1", "cid-SECRET-2", "csec-SECRET-3", "extra-SECRET-4", "cf-SECRET-5", "applied-SECRET-6"];
  const context = { configured: false, localServer: null, honcho: { url: "" }, user: { peerId: "" }, team: null, targets: [] };
  const draft = collectDraft(context);
  Object.assign(draft, {
    server: "remote",
    remoteUrl: MINE,
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
    docker: null,
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
  for (const name of ["apiToken", "accessClientId", "accessClientSecret", "extra"]) assert.equal(text.includes(`"${name}"`), false, `${name} is kept`);

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
  assert.equal(back.docker, null);
  // Nothing kept, a kept setup this app does not know, or another team's link: the window starts anew.
  assert.equal(restoreSetup(null, context), null);
  assert.equal(restoreSetup({ ...kept, version: 0 }, context), null);
  assert.equal(restoreSetup({ ...kept, tasks: [] }, context), null);
  const joined = { ...kept, path: "link", team: { ...kept.team, hub: "team.example.com" } };
  assert.equal(restoreSetup(joined, context, { link: "team.other.example" }), null);
  assert.equal(restoreSetup(joined, context, { link: "team.example.com" }).path, "link");
});

test("적용 ends with 점검, the end screen has its box, and every row runs something", async () => {
  const setup = await fsp.readFile(path.join(ROOT, "ui", "views", "setup.js"), "utf8");
  const build = setupPart(setup, "function buildTasks(");
  assert.match(build, /tasks\.push\(\{ label: "점검" \}, \{ key: "check", title: "점검", sub: checkSub\(\) \}\);\n\s*return tasks\.map/);
  const runs = setup.match(/const RUNS = \{([\s\S]*?)\n {2}\};/)[1];
  for (const key of new Set([...build.matchAll(/key: "([A-Za-z]+)"/g)].map((match) => match[1]))) {
    assert.match(runs, new RegExp(`^\\s*${key}[,:]`, "m"), `the ${key} row runs nothing`);
  }
  const finish = setupPart(setup, "function finish(");
  assert.match(finish, /clear\(box, progressList\(checkLines\(\)\)\)/);
  assert.match(finish, /"팀원 더하기로 팀원 이메일을 넣고, 팀 주소 줄의 복사를 눌러 초대 문구를 보내세요\."/);
  // A window opened again runs from 적용, before a link's login or the start cards.
  assert.match(setup, /const resumed = restoreSetup\(kept, app\.context, \{ link \}\);/);
  assert.ok(setup.indexOf("if (resumed) {") < setup.indexOf("} else if (link) {"));
  // A computer set up already joins a team with the login and 팀원 steps alone.
  assert.match(setup, /state\.joinOnly\n\s*\? \[\.\.\.\(state\.path === "join" \? \["team"\] : \[\]\), "login", "mates"\]/);
  assert.match(setup, /state\.joinOnly = !firstRun && \["join", "link"\]\.includes\(path\);/);
});

test("the move to another team names the servers it stops collecting into, or nothing when it cannot tell", async () => {
  const team = { hub: "team.example.com", localHost: null };
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

  const setup = await fsp.readFile(path.join(ROOT, "ui", "views", "setup.js"), "utf8");
  const step = setupPart(setup, "function loginStep(");
  assert.equal(step.includes("한 컴퓨터는 팀 하나에만 들어갑니다."), false);
  assert.match(step, /stops\.length \? h\("div", \{ class: "hint" \}, `옮기면 지금 팀을 거쳐 쌓던 서버에는 더 쌓지 않습니다: \$\{stops\.join\(", "\)\}`\) : null/);
});
