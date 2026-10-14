// Requests between team members, as the bell and the 팀 page show them.
//
// A member asks another to open their memory (a request of kind "chat", its name
// from before agents searched it themselves) or, for the company server, to collect
// into it. The hub keeps each request and its answer; the owner's app opens its
// server first (the gate's access.json, team-app.mjs) and only then answers, so
// "approved" always means it works. What waits for this person goes to the bell: a
// request to answer, the team servers login an opened memory needs, a refusal to
// read. An opened memory needs nothing else: the plugin's team-memory MCP server
// reaches it with this computer's team login. An approved collect request needs
// nothing from anyone either: this app registers with the company server, turns its
// column on and sends the chosen folders' past conversations, as soon as it sees the
// answer.
import { post } from "./api.js";
import { bellSource, refreshBell } from "./bell.js";
import { h, clear } from "./dom.js";
import { appRowsOf, folderRowsOf, grantFromHubNames, grantFromTicked, grantedPaths } from "./folder-grants.js";
import { folderTree, folderTreeTable, openAtFirst } from "./folder-tree.js";
import { number } from "./format.js";
import { listItem, modal } from "./kit.js";
import { ago, loginTab, personName as nameOfPerson, registerWith, serversLogin, teamCall, teamDirectory, teamRequests, teamStatus } from "./team.js";
import { app, loadContext } from "./state.js";
import { DEFAULT_TOOLS, toolPicker, toolsText } from "./tool-grants.js";
import { button, busy, notice, spinner, toast } from "./ui.js";

let latest = null;
let loading = null;
let refused = null;
const starting = new Set();
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
  return field === "from" ? request.fromName || request.fromPeer || request.from?.split("@")[0] || "" : request.ownerName || request.ownerPeer || request.owner?.split("@")[0] || "";
}

/**
 * The folders window: what a teammate's agents may search and read, folders and,
 * under 폴더 없는 대화, ChatGPT 기록 and other apps' conversations, on its 열 폴더 tab,
 * and the owner's MCP tools they may call on its MCP 도구 tab (tool-grants.js), with
 * 모든 팀원에게 같은 도구 열기 under them. Used to approve a request (T2) and to
 * change what is open later (T4). `who` is the teammate. `chosenNames` ticks what an
 * approval opened as the hub named it, where this server has no grant to show
 * (grantFromHubNames); `chosenTools` what the tab starts with. Resolves
 * `{ folders: [{ path, subfolders }], sources: ["chatgpt"], tools: ["search"], allTools }`
 * (folder-grants.js), or null when closed.
 */
