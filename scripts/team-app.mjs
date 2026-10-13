// The app's team routes (ui.mjs sends /api/team/* and /oauth/callback here).
//
// These are the exception ui.mjs's header mentions: they run in the app's own
// process instead of as CLI subcommands. The browser login comes back to this
// process (the callback), and everything else is a short HTTPS request to the team
// hub or to a gate with this computer's team login (team-auth.mjs), or a change to
// the gate's access.json beside this computer's server (gate-access.mjs), or a read
// of that server's sessions for the folders to open (server-folders.mjs). What
// starts or stops a server still goes through the CLI.
//
// No route ever returns a token, a device key or the team's Jev key. A route that
// changes something is a JSON POST, as every other route of the app.
import { loadConfig } from "./config.mjs";
import { folderList, gateDevices, gateGrants, gateStatePaths, grantChat, grantCollect, revokeDevice, revokePerson, setChatOff, sourceList } from "./gate-access.mjs";
import { serverFolders } from "./server-folders.mjs";
import { CALLBACK_PATH, finishLogin, registerDevice, serverWhoami, setTeam, signOut, startLogin, teamAuthPaths, teamHost, teamLoginStatus } from "./team-auth.mjs";
import { computerName, hubCall, madeTeam, teamWhoami } from "./team-hub.mjs";

/** The routes that only read, so a GET may ask them. */
export const TEAM_READ_ROUTES = new Set(["/api/team/status"]);

function list(value) {
  return Array.isArray(value) ? value : [];
}

// The hub keeps, on an approved request, the names of what is open (it predates
// folders and calls them projects): at most 50, each up to 64 characters.
const HUB_NAMES = 50;
const HUB_NAME_LENGTH = 64;

/**
 * A folder as the hub shows it: the home folder as ~, without the characters the hub
 * refuses in a name (controls, invisible ones), and cut from the left to fit.
 */
function hubFolderName(entry) {
  const shown = entry.path.replace(/^\/Users\/[^/]+(?=\/|$)/, "~").replace(/^\/home\/[^/]+(?=\/|$)/, "~").replace(/^[A-Za-z]:\\Users\\[^\\]+(?=\\|$)/, "~")
    .replace(/[\p{C}\p{Zl}\p{Zp}]/gu, "").trim();
  const chars = [...shown];
  return chars.length <= HUB_NAME_LENGTH ? shown : `…${chars.slice(-(HUB_NAME_LENGTH - 1)).join("")}`;
}

// An app opened beside the folders, as the hub shows it. A folder's name always
// starts with ~, /, … or a drive, so the teammate's app tells the two apart.
const APP_NAMES = { chatgpt: "ChatGPT 기록", unknown: "기타 대화" };
const hubAppName = (source) => APP_NAMES[source] || `${source} 기록`;

/** The names of `folders` and `sources` for the hub's record of a request, the apps first so none is cut. */
function hubNames(folders, sources) {
  return [...new Set([...sources.map(hubAppName), ...folders.map(hubFolderName)].filter(Boolean))].slice(0, HUB_NAMES);
}

const NOTHING_CHOSEN = "폴더나 ChatGPT 기록을 하나 이상 고르세요.";

async function context() {
  const config = await loadConfig().catch(() => null);
  return { config, paths: teamAuthPaths(config), gate: gateStatePaths(config ? { serverDirectory: config.paths?.serverDir } : {}) };
}

/** The hub's answer about the Jev key, cut to what the page may see. */
function jevStatus(answer) {
  return { set: Boolean(answer?.set), setAt: answer?.setAt ?? null, setBy: answer?.setBy ?? null };
}

/** Where the browser comes back to: this app's own address, as the request reached it. */
function redirectUri(req) {
  return `http://${req.headers.host}${CALLBACK_PATH}`;
}

/**
 * Keeps the hub's word on whether this person is an admin, when it changed since the
 * login: another admin made them one or took it away, and the 관리자 menu follows
 * without logging in again.
 */
async function keepAdmin(directory, paths) {
  const status = await teamLoginStatus({ paths });
  const me = list(directory?.people).find((person) => person?.email === status.email);
  if (!status.hub || typeof me?.admin !== "boolean" || me.admin === status.admin) return;
  await setTeam({ hub: status.hub, admin: me.admin }, { paths });
}

