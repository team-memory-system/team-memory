// /team-memory's switches (scripts/switch.mjs), with the server's parts stood in for:
// what matters is that each option does what its button in the app does and no
// more, that a teammate is found by team name, email or the start of the email (and
// asked for by email when a name fits two), that what is open to a teammate stays
// while they are off, and that every answer is one line saying how to undo it.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { gateGrants, gateStatePaths, grantChat, grantCollect, readGateAccess, setChatOff } from "../scripts/gate-access.mjs";
import { findTeammate, josa, switchCommand } from "../scripts/switch.mjs";

const HONCHO = { path: "/Users/me/dev/honcho", subfolders: true };

/** A server and its gate in a temporary folder, with the calls each stand-in got. */
async function bench(t, { installed = true, running = true, shared = true, team = true, started = { ok: true }, shareOn = { ok: true } } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "switch-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const config = { paths: { serverDir: path.join(dir, "server") }, honcho: { workspaceId: "memory" } };
  const gate = gateStatePaths({ serverDirectory: config.paths.serverDir });
  const calls = [];
  const deps = {
    loadConfig: async () => config,
    serverStatus: async (options) => { calls.push(["serverStatus", options]); return { ok: running, installed, running }; },
    serverStop: async (options) => { calls.push(["serverStop", options]); running = false; return { ok: true, stopped: true }; },
    serverStart: async (options) => { calls.push(["serverStart", options]); return started; },
    shareStatus: async () => { calls.push(["shareStatus"]); return { ok: true, installed, enabled: shared, tunnel: { enabled: shared }, team }; },
    shareDisable: async () => { calls.push(["shareDisable"]); shared = false; return { ok: true, enabled: false }; },
    teamShare: async (options) => { calls.push(["teamShare", { replace: options.replace, config: options.config === config }]); return shareOn; },
    gateGrants,
    setChatOff: async (paths, options) => { calls.push(["setChatOff", options]); return setChatOff(paths, options); },
  };
  return { gate, calls, deps, run: (...args) => switchCommand(args, deps) };
}

test("with no option it says what is on, a teammate turned off among them", async (t) => {
  const { gate, run, calls } = await bench(t);
  await grantChat(gate, { email: "chulsoo@example.com", peer: "chulsoo", folders: [HONCHO] });
  await grantChat(gate, { email: "younghee@example.com", peer: "younghee", sources: ["chatgpt"] });
  await grantCollect(gate, { email: "minsu@example.com", peer: "minsu" });
  await setChatOff(gate, { email: "younghee@example.com", off: true });
  const answer = await run();
  assert.equal(answer.said, "기억 서버 켜짐 · 공유 켜짐 · chulsoo 켜짐 · younghee 꺼 둠");
  assert.deepEqual(answer.teammates.map((one) => [one.name, one.off]), [["chulsoo", false], ["younghee", true]]);
  assert.deepEqual(calls.map(([name]) => name), ["serverStatus", "shareStatus"], "it only looks");

  const stopped = await bench(t, { running: false, shared: false });
  assert.equal((await stopped.run()).said, "기억 서버 꺼짐 · 공유 꺼짐");
  const none = await bench(t, { installed: false });
  assert.deepEqual(await none.run(), { ok: true, installed: false, said: "이 컴퓨터에는 기억 서버가 없습니다." });
});

test("off and on stop and start the whole memory server, as 서버 → 기억 서버 does", async (t) => {
  const { run, calls } = await bench(t);
  assert.deepEqual(await run("off"), { ok: true, said: "기억 서버를 멈췄습니다. 다시 켜려면 /team-memory on" });
  assert.deepEqual(calls.at(-1), ["serverStop", { profile: "personal" }]);
  assert.deepEqual(await run("on"), { ok: true, changed: true, said: "기억 서버를 시작했습니다." });
  assert.deepEqual(calls.at(-1), ["serverStart", { profile: "personal", build: true }], "the models it was set up with are kept");

  const running = await bench(t);
  assert.equal((await running.run("on")).said, "기억 서버는 이미 켜져 있습니다.");
  assert.equal(running.calls.some(([name]) => name === "serverStart"), false);

  const broken = await bench(t, { running: false, started: { ok: false, ready: false, next: "Resolve the reported host-service issue before starting Honcho containers" } });
  const failed = await broken.run("on");
  assert.equal(failed.ok, false);
  assert.equal(failed.said, "기억 서버를 시작하지 못했습니다: Resolve the reported host-service issue before starting Honcho containers");

  // A teammate's name after on or off points to the switch for one person.
  const one = await run("off", "chulsoo");
  assert.equal(one.ok, false);
  assert.equal(one.said, "off는 기억 서버 전체를 멈춥니다. 한 사람만 끄려면 /team-memory shared-off chulsoo");
  assert.equal((await (await bench(t, { installed: false })).run("off")).said, "이 컴퓨터에는 기억 서버가 없습니다.");
});

