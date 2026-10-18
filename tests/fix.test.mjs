// What /team-memory doctor repairs on its own (scripts/fix.mjs), with setup, the server
// and the app stood in for: what matters is that only what doctor marks as behind is
// touched (a current server is never restarted), that a server behind its pins is
// brought up to them (setup apply alone left the server and gateway on the old
// version), that a stopped one stays off, that a lost gateway login says what to do,
// and that the answer is one line, which names the app's screens and no command Codex
// lacks. The app's update shows each step as a row (onStep), with the reason a
// failing step gave, docker's own when compose throws.
import assert from "node:assert/strict";
import test from "node:test";

import { fixable, fixChecks, toVersion } from "../scripts/fix.mjs";
import { VERSION } from "../scripts/version.mjs";

const behind = (...names) => [
  { name: "configuration", ok: true },
  ...names.map((name) => ({ name, ok: false, fix: "/team-memory doctor" })),
  { name: "honcho-health", ok: false, error: "This operation was aborted" },
];

function bench({
  setup = { ok: true },
  server = { installed: true, running: true },
  after = server,
  started = { ok: true, ready: true },
  prepared = { ok: true, ready: true },
  app = { ok: true },
} = {}) {
  const calls = [];
  const told = [];
  const answer = (value) => (typeof value === "function" ? value() : value);
  let statuses = 0;
  const deps = {
    setupApply: async (options) => { calls.push(["setupApply", options]); return answer(setup); },
    serverStatus: async (options) => { calls.push(["serverStatus", options]); statuses += 1; return statuses > 1 ? after : server; },
    serverStart: async (options) => { calls.push(["serverStart", options]); return answer(started); },
    serverPrepare: async (options) => { calls.push(["serverPrepare", options]); return answer(prepared); },
    restartApp: async () => { calls.push(["restartApp"]); return answer(app); },
    onStep: async (...step) => { told.push(step); },
  };
  return { deps, calls, told, names: () => calls.map(([name]) => name) };
}

test("only the checks marked fix count, and nothing is done when none is behind", async () => {
  assert.deepEqual([...fixable(behind("runtime"))], ["runtime"], "a failing check without fix is left to the person");
  const { deps, names } = bench();
  const answer = await fixChecks(behind(), deps);
  assert.deepEqual(answer, { ok: true, changed: false, steps: [], said: "" });
  assert.deepEqual(names(), []);
});

test("a version takes 으로 or 로 as its last digit is read", () => {
  // 영, 삼 and 육 end in a consonant; 일, 칠 and 팔 end in ㄹ, which takes 로 as the rest do.
  assert.deepEqual(["0.8.10", "0.8.13", "0.8.16"].map((version) => toVersion(version)), ["0.8.10으로", "0.8.13으로", "0.8.16으로"]);
  assert.deepEqual(["0.8.11", "0.8.12", "0.8.14", "0.8.15", "0.8.17", "0.8.18", "0.8.19", "0.9"].map((version) => toVersion(version)),
    ["0.8.11로", "0.8.12로", "0.8.14로", "0.8.15로", "0.8.17로", "0.8.18로", "0.8.19로", "0.9로"]);
});

test("after an update everything behind is brought up: setup, the running server, the app", async () => {
  const { deps, calls, names } = bench();
  const answer = await fixChecks(behind("runtime", "server-version", "app"), deps);
  assert.equal(answer.ok, true);
  assert.deepEqual(names(), ["setupApply", "serverStatus", "serverStart", "restartApp"]);
  assert.deepEqual(calls[0][1], {}, "setup keeps the saved settings");
  assert.deepEqual(calls[2][1], { profile: "personal", build: true }, "start prepares again, so the gateway moves too");
  assert.equal(answer.said, `대화 모으기를 ${toVersion(VERSION)} 바꿨습니다. 기억 서버와 구독 게이트웨이를 새 판으로 다시 시작했습니다. 팀 메모리 앱을 새 판으로 다시 켰습니다. 열려 있는 Claude Code와 Codex 창은 새로 시작해야 새 판을 씁니다.`);
});

test("a server that is current is not restarted when only the collector is behind", async () => {
  const { deps, names } = bench();
  const answer = await fixChecks(behind("runtime"), deps);
  assert.equal(answer.ok, true);
  assert.deepEqual(names(), ["setupApply"]);
  assert.doesNotMatch(answer.said, /기억 서버/);
});

