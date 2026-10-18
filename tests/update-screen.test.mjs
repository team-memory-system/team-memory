// 업데이트's screens (ui/lib/update.js) over the update's back end (scripts/update.mjs).
// What matters: the bell has a row for a new version only, saying what 업데이트 brings
// up and, only when the server's pins differ, that teammates' reading stops; with no
// new version, a row for what doctor finds behind that 고치기 repairs, warning first
// when that rebuilds the server; and a row for an update or a 고치기 going or stopped,
// which opens its window. 업데이트 starts with what the row showed, and a version or a
// warning that moved since redraws the row with why. The dashboard says where to
// press while the bell has 업데이트. The window keeps each row's state (wait, run, ok,
// bad, login), a stopped row the update's reason as it wrote it; it waits through the
// app starting again and then loads the new version's screens, which open it again as
// the app starts, before a setup kept half way. A stopped one offers 다시 시도, and
// 서버 켜기 for a server it left off; the end, 서버 켜기 for the server kept off and 팀
// 주소 다시 올리기 only when the hub changed. 업데이트 waits while past conversations go
// in or the memory is rebuilt, saying why in the update's words; on a page another
// computer shows, every button is that computer's.
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import test, { afterEach } from "node:test";
import { fileURLToPath } from "node:url";

import { HERE_ONLY } from "../scripts/viewer.mjs";
import { REBUILD_NOTE } from "../ui/lib/check.js";
import {
  bellLines, bootWindow, dashboardLine, endHeading, endItems, endKey, follow, LONG_JOBS, loginAccount, pressUpdate, progressLines,
  redeployHub, refreshUpdate, retryUpdate, standing, UPDATE_HERE_ONLY, updateLines, windowActions,
} from "../ui/lib/update.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fsp.readFile(path.join(ROOT, file), "utf8");

const DAY = 24 * 3_600_000;
const AT = "2026-10-19T09:00:00.000Z";
const NOW = Date.parse("2026-10-19T09:10:00.000Z");
const FIX = "팀 메모리 앱 오른쪽 위 종에서 업데이트를 누르세요. Claude Code에서는 /team-memory doctor";
const ROWS = [
  { id: "claude", title: "Claude Code 플러그인" },
  { id: "runtime", title: "대화 모으기" },
  { id: "server", title: "기억 서버 다시 만들기", sub: "몇 분에서 10분 넘게 걸립니다." },
  { id: "app", title: "앱 다시 켜기" },
  { id: "codex", title: "Codex 플러그인" },
];
const LOGIN = { id: "login", title: "구독 계정 로그인", sub: "브라우저에서 로그인을 마치세요." };
const SESSIONS = "열린 창은 닫고 새로 여세요.";

/** The status of a computer one version behind whose running server main's pins rebuild, then `changes`. */
function status(changes = {}) {
  return {
    ok: true,
    latest: "0.8.14",
    checkedAt: AT,
    newer: true,
    here: { app: "0.8.13", claude: "0.8.13", codex: "0.8.13", runtime: "0.8.13" },
    rows: ROWS,
    summary: "플러그인과 대화 모으기, 기억 서버를 올립니다.",
    server: { rebuild: true, running: true, gateway: false },
    warning: REBUILD_NOTE,
    blocked: null,
    progress: null,
    ...changes,
  };
}
const CURRENT = status({ newer: false, here: { app: "0.8.14", claude: "0.8.14", codex: "0.8.14", runtime: "0.8.14" }, rows: [], summary: null, server: null, warning: null });

/** update.json with ROWS in `states` (wait for the rest), then `changes`. */
function progress(state, states = [], changes = {}) {
  return {
    version: 1,
    kind: "update",
    state,
    from: "0.8.13",
    to: "0.8.14",
    startedAt: AT,
    updatedAt: "2026-10-19T09:05:00.000Z",
    finishedAt: state === "running" || state === "login" ? null : "2026-10-19T09:05:00.000Z",
    rows: ROWS.map((row, index) => ({ ...row, state: states[index] || "wait" })),
    todo: [],
    ...changes,
  };
}
const ALL_OK = ROWS.map(() => "ok");

/** Doctor on a computer that collects, the checks in `behind` failing with a fix; `app` changes its app check. */
function doctor(behind = [], { app = {} } = {}) {
  const check = (name, extra = {}) => ({ name, ...extra, ...(behind.includes(name) ? { ok: false, fix: FIX } : { ok: true }) });
  return {
    ok: !behind.length,
    version: "0.8.14",
    checks: [
      { name: "configuration", ok: true, state: "valid" },
      check("runtime", { expectedVersion: "0.8.14", actualVersion: "0.8.13" }),
      check("server-version"),
      { name: "honcho-health", ok: true, status: 200 },
      { ...check("app", { version: "0.8.14" }), ...app },
    ],
  };
}

