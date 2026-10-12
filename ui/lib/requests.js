// Requests between team members, as the bell and the 팀 page show them.
//
// A member asks another for chat (to ask their memory) or, for the company server,
// to collect into it. The hub keeps each request and its answer; the owner's app
// opens its server first (the gate's access.json, team-app.mjs) and only then
// answers, so "approved" always means it works. What waits for this person goes to
// the bell: a request to answer, an approved chat to connect, a refusal to read.
// An approved collect request needs nothing from anyone: this app registers with
// the company server, turns its column on and sends the chosen folders' past
// conversations, as soon as it sees the answer.
import { post } from "./api.js";
import { bellSource, refreshBell } from "./bell.js";
import { h, clear } from "./dom.js";
import { folderRowsOf, grantFromTicked, grantedPaths } from "./folder-grants.js";
import { folderTree, folderTreeTable, openAtFirst } from "./folder-tree.js";
import { number } from "./format.js";
import { listItem, modal } from "./kit.js";
import { ago, clientOutcome, connectTeammate, mateName, registerWith, teamCall, teamDirectory, teamRequests, teamStatus } from "./team.js";
import { app, loadContext, refreshStatus } from "./state.js";
import { button, busy, notice, spinner, tag, toast } from "./ui.js";

let latest = null;
let loading = null;
let refused = null;
const starting = new Set();
const CODEX_POLL_MS = 2_000;
const CODEX_WAIT_MS = 10 * 60_000;
// What the gate keeps open to one teammate (gate-access.mjs MAX_FOLDERS) and what
// fits the header it hands the MCP bridge (gate.mjs MAX_FOLDERS_HEADER, base64url).
const MAX_GRANT_FOLDERS = 100;
const MAX_GRANT_BYTES = 8_000;

/**
 * The hub's requests with this server's own grants and computers, asked at most once
 * at a time. A login the hub or a host refuses (`login_needed`) gives none, and the
 * bell offers 다시 로그인 (requestsLoginRefused); any other failure keeps the last answer.
 */
export function loadRequests({ fresh = false } = {}) {
  if (!app.context?.team?.hub || !app.context?.team?.signedIn) { refused = null; return Promise.resolve(null); }
  if (!loading || fresh) {
    loading = teamRequests().then((value) => { latest = value; refused = null; return value; }).catch((error) => {
      if (error?.code !== "login_needed") return latest;
      refused = error;
      return null;
    }).finally(() => {
      setTimeout(() => { loading = null; }, 5_000);
    });
  }
  return loading;
}

/** The login_needed error the latest ask for requests ended with, or null. */
export async function requestsLoginRefused() {
  await loadRequests();
  return refused;
}

export function requestsSeen() {
  return latest;
}

function personName(request, field = "from") {
  return field === "from" ? request.fromPeer || request.from?.split("@")[0] || "" : request.ownerPeer || request.owner?.split("@")[0] || "";
}

/**
 * The folders window: which folders a teammate's chat answers from. Used to approve a
 * request (T2) and to change what is open later (T4). Resolves the entries to open
 * ([{ path, subfolders }], folder-grants.js), or null when closed.
 */
