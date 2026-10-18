// 업데이트: a new version on GitHub's main (scripts/update.mjs), which the bell at the
// top right and a line on the dashboard tell, and one button brings up. With none, the
// bell's 업데이트 brings up what doctor finds behind this version (고치기, lib/check.js),
// and an update or a 고치기 that goes, or stopped, keeps a row there that opens its
// window, as does an update that ended unseen. The window shows update.json's rows
// (fix.json's) as first setup's 적용 shows its own, read every few seconds: the app
// starting again on its new version cuts the reads for a moment, and the page then
// loads that version's screens, which open the window again as the app starts
// (reopenUpdate). It ends with 점검 and what is left to do, or with the row that
// stopped, its reason and what to press. On a page another computer shows, what the
// way there refuses (scripts/viewer.mjs HERE_ONLY) is locked: 업데이트 and 다시 시도,
// and the login that goes on to 다시 시도; 서버 켜기 and 팀 주소 다시 올리기 are
// pressed as here.
import { gateway, get, post } from "./api.js";
import { pendingLogin } from "./accounts.js";
import { bellSource, refreshBell } from "./bell.js";
import { checkBox, checkHere, checkingText, failures, fixLines, REBUILD_NOTE, runFix, startServer } from "./check.js";
import { problem } from "./collect.js";
import { h, clear } from "./dom.js";
import { josa } from "./format.js";
import { listItem, modal, progressList, todoList } from "./kit.js";
import { gatewayLogin } from "./login.js";
import { hereOnlyButton, hereOnlyNote, shownElsewhere } from "./machines.js";
import { app, go } from "./state.js";
import { busy, button, details, notice, toast } from "./ui.js";

// update.json is read this often while the update goes; reads failing this long on
// end are an app that does not come back by itself.
const POLL_MS = 2500;
const STALL_MS = 120_000;
// An update or a 고치기 that stopped stays on the bell for a day, and an update that
// ended opens its window as the app starts for as long.
const DAY_MS = 24 * 3_600_000;
// What the bell reads again only as it opens, and then no more often than this: a
// status that asked docker about the server, and doctor's checks (/api/status runs
// detect and doctor), which are read once as the app starts.
const FRESH_MS = 30_000;
// The last update whose end this browser showed.
const SEEN_KEY = "tm.update";
const PROGRESS = { update: "/api/update/progress", fix: "/api/doctor/fix/status" };

/** Why 업데이트 is pressed only in front of its computer (scripts/ui.mjs UPDATE_HERE_ONLY). */
export const UPDATE_HERE_ONLY = "업데이트는 그 컴퓨터에서 누르세요. 업데이트하는 동안 이 화면으로 오는 길이 끊깁니다.";
// A login row there: that page has no login panel, as the 다시 시도 after it is the computer's.
const LOGIN_THERE = "그 컴퓨터의 종에서 열기를 누르면 로그인 칸이 나옵니다.";

/**
 * Why 업데이트 waits, in the update's own words (scripts/update.mjs LONG_JOBS, their
 * `update`). A 고치기 that makes the server again is refused while they go
 * (recordFix), so the bell holds the 업데이트 that runs one, while 기억 서버 is behind.
 */
export const LONG_JOBS = Object.freeze({
  past: "지난 대화를 쌓는 중입니다. 다 쌓은 뒤 업데이트를 누르세요.",
  rederive: "기억을 다시 정리하는 중입니다. 다 끝난 뒤 업데이트를 누르세요.",
  stopped: "기억 다시 정리가 멈춰 있습니다. 서버 → 기억 서버를 열면 이어서 정리합니다. 다 끝난 뒤 업데이트를 누르세요.",
});

// An app that stopped answering opens again from an agent (skills/setup-memory, ui open).
const STALLED = "앱이 답하지 않습니다. Claude Code에서 /team-memory setup을, Codex에서 $setup-memory를 실행하세요.";
const NO_ACCOUNT = "서버 → 모델에서 구독 계정을 로그인한 뒤 다시 시도를 누르세요.";
// The hub without a token kept here, as the update's to-do says it (scripts/update.mjs todoOf).
const NO_TOKEN = "관리자 탭의 Cloudflare에서 token 바꾸기를 누르세요.";

// doctor's checks 고치기 repairs, as the bell names them (scripts/update.mjs FIX_ROWS).
const BEHIND = [["runtime", "대화 모으기"], ["server-version", "기억 서버"], ["app", "앱"]];

