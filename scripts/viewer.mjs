// 컴퓨터 고르기: one window that shows this computer's app, or the whole app of the
// owner's server computer, by the computer chosen at the top of the menu.
//
// The server computer's gate opens /team-memory/app to an owner's registered computer
// (server/gate/gate.mjs) and passes it to the app running there. This computer's app
// listens once more, one port above its own, and sends every request that reaches
// that port to the gate with this computer's team login and device key. The browser
// sees one more loopback origin, and the page that comes back is the server
// computer's own, at its own version; only /api/viewer, which says which computers
// there are and which one the window shows, is answered here on both ports.
//
// A page shown on another computer cannot do everything there. The gate names the
// computer it came from (X-Team-Memory-Viewer), and the app refuses what would cut
// the way the page came for good, log the server computer in or out through a browser that
// comes back to this one, open a window on its screen, or send an upload past the
// gate's limit (HERE_ONLY).
import { execFile } from "node:child_process";
import http from "node:http";
import { promisify } from "node:util";

import { loadConfig } from "./config.mjs";
import { readTeamAuth, deviceHeaderValue, teamAuthPaths, teamFetch } from "./team-auth.mjs";
import { computerName } from "./team-hub.mjs";

const execFileAsync = promisify(execFile);

export const VIEWER_HEADER = "x-team-memory-viewer";
export const APP_PREFIX = "/team-memory/app";
// What the gate takes in one body; a larger one would be cut off there.
const MAX_BODY_BYTES = 20 * 1024 * 1024;
// A dialectic answer can stream for minutes; Cloudflare ends a request that waits
// longer than about 100 s for its first byte on its own.
const REQUEST_TIMEOUT_MS = 15 * 60_000;
// How long what the server computer said about itself is kept.
const PROBE_TTL_MS = 30_000;
const PROBE_TIMEOUT_MS = 6_000;

/**
 * What an app does only for a page on its own computer, by path (all POST). Each
 * would cut the way a page on another computer came for good (stopping the server,
 * turning sharing off: neither comes back from afar; 다시 시작 does), send a login's browser back to the wrong
 * computer, open a window on this computer's screen, or upload past the gate.
 */
export const HERE_ONLY = new Map([
  ["/api/server/stop", "기억 서버를 멈추면 이 화면으로 오는 길도 같이 끊깁니다."],
  ["/api/server/share/disable", "공유를 끄면 이 화면으로 오는 길도 같이 끊깁니다."],
  ["/api/team/login", "로그인 창이 이 컴퓨터로 돌아오지 않습니다."],
  ["/api/team/logout", "그 컴퓨터의 팀 로그인을 끊으면 이 화면도 쓸 수 없습니다."],
  ["/api/gateway/open", "그 창은 그 컴퓨터의 화면에 뜹니다."],
  ["/api/past/chatgpt", "큰 파일은 그 컴퓨터에서 올리세요."],
]);

/** The page's computer when another computer shows it, or null on its own computer. */
export function viewerOf(req) {
  const value = req.headers[VIEWER_HEADER];
  if (typeof value !== "string" || !value) return null;
  try {
    return decodeURIComponent(value).slice(0, 64);
  } catch {
    return null;
  }
}

/** The gate's id of the computer showing this page, so the page does not cut that one off. */
export function viewerDeviceOf(req) {
  const value = req.headers[`${VIEWER_HEADER}-device`];
  return viewerOf(req) && typeof value === "string" && /^d-[0-9a-f]{16}$/.test(value) ? value : null;
}

/** Why the app does not do this for a page shown on another computer, or null. */
export function hereOnly(req, pathname) {
  if (!viewerOf(req) || req.method !== "POST") return null;
  const why = HERE_ONLY.get(pathname);
  return why ? { status: 403, body: { ok: false, hereOnly: true, error: `이 일은 그 컴퓨터 앞에서 하세요. ${why}` } } : null;
}

/**
 * A computer's name without whose it is ("chenjing의 MacBook Pro", "Ana's iMac"):
 * every computer in the list is the owner's, and the box at the menu's foot is narrow.
 */
