// 점검: what a setup, a fix or an update left on this computer, as the rows a window
// shows under 점검, each one what it runs (a version, an address) or what is wrong
// and what to press. checkRows reads doctor's checks and, for a server on this
// computer, `server verify` without a model call; teamCheckRows the team's logins,
// for a setup that stores nothing. checkBox draws the rows and does what a button
// says: 고치기 runs doctor --fix and shows its rows (fix.json) while it goes, also
// across the app starting again on its new version; 명령 복사, 서버 켜기, a team
// login and 다시 점검 do the same in every window, and 대화 수집 수정 is the
// window's own. On a page another computer shows, 고치기 is locked, as the app
// there refuses it (scripts/viewer.mjs HERE_ONLY). First setup's end
// (views/setup.js) and the 대화 수집 window's 적용 (views/settings.js) use it.
import { get, post } from "./api.js";
import { AGENTS, pluginCommands, problem, sameServer } from "./collect.js";
import { h, clear, copyText } from "./dom.js";
import { progressList } from "./kit.js";
import { hereOnlyButton, hereOnlyNote, shownElsewhere } from "./machines.js";
import { app, go, loadContext } from "./state.js";
import { loginEndedText, loginTab, relogin, teamStatus } from "./team.js";
import { busy, button, notice, tag } from "./ui.js";

// What a failed row offers; 다시 점검 ends every one.
const RECHECK = { kind: "recheck", label: "다시 점검" };
const FIX = { kind: "fix", label: "고치기" };
const START = { kind: "start", label: "서버 켜기" };
const COLLECT = { kind: "collect", label: "대화 수집 수정" };

/** Said before a 고치기 that makes the server again, in the update's words (scripts/update.mjs). */
export const REBUILD_NOTE = "기억 서버를 다시 만드는 동안 팀원 열람이 멈춥니다.";

/** Why 고치기 is locked on a page another computer shows: the way here goes while it runs. */
export const FIX_HERE_ONLY = "고치기는 그 컴퓨터에서 누르세요. 고치는 동안 이 화면으로 오는 길이 끊깁니다.";

/**
 * The plugin's install from its own repository, as scripts/host-plugins.mjs
 * (manualCommands) gives it: what 명령 복사 copies when setup gave no commands.
 */
export const INSTALL_COMMANDS = {
  claude: ["claude plugin marketplace add team-memory-system/team-memory", "claude plugin install team-memory@team-memory --scope user"],
  codex: ["codex plugin marketplace add team-memory-system/team-memory", "codex plugin add team-memory@team-memory"],
};

// fix.json is read this often while 고치기 runs; once its request ended with the
// app, this many reads in a row without its rows (the app not answering, or no fix
// started) end the wait.
const POLL_MS = 2000;
const GIVE_UP = 90;

/** An address as a row shows it: its host and port. */
function hostOf(value) {
  try { return new URL(value).host; } catch { return ""; }
}

const checkRow = (name, value = "") => ({ name, value, ok: true, problems: [], actions: [] });

/** A problem on a row, once, and what to press for it; commands to copy join the row's one 명령 복사. */
function fail(row, text, action = null) {
  row.ok = false;
  if (!row.problems.includes(text)) row.problems.push(text);
  if (!action) return;
  const kept = row.actions.find((item) => item.kind === action.kind);
  if (!kept) row.actions.push({ ...action });
  else if (action.text && !kept.text.includes(action.text)) kept.text = `${kept.text}\n${action.text}`;
}

const rechecked = (rows) => rows.map((row) => (row.ok || row.follows ? row : { ...row, actions: [...row.actions, RECHECK] }));

/** The one row of a check that could not be made. */
export function checkFailed() {
  const row = checkRow("점검");
  fail(row, "점검하지 못했습니다.");
  return rechecked([row]);
}

/**
 * Why a server did not answer one of doctor's probes, and what to press: one on
 * this computer is started from here, another only where it runs. `named` is the
 * server as the line names it.
 */
