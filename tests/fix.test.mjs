// What /team-memory doctor repairs on its own (scripts/fix.mjs), with setup, the server
// and the app stood in for: what matters is that only what doctor marks as behind is
// touched (a current server is never restarted), that a server behind its pins is
// brought up to them (setup apply alone left the server and gateway on the old
// version), that a stopped one stays off, that a lost gateway login says what to do,
// and that the answer is one line.
import assert from "node:assert/strict";
import test from "node:test";

import { fixable, fixChecks } from "../scripts/fix.mjs";
import { VERSION } from "../scripts/version.mjs";

const behind = (...names) => [
  { name: "configuration", ok: true },
  ...names.map((name) => ({ name, ok: false, fix: "/team-memory doctor" })),
  { name: "honcho-health", ok: false, error: "This operation was aborted" },
];

function bench({
  setup = { ok: true },
  server = { installed: true, running: true },
  started = { ok: true, ready: true },
  prepared = { ok: true, ready: true },
  app = { ok: true },
} = {}) {
  const calls = [];
  const deps = {
    setupApply: async (options) => { calls.push(["setupApply", options]); return setup; },
    serverStatus: async (options) => { calls.push(["serverStatus", options]); return server; },
    serverStart: async (options) => { calls.push(["serverStart", options]); return started; },
    serverPrepare: async (options) => { calls.push(["serverPrepare", options]); return prepared; },
    restartApp: async () => { calls.push(["restartApp"]); return app; },
  };
  return { deps, calls, names: () => calls.map(([name]) => name) };
}

test("only the checks marked fix count, and nothing is done when none is behind", async () => {
  assert.deepEqual([...fixable(behind("runtime"))], ["runtime"], "a failing check without fix is left to the person");
  const { deps, names } = bench();
  const answer = await fixChecks(behind(), deps);
  assert.deepEqual(answer, { ok: true, changed: false, steps: [], said: "" });
  assert.deepEqual(names(), []);
});

test("after an update everything behind is brought up: setup, the running server, the app", async () => {
  const { deps, calls, names } = bench();
  const answer = await fixChecks(behind("runtime", "server-version", "app"), deps);
  assert.equal(answer.ok, true);
  assert.deepEqual(names(), ["setupApply", "serverStatus", "serverStart", "restartApp"]);
  assert.deepEqual(calls[0][1], {}, "setup keeps the saved settings");
  assert.deepEqual(calls[2][1], { profile: "personal", build: true }, "start prepares again, so the gateway moves too");
  assert.equal(answer.said, `대화 모으기를 ${VERSION}로 바꿨습니다. 기억 서버와 구독 게이트웨이를 새 판으로 다시 시작했습니다. 팀 메모리 앱을 새 판으로 다시 켰습니다. 열려 있는 Claude Code와 Codex 창은 새로 시작해야 새 판을 씁니다.`);
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
  assert.equal(answer.said, "꺼 둔 기억 서버는 새 판으로 준비만 했습니다. 켜려면 /team-memory on");
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
  assert.match(answer.said, new RegExp(`^대화 모으기를 ${VERSION.replaceAll(".", "\\.")}로 바꿨습니다\\. 구독 계정의 로그인이 풀려 있습니다\\.`));
  assert.match(answer.said, /게이트웨이 화면에서 로그인한 뒤 \/team-memory doctor 를 다시 입력하세요/);
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
});