export function shortName(name) {
  const text = String(name || "").trim();
  const short = text.replace(/^[^\s]{1,32}(?:의|['’]s)\s+/u, "").trim();
  return short || text;
}

let named = null;
/** This computer's name as its owner calls it, short: macOS's own name, else the host name. */
export function displayName({ platform = process.platform, run = execFileAsync } = {}) {
  if (!named) {
    named = (platform === "darwin"
      ? run("/usr/sbin/scutil", ["--get", "ComputerName"], { timeout: 2_000 }).then(({ stdout }) => String(stdout).trim())
      : Promise.resolve(""))
      .catch(() => "")
      .then((name) => shortName(name && name.length <= 64 && !/[\p{C}]/u.test(name) ? name : computerName()));
  }
  return named;
}

/**
 * The owner's server computer this computer shows, or null: the https memory server
 * it sends to, when it holds a device key there. A computer that runs its own server
 * shows only itself.
 */
export async function serverOrigin({ config, paths } = {}) {
  const loaded = config === undefined ? await loadConfig().catch(() => null) : config;
  let target;
  try { target = new URL(loaded?.honcho?.baseUrl || ""); } catch { return null; }
  if (target.protocol !== "https:") return null;
  const auth = await readTeamAuth(paths || teamAuthPaths(loaded)).catch(() => null);
  return auth && deviceHeaderValue(auth, target.hostname) ? target.origin : null;
}

/** Where this computer's team login is kept: the paths given, else the configured ones. */
async function authPaths(paths) {
  return paths || teamAuthPaths(await loadConfig().catch(() => null));
}

const probes = new Map();

/**
 * What the server computer's app says about itself through the gate: its name, or
 * why it cannot be shown. `reason` is one of login (log in to the team again),
 * owner (this login is not the server's owner, or this computer is not registered
 * there), old (its gate has no /team-memory/app yet), off (its app is not running)
 * and unreachable.
 */
export async function probeServer(origin, { fetchImpl, paths, now = Date.now() } = {}) {
  const kept = probes.get(origin);
  if (kept && now - kept.at < PROBE_TTL_MS) return kept.value;
  let value;
  try {
    paths = await authPaths(paths);
    const response = await teamFetch(`${origin}${APP_PREFIX}/api/app/context`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    }, { paths, ...(fetchImpl ? { fetchImpl } : {}) });
    const body = await response.json().catch(() => null);
    if (response.ok && body && body.ok !== false) {
      value = { ok: true, name: shortName(body.computer || body.team?.computer || new URL(origin).hostname), version: body.version || null };
    } else {
      const reason = response.status === 403 ? "owner" : response.status === 404 ? "old" : response.status === 502 ? "off" : "unreachable";
      value = { ok: false, reason };
    }
  } catch (error) {
    value = { ok: false, reason: error?.code === "login_needed" || error?.code === "login_failed" ? "login" : "unreachable" };
  }
  probes.set(origin, { at: now, value });
  return value;
}

/** Forget what the server computer said, so the next look asks again. */
export function forgetProbes() {
  probes.clear();
}

/**
 * /api/viewer: the owner's computers this window can show, and which it shows now.
 * `viewing` is "here" on this computer's own port and "server" on the viewer's.
 */
export async function viewerInfo({ viewing = "here", homeUrl, viewUrl, origin, fetchImpl, paths, fresh = false } = {}) {
  if (fresh) forgetProbes();
  const here = { id: "here", name: await displayName(), here: true, url: homeUrl, ok: true };
  if (!origin) return { current: "here", computers: [here] };
  const probe = await probeServer(origin, { fetchImpl, paths });
  const server = {
    id: "server",
    name: probe.name || new URL(origin).hostname,
    host: new URL(origin).hostname,
    url: viewUrl || null,
    ok: Boolean(probe.ok && viewUrl),
    reason: viewUrl ? probe.reason || null : "port",
    version: probe.version || null,
  };
  return { current: viewing, computers: [here, server] };
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error("이 요청은 다른 컴퓨터로 보내기에 너무 큽니다."), { status: 413 });
    chunks.push(chunk);
  }
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

const REASONS = {
  login: "팀 로그인이 끝났습니다. 이 컴퓨터의 팀 화면에서 다시 로그인하세요.",
  owner: "이 컴퓨터가 그 서버에 주인 컴퓨터로 등록되어 있지 않습니다.",
  old: "그 컴퓨터의 팀 메모리가 이 기능보다 옛 판입니다. 그 컴퓨터를 업데이트하세요.",
  off: "그 컴퓨터의 팀 메모리 앱이 꺼져 있습니다. 그 컴퓨터에서 앱을 여세요.",
  unreachable: "그 컴퓨터가 잠자거나 꺼져 있거나, 서버의 공유가 꺼져 있습니다.",
};
export const reasonText = (reason) => REASONS[reason] || REASONS.unreachable;

/**
 * The page in place of the server computer's when it cannot be reached: this
 * computer's look (its stylesheet, from its own port), the server computer's name,
 * why, and the ways on: try again, or back to this computer.
 */
export function unreachablePage({ name, reason, homeUrl, here }) {
  const back = `${homeUrl}#/dashboard`;
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark"><title>팀 메모리</title><link rel="stylesheet" href="${escapeHtml(homeUrl)}styles.css"></head>
<body><div class="shell"><aside class="rail"><div class="mark"><img class="logo" src="${escapeHtml(homeUrl)}logo.svg" alt=""><strong>팀 메모리</strong></div>
<div class="rail-foot"><div class="machine away"><a class="machine-btn" href="${escapeHtml(back)}"><span class="glyph">${GLYPH}</span><span><b>${escapeHtml(name)}</b><small>닿지 않음</small></span></a></div></div></aside>
<div class="main away"><div class="away-strip"><span><b>${escapeHtml(name)}</b>에 닿지 않습니다.</span><a class="btn small" href="${escapeHtml(back)}">돌아가기</a></div>
<main class="view"><div class="away-gate"><div class="gate-card"><span class="gate-mark">${GLYPH}</span><div>
<b>${escapeHtml(name)}에 닿지 않습니다</b><p>${escapeHtml(reasonText(reason))}</p>
<div class="away-actions"><a class="btn primary small" href="" onclick="location.reload();return false">다시 시도</a><a class="btn small" href="${escapeHtml(back)}">${escapeHtml(here)} 화면으로</a></div>
</div></div></div></main></div></div></body></html>`;
}

const GLYPH = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" class="icon" aria-hidden="true"><rect x="2.5" y="2.5" width="11" height="8" rx="1"/><path d="M6 13.5h4M8 10.5v3"/></svg>';

// What goes on from the browser, and what comes back from the server computer.
// Node's fetch has already undone any compression, so length and encoding go.
const SENT_HEADERS = ["accept", "content-type", "last-event-id", "if-none-match", "if-modified-since"];
const RETURNED_HEADERS = ["content-type", "cache-control", "etag", "last-modified"];

/**
 * The viewer's listener: every request to the server computer's app, through its
 * gate, after the same checks this computer's own app makes (`reject`).
 */
export function createViewServer({ reject, homeUrl, viewUrl, fetchImpl, paths, origin: fixedOrigin } = {}) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://viewer");
    if (!url.pathname.startsWith("/api/") && req.method !== "GET" && req.method !== "HEAD") {
      return sendJson(res, 405, { error: "Method not allowed" });
    }
    const rejection = reject?.(req);
    if (rejection) return sendJson(res, rejection.status, { error: rejection.error });
    const login = await authPaths(paths);
    const origin = fixedOrigin === undefined ? await serverOrigin({ paths: login }) : fixedOrigin;
    if (url.pathname === "/api/viewer" && req.method === "GET") {
      return sendJson(res, 200, await viewerInfo({ viewing: "server", homeUrl, viewUrl, origin, fetchImpl, paths: login, fresh: url.searchParams.has("fresh") }));
    }
    const page = !url.pathname.startsWith("/api/");
    const here = await displayName();
    const fail = async (reason) => {
      if (page && req.method === "GET") {
        const probe = origin ? await probeServer(origin, { fetchImpl, paths: login }).catch(() => ({})) : {};
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        return res.end(unreachablePage({ name: probe.name || (origin ? new URL(origin).hostname : "서버 컴퓨터"), reason, homeUrl, here }));
      }
      return sendJson(res, 502, { ok: false, unreachable: true, reason, error: reasonText(reason) });
    };
    if (!origin) return fail("owner");

    let body;
    try {
      body = ["GET", "HEAD"].includes(req.method) ? undefined : await readBody(req);
    } catch (error) {
      return sendJson(res, error.status || 400, { ok: false, error: error.message });
    }
    const headers = {};
    for (const name of SENT_HEADERS) if (req.headers[name]) headers[name] = req.headers[name];
    const stop = new AbortController();
    res.on("close", () => { if (!res.writableFinished) stop.abort(); });
    let upstream;
    try {
      upstream = await teamFetch(`${origin}${APP_PREFIX}${url.pathname}${url.search}`, {
        method: req.method,
        headers,
        body,
        signal: AbortSignal.any([stop.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      }, { paths: login, ...(fetchImpl ? { fetchImpl } : {}) });
    } catch (error) {
      forgetProbes();
      return fail(error?.code === "login_needed" || error?.code === "login_failed" ? "login" : "unreachable");
    }
    // The gate's own refusals, not the app's answers: why the computer cannot be shown.
    if (upstream.status === 403 || upstream.status === 404 || upstream.status === 502) {
      const gateSaid = await upstream.clone().json().catch(() => null);
      const reason = { 403: "owner", 404: "old", 502: "off" }[upstream.status];
      if (gateSaid?.error && ["forbidden", "not_found", "upstream_unavailable"].includes(gateSaid.error)) {
        await upstream.arrayBuffer().catch(() => {});
        forgetProbes();
        return fail(reason);
      }
    }
    const answer = { "cache-control": upstream.headers.get("cache-control") || "no-store" };
    for (const name of RETURNED_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) answer[name] = value;
    }
    res.writeHead(upstream.status, answer);
    res.flushHeaders();
    try {
      if (upstream.body && req.method !== "HEAD") for await (const chunk of upstream.body) res.write(chunk);
    } catch {
      res.destroy();
      return;
    }
    res.end();
  });
}