function reachProblem(probe, named, local) {
  if (probe?.access || probe?.status === 401 || probe?.status === 403) return [`${named}가 이 컴퓨터의 요청을 막았습니다.`, COLLECT];
  if (probe?.status) return [`${named}가 오류로 답합니다 (HTTP ${probe.status}).`, null];
  return local ? [`${named}가 답하지 않습니다.`, START] : [`${named}가 답하지 않습니다. 서버를 둔 컴퓨터에서 서버를 켜세요.`, null];
}

/**
 * 점검 of a setup that collects: doctor's checks and, for a server on this computer,
 * `server verify` without a model call (`verify`, null when not asked), as rows
 * `{ name, ok, value, problems, actions }`. A failed row says what is wrong and
 * offers what to press: 고치기 (`doctor --fix`) for what is behind this version,
 * with REBUILD_NOTE when it makes the server again, 서버 켜기 for the server here,
 * 명령 복사 for a plugin to install or turn on, 대화 수집 수정 for a server that
 * refuses this computer or is not the one chosen (`expected`), and 다시 점검. A row
 * that `follows` another is not judged on its own: 임베딩 when 기억 서버 already says
 * Ollama is not there. `done` is what setup apply said, with the commands it could
 * not run. A check's own `fix` line is for the terminal and never shown.
 */