test("shared-off and shared-on close and reopen sharing for everyone, the team's address taken again", async (t) => {
  const { run, calls } = await bench(t);
  assert.equal((await run("shared-on")).said, "공유는 이미 켜져 있습니다.");
  assert.deepEqual(await run("shared-off"), { ok: true, changed: true, said: "공유를 껐습니다. 다시 켜려면 /team-memory shared-on" });
  assert.equal((await run("shared-off")).said, "공유는 이미 꺼져 있습니다.");
  assert.deepEqual(await run("shared-on"), { ok: true, changed: true, said: "공유를 켰습니다." });
  assert.deepEqual(calls.filter(([name]) => name === "teamShare"), [["teamShare", { replace: true, config: true }]], "as 다시 켜기 does");

  const notTeam = await bench(t, { shared: false, team: false });
  assert.equal((await notTeam.run("shared-on")).said, "이 서버는 팀으로 공유한 적이 없습니다. 앱의 서버 → 공유에서 켜세요.");
  const loggedOut = await bench(t, { shared: false, shareOn: { ok: false, code: "login_needed", error: "The team login has ended (hub); log in again" } });
  assert.match((await loggedOut.run("shared-on")).said, /^팀 로그인이 필요합니다\./);
});

test("one teammate is turned off and on by team name or email, what is open to them kept", async (t) => {
  const { gate, run } = await bench(t);
  await grantChat(gate, { email: "kim.chulsoo@example.com", peer: "chulsoo", folders: [HONCHO], sources: ["chatgpt"] });
  await grantChat(gate, { email: "naddle@example.com", peer: "naddle", folders: [HONCHO] });

  assert.deepEqual(await run("shared-off", "chulsoo"), { ok: true, changed: true, email: "kim.chulsoo@example.com", off: true, said: "chulsoo를 껐습니다. 다시 켜려면 /team-memory shared-on chulsoo" });
  const chat = (await readGateAccess(gate)).people["kim.chulsoo@example.com"].chat;
  assert.deepEqual([chat.folders, chat.sources, chat.off], [[HONCHO], ["chatgpt"], true]);
  assert.equal((await run("shared-off", "Kim.Chulsoo@Example.com")).said, "chulsoo는 이미 꺼 두었습니다.");
  assert.equal((await run("shared-on", "kim.chulsoo")).said, "chulsoo를 켰습니다.", "the start of the email names them too");
  assert.equal((await readGateAccess(gate)).people["kim.chulsoo@example.com"].chat.off, undefined);
  assert.equal((await run("shared-off", "NADDLE")).said, "naddle을 껐습니다. 다시 켜려면 /team-memory shared-on naddle");

  const missing = await run("shared-off", "영희");
  assert.equal(missing.ok, false);
  assert.equal(missing.said, "영희는 내 기억을 여는 팀원이 아닙니다. 지금 여는 팀원: chulsoo, naddle");
});

test("a name that fits two teammates is asked for by email, and the undo names the one meant", async (t) => {
  const { gate, run } = await bench(t);
  // Two emails that start alike, and a third that starts with another's team name.
  await grantChat(gate, { email: "chulsoo@a.example", peer: "kim", folders: [HONCHO] });
  await grantChat(gate, { email: "chulsoo@b.example", peer: "lee", folders: [HONCHO] });
  await grantChat(gate, { email: "kim@c.example", peer: "park", folders: [HONCHO] });
  const asked = await run("shared-off", "chulsoo");
  assert.equal(asked.ok, false);
  assert.equal(asked.said, "chulsoo가 여러 명입니다. 이메일로 적으세요: chulsoo@a.example, chulsoo@b.example");
  assert.equal((await run("shared-off", "chulsoo@b.example")).said, "lee를 껐습니다. 다시 켜려면 /team-memory shared-on lee");
  assert.equal((await run("shared-off", "kim")).email, "chulsoo@a.example", "a team name wins over the start of an email");
  assert.equal((await run("shared-off", "park")).said, "park을 껐습니다. 다시 켜려면 /team-memory shared-on park");

  const empty = await bench(t);
  assert.equal((await empty.run("shared-on", "chulsoo")).said, "내 기억을 여는 팀원이 아직 없습니다. 팀원이 chat을 요청하면 앱에서 승인하세요.");
});

test("an option it does not know is named back with the ones it does", async (t) => {
  const { run, calls } = await bench(t);
  const answer = await run("pause");
  assert.equal(answer.ok, false);
  assert.equal(answer.said, "pause는 모르는 옵션입니다. on, off, shared-on, shared-off, setup, doctor 중 하나를 적으세요.");
  assert.deepEqual(calls, []);
});

test("findTeammate and josa read names as the team writes them", () => {
  const grants = [
    { email: "a@example.com", peer: "Luna", chat: { folders: [] } },
    { email: "b@example.com", peer: "bob", chat: null, collect: {} },
  ];
  assert.equal(findTeammate(grants, "luna").grant.email, "a@example.com");
  assert.deepEqual(findTeammate(grants, "bob"), { none: true }, "collecting is not chat");
  assert.deepEqual(["철수", "민준", "naddle", "luna"].map((name) => josa(name, "을/를")), ["철수를", "민준을", "naddle을", "luna를"]);
});
