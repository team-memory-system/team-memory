// 업데이트 (scripts/update.mjs), with GitHub's main, the Claude Code and Codex CLIs,
// the processes it starts, the clock, doctor and the steps of doctor --fix stood in
// for: nothing here reads the network or runs a real CLI. What matters is that the
// app knows a newer version from the lowest one here, reads main once a day, warns
// about a rebuild only when the server here is not what main runs, refuses while a
// long job runs, runs the Claude Code plugin first, the rest from the new plugin's
// folder and the Codex plugin last (first on a computer with Codex only, with the app
// right after it), and writes every row's state to the app's folder, where a new app
// reads how far it got.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test, { after } from "node:test";

import { fixChecks } from "../scripts/fix.mjs";
import { VERSION } from "../scripts/version.mjs";
import {
  compareVersions,
  fixProgress,
  latestVersion,
  pluginUpdateArgs,
  recordFix,
  retryCli,
  stepRow,
  UPDATE_BASE_ENV,
  updateContinue,
  updateProgress,
  updateRetry,
  updateRun,
  updateStart,
  updateStatus,
} from "../scripts/update.mjs";
import { HERE_ONLY } from "../scripts/viewer.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAIN = "https://raw.githubusercontent.com/team-memory-system/team-memory/main/";
const HONCHO_PIN = { repo: "https://github.com/team-memory-system/honcho-selfhost", ref: "main", commit: "a".repeat(40) };
const GATEWAY_PIN = { repo: "https://github.com/team-memory-system/subscription-gateway", ref: "main", commit: "b".repeat(40) };
const COMPOSE = "services:\n  api:\n    image: honcho\n";
const GATE = "export default {};\n";
const HOUR = 60 * 60_000;

const ENV = ["HONCHO_AGENT_BRIDGE_HOME", "HONCHO_AGENT_BRIDGE_USER_HOME", "HONCHO_AGENT_BRIDGE_SERVER_DIR", "HONCHO_AGENT_BRIDGE_CONFIG", UPDATE_BASE_ENV];
const original = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));
after(() => {
  for (const [name, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

async function put(file, text) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, text);
}

const readJson = async (file) => JSON.parse(await fsp.readFile(file, "utf8"));

async function pluginFolder(folder, version) {
  await put(path.join(folder, "scripts", "version.mjs"), `export const VERSION = "${version}";\n`);
  await put(path.join(folder, "scripts", "cli.mjs"), "");
  return folder;
}

/** The Claude Code plugin at `version`: its folder in the cache, older ones kept, and installed_plugins.json. */
async function claudeAt(home, version) {
  const folder = await pluginFolder(path.join(home, ".claude", "plugins", "cache", "team-memory", "team-memory", version), version);
  await put(path.join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({
    version: 2,
    plugins: { "team-memory@team-memory": [{ scope: "user", installPath: folder, version, installedAt: "2026-10-01T00:00:00.000Z" }] },
  }));
  return folder;
}

/** The Codex plugin at `version`: its table in config.toml and the one folder Codex keeps. */
async function codexAt(home, version) {
  const base = path.join(home, ".codex", "plugins", "cache", "team-memory", "team-memory");
  await fsp.rm(base, { recursive: true, force: true });
  await put(path.join(home, ".codex", "config.toml"),
    '[marketplaces.team-memory]\nsource_type = "git"\nsource = "https://github.com/team-memory-system/team-memory.git"\n\n[plugins."team-memory@team-memory"]\nenabled = true\n');
  return pluginFolder(path.join(base, version), version);
}

/**
 * One computer: the plugins, the collector, the app and the server at the versions
 * given, and main at `latest`. `server` is the server here against main: "same",
 * "honcho", "gateway" or "compose" (that one is behind), "crlf" (the same with
 * Windows line ends) or null (no server). `doctor` names the checks the new folder's
 * doctor marks.
 */
async function bench(t, {
  latest = "0.9.1",
  claude = "0.9.0",
  codex = null,
  runtime = "0.9.0",
  app = "0.9.0",
  server = "same",
  running = true,
  config = {},
  doctor = null,
  hub = null,
} = {}) {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "team-memory-update-")));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const appHome = path.join(root, "app");
  process.env.HONCHO_AGENT_BRIDGE_HOME = appHome;
  process.env.HONCHO_AGENT_BRIDGE_USER_HOME = home;
  delete process.env.HONCHO_AGENT_BRIDGE_SERVER_DIR;
  delete process.env.HONCHO_AGENT_BRIDGE_CONFIG;
  delete process.env[UPDATE_BASE_ENV];

  const own = claude ? await claudeAt(home, claude) : null;
  const codexOwn = codex ? await codexAt(home, codex) : null;
  if (runtime) await put(path.join(appHome, "runtime", "collector", "version.mjs"), `export const VERSION = "${runtime}";\n`);
  if (server) {
    const dir = path.join(appHome, "server");
    await put(path.join(dir, "compose.yaml"), server === "compose" ? `${COMPOSE}    # 0.9.0\n` : server === "crlf" ? COMPOSE.replace(/\n/g, "\r\n") : COMPOSE);
    await put(path.join(dir, "gate", "gate.mjs"), GATE);
    await put(path.join(dir, "honcho-source.json"), JSON.stringify(server === "honcho" ? { ...HONCHO_PIN, commit: "c".repeat(40) } : HONCHO_PIN));
    await put(path.join(appHome, "runtime", "subscription-gateway", ".honcho-agent-bridge-source.json"),
      JSON.stringify({ ...(server === "gateway" ? { ...GATEWAY_PIN, commit: "d".repeat(40) } : GATEWAY_PIN), head: "e".repeat(40) }));
  }

  const main = {
    ".claude-plugin/plugin.json": JSON.stringify({ name: "team-memory", version: latest }),
    "server/honcho-source.json": JSON.stringify(HONCHO_PIN),
    "server/gateway-source.json": JSON.stringify(GATEWAY_PIN),
    "server/compose.yaml": COMPOSE,
    "server/gate/gate.mjs": GATE,
  };
  const b = {
    root,
    home,
    appHome,
    main,
    own,
    codexOwn,
    offline: false,
    time: Date.parse("2026-10-19T09:00:00Z"),
    fetched: [],
    calls: [],
    spawned: [],
    live: new Set([process.pid]),
    running,
    hub,
    // What the steps of doctor --fix answer; a function is asked each time.
    answers: {
      setup: { ok: true },
      started: { ok: true, ready: true },
      prepared: { ok: true, ready: true },
      app: { ok: true },
    },
    seen: [],
    doctor: doctor || [
      ...(runtime && compareVersions(runtime, latest) < 0 ? ["runtime"] : []),
      ...(server && !["same", "crlf"].includes(server) ? ["server-version"] : []),
      ...(app && compareVersions(app, latest) < 0 ? ["app"] : []),
    ],
    update: path.join(appHome, "update", "update.json"),
  };
  const answer = (value) => (typeof value === "function" ? value() : value);
  const steps = {
    setupApply: async () => { b.calls.push("setup apply"); return answer(b.answers.setup); },
    serverStatus: async () => ({ installed: true, running: b.running }),
    serverStart: async () => { b.calls.push("server start"); b.seen.push(await readJson(b.update)); return answer(b.answers.started); },
    serverPrepare: async () => { b.calls.push("server prepare"); return answer(b.answers.prepared); },
    restartApp: async () => { b.calls.push("app restart"); return answer(b.answers.app); },
  };
  let pid = 70_000;
  b.options = {
    home,
    config,
    env: { PATH: "" },
    platform: "linux",
    now: () => b.time,
    fetchImpl: async (url) => {
      b.fetched.push(url);
      if (b.offline) throw new TypeError("fetch failed");
      const name = url.startsWith(MAIN) ? url.slice(MAIN.length) : null;
      return name !== null && name in b.main ? new Response(b.main[name]) : new Response("404: Not Found", { status: 404 });
    },
    spawn: (cli, args, { cwd }) => {
      pid += 1;
      b.spawned.push({ cli, args, cwd });
      b.live.add(pid);
      return pid;
    },
    alive: (value) => b.live.has(value),
    clientRunner: async (client, args) => {
      b.calls.push([client, ...args].join(" "));
      if (client === "claude" && args[1] === "update") await claudeAt(home, b.main[".claude-plugin/plugin.json"] && JSON.parse(b.main[".claude-plugin/plugin.json"]).version);
      if (client === "codex" && args[1] === "add") await codexAt(home, JSON.parse(b.main[".claude-plugin/plugin.json"]).version);
      return { code: 0, stdout: "", stderr: "" };
    },
    serverStatus: async () => ({ installed: true, running: b.running }),
    hubBehind: async () => b.hub,
    scriptDir: path.join(own || codexOwn || path.join(root, "checkout"), "scripts"),
    appVersion: app,
    doctor: async () => ({ ok: false, checks: [{ name: "configuration", ok: true }, ...b.doctor.map((name) => ({ name, ok: false, fix: "고치기" }))] }),
    fix: (checks, onStep) => fixChecks(checks, { ...steps, onStep }),
  };
  b.progress = () => readJson(b.update);
  b.ids = (rows) => rows.map((row) => row.id);
  b.states = (rows) => Object.fromEntries(rows.map((row) => [row.id, row.state]));
  return b;
}