export function checkRows(doctor, verify, { context = null, expected = null, done = null } = {}) {
  const checks = new Map((doctor?.checks || []).map((check) => [check.name, check]));
  if (!checks.size) return checkFailed();
  const rows = [];

  // 대화 모으기: the setup, the files the hooks run, the MCP server and each agent's plugin.
  const runtime = checks.get("runtime");
  const collect = { ...checkRow("대화 모으기", runtime?.actualVersion || ""), missing: [] };
  const configuration = checks.get("configuration");
  if (configuration && !configuration.ok) fail(collect, configuration.state === "missing" ? "이 컴퓨터에 대화 수집 설정이 없습니다." : "대화 수집 설정을 읽을 수 없습니다.", COLLECT);
  if (runtime && !runtime.ok && runtime.fix) {
    const old = runtime.actualVersion && runtime.actualVersion !== runtime.expectedVersion ? `(${runtime.actualVersion})` : "";
    fail(collect, runtime.missingFiles?.length ? "대화 모으기 파일이 빠졌습니다." : `대화 모으기가 옛 판${old}입니다.`, FIX);
  }
  if (checks.get("mcp")?.ok === false) fail(collect, "MCP 서버가 답하지 않습니다.");
  for (const name of Object.keys(AGENTS)) {
    const plugin = checks.get(`${name}-plugin`);
    if (!plugin || plugin.ok) continue;
    if (!plugin.installed) {
      const commands = pluginCommands(done, name);
      collect.missing.push(name);
      fail(collect, `${AGENTS[name]}에 팀 메모리 플러그인이 없습니다.`, { kind: "copy", label: "명령 복사", text: (commands.length ? commands : INSTALL_COMMANDS[name]).join("\n") });
      continue;
    }
    // Claude Code turns a plugin on with a command; Codex only in its own settings.
    const id = name === "claude" ? plugin.pluginIds?.[0] : "";
    fail(collect, `${AGENTS[name]}에 팀 메모리 플러그인이 꺼져 있습니다.`, id ? { kind: "copy", label: "명령 복사", text: `claude plugin enable ${id}` } : null);
  }
  if (checks.get("codex-hook")?.ok === false) fail(collect, "Codex 훅이 설정돼 있지 않습니다.", COLLECT);
  rows.push(collect);

  // 기억 서버: the one collection goes to and, with verify, the server here end to end.
  const health = checks.get("honcho-health");
  const url = health?.url || "";
  const local = Boolean(context?.localServer) && (sameServer(url, context.localServer.apiUrl) || (Boolean(context.team?.localHost) && hostOf(url) === context.team.localHost));
  const { status, honcho, containerHost, embedding } = verify?.checks || {};
  const down = Boolean(status && !status.ok);
  const server = checkRow("기억 서버", hostOf(url));
  if (health && !health.ok && !(local && down)) fail(server, ...reachProblem(health, "기억 서버", local));
  const workspaces = checks.get("honcho-workspaces");
  if (health?.ok && workspaces && !workspaces.ok) fail(server, ...reachProblem(workspaces, "기억 서버", local));
  if (url && expected && !sameServer(url, expected)) fail(server, `대화가 ${hostOf(expected)} 대신 ${hostOf(url)}에 쌓이게 돼 있습니다.`, COLLECT);
  const version = checks.get("server-version");
  const rebuild = Boolean(version && !version.ok && version.fix);
  if (rebuild) fail(server, "기억 서버가 옛 판입니다.", FIX);
  // Whether this row says Ollama is not there, which 임베딩 then follows.
  let ollama = false;
  if (down) {
    const host = status.host || {};
    if (status.docker && !status.docker.running) fail(server, "Docker Desktop이 꺼져 있습니다.", START);
    else if (!status.running) fail(server, "기억 서버가 꺼져 있습니다.", START);
    else if (!host.gatewayLoggedIn) fail(server, "구독 게이트웨이에 로그인한 계정이 없습니다. 서버 → 모델에서 로그인하세요.");
    else if (!host.routerHealthy) fail(server, "구독 게이트웨이가 응답하지 않습니다.", START);
    else if (!host.ollamaHealthy) { ollama = true; fail(server, "Ollama가 응답하지 않습니다.", START); }
    else if (!host.embeddingResident) { ollama = true; fail(server, "Ollama가 아직 임베딩 모델을 불러오지 못했습니다.", START); }
    else fail(server, "기억 서버가 답하지 않습니다.", START);
  } else {
    if (honcho && !honcho.ok) fail(server, "기억 서버가 답하지 않습니다.", START);
    if (containerHost?.router?.ok === false) fail(server, "기억 서버가 구독 게이트웨이를 부르지 못합니다.", START);
    if (containerHost?.ollama?.ok === false) { ollama = true; fail(server, "기억 서버가 Ollama를 부르지 못합니다.", START); }
  }
  if (health || verify) rows.push(server);

  // 임베딩: a long text through the embedding model, as Honcho sends one.
  if (verify) {
    const row = checkRow("임베딩");
    if (!verify.checks) fail(row, "임베딩을 점검하지 못했습니다.");
    else if (embedding && !embedding.ok && ollama) Object.assign(row, { ok: false, follows: true });
    else if (embedding && !embedding.ok) {
      if (!embedding.status) fail(row, "임베딩 모델(Ollama)이 답하지 않습니다.", START);
      else if (embedding.status >= 400) fail(row, `Ollama가 임베딩 요청을 받지 않습니다 (HTTP ${embedding.status}).`, START);
      else fail(row, "임베딩 모델의 답이 이 서버의 설정과 맞지 않습니다.");
    }
    rows.push(row);
  }

  // The other servers that take some folders' conversations.
  for (const [name, check] of checks) {
    if (!name.startsWith("target-")) continue;
    const id = name.slice("target-".length);
    const label = (context?.targets || []).find((target) => target.id === id)?.label || id;
    const row = checkRow(label, hostOf(check.url));
    if (!check.ok) fail(row, ...reachProblem(check.health?.ok === false ? check.health : check.workspace, /서버$/.test(label) ? label : `${label} 서버`, false));
    rows.push(row);
  }

  // The app shows this page, so it is a row only when it is behind this version.
  const shell = checks.get("app");
  if (shell && !shell.ok) {
    const row = checkRow("앱", shell.version || "");
    fail(row, "앱이 옛 판입니다.", shell.fix ? FIX : null);
    rows.push(row);
  }
  // One 고치기 fixes all that is behind: each says so when the server is among it.
  if (rebuild) for (const row of rows) for (const action of row.actions) if (action.kind === "fix") action.note = REBUILD_NOTE;
  return rechecked(rows);
}