const saved = globalThis.fetch;
afterEach(() => { globalThis.fetch = saved; });

const json = (body) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
/**
 * A fake app: `routes` answers "METHOD /path" with a value, or a function of the body;
 * "down" (and a route not given) is a request that gets no answer, as while the app
 * starts again. Answers the calls made.
 */
function serve(routes) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const key = `${init.method || "GET"} ${url}`;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ key, body });
    let answer = routes[key];
    if (typeof answer === "function") answer = answer(body);
    if (answer === undefined || answer === "down") throw new TypeError("fetch failed");
    return json(answer);
  };
  return calls;
}

const shown = (line) => ({ kind: line.kind, title: line.title, text: line.text, blocked: line.blocked, hereOnly: line.hereOnly });

test("the bell has a row for a new version only, saying what 업데이트 brings up, and that teammates' reading stops only when the server's pins differ", () => {
  assert.deepEqual(bellLines({ status: status() }, { now: NOW }).map(shown), [{
    kind: "new",
    title: "새 판 0.8.14",
    text: "플러그인과 대화 모으기, 기억 서버를 올립니다. 기억 서버를 다시 만드는 동안 팀원 열람이 멈춥니다.",
    blocked: "",
    hereOnly: "",
  }]);
  // The pins as the server runs them: nothing rebuilt, so no warning.
  const pinned = status({ rows: ROWS.filter((row) => row.id !== "server"), summary: "플러그인과 대화 모으기를 올립니다.", server: { rebuild: false, running: null, gateway: false }, warning: null });
  assert.deepEqual(bellLines({ status: pinned }, { now: NOW }).map((line) => line.text), ["플러그인과 대화 모으기를 올립니다."]);
  // A server kept off is only prepared: no warning either.
  const off = status({ server: { rebuild: true, running: false, gateway: false }, warning: null });
  assert.deepEqual(bellLines({ status: off }, { now: NOW }).map((line) => line.text), ["플러그인과 대화 모으기, 기억 서버를 올립니다."]);
  // No new version, or none read yet: no row.
  assert.deepEqual(bellLines({ status: CURRENT }, { now: NOW }), []);
  assert.deepEqual(bellLines({ status: null }, { now: NOW }), []);
  assert.deepEqual(bellLines(null, { now: NOW }), []);
  // A check of main that failed keeps the version it found before.
  assert.deepEqual(bellLines({ status: status({ error: "fetch failed", failedAt: AT }) }, { now: NOW }).map((line) => line.title), ["새 판 0.8.14"]);
});

test("with no new version, the bell offers 업데이트 for what doctor finds behind that 고치기 repairs, saying first when it rebuilds the server", () => {
  const lines = (behind, options) => bellLines({ status: CURRENT, doctor: doctor(behind, options) }, { now: NOW });
  assert.deepEqual(lines(["runtime", "server-version"]).map(shown), [{
    kind: "behind",
    title: "대화 모으기와 기억 서버가 새 판에 맞지 않습니다.",
    text: REBUILD_NOTE,
    blocked: "",
    hereOnly: "",
  }]);
  assert.deepEqual(lines(["runtime"]).map((line) => [line.title, line.text]), [["대화 모으기가 새 판에 맞지 않습니다.", ""]], "only the server's rebuild stops teammates' reading");
  assert.equal(lines(["runtime", "server-version", "app"])[0].title, "대화 모으기와 기억 서버, 앱이 새 판에 맞지 않습니다.");
  assert.equal(lines(["app"])[0].title, "앱이 새 판에 맞지 않습니다.");
  assert.equal(lines(["server-version", "app"])[0].title, "기억 서버와 앱이 새 판에 맞지 않습니다.");
  // An app that cannot show its pages is not this page's to bring up.
  assert.deepEqual(lines(["app"], { app: { pages: false } }), []);
  assert.deepEqual(lines([]), []);
  // What fails with nothing for 고치기 to do (a server not answering) is not behind.
  assert.deepEqual(bellLines({ status: CURRENT, doctor: { checks: [{ name: "honcho-health", ok: false, status: 502 }] } }, { now: NOW }), []);
  // With a new version, the update brings it all up: its row alone.
  assert.deepEqual(bellLines({ status: status(), doctor: doctor(["runtime", "server-version"]) }, { now: NOW }).map((line) => line.kind), ["new"]);
  // doctor's FIX line sends the person here.
  assert.ok(FIX.startsWith("팀 메모리 앱 오른쪽 위 종에서 업데이트를 누르세요."));
});

