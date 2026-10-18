// 처음 설정: one window over an empty page until this computer is set up, and again
// from the palette (처음 설정 다시 하기). The first choice decides the steps: 팀에
// 들어가기 starts from the team's address, a team link (#/start?team=<address>) from
// the Google login itself, 새 팀 만들기 from a Cloudflare API token, and 혼자 쓰기
// from nothing. In a team the Google login comes first: the hub then says who this
// is (the peer name comes from the email, so nobody types it), whether they already
// have a server, the company server they may also collect into, and the teammates
// whose memory they may ask. Every way ends with 적용; the window then shows each
// thing it does (적용 중), the last a check of what it set up (점검), and then the
// check's rows, a failed one with its buttons, and what is left to do (할 일). Where
// the conversations go, from which agents, from where the past ones come and which
// folders, are lib/collect.js's and lib/past.js's steps, the same ones 기억 설정 →
// 대화 수집 → 수정 opens. The past conversations go in before any new one, in the
// order they were started, and keep going in after the window closes. A window
// closed during 적용, or a computer restarted on the way, opens at 적용 again with
// the rows done kept done (lib/state.js keeps the choices, without a secret), and
// runs the rest on 이어서 하기 or starts anew on 처음부터, as it does for another
// team's link opened while it waits. A computer is in one team
// only: on one in another team, the login to a link's or a typed address's team
// first shows both teams, and 옮기고 로그인 leaves the one it is in before the
// login. On a computer set up already, a link's 취소 closes the window. One that
// collects, or one in a team that stores nothing, joins a team leaving the rest as
// it is: after the login only the 팀원 step, the team's rows (with the peer name the
// team gives, when its setup has another) and 점검.
import { gateway, get, post } from "../lib/api.js";
import { backendAccounts } from "../lib/accounts.js";
import { defaultRoles, roleRows, ROLES } from "../lib/chat-roles.js";
import { h, clear, copyText } from "../lib/dom.js";
import { number } from "../lib/format.js";
import { counter, field, kv, modal, opt, opts, progressList, stepper, todoList } from "../lib/kit.js";
import { checkBox, checkHere, checkingText, checkTeam, failures, missingPlugins, startServer } from "../lib/check.js";
import {
  AGENTS,
  agentTodo,
  agentsStep,
  applySetup,
  collectDraft,
  detectAgents,
  dockerSteps,
  draftServer,
  loadProjects,
  NEW_SERVER_SUB,
  problem,
  projectsStep,
  sameServer,
  serverStep,
  setupBody,
  teamServers,
} from "../lib/collect.js";
import { dayText, HELD, holdNewTurns, pastStep, pastToPut, periodText, planPast, releaseNewTurns, runLine, startPast } from "../lib/past.js";
import { gatewayLogin } from "../lib/login.js";
import {
  GOOGLE_ADD_ACCOUNT,
  joinCase,
  joinedTeam,
  leaveTeam,
  loginTab,
  personName,
  registerWith,
  sameAccountAgain,
  sendRequest,
  switchAccount,
  teamDirectory,
  teamHostOf,
  teamLogin,
  teamMe,
} from "../lib/team.js";
import { app, dropSetup, keepSetup, keptSetup, loadContext, refreshStatus, savePrefs } from "../lib/state.js";
import { button, notice, spinner, tag } from "../lib/ui.js";

const TITLE = "팀 메모리 시작하기";
const STARTS = [
  ["join", "팀에 들어가기", "관리자에게 받은 팀 주소로 Google에 로그인합니다.", "들어가기"],
  ["make", "새 팀 만들기", "팀 관리자가 처음 한 번 합니다.", "만들기"],
  ["solo", "혼자 쓰기", "로그인과 팀 없이 내 컴퓨터에서만 씁니다.", "시작"],
];
const LABELS = { team: "팀 주소", make: "팀 만들기", login: "로그인", server: "서버", subscription: "구독", model: "모델", agents: "에이전트", past: "지난 대화", projects: "프로젝트", mates: "팀원" };
const BACKENDS = [["codex", "ChatGPT"], ["claude", "Claude"]];
const TODO_BELL = { title: "알림", text: "팀원이 승인하면 오른쪽 위 종에 알림이 뜹니다. 그 알림에서 연결을 누르세요." };
// The Cloudflare API token 새 팀 만들기 needs, in the words of Cloudflare's token screen.
const TOKEN_PERMISSIONS = "Account의 Cloudflare Tunnel: Edit, Access: Apps and Policies: Edit, Access: Organizations, Identity Providers, and Groups: Read, Workers: Admin과, 쓸 zone의 DNS: Edit, Zone: Read, Workers Routes: Edit";

// Where `server prepare` stopped for the person to do something, in this window's words.
const NEXT_ACTIONS = {
  "docker-first-run": "Docker Desktop 창에서 약관에 동의하고 처음 설정을 마치세요. 엔진이 켜졌다고 하면 다시 시도를 누르세요.",
  "restart-required": "Docker Desktop이 쓰는 WSL 2를 마저 설치하려면 Windows를 다시 시작해야 합니다. 다시 켠 뒤 이 앱을 열면 이어서 합니다.",
  "docker-install-approval": "Docker Desktop을 설치하려면 Windows가 묻는 창에서 예를 눌러야 합니다. 누른 뒤 다시 시도를 누르세요.",
};

/** A Google login's id under its name, only when another one has the same name. */
function idpSub(idp, idps) {
  const named = (idp.name || "").trim();
  return named && idps.filter((other) => (other.name || "").trim() === named).length < 2 ? null : h("span", { class: "mono" }, idp.id);
}

/** "alice와 bob", "alice, bob과 carol": names joined the way a sentence reads. */
function joined(names) {
  if (names.length < 2) return names.join("");
  return `${names.slice(0, -1).join(", ")}와 ${names.at(-1)}`;
}

/** Where a computer set up already collects now: its own server, another, or nowhere. */
function currentServer(context) {
  if (!context?.configured) return "none";
  return sameServer(context.honcho?.url, context.localServer?.apiUrl) ? "here" : "remote";
}

/**
 * Whether a computer joins a team by itself, its setup left as it is: one that
 * collects, or one in a team that stores nothing. A server installed but not
 * collecting, or a Honcho this app did not make answering (`answers`), takes every
 * step. `mode` is how first setup ended here (app.prefs.mode).
 */
export function joinsAlone(context, { mode = "", answers = false } = {}) {
  if (context?.configured) return true;
  return !context?.localServer && !answers && joinedTeam(context?.team, mode);
}

/** What the window starts from: nothing chosen, at a team link's team when it came from one. */
function startState(link, context) {
  return {
    path: link ? "link" : null,
    // A computer set up already that joins a team does the team's part alone.
    joinOnly: false,
    // zones and idps: what Cloudflare offered when the token sees more than one.
    team: { hub: link, me: null, directory: null, name: "", apiToken: "", email: "", zone: "", hubLabel: "", idp: "", zones: [], idps: [] },
    // leave: 옮기고 로그인 was pressed, so the login starts by leaving ownTeam.
    login: { phase: "idle", error: "", tab: null, reopen: null, logouts: null, switchFrom: null, sameAccount: false, leave: false },
    draft: collectDraft(context),
    models: { chosen: new Set(["codex"]), counts: { codex: 1, claude: 1 } },
    // 추출·드림·묻기, filled on the 모델 step; `picked` holds what the person changed
    // ("deriver.model", "dream.effort"), the only parts sent: the server fills the rest.
    roles: null,
    picked: new Set(),
    mates: new Set(),
    tasks: [],
    applied: null,
    requested: [],
  };
}

// ── What the window does, from its state and this computer's context ──

const inTeamPath = (state) => ["join", "link", "make"].includes(state.path);
/** The server the hub says this person has. */
const ownServer = (state) => state.team.me?.servers?.[0] || null;
/** The server is the one this computer runs and already shares through the team. */
const runsHere = (server, context) => Boolean(server && context?.localServer && server.host === context?.team?.localHost);
/** This computer made the server: the hub keeps the name of the computer that made it. */
const madeOn = (server, context) => Boolean(server?.createdOn && context?.team?.computer && server.createdOn === context.team.computer);
/** A server to make here first: one chosen here, with none on this computer yet. */
const newServer = (state, context) => state.draft.server === "here" && !context?.localServer;