export function chooseFolders({ title, lead, chosen = [], confirm = "승인", extra = null }) {
  return new Promise((resolve) => {
    let entries = null;
    const win = modal({ title, big: true, small: true, onClose: (value) => resolve(value === "ok" ? entries : null) });
    const box = h("div", {}, spinner());
    const summary = h("p", { class: "hint" });
    const problem = h("div", {});
    let rows = null;
    let tree = [];
    const checked = new Set();
    const tooMany = (list) => list.length > MAX_GRANT_FOLDERS || new TextEncoder().encode(JSON.stringify(list)).length > MAX_GRANT_BYTES;
    const drawSummary = () => {
      clear(problem);
      const ticked = (rows || []).filter((row) => checked.has(row.path));
      const conversations = ticked.reduce((sum, row) => sum + row.count, 0);
      clear(summary, ticked.length ? `폴더 ${number(ticked.length)}개 · 대화 ${number(conversations)}개를 엽니다.` : "");
    };
    win.body(
      h("p", { class: "lead", style: { marginTop: "4px" } }, lead),
      h("p", { class: "hint" }, "폴더를 고르면 그 안의 폴더도 같이 열립니다. 나중에 그 안에 생기는 폴더도 열립니다."),
      box, summary, problem);
    win.foot(extra, [
      button("취소", { kind: "quiet", onClick: () => win.close() }),
      button(confirm, { kind: "primary", onClick: () => {
        if (!rows) return;
        const picked = grantFromTicked(tree, checked);
        if (!picked.length) { clear(problem, notice("warn", "폴더를 하나 이상 고르세요.")); return; }
        if (tooMany(picked)) { clear(problem, notice("warn", "고른 폴더가 너무 많습니다. 위쪽 폴더를 통째로 고르면 줄어듭니다.")); return; }
        entries = picked;
        win.close("ok");
      } }),
    ]);
    win.open();
    teamCall("/api/team/folders", {}).then((result) => {
      const list = folderRowsOf(result.folders || [], chosen);
      rows = list;
      tree = folderTree(rows);
      for (const path of grantedPaths(rows, chosen)) checked.add(path);
      clear(box, rows.length
        ? folderTreeTable(rows, checked, { open: openAtFirst(rows), onChange: drawSummary })
        : notice("warn", "이 서버에 쌓인 대화가 아직 없습니다. 대화가 쌓이면 그 폴더가 여기에 나옵니다."));
      drawSummary();
    }, (error) => clear(box, notice("bad", h("b", {}, error.message), h("div", {}, "서버 화면에서 기억 서버가 켜져 있는지 확인하고, 이 창을 닫았다가 다시 여세요."))));
  });
}

/** 승인 on a chat request: the folders first, then the server opens and the hub hears. */
export async function approveChat(request) {
  const who = personName(request);
  const folders = await chooseFolders({
    title: `${who}에게 내 기억 열기`,
    lead: `${who}가 chat으로 물을 때 답에 쓸 폴더를 고르세요.`,
  });
  if (!folders) return false;
  await teamCall("/api/team/decide", { id: request.id, approve: true, kind: "chat", email: request.from, peer: request.fromPeer, folders });
  toast(`${who}에게 폴더를 열었습니다.`, "ok");
  return true;
}

export async function approveCollect(request) {
  await teamCall("/api/team/decide", { id: request.id, approve: true, kind: "collect", email: request.from, peer: request.fromPeer });
  toast(`${personName(request)}의 ${request.device || "컴퓨터"}가 이 서버에 쌓습니다.`, "ok");
  return true;
}

export async function decline(request) {
  await teamCall("/api/team/decide", { id: request.id, approve: false });
  return true;
}

/**
 * After a teammate's memory went in: each agent logs in to it once, and how. Codex
 * prints its login address without opening a browser (team-access.mjs), so it opens
 * here, in the browser the team login used, not in the system's default one, which
 * may be signed in to another Google account. Codex's row shows whether Codex holds
 * a login and follows the one started here to its end.
 */