test("an update or a 고치기 going or stopped keeps a row that opens its window, for a day once it stopped", () => {
  const lines = (update, { fix = null, at = NOW } = {}) => bellLines({ status: status({ progress: update }), update, fix }, { now: at }).map((line) => [line.kind, line.title, line.text]);
  const running = progress("running", ["ok", "ok", "run"]);
  assert.deepEqual(lines(running), [["going", "새 판 0.8.14", "업데이트하는 중입니다."]]);
  const login = progress("login", ["ok", "ok"], { rows: [...progress("login", ["ok", "ok"]).rows.slice(0, 2), { ...LOGIN, state: "login" }, ...progress("login").rows.slice(2)] });
  assert.deepEqual(lines(login), [["going", "새 판 0.8.14", "구독 계정 로그인이 필요합니다."]]);
  const failed = progress("failed", ["ok", "ok", "bad"], { error: "Docker Desktop is not running" });
  assert.deepEqual(lines(failed), [["going", "새 판 0.8.14", "기억 서버 다시 만들기에서 멈췄습니다."]]);
  assert.ok(standing(running, NOW + 7 * DAY), "one going stays however long it goes");
  // A day after it stopped, the new version's 업데이트 again.
  assert.equal(standing(failed, NOW + DAY), false);
  assert.deepEqual(lines(failed, { at: NOW + DAY }).map(([kind]) => kind), ["new"]);
  // One that went through leaves nothing on the bell (its hub aside, below).
  assert.deepEqual(bellLines({ status: CURRENT, update: progress("done", ALL_OK) }, { now: NOW }), []);
  // A 고치기 going sits beside the new version; one stopped stands in for what doctor finds.
  const fix = { ...progress("running"), kind: "fix", from: undefined, to: undefined, rows: [{ id: "runtime", title: "대화 모으기", state: "run" }] };
  assert.deepEqual(lines(null, { fix }), [["new", "새 판 0.8.14", "플러그인과 대화 모으기, 기억 서버를 올립니다. 기억 서버를 다시 만드는 동안 팀원 열람이 멈춥니다."], ["going", "새 판에 맞추기", "고치는 중입니다."]]);
  const stopped = { ...fix, state: "failed", rows: [{ id: "runtime", title: "대화 모으기", state: "bad", error: "setup apply failed" }] };
  assert.deepEqual(bellLines({ status: CURRENT, fix: stopped, doctor: doctor(["runtime"]) }, { now: NOW }).map((line) => [line.kind, line.text]), [["going", "대화 모으기에서 멈췄습니다."]]);
});

test("업데이트 sends what the bell showed, and a version or a warning that moved since redraws the row with why", async () => {
  serve({
    "GET /api/update/progress": { ok: true, progress: null },
    "GET /api/doctor/fix/status": { ok: true, progress: null },
    "GET /api/update/status": status(),
  });
  await refreshUpdate({ open: true, now: NOW + 100 * DAY });
  const [first] = updateLines({ now: NOW });
  assert.equal(first.text, "플러그인과 대화 모으기, 기억 서버를 올립니다. 기억 서버를 다시 만드는 동안 팀원 열람이 멈춥니다.");

  // The server went off in between: start says so with the status as it is, and starts nothing.
  const unwarned = "그사이 기억 서버가 바뀌어, 팀원 열람은 멈추지 않습니다. 보고 업데이트를 다시 누르세요.";
  const moved = status({ rows: ROWS.map((row) => (row.id === "server" ? { id: "server", title: "기억 서버 준비", sub: "꺼 둔 서버는 켜지 않습니다." } : row)), server: { rebuild: true, running: false, gateway: false }, warning: null });
  let calls = serve({ "POST /api/update/start": { ok: false, code: "changed", error: unwarned, status: moved } });
  assert.equal(await pressUpdate(first.status, { now: NOW }), null);
  assert.deepEqual(calls.map((call) => [call.key, call.body]), [["POST /api/update/start", { seen: { latest: "0.8.14", warning: true } }]]);
  const [redrawn] = updateLines({ now: NOW });
  assert.deepEqual([redrawn.title, redrawn.text, redrawn.said.text], ["새 판 0.8.14", "플러그인과 대화 모으기, 기억 서버를 올립니다.", unwarned]);

  // Another version on main: the row shows it, with start's words.
  const changed = "새 판이 바뀌었습니다. 바뀐 내용을 보고 업데이트를 다시 누르세요.";
  serve({ "POST /api/update/start": { ok: false, code: "changed", error: changed, status: status({ latest: "0.8.15" }) } });
  assert.equal(await pressUpdate(redrawn.status, { now: NOW }), null);
  const [newer] = updateLines({ now: NOW });
  assert.deepEqual([newer.title, newer.said.text], ["새 판 0.8.15", changed]);

  // Pressed again, it starts with what the row shows now, and the row is the update going.
  const started = progress("running", [], { to: "0.8.15" });
  calls = serve({ "POST /api/update/start": (body) => (body.seen.latest === "0.8.15" && body.seen.warning === true ? { ok: true, progress: started } : { ok: false, code: "changed", error: changed, status: status() }) });
  assert.deepEqual(await pressUpdate(newer.status, { now: NOW }), started);
  assert.deepEqual(updateLines({ now: NOW }).map((line) => [line.kind, line.title, line.text, line.said ?? null]), [["going", "새 판 0.8.15", "업데이트하는 중입니다.", null]]);

  // Other refusals are said as they come: main unread, with GitHub's side to open; the app not answering.
  const unread = "GitHub에서 새 판을 읽지 못했습니다. 인터넷 연결을 확인하고 업데이트를 다시 누르세요.";
  serve({ "POST /api/update/start": { ok: false, code: "unread", error: unread, detail: "HTTP 503" } });
  assert.equal(await pressUpdate(status(), { now: NOW }), null);
  serve({ "GET /api/update/progress": { ok: true, progress: null }, "GET /api/doctor/fix/status": { ok: true, progress: null }, "GET /api/update/status": status() });
  await refreshUpdate({ open: true, now: NOW + 101 * DAY });
  assert.deepEqual(updateLines({ now: NOW })[0].said, { text: unread, detail: "HTTP 503" });
  serve({});
  assert.equal(await pressUpdate(status(), { now: NOW }), null);
  assert.equal(updateLines({ now: NOW })[0].said.text, "이 앱의 서버에 연결할 수 없습니다. 창을 닫았다가 다시 열어 주세요.");
});