/**
 * 점검 for a setup that stores nothing (쌓지 않기): the team login, and the one
 * login every teammate's server takes, from the team's status. `host` is a
 * teammate's server to log in at; with none yet, there is nothing to log in to.
 */
export function teamCheckRows(status, { host = "" } = {}) {
  if (!status || status.ok === false) return checkFailed();
  const hub = checkRow("팀 로그인", status.email || "");
  const hubEnded = status.hubLogin?.ended;
  if (!status.hubLogin?.signedIn) {
    fail(hub, hubEnded ? loginEndedText({ kind: "hub", email: hubEnded.email }) : "팀에 로그인돼 있지 않습니다.", { kind: "login", login: "hub", host: "", label: hubEnded ? "다시 로그인" : "팀 로그인" });
  }
  const rows = [hub];
  const servers = status.serversLogin || {};
  if (servers.signedIn || host) {
    const row = checkRow("팀 서버 로그인");
    if (!servers.signedIn) {
      fail(row, servers.ended ? loginEndedText({ kind: "servers", email: servers.ended.email }) : "팀원 기억을 읽으려면 팀 서버 로그인이 한 번 필요합니다.", { kind: "login", login: "servers", host, label: servers.ended ? "다시 로그인" : "팀 서버 로그인" });
    }
    rows.push(row);
  }
  return rechecked(rows);
}

/**
 * What a failed row offers in this window: its buttons and the lines over them. On
 * a page another computer shows (`elsewhere`), 고치기 is there but locked, with
 * FIX_HERE_ONLY in place of what it would stop first.
 */
export function offers(row, { elsewhere = false } = {}) {
  const locked = elsewhere && row.actions.some((action) => action.kind === "fix");
  return {
    locked,
    notes: locked ? [FIX_HERE_ONLY] : [...new Set(row.actions.map((action) => action.note).filter(Boolean))],
    actions: locked ? row.actions.map((action) => (action.kind === "fix" ? { ...action, hereOnly: FIX_HERE_ONLY } : action)) : row.actions,
  };
}

/** The rows that failed on their own: a row that follows another is not counted again. */
export function failures(rows) {
  return (rows || []).filter((row) => !row.ok && !row.follows).length;
}

/** The agents whose plugin 점검 found missing, their row copying the install commands: null when 점검 could not tell. */
export function missingPlugins(rows) {
  const collect = (rows || []).find((row) => row.missing);
  return collect ? new Set(collect.missing) : null;
}

/** What the 점검 row says it looks at while it runs. */
export function checkingText({ team = false, verify = false } = {}) {
  if (team) return "팀 로그인, 팀 서버 로그인";
  return verify ? "대화 모으기, 기억 서버, 임베딩" : "대화 모으기, 기억 서버";
}

/**
 * 점검 of this computer: doctor (/api/status) and, with `verify`, `server verify`
 * for the server here. `expected` is the server collection should go to, `done`
 * what setup apply said.
 */
export async function checkHere({ verify = false, expected = null, done = null } = {}) {
  await loadContext().catch(() => {});
  const [status, verified] = await Promise.all([
    get("/api/status").catch(() => null),
    verify ? post("/api/server/verify", { profile: "personal" }).catch((error) => ({ ok: false, error: error.message })) : null,
  ]);
  return checkRows(status?.doctor, verified, { context: app.context, expected, done });
}

/** 점검 of a setup that stores nothing: the team's logins, `host` a teammate's server. */
export async function checkTeam({ host = "" } = {}) {
  return teamCheckRows(await teamStatus().catch(() => null), { host });
}