export function openConnected(mate) {
  const entry = mate.entry || `team-${mate.name}`;
  const email = app.context?.team?.email || "";
  const account = email ? `팀에 들어갈 때 쓴 Google 계정(${email})` : "팀 Google 계정";
  const win = modal({ title: `${mate.name}의 기억 연결`, big: true, small: true });
  const codexState = tag("로그인 필요", "warn");
  const codexNote = h("div", { class: "s" }, `Codex 로그인을 누르면 이 브라우저에 로그인 탭이 열립니다. ${account}으로 로그인하세요.`);
  const loginLink = (url) => (url ? h("a", { href: url, target: "_blank", rel: "noreferrer" }, "로그인 주소") : "로그인 주소");
  const showCodex = (state, error) => {
    const [text, kind] = { done: ["로그인됨", "ok"], waiting: ["로그인 중", ""] }[state] || ["로그인 필요", "warn"];
    clear(codexState, text);
    codexState.className = `tag ${kind}`;
    if (state === "done") clear(codexNote, "Codex가 이 기억에 로그인했습니다.");
    if (state === "failed") clear(codexNote, `Codex 로그인이 끝나지 않았습니다${error ? ` (${error})` : ""}. Codex 로그인을 다시 누르세요.`);
  };
  // The login started last, followed until it ends or the dialog closes (the app ends
  // the one before it). Each start counts up, so an older look or loop stops.
  let following = 0;
  const follow = async () => {
    const mine = ++following;
    const deadline = Date.now() + CODEX_WAIT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, CODEX_POLL_MS));
      if (mine !== following || !win.dialog.isConnected) return;
      const now = await post("/api/teammates/codex-login-status", { name: mate.name }).catch(() => null);
      if (mine !== following || !win.dialog.isConnected) return;
      if (now?.ok && now.state !== "waiting") return showCodex(now.state, now.error);
    }
    showCodex("failed", "10분이 지났습니다");
  };
  const codexLogin = button("Codex 로그인", { kind: "small", onClick: (event) => busy(event.currentTarget, async () => {
    // A tab opened in the click itself, for the address to go to (a later one is blocked).
    const tab = window.open("", "_blank");
    try { tab?.document.write(`<!doctype html><meta charset="utf-8"><title>팀 메모리</title><p style="font:15px system-ui,sans-serif;color:#57534b;margin:40px">Codex 로그인으로 넘어가는 중입니다…</p>`); } catch {}
    following += 1;
    const login = await post("/api/teammates/codex-login", { name: mate.name }).catch((error) => ({ ok: false, error: error.message }));
    if (!login.ok || login.state === "done" || !login.noBrowser || !login.loginUrl) tab?.close();
    if (!login.ok) {
      showCodex("needed");
      throw new Error(login.error || "Codex 로그인을 시작하지 못했습니다.");
    }
    if (login.state === "done") return showCodex("done");
    showCodex("waiting");
    follow();
    if (login.noBrowser && login.loginUrl) {
      if (tab && !tab.closed) tab.location.href = login.loginUrl;
      else window.open(login.loginUrl, "_blank", "noopener");
      clear(codexNote, `새 탭에서 ${account}으로 로그인하세요. Google이 계정을 물으면 이 계정을 고릅니다. 탭이 열리지 않았으면 `,
        loginLink(login.loginUrl), "를 여세요. 로그인을 마치면 여기 표시가 바뀝니다.");
      return;
    }
    // A Codex without --no-browser opened the system's default browser itself.
    clear(codexNote, `브라우저에서 ${account}으로 로그인을 마치세요. 창이 열리지 않았으면 `,
      loginLink(login.loginUrl), "를 여세요. 로그인을 마치면 여기 표시가 바뀝니다.");
  }) });
  win.body(
    h("p", { class: "lead", style: { marginTop: "4px" } },
      `${mate.name}의 기억을 이 컴퓨터의 Claude Code와 Codex에 도구로 넣었습니다. ${mate.name}의 서버는 팀 Google 계정으로만 열려서, 에이전트마다 한 번 로그인하면 끝납니다.`),
    h("div", { class: "opts" },
      h("div", { class: "agent" }, h("span", { class: "src claude" }, "C"),
        h("div", { class: "ab" }, h("div", { class: "t" }, "Claude Code ", tag("로그인 필요", "warn")),
          h("div", { class: "s" }, "열린 세션에서 ", h("span", { class: "mono" }, "/mcp"), " 를 열고 ", h("span", { class: "mono" }, entry), ` 을 골라 Authenticate를 누르고, 브라우저가 열리면 ${account}으로 로그인하세요.`))),
      h("div", { class: "agent" }, h("span", { class: "src codex" }, "X"),
        h("div", { class: "ab" }, h("div", { class: "t" }, "Codex ", codexState), codexNote),
        codexLogin)));
  win.foot(null, button("닫기", { onClick: () => win.close() }));
  win.open();
  // A login Codex kept from before shows as one, and a login still running is followed.
  const asked = following;
  post("/api/teammates/codex-login-status", { name: mate.name }).then((now) => {
    if (asked !== following || !win.dialog.isConnected || !now?.ok) return;
    showCodex(now.state, now.error);
    if (now.state === "waiting") follow();
  }, () => {});
}

/** 연결 on an approved chat request: the teammate's memory into Claude Code and Codex. */
export async function connectApproved(request) {
  const name = mateName({ peer: request.ownerPeer, email: request.owner });
  const result = await connectTeammate({ name, host: request.server });
  if (!result.ok) throw new Error(result.error || clientOutcome(result).join(" · ") || "연결하지 못했습니다.");
  // The request stays, with its folders, for the 팀 page; the bell stops showing it
  // because Claude Code or Codex now has that server.
  await loadContext();
  refreshStatus();
  openConnected({ name, entry: result.entry });
  return true;
}

/**
 * An approved collect request: this computer registers with the company server and
 * the server's column goes on, with the chosen folders' past conversations. Quietly
 * when the team's servers login is there; otherwise the bell asks for one press.
 */