export function chooseFolders({ title, lead, who, chosen = [], chosenSources = [], chosenNames = [], chosenTools = DEFAULT_TOOLS, confirm = "승인", extra = null }) {
  return new Promise((resolve) => {
    let entries = null;
    const win = modal({ title, big: true, small: true, onClose: (value) => resolve(value === "ok" ? entries : null) });
    const allTools = h("input", { type: "checkbox" });
    const toolCount = h("span", { class: "n" });
    const picker = toolPicker(chosenTools, { onChange: () => drawSummary() });
    const box = h("div", {}, spinner());
    const summary = h("span", { class: "foot-hint" });
    const problem = h("div", {});
    let rows = null;
    let apps = [];
    let tree = [];
    const checked = new Set();
    const sources = new Set();
    const tooMany = (list) => list.length > MAX_GRANT_FOLDERS || new TextEncoder().encode(JSON.stringify(list)).length > MAX_GRANT_BYTES;
    const apply = button(confirm, { kind: "primary", onClick: () => {
      if (!rows) return;
      const picked = grantFromTicked(tree, checked);
      const opened = apps.filter((row) => sources.has(row.key)).map((row) => row.key);
      if (!picked.length && !opened.length) { show("folders"); clear(problem, notice("warn", "폴더나 ChatGPT 기록을 하나 이상 고르세요.")); return; }
      if (tooMany(picked)) { show("folders"); clear(problem, notice("warn", "고른 폴더가 너무 많습니다. 위쪽 폴더를 통째로 고르면 줄어듭니다.")); return; }
      entries = { folders: picked, sources: opened, tools: picker.tools(), allTools: allTools.checked };
      win.close("ok");
    } });
    const drawSummary = () => {
      clear(problem);
      const ticked = (rows || []).filter((row) => checked.has(row.path));
      const opened = apps.filter((row) => sources.has(row.key));
      const conversations = ticked.reduce((sum, row) => sum + row.count, 0) + opened.reduce((sum, row) => sum + row.count, 0);
      const what = [ticked.length ? `폴더 ${number(ticked.length)}개` : null, ...opened.map((row) => row.label)].filter(Boolean);
      const tools = picker.tools().length;
      clear(toolCount, number(tools));
      clear(summary, !what.length ? (rows ? "폴더나 ChatGPT 기록을 하나 이상 고르세요." : "")
        : !tools ? "MCP 도구를 하나 이상 켜세요."
          : `${what.join(" · ")} · 대화 ${number(conversations)}개 · ${toolsText(picker.tools())}를 엽니다`);
      apply.disabled = !rows || !what.length || !tools;
    };
    // 열 폴더 first: what is open is the first thing to choose; the tools start as they
    // were. Both tabs keep one height, so the window does not jump between them.
    const panes = {
      folders: h("div", { class: "tab-pane" }, box,
        h("p", { class: "hint" }, "폴더를 고르면 그 안의 폴더도 같이 열립니다. 나중에 그 안에 생기는 폴더도 열립니다. ChatGPT 기록은 나중에 더 가져오는 것도 열립니다."),
        problem),
      tools: h("div", { class: "tab-pane", hidden: true }, picker.node),
    };
    const tabs = {
      folders: h("button", { type: "button", role: "tab", "aria-selected": "true", onclick: () => show("folders") }, "열 폴더"),
      tools: h("button", { type: "button", role: "tab", "aria-selected": "false", onclick: () => show("tools") }, "MCP 도구 ", toolCount),
    };
    function show(name) {
      for (const key of Object.keys(panes)) {
        panes[key].hidden = key !== name;
        tabs[key].setAttribute("aria-selected", String(key === name));
      }
    }
    win.body(
      h("p", { class: "lead", style: { marginTop: "4px" } }, lead),
      h("div", { class: "tabs m-tabs", role: "tablist" }, tabs.folders, tabs.tools),
      panes.folders,
      panes.tools);
    // On a narrow screen the summary takes a line of its own, and the buttons stay together on the right.
    win.foot([extra, h("label", { class: "all-tools" }, allTools, "모든 팀원에게 같은 도구 열기")],
      [summary, h("span", { class: "foot-btns" }, button("취소", { kind: "quiet", onClick: () => win.close() }), apply)]);
    drawSummary();
    win.open();
    teamCall("/api/team/folders", {}).then((result) => {
      const named = grantFromHubNames(chosenNames, folderRowsOf(result.folders || [], chosen));
      chosen = [...chosen, ...named.folders];
      chosenSources = [...new Set([...chosenSources, ...named.sources])];
      rows = folderRowsOf(result.folders || [], chosen);
      apps = appRowsOf(result.apps || [], chosenSources);
      tree = folderTree(rows);
      for (const path of grantedPaths(rows, chosen)) checked.add(path);
      for (const row of apps) if (chosenSources.includes(row.key)) sources.add(row.key);
      clear(box, rows.length || apps.some((row) => !row.disabled)
        ? folderTreeTable(rows, checked, { open: openAtFirst(rows), onChange: drawSummary, loose: { rows: apps, checked: sources } })
        : notice("warn", "이 서버에 쌓인 대화가 아직 없습니다. 대화가 쌓이면 그 폴더가 여기에 나옵니다."));
      drawSummary();
    }, (error) => clear(box, notice("bad", h("b", {}, error.message), h("div", {}, "서버 화면에서 기억 서버가 켜져 있는지 확인하고, 이 창을 닫았다가 다시 여세요."))));
  });
}