/** 서버 켜기: the server on this computer and its host services. `again` is the button to press once more. */
export async function startServer(again = "서버 켜기") {
  const started = await post("/api/server/start", { profile: "personal" });
  // What did not come up on this computer often comes up on a second try.
  if (!started.ok) throw new Error(`${problem(started, "기억 서버를 켜지 못했습니다.")}${started.host ? ` ${again}를 누르세요.` : ""}`);
  await post("/api/host/start", {}).catch(() => {});
  await loadContext();
}

/** fix.json's rows (GET /api/doctor/fix/status) as the box shows them while 고치기 runs. */
export function fixLines(progress) {
  const rows = (progress?.rows || []).map((row) => {
    // A subscription login that went is a stop like any other here: its line says where to log in.
    const state = row.state === "login" ? "bad" : row.state;
    return { state, title: row.title, sub: state === "bad" ? row.error || row.sub : row.sub };
  });
  return [{ label: "고치는 중" }, ...(rows.length ? rows : [{ state: "run", title: "고치기" }])];
}

/**
 * What a 고치기 says after: doctor --fix's own answer, or, when the request had none
 * (it ended with the app starting again on its new version), fix.json's
 * (`progress`). `{ text, bad }`, or null when there was nothing to fix.
 */
export function fixOutcome(answer, progress) {
  if (answer) {
    if (answer.said) return { text: answer.said, bad: answer.fixed ? answer.fixed.ok === false : answer.ok === false };
    if (answer.ok === false && !answer.checks) return { text: problem(answer, "고치지 못했습니다."), bad: true };
    return null;
  }
  if (progress?.said) return { text: progress.said, bad: progress.state !== "done" };
  return { text: "고치지 못했습니다.", bad: true };
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fixStatus = () => get("/api/doctor/fix/status").then((answer) => answer?.progress || null, () => null);

/**
 * 고치기: doctor --fix, with fix.json's rows drawn by `draw` while it goes. A fix
 * that brings the app to its new version starts the app again, which ends this
 * request: the rows and what the fix said are then read from fix.json alone, the
 * app answering again after a few seconds. One refused because a 고치기 runs
 * already follows that one the same way: the browser may send a request that ended
 * with the app once more, to the app started again. A request that came back
 * empty, or as the way's 502 from another computer, is one that ended with the app
 * too. fix.json is read every `every` ms, never more often, and a wait without this
 * 고치기's rows ends after GIVE_UP reads. Answers what fixOutcome says.
 */
export async function runFix(draw, { every = POLL_MS } = {}) {
  const before = (await fixStatus())?.startedAt || null;
  let answer = null;
  // With no answer of its own, whose rows to follow: "ours" once the request ended
  // with the app or came back empty, "any" when another 고치기 was running.
  let follow = "";
  let going = true;
  const asked = post("/api/doctor/fix", {}).then((value) => {
    if (!value || typeof value !== "object") follow = "ours";
    else if (value.ok === false && value.code === "fixing") follow = "any";
    else answer = value;
  }, (error) => {
    // No answer at all here, or the way's 502 on a page another computer shows.
    if (error.unreachable && (!error.status || error.status === 502)) follow = "ours";
    else answer = { ok: false, error: error.message };
  }).finally(() => { going = false; });
  let progress = null;
  let misses = 0;
  // This 고치기's rows: one started after the press, or with "any", the one running and then the same one.
  const followed = (now) => Boolean(now) && (now.startedAt !== before
    || (follow === "any" && (now.state === "running" || now.startedAt === progress?.startedAt)));
  draw(fixLines(null));
  for (;;) {
    // While the request goes, its answer or `every`, whichever comes first; once it is back, `every` each time.
    await (going ? Promise.race([asked, pause(every)]) : pause(every));
    const now = await fixStatus();
    if (followed(now)) {
      progress = now;
      misses = 0;
      draw(fixLines(now));
    } else if (!going) {
      misses += 1;
    }
    if (answer) break;
    if (!going && ((progress && progress.state !== "running") || misses > GIVE_UP)) break;
  }
  return fixOutcome(answer, progress?.state === "running" ? null : progress);
}

/**
 * The 점검 box: `check()` answers its rows (checkHere, checkTeam), asked now unless
 * `rows` are given, and again on 다시 점검 and after a button; `sub` is what the 점검
 * row says it looks at while it runs. `onCollect` is what 대화 수집 수정 does in this
 * window, `onChecked(rows)` hears each answer, for a heading that counts what is
 * left. Answers `{ root, again }`.
 */
export function checkBox({ check, rows = null, sub = "", onCollect = () => go("computer/collect"), onChecked = null }) {
  const box = h("div", {});
  const said = h("div", {});
  let shown = rows;
  // What the last button said: what 고치기 did, why the server did not start, a copy.
  let note = null;
  const sayNote = () => clear(said, note ? (note.bad ? notice("bad", note.text) : h("div", { class: "hint", style: { marginTop: "8px" } }, note.text)) : null);
  const paint = (lines = null) => {
    clear(box, progressList(lines || boxLines()));
    sayNote();
  };

  async function again() {
    shown = null;
    paint();
    shown = await check().catch(() => checkFailed());
    paint();
    onChecked?.(shown);
  }

  const press = (action) => {
    if (action.hereOnly) return hereOnlyButton(action.label, action.hereOnly);
    if (action.kind === "copy") {
      return button(action.label, { kind: "small", onClick: async () => {
        await copyText(action.text);
        note = { text: "명령을 복사했습니다. 터미널에서 실행하세요." };
        sayNote();
      } });
    }
    if (action.kind === "collect") return button(action.label, { kind: "small", onClick: () => onCollect() });
    if (action.kind === "login") {
      return button(action.label, { kind: "small", onClick: (event) => {
        // Opened in this click, so the browser lets it.
        const tab = loginTab("Google 로그인으로 넘어가는 중입니다…");
        busy(event.currentTarget, async () => {
          note = null;
          await relogin({ kind: action.login, host: action.host, tab }).catch((error) => {
            tab?.close();
            note = { text: error.message, bad: true };
          });
          await again();
        });
      } });
    }
    return button(action.label, { kind: "small", onClick: (event) => busy(event.currentTarget, async () => {
      note = null;
      if (action.kind === "fix") note = await runFix(paint);
      if (action.kind === "start") await startServer().catch((error) => { note = { text: error.message, bad: true }; });
      await again();
    }) });
  };

  /**
   * How it went, then a row each: a failed one with what is wrong, what 고치기 stops
   * first (or, on a page another computer shows, where to press it), and its buttons.
   */
  function boxLines() {
    if (!shown) return [{ label: "점검" }, { state: "run", title: "점검", sub }];
    const failed = failures(shown);
    const elsewhere = shownElsewhere();
    return [
      { label: ["점검 ", failed ? tag(`실패 ${failed}개`, "bad") : tag("모두 통과", "ok")] },
      ...shown.map((row) => {
        if (row.follows) return { state: "wait", title: row.name };
        if (row.ok) return { state: "ok", title: row.name, end: row.value ? h("span", { class: "mono muted" }, row.value) : null };
        const { locked, notes, actions } = offers(row, { elsewhere });
        return {
          state: "bad",
          title: row.name,
          sub: [
            row.problems.join(" "),
            notes.map((text) => (locked ? hereOnlyNote(text) : h("div", { class: "hint" }, text))),
            h("div", { style: { display: "flex", flexWrap: "wrap", gap: "6px", marginTop: "8px" } }, actions.map(press)),
          ],
        };
      }),
    ];
  }

  if (shown) {
    paint();
    onChecked?.(shown);
  } else {
    again();
  }
  return { root: h("div", {}, box, said), again };
}