test("a stopped server behind its pins is only prepared and stays off", async () => {
  const { deps, names } = bench({ server: { installed: true, running: false } });
  const answer = await fixChecks(behind("server-version"), deps);
  assert.equal(answer.ok, true);
  assert.deepEqual(names(), ["serverStatus", "serverPrepare"]);
  assert.equal(answer.said, "꺼 둔 기억 서버는 새 판으로 준비만 했습니다. 켜려면 팀 메모리 앱의 서버 → 기억 서버에서 시작을 누르세요.");
});

test("a setup that fails stops before the server", async () => {
  const { deps, names } = bench({ setup: { ok: false, error: "Node.js 18 or newer is required" } });
  const answer = await fixChecks(behind("runtime", "server-version"), deps);
  assert.equal(answer.ok, false);
  assert.deepEqual(names(), ["setupApply"]);
  assert.equal(answer.said, "대화 모으기를 새 판으로 바꾸지 못했습니다: Node.js 18 or newer is required");
});

test("a gateway whose login ended says where to log in, after what was already done", async () => {
  const { deps, names } = bench({ started: { ok: true, ready: false, nextAction: { kind: "gateway-login" } } });
  const answer = await fixChecks(behind("runtime", "server-version", "app"), deps);
  assert.equal(answer.ok, false);
  assert.deepEqual(names(), ["setupApply", "serverStatus", "serverStart"]);
  assert.match(answer.said, new RegExp(`^대화 모으기를 ${toVersion(VERSION).replaceAll(".", "\\.")} 바꿨습니다\\. 구독 계정의 로그인이 풀려 있습니다\\.`));
  // It ends at the login: the chat runs /team-memory doctor again, the app has 다시 시도.
  assert.match(answer.said, /팀 메모리 앱의 서버 → 모델에서 로그인하세요\.$/);
  assert.equal(answer.login, true);
  assert.equal(answer.failed, "server");
  assert.equal(answer.serverOff, undefined, "a login stops prepare before the running server is touched");
});

test("no answer sends a Codex user to /team-memory, which only Claude Code has", async () => {
  const answers = [
    await fixChecks(behind("runtime", "server-version", "app"), bench().deps),
    await fixChecks(behind("server-version"), bench({ server: { installed: true, running: false } }).deps),
    await fixChecks(behind("runtime", "server-version"), bench({ started: { ok: true, ready: false, nextAction: { kind: "gateway-login" } } }).deps),
    await fixChecks(behind("server-version"), bench({ started: { ok: false, issues: ["Docker Desktop is not running"] } }).deps),
  ];
  for (const answer of answers) assert.doesNotMatch(answer.said, /\/team-memory/, answer.said);
});

test("a server that does not come back, or an app that cannot restart, says why", async () => {
  const broken = bench({ started: { ok: false, issues: ["Docker Desktop is not running"] } });
  const answer = await fixChecks(behind("server-version"), broken.deps);
  assert.equal(answer.ok, false);
  assert.equal(answer.said, "기억 서버를 새 판으로 다시 시작하지 못했습니다: Docker Desktop is not running");

  const stuck = bench({ app: { ok: false, error: "The older Team Memory app did not stop" } });
  const late = await fixChecks(behind("app"), stuck.deps);
  assert.equal(late.ok, false);
  assert.equal(late.said, "팀 메모리 앱을 새 판으로 다시 켜지 못했습니다: The older Team Memory app did not stop");

  // Its containers came up and Honcho never answered: server start says why in `health` alone.
  for (const [error, reason] of [["HTTP 502", "Honcho /health: HTTP 502"], ["health check timed out", "Honcho /health: health check timed out"]]) {
    const silent = bench({ started: { ok: false, mode: "local-docker", health: { ok: false, error, elapsedMs: 120_000 } } });
    const quiet = await fixChecks(behind("server-version"), silent.deps);
    assert.deepEqual([quiet.ok, quiet.error], [false, reason]);
    assert.equal(quiet.said, `기억 서버를 새 판으로 다시 시작하지 못했습니다: ${reason}`);
    assert.deepEqual(silent.told.at(-1), ["server", "bad", { error: reason, detail: null }], "its row says it too");
  }

  // An address in a reason a step gave keeps no secret, as one in what it threw.
  const secret = "https://agent:hunter2@memory.example.com/v3?key=abc123";
  const leaky = bench({ started: { ok: false, error: `Honcho at ${secret} did not answer`, detail: `GET ${secret}` } });
  const cleaned = await fixChecks(behind("server-version"), leaky.deps);
  assert.deepEqual([cleaned.error, cleaned.detail], ["Honcho at https://memory.example.com/v3 did not answer", "GET https://memory.example.com/v3"]);
  assert.doesNotMatch(JSON.stringify([cleaned, leaky.told]), /hunter2|abc123/);
});