// What a to-do's `action` is pressed with.
const ACTIONS = {
  "server-start": { run: "start", label: "서버 켜기" },
  hub: { run: "hub", label: "팀 주소 다시 올리기" },
};

// ── What the bell, the dashboard and the window read ─────

/**
 * What was read last: the update's status (GET /api/update/status) and when, the
 * update and the 고치기 as their files have them, doctor's checks and when, the long
 * jobs (/api/app/flow), and what the last 업데이트 pressed on the bell came back with,
 * and of what the bell showed then (shownOf).
 */
const known = { status: null, statusAt: 0, update: undefined, fix: null, doctor: null, doctorAt: 0, flow: null, said: null, saidOf: "", hub: null };
let asking = null;
const listeners = new Set();
// The version whose screens this page runs: the app's as the page started.
let pageVersion = "";

const progressOf = (kind) => get(PROGRESS[kind]).then((answer) => answer?.progress || null);

/** What the bell shows of a status, which 업데이트 starts with: main's version, and whether it warned. */
const shownOf = (status) => `${status?.latest || ""} ${Boolean(status?.warning)}`;

function keepStatus(status, now = Date.now()) {
  // A refusal said of another version, or of the same one warned otherwise, is not this row's.
  if (known.said && shownOf(status) !== known.saidOf) known.said = null;
  known.status = status;
  known.statusAt = now;
  for (const listener of listeners) listener(status);
}

/**
 * The update's status, the last one unless `fresh`: one request at a time, which
 * the bell and the dashboard share.
 */
export function loadUpdate({ fresh = false, now = Date.now() } = {}) {
  if (asking) return asking;
  if (known.status && !fresh) return Promise.resolve(known.status);
  asking = get("/api/update/status").then((status) => {
    keepStatus(status, now);
    return status;
  }, () => known.status).finally(() => { asking = null; });
  return asking;
}