/** The teammates ticked in the 팀원 step, with their servers. */
function chosenMates(state) {
  if (!inTeamPath(state) || state.path === "make") return [];
  const servers = new Map((state.team.directory?.servers || []).map((server) => [server.owner, server]));
  return (state.team.directory?.people || [])
    .filter((person) => state.mates.has(person.email) && servers.has(person.email))
    .map((person) => ({ email: person.email, name: personName(person), host: servers.get(person.email).host }));
}

/**
 * The peer name the team gives this person, on a computer set up already that
 * joins it alone with another one in its setup: `{ from, to }`, or null when they
 * are the same. The hub names a person after their email (server/hub/hub.mjs), and
 * a computer takes that name at its setup.
 */
export function peerChange(state, context) {
  const to = state.team.me?.peer || "";
  const from = context?.user?.peerId || "";
  return state.joinOnly && context?.configured && to && to !== from ? { from, to } : null;
}

/**
 * The rows of 적용, as data: each names what it runs by its `key` (RUNS in
 * openSetup), so a window opened again runs the rows left from what it kept. The
 * last is 점검. A computer set up already that joins a team alone has the team's
 * rows only: its peer name when the team's is another, its server opened to the
 * team, the teammates asked, and 점검.
 */
export function applyRows(state, context) {
  const { draft } = state;
  const tasks = [];
  const install = newServer(state, context);
  const mine = ownServer(state);
  // In a team this computer's server opens to it unless it is open already; joining
  // alone, also unless the person has a server on another computer.
  const opens = inTeamPath(state) && draft.server === "here" && !runsHere(mine, context) && (!state.joinOnly || !mine || madeOn(mine, context));
  const share = { key: "share", title: "팀에 내 서버 열기", sub: "팀원이 승인을 받아 물을 수 있는 내 서버 주소를 만듭니다." };
  if (state.joinOnly) {
    const peer = peerChange(state, context);
    if (peer) tasks.push({ label: "대화 수집" }, { key: "peer", title: "peer 이름 바꾸기", sub: peer.from ? `${peer.from} → ${peer.to}` : peer.to });
    if (opens) tasks.push({ label: "기억 서버" }, share);
  } else {
    if (draft.server !== "none") tasks.push({ label: "기억 서버" });
    if (install) {
      tasks.push({ key: "install", title: "기억 서버 설치", sub: "Docker와 Ollama, Honcho, 구독 게이트웨이를 받아 설치합니다. 처음에는 몇 분 걸립니다." });
      for (const [backend, name] of BACKENDS) {
        if (!state.models.chosen.has(backend)) continue;
        const count = state.models.counts[backend];
        for (let index = 1; index <= count; index += 1) {
          tasks.push({ key: "login", backend, index, title: `${name} 계정 로그인${count > 1 ? ` ${index}/${count}` : ""}`, sub: "브라우저에서 로그인을 마치세요." });
        }
      }
      tasks.push({ key: "prepare", title: "기억 서버 준비", sub: "서버 설정을 쓰고 임베딩 모델을 받습니다. 처음에는 오래 걸립니다." });
      tasks.push({ key: "start", title: "기억 서버 켜기" });
    } else if (draft.server === "found") {
      tasks.push({ key: "found", title: "내 서버 연결", sub: mine?.host || "" });
    } else if (draft.server !== "none") {
      const host = draft.server === "remote" ? draft.remoteUrl.trim() : context?.localServer?.apiUrl || "";
      tasks.push({ key: "reach", title: draft.server === "remote" ? "내 서버 연결" : "이 컴퓨터 서버 연결", sub: host.replace(/^https?:\/\//, "") });
    }
    if (opens) tasks.push(share);
    if (draft.company?.on) tasks.push({ key: "company", title: "회사 서버에 승인 요청", sub: draft.company.host });
    if (draft.server !== "none") {
      tasks.push({ label: "에이전트" });
      const agents = Object.keys(AGENTS).filter((name) => draft.agents?.has(name));
      const held = pastToPut(draft) ? HELD : null;
      agents.forEach((name, index) => tasks.push({ key: "plugin", first: !index, title: `${AGENTS[name]}에 플러그인 설치`, sub: held }));
      tasks.push({ label: "지난 대화" });
      tasks.push({ key: "line", title: "시작한 시각순으로 줄 세우기" });
      if (draft.past.totals?.dupes) tasks.push({ key: "dupes", title: "겹치는 대화 빼기" });
      if (!install) tasks.push({ key: "onServer", title: "서버에 있는 대화 빼기" });
      tasks.push({ key: "fill", title: "시간순으로 쌓기 시작" });
    }
  }
  const mates = chosenMates(state);
  if (mates.length) {
    tasks.push({ label: "팀원" });
    tasks.push({ key: "mates", title: `${joined(mates.map((mate) => mate.name))}에게 열람 요청` });
  }
  tasks.push({ label: "점검" }, { key: "check", title: "점검", sub: checkSub(state) });
  return tasks.map((task) => (task.label ? task : { state: "wait", ...task }));
}

/** What 점검 looks at: the team's logins for a setup that stores nothing. */
function checkSub(state) {
  return checkingText({ team: state.draft.server === "none", verify: state.verify });
}

/** The end's button, as [label, screen]: a computer that joined a team alone, or stores nothing, has its news on the team screen. */
export function endButton(state) {
  if (state.path === "make") return ["관리자 탭 열기", "admin"];
  if (state.draft.server === "none" || state.joinOnly) return ["팀 화면 열기", "team"];
  return ["대시보드 열기", "dashboard"];
}

const KEPT_VERSION = 1;

/** An address as it is kept: its origin and path, so nothing typed after them is. */
function plainUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    return `${url.origin}${url.pathname}`.replace(/\/$/, "");
  } catch {
    return "";
  }
}

/**
 * What a window keeps of its setup once 적용 starts (lib/state.js): the choices the
 * rows run with and each row as it stands. Fields are taken one by one, so no secret
 * the steps hold (a server's token, the Cloudflare API token) is ever among them,
 * and an address keeps its origin and path only. A server that needs a token is
 * then refused at 점검, whose 대화 수집 수정 takes it.
 */
export function setupSnapshot(state) {
  const { draft, team } = state;
  const list = (set) => (set ? [...set] : null);
  const past = draft.past;
  return {
    version: KEPT_VERSION,
    path: state.path,
    joinOnly: Boolean(state.joinOnly),
    verify: Boolean(state.verify),
    team: { hub: team.hub, name: team.name, me: team.me, directory: team.directory },
    draft: {
      server: draft.server,
      remoteUrl: plainUrl(draft.remoteUrl),
      userPeer: draft.userPeer,
      workspace: draft.workspace,
      agents: list(draft.agents),
      checked: list(draft.checked),
      projects: draft.projects ? draft.projects.map(({ path, name }) => ({ path, name })) : null,
      rest: draft.rest,
      automation: Boolean(draft.automation),
      company: draft.company ? { on: draft.company.on, host: draft.company.host, label: draft.company.label, owner: draft.company.owner, folders: [...draft.company.folders], requested: Boolean(draft.company.requested) } : null,
      past: {
        storeOn: past.storeOn,
        store: past.store,
        filled: past.filled,
        chatgptOn: past.chatgptOn,
        late: past.late,
        totals: past.totals,
        scan: past.scan?.chatgpt ? { chatgpt: past.scan.chatgpt.map(({ id, applied }) => ({ id, applied })) } : null,
      },
    },
    models: { chosen: [...state.models.chosen], counts: state.models.counts },
    roles: state.roles,
    picked: [...state.picked],
    mates: [...state.mates],
    requested: state.requested,
    // What the end's to-dos read from setup apply: what is left to run by hand, and
    // whether each hook was written anew or a plugin installed.
    applied: state.applied ? {
      nextSteps: state.applied.nextSteps || [],
      ...(state.applied.hooks ? { hooks: state.applied.hooks.map(({ provider, changed }) => ({ provider, changed: Boolean(changed) })) } : {}),
      ...(state.applied.plugins ? { plugins: state.applied.plugins.map(({ agent, action }) => ({ agent, action })) } : {}),
    } : null,
    plan: state.plan || null,
    filling: Boolean(state.filling),
    tasks: state.tasks.map(({ extra, ...task }) => task),
  };
}

/** A setup kept half way that a window can carry on: kept by this version, with its rows. */
export function resumable(kept) {
  return kept?.version === KEPT_VERSION && Array.isArray(kept.tasks) && kept.tasks.length > 0;
}

/**
 * A window opened again on a setup kept half way: its state, at 적용, the rows done
 * kept done and the one that was running or stopped to run again. Docker Desktop's
 * window is read from the plan again, which a restart may have changed. Null when
 * there is nothing to carry on, or `link` is another team's: that link starts anew.
 */
export function restoreSetup(kept, context, { link = "" } = {}) {
  if (!resumable(kept)) return null;
  if (link && kept.team?.hub !== link) return null;
  const state = startState(kept.path === "link" ? kept.team?.hub || "" : "", context);
  const saved = kept.draft || {};
  const draft = state.draft;
  Object.assign(state, { path: kept.path || null, joinOnly: Boolean(kept.joinOnly), verify: Boolean(kept.verify) });
  Object.assign(state.team, { hub: kept.team?.hub || "", name: kept.team?.name || "", me: kept.team?.me || null, directory: kept.team?.directory || null });
  Object.assign(draft, {
    server: saved.server || draft.server,
    remoteUrl: saved.remoteUrl || "",
    userPeer: saved.userPeer || draft.userPeer,
    workspace: saved.workspace || draft.workspace,
    agents: saved.agents ? new Set(saved.agents) : draft.agents,
    checked: saved.checked ? new Set(saved.checked) : null,
    projects: saved.projects || null,
    rest: saved.rest || draft.rest,
    automation: Boolean(saved.automation),
    company: saved.company ? { ...saved.company, folders: new Set(saved.company.folders || []) } : null,
  });
  Object.assign(draft.past, saved.past || {});
  state.models = { chosen: new Set(kept.models?.chosen || ["codex"]), counts: { codex: 1, claude: 1, ...kept.models?.counts } };
  state.roles = kept.roles || null;
  state.picked = new Set(kept.picked || []);
  state.mates = new Set(kept.mates || []);
  state.matesSeeded = true;
  state.requested = kept.requested || [];
  state.applied = kept.applied || null;
  state.plan = kept.plan || null;
  state.filling = Boolean(kept.filling);
  state.tasks = kept.tasks.map((task) => (task.label || task.state === "ok" ? task : { ...task, state: "wait", error: null }));
  return state;
}

/**
 * What an open window does with a team link opened again (#/start?team=), `team`
 * its address: "keep" what it shows, or "login" to start over at that team's login.
 * A window that waits for 이어서 하기 (`paused`) does what opening it with that link
 * does (restoreSetup): the same team's link keeps it waiting, another's is "anew",
 * what it kept dropped and that team's login first. One applying keeps on.
 */
export function linkTurn(state, team, { paused = false } = {}) {
  if (!team) return "keep";
  if (paused) return state.team?.hub === team ? "keep" : "anew";
  if (state.tasks.length || (state.path === "link" && state.team?.hub === team)) return "keep";
  return "login";
}

/**
 * Opens the window. `firstRun` keeps it open until setup is done; `team` is the
 * team's address from a team link. `onDone(screen)` hears which screen to open
 * after it; `onCancel` that it was closed half way.
 */
export function openSetup({ firstRun, onDone, onCancel, team = "" }) {
  // The team link this window follows; a later one replaces it (win.follow).
  let link = teamHostOf(team) || team;
  // The team this computer is in, until 옮기고 로그인 leaves it.
  let ownTeam = app.context?.team || null;
  // A setup kept half way opens at 적용, its rows done kept done, and waits for 이어서
  // 하기 or 처음부터; another team's link starts anew.
  const kept = keptSetup();
  const resumed = restoreSetup(kept, app.context, { link });
  if (kept && !resumed) dropSetup();
  let state = resumed || startState(link, app.context);
  let paused = Boolean(resumed);
  let at = 0;
  let steps = [];
  let keys = [];
  // Redraws the stepper and the button when a choice changes the steps that follow.
  let frame = null;
  // Closed during 적용, the row on its way ends and the rest wait for the window to open again.
  let closed = false;
  const issue = h("div", {});
  const win = modal({
    title: TITLE,
    locked: firstRun,
    onClose: (value) => {
      closed = true;
      if (value !== "done") onCancel?.();
    },
  });

  const inTeam = () => inTeamPath(state);
  /** The team this computer leaves first, when the login is to another team's address. */
  const teamToLeave = () => (["join", "link"].includes(state.path) && joinCase(ownTeam, state.team.hub) === "move" ? ownTeam : null);
  const me = () => state.team.me;
  const myServer = () => ownServer(state);
  const thisComputers = (server) => runsHere(server, app.context);
  const madeHere = (server) => madeOn(server, app.context);
  /** The team's company server, when this person is not its owner. */
  const company = () => (state.team.directory?.servers || []).find((server) => server.company && server.owner !== me()?.email) || null;

  // ── The steps, which follow the first choice and the server chosen ──

  /**
   * The first choice, or a link's. On a computer that collects, or one in a team
   * that stores nothing, a team's address joins that team alone, and the computer
   * goes on as it does now (joinsAlone).
   */
  function choose(path) {
    const joinedOnly = state.joinOnly;
    state.path = path;
    state.joinOnly = !firstRun && ["join", "link"].includes(path) && joinsAlone(app.context, { mode: app.prefs.mode, answers: app.status?.honcho?.state === "on" });
    if (state.joinOnly) state.draft.server = currentServer(app.context);
    else if (joinedOnly) state.draft.server = collectDraft(app.context).server;
  }

  const needsModel = () => newServer(state, app.context);
  const stepKeys = () => (state.joinOnly
    ? [...(state.path === "join" ? ["team"] : []), "login", "mates"]
    : [
      ...(state.path === "join" ? ["team"] : []),
      ...(state.path === "make" ? ["make"] : []),
      ...(inTeam() ? ["login"] : []),
      "server",
      ...(needsModel() ? ["subscription", "model"] : []),
      ...(state.draft.server === "none" ? [] : ["agents", "past", "projects"]),
      ...(inTeam() && state.path !== "make" ? ["mates"] : []),
    ]);

  function teamStep() {
    const input = h("input", { class: "input mono", autocomplete: "off", spellcheck: "false", placeholder: "team.example.com", value: state.team.hub });
    input.addEventListener("input", () => { state.team.hub = input.value; });
    return {
      body: h("div", {}, h("h3", {}, "팀 주소를 넣으세요"),
        field("팀 주소", input, "관리자가 보낸 팀 주소입니다. 들어가면 브라우저에서 Google 로그인을 합니다.")),
      next: "Google로 로그인",
      check() {
        const host = teamHostOf(state.team.hub);
        if (!host) { input.focus(); return "팀 주소를 team.example.com 이나 https://로 시작하게 넣으세요."; }
        state.team.hub = host;
        return null;
      },
    };
  }

  function makeStep() {
    const input = (key, attributes) => {
      const element = h("input", { class: "input", autocomplete: "off", spellcheck: "false", value: state.team[key], ...attributes });
      element.addEventListener("input", () => { state.team[key] = element.value; });
      return element;
    };
    const name = input("name", { placeholder: "예: 우리 팀", maxlength: "60" });
    const token = input("apiToken", { type: "password", class: "input mono" });
    const email = input("email", { type: "email", class: "input mono", placeholder: "admin@example.com" });
    const { zones, idps } = state.team;
    // Cloudflare had more than one and the token did not say which: one to pick, at the top.
    const choice = (key, text, rows) => notice("warn", h("b", {}, text),
      opts(...rows.map(([value, title, sub]) => opt({
        name: `make-${key}`, value, title, sub, checked: state.team[key] === value,
        onChange: (on) => { if (on) state.team[key] = value; },
      }))));
    return {
      body: h("div", {}, h("h3", {}, "새 팀 만들기"),
        zones.length ? choice("zone", `이 token이 보는 zone이 ${zones.length}개입니다. 팀 주소에 쓸 zone을 고르세요.`,
          zones.map((zone) => [zone, h("span", { class: "mono" }, zone)])) : null,
        idps.length ? choice("idp", `Cloudflare Zero Trust에 Google 로그인이 ${idps.length}개 있습니다. 팀 주소에 로그인할 때 쓸 것을 고르세요.`,
          idps.map((idp) => [idp.id, idp.name || idp.id, idpSub(idp, idps)])) : null,
        field("팀 이름", name),
        field("Cloudflare API token", token, "Cloudflare에서 만든 API token을 여기에만 붙여 넣으세요."),
        field("관리자 Google 이메일", email, "팀 주소로 로그인할 내 Google 계정입니다."),
        h("details", { class: "fold" }, h("summary", {}, "token 권한과 팀 주소"),
          h("p", { class: "hint" }, `token에는 ${TOKEN_PERMISSIONS}만 줍니다.`),
          zones.length ? null : field("zone", input("zone", { class: "input mono", placeholder: "example.com" }), "비워 두면 token이 보는 zone이 하나일 때 그것을 씁니다."),
          field("팀 주소 이름", input("hubLabel", { class: "input mono", placeholder: "team" }), "팀 주소는 <이름>.<zone>이 됩니다."))),
      next: "만들고 로그인",
      check() {
        if (!state.team.name.trim()) { name.focus(); return "팀 이름을 넣으세요."; }
        if (!state.team.apiToken.trim()) { token.focus(); return "Cloudflare API token을 넣으세요."; }
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(state.team.email.trim())) { email.focus(); return "관리자 Google 이메일을 넣으세요."; }
        if (zones.length && !zones.includes(state.team.zone)) return "팀 주소에 쓸 zone을 고르세요.";
        if (idps.length && !idps.some((idp) => idp.id === state.team.idp)) return "팀 주소에 로그인할 때 쓸 Google 로그인을 고르세요.";
        return null;
      },
      // Made before the login: the login is to the team this makes.
      async run() {
        const body = { name: state.team.name.trim(), email: state.team.email.trim(), apiToken: state.team.apiToken.trim() };
        if (state.team.zone.trim()) body.zone = state.team.zone.trim();
        if (state.team.hubLabel.trim()) body.hub = state.team.hubLabel.trim();
        if (state.team.idp) body.idp = state.team.idp;
        const made = await post("/api/team/make", body);
        if (!made.ok) {
          // Nothing was made yet: the step comes back with the list to pick from, token kept.
          if (["zone", "idp"].includes(made.choose) && made.choices?.length) {
            state.team[made.choose === "zone" ? "zones" : "idps"] = made.choices;
            throw Object.assign(new Error(""), { choose: true });
          }
          throw new Error(problem(made, "팀을 만들지 못했습니다."));
        }
        // Kept by the CLI on this computer and in the team hub; the window lets go of it.
        state.team.apiToken = "";
        state.team.hub = made.team.host;
      },
    };
  }

  function loginStep() {
    const { login } = state;
    const host = h("span", { class: "mono muted" }, state.team.hub);
    if (login.phase === "denied") {
      return {
        body: h("div", {}, h("h3", {}, "이 이메일은 팀 명단에 없습니다"),
          h("div", { class: "idbox" }, h("span", { class: "mono" }, login.email || "")),
          // Google picks the only account a browser is signed in to without asking.
          login.sameAccount ? notice("warn", "Google이 같은 계정을 다시 골랐습니다. 브라우저에 Google 계정이 하나뿐이면 Google은 묻지 않고 그 계정으로 로그인합니다. ",
            h("a", { href: GOOGLE_ADD_ACCOUNT, target: "_blank", rel: "noreferrer" }, "다른 Google 계정 추가"),
            "에서 쓸 계정을 브라우저에 더한 뒤 다른 계정으로 로그인을 다시 누르세요.") : null,
          h("p", { class: "lead", style: { marginTop: "12px" } }, "이 이메일을 팀 관리자에게 보내고, 등록되면 다시 로그인을 누르세요.")),
        foot: [
          button("다른 계정으로 로그인", { kind: "quiet", onClick: () => {
            // Access forgets the login on both of its domains, then the login starts
            // again in the same tab and Google is asked which account.
            const tab = loginTab("로그아웃하는 중입니다…");
            const logouts = login.logouts?.() || [];
            login.switchFrom = login.email || null;
            login.phase = "leaving";
            login.reopen = null;
            drawStep();
            switchAccount(tab, logouts).then(() => {
              login.phase = "idle";
              login.tab = tab;
              if (keys[at] === "login") drawStep();
            });
          } }),
          button("이메일 복사", { onClick: async () => { await copyText(login.email || ""); } }),
          button("다시 로그인", { kind: "primary", onClick: (event) => recheck(event.currentTarget) }),
        ],
        check: () => "팀 명단에 들어간 뒤 다시 로그인을 누르세요.",
      };
    }
    if (login.phase === "error") {
      return {
        body: h("div", {}, h("h3", {}, "로그인하지 못했습니다"), notice("bad", login.error)),
        foot: [button("다시 로그인", { kind: "primary", onClick: () => {
          login.phase = "idle";
          login.tab = loginTab("Google 로그인으로 넘어가는 중입니다…");
          drawStep();
        } })],
        check: () => login.error,
      };
    }
    const from = login.phase === "idle" && !login.tab ? teamToLeave() : null;
    if (from) {
      // Asked before the login starts: once it does, the team this computer is in is left.
      const named = (name, hub) => [name ? [h("b", {}, name), " "] : null, h("span", { class: name ? "mono muted" : "mono" }, hub)];
      // What the move stops: the servers this computer collects into through the team it leaves.
      const stops = teamServers(app.context);
      return {
        body: h("div", {}, h("h3", {}, "지금 팀에서 빠지고 새 팀으로 옮깁니다"),
          h("div", { class: "sheet-kv" }, kv("지금 팀", named(from.name, from.hub)), kv("새 팀", named(state.team.name, state.team.hub))),
          stops.length ? h("div", { class: "hint" }, `옮기면 지금 팀을 거쳐 쌓던 서버에는 더 쌓지 않습니다: ${stops.join(", ")}`) : null),
        foot: [button("옮기고 로그인", { kind: "primary", onClick: () => {
          // Opened in this click, so the browser lets it: the login goes there once this computer has left.
          login.tab = loginTab("Google 로그인으로 넘어가는 중입니다…");
          login.leave = true;
          drawStep();
        } })],
        check: () => "옮기고 로그인을 누르세요.",
      };
    }
    if (login.phase === "idle" && !login.tab) {
      // A team link opens this step with no click behind it, and the browser blocks a
      // tab opened without one; the login starts in this button's click instead.
      return {
        body: h("div", {}, h("h3", {}, "Google로 로그인을 누르세요"),
          h("div", { class: "idbox" }, state.team.name ? h("b", {}, state.team.name) : null, host)),
        foot: [button("Google로 로그인", { kind: "primary", onClick: () => {
          login.tab = loginTab("Google 로그인으로 넘어가는 중입니다…");
          drawStep();
        } })],
        check: () => "Google로 로그인을 누르세요.",
      };
    }
    if (login.phase === "idle") startLogin();
    const leaving = login.phase === "leaving";
    return {
      body: h("div", {}, h("h3", {}, "브라우저에서 Google 로그인을 마치세요"),
        h("div", { class: "idbox" }, state.team.name ? h("b", {}, state.team.name) : null, host),
        h("div", { class: "waitline" }, spinner(), leaving ? "이전 계정에서 로그아웃하는 중입니다." : "로그인을 기다리는 중입니다."),
        h("div", { class: "hint" }, "브라우저가 열리지 않았거나 로그인 창이 오류를 보이면 브라우저 다시 열기를 누르세요. 로그인을 새로 시작합니다.")),
      foot: [button("브라우저 다시 열기", { disabled: leaving, onClick: () => login.reopen?.() })],
      check: () => "브라우저에서 로그인을 마치세요.",
    };
  }

  /** The hub login, then who the hub says this is; after 옮기고 로그인, out of the team this computer is in first. */
  async function startLogin() {
    const { login } = state;
    login.phase = "waiting";
    const controller = new AbortController();
    login.abort = () => controller.abort();
    try {
      if (login.leave) {
        await leaveTeam();
        login.leave = false;
        ownTeam = null;
        // The screens under the window no longer show the team it left.
        loadContext().catch(() => {});
        if (controller.signal.aborted) throw new DOMException("cancelled", "AbortError");
      }
      const flow = teamLogin({ kind: "hub", hub: state.team.hub, tab: login.tab, signal: controller.signal });
      login.reopen = flow.reopen;
      login.logouts = flow.logouts;
      await flow.done;
      login.tab = null;
      await admit();
    } catch (error) {
      // A tab still at 넘어가는 중 would look like a login going on.
      login.tab?.close();
      login.tab = null;
      if (error?.name === "AbortError") return;
      login.phase = "error";
      login.error = error?.message || String(error);
      if (keys[at] === "login") drawStep();
    }
  }

  /** Who the hub says this is: on the list, on to the server step; not, the 명단에 없음 screen. */
  async function admit() {
    const { login } = state;
    const who = await teamMe(state.team.hub);
    login.email = who.email;
    // After 다른 계정으로 로그인: the same email again means Google chose the same account.
    login.sameAccount = !who.member && sameAccountAgain(login.switchFrom, who.email);
    login.switchFrom = null;
    if (!who.member) {
      login.phase = "denied";
      if (keys[at] === "login") drawStep();
      return;
    }
    state.team.me = who;
    state.team.name = who.team?.name || state.team.name;
    state.team.directory = await teamDirectory().catch(() => null);
    // A team's peer name comes from the email; nobody types it.
    state.draft.userPeer = who.peer || state.draft.userPeer;
    // Someone with a server starts from it. This computer's own server is "here", and so
    // is one this computer made that is gone (the app set up again): it is made again
    // here and its address moves to it. Joining alone, this computer keeps its own.
    const own = who.servers?.[0];
    if (!state.joinOnly) state.draft.server = state.path === "make" || !own || thisComputers(own) || madeHere(own) ? "here" : "found";
    login.phase = "done";
    if (keys[at] === "login") { at += 1; drawStep(); }
  }

  async function recheck(target) {
    target.disabled = true;
    try { await admit(); } catch (error) { state.login.phase = "error"; state.login.error = error.message; drawStep(); }
    finally { target.disabled = false; }
  }

  /** The server step in a team: the server this person has, a new one here, or none; and the company server. */
  function teamServerStep() {
    const draft = state.draft;
    const own = myServer();
    const here = thisComputers(own);
    const local = app.context?.localServer;
    // A server this computer made is never one to connect to from here. Not running
    // here (the app set up again), it is made again and its address moves to it.
    const gone = !here && !local && madeHere(own);
    const mine = here || madeHere(own) ? null : own;
    const choices = state.path === "make" || !mine ? ["here", "none"] : ["found", "here", "none"];
    if (!choices.includes(draft.server)) draft.server = choices[0];
    const pick = (choice) => () => { draft.server = choice; frame?.(); };
    const rows = choices.map((choice) => {
      if (choice === "found") {
        return opt({ name: "server", value: "found", checked: draft.server === "found", onChange: pick("found"),
          title: ["내 서버 ", h("span", { class: "mono muted" }, mine.host)],
          sub: mine.createdOn ? `${mine.createdOn}에서 만든 서버` : null,
          end: tag("찾음", "ok") });
      }
      if (choice === "here") {
        return local
          ? opt({ name: "server", value: "here", checked: draft.server === "here", onChange: pick("here"),
            title: ["이 컴퓨터 서버 ", h("span", { class: "mono muted" }, local.apiUrl.replace(/^https?:\/\//, ""))],
            sub: here ? own.host : own ? "내 서버 주소를 이 컴퓨터 서버로 옮깁니다." : null,
            end: here ? tag("지금 쌓는 중", "ok") : tag("이 컴퓨터에 있음") })
          : opt({ name: "server", value: "here", checked: draft.server === "here", onChange: pick("here"),
            title: "이 컴퓨터에 새로 만들기", sub: own ? `${NEW_SERVER_SUB} 내 서버 주소를 이 컴퓨터 서버로 옮깁니다.` : NEW_SERVER_SUB });
      }
      return opt({ name: "server", value: "none", checked: draft.server === "none", onChange: pick("none"), title: "쌓지 않기" });
    });
    const other = state.path === "make" ? null : company();
    if (other && !draft.company) draft.company = { on: false, host: other.host, label: "회사 서버", owner: other.owner, folders: new Set() };
    return {
      body: h("div", {},
        h("h3", {}, "어디에 쌓을까요?"),
        own ? h("div", { class: "label" }, "내 기억 서버") : h("p", { class: "lead" }, `${me()?.email || ""} 계정에는 아직 기억 서버가 없습니다.`),
        opts(...rows),
        gone ? h("div", { class: "hint" }, `내 서버 ${own.host}는 이 컴퓨터에서 만든 서버인데, 지금 이 컴퓨터에 없습니다. 새로 만들면 이 주소가 새 서버로 옮겨집니다.`) : null,
        other ? [h("div", { class: "label" }, "함께 쌓을 서버"), opts(opt({
          type: "checkbox",
          name: "company",
          value: other.host,
          checked: draft.company.on,
          title: ["회사 ", h("span", { class: "mono muted" }, other.host)],
          end: tag("승인 요청", "warn"),
          onChange: (on) => { draft.company.on = on; },
        }))] : null),
      check: () => (draft.server === "none" && draft.company?.on ? "회사 서버에 쌓으려면 내 기억 서버를 먼저 고르세요." : null),
    };
  }

  function subscriptionStep() {
    const { chosen, counts } = state.models;
    const row = ([backend, title]) => {
      // The number of accounts belongs to a subscription that is ticked; kept in place
      // but not shown otherwise, so an unticked row does not read as one account.
      const accounts = h("span", { class: "cnt-g" }, h("span", { class: "cnt-l" }, "계정"), counter(counts[backend], {
        min: 1, max: 5, label: `${title} 계정 수`,
        onChange: (count) => { counts[backend] = count; },
      }));
      const shown = (on) => { accounts.style.visibility = on ? "" : "hidden"; };
      shown(chosen.has(backend));
      return opt({
        type: "checkbox",
        name: "models",
        value: backend,
        checked: chosen.has(backend),
        title: `${title} 구독`,
        end: accounts,
        onChange: (on) => { if (on) chosen.add(backend); else chosen.delete(backend); shown(on); },
      });
    };
    return {
      body: h("div", {},
        h("h3", {}, "기억 서버가 쓸 구독을 고르세요"),
        h("p", { class: "lead" }, "적용할 때 고른 계정마다 브라우저에서 로그인합니다. 이 컴퓨터에 이미 로그인된 계정이 있으면 그 계정을 씁니다."),
        opts(...BACKENDS.map(row)),
        h("div", { class: "hint" }, "하나 이상 고르세요. 계정이 여럿이면 +를 누르세요.")),
      check: () => (chosen.size ? null : "구독을 하나 이상 고르세요."),
    };
  }

  /**
   * 추출·드림·묻기 from the chosen subscriptions' models. Nothing is logged in yet, so
   * the list is the one the app knows (chatModels.setup). A part the person changed
   * stays while its model is still on offer; the rest follow the subscriptions, so
   * choosing Claude makes them Opus.
   */
  function modelStep() {
    const catalog = app.context?.chatModels?.setup || {};
    const groups = BACKENDS.filter(([backend]) => state.models.chosen.has(backend)).map(([backend]) => ({ backend, models: catalog[backend] || [] }));
    const offered = groups.flatMap((group) => group.models);
    const fallback = defaultRoles(offered, app.context?.chatModels);
    const before = state.roles;
    state.roles = Object.fromEntries(ROLES.map(([key]) => {
      if (state.picked.has(`${key}.model`) && !offered.includes(before?.[key]?.model)) state.picked.delete(`${key}.model`);
      return [key, {
        model: state.picked.has(`${key}.model`) ? before[key].model : fallback[key].model,
        effort: state.picked.has(`${key}.effort`) ? before[key].effort : fallback[key].effort,
      }];
    }));
    const rows = roleRows(state.roles, {
      groups,
      efforts: app.context?.chatModels?.efforts || ["low", "medium", "high", "xhigh", "max"],
      onChange: (key, part) => state.picked.add(`${key}.${part}`),
    });
    return {
      body: h("div", {},
        h("h3", {}, "기억 서버가 쓸 모델을 고르세요"),
        h("p", { class: "lead" }, "추출, 드림, 묻기마다 모델과 effort를 고르세요."),
        rows.root,
        h("div", { class: "hint" }, "나중에 서버 → 모델에서 바꿀 수 있습니다.")),
      check: () => null,
    };
  }

  /** The parts of 추출·드림·묻기 the person changed, for `server prepare`. */
  function chosenRoles() {
    const roles = {};
    for (const [key] of ROLES) {
      const parts = ["model", "effort"].filter((part) => state.picked.has(`${key}.${part}`));
      if (parts.length) roles[key] = Object.fromEntries(parts.map((part) => [part, state.roles[key][part]]));
    }
    return roles;
  }

  /** The teammates who have a server: whose memory this computer's agents may ask, once they approve. */
  function matesStep() {
    const people = (state.team.directory?.people || []).filter((person) => person.email !== me()?.email);
    const servers = new Map((state.team.directory?.servers || []).map((server) => [server.owner, server]));
    if (!state.matesSeeded) {
      for (const person of people) if (servers.has(person.email)) state.mates.add(person.email);
      state.matesSeeded = true;
    }
    const rows = people.map((person) => {
      const server = servers.get(person.email);
      const name = personName(person);
      return opt({
        type: "checkbox",
        name: "mates",
        value: person.email,
        checked: Boolean(server) && state.mates.has(person.email),
        disabled: !server,
        title: server ? [name, " ", h("span", { class: "mono muted" }, server.host)] : name,
        sub: server ? null : "서버 없음",
        onChange: (on) => { if (on) state.mates.add(person.email); else state.mates.delete(person.email); },
      });
    });
    return {
      body: h("div", {}, h("h3", {}, "어느 팀원의 기억에 물을까요?"),
        h("p", { class: "lead" }, "고른 팀원에게 기억 열람을 요청합니다. 승인되면 이 컴퓨터의 Claude Code와 Codex가 그 팀원이 연 대화를 찾아봅니다."),
        rows.length ? opts(...rows) : h("div", { class: "opts" }, h("div", { class: "list-empty" }, "아직 서버를 연 팀원이 없습니다."))),
      // Joining alone has no server step to go back to, so no teammate is needed.
      check: () => (!state.joinOnly && state.draft.server === "none" && !state.mates.size ? "내 대화를 쌓지 않으면 팀원을 하나 이상 고르세요." : null),
    };
  }

  /** The server the projects step counts against: none yet for one this setup makes, a team's by its address. */
  const overviewServer = () => draftServer(state.draft, app.context, {
    newServer: needsModel(),
    url: state.draft.server === "found" ? `https://${myServer().host}` : null,
  });

  function buildStep(key) {
    const context = app.context;
    if (key === "team") return teamStep();
    if (key === "make") return makeStep();
    if (key === "login") return loginStep();
    if (key === "subscription") return subscriptionStep();
    if (key === "model") return modelStep();
    if (key === "mates") return matesStep();
    if (key === "agents") return agentsStep(state.draft);
    if (key === "past") return pastStep(state.draft, context, { newServer: needsModel() });
    if (key === "projects") return projectsStep(state.draft, context, { server: overviewServer() });
    if (inTeam()) return teamServerStep();
    return serverStep(state.draft, context, { choices: ["here", "remote"], onPick: () => frame?.() });
  }

  // ── The window, one screen at a time ──

  function drawStart() {
    win.steps(null);
    win.body(
      h("h3", {}, "어떻게 시작할까요?"),
      h("div", { class: "cards" }, STARTS.map(([key, title, text, label]) => h("div", { class: "cardopt" },
        h("b", {}, title), h("p", {}, text),
        button(label, { kind: key === state.path ? "primary" : "", onClick: () => {
          choose(key);
          // A server choice another way allowed is not one this way offers.
          if (!state.joinOnly && key === "solo" && !["here", "remote"].includes(state.draft.server)) state.draft.server = "here";
          if (!state.joinOnly && key !== "solo" && state.draft.server === "remote") state.draft.server = "here";
          at = 0;
          drawStep();
        } })))));
    win.foot(firstRun ? null : button("취소", { kind: "quiet", onClick: () => win.close() }), null);
  }

  /** What the step says under its fields, scrolled to so it shows above the buttons. */
  function say(node) {
    clear(issue, node);
    issue.scrollIntoView({ block: "nearest" });
  }

  function drawStep() {
    keys = stepKeys();
    at = Math.min(at, keys.length - 1);
    steps = keys.map((key, index) => (index === at ? buildStep(key) : null));
    const step = steps[at];
    clear(issue);
    win.steps(stepper(keys.map((key) => LABELS[key]), at));
    win.body(step.body, issue);
    const back = button(keys[at] === "login" ? "취소" : "이전", { kind: "quiet", onClick: () => {
      state.login.abort?.();
      if (keys[at] === "login") state.login.phase = "idle";
      // A link on a computer set up already came for that team alone: no start cards behind it.
      if (state.path === "link" && keys[at] === "login" && !firstRun) { win.close(); return; }
      if (at === 0 || (state.path === "link" && keys[at] === "login")) { state.path = link ? "link" : null; drawStart(); return; }
      at -= 1;
      drawStep();
    } });
    frame = null;
    if (step.foot) {
      win.foot(back, step.foot);
      return;
    }
    const last = () => at === stepKeys().length - 1;
    const label = () => step.next || (last() ? "적용" : "다음");
    // A step still reading (지난 대화) keeps 다음 until it is done, and says so beside it.
    const waiting = h("span", { class: "foot-hint" });
    const primary = button(label(), { kind: "primary", onClick: async (event) => {
      const problemText = step.check();
      if (problemText) { say(notice("warn", problemText)); return; }
      keys = stepKeys();
      if (last()) { apply(); return; }
      // The login opens a tab: opened now, in the click, so the browser lets it. Another
      // team's login first asks to leave this computer's team, and 옮기고 로그인 opens it.
      if (keys[at + 1] === "login" && !teamToLeave()) state.login.tab = loginTab(step.run ? "팀을 만드는 중입니다. 다 되면 Google 로그인으로 넘어갑니다…" : "Google 로그인으로 넘어가는 중입니다…");
      if (step.run) {
        const target = event.currentTarget;
        target.disabled = true;
        say(h("div", { class: "waitline" }, spinner(), "팀을 만드는 중입니다. 1~2분 걸립니다."));
        try {
          await step.run();
        } catch (error) {
          state.login.tab?.close();
          state.login.tab = null;
          target.disabled = false;
          // A choice to make first: the step is drawn again with it at the top.
          if (error.choose) { drawStep(); return; }
          say(notice("bad", error.message));
          return;
        }
      }
      state.login.phase = "idle";
      at += 1;
      drawStep();
    } });
    frame = () => {
      keys = stepKeys();
      win.steps(stepper(keys.map((key) => LABELS[key]), at));
      primary.querySelector("span").textContent = label();
    };
    step.watch?.(({ blocked, hint }) => {
      primary.disabled = blocked;
      waiting.textContent = hint || "";
    });
    win.foot(back, [waiting, primary]);
  }

  // ── 적용 중: each thing the setup does, one row each (applyRows) ──

  const matesChosen = () => chosenMates(state);

  async function prepare(task) {
    // Docker Desktop's own window comes up during the install: what to do in it shows from the start.
    if (state.docker === undefined) {
      state.docker = dockerSteps(await post("/api/server/plan", { profile: "personal" }).catch(() => null));
      keep();
      draw();
    }
    // With a login already in the gateway (set up again), this prepare writes the models too.
    const result = await post("/api/server/prepare", { profile: "personal", roles: chosenRoles() });
    if (result.nextAction?.kind === "gateway-login") return;
    if (result.ok && result.ready !== false) return;
    const action = NEXT_ACTIONS[result.nextAction?.kind];
    task.retry = "다시 시도";
    throw new Error(action || problem(result, "설치하지 못했습니다."));
  }

  async function login(task, backend, index) {
    // The gateway may hold this backend's accounts already (the app set up again on
    // this computer): as many logged in as were asked for are used as they are, and
    // a slot whose login never finished is logged in before another is added.
    if (!task.accountId) {
      const status = await gateway.status().catch(() => null);
      const { loggedIn, empty } = backendAccounts(status?.accounts, backend);
      if (index <= loggedIn.length) {
        task.sub = `이미 로그인된 계정 ${loggedIn[index - 1].login?.account || loggedIn[index - 1].id}`;
        return;
      }
      task.accountId = empty[index - loggedIn.length - 1] || null;
    }
    const panel = gatewayLogin({ backend, accountId: task.accountId || null, label: `${task.title}을 기다리는 중` });
    task.extra = panel.root;
    draw();
    const ok = await panel.done;
    task.accountId = panel.account();
    task.extra = null;
    // The panel goes with the reason it showed, so the reason stays on the task's line.
    if (!ok) throw new Error(`${panel.reason() || "로그인하지 못했습니다."} 다시 시도를 누르면 새로 로그인합니다.`);
  }

  async function prepareAgain() {
    const result = await post("/api/server/prepare", { profile: "personal", roles: chosenRoles() });
    if (result.nextAction?.kind === "gateway-login") throw new Error("구독 계정이 아직 연결되지 않았습니다. 위의 로그인을 마친 뒤 다시 시도를 누르세요.");
    if (!(result.ok && result.ready !== false)) throw new Error(NEXT_ACTIONS[result.nextAction?.kind] || problem(result, "준비하지 못했습니다."));
  }

  async function start(task) {
    await startServer("다시 시도");
    task.sub = app.context?.localServer?.apiUrl?.replace(/^https?:\/\//, "") || "";
  }

  /**
   * The peer name the team gives this person, on a computer set up already that
   * joins it alone: setup apply with that name only keeps the server, the folders,
   * the agents and the rest as they are.
   */
  async function renamePeer() {
    const peer = peerChange(state, app.context);
    if (!peer) return;
    const outcome = await applySetup({ userPeer: peer.to });
    if (!outcome.ok) throw new Error(problem(outcome.result, "peer 이름을 바꾸지 못했습니다."));
    state.applied = outcome.result;
    await loadContext().catch(() => {});
  }

  async function reach() {
    const plan = await post("/api/setup/plan", setupBody(state.draft, app.context));
    if (!plan.ready) throw new Error(problem(plan, "이 서버에 쌓을 수 없습니다."));
  }

  /** My server on another computer: this computer registers with its gate, then setup sends there. */
  async function connectFound(task) {
    const host = myServer().host;
    await registerWith(host);
    task.sub = host;
  }

  /** The address the team makes for this computer's server, and sharing on through it. */
  async function shareTeam(task) {
    const result = await post("/api/team/share", myServer() ? { replace: true } : {});
    if (!result.ok) throw new Error(problem(result, "팀에 내 서버를 열지 못했습니다."));
    task.sub = result.server?.host || result.host || "";
  }

  /** Asks the company server's owner; the server is written to only after they approve. */
  async function requestCompany(task) {
    const { company: chosen } = state.draft;
    const folders = (state.draft.projects || []).filter((project) => chosen.folders.has(project.path)).map((project) => project.name);
    await sendRequest({ kind: "collect", server: chosen.host, folders });
    chosen.requested = true;
    task.sub = `${chosen.host} · 승인 기다리는 중`;
  }

  async function applyNow() {
    // From here new turns wait, so none goes in before the past ones (lib/past.js).
    if (pastToPut(state.draft)) await holdNewTurns();
    const body = setupBody(state.draft, app.context);
    if (state.draft.server === "found") body.honchoUrl = `https://${myServer().host}`;
    const outcome = await applySetup(body);
    if (!outcome.ok) throw new Error(problem(outcome.result, "설정하지 못했습니다."));
    state.applied = outcome.result;
    // The company server takes nothing until its owner approves: kept, switched off.
    if (state.draft.company?.requested) {
      await post("/api/targets/add", {
        id: "company",
        label: "회사",
        url: `https://${state.draft.company.host}`,
        folders: [...state.draft.company.folders],
        team: true,
      }).catch(() => null);
    }
  }

  async function afterApply() {
    if (!state.applied) throw new Error("앞 단계를 먼저 마쳐야 합니다.");
  }

  // ── 지난 대화: the order, what is left out, and the start ──

  async function linePast(task) {
    state.plan = await planPast(state.draft);
    const { considered = 0, total = 0, first, last } = state.plan;
    task.sub = `${number(considered)}개${total ? ` · ${periodText(first, last)}` : ""}`;
  }

  async function dupesOut(task) {
    task.sub = `두 곳에 있는 같은 대화 ${number(state.plan?.dupes || 0)}개는 한 번만 넣습니다.`;
  }

  async function serverOut(task) {
    const there = Number(state.plan?.onServer || 0) + Number(state.plan?.already || 0);
    task.sub = there ? `${number(there)}개는 내 서버에 이미 있습니다.` : "내 서버에 이미 있는 대화가 없습니다.";
  }

  async function startFill(task) {
    const plan = state.plan;
    if (!plan?.total) {
      // Nothing to put in: the new turns held for them go now.
      await releaseNewTurns();
      task.sub = "새로 넣을 대화가 없습니다.";
      return;
    }
    await startPast();
    state.filling = true;
    // An empty server takes them all from the oldest; one with conversations, what it lacks.
    task.sub = !(Number(plan.onServer || 0) + Number(plan.already || 0))
      ? `${dayText(plan.first)} 대화부터`
      : `${number(plan.total)}개${plan.late && !plan.skippedLate ? ` · 오래된 ${number(plan.late)}개 포함` : ""}`;
  }

  async function requestMates(task) {
    const failed = [];
    for (const mate of matesChosen()) {
      if (state.requested.includes(mate.email)) continue;
      try {
        await sendRequest({ kind: "chat", server: mate.host });
        state.requested.push(mate.email);
      } catch (error) {
        failed.push(`${mate.name}: ${error.message}`);
      }
    }
    if (failed.length) throw new Error(failed.join(" "));
    task.sub = "승인 기다리는 중";
  }

  // 점검: doctor's checks and, for the server here, `server verify`; the team's logins
  // for a setup that stores nothing (lib/check.js). The row ends whatever it finds:
  // the end screen shows what it found.
  function checkAll() {
    if (state.draft.server === "none") {
      const host = matesChosen()[0]?.host || state.team.directory?.servers?.[0]?.host || "";
      return checkTeam({ host });
    }
    return checkHere({ verify: state.verify, expected: expectedServer(), done: state.applied });
  }

  /** The server this setup chose for the conversations, which 점검 expects them to go to. */
  function expectedServer() {
    if (state.joinOnly) return null;
    if (state.draft.server === "found") return myServer() ? `https://${myServer().host}` : null;
    if (state.draft.server === "remote") return state.draft.remoteUrl.trim() || null;
    return app.context?.localServer?.apiUrl || null;
  }

  // What each row of 적용 runs, by its key.
  const RUNS = {
    install: prepare,
    login: (task) => login(task, task.backend, task.index),
    prepare: prepareAgain,
    start,
    found: connectFound,
    reach,
    share: shareTeam,
    company: requestCompany,
    plugin: (task) => (task.first ? applyNow() : afterApply()),
    line: linePast,
    dupes: dupesOut,
    onServer: serverOut,
    fill: startFill,
    peer: renamePeer,
    mates: requestMates,
    check: async () => { state.check = await checkAll(); },
  };

  /** What this setup chose and did so far, for a window opened again (lib/state.js). */
  const keep = () => keepSetup(setupSnapshot(state));

  function draw() {
    const running = state.tasks.find((task) => task.state === "run");
    const failed = state.tasks.find((task) => task.state === "bad");
    win.body(
      h("h3", {}, "적용 중"),
      paused ? h("p", { class: "lead" }, "이어서 하기를 누르면 남은 줄부터 합니다.") : null,
      progressList(state.tasks.map((task) => {
        if (task.label) return task;
        const sub = task.state === "bad" ? task.error : task.sub;
        // Docker Desktop's window, until the install is through.
        const docker = task.key === "install" && task.state !== "ok" ? state.docker : null;
        return { state: task.state, title: task.title, sub: docker ? [sub, docker.map((line) => h("div", { class: "hint" }, line))] : sub };
      })),
      running?.extra || null);
    // A window opened again runs nothing by itself: the rows left wait for 이어서 하기.
    if (paused) {
      win.foot(button("처음부터", { kind: "quiet", onClick: restart }), button("이어서 하기", { kind: "primary", onClick: () => { paused = false; run(); } }));
      return;
    }
    win.foot(failed ? button("설정으로 돌아가기", { kind: "quiet", onClick: () => { state.tasks = []; dropSetup(); drawStep(); } }) : null,
      failed ? button(failed.retry || "다시 시도", { kind: "primary", onClick: () => run() }) : null);
  }

  /** 처음부터: what the window kept goes, and it is back at its first step. */
  function restart() {
    dropSetup();
    paused = false;
    state = startState(link, app.context);
    at = 0;
    begin();
  }

  async function run() {
    for (const task of state.tasks) {
      if (task.label || task.state === "ok") continue;
      if (closed) return;
      task.state = "run";
      task.error = null;
      draw();
      try {
        await RUNS[task.key](task);
        task.state = "ok";
      } catch (error) {
        task.state = "bad";
        task.error = error?.message || String(error);
        keep();
        draw();
        return;
      }
      keep();
    }
    if (closed) return;
    draw();
    finish();
  }

  function apply() {
    // A server on this computer is checked end to end at 점검.
    state.verify = state.draft.server === "here";
    win.steps(stepper(stepKeys().map((key) => LABELS[key]), "done"));
    state.tasks = applyRows(state, app.context);
    keep();
    run();
  }

  // ── 할 일: what 점검 found, what is left to do in the agents, and the bell ──

  function finish() {
    dropSetup();
    savePrefs({ mode: state.path === "link" ? "join" : state.path });
    // The setup just written names this person: the menu behind the window shows them
    // now, not 이름 미설정 until the window closes.
    loadContext().catch(() => {}).then(() => refreshStatus());
    const chatOnly = state.draft.server === "none";
    const [nextLabel, nextScreen] = endButton(state);
    const names = matesChosen().filter((mate) => state.requested.includes(mate.email)).map((mate) => mate.name);
    const heading = h("h3", {}, "점검하는 중입니다");
    const left = h("div", {});
    const lead = h("div", {});
    /**
     * What is left once 점검 answers: what to do in each agent, but for an agent
     * whose missing plugin its row already copies the commands for, the bell, and
     * the admin's first step.
     */
    const todo = (rows) => {
      const items = state.applied ? agentTodo(state.applied, state.draft.agents, { missing: missingPlugins(rows) }) : [];
      if (state.requested.length) items.push(TODO_BELL);
      if (state.path === "make") items.push({ title: "관리자 탭", text: "팀원 더하기로 팀원 이메일을 넣고, 팀 주소 줄의 복사를 눌러 초대 문구를 보내세요." });
      return items;
    };
    const paint = (rows) => {
      const items = todo(rows);
      const failed = failures(rows);
      const count = items.length + failed;
      // Waiting only when this setup asked someone: the admin who made a team asked nobody.
      heading.textContent = chatOnly && state.requested.length && !failed ? "승인 기다리는 중" : count ? `할 일 ${count}개` : "다 됐습니다";
      const agentsOnly = items.every((item) => Object.values(AGENTS).includes(item.title));
      clear(left, items.length ? [h("div", { class: "label" }, agentsOnly ? "에이전트에서 할 일" : "남은 할 일"), todoList(items)] : null);
      clear(lead, !items.length && !failed && !chatOnly ? h("p", { class: "lead" }, "이제 대화가 끝날 때마다 기억 서버에 쌓입니다.") : null);
    };
    const check = checkBox({
      check: checkAll,
      // What the 점검 row found; a window opened again after that row has it run once more.
      rows: state.check || null,
      sub: checkSub(state),
      onCollect: () => { win.close("done"); onDone?.("computer/collect"); },
      onChecked: (rows) => {
        state.check = rows;
        paint(rows);
      },
    });
    win.body(
      heading,
      chatOnly && names.length ? h("p", { class: "lead" }, `${joined(names)}에게 열람 요청을 보냈습니다.`) : null,
      check.root,
      left,
      lead,
      state.filling ? fillJob() : null);
    win.foot(null, button(nextLabel, { kind: "primary", onClick: () => { win.close("done"); onDone?.(nextScreen); } }));
  }

  /** 지난 대화 쌓는 중: how far the run got, asked again while the window shows it. */
  function fillJob() {
    const count = h("span", { class: "muted" });
    const bar = h("span", { style: { width: "0%" } });
    const line = h("div", { class: "s" }, "창을 닫아도 계속 쌓습니다.");
    const head = h("div", { class: "job-h" }, spinner(), h("b", {}, "지난 대화 쌓는 중"), h("span", { class: "sp" }), count);
    const box = h("div", { class: "job" }, head, h("div", { class: "bar run" }, bar), line);
    const look = async () => {
      if (!box.isConnected && box.dataset.shown) return;
      box.dataset.shown = "1";
      const past = (await get("/api/app/flow").catch(() => null))?.past || null;
      const running = past?.running;
      if (running) {
        const percent = running.total ? Math.max(1, Math.floor((running.done / running.total) * 100)) : 0;
        count.textContent = running.total !== null && running.total !== undefined ? `${number(running.done || 0)} / ${number(running.total)}` : "";
        bar.style.width = `${percent}%`;
        line.textContent = `${running.month ? `${runLine({ month: running.month })} 쌓음 · ` : ""}창을 닫아도 계속 쌓습니다.`;
      } else if (past?.last?.finishedAt) {
        clear(head, h("span", { class: "ic ok" }, "✓"), h("b", {}, "지난 대화를 다 쌓았습니다"), h("span", { class: "sp" }), h("span", { class: "muted" }, `${number(past.last.sent || 0)} / ${number(past.last.total || 0)}`));
        bar.style.width = "100%";
        bar.parentElement.classList.remove("run");
        line.textContent = past.last.held?.conversations ? `그동안 생긴 새 대화 ${number(past.last.held.conversations)}개도 쌓았습니다.` : "";
        return;
      }
      setTimeout(look, 2000);
    };
    setTimeout(look, 300);
    return box;
  }

  /**
   * A team link opened while the window is up (#/start?team= again): the window
   * starts over from it, at the login, unless setup is already applying. One that
   * waits for 이어서 하기 on another team's setup drops it, as 처음부터 does (linkTurn).
   */
  win.follow = (team) => {
    team = teamHostOf(team) || team;
    const turn = linkTurn(state, team, { paused });
    if (turn === "keep") return;
    if (turn === "anew") {
      link = team;
      restart();
      return;
    }
    state.login.abort?.();
    state.login.tab?.close();
    Object.assign(state.login, { phase: "idle", error: "", tab: null, reopen: null, abort: null, leave: false });
    link = team;
    choose("link");
    // Who the hub said this is belongs to the team before: the new one's login says it again.
    Object.assign(state.team, { hub: team, name: "", me: null, directory: null });
    at = 0;
    drawStep();
  };

  /** The first step: a team link's login, whose button opens the tab, or the start cards. */
  function begin() {
    if (link) {
      choose("link");
      drawStep();
    } else {
      drawStart();
    }
  }

  detectAgents({ fresh: true });
  loadProjects({ fresh: true });
  if (resumed) {
    // Back at 적용, paused: 설정으로 돌아가기 goes to the last step, as after 적용.
    at = stepKeys().length - 1;
    win.steps(stepper(stepKeys().map((key) => LABELS[key]), "done"));
    draw();
  } else {
    begin();
  }
  win.open();
  return win;
}