test("the dashboard says a new version is there and where to press, while the bell has its 업데이트", async () => {
  assert.equal(dashboardLine({ status: status() }, { now: NOW }), "새 판 0.8.14가 있습니다. 오른쪽 위 종에서 업데이트를 누르세요.");
  assert.equal(dashboardLine({ status: status({ latest: "0.8.13" }) }, { now: NOW }), "새 판 0.8.13이 있습니다. 오른쪽 위 종에서 업데이트를 누르세요.");
  assert.equal(dashboardLine({ status: CURRENT }, { now: NOW }), null);
  assert.equal(dashboardLine({ status: null }), null);
  assert.equal(dashboardLine({ status: status(), update: progress("running", ["run"]) }, { now: NOW }), null, "not while it goes");
  assert.equal(dashboardLine({ status: status(), update: progress("failed", ["bad"]) }, { now: NOW }), null, "nor while the bell has the one that stopped");
  assert.equal(dashboardLine({ status: status() }, { elsewhere: true, now: NOW }), "새 판 0.8.14가 있습니다. 그 컴퓨터의 오른쪽 위 종에서 업데이트를 누르세요.");
  // It goes on top, under a team login that ended, as words and no link.
  const dashboard = await read("ui/views/dashboard.js");
  assert.ok(dashboard.indexOf("updateNotice()") > dashboard.indexOf("ended?.node || null"));
});

test("the window's rows keep each state, a stopped row the reason as the update wrote it, docker's output to open", async () => {
  // The compose step's failure (10-17), whose cause is not known: shown as it came.
  const compose = "failed to solve: process \"/bin/sh -c npm ci --omit=dev\" did not complete successfully: exit code: 1";
  const detail = "#12 [gate 4/5] RUN npm ci --omit=dev\n#12 ERROR: process did not complete successfully";
  const failed = progress("failed", ["ok", "ok", "bad"], { error: compose });
  failed.rows[0].version = "0.8.14";
  Object.assign(failed.rows[2], { error: compose, detail });
  assert.deepEqual(progressLines(failed), [
    { label: "업데이트 중" },
    { state: "ok", title: "Claude Code 플러그인", sub: "", detail: "", version: "0.8.14" },
    { state: "ok", title: "대화 모으기", sub: "", detail: "", version: "" },
    { state: "bad", title: "기억 서버 다시 만들기", sub: compose, detail, version: "" },
    { state: "wait", title: "앱 다시 켜기", sub: "", detail: "", version: "" },
    { state: "wait", title: "Codex 플러그인", sub: "", detail: "", version: "" },
  ]);
  // Going, and stopped for a login: the row's own line.
  const running = progress("running", ["ok", "ok", "run"]);
  assert.deepEqual(progressLines(running).slice(1).map((line) => [line.state, line.sub]), [["ok", ""], ["ok", ""], ["run", "몇 분에서 10분 넘게 걸립니다."], ["wait", ""], ["wait", ""]]);
  const login = { ...progress("login"), rows: [{ ...ROWS[1], state: "ok" }, { ...LOGIN, state: "login" }, { ...ROWS[2], state: "wait" }] };
  assert.deepEqual(progressLines(login).slice(1).map((line) => [line.state, line.title, line.sub]), [
    ["ok", "대화 모으기", ""],
    ["login", "구독 계정 로그인", "브라우저에서 로그인을 마치세요."],
    ["wait", "기억 서버 다시 만들기", "몇 분에서 10분 넘게 걸립니다."],
  ]);
  // A 고치기's rows are 고치는 중.
  assert.deepEqual(progressLines({ kind: "fix", rows: [] }), [{ label: "고치는 중" }]);
  // Every state has its look.
  const css = await read("ui/styles.css");
  for (const state of ["wait", "run", "ok", "bad", "login"]) assert.match(css, new RegExp(`\\.ic\\.${state}\\b`), state);
});