/** Hears each status read, for the dashboard's line. */
export function onUpdate(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Neither an update, a new version, nor a 고치기 is on the bell: what doctor finds behind may be. */
const nothingElse = (now) => !standing(known.update ?? known.status?.progress, now) && !known.status?.newer && !standing(known.fix, now);

/**
 * Reads again what the bell shows, each time it asks (as it opens, `open`, and every
 * minute): the update and the 고치기 from their files; the status every time it was
 * light, and once the update moved, but one that asked docker about the server only
 * as the bell opens; and with nothing else on the bell, doctor's checks once, then as
 * it opens and once an update or a 고치기 ended since the last read, with the long
 * jobs while 기억 서버 is behind, as they hold its 업데이트.
 */
export async function refreshUpdate({ open = false, now = Date.now() } = {}) {
  const stale = (at) => open && now - at > FRESH_MS;
  const [update, fix] = await Promise.all([
    progressOf("update").catch(() => known.update ?? null),
    progressOf("fix").catch(() => known.fix),
  ]);
  if (ended(known.update, update) || ended(known.fix, fix)) forgetDoctor();
  known.update = update;
  known.fix = fix;
  const moved = (update?.updatedAt || "") !== (known.status?.progress?.updatedAt || "");
  await loadUpdate({ fresh: !known.status?.newer || moved || stale(known.statusAt), now });
  if (!nothingElse(now)) return;
  if (!known.doctorAt || stale(known.doctorAt)) {
    known.doctorAt = now;
    known.doctor = await get("/api/status").then((answer) => answer?.doctor || null, () => known.doctor);
  }
  known.flow = behindChecks(known.doctor).includes("server-version") ? await get("/api/app/flow").catch(() => null) : null;
}

/** After an update or a 고치기, doctor's checks are read again as the bell next asks. */
function forgetDoctor() {
  known.doctor = null;
  known.doctorAt = 0;
}

/**
 * A run that ended since the last read: one read going that goes no more (it ended or
 * stopped, or another took its place), or one with a new end, as a 고치기 of seconds
 * that no minute's read caught going.
 */
const ended = (before, after) => (before?.state === "running" && (after?.state !== "running" || after.startedAt !== before.startedAt))
  || Boolean(after?.finishedAt && after.finishedAt !== before?.finishedAt);

// ── What each shows ──────────────────────────────────────

/** An update or a 고치기 the bell keeps: one going, or one that stopped within the day. */
export function standing(progress, now = Date.now()) {
  if (!progress) return false;
  if (progress.state === "running") return true;
  return (progress.state === "login" || progress.state === "failed") && now - Date.parse(progress.updatedAt || "") < DAY_MS;
}

/** doctor's checks that 고치기 repairs and fail now; an app that cannot show its pages is not this page's to bring up. */
export function behindChecks(doctor) {
  const checks = doctor?.checks || [];
  return BEHIND.map(([name]) => name)
    .filter((name) => checks.some((check) => check.name === name && !check.ok && check.fix && !(name === "app" && check.pages === false)));
}

/** "대화 모으기와 기억 서버가 새 판에 맞지 않습니다.": what doctor finds behind, by name. */
export function behindLine(names) {
  const words = BEHIND.filter(([name]) => names.includes(name)).map(([, word]) => word);
  if (!words.length) return "";
  const [first, ...rest] = words;
  const subject = rest.length ? `${josa(first, "과/와")} ${[...rest.slice(0, -1), josa(rest.at(-1), "이/가")].join(", ")}` : josa(first, "이/가");
  return `${subject} 새 판에 맞지 않습니다.`;
}

/** 지난 대화 쌓기 or 기억 다시 정리 going, as the update reads them (/api/app/flow): why 업데이트 waits, or null. */
export function longJob(flow) {
  if (flow?.past?.running) return LONG_JOBS.past;
  const job = flow?.rederive?.job;
  if (job && !job.error) return flow.rederive.running ? LONG_JOBS.rederive : LONG_JOBS.stopped;
  return null;
}

/** What the window and the bell call an update (by its version) or a 고치기. */
function titleOf(progress) {
  if (progress?.kind === "fix") return "새 판에 맞추기";
  return progress?.to ? `새 판 ${progress.to}` : "업데이트";
}

/** An update or a 고치기 going or stopped, as one row: what it is and how it stands. */
function goingLine(progress) {
  const stopped = (progress.rows || []).find((row) => row.state === "bad");
  const text = progress.state === "running" ? (progress.kind === "fix" ? "고치는 중입니다." : "업데이트하는 중입니다.")
    : progress.state === "login" ? "구독 계정 로그인이 필요합니다."
      : stopped ? `${stopped.title}에서 멈췄습니다.` : "멈췄습니다.";
  return { kind: "going", title: titleOf(progress), text, progress };
}

/**
 * The bell's rows from what was read: an update going or stopped, else one that
 * ended since this browser last showed its end (`seen`, a day at most, as reopens)
 * and a new version with what 업데이트 brings up and, when it rebuilds a running
 * server, that teammates' reading stops (the status's warning); a 고치기 going or
 * stopped, else, with nothing else on the bell, what doctor finds behind this
 * version, with REBUILD_NOTE when the server is among it; and the team hub an update
 * left to go up. A row's 업데이트 waits (`blocked`) while a long job goes, for what
 * doctor finds only when 기억 서버 is among it, the one 고치기 recordFix refuses
 * then; on a page another computer shows (`elsewhere`), it is that computer's
 * (`hereOnly`).
 */
export function bellLines(last, { elsewhere = false, now = Date.now(), seen = "" } = {}) {
  const { status = null, fix = null, doctor = null, flow = null, said = null } = last || {};
  const update = last?.update ?? status?.progress ?? null;
  // The status says so itself on a page another computer shows (scripts/ui.mjs).
  const here = elsewhere ? (status?.blocked?.code === "here-only" && status.blocked.reason) || UPDATE_HERE_ONLY : "";
  const lines = [];
  if (standing(update, now)) lines.push(goingLine(update));
  else {
    if (update?.state === "done" && unseen(update, seen, now)) lines.push({ kind: "ended", title: titleOf(update), text: "업데이트를 마쳤습니다.", progress: update });
    if (status?.newer && status.latest) {
      lines.push({
        kind: "new",
        title: `새 판 ${status.latest}`,
        text: [status.summary, status.warning].filter(Boolean).join(" "),
        blocked: !here && status.blocked ? status.blocked.reason : "",
        hereOnly: here,
        said,
        status,
      });
    }
  }
  if (standing(fix, now)) lines.push(goingLine(fix));
  else if (!lines.length) {
    const names = behindChecks(doctor);
    if (names.length) {
      const server = names.includes("server-version");
      lines.push({
        kind: "behind",
        title: behindLine(names),
        text: server ? REBUILD_NOTE : "",
        blocked: here || !server ? "" : longJob(flow) || "",
        hereOnly: here,
      });
    }
  }
  const hub = update?.state === "done" ? (update.todo || []).find((item) => item.id === "hub") : null;
  if (hub) lines.push({ kind: "hub", title: hub.title, text: hub.text, action: hub.action === "hub", said: last?.hub || null });
  return lines;
}

/** The bell's rows from what this page read last. */
export function updateLines(options = {}) {
  return bellLines(known, options);
}

/** The dashboard's line while a new version waits for 업데이트 on the bell, or null. */
export function dashboardLine(last, { elsewhere = false, now = Date.now() } = {}) {
  const status = last?.status;
  if (!status?.newer || !status.latest || standing(last.update ?? status.progress, now)) return null;
  return `새 판 ${josa(status.latest, "이/가")} 있습니다. ${elsewhere ? "그 컴퓨터의 " : ""}오른쪽 위 종에서 업데이트를 누르세요.`;
}

/** The dashboard's line as a notice, from what this page read last; null with none. */
export function updateNotice() {
  const line = dashboardLine(known, { elsewhere: shownElsewhere() });
  return line ? notice("", line) : null;
}

/**
 * update.json or fix.json as the window's rows, in the order they go, each in its
 * state (wait, run, ok, bad, login): a stopped one says the reason the update wrote
 * as it is, with docker's output (`detail`) to open, and a plugin that went up its
 * version. On a page another computer shows (`elsewhere`), a login row says where
 * its panel is.
 */
export function progressLines(progress, { elsewhere = false } = {}) {
  const rows = (progress?.rows || []).map((row) => ({
    state: row.state,
    title: row.title,
    sub: row.state === "bad" ? row.error || row.sub || "" : row.state === "login" && elsewhere ? LOGIN_THERE : row.sub || "",
    detail: row.state === "bad" ? row.detail || "" : "",
    version: row.state === "ok" ? row.version || "" : "",
  }));
  return [{ label: progress?.kind === "fix" ? "고치는 중" : "업데이트 중" }, ...rows];
}

/**
 * The buttons of a stopped update or 고치기: 다시 시도, and 서버 켜기 for a server it
 * left off, until it was started from the window (`started`). On a page another
 * computer shows, 다시 시도 is that computer's: running it again cuts the way there.
 */
export function windowActions(progress, { elsewhere = false, started = false } = {}) {
  if (progress?.state !== "failed" && progress?.state !== "login") return [];
  return [
    ...(progress.state === "failed" && progress.serverOff && !started ? [{ run: "start", label: "서버 켜기" }] : []),
    { run: "retry", label: "다시 시도", primary: true, ...(elsewhere ? { hereOnly: UPDATE_HERE_ONLY } : {}) },
  ];
}

/**
 * What is left once an update or a 고치기 went through (its `todo`), each with the
 * button its `action` names: 서버 켜기 for the server kept off, and 팀 주소 다시
 * 올리기 for a hub this version changed. The server's is 점검's when it checks the
 * server here (`verify`), its 기억 서버 row offering 서버 켜기 then, and goes once
 * the server was started from the window (`started`).
 */
export function endItems(progress, { started = false, verify = false } = {}) {
  return (progress?.todo || [])
    .filter((item) => !((started || verify) && item.action === "server-start"))
    .map((item) => ({ id: item.id, title: item.title, text: item.text, action: ACTIONS[item.action] || null }));
}

/** The end's heading: until 점검 answers, that it checks; then what is left, counted with what 점검 found. */
export function endHeading(items, rows) {
  if (!rows) return "점검하는 중입니다";
  const count = items.length + failures(rows);
  return count ? `할 일 ${count}개` : "다 됐습니다";
}

/**
 * What the window shows once a 고치기 it started is back: fix.json's run when one
 * started (`after` is not the run from `before`), else what the request said
 * (`outcome`, check.js fixOutcome), a refusal's reason as it came, in the words of
 * 업데이트 when it has them, since the bell's 업데이트 opens this window; with
 * neither, nothing was behind any more, and 점검 says how it stands.
 */
export function fixShown(outcome, before, after) {
  if (after && after.startedAt !== before) return { progress: after };
  if (outcome) return { said: outcome.update ? { text: outcome.update, bad: outcome.bad } : outcome };
  return { progress: { kind: "fix", state: "done", rows: [], todo: [] } };
}

/** The account a login the update stopped for logs in: one the gateway waits on, else one logged out; null with none. */
export function loginAccount(accounts) {
  const pending = pendingLogin(accounts);
  if (pending) return pending;
  const out = (Array.isArray(accounts) ? accounts : []).find((account) => account?.id && !account.login?.loggedIn);
  return out ? { accountId: out.id, backend: out.backend || "", prompt: null } : null;
}

/** Whether the window opens again as the app starts: an update going, or one ended unseen. */
export function reopens(progress, seen = "", now = Date.now()) {
  if (!progress) return false;
  if (progress.state === "running") return true;
  return ["login", "failed", "done"].includes(progress.state) && unseen(progress, seen, now);
}

/** An end this browser has not shown (`seen` is the last it showed), a day at most. */
const unseen = (progress, seen, now) => seen !== endKey(progress) && now - Date.parse(progress.updatedAt || "") < DAY_MS;

/** The window to open as the app starts: an update's (reopens), else a 고치기 going; null for none. */
export function bootWindow(update, fix, { seen = "", now = Date.now() } = {}) {
  if (reopens(update, seen, now)) return { kind: "update", progress: update };
  if (fix?.state === "running") return { kind: "fix", progress: fix };
  return null;
}

/** One end of one run: a 다시 시도 that stops again is another. */
export const endKey = (progress) => `${progress?.kind} ${progress?.startedAt} ${progress?.state} ${progress?.updatedAt}`;

function seenEnd() {
  try { return localStorage.getItem(SEEN_KEY) || ""; } catch { return ""; }
}

function markSeen(progress) {
  if (progress?.kind !== "update" || !progress.startedAt) return;
  try { localStorage.setItem(SEEN_KEY, endKey(progress)); } catch {}
}

// ── What a button does ───────────────────────────────────

/**
 * 업데이트 on the bell: the update starts with what the bell showed (`seen`: main's
 * version and whether it warned that teammates' reading stops), and this answers its
 * progress. A refusal is kept for the row to show, with the status that came with it
 * (`changed`: the version or the warning moved since), until a status read later
 * shows another version or warning; this answers null.
 */
export async function pressUpdate(status, { now = Date.now() } = {}) {
  known.said = null;
  const answer = await post("/api/update/start", { seen: { latest: status.latest, warning: Boolean(status.warning) } })
    .catch((error) => ({ ok: false, error: error.message }));
  if (answer?.ok && answer.progress) {
    known.update = answer.progress;
    keepStatus({ ...status, progress: answer.progress }, now);
    return answer.progress;
  }
  if (answer?.status) keepStatus(answer.status, now);
  known.said = { text: answer?.error || "업데이트를 시작하지 못했습니다.", detail: answer?.detail || "" };
  known.saidOf = shownOf(answer?.status || status);
  return null;
}

/** 다시 시도 of a stopped update, from the row that stopped: `{ progress }` running again, or `{ error }` with why not. */
export async function retryUpdate() {
  const answer = await post("/api/update/retry", {}).catch((error) => ({ ok: false, error: error.message }));
  return answer?.ok && answer.progress ? { progress: answer.progress } : { error: answer?.error || "다시 시도하지 못했습니다." };
}

/** 팀 주소 다시 올리기: the team hub again with the Cloudflare token kept here, `{ text, bad }`. */
export async function redeployHub() {
  const answer = await post("/api/team/redeploy", {}).catch((error) => ({ ok: false, error: error.message }));
  if (answer?.ok) return { text: "팀 주소를 다시 올렸습니다.", bad: false };
  return { text: answer?.code === "no_token" ? NO_TOKEN : problem(answer, "팀 주소를 다시 올리지 못했습니다."), bad: true };
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const appWent = (progress) => (progress?.rows || []).some((row) => row.id === "app" && row.state === "ok");

/**
 * Follows update.json (`kind` "update") or fix.json while it runs, every `every` ms:
 * `draw(progress, { stalled })` hears each read, and the last progress again while a
 * read fails. Reads fail for a moment while the app starts again on its new version:
 * they are waited through, and `stalled` says once they failed STALL_MS on end. Once
 * a read failed, or the app's row went through, the app's version is asked; when it
 * is no longer the page's (`version`), the page has to load that version's screens,
 * and this ends with `reload`. Answers `{ progress, reload, closed }` once the
 * progress no longer runs, or `gone()` says the window closed.
 */
export async function follow(kind, draw, { every = POLL_MS, now = Date.now, version = pageVersion, gone = () => false } = {}) {
  let last = null;
  let failing = 0;
  let ask = false;
  for (;;) {
    if (gone()) return { progress: last, closed: true };
    const answer = await get(PROGRESS[kind]).catch(() => null);
    if (gone()) return { progress: last, closed: true };
    if (!answer) {
      if (!failing) failing = now();
      ask = true;
      draw(last, { stalled: now() - failing >= STALL_MS });
    } else {
      failing = 0;
      const progress = answer.progress || null;
      if (appWent(progress) && !appWent(last)) ask = true;
      if (ask && version) {
        const context = await get("/api/app/context").catch(() => null);
        if (context) ask = false;
        if (context?.version && context.version !== version) return { progress, reload: true };
      }
      last = progress;
      draw(progress, { stalled: false });
      if (progress?.state !== "running") return { progress };
    }
    await pause(every);
  }
}

/** A window closed after the app went to a new version loads that version's screens. */
async function reloadIfNew() {
  const context = await get("/api/app/context").catch(() => null);
  if (context?.version && pageVersion && context.version !== pageVersion) location.reload();
}

// ── The bell ─────────────────────────────────────────────

/** One bell row: its title, what it says, then its button under the text, or why there is none. */
function bellRow(line) {
  const acts = (...nodes) => h("div", { class: "bell-acts" }, nodes);
  const sub = [line.text ? h("div", {}, line.text) : null];
  if (line.kind === "going") {
    sub.push(acts(button("열기", { kind: "small", onClick: () => openUpdate({ kind: line.progress.kind, progress: line.progress }) })));
  } else if (line.kind === "ended") {
    sub.push(acts(button("열기", { kind: "small", onClick: (event) => busy(event.currentTarget, () => openEnded(line.progress)) })));
  } else if (line.kind === "hub") {
    if (line.action) sub.push(acts(button("팀 주소 다시 올리기", { kind: "small", onClick: (event) => busy(event.currentTarget, pressHub) })));
    if (line.said) sub.push(h("div", { class: "bell-said bad" }, line.said.text));
  } else if (line.hereOnly) {
    sub.push(acts(hereOnlyButton("업데이트", line.hereOnly)), hereOnlyNote(line.hereOnly));
  } else if (line.blocked) {
    sub.push(h("div", { class: "bell-said warn" }, line.blocked));
  } else {
    sub.push(acts(button("업데이트", { kind: "primary small", onClick: (event) => busy(event.currentTarget, () => press(line)) })));
    if (line.said) sub.push(h("div", { class: "bell-said bad" }, line.said.text), line.said.detail ? details("자세히", line.said.detail) : null);
  }
  return listItem({ title: line.title, sub });
}

/** 업데이트 on a row: a new version starts here and opens its window; what doctor finds behind is fixed in the window. */
async function press(line) {
  if (line.kind === "behind") {
    openUpdate({ kind: "fix", fix: true });
    return;
  }
  const progress = await pressUpdate(line.status);
  if (progress) openUpdate({ kind: "update", progress });
  refreshBell();
}

async function pressHub() {
  const said = await redeployHub();
  known.hub = said.bad ? said : null;
  if (!said.bad) toast(said.text, "ok");
  refreshBell();
}

/**
 * 열기 on an update that ended unseen: its end, while the app runs this page's
 * version (`version`); on another, the page loads that version's screens first
 * (`reload`), which open the end as the app starts. The page is loaded again only
 * here, as it is pressed: what was being typed on it would go.
 */
export async function openEnded(progress, { version = pageVersion, reload = () => location.reload(), open = openUpdate } = {}) {
  const context = await get("/api/app/context").catch(() => null);
  if (context?.version && version && context.version !== version) reload();
  else open({ kind: "update", progress });
}

let watching = false;
/** Puts the update on the bell, once, as the app starts; this page's version is the app's then. */
export function watchUpdates() {
  if (watching) return;
  watching = true;
  pageVersion = app.context?.version || "";
  bellSource(async () => {
    await refreshUpdate({ open: document.querySelector(".bell-pop")?.hidden === false });
    return updateLines({ elsewhere: shownElsewhere(), seen: seenEnd() }).map(bellRow);
  });
}

/**
 * As the app starts: the window of an update going, or ended since this browser last
 * showed one, or of a 고치기 going; true when one opened. `onClose` hears it close,
 * for what waits for it (a setup kept half way).
 */
export async function reopenUpdate({ onClose = null } = {}) {
  const [update, fix] = await Promise.all([progressOf("update").catch(() => null), progressOf("fix").catch(() => null)]);
  const shown = bootWindow(update, fix, { seen: seenEnd() });
  if (!shown) return false;
  return openUpdate({ ...shown, onClose });
}

// ── The window ───────────────────────────────────────────

/** The rows as progressList draws them: docker's output folded under the reason, a plugin's version at the end. */
const drawnLines = (lines) => lines.map((line) => (line.label !== undefined ? line : {
  state: line.state,
  title: line.title,
  sub: line.detail ? [line.sub, details("오류 내용", line.detail)] : line.sub,
  end: line.version ? h("span", { class: "mono muted" }, line.version) : null,
}));

let windowOpen = false;

/**
 * The window of an update (`kind` "update") or a 고치기 ("fix"): `progress` as last
 * read, followed while it runs; with `fix`, a 고치기 starts in it (runFix). While it
 * goes, its rows; stopped, the row that stopped with its reason and 다시 시도, or the
 * account login it waits for; at the end, what it did, 점검 and what is left to do.
 * What a button did is said on a line in the window. On a page another computer
 * shows, 다시 시도 and the login before it are that computer's. `onClose` hears it
 * close. One window at a time: answers whether this one opened.
 */
export function openUpdate({ kind = "update", progress = null, fix = false, onClose = null } = {}) {
  if (windowOpen) return false;
  windowOpen = true;
  const elsewhere = shownElsewhere();
  let current = progress;
  // A 고치기 started here: runFix's lines while it goes, and what its request said when fix.json has none of it.
  let fixing = null;
  let fixSaid = null;
  let stalled = false;
  let closed = false;
  let started = false;
  // The follow going now: one started later ends the one before.
  let following = 0;
  // What the last button said: a refusal, why the server did not start, the hub.
  let note = null;
  let login = null;
  let end = null;
  const win = modal({
    title: "업데이트",
    onClose: () => {
      closed = true;
      windowOpen = false;
      login?.panel?.cancel();
      forgetDoctor();
      refreshBell();
      onClose?.();
      reloadIfNew();
    },
  });
  const kindOf = () => current?.kind || kind;
  const noteLine = () => (note ? (note.bad ? notice("bad", note.text) : h("div", { class: "hint", style: { marginTop: "8px" } }, note.text)) : null);

  const actionButton = (action) => {
    if (action.hereOnly) return hereOnlyButton(action.label, action.hereOnly);
    return button(action.label, { kind: action.primary ? "primary" : action.small ? "small" : "", onClick: (event) => busy(event.currentTarget, () => act(action)) });
  };

  async function act(action) {
    note = null;
    try {
      if (action.run === "retry") await again();
      else if (action.run === "start") {
        await startServer();
        started = true;
        note = { text: "기억 서버를 켰습니다." };
        end?.check.again();
      } else if (action.run === "hub") {
        note = await redeployHub();
        // The hub's to-do goes once the hub runs this version.
        if (!note.bad) current = (await progressOf(kindOf()).catch(() => null)) || current;
        refreshBell();
      }
    } catch (error) {
      note = { text: error.message, bad: true };
    }
    draw();
  }

  /** 다시 시도: an update from the row that stopped, a 고치기 anew. */
  async function again() {
    if (kindOf() === "fix") {
      login?.panel?.cancel();
      fixHere();
      return;
    }
    const answer = await retryUpdate();
    if (answer.error) {
      note = { text: answer.error, bad: true };
      // Refused because it runs already: that run is followed.
      const now = await progressOf("update").catch(() => null);
      if (now?.state === "running") {
        current = now;
        watch();
      }
      return;
    }
    // A login still waiting in the panel is not the one this run asks for.
    login?.panel?.cancel();
    current = answer.progress;
    watch();
  }

  async function watch() {
    const mine = ++following;
    stalled = false;
    draw();
    const outcome = await follow(kindOf(), (now, { stalled: late }) => {
      if (now) current = now;
      stalled = late;
      draw();
    }, { gone: () => closed || mine !== following });
    if (outcome.reload) {
      location.reload();
      return;
    }
    if (outcome.closed) return;
    stalled = false;
    draw();
    refreshBell();
  }

  /** 고치기 in this window: runFix's lines while it goes, then fix.json's end, or what its request said. */
  async function fixHere() {
    note = null;
    fixSaid = null;
    const before = (await progressOf("fix").catch(() => null))?.startedAt || null;
    fixing = fixLines(null);
    draw();
    const outcome = await runFix((lines) => {
      fixing = lines;
      draw();
    });
    const after = await progressOf("fix").catch(() => null);
    fixing = null;
    if (closed) return;
    const shown = fixShown(outcome, before, after);
    if (shown.said) fixSaid = shown.said;
    else current = shown.progress;
    if (current?.state === "running") watch();
    else draw();
    refreshBell();
  }

  /** The login a stopped update or 고치기 waits for: the panel of the account logged out, once per stop. */
  async function askLogin() {
    const key = endKey(current);
    if (login?.key === key) return;
    const mine = { key, node: null, panel: null };
    login = mine;
    const accounts = (await gateway.status().catch(() => null))?.accounts;
    if (closed || login !== mine) return;
    const target = loginAccount(accounts);
    if (!target) {
      mine.node = h("div", { class: "hint" }, NO_ACCOUNT);
      draw();
      return;
    }
    const panel = gatewayLogin({ backend: target.backend, accountId: target.accountId, prompt: target.prompt });
    mine.panel = panel;
    mine.node = panel.root;
    draw();
    const ok = await panel.done;
    if (closed || login !== mine) return;
    mine.panel = null;
    mine.node = null;
    if (!ok) {
      note = { text: `${panel.reason() || "로그인하지 못했습니다."} 다시 시도를 누르면 새로 로그인합니다.`, bad: true };
      draw();
      return;
    }
    await again();
    draw();
  }

  /** The end: what it did, 점검 of this computer, and what is left to do with its buttons. Built once per end. */
  function drawEnd() {
    const key = endKey(current);
    if (end?.key === key) {
      end.paint();
      return;
    }
    markSeen(current);
    const heading = h("h3", {}, endHeading([], null));
    const left = h("div", {});
    const verify = Boolean(app.context?.localServer);
    let rows = null;
    const todoItem = (item) => ({ title: item.title, text: [item.text, item.action ? h("div", { class: "todo-acts" }, actionButton({ ...item.action, small: true })) : null] });
    const paint = () => {
      const items = endItems(current, { started, verify });
      heading.textContent = endHeading(items, rows);
      const agentsOnly = items.every((item) => item.id === "claude" || item.id === "codex");
      clear(left,
        items.length ? [h("div", { class: "label" }, `${elsewhere ? "그 컴퓨터의 " : ""}${agentsOnly ? "에이전트에서 할 일" : "남은 할 일"}`), todoList(items.map(todoItem))] : null,
        noteLine());
    };
    const check = checkBox({
      check: () => checkHere({ verify }),
      sub: checkingText({ verify }),
      onCollect: () => { win.close(); go("computer/collect"); },
      onChecked: (found) => {
        rows = found;
        paint();
      },
    });
    end = { key, paint, check };
    win.body(heading, current.said ? h("p", { class: "lead" }, current.said) : null, check.root, left);
    win.foot(null, button("닫기", { kind: "primary", onClick: () => win.close() }));
    paint();
  }

  function draw() {
    if (closed) return;
    if (fixSaid) {
      win.body(h("h3", {}, titleOf({ kind: "fix" })), notice(fixSaid.bad ? "bad" : "", fixSaid.text), noteLine());
      win.foot(null, actionButton({ run: "retry", label: "다시 시도", primary: true }));
      return;
    }
    if (!fixing && current?.state === "done") {
      drawEnd();
      return;
    }
    end = null;
    const state = fixing ? "running" : current?.state;
    if (state === "login" || state === "failed") markSeen(current);
    if (state === "login" && !elsewhere) askLogin();
    const stray = state === "failed" && current.error && !(current.rows || []).some((row) => row.state === "bad");
    win.body(
      h("h3", {}, titleOf(current || { kind })),
      progressList(fixing || drawnLines(progressLines(current, { elsewhere }))),
      stray ? notice("bad", current.error) : null,
      stalled && !elsewhere ? notice("warn", STALLED) : null,
      state === "login" && !elsewhere ? login?.node || null : null,
      elsewhere && state !== "running" ? hereOnlyNote(UPDATE_HERE_ONLY) : null,
      noteLine());
    win.foot(null, fixing ? null : windowActions(current, { elsewhere, started }).map(actionButton));
  }

  win.open();
  if (fix) fixHere();
  else if (current?.state === "running") watch();
  else draw();
  return true;
}