export async function startCollect(request, { tab = null } = {}) {
  const target = (app.context?.targets || []).find((item) => item.team && String(item.url || "").replace(/^https:\/\//, "") === request.server);
  await registerWith(request.server, { tab });
  if (target && !target.enabled) {
    const set = await post("/api/targets/set", { id: target.id, enabled: true });
    if (set.ok === false) throw new Error(set.error || "회사 서버 쌓기를 켜지 못했습니다.");
    post("/api/targets/backfill", { id: target.id }).catch(() => {});
  }
  await teamCall("/api/team/dismiss", { id: request.id }).catch(() => null);
  await loadContext();
  toast("회사 서버에도 쌓기 시작했습니다.", "ok");
  return true;
}

async function tryStart(request) {
  if (starting.has(request.id)) return;
  starting.add(request.id);
  const status = await teamStatus().catch(() => null);
  if (!status?.serversLogin?.signedIn) return;
  try { await startCollect(request); refreshBell(); }
  catch { starting.delete(request.id); }
}

/** The bell's rows: everything a person has to press. */
async function bellRows() {
  const requests = await loadRequests({ fresh: true });
  if (!requests) return [];
  // Names as the team shows them: each member's peer, which also names team-<peer>.
  const directory = await teamDirectory().catch(() => null);
  const peers = new Map((directory?.people || []).map((person) => [person.email, person.peer]));
  for (const request of [...(requests.incoming || []), ...(requests.outgoing || [])]) {
    request.ownerPeer = request.ownerPeer || peers.get(request.owner) || null;
    request.fromPeer = request.fromPeer || peers.get(request.from) || null;
  }
  const rows = [];
  const act = (label, kind, run) => button(label, { kind, onClick: (event) => busy(event.currentTarget, async () => {
    if (await run()) { await loadRequests({ fresh: true }); refreshBell(); }
  }) });
  // A server opens on the computer that runs it (its gate's access.json is there), so
  // only that computer answers; the owner's others see the request and where to go.
  const here = app.context?.team?.localHost || null;
  for (const request of requests.incoming || []) {
    const chat = request.kind === "chat";
    const what = chat ? "내 기억에 chat으로 물으려 합니다" : `${(request.folders || []).join(" · ") || "고른"} 폴더의 대화를 쌓으려 합니다`;
    rows.push(listItem({
      title: chat ? personName(request) : `${personName(request)}의 ${request.device || "컴퓨터"}`,
      sub: request.server === here ? `${what} · ${ago(request.createdAt)}` : `${what} · 서버를 둔 컴퓨터에서 승인합니다`,
      end: request.server === here
        ? [act("승인", "primary small", () => (chat ? approveChat(request) : approveCollect(request))), act("거절", "small danger", () => decline(request))]
        : null,
    }));
  }
  const connected = new Set(app.context?.teamMemory?.hosts || []);
  for (const request of requests.outgoing || []) {
    const owner = personName(request, "owner");
    if (request.status === "approved" && request.kind === "chat" && connected.has(request.server)) continue;
    if (request.status === "approved" && request.kind === "chat") {
      rows.push(listItem({
        title: owner,
        sub: `chat 요청을 승인했습니다 · 열린 폴더 ${(request.projects || []).length}개 · ${ago(request.decidedAt)}`,
        end: act("연결", "primary small", () => connectApproved(request)),
      }));
    } else if (request.status === "approved" && request.kind === "collect") {
      tryStart(request);
      rows.push(listItem({
        title: "회사 서버",
        sub: `대화 쌓기를 승인했습니다 · ${ago(request.decidedAt)}`,
        end: act("시작", "primary small", () => startCollect(request)),
      }));
    } else if (request.status === "declined" || request.status === "revoked") {
      rows.push(listItem({
        title: request.kind === "chat" ? owner : "회사 서버",
        sub: `${request.kind === "chat" ? "chat" : "대화 쌓기"} 요청을 ${request.status === "declined" ? "거절했습니다" : "닫았습니다"} · ${ago(request.decidedAt || request.revokedAt)}`,
        end: act("확인", "small", async () => { await teamCall("/api/team/dismiss", { id: request.id }); return true; }),
      }));
    }
  }
  return rows;
}

/** Puts the team's requests on the bell, once. */
let registered = false;
export function watchRequests() {
  if (registered) return;
  registered = true;
  bellSource(bellRows);
}