/** 승인 on a request to open my memory: what to open first, then the server opens and the hub hears. */
export async function approveChat(request) {
  const who = personName(request);
  const chosen = await chooseFolders({
    title: `${who}에게 내 기억 열기`,
    lead: `고른 폴더의 대화를 ${who}의 에이전트가 찾아서 그대로 읽습니다. 열 폴더와 쓸 MCP 도구를 고르세요.`,
    who,
    chosenTools: latest?.teamTools || DEFAULT_TOOLS,
  });
  if (!chosen) return false;
  await teamCall("/api/team/decide", { id: request.id, approve: true, kind: "chat", email: request.from, peer: request.fromPeer, ...chosen });
  toast(`${who}에게 내 기억을 열었습니다.`, "ok");
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

/** The team servers login a memory opened to this person needs, from the bell or the 팀 page. */
export function serversLoginButton(host, { label = "팀 서버 로그인", onDone } = {}) {
  return button(label, { kind: "primary small", onClick: (event) => {
    const tab = loginTab("Google 로그인으로 넘어가는 중입니다…");
    busy(event.currentTarget, async () => {
      try {
        await serversLogin(host, { tab });
      } catch (error) {
        tab?.close();
        throw error;
      }
      refreshBell();
      await onDone?.();
    }, { done: "팀 서버에 로그인했습니다" });
  } });
}

/** The bell's rows: everything a person has to press. */
async function bellRows() {
  const requests = await loadRequests({ fresh: true });
  if (!requests) return [];
  // Names as the team shows them: each member's nickname, else their peer.
  const [directory, status] = await Promise.all([teamDirectory().catch(() => null), teamStatus().catch(() => null)]);
  const people = new Map((directory?.people || []).map((person) => [person.email, person]));
  for (const request of [...(requests.incoming || []), ...(requests.outgoing || [])]) {
    request.ownerPeer = request.ownerPeer || people.get(request.owner)?.peer || null;
    request.fromPeer = request.fromPeer || people.get(request.from)?.peer || null;
    if (people.has(request.owner)) request.ownerName = nameOfPerson(people.get(request.owner));
    if (people.has(request.from)) request.fromName = nameOfPerson(people.get(request.from));
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
    const what = chat ? "내 기억을 열어 달라고 합니다" : `${(request.folders || []).join(" · ") || "고른"} 폴더의 대화를 쌓으려 합니다`;
    rows.push(listItem({
      title: chat ? personName(request) : `${personName(request)}의 ${request.device || "컴퓨터"}`,
      sub: request.server === here ? `${what} · ${ago(request.createdAt)}` : `${what} · 서버를 둔 컴퓨터에서 승인합니다`,
      end: request.server === here
        ? [act("승인", "primary small", () => (chat ? approveChat(request) : approveCollect(request))), act("거절", "small danger", () => decline(request))]
        : null,
    }));
  }
  // An opened memory needs only the team servers login, one for every server: one
  // row while it is missing, naming who opened theirs; with it, nothing to press.
  const opened = (requests.outgoing || []).filter((request) => request.status === "approved" && request.kind === "chat");
  if (opened.length && !status?.serversLogin?.signedIn) {
    rows.push(listItem({
      title: opened.map((request) => personName(request, "owner")).join(" · "),
      sub: `기억을 열었습니다 · 읽으려면 팀 서버 로그인이 한 번 필요합니다 · ${ago(opened[0].decidedAt)}`,
      end: serversLoginButton(opened[0].server),
    }));
  }
  for (const request of requests.outgoing || []) {
    const owner = personName(request, "owner");
    if (request.status === "approved" && request.kind === "chat") continue;
    if (request.status === "approved" && request.kind === "collect") {
      tryStart(request);
      rows.push(listItem({
        title: "회사 서버",
        sub: `대화 쌓기를 승인했습니다 · ${ago(request.decidedAt)}`,
        end: act("시작", "primary small", () => startCollect(request)),
      }));
    } else if (request.status === "declined" || request.status === "revoked") {
      rows.push(listItem({
        title: request.kind === "chat" ? owner : "회사 서버",
        sub: `${request.kind === "chat" ? "기억 열람" : "대화 쌓기"} 요청을 ${request.status === "declined" ? "거절했습니다" : "닫았습니다"} · ${ago(request.decidedAt || request.revokedAt)}`,
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

/**
 * 모든 팀원 도구: the owner's MCP tools every teammate may call, those opened to now
 * and those approved later. Resolves the tools chosen, or null when closed.
 */
export function chooseTeamTools(chosenTools = DEFAULT_TOOLS) {
  return new Promise((resolve) => {
    let tools = null;
    const win = modal({ title: "모든 팀원 도구", big: true, small: true, onClose: (value) => resolve(value === "ok" ? tools : null) });
    const summary = h("span", { class: "foot-hint" });
    const picker = toolPicker(chosenTools, { onChange: () => drawSummary() });
    const apply = button("적용", { kind: "primary", onClick: () => { tools = picker.tools(); win.close("ok"); } });
    const drawSummary = () => {
      const count = picker.tools().length;
      clear(summary, count ? `팀원 모두에게 ${toolsText(picker.tools())}를 엽니다` : "MCP 도구를 하나 이상 켜세요.");
      apply.disabled = !count;
    };
    win.body(h("p", { class: "lead", style: { marginTop: "4px" } }, "적용하면 팀원 모두가 이 도구를 씁니다. 나중에 승인한 팀원도 이 목록으로 시작합니다."), picker.node);
    win.foot(null, [summary, h("span", { class: "foot-btns" }, button("취소", { kind: "quiet", onClick: () => win.close() }), apply)]);
    drawSummary();
    win.open();
  });
}