test("the window waits through the app starting again, and loads the new version's screens once it answers", async () => {
  let clock = 0;
  const going = progress("running", ["ok", "ok", "ok", "run"]);
  const restarted = progress("running", ["ok", "ok", "ok", "ok", "run"]);
  let reads = [going, "down", "down", restarted];
  const versions = [];
  serve({
    "GET /api/update/progress": () => {
      clock += 1000;
      const next = reads.length > 1 ? reads.shift() : reads[0];
      return next === "down" ? "down" : { ok: true, progress: next };
    },
    "GET /api/app/context": () => { versions.push(clock); return { version: "0.8.14" }; },
  });
  const drawn = [];
  const draw = (now, { stalled }) => drawn.push([now?.rows.filter((row) => row.state === "ok").length ?? null, stalled]);
  const outcome = await follow("update", draw, { every: 1, now: () => clock, version: "0.8.13" });
  assert.deepEqual(outcome, { progress: restarted, reload: true });
  // The reads that failed drew what was there, as nothing gone wrong.
  assert.deepEqual(drawn, [[3, false], [3, false], [3, false]]);
  assert.equal(versions.length, 1, "the version is asked once the app answers again");

  // The same version answering again (its row was not the app's): nothing to load, the rows go on to the end.
  const done = progress("done", ALL_OK, { said: "Claude Code 플러그인을 0.8.14로 올렸습니다." });
  reads = [going, "down", done];
  const calls = serve({
    "GET /api/update/progress": () => { const next = reads.length > 1 ? reads.shift() : reads[0]; return next === "down" ? "down" : { ok: true, progress: next }; },
    "GET /api/app/context": { version: "0.8.13" },
  });
  assert.deepEqual(await follow("update", () => {}, { every: 1, version: "0.8.13" }), { progress: done });
  assert.equal(calls.filter((call) => call.key === "GET /api/app/context").length, 1);

  // Reads failing two minutes on end say so, and the wait goes on to the end.
  clock = 0;
  reads = [going, "down", "down", "down", done];
  serve({
    "GET /api/update/progress": () => { clock += 61_000; const next = reads.length > 1 ? reads.shift() : reads[0]; return next === "down" ? "down" : { ok: true, progress: next }; },
    "GET /api/app/context": { version: "0.8.13" },
  });
  const late = [];
  assert.deepEqual(await follow("update", (now, { stalled }) => late.push(stalled), { every: 1, now: () => clock, version: "0.8.13" }), { progress: done });
  assert.deepEqual(late, [false, false, false, true, false]);

  // A 고치기 is followed in fix.json; a window closed stops following.
  let open = true;
  serve({ "GET /api/doctor/fix/status": () => { open = false; return { ok: true, progress: { ...going, kind: "fix" } }; } });
  assert.deepEqual(await follow("fix", () => {}, { every: 1, gone: () => !open }), { progress: null, closed: true });
});