test("each step is told as it goes, the server's with whether it runs", async () => {
  const { deps, told } = bench();
  const answer = await fixChecks(behind("runtime", "server-version", "app"), deps);
  assert.equal(answer.ok, true);
  assert.deepEqual(told, [
    ["runtime", "run", undefined], ["runtime", "ok", undefined],
    ["server", "run", { running: true }], ["server", "ok", undefined],
    ["app", "run", undefined], ["app", "ok", undefined],
  ]);

  const login = bench({ server: { installed: true, running: false }, prepared: { ok: true, ready: false, nextAction: { kind: "gateway-login" } } });
  await fixChecks(behind("server-version"), login.deps);
  assert.deepEqual(login.told, [["server", "run", { running: false }], ["server", "login", undefined]]);
});

test("a stopped server prepared only, or one a failed start left down, is off at the end", async () => {
  const stopped = await fixChecks(behind("server-version", "app"), bench({ server: { installed: true, running: false } }).deps);
  assert.equal(stopped.ok, true);
  assert.equal(stopped.serverOff, true);

  const down = bench({ started: { ok: false, issues: ["The host services did not become ready"] }, after: { installed: true, running: false } });
  const failed = await fixChecks(behind("server-version", "app"), down.deps);
  assert.equal(failed.ok, false);
  assert.equal(failed.failed, "server");
  assert.equal(failed.serverOff, true);
  assert.deepEqual(down.names(), ["serverStatus", "serverStart", "serverStatus"], "asked again after the failure, and the app is not restarted");
  assert.deepEqual(down.told.at(-1), ["server", "bad", { error: "The host services did not become ready", detail: null }]);

  const running = await fixChecks(behind("server-version"), bench({ started: { ok: false, issues: ["The gate still runs the old files"] } }).deps);
  assert.equal(running.serverOff, undefined, "still running after the failure");
});

test("a compose that throws fails the server's step with docker's own last line, and the lines before it", async () => {
  const thrown = Object.assign(new Error("Command failed: docker compose --project-directory /x/server up -d --remove-orphans --build"), {
    stderr: " Container honcho-api  Recreate\n Container honcho-api  Error\nError response from daemon: driver failed programming external connectivity\n",
  });
  const broken = bench({ started: () => { throw thrown; }, after: { installed: true, running: false } });
  const answer = await fixChecks(behind("runtime", "server-version"), broken.deps);
  assert.equal(answer.ok, false);
  assert.equal(answer.error, "Error response from daemon: driver failed programming external connectivity");
  assert.equal(answer.detail, "Container honcho-api  Recreate\nContainer honcho-api  Error");
  assert.equal(answer.serverOff, true);
  assert.equal(answer.said, `대화 모으기를 ${toVersion(VERSION)} 바꿨습니다. 기억 서버를 새 판으로 다시 시작하지 못했습니다: Error response from daemon: driver failed programming external connectivity`);
  assert.deepEqual(broken.told.at(-1), ["server", "bad", { error: answer.error, detail: answer.detail }]);

  const setup = bench({ setup: () => { throw new Error("Setup failed: EACCES: permission denied; changes were rolled back"); } });
  const stopped = await fixChecks(behind("runtime", "server-version"), setup.deps);
  assert.equal(stopped.said, "대화 모으기를 새 판으로 바꾸지 못했습니다: Setup failed: EACCES: permission denied; changes were rolled back");
  assert.deepEqual(setup.names(), ["setupApply"]);
});

test("a progress file that cannot be written stops no step", async () => {
  const { deps, names } = bench();
  deps.onStep = async () => { throw new Error("ENOSPC"); };
  const answer = await fixChecks(behind("runtime", "app"), deps);
  assert.equal(answer.ok, true);
  assert.deepEqual(names(), ["setupApply", "restartApp"]);
});