/** Owner side: what is opened to whom, and the computers that write here. */
async function ownerView(gate) {
  const [grants, devices] = await Promise.all([gateGrants(gate), gateDevices(gate)]);
  return { grants, devices };
}

const ROUTES = {
  /**
   * Who this computer is signed in as, a login that ended, the browser logins that
   * failed (by id), and the team made here. Never a token.
   */
  "/api/team/status": async () => {
    const { paths } = await context();
    return { ok: true, ...(await teamLoginStatus({ paths })), made: await madeTeam() };
  },

  /**
   * Starts a browser login: to the hub (`kind: "hub"`, with `hub`), or to the servers
   * (with a server's `host`). A new state each time, with the id the page waits on
   * and the two addresses that sign the browser out of Access.
   */
  "/api/team/login": async (body, req) => {
    const { paths } = await context();
    const kind = body.kind === "servers" ? "servers" : "hub";
    const host = teamHost(kind === "hub" ? body.hub : body.host);
    if (!host) return { ok: false, error: kind === "hub" ? "팀 주소를 확인하세요." : "서버 주소를 확인하세요." };
    const started = await startLogin({ host, kind, redirectUri: redirectUri(req), paths });
    return { ok: true, url: started.url, id: started.id, logouts: started.logouts, kind, host };
  },

  /** After the hub login: who the hub says this is (and a peer name the first time). */
  "/api/team/me": async (body) => {
    const { config, paths } = await context();
    const me = await teamWhoami({ hub: body.hub, peer: config?.user?.peerId || "", paths });
    return { ok: true, ...me };
  },

  "/api/team/directory": async () => {
    const { paths } = await context();
    const directory = await hubCall("GET", "/api/team", undefined, { paths });
    await keepAdmin(directory, paths).catch(() => {});
    return { ok: true, ...directory };
  },

  /** Requests to and from this person, from the hub, with this server's own grants and computers. */
  "/api/team/requests": async () => {
    const { paths, gate } = await context();
    const requests = await hubCall("GET", "/api/requests", undefined, { paths });
    return { ok: true, ...requests, ...(await ownerView(gate)) };
  },

  "/api/team/request": async (body) => {
    const { paths } = await context();
    const kind = body.kind === "collect" ? "collect" : "chat";
    const answer = await hubCall("POST", "/api/requests", {
      kind,
      server: teamHost(body.server),
      device: computerName(),
      ...(kind === "collect" ? { folders: list(body.folders).map(String).slice(0, 50) } : {}),
    }, { paths });
    return { ok: true, request: answer.request || answer };
  },

  /**
   * The owner answers a request. An approval opens the server first (access.json),
   * then tells the hub, so the requester never sees "approved" before it works.
   */
  "/api/team/decide": async (body) => {
    const { paths, gate } = await context();
    const id = String(body.id || "");
    if (!/^r-[0-9a-f]{16}$/.test(id)) return { ok: false, error: "요청을 찾을 수 없습니다." };
    if (body.approve) {
      const email = String(body.email || "");
      const peer = String(body.peer || "");
      if (body.kind === "collect") {
        const config = await loadConfig().catch(() => null);
        await grantCollect(gate, { email, peer, workspace: config?.honcho?.workspaceId || "memory" });
      } else {
        const folders = folderList(body.folders);
        const sources = sourceList(body.sources);
        if (!folders.length && !sources.length) return { ok: false, error: NOTHING_CHOSEN };
        await grantChat(gate, { email, peer, folders, sources });
      }
    }
    const projects = body.approve && body.kind !== "collect" ? hubNames(folderList(body.folders), sourceList(body.sources)) : null;
    const answer = await hubCall("POST", `/api/requests/${id}/decide`, { approve: Boolean(body.approve), ...(projects ? { projects } : {}) }, { paths });
    return { ok: true, request: answer.request || answer };
  },

  "/api/team/cancel": async (body) => {
    const { paths } = await context();
    return { ok: true, ...(await hubCall("POST", `/api/requests/${encodeURIComponent(String(body.id || ""))}/cancel`, {}, { paths })) };
  },

  "/api/team/dismiss": async (body) => {
    const { paths } = await context();
    return { ok: true, ...(await hubCall("POST", `/api/requests/${encodeURIComponent(String(body.id || ""))}/dismiss`, {}, { paths })) };
  },

  /**
   * The folders this server holds conversations of, for the window that opens them
   * to a teammate (server-folders.mjs). A server that cannot be read says so
   * instead of listing nothing.
   */
  "/api/team/folders": async () => {
    const { config } = await context();
    try {
      return await serverFolders({ config });
    } catch (error) {
      const reason = error?.cause?.code || /^HTTP \d+/.exec(String(error?.message))?.[0] || String(error?.message || error);
      return { ok: false, error: `기억 서버에서 폴더를 읽지 못했습니다 (${reason}).` };
    }
  },

  /**
   * The owner changes what is open to a teammate (`folders`, `sources`), turns their
   * chat off for now or on again (`off`), or closes it (`close: true`).
   */
  "/api/team/grant": async (body) => {
    const { paths, gate } = await context();
    const email = String(body.email || "");
    const request = String(body.request || "");
    if (body.close) {
      await revokePerson(gate, { email, kind: "chat" });
      if (/^r-[0-9a-f]{16}$/.test(request)) await hubCall("POST", `/api/requests/${request}/revoke`, {}, { paths }).catch(() => null);
      return { ok: true, closed: true };
    }
    if (typeof body.off === "boolean") {
      try {
        await setChatOff(gate, { email, off: body.off });
      } catch (error) {
        if (error.code === "not_opened") return { ok: false, error: "이 팀원에게는 아직 내 기억이 열려 있지 않습니다. chat 요청을 승인하면 열립니다." };
        throw error;
      }
      return { ok: true, off: body.off };
    }
    const folders = folderList(body.folders);
    const sources = sourceList(body.sources);
    if (!folders.length && !sources.length) return { ok: false, error: `${NOTHING_CHOSEN} 모두 닫으려면 끊기를 누르세요.` };
    await grantChat(gate, { email, peer: String(body.peer || ""), folders, sources });
    if (/^r-[0-9a-f]{16}$/.test(request)) {
      await hubCall("POST", `/api/requests/${request}/projects`, { projects: hubNames(folders, sources) }, { paths }).catch(() => null);
    }
    return { ok: true, folders, sources };
  },

  /** The owner stops a teammate's computers collecting into this server. */
  "/api/team/stop-collect": async (body) => {
    const { paths, gate } = await context();
    await revokePerson(gate, { email: String(body.email || ""), kind: "collect" });
    const request = String(body.request || "");
    if (/^r-[0-9a-f]{16}$/.test(request)) await hubCall("POST", `/api/requests/${request}/revoke`, {}, { paths }).catch(() => null);
    return { ok: true };
  },

  /** The computers that write to this server, and cutting one off (`revoke: <id>`). */
  "/api/team/devices": async (body) => {
    const { gate } = await context();
    if (body.revoke) await revokeDevice(gate, { id: String(body.revoke) });
    return { ok: true, devices: await gateDevices(gate) };
  },

  /** This computer registers with a team server it writes to (its own on another computer, or one that approved it). */
  "/api/team/register": async (body) => {
    const { paths } = await context();
    const host = teamHost(body.host);
    if (!host) return { ok: false, error: "서버 주소를 확인하세요." };
    return registerDevice(host, { name: computerName(), paths });
  },

  "/api/team/server": async (body) => {
    const { paths } = await context();
    const host = teamHost(body.host);
    if (!host) return { ok: false, error: "서버 주소를 확인하세요." };
    return { ok: true, ...(await serverWhoami(host, { paths })) };
  },

  "/api/team/admin/people": async () => {
    const { paths } = await context();
    return { ok: true, ...(await hubCall("GET", "/api/admin/people", undefined, { paths })) };
  },

  "/api/team/admin/add": async (body) => {
    const { paths } = await context();
    return { ok: true, ...(await hubCall("POST", "/api/admin/people", { email: String(body.email || "") }, { paths })) };
  },

  "/api/team/admin/remove": async (body) => {
    const { paths } = await context();
    return { ok: true, ...(await hubCall("DELETE", `/api/admin/people/${encodeURIComponent(String(body.email || ""))}`, undefined, { paths })) };
  },

  /** Makes a teammate an admin (`admin: true`) or takes it away (`admin: false`). */
  "/api/team/admin/set-admin": async (body) => {
    const { paths } = await context();
    return { ok: true, ...(await hubCall("PUT", `/api/admin/people/${encodeURIComponent(String(body.email || ""))}`, { admin: body.admin }, { paths })) };
  },

  "/api/team/admin/rename": async (body) => {
    const { paths } = await context();
    return { ok: true, ...(await hubCall("PUT", "/api/admin/team", { name: String(body.name || "") }, { paths })) };
  },

  /** Whether the team's hub keeps a Jev key: set, when, by whom. Never the key. */
  "/api/team/admin/jev": async () => {
    const { paths } = await context();
    return { ok: true, jev: jevStatus(await hubCall("GET", "/api/admin/jev", undefined, { paths })) };
  },

  /** Sets or replaces the team's Jev key (`key`); it goes to the hub and is not kept here. */
  "/api/team/admin/jev/set": async (body) => {
    const { paths } = await context();
    const key = typeof body.key === "string" ? body.key.trim() : "";
    if (!key) return { ok: false, error: "Jev 키를 넣으세요." };
    return { ok: true, jev: jevStatus(await hubCall("PUT", "/api/admin/jev", { key }, { paths })) };
  },

  "/api/team/admin/jev/clear": async () => {
    const { paths } = await context();
    return { ok: true, jev: jevStatus(await hubCall("DELETE", "/api/admin/jev", undefined, { paths })) };
  },

  "/api/team/logout": async () => {
    const { paths } = await context();
    return signOut({ paths });
  },
};