/** main on a loopback server, serving what `b.main` holds, for what reads it outside the bench's fetch. */
async function serveMain(t, b) {
  const server = http.createServer((request, response) => {
    const name = request.url.replace(/^\/+/, "");
    if (name in b.main) return response.end(b.main[name]);
    response.statusCode = 404;
    response.end("404: Not Found");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}/`;
}

/** The processes `update start` and `retry` would start, run here in turn as they would run there. */
async function drive(b, from = 0) {
  for (let at = from; at < b.spawned.length; at += 1) {
    const { cli, args } = b.spawned[at];
    const options = { ...b.options, scriptDir: path.dirname(cli) };
    if (args[1] === "run") await updateRun(options);
    else if (args[1] === "continue") await updateContinue(options);
  }
}

test("versions compare as numbers, and what is not one is below every version", () => {
  assert.equal(compareVersions("0.8.13", "0.8.14"), -1);
  assert.equal(compareVersions("0.10.0", "0.9.9"), 1);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  assert.equal(compareVersions("dev", "0.0.1"), -1);
  assert.equal(compareVersions("0.0.1", ""), 1);
});

test("main above the lowest of the app, the plugins and the collector is newer, the same is not", async (t) => {
  const behind = await bench(t, { latest: "0.9.1", claude: "0.9.1", codex: "0.9.1", runtime: "0.9.0", app: "0.9.1" });
  const status = await updateStatus(behind.options);
  assert.equal(status.ok, true);
  assert.equal(status.newer, true);
  assert.equal(status.latest, "0.9.1");
  assert.deepEqual(status.here, { app: "0.9.1", claude: "0.9.1", codex: "0.9.1", runtime: "0.9.0" });
  assert.deepEqual(status.rows, [{ id: "runtime", title: "대화 모으기" }], "only what is behind is brought up");
  assert.equal(status.summary, "대화 모으기를 올립니다.");
  assert.equal(status.warning, null);
  assert.deepEqual(behind.fetched.sort(), [
    `${MAIN}.claude-plugin/plugin.json`,
    `${MAIN}server/compose.yaml`,
    `${MAIN}server/gate/gate.mjs`,
    `${MAIN}server/gateway-source.json`,
    `${MAIN}server/honcho-source.json`,
  ]);

  // A server behind main changes nothing while every version here is main's.
  const current = await bench(t, { latest: "0.9.1", claude: "0.9.1", runtime: "0.9.1", app: "0.9.1", server: "honcho" });
  const none = await updateStatus(current.options);
  assert.equal(none.newer, false);
  assert.deepEqual([none.rows, none.summary, none.server, none.warning, none.blocked], [[], null, null, null, null]);
  const refused = await updateStart(current.options);
  assert.deepEqual([refused.ok, refused.code], [false, "current"]);
  assert.equal(current.spawned.length, 0);

  // The collector before setup is not counted; the app answering here is.
  const fresh = await bench(t, { latest: "0.9.1", claude: "0.9.1", runtime: "0.9.0", app: "0.9.0", config: null });
  assert.deepEqual((await updateStatus(fresh.options)).rows, [{ id: "app", title: "앱 다시 켜기" }]);
  assert.equal((await updateStatus(fresh.options)).summary, "앱을 새 판으로 다시 켭니다.");
});

test("every row says what it brings up, in the order it runs, and a running server's rebuild is warned of", async (t) => {
  const b = await bench(t, { claude: "0.9.0", codex: "0.9.0", runtime: "0.9.0", app: "0.9.0", server: "honcho" });
  const status = await updateStatus(b.options);
  assert.deepEqual(status.rows, [
    { id: "claude", title: "Claude Code 플러그인" },
    { id: "runtime", title: "대화 모으기" },
    { id: "server", title: "기억 서버 다시 만들기", sub: "몇 분에서 10분 넘게 걸립니다." },
    { id: "app", title: "앱 다시 켜기" },
    { id: "codex", title: "Codex 플러그인" },
  ]);
  assert.equal(status.summary, "플러그인과 대화 모으기, 기억 서버를 올립니다.");
  assert.equal(status.warning, "기억 서버를 다시 만드는 동안 팀원 열람이 멈춥니다.");
  assert.deepEqual(status.server, { rebuild: true, running: true, gateway: false });

  const two = await bench(t, { claude: "0.9.0", runtime: "0.9.1", app: "0.9.1", server: "gateway" });
  assert.equal((await updateStatus(two.options)).summary, "플러그인과 기억 서버를 올립니다.");
});

test("the server is rebuilt only when main runs another Honcho, gateway or container file than the server here", async (t) => {
  const cases = [
    ["same", false],
    ["crlf", false],
    ["honcho", true],
    ["gateway", true],
    ["compose", true],
  ];
  for (const [server, rebuild] of cases) {
    const b = await bench(t, { server });
    const status = await updateStatus(b.options);
    assert.equal(status.server.rebuild, rebuild, server);
    assert.equal(status.rows.some((row) => row.id === "server"), rebuild, server);
    assert.equal(status.warning !== null, rebuild, server);
    // Whether it runs is asked only for a rebuild.
    if (!rebuild) assert.deepEqual(status.server, { rebuild: false, running: null, gateway: false }, server);
  }

  // A version whose gateway pin moved says so on the server's row.
  const gateway = await updateStatus((await bench(t, { server: "gateway" })).options);
  assert.deepEqual(gateway.rows.find((row) => row.id === "server"), {
    id: "server", title: "기억 서버 다시 만들기", sub: "게이트웨이도 새 판으로 바꿉니다. 몇 분에서 10분 넘게 걸립니다.", gateway: true,
  });
  assert.deepEqual(gateway.server, { rebuild: true, running: true, gateway: true });

  // A stopped server is prepared only: its row says so, and no teammate's reading stops.
  const stopped = await bench(t, { server: "honcho", running: false });
  const status = await updateStatus(stopped.options);
  assert.deepEqual(status.rows.find((row) => row.id === "server"), { id: "server", title: "기억 서버 준비", sub: "꺼 둔 서버는 켜지 않습니다." });
  assert.deepEqual([status.server, status.warning], [{ rebuild: true, running: false, gateway: false }, null]);

  // A computer with no server of its own (쌓지 않기, 다른 컴퓨터의 내 서버) has no server row.
  const none = await bench(t, { server: null });
  const without = await updateStatus(none.options);
  assert.equal(without.newer, true);
  assert.equal(without.server, null);
  assert.equal(without.rows.some((row) => row.id === "server"), false);
  assert.equal(without.summary, "플러그인과 대화 모으기를 올립니다.");
});

test("main is read once a day, an hour after a check that failed, and at once when asked", async (t) => {
  const b = await bench(t);
  await updateStatus(b.options);
  assert.equal(b.fetched.length, 5);
  await updateStatus(b.options);
  b.time += 23 * HOUR;
  await updateStatus(b.options);
  assert.equal(b.fetched.length, 5, "read once in the day");

  b.main[".claude-plugin/plugin.json"] = JSON.stringify({ version: "0.9.2" });
  b.time += HOUR + 1;
  assert.equal((await updateStatus(b.options)).latest, "0.9.2");
  assert.equal(b.fetched.length, 10);

  // No network: the version found last stays, with the reason, and the next try is an hour on.
  b.offline = true;
  b.time += 25 * HOUR;
  const offline = await updateStatus(b.options);
  assert.equal(offline.latest, "0.9.2");
  assert.match(offline.error, /fetch failed/);
  assert.equal(b.fetched.length, 15);
  b.time += HOUR - 1;
  await updateStatus(b.options);
  assert.equal(b.fetched.length, 15);
  b.offline = false;
  b.time += 2;
  const back = await updateStatus(b.options);
  assert.equal(back.error, undefined);
  assert.equal(b.fetched.length, 20);

  // update status --check, and a clock that went back a week.
  await latestVersion({ ...b.options, force: true });
  assert.equal(b.fetched.length, 25);
  b.time -= 7 * 24 * HOUR;
  await updateStatus(b.options);
  assert.equal(b.fetched.length, 30);

  // A main without the server's files is still read for its version; one without a version is a failure.
  delete b.main["server/gate/gate.mjs"];
  assert.equal((await latestVersion({ ...b.options, force: true })).version, "0.9.2");
  await assert.rejects(fsp.access(path.join(b.appHome, "update", "main", "gate", "gate.mjs")), "a file main no longer has is not kept");
  b.main[".claude-plugin/plugin.json"] = "{}";
  const broken = await latestVersion({ ...b.options, force: true });
  assert.deepEqual([broken.version, broken.error], ["0.9.2", "plugin.json on main names no version"]);
});

test("while past conversations go in, the memory is made again, or a fix runs, the button is refused with why", async (t) => {
  const b = await bench(t);
  const past = path.join(b.appHome, "data", "past", "status.json");
  await put(past, JSON.stringify({ running: { pid: 4321, startedAt: "2026-10-19T08:00:00Z" } }));
  b.live.add(4321);
  const status = await updateStatus(b.options);
  assert.deepEqual(status.blocked, { code: "past", reason: "지난 대화를 쌓는 중입니다. 다 쌓은 뒤 업데이트를 누르세요." });
  const refused = await updateStart(b.options);
  assert.deepEqual(refused, { ok: false, code: "past", error: "지난 대화를 쌓는 중입니다. 다 쌓은 뒤 업데이트를 누르세요." });
  assert.equal(b.spawned.length, 0);
  b.live.delete(4321);
  assert.equal((await updateStatus(b.options)).blocked, null, "a run whose process is gone holds nothing up");

  const rederive = path.join(b.appHome, "data", "rederive", "status.json");
  await put(rederive, JSON.stringify({ job: { pid: 4322, kind: "build" } }));
  b.live.add(4322);
  assert.deepEqual((await updateStatus(b.options)).blocked, { code: "rederive", reason: "기억을 다시 정리하는 중입니다. 다 끝난 뒤 업데이트를 누르세요." });
  // Its process gone, the app carries it on: it is going until it ends or stops with an error.
  b.live.delete(4322);
  assert.equal((await updateStatus(b.options)).blocked?.code, "rederive");
  assert.equal((await updateStart(b.options)).code, "rederive");
  await put(rederive, JSON.stringify({ job: { pid: 4322, kind: "build", error: "Honcho answered 500" } }));
  assert.equal((await updateStatus(b.options)).blocked, null, "one that stopped with an error holds nothing up");

  await put(path.join(b.appHome, "update", "fix.json"), JSON.stringify({ version: 1, kind: "fix", state: "running", pid: process.pid, rows: [] }));
  assert.equal((await updateStatus(b.options)).blocked.code, "fixing");
  assert.equal((await updateStart(b.options)).code, "fixing");
});

test("the Claude Code plugin goes first, the rest runs from its new folder, and the Codex plugin goes last", async (t) => {
  const b = await bench(t, { claude: "0.9.0", codex: "0.9.0", runtime: "0.9.0", app: "0.9.0", server: "honcho" });
  const started = await updateStart(b.options);
  assert.equal(started.ok, true, started.error);
  assert.deepEqual(b.states(started.progress.rows), { claude: "wait", runtime: "wait", server: "wait", app: "wait", codex: "wait" });
  assert.deepEqual([started.progress.from, started.progress.to, started.progress.state], ["0.9.0", "0.9.1", "running"]);
  assert.equal(started.progress.pid, undefined, "the screen gets no process ids");
  await drive(b);

  assert.deepEqual(b.calls, [
    "claude plugin marketplace update team-memory",
    "claude plugin update team-memory@team-memory --scope user",
    "setup apply",
    "server start",
    "app restart",
    "codex plugin marketplace upgrade team-memory",
    "codex plugin add team-memory@team-memory",
  ]);
  const newer = path.join(b.home, ".claude", "plugins", "cache", "team-memory", "team-memory", "0.9.1");
  assert.deepEqual(b.spawned.map(({ cli, args }) => [cli, args.join(" ")]), [
    [path.join(b.own, "scripts", "cli.mjs"), "update run"],
    [path.join(newer, "scripts", "cli.mjs"), "update continue"],
  ]);
  // Never in a plugin folder: Windows cannot take away a folder a process is in.
  for (const { cwd } of b.spawned) assert.equal(cwd, path.join(b.appHome, "update"));

  // The server's step ran with the rows before it done.
  assert.deepEqual(b.states(b.seen[0].rows), { claude: "ok", runtime: "ok", server: "run", app: "wait", codex: "wait" });
  const done = await updateProgress(b.options);
  assert.equal(done.state, "done");
  assert.deepEqual(b.states(done.rows), { claude: "ok", runtime: "ok", server: "ok", app: "ok", codex: "ok" });
  assert.deepEqual(done.todo, [
    { id: "claude", title: "Claude Code", text: "열린 창은 닫고 새로 여세요." },
    { id: "codex", title: "Codex", text: "열린 창은 닫고 새로 여세요." },
  ]);
  assert.match(done.said, /^Claude Code 플러그인을 0\.9\.1로 올렸습니다\. Codex 플러그인을 0\.9\.1로 올렸습니다\. 대화 모으기를 /);
  assert.equal(done.finishedAt, new Date(b.time).toISOString());
  assert.equal((await updateStatus(b.options)).progress.state, "done", "the status carries the update last done");
});

test("on a computer with Codex only, the Codex plugin goes first, the app right after it, and the rest from its new folder", async (t) => {
  const b = await bench(t, { claude: null, codex: "0.9.0", runtime: "0.9.0", app: "0.9.0", server: "honcho" });
  const status = await updateStatus(b.options);
  assert.deepEqual(b.ids(status.rows), ["codex", "app", "runtime", "server"]);
  assert.equal((await updateStart(b.options)).ok, true);
  await drive(b);
  // Codex took away the folder the app ran from: its pages are back before the server's rebuild.
  assert.deepEqual(b.calls, [
    "codex plugin marketplace upgrade team-memory",
    "codex plugin add team-memory@team-memory",
    "app restart",
    "setup apply",
    "server start",
  ]);
  assert.deepEqual(b.states(b.seen[0].rows), { codex: "ok", app: "ok", runtime: "ok", server: "run" });
  const newer = path.join(b.home, ".codex", "plugins", "cache", "team-memory", "team-memory", "0.9.1");
  assert.deepEqual(b.spawned.map(({ cli }) => cli), [path.join(b.codexOwn, "scripts", "cli.mjs"), path.join(newer, "scripts", "cli.mjs")]);
  await assert.rejects(fsp.access(b.codexOwn), "Codex took the old folder away");
  const done = await updateProgress(b.options);
  assert.equal(done.state, "done");
  assert.deepEqual(done.todo, [{ id: "codex", title: "Codex", text: "열린 창은 닫고 새로 여세요." }]);
  assert.match(done.said, /^Codex 플러그인을 0\.9\.1로 올렸습니다\. 팀 메모리 앱을 새 판으로 다시 켰습니다\. 대화 모으기를 /);

  // The server failing after it leaves the new app up, and 다시 시도 runs the server's row.
  const failing = await bench(t, { claude: null, codex: "0.9.0", server: "honcho" });
  failing.answers.started = { ok: false, ready: false, issues: ["Docker Desktop is not running"] };
  await updateStart(failing.options);
  await drive(failing);
  const failed = await updateProgress(failing.options);
  assert.deepEqual(failing.states(failed.rows), { codex: "ok", app: "ok", runtime: "ok", server: "bad" });
  assert.equal(failed.said, `팀 메모리 앱을 새 판으로 다시 켰습니다. 대화 모으기를 ${VERSION}로 바꿨습니다. 기억 서버를 새 판으로 다시 시작하지 못했습니다: Docker Desktop is not running`);
  failing.answers.started = { ok: true, ready: true };
  failing.doctor = ["server-version"];
  failing.calls.length = 0;
  const from = failing.spawned.length;
  await updateRetry(failing.options);
  await drive(failing, from);
  assert.deepEqual(failing.calls, ["server start"]);
  assert.equal((await updateProgress(failing.options)).state, "done");
});

test("a step that fails stops there with its reason, and 다시 시도 starts again at it in the new folder", async (t) => {
  const b = await bench(t, { claude: "0.9.0", codex: "0.9.0", runtime: "0.9.0", app: "0.9.0", server: "honcho" });
  b.answers.started = { ok: false, ready: false, issues: ["Docker Desktop is not running"] };
  await updateStart(b.options);
  await drive(b);
  const failed = await updateProgress(b.options);
  assert.equal(failed.state, "failed");
  assert.equal(failed.error, "Docker Desktop is not running");
  assert.deepEqual(b.states(failed.rows), { claude: "ok", runtime: "ok", server: "bad", app: "wait", codex: "wait" });
  assert.equal(failed.rows.find((row) => row.id === "server").error, "Docker Desktop is not running");
  assert.equal(failed.serverOff, undefined, "the server still runs");
  assert.equal(b.calls.includes("app restart"), false);

  // 다시 시도 runs in the new folder, and only from the server on.
  b.answers.started = { ok: true, ready: true };
  b.doctor = ["server-version", "app"];
  const newer = path.join(b.home, ".claude", "plugins", "cache", "team-memory", "team-memory", "0.9.1");
  assert.equal(await retryCli(path.join(b.own, "scripts", "cli.mjs"), b.options), path.join(newer, "scripts", "cli.mjs"));
  const from = b.spawned.length;
  const retried = await updateRetry({ ...b.options, scriptDir: path.join(newer, "scripts") });
  assert.equal(retried.ok, true, retried.error);
  assert.deepEqual(b.states(retried.progress.rows), { claude: "ok", runtime: "ok", server: "wait", app: "wait", codex: "wait" });
  assert.deepEqual(b.spawned.slice(from).map(({ cli, args }) => [cli, args[1]]), [[path.join(newer, "scripts", "cli.mjs"), "continue"]]);
  b.calls.length = 0;
  await drive(b, from);
  assert.deepEqual(b.calls, ["server start", "app restart", "codex plugin marketplace upgrade team-memory", "codex plugin add team-memory@team-memory"]);
  assert.equal((await updateProgress(b.options)).state, "done");
  assert.deepEqual((await updateRetry(b.options)).code, "done");
});

test("a failure that leaves the server down, or a plugin that did not move, says so on its row", async (t) => {
  const b = await bench(t, { server: "honcho" });
  b.answers.started = () => {
    b.running = false;
    throw Object.assign(new Error("Command failed: docker compose up -d --build"), { stderr: "#5 ERROR: failed to solve\nfailed to solve: process did not complete successfully: exit code: 1\n" });
  };
  await updateStart(b.options);
  await drive(b);
  const failed = await updateProgress(b.options);
  const row = failed.rows.find((item) => item.id === "server");
  assert.deepEqual([row.state, row.error, row.detail], ["bad", "failed to solve: process did not complete successfully: exit code: 1", "#5 ERROR: failed to solve"]);
  assert.equal(failed.serverOff, true, "서버 켜기 is shown beside 다시 시도");

  // The marketplace still offers the version here: the plugin's row fails with what it has.
  const stale = await bench(t);
  stale.options.clientRunner = async (client, args) => {
    stale.calls.push([client, ...args].join(" "));
    return { code: 0, stdout: "", stderr: "" };
  };
  await updateStart(stale.options);
  await drive(stale);
  const view = await updateProgress(stale.options);
  assert.equal(view.state, "failed");
  assert.deepEqual(view.rows[0], { id: "claude", title: "Claude Code 플러그인", state: "bad", error: "Claude Code 플러그인이 0.9.1로 바뀌지 않았습니다. 지금 판: 0.9.0" });
  assert.equal(stale.spawned.length, 1, "nothing ran from a new folder");

  // A CLI that fails says what it said.
  const refusing = await bench(t);
  refusing.options.clientRunner = async () => ({ code: 1, stdout: "", stderr: "Error: Marketplace 'team-memory' not found\n" });
  await updateStart(refusing.options);
  await drive(refusing);
  assert.equal((await updateProgress(refusing.options)).rows[0].error, "Error: Marketplace 'team-memory' not found");
  // From this copy again, since the plugin never went up.
  const from = refusing.spawned.length;
  await updateRetry(refusing.options);
  assert.deepEqual(refusing.spawned.slice(from).map(({ cli, args }) => [cli, args[1]]), [[path.join(refusing.own, "scripts", "cli.mjs"), "run"]]);
});

test("a subscription login that ended puts a login row before the server's, and 다시 시도 goes on after it", async (t) => {
  const b = await bench(t, { claude: "0.9.0", runtime: "0.9.0", app: "0.9.0", server: "honcho" });
  b.answers.started = { ok: true, ready: false, nextAction: { kind: "gateway-login", appScreen: "models" } };
  await updateStart(b.options);
  await drive(b);
  const waiting = await updateProgress(b.options);
  assert.equal(waiting.state, "login");
  assert.deepEqual(waiting.rows.map((row) => [row.id, row.state]), [["claude", "ok"], ["runtime", "ok"], ["login", "login"], ["server", "wait"], ["app", "wait"]]);
  assert.deepEqual(waiting.rows[2], { id: "login", title: "구독 계정 로그인", sub: "브라우저에서 로그인을 마치세요.", state: "login" });
  assert.match(waiting.said, /팀 메모리 앱의 서버 → 모델에서 로그인하세요\.$/);

  b.answers.started = { ok: true, ready: true };
  b.doctor = ["server-version", "app"];
  const from = b.spawned.length;
  await updateRetry(b.options);
  await drive(b, from);
  const done = await updateProgress(b.options);
  assert.equal(done.state, "done");
  assert.deepEqual(done.rows.map((row) => [row.id, row.state]), [["claude", "ok"], ["runtime", "ok"], ["login", "ok"], ["server", "ok"], ["app", "ok"]]);
});

test("a stopped server is only prepared and stays off, with 서버 켜기 left to do", async (t) => {
  const b = await bench(t, { server: "gateway", running: false });
  await updateStart(b.options);
  await drive(b);
  assert.deepEqual(b.calls.filter((call) => call.startsWith("server")), ["server prepare"]);
  const done = await updateProgress(b.options);
  assert.equal(done.state, "done");
  assert.equal(done.serverOff, true);
  assert.deepEqual(done.rows.find((row) => row.id === "server"), {
    id: "server", title: "기억 서버 준비", sub: "게이트웨이도 새 판으로 바꿉니다. 꺼 둔 서버는 켜지 않습니다.", gateway: true, state: "ok",
  });
  assert.deepEqual(done.todo.at(-1), {
    id: "server", title: "기억 서버", text: "꺼 둔 기억 서버는 새 판으로 준비만 했습니다. 켜려면 서버 켜기를 누르세요.", action: "server-start",
  });
});

test("a server kept off stays so through 다시 시도, with 서버 켜기 left to do at the end", async (t) => {
  const b = await bench(t, { server: "honcho", running: false });
  b.answers.app = { ok: false, error: "The setup screen did not start." };
  await updateStart(b.options);
  await drive(b);
  const failed = await updateProgress(b.options);
  assert.deepEqual(b.states(failed.rows), { claude: "ok", runtime: "ok", server: "ok", app: "bad" });
  assert.equal(failed.serverOff, true);

  b.answers.app = { ok: true };
  b.doctor = ["app"];
  const from = b.spawned.length;
  assert.equal((await updateRetry(b.options)).ok, true);
  assert.equal((await b.progress()).serverOff, true, "the server's row, done, does not run again");
  await drive(b, from);
  const done = await updateProgress(b.options);
  assert.deepEqual([done.state, done.serverOff, done.todo.at(-1).action], ["done", true, "server-start"]);
  assert.deepEqual(b.calls.filter((call) => call.startsWith("server")), ["server prepare"]);
});

test("the app's row starts the app again even when the new folder's doctor checks no app, as when its pages went with the old folder", async (t) => {
  // doctor checks only an app it knows answering; with Codex only, the update took the
  // folder the app served its pages from.
  const codex = await bench(t, { claude: null, codex: "0.9.0", runtime: "0.9.0", app: "0.9.0", server: "same", doctor: ["runtime"] });
  assert.deepEqual(codex.ids((await updateStatus(codex.options)).rows), ["codex", "app", "runtime"]);
  await updateStart(codex.options);
  await drive(codex);
  assert.deepEqual(codex.calls, ["codex plugin marketplace upgrade team-memory", "codex plugin add team-memory@team-memory", "app restart", "setup apply"]);
  const done = await updateProgress(codex.options);
  assert.deepEqual([done.state, codex.states(done.rows)], ["done", { codex: "ok", app: "ok", runtime: "ok" }]);

  const claude = await bench(t, { claude: "0.9.0", runtime: "0.9.1", app: "0.9.0", server: "same", doctor: [] });
  await updateStart(claude.options);
  await drive(claude);
  assert.deepEqual(claude.calls.slice(2), ["app restart"]);
  assert.equal((await updateProgress(claude.options)).state, "done");

  // What answers in the app's place stops its row with that reason.
  const other = await bench(t, { claude: "0.9.0", runtime: "0.9.1", app: "0.9.0", server: "same", doctor: [] });
  other.answers.app = { ok: false, error: "Something else is answering at http://127.0.0.1:4180/. Close it, or set HONCHO_AGENT_BRIDGE_UI_PORT." };
  await updateStart(other.options);
  await drive(other);
  const failed = await updateProgress(other.options);
  assert.deepEqual([failed.state, other.states(failed.rows)], ["failed", { claude: "ok", app: "bad" }]);
  assert.match(failed.rows.find((row) => row.id === "app").error, /^Something else is answering at http:\/\/127\.0\.0\.1:4180\./);

  // An app the new folder's doctor sees at its version was started again already.
  const current = await bench(t, { claude: "0.9.0", runtime: "0.9.1", app: "0.9.0", server: "same" });
  current.options.doctor = async () => ({ ok: true, checks: [{ name: "configuration", ok: true }, { name: "app", ok: true, version: "0.9.1" }] });
  await updateStart(current.options);
  await drive(current);
  assert.deepEqual(current.calls.slice(2), []);
  assert.deepEqual(current.states((await updateProgress(current.options)).rows), { claude: "ok", app: "ok" });
});

test("업데이트 reads main again, and starts nothing when main's version or the warning is not what the bell showed", async (t) => {
  const b = await bench(t, { server: "honcho", running: false });
  const shown = await updateStatus(b.options);
  assert.deepEqual([shown.latest, shown.warning], ["0.9.1", null]);
  const read = b.fetched.length;

  // main moved on after the bell read it.
  b.main[".claude-plugin/plugin.json"] = JSON.stringify({ version: "0.9.2" });
  const moved = await updateStart({ ...b.options, seen: { latest: "0.9.1", warning: false } });
  assert.deepEqual([moved.ok, moved.code, moved.error], [false, "changed", "새 판이 바뀌었습니다. 바뀐 내용을 보고 업데이트를 다시 누르세요."]);
  assert.equal(b.fetched.length, read + 5, "read again at once, within the day");
  assert.deepEqual([moved.status.latest, moved.status.newer], ["0.9.2", true], "the status as it is now, for the bell to show");

  // The server was started since: its rebuild now stops teammates' reading.
  b.running = true;
  const warned = await updateStart({ ...b.options, seen: { latest: "0.9.2", warning: false } });
  assert.deepEqual([warned.code, warned.status.warning], ["changed", "기억 서버를 다시 만드는 동안 팀원 열람이 멈춥니다."]);

  // main cannot be read now: what it would bring is not known.
  b.offline = true;
  const unread = await updateStart({ ...b.options, seen: { latest: "0.9.2", warning: true } });
  assert.deepEqual([unread.ok, unread.code, unread.error], [false, "unread", "GitHub에서 새 판을 읽지 못했습니다. 인터넷 연결을 확인하고 업데이트를 다시 누르세요."]);
  assert.match(unread.detail, /fetch failed/);
  assert.equal(b.spawned.length, 0, "none of them started anything");
  assert.equal(await fsp.access(b.update).then(() => true, () => false), false);

  b.offline = false;
  const started = await updateStart({ ...b.options, seen: { latest: "0.9.2", warning: true } });
  assert.equal(started.ok, true, started.error);
  assert.equal(started.progress.to, "0.9.2");
});

test("the versions said are the ones the plugins went to, when main moved on after 업데이트 was pressed", async (t) => {
  const b = await bench(t, { claude: "0.9.0", codex: "0.9.0", runtime: "0.9.1", app: "0.9.1", server: "same", doctor: [] });
  const started = await updateStart(b.options);
  assert.equal(started.progress.to, "0.9.1");
  b.main[".claude-plugin/plugin.json"] = JSON.stringify({ version: "0.9.2" });
  await drive(b);
  const done = await updateProgress(b.options);
  assert.deepEqual([done.state, done.to], ["done", "0.9.2"]);
  assert.deepEqual(done.rows.map((row) => [row.id, row.state, row.version]), [["claude", "ok", "0.9.2"], ["codex", "ok", "0.9.2"]]);
  assert.equal(done.said, "Claude Code 플러그인을 0.9.2로 올렸습니다. Codex 플러그인을 0.9.2로 올렸습니다.");
});

test("an address in a reason keeps none of its secrets in update.json or fix.json", async (t) => {
  const secret = "https://agent:hunter2@memory.example.com/v3/health?key=abc123";
  const failing = { ok: false, error: `Honcho at ${secret} did not answer`, detail: `GET ${secret}\n502` };
  const b = await bench(t, { server: "honcho" });
  b.answers.started = failing;
  await updateStart(b.options);
  await drive(b);
  const written = await fsp.readFile(b.update, "utf8");
  const failed = JSON.parse(written);
  assert.equal(failed.error, "Honcho at https://memory.example.com/v3/health did not answer");
  assert.equal(failed.rows.find((row) => row.id === "server").detail, "GET https://memory.example.com/v3/health\n502");
  assert.match(failed.said, /기억 서버를 새 판으로 다시 시작하지 못했습니다: Honcho at https:\/\/memory\.example\.com\/v3\/health did not answer$/);
  assert.doesNotMatch(written, /hunter2|abc123|agent:/);

  // 고치기's rows the same.
  const checks = [{ name: "server-version", ok: false, fix: "고치기" }];
  const fix = (list, onStep) => fixChecks(list, {
    serverStatus: async () => ({ running: true }),
    serverStart: async () => failing,
    onStep,
  });
  await recordFix(checks, fix, b.options);
  const fixed = await fsp.readFile(path.join(b.appHome, "update", "fix.json"), "utf8");
  assert.match(fixed, /https:\/\/memory\.example\.com\/v3\/health/);
  assert.doesNotMatch(fixed, /hunter2|abc123|agent:/);

  // A plugin's CLI that names its source with a login in it.
  const plugin = await bench(t);
  plugin.options.clientRunner = async () => ({ code: 1, stdout: "", stderr: `fatal: could not read from ${secret}\n` });
  await updateStart(plugin.options);
  await drive(plugin);
  const refused = await fsp.readFile(plugin.update, "utf8");
  assert.match(refused, /could not read from https:\/\/memory\.example\.com\/v3\/health/);
  assert.doesNotMatch(refused, /hunter2|abc123/);
});

test("a computer with no server of its own runs no server step, whatever main's pins are", async (t) => {
  const b = await bench(t, { server: null });
  b.main["server/honcho-source.json"] = JSON.stringify({ ...HONCHO_PIN, commit: "f".repeat(40) });
  await updateStart(b.options);
  await drive(b);
  assert.deepEqual(b.calls, [
    "claude plugin marketplace update team-memory",
    "claude plugin update team-memory@team-memory --scope user",
    "setup apply",
    "app restart",
  ]);
  const done = await updateProgress(b.options);
  assert.deepEqual(b.ids(done.rows), ["claude", "runtime", "app"]);
});

test("rows follow what doctor marks in the new folder: one it no longer marks is done, one it adds is run", async (t) => {
  const b = await bench(t, { server: "same", doctor: ["server-version", "app"] });
  await updateStart(b.options);
  await drive(b);
  const done = await updateProgress(b.options);
  assert.deepEqual(done.rows.map((row) => [row.id, row.state]), [["claude", "ok"], ["runtime", "ok"], ["server", "ok"], ["app", "ok"]]);
  assert.deepEqual(b.calls.slice(2), ["server start", "app restart"], "no setup: the collector was current in the new folder");
});

test("on the computer that made the team, a hub that changed is left to do, until it is deployed again", async (t) => {
  const b = await bench(t, { hub: { behind: true, canDeploy: true } });
  await updateStart(b.options);
  await drive(b);
  const done = await updateProgress(b.options);
  assert.deepEqual(done.todo.at(-1), { id: "hub", title: "팀 주소", text: "팀 주소 다시 올리기를 누르세요. 올리는 동안 팀원의 로그인이 잠깐 멈춥니다.", action: "hub" });
  assert.deepEqual(b.calls.slice(2), ["setup apply", "app restart"], "the update itself never deploys the hub");
  b.hub = { behind: false, canDeploy: true };
  assert.equal((await updateProgress(b.options)).todo.some((item) => item.id === "hub"), false);

  const unsaved = await bench(t, { hub: { behind: true, canDeploy: false } });
  await updateStart(unsaved.options);
  await drive(unsaved);
  assert.deepEqual((await updateProgress(unsaved.options)).todo.at(-1), { id: "hub", title: "팀 주소", text: "관리자 탭의 Cloudflare에서 token 바꾸기를 누르세요." });

  const member = await bench(t, { hub: null });
  await updateStart(member.options);
  await drive(member);
  assert.equal((await updateProgress(member.options)).todo.some((item) => item.id === "hub"), false);
});

test("an update whose process is gone reads as failed at its row, and is started again from there", async (t) => {
  const b = await bench(t);
  await updateStart(b.options);
  const progress = await b.progress();
  progress.rows[0].state = "run";
  progress.pid = 99_999;
  await fsp.writeFile(b.update, JSON.stringify(progress));
  const view = await updateProgress(b.options);
  assert.equal(view.state, "failed");
  assert.deepEqual([view.rows[0].state, view.rows[0].error, view.error], ["bad", "중간에 멈췄습니다.", "중간에 멈췄습니다."]);
  assert.equal((await updateStatus(b.options)).blocked, null);
  const from = b.spawned.length;
  assert.equal((await updateRetry(b.options)).ok, true);
  assert.deepEqual(b.spawned.slice(from).map(({ args }) => args[1]), ["run"]);

  // One going is not started twice.
  assert.deepEqual([(await updateStart(b.options)).code, (await updateRetry(b.options)).code], ["running", "running"]);
});

test("a login row goes before the server's, and the server's run names it by whether the server runs", () => {
  const progress = { host: "claude", rows: [{ id: "claude", state: "ok" }, { id: "server", title: "기억 서버 다시 만들기", state: "run" }, { id: "app", state: "wait" }] };
  stepRow(progress, "server", "login");
  assert.deepEqual(progress.rows.map((row) => [row.id, row.state]), [["claude", "ok"], ["login", "login"], ["server", "wait"], ["app", "wait"]]);
  stepRow(progress, "server", "run", { running: false });
  assert.deepEqual(progress.rows.map((row) => [row.id, row.state]), [["claude", "ok"], ["login", "ok"], ["server", "run"], ["app", "wait"]]);
  assert.equal(progress.rows[2].title, "기억 서버 준비");
  stepRow(progress, "server", "bad", { error: "down", detail: "line" });
  assert.deepEqual(progress.rows[2], { id: "server", title: "기억 서버 준비", sub: "꺼 둔 서버는 켜지 않습니다.", state: "bad", error: "down", detail: "line" });
  stepRow(progress, "server", "run", { running: true });
  assert.equal(progress.rows[2].error, undefined);
});

test("the hosts are asked to update with their own commands", () => {
  assert.deepEqual(pluginUpdateArgs("claude", { marketplace: "team-memory", scope: "user" }), [
    ["plugin", "marketplace", "update", "team-memory"],
    ["plugin", "update", "team-memory@team-memory", "--scope", "user"],
  ]);
  assert.deepEqual(pluginUpdateArgs("claude", { marketplace: "chenjing-plugins", scope: null })[1], ["plugin", "update", "team-memory@chenjing-plugins"]);
  assert.deepEqual(pluginUpdateArgs("codex", { marketplace: "team-memory" }), [
    ["plugin", "marketplace", "upgrade", "team-memory"],
    ["plugin", "add", "team-memory@team-memory"],
  ]);
});

test("doctor --fix writes its rows to fix.json as it goes, and waits for an update the app runs", async (t) => {
  const b = await bench(t);
  const checks = [{ name: "runtime", ok: false, fix: "고치기" }, { name: "server-version", ok: false, fix: "고치기" }, { name: "mcp", ok: false }];
  const seen = [];
  const fix = (list, onStep) => fixChecks(list, {
    setupApply: async () => { seen.push((await fixProgress(b.options)).rows.map((row) => [row.id, row.state])); return { ok: true }; },
    serverStatus: async () => ({ running: false }),
    serverPrepare: async () => ({ ok: true, ready: true }),
    serverStart: async () => ({ ok: true }),
    restartApp: async () => ({ ok: true }),
    onStep,
  });
  const { fixed } = await recordFix(checks, fix, b.options);
  assert.equal(fixed.ok, true);
  assert.deepEqual(seen, [[["runtime", "run"], ["server", "wait"]]]);
  const done = await fixProgress(b.options);
  assert.equal(done.kind, "fix");
  assert.equal(done.state, "done");
  assert.deepEqual(done.rows.map((row) => [row.id, row.title, row.state]), [["runtime", "대화 모으기", "ok"], ["server", "기억 서버 준비", "ok"]]);
  assert.equal(done.serverOff, true);
  assert.deepEqual(done.todo.map((item) => item.id), ["claude", "server"]);
  assert.equal(done.said, fixed.said);

  // While an update the app started runs, doctor --fix waits for it.
  await updateStart(b.options);
  const refused = await recordFix(checks, fix, b.options);
  assert.deepEqual(refused, { refused: { code: "updating", said: "팀 메모리 앱에서 업데이트가 도는 중입니다. 업데이트가 끝나기를 기다리세요." } });
});

test("the app answers the bell from its own folder, and another computer's screen is told to press it there", async (t) => {
  const b = await bench(t, { server: null });
  process.env[UPDATE_BASE_ENV] = await serveMain(t, b);
  const { createUiServer } = await import("../scripts/ui.mjs");
  const ui = createUiServer();
  await new Promise((resolve) => ui.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => ui.close(resolve)));
  const { port } = ui.address();
  const call = async (pathname, { method = "GET", viewer = false } = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      method,
      headers: { ...(method === "POST" ? { "content-type": "application/json" } : {}), ...(viewer ? { "x-team-memory-viewer": encodeURIComponent("MacBook") } : {}) },
      ...(method === "POST" ? { body: "{}" } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  const here = await call("/api/update/status");
  assert.equal(here.status, 200);
  assert.equal(here.body.latest, "0.9.1");
  assert.equal(here.body.newer, true, "the app counts its own version");
  assert.equal(here.body.blocked, null);
  const there = await call("/api/update/status", { viewer: true });
  assert.deepEqual(there.body.blocked, { code: "here-only", reason: `업데이트는 그 컴퓨터에서 누르세요. ${HERE_ONLY.get("/api/update/start")}` });
  const pressed = await call("/api/update/start", { method: "POST", viewer: true });
  assert.deepEqual([pressed.status, pressed.body.hereOnly], [403, true]);
  // Without what the bell showed, nothing is started (and no CLI runs).
  const unseen = await call("/api/update/start", { method: "POST" });
  assert.deepEqual([unseen.status, unseen.body.ok, unseen.body.code], [200, false, "seen"]);
  assert.equal(await fsp.access(b.update).then(() => true, () => false), false);
  assert.deepEqual((await call("/api/update/progress")).body, { ok: true, progress: null });
  assert.deepEqual((await call("/api/doctor/fix/status")).body, { ok: true, progress: null });
  assert.equal((await call("/api/update/start")).status, 405, "a GET changes nothing");
});

test("update status runs from the CLI against main, with the app answering here, and prints no secret", async (t) => {
  const b = await bench(t, { claude: "0.9.1", runtime: "0.9.1", server: null });
  const main = await serveMain(t, b);
  const app = http.createServer((request, response) => {
    if (request.url === "/api/app/context") return response.end(JSON.stringify({ ok: true, version: "0.9.0" }));
    response.end('<div id="team-memory-app"></div>');
  });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => app.close(resolve)));
  const { stdout } = await execFileAsync(process.execPath, [path.join(ROOT, "scripts", "cli.mjs"), "update", "status"], {
    env: {
      ...process.env,
      HOME: b.home,
      USERPROFILE: b.home,
      HONCHO_AGENT_BRIDGE_HOME: b.appHome,
      HONCHO_AGENT_BRIDGE_USER_HOME: b.home,
      HONCHO_AGENT_BRIDGE_UI_PORT: String(app.address().port),
      [UPDATE_BASE_ENV]: main,
    },
  });
  const status = JSON.parse(stdout);
  assert.equal(status.ok, true);
  assert.deepEqual([status.latest, status.newer, status.here.app, status.here.claude], ["0.9.1", true, "0.9.0", "0.9.1"]);
  assert.deepEqual(status.rows, [{ id: "app", title: "앱 다시 켜기" }]);
  assert.doesNotMatch(stdout, /token|secret|password/i);
});