test("as the app starts, the window opens again for an update going or ended unseen, a day at most, before a setup kept half way", async () => {
  const running = progress("running", ["ok"]);
  const done = progress("done", ALL_OK, { said: "Claude Code 플러그인을 0.8.14로 올렸습니다." });
  const failed = progress("failed", ["ok", "ok", "bad"], { error: "Docker Desktop is not running" });
  assert.deepEqual(bootWindow(running, null, { now: NOW }), { kind: "update", progress: running });
  assert.deepEqual(bootWindow(done, null, { now: NOW }), { kind: "update", progress: done });
  assert.deepEqual(bootWindow(failed, null, { now: NOW }), { kind: "update", progress: failed });
  // Its end shown in this browser already, or a day old: the bell has what is left.
  assert.equal(bootWindow(done, null, { seen: endKey(done), now: NOW }), null);
  assert.equal(bootWindow(done, null, { now: NOW + DAY }), null);
  assert.deepEqual(bootWindow(running, null, { seen: endKey(running), now: NOW + DAY }), { kind: "update", progress: running }, "one going opens however long it goes");
  // A 다시 시도 that stopped again is another end.
  const again = { ...failed, updatedAt: "2026-10-19T09:08:00.000Z" };
  assert.deepEqual(bootWindow(again, null, { seen: endKey(failed), now: NOW }), { kind: "update", progress: again });
  // A 고치기 going opens its window; one that ended is the bell's.
  const fixing = { ...running, kind: "fix" };
  assert.deepEqual(bootWindow(null, fixing, { now: NOW }), { kind: "fix", progress: fixing });
  assert.equal(bootWindow(null, { ...fixing, state: "failed" }, { now: NOW }), null);
  assert.equal(bootWindow(null, null, { now: NOW }), null);
  // The shell opens it before a setup kept half way, which, as any setup window but
  // first setup's, waits for it to close.
  const shell = await read("ui/app.js");
  const boot = shell.slice(shell.indexOf("async function boot()"));
  assert.ok(boot.indexOf("await reopenUpdate({") < boot.indexOf("await show();"), "before the screen's setup window");
  assert.ok(boot.indexOf("await show();") < boot.indexOf("if (resumeAtBoot(bootPath"));
  assert.match(boot, /onClose: \(\) => \{\n\s*updateWindow = null;\n\s*if \(waiting\.later\) showSetup\(waiting\.later\);/);
  const setup = shell.slice(shell.indexOf("function showSetup("), shell.indexOf("async function show("));
  assert.match(setup, /if \(updateWindow && !firstRun\) \{\n\s*updateWindow\.later = \{ firstRun, team \};\n\s*return;/);
  assert.ok(boot.indexOf("watchUpdates();") > boot.indexOf("mountBell($(\".main\"));"), "the bell's rows once the bell is there");
});

test("a stopped update shows its row's reason with 다시 시도, and 서버 켜기 when it left the server off", async () => {
  const failed = progress("failed", ["ok", "ok", "bad"], { error: "Docker Desktop is not running" });
  failed.rows[2].error = "Docker Desktop is not running";
  assert.deepEqual(progressLines(failed)[3].sub, "Docker Desktop is not running");
  assert.deepEqual(windowActions(failed), [{ run: "retry", label: "다시 시도", primary: true }]);
  assert.deepEqual(windowActions({ ...failed, serverOff: true }).map((action) => action.label), ["서버 켜기", "다시 시도"]);
  assert.deepEqual(windowActions(progress("login")).map((action) => action.label), ["다시 시도"], "after a login that did not finish");
  assert.deepEqual(windowActions(progress("running")), []);
  assert.deepEqual(windowActions(progress("done", ALL_OK, { serverOff: true })), [], "the end has its own 서버 켜기");
  // 다시 시도 goes on from the row that stopped; a refusal says why in its own words.
  const again = progress("running", ["ok", "ok", "wait"]);
  const calls = serve({ "POST /api/update/retry": { ok: true, progress: again } });
  assert.deepEqual(await retryUpdate(), { progress: again });
  assert.deepEqual(calls.map((call) => call.key), ["POST /api/update/retry"]);
  serve({ "POST /api/update/retry": { ok: false, code: "rederive", error: LONG_JOBS.stopped } });
  assert.deepEqual(await retryUpdate(), { error: LONG_JOBS.stopped });
  // The login the update stopped for: the one the gateway waits on, else one logged out.
  const prompt = { running: true, url: "https://claude.ai/oauth/authorize?x=1", backend: "claude" };
  const accounts = [
    { id: "codex-1", backend: "codex", login: { loggedIn: true } },
    { id: "claude-1", backend: "claude", login: { loggedIn: false } },
    { id: "claude-2", backend: "claude", login: { loggedIn: false }, pendingLogin: prompt },
  ];
  assert.deepEqual(loginAccount(accounts), { accountId: "claude-2", backend: "claude", prompt });
  assert.deepEqual(loginAccount(accounts.slice(0, 2)), { accountId: "claude-1", backend: "claude", prompt: null });
  assert.equal(loginAccount(accounts.slice(0, 1)), null);
  assert.equal(loginAccount(null), null);
});

test("the end shows what is left, 서버 켜기 for the server kept off and 팀 주소 다시 올리기 only when the hub changed", async () => {
  const todo = [
    { id: "claude", title: "Claude Code", text: SESSIONS },
    { id: "server", title: "기억 서버", text: "꺼 둔 기억 서버는 새 판으로 준비만 했습니다. 켜려면 서버 켜기를 누르세요.", action: "server-start" },
    { id: "hub", title: "팀 주소", text: "팀 주소 다시 올리기를 누르세요. 올리는 동안 팀원의 로그인이 잠깐 멈춥니다.", action: "hub" },
  ];
  const done = progress("done", ALL_OK, { todo, serverOff: true, said: "Claude Code 플러그인을 0.8.14로 올렸습니다." });
  const items = (value, options) => endItems(value, options).map((item) => [item.title, item.action?.label || null]);
  assert.deepEqual(items(done), [["Claude Code", null], ["기억 서버", "서버 켜기"], ["팀 주소", "팀 주소 다시 올리기"]]);
  assert.deepEqual(items(done, { started: true }), [["Claude Code", null], ["팀 주소", "팀 주소 다시 올리기"]], "the server once started from the window");
  // A version whose hub did not change has no hub to-do, so no button.
  assert.deepEqual(items({ ...done, todo: todo.slice(0, 1) }), [["Claude Code", null]]);
  // Without a token kept here, the hub's to-do says where to put one, with no button.
  assert.deepEqual(items({ ...done, todo: [{ id: "hub", title: "팀 주소", text: "관리자 탭의 Cloudflare에서 token 바꾸기를 누르세요." }] }), [["팀 주소", null]]);
  // The heading counts what is left with what 점검 found, as first setup's end does.
  assert.equal(endHeading(endItems(done), null), "점검하는 중입니다");
  assert.equal(endHeading(endItems(done), [{ name: "대화 모으기", ok: true }, { name: "기억 서버", ok: false }]), "할 일 4개");
  assert.equal(endHeading([], [{ name: "대화 모으기", ok: true }]), "다 됐습니다");
  // Closed before it was pressed, the hub's to-do stays on the bell until the hub runs this version.
  assert.deepEqual(bellLines({ status: CURRENT, update: done }, { now: NOW + 30 * DAY }).map((line) => [line.kind, line.title, line.action]), [["hub", "팀 주소", true]]);
  assert.deepEqual(bellLines({ status: CURRENT, update: { ...done, todo: todo.slice(0, 2) } }, { now: NOW }), []);
  // 팀 주소 다시 올리기 goes up with the token kept here.
  const calls = serve({ "POST /api/team/redeploy": { ok: true, team: { name: "우리 팀", host: "team.example.com" }, created: false } });
  assert.deepEqual(await redeployHub(), { text: "팀 주소를 다시 올렸습니다.", bad: false });
  assert.deepEqual(calls.map((call) => call.key), ["POST /api/team/redeploy"]);
  serve({ "POST /api/team/redeploy": { ok: false, code: "no_token", error: "No Cloudflare API token is saved here: change it in the app's admin tab (token 바꾸기)" } });
  assert.deepEqual(await redeployHub(), { text: "관리자 탭의 Cloudflare에서 token 바꾸기를 누르세요.", bad: true });
  assert.ok((await read("scripts/update.mjs")).includes('"관리자 탭의 Cloudflare에서 token 바꾸기를 누르세요."'), "in the to-do's own words");
});

test("업데이트 waits while past conversations go in or the memory is rebuilt, and says why in the update's words", async () => {
  // The update's status holds its own button.
  assert.deepEqual(bellLines({ status: status({ blocked: { code: "past", reason: LONG_JOBS.past } }) }, { now: NOW }).map((line) => line.blocked), [LONG_JOBS.past]);
  const fixing = "고치기가 도는 중입니다. 끝난 뒤 업데이트를 누르세요.";
  assert.deepEqual(bellLines({ status: status({ blocked: { code: "fixing", reason: fixing } }) }, { now: NOW }).map((line) => line.blocked), [fixing]);
  // doctor --fix does not wait for them, so the bell holds the 업데이트 that runs it.
  const behind = (flow) => bellLines({ status: CURRENT, doctor: doctor(["server-version"]), flow }, { now: NOW })[0].blocked;
  assert.equal(behind({ past: { running: { done: 3, total: 10 } }, rederive: null }), LONG_JOBS.past);
  assert.equal(behind({ past: null, rederive: { job: { kind: "rebuild", error: null }, running: true } }), LONG_JOBS.rederive);
  assert.equal(behind({ past: null, rederive: { job: { kind: "rebuild", error: null }, running: false } }), LONG_JOBS.stopped, "one whose process stopped");
  assert.equal(behind({ past: { running: null, last: { finishedAt: AT } }, rederive: { job: { kind: "rebuild", error: "boom" }, running: false } }), "", "one stopped on an error holds nothing");
  assert.equal(behind(null), "");
  const source = await read("scripts/update.mjs");
  for (const text of Object.values(LONG_JOBS)) assert.ok(source.includes(`"${text}"`), text);
});

test("on a page another computer shows, every button is that computer's", async () => {
  assert.equal(UPDATE_HERE_ONLY, `업데이트는 그 컴퓨터에서 누르세요. ${HERE_ONLY.get("/api/update/start")}`);
  assert.ok((await read("scripts/ui.mjs")).includes("reason: `업데이트는 그 컴퓨터에서 누르세요. ${HERE_ONLY.get(\"/api/update/start\")}`"));
  const there = { code: "here-only", reason: UPDATE_HERE_ONLY };
  // The status says so itself there; a long job held here is that computer's to say.
  assert.deepEqual(bellLines({ status: status({ blocked: there }) }, { elsewhere: true, now: NOW }).map((line) => [line.hereOnly, line.blocked]), [[UPDATE_HERE_ONLY, ""]]);
  const behind = bellLines({ status: { ...CURRENT, blocked: there }, doctor: doctor(["runtime"]), flow: { past: { running: {} } } }, { elsewhere: true, now: NOW });
  assert.deepEqual(behind.map((line) => [line.kind, line.hereOnly, line.blocked]), [["behind", UPDATE_HERE_ONLY, ""]]);
  // The window: 다시 시도 and 서버 켜기 are locked with why.
  const failed = progress("failed", ["ok", "ok", "bad"], { serverOff: true });
  assert.deepEqual(windowActions(failed, { elsewhere: true }).map((action) => [action.label, action.hereOnly]), [["서버 켜기", "그 컴퓨터에서 누르세요."], ["다시 시도", UPDATE_HERE_ONLY]]);
  // The end's buttons, and the hub's row on the bell.
  const hub = { id: "hub", title: "팀 주소", text: "팀 주소 다시 올리기를 누르세요. 올리는 동안 팀원의 로그인이 잠깐 멈춥니다.", action: "hub" };
  const done = progress("done", ALL_OK, { todo: [{ id: "codex", title: "Codex", text: SESSIONS }, hub] });
  assert.deepEqual(endItems(done, { elsewhere: true }).map((item) => item.action?.hereOnly || null), [null, "그 컴퓨터에서 누르세요."]);
  assert.deepEqual(bellLines({ status: { ...CURRENT, blocked: there }, update: done }, { elsewhere: true, now: NOW }).map((line) => [line.kind, line.hereOnly]), [["hub", "그 컴퓨터에서 누르세요."]]);
  // On this computer's own page, nothing is locked.
  assert.deepEqual(bellLines({ status: status() }, { now: NOW }).map((line) => line.hereOnly), [""]);
  assert.ok(windowActions(failed).every((action) => !action.hereOnly));
});

test("the bell asks every minute for what is light, and only as it opens for a status that asked docker and for doctor's checks", async () => {
  const counts = {};
  let answer = status();
  let update = null;
  serve(new Proxy({}, {
    get: (_, key) => {
      counts[key] = (counts[key] || 0) + 1;
      if (key === "GET /api/update/status") return answer;
      if (key === "GET /api/update/progress") return { ok: true, progress: update };
      if (key === "GET /api/doctor/fix/status") return { ok: true, progress: null };
      if (key === "GET /api/status") return { detect: {}, doctor: doctor(["runtime"]) };
      if (key === "GET /api/app/flow") return { ok: true, past: null, rederive: null };
      return undefined;
    },
  }));
  const asked = (key) => counts[key] || 0;
  let at = NOW + 200 * DAY;
  // As the bell opens: the status, heavy, as main has a new version that rebuilds the server.
  await refreshUpdate({ open: true, now: at });
  assert.equal(asked("GET /api/update/status"), 1);
  // Every minute after, the same answer, while update.json stays as it was.
  for (let minute = 1; minute <= 3; minute += 1) await refreshUpdate({ now: at + minute * 60_000 });
  assert.equal(asked("GET /api/update/status"), 1);
  assert.equal(asked("GET /api/update/progress"), 4, "update.json is read each time");
  // Opened again: read again, but not twice within half a minute.
  at += 10 * 60_000;
  await refreshUpdate({ open: true, now: at });
  await refreshUpdate({ open: true, now: at + 10_000 });
  assert.equal(asked("GET /api/update/status"), 2);
  // update.json moved (an update started elsewhere): read again at once.
  update = progress("running", ["run"]);
  await refreshUpdate({ now: at + 20_000 });
  assert.equal(asked("GET /api/update/status"), 3);
  assert.equal(asked("GET /api/status"), 0, "doctor is not asked while the update has the bell");

  // A light status (no new version) is read every minute, and doctor's checks once, then as the bell opens.
  answer = CURRENT;
  update = null;
  at += 10 * 60_000;
  await refreshUpdate({ open: true, now: at });
  const light = asked("GET /api/update/status");
  const doctorReads = asked("GET /api/status");
  assert.equal(doctorReads, 1);
  for (let minute = 1; minute <= 3; minute += 1) await refreshUpdate({ now: at + minute * 60_000 });
  assert.equal(asked("GET /api/update/status"), light + 3);
  assert.equal(asked("GET /api/status"), doctorReads, "doctor's checks only as the bell opens");
  assert.equal(asked("GET /api/app/flow"), 4, "the long jobs each time what doctor found is on the bell");
  await refreshUpdate({ open: true, now: at + 5 * 60_000 });
  assert.equal(asked("GET /api/status"), doctorReads + 1);
  assert.deepEqual(updateLines({ now: at }).map((line) => [line.kind, line.title]), [["behind", "대화 모으기가 새 판에 맞지 않습니다."]]);
});