/**
 * The page the browser shows when the login comes back here. It closes itself either
 * way, since the app says what happened; a failure stays a little longer, with why.
 */
function loginPage(ok, message) {
  const escape = (text) => String(text).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]);
  const title = ok ? "로그인됐습니다" : "로그인하지 못했습니다";
  const text = ok ? "이 창을 닫고 팀 메모리 앱으로 돌아가세요." : "이 창을 닫고 팀 메모리 앱에서 다시 로그인을 누르세요.";
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#faf8f4;color:#1d1c19;font-family:system-ui,-apple-system,"Noto Sans KR",sans-serif}
main{max-width:420px;padding:28px 32px;border:1px solid #e3dfd6;border-radius:14px;background:#fff}h1{margin:0 0 8px;font-size:20px}p{margin:0;color:#57534b;line-height:1.6}p.why{margin-top:10px;color:#8a857a;font-size:13px}</style></head>
<body><main><h1>${title}</h1><p>${text}</p>${ok || !message ? "" : `<p class="why">${escape(message)}</p>`}</main>
<script>setTimeout(() => window.close(), ${ok ? 1500 : 4000})</script></body></html>`;
}

/** GET /oauth/callback: finishes the login this app started (an unknown state does nothing). */
export async function handleLoginCallback(url, res) {
  const { paths } = await context();
  let ok = false;
  let message = "";
  try {
    await finishLogin({
      state: url.searchParams.get("state"),
      code: url.searchParams.get("code"),
      error: url.searchParams.get("error"),
      errorDescription: url.searchParams.get("error_description"),
      paths,
    });
    ok = true;
  } catch (error) {
    message = String(error?.message || error);
  }
  const html = loginPage(ok, message);
  res.writeHead(ok ? 200 : 400, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(html);
}

/** One /api/team/* route, or null when there is none of that name. */
export function teamRoute(pathname) {
  return ROUTES[pathname] || null;
}

/**
 * Runs a route; any failure comes back as { ok: false, error } with the hub's or
 * gate's own code, and for a login to do again, which one (`kind`, `host`).
 */
export async function runTeamRoute(route, body, req) {
  try {
    return await route(body, req);
  } catch (error) {
    return {
      ok: false,
      error: String(error?.message || error),
      ...(error?.code ? { code: error.code } : {}),
      ...(error?.status ? { status: error.status } : {}),
      ...(error?.kind ? { kind: error.kind } : {}),
      ...(error?.code === "login_needed" && error?.host ? { host: error.host } : {}),
    };
  }
}

