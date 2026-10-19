// 업데이트: the app learns that a new version is out, and one button brings this
// computer up to it.
//
// Once a day the app reads what GitHub's main holds (MAIN_FILES): the version in
// plugin.json, the Honcho and gateway pins, and the two files the server's
// containers run as they are. A version above the lowest of the app, the two
// plugins and the collector here is newer. The rows say what the button would bring
// up, the server's only when the server here is not what that version runs, by the
// same three things doctor's server-version check compares; nothing is updated on
// its own, since rebuilding the server stops teammates' reading for a while.
//
// The button runs three processes one after another, each detached so it outlives
// the one that started it, each writing how far it got to update.json in the app's
// folder, which every copy of the app reads:
//   update start     the app's own copy: reads main again, refuses while a long job runs
//                    or when main's version or the warning is not what the bell showed,
//                    writes the rows
//   update run       the same copy: updates the plugin of Claude Code (else Codex), then
//                    starts the new plugin folder's, whose version the rest goes up to
//   update continue  doctor and fix.mjs there for the collector, the server and the app,
//                    which restarts the app from that folder (with Codex only, the app
//                    first); then the Codex plugin, last, since Codex keeps only its
//                    newest folder and the app may run from one
// A step that fails stops there with its reason, and `update retry` starts again at
// it; a subscription login that ended puts a login row before the server's.
//
// doctor --fix, the app's 고치기, writes its rows to fix.json the same way: the app it
// restarts is not the one that asked, and reads how it ended from there.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defaultAppHome, installPaths, loadConfig, readJson, userHome } from "./config.mjs";
import { acquireFileLock, releaseFileLock } from "./file-lock.mjs";
import { fixable, KEPT_OFF, toVersion } from "./fix.mjs";
import { gatewayDirectory, gatewaySourceProbe } from "./gateway.mjs";
import { DEFAULT_SOURCE, hostCli, PLUGIN_INSTALL_TIMEOUT_MS, PLUGIN_NAME } from "./host-plugins.mjs";
import { sanitizeUrlsInText } from "./redact.mjs";
import { rederivePaths } from "./rederive.mjs";
import { honchoSourcePin, installedServerDir, serverStatus } from "./server-manager.mjs";
import { CLIENT_NAMES, clientFailure, runClient } from "./team-access.mjs";
import { hubBehind } from "./team-hub.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Where main is read from, and a loopback address in its place for tests.
const MAIN_URL = `https://raw.githubusercontent.com/${DEFAULT_SOURCE}/main/`;
export const UPDATE_BASE_ENV = "HONCHO_AGENT_BRIDGE_UPDATE_BASE";
// What is read from main, by the name it is kept under here. Only plugin.json has to
// be there: a version that moved one of the others is still noticed.
const MAIN_FILES = Object.freeze({
  "plugin.json": ".claude-plugin/plugin.json",
  "honcho-source.json": "server/honcho-source.json",
  "gateway-source.json": "server/gateway-source.json",
  "compose.yaml": "server/compose.yaml",
  "gate/gate.mjs": "server/gate/gate.mjs",
});
// The bundle's files the server's containers run as they are (staleServerFiles in
// server-manager.mjs). Compared with line ends evened out: a Windows checkout of the
// plugin may have turned them into CRLF, and main never has.
const RUNNING_FILES = ["compose.yaml", "gate/gate.mjs"];
const FETCH_TIMEOUT_MS = 15_000;
const MAX_FILE_BYTES = 1024 * 1024;
const DAY_MS = 24 * 60 * 60_000;
// After a check that failed (no network, GitHub down) the next one is sooner.
const RETRY_MS = 60 * 60_000;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const MARKETPLACE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;
const LOCK = { attempts: 50, delayMs: 100, staleMs: 120_000, reclaimDeadImmediately: true };

// What the rows are called, as the app shows them; the server's says whether it runs.
const TITLES = Object.freeze({
  claude: "Claude Code 플러그인",
  codex: "Codex 플러그인",
  runtime: "대화 수집",
  app: "앱 다시 켜기",
});
const SERVER_ROWS = Object.freeze({
  running: { title: "기억 서버 다시 만들기", sub: "몇 분에서 10분 넘게 걸립니다." },
  stopped: { title: "기억 서버 준비", sub: "꺼 둔 서버는 켜지 않습니다." },
});
// Before the server's line, when the version's gateway pin moved: the row is the
// memory server's, and the subscription gateway beside it goes up with it.
const GATEWAY_TOO = "게이트웨이도 새 판으로 바꿉니다.";
const LOGIN_ROW = Object.freeze({ title: "구독 계정 로그인", sub: "브라우저에서 로그인을 마치세요." });
// A server kept off, said where 서버 켜기 is beside it (the end's 점검 row, or its
// to-do), as fix.mjs's KEPT_OFF tells a terminal where 시작 is.
const KEPT_OFF_HERE = "꺼 둔 기억 서버는 새 판으로 준비만 했습니다. 켜려면 서버 켜기를 누르세요.";
const inApp = (said) => said.replace(KEPT_OFF, KEPT_OFF_HERE);

/** What doctor --fix answered, in the app's words, for the 고치기 beside 점검's rows. */
export function fixAnswerInApp(answer) {
  return typeof answer?.said === "string" ? { ...answer, said: inApp(answer.said) } : answer;
}
// The doctor checks fix.mjs repairs, by the row each one is.
const FIX_ROWS = Object.freeze({ runtime: "runtime", "server-version": "server", app: "app" });

const WARNING = "기억 서버를 새 판으로 다시 켜는 동안 잠깐 팀원 열람이 멈춥니다.";
const STALLED = "중간에 멈췄습니다.";
const SESSIONS = "열린 창은 닫고 새로 여세요.";
const BLOCKED = Object.freeze({
  fixing: "고치기가 도는 중입니다. 끝난 뒤 업데이트를 누르세요.",
  "no-plugin": "Claude Code나 Codex에 팀 메모리 플러그인을 설치한 뒤 업데이트를 누르세요.",
});
// A long job that making the server again would cut (longJob): the update waits for
// it, and so does a 고치기 that would make the server again (recordFix), whose words
// name the app's button, as fix.mjs's name its screens. A rebuild of the memory whose
// process stopped (the computer restarted, say) goes on when 서버 → 기억 서버 asks how
// it goes (rederive status), and holds both up till then.
const LONG_JOBS = Object.freeze({
  past: {
    update: "지난 대화를 쌓는 중입니다. 다 쌓은 뒤 업데이트를 누르세요.",
    fix: "지난 대화를 쌓는 중입니다. 다 쌓은 뒤 고치기를 다시 누르세요.",
  },
  rederive: {
    update: "기억을 다시 정리하는 중입니다. 다 끝난 뒤 업데이트를 누르세요.",
    fix: "기억을 다시 정리하는 중입니다. 다 끝난 뒤 고치기를 다시 누르세요.",
  },
  stopped: {
    update: "기억 다시 정리가 멈춰 있습니다. 서버 → 기억 서버를 열면 이어서 정리합니다. 다 끝난 뒤 업데이트를 누르세요.",
    fix: "기억 다시 정리가 멈춰 있습니다. 서버 → 기억 서버를 열면 이어서 정리합니다. 다 끝난 뒤 고치기를 다시 누르세요.",
  },
});
const UPDATING = "팀 메모리 앱에서 업데이트가 도는 중입니다. 업데이트가 끝나기를 기다리세요.";
const FIXING = "고치기가 이미 도는 중입니다. 끝나기를 기다리세요.";
const STARTING = "업데이트나 고치기를 시작하는 중입니다. 끝나기를 기다리세요.";
// What start says when the bell showed something else: main's version, or at the same
// version whether teammates' reading stops (the server came on, or went off or was
// brought up to that version, in between).
const CHANGED = "새 판이 바뀌었습니다. 바뀐 내용을 보고 업데이트를 다시 누르세요.";
const WARNED = "그사이 기억 서버가 켜져, 새 판으로 다시 켜는 동안 잠깐 팀원 열람이 멈춥니다. 보고 업데이트를 다시 누르세요.";
const UNWARNED = "그사이 기억 서버가 바뀌어, 팀원 열람은 멈추지 않습니다. 보고 업데이트를 다시 누르세요.";
const UNREAD = "GitHub에서 새 판을 읽지 못했습니다. 인터넷 연결을 확인하고 업데이트를 다시 누르세요.";

// What is written to update.json and fix.json, which the app shows: addresses in a
// reason lose what is secret in them, as the CLI's own output does.
const clean = (text) => sanitizeUrlsInText(String(text));

export function updatePaths(appHome = defaultAppHome()) {
  const dir = path.join(appHome, "update");
  return {
    dir,
    // What main held at the last check that worked.
    main: path.join(dir, "main"),
    check: path.join(dir, "check.json"),
    update: path.join(dir, "update.json"),
    fix: path.join(dir, "fix.json"),
    lock: path.join(dir, "update.lock"),
  };
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/** Starts `cli` with `args` in a process of its own, which outlives this one: its pid, or null. */
function spawnCli(cli, args, { cwd, env }) {
  try {
    const child = spawn(process.execPath, [cli, ...args], { cwd, env, detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => {});
    child.unref();
    return child.pid || null;
  } catch {
    return null;
  }
}

/**
 * What every step reads from, each part replaceable for tests: `fetchImpl` (main),
 * `now`, `spawn`, `alive`, `clientRunner` (the hosts' CLIs), `serverStatus`,
 * `hubBehind`, `longJob`, and from cli.mjs `doctor` and `fix(checks, onStep)`.
 */
function context(options = {}) {
  return {
    paths: updatePaths(options.appHome),
    home: options.home || userHome(),
    env: options.env || process.env,
    platform: options.platform || process.platform,
    now: options.now || Date.now,
    fetchImpl: options.fetchImpl || globalThis.fetch,
    spawn: options.spawn || spawnCli,
    alive: options.alive || alive,
    clientRunner: options.clientRunner || null,
    serverStatus: options.serverStatus || serverStatus,
    hubBehind: options.hubBehind || hubBehind,
    longJob: options.longJob || longJob,
    config: options.config !== undefined ? async () => options.config : () => loadConfig().catch(() => null),
    scriptDir: options.scriptDir || HERE,
    appVersion: options.appVersion || null,
    doctor: options.doctor,
    fix: options.fix,
  };
}

const iso = (time) => new Date(time).toISOString();

async function exists(target) {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

async function writeAtomic(filePath, text) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  try {
    await fsp.writeFile(temporary, text, { mode: 0o600 });
    await fsp.rename(temporary, filePath);
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

const writeJson = (filePath, value) => writeAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
const readText = (filePath) => fsp.readFile(filePath, "utf8").catch(() => null);

async function withLock(ctx, callback) {
  const lock = await acquireFileLock(ctx.paths.lock, LOCK);
  if (!lock) return { ok: false, code: "busy", error: "업데이트를 시작하는 중입니다." };
  try {
    return await callback();
  } finally {
    await releaseFileLock(lock);
  }
}

// ------------------------------------------------------------------ versions

/** -1, 0 or 1 as `a` is below, at or above `b`; what is not x.y.z is below every version. */
export function compareVersions(a, b) {
  const parts = (value) => (VERSION_PATTERN.test(String(value)) ? String(value).split(".").map(Number) : null);
  const [x, y] = [parts(a), parts(b)];
  if (!x || !y) return x ? 1 : y ? -1 : 0;
  for (let index = 0; index < 3; index += 1) if (x[index] !== y[index]) return x[index] < y[index] ? -1 : 1;
  return 0;
}

/** The VERSION a copy's version.mjs holds (a plugin's scripts/, the installed collector), or "". */
export async function scriptVersion(directory) {
  const source = await readText(path.join(directory, "version.mjs"));
  return source?.match(/VERSION\s*=\s*["']([^"']+)["']/)?.[1] || "";
}

/** The Claude Code plugin here, { version, folder, marketplace, scope }, from installed_plugins.json; null without it. */
export async function claudePlugin(home) {
  const document = await readJson(path.join(home, ".claude", "plugins", "installed_plugins.json"), null);
  for (const [id, value] of Object.entries(document?.plugins || {})) {
    if (!id.startsWith(`${PLUGIN_NAME}@`)) continue;
    const marketplace = id.slice(PLUGIN_NAME.length + 1);
    if (!MARKETPLACE_NAME.test(marketplace)) continue;
    const entries = (Array.isArray(value) ? value : [value]).filter((entry) => typeof entry?.installPath === "string" && entry.installPath);
    // Setup installs it for the user; one for a project only is taken when there is no other.
    const entry = entries.find((item) => item.scope === "user") || entries[0];
    if (!entry) continue;
    const folder = path.resolve(entry.installPath);
    const version = (await scriptVersion(path.join(folder, "scripts"))) || (typeof entry.version === "string" ? entry.version : "");
    return { version: version || null, folder, marketplace, scope: entry.scope === "user" ? "user" : null };
  }
  return null;
}

/** The Codex plugin here, { version, folder, marketplace }: its table in config.toml and the one folder Codex keeps of it. */
export async function codexPlugin(home) {
  const text = await readText(path.join(home, ".codex", "config.toml"));
  const header = String(text || "").match(new RegExp(`^\\s*\\[plugins\\."${PLUGIN_NAME}@([A-Za-z0-9_][A-Za-z0-9._-]{0,99})"\\]\\s*$`, "m"));
  if (!header) return null;
  const marketplace = header[1];
  const base = path.join(home, ".codex", "plugins", "cache", marketplace, PLUGIN_NAME);
  const names = (await fsp.readdir(base).catch(() => [])).filter((name) => VERSION_PATTERN.test(name)).sort(compareVersions);
  const folder = names.length ? path.join(base, names.at(-1)) : null;
  const version = folder ? (await scriptVersion(path.join(folder, "scripts"))) || names.at(-1) : null;
  return { version, folder, marketplace };
}

const pluginOf = (ctx, host) => (host === "claude" ? claudePlugin(ctx.home) : codexPlugin(ctx.home));

/** What runs here: the app answering (its version), the two plugins, and the collector once set up. */
async function hereVersions(ctx, config) {
  const [claude, codex, runtime] = await Promise.all([
    claudePlugin(ctx.home),
    codexPlugin(ctx.home),
    config ? scriptVersion(installPaths(config).runtimeDir) : "",
  ]);
  return { app: ctx.appVersion, claude, codex, runtime: runtime || null };
}

// ------------------------------------------------------------------ main

function mainUrl(env) {
  const value = String(env[UPDATE_BASE_ENV] || "").trim();
  try {
    if (value && ["127.0.0.1", "localhost", "[::1]"].includes(new URL(value).hostname)) return value.endsWith("/") ? value : `${value}/`;
  } catch {}
  return MAIN_URL;
}

async function fetchText(ctx, url) {
  const response = await ctx.fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  const text = await response.text();
  if (text.length > MAX_FILE_BYTES) throw new Error(`${url} is larger than ${MAX_FILE_BYTES} bytes`);
  return text;
}

/** Reads main and keeps what it read in paths.main: its version, or a thrown reason. */
async function readMain(ctx) {
  const base = mainUrl(ctx.env);
  const files = Object.fromEntries(await Promise.all(Object.entries(MAIN_FILES).map(async ([name, remote]) => [name, await fetchText(ctx, new URL(remote, base).href)])));
  let version = "";
  try { version = String(JSON.parse(files["plugin.json"] || "")?.version || ""); } catch {}
  if (!VERSION_PATTERN.test(version)) throw new Error("plugin.json on main names no version");
  for (const [name, text] of Object.entries(files)) {
    const target = path.join(ctx.paths.main, ...name.split("/"));
    if (text === null) await fsp.rm(target, { force: true });
    else await writeAtomic(target, text);
  }
  return version;
}

/**
 * main's version: { version, checkedAt, nextAt }, read again a day after the last
 * check, an hour after one that failed, or at once with `force`. A check that failed
 * keeps the last version found and says why in `error`.
 */
export async function latestVersion(options = {}) {
  const ctx = context(options);
  const saved = await readJson(ctx.paths.check, null);
  const now = ctx.now();
  const next = Date.parse(saved?.nextAt || "");
  // A next check over a day away is a clock that went back.
  if (options.force !== true && Number.isFinite(next) && now < next && next - now <= DAY_MS) return saved;
  let check;
  try {
    check = { version: await readMain(ctx), checkedAt: iso(now), nextAt: iso(now + DAY_MS) };
  } catch (error) {
    check = {
      version: saved?.version || null,
      checkedAt: saved?.checkedAt || null,
      failedAt: iso(now),
      error: String(error?.message || error).split(/\r?\n/)[0],
      nextAt: iso(now + RETRY_MS),
    };
  }
  await writeJson(ctx.paths.check, check).catch(() => {});
  return check;
}

// ------------------------------------------------------------------ the plan

const NO_GIT = async () => ({ stdout: "", stderr: "" });
const evenLines = (text) => text.replace(/\r\n/g, "\n");

/**
 * Whether main's version rebuilds the memory server here, by what doctor's
 * server-version check compares: the Honcho pin, the gateway's pin, and the files the
 * containers run. { rebuild, running, gateway }, or null on a computer with no server;
 * `running` is asked only for a rebuild, and is null otherwise.
 */
async function serverChange(ctx, config) {
  const serverDir = installedServerDir(config);
  if (!(await exists(path.join(serverDir, "compose.yaml")))) return null;
  const main = ctx.paths.main;
  const [installed, wanted] = await Promise.all([honchoSourcePin(serverDir), honchoSourcePin(main)]);
  const honcho = wanted.ok && !(installed.ok && installed.commit === wanted.commit);
  const gateway = await gatewaySourceProbe({ pinDirectory: main, directory: gatewayDirectory(serverDir), runner: NO_GIT }).catch(() => null);
  let files = false;
  for (const name of RUNNING_FILES) {
    const [want, have] = await Promise.all([readText(path.join(main, ...name.split("/"))), readText(path.join(serverDir, ...name.split("/")))]);
    if (want !== null && (have === null || evenLines(want) !== evenLines(have))) files = true;
  }
  const moved = Boolean(gateway?.present && gateway.state === "stale");
  const rebuild = honcho || moved || files;
  if (!rebuild) return { rebuild: false, running: null, gateway: false };
  const status = await ctx.serverStatus({ profile: "personal" }).catch(() => null);
  return { rebuild: true, running: Boolean(status?.running), gateway: moved };
}

/** A row as the app shows it; the server's by whether it runs, and with the gateway when it moves too. */
function row(id, running = true, gateway = false) {
  if (id === "server") {
    const { title, sub } = running === false ? SERVER_ROWS.stopped : SERVER_ROWS.running;
    return gateway ? { id, title, sub: `${GATEWAY_TOO} ${sub}`, gateway: true } : { id, title, sub };
  }
  if (id === "login") return { id, ...LOGIN_ROW };
  return { id, title: TITLES[id] };
}

/**
 * The order the rows run in: the plugin the rest runs from first, the Codex plugin
 * last. With Codex only, the app goes up right after it: the plugin update took away
 * the folder the app ran from, and the app's pages with it.
 */
function sortRows(progress) {
  const order = progress.host === "codex"
    ? ["codex", "app", "runtime", "login", "server"]
    : ["claude", "runtime", "login", "server", "app", "codex"];
  progress.rows.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
}

/** 받침 picks the particle: 플러그인과, 대화 수집과; 기억 서버를, 플러그인을. */
function particle(word, withFinal, without) {
  const code = word.charCodeAt(word.length - 1) - 0xac00;
  return code >= 0 && code < 11172 && code % 28 ? withFinal : without;
}

function listOf(names) {
  const object = (word) => `${word}${particle(word, "을", "를")}`;
  if (names.length === 1) return object(names[0]);
  const [first, ...rest] = names;
  return `${first}${particle(first, "과", "와")} ${[...rest.slice(0, -1), object(rest.at(-1))].join(", ")}`;
}

/** "플러그인과 대화 수집, 기억 서버를 올립니다.": what the button brings up, or null for nothing. */
function summaryOf(rows) {
  const has = (...ids) => rows.some((item) => ids.includes(item.id));
  const names = [
    ...(has("claude", "codex") ? ["플러그인"] : []),
    ...(has("runtime") ? ["대화 수집"] : []),
    ...(has("server") ? ["기억 서버"] : []),
  ];
  if (names.length) return `${listOf(names)} 올립니다.`;
  return has("app") ? "앱을 새 판으로 다시 켭니다." : null;
}

/**
 * 지난 대화 쌓기 or 기억 다시 정리 going now, from their status files only (as
 * rederive.mjs reads them): { code, update, fix }, its words (LONG_JOBS), or null. A
 * rebuild of the memory is going until it ends or stops with an error, whether or not
 * its process runs: the app carries one on whose process stopped, and the words say where.
 */
async function longJob(ctx, config) {
  const paths = rederivePaths(config);
  const [past, rederive] = await Promise.all([readJson(paths.pastStatus, null), readJson(paths.status, null)]);
  if (past?.running && ctx.alive(Number(past.running.pid))) return { code: "past", ...LONG_JOBS.past };
  if (rederive?.job && !rederive.job.error) {
    return { code: "rederive", ...(ctx.alive(Number(rederive.job.pid)) ? LONG_JOBS.rederive : LONG_JOBS.stopped) };
  }
  return null;
}

const runningIn = (ctx, progress) => progress?.state === "running" && ctx.alive(progress.pid);

/** Why the button cannot be pressed now, or null; `here` without a plugin in either host is one reason. */
async function blockedNow(ctx, config, here = null) {
  const reason = (code) => ({ code, reason: BLOCKED[code] });
  if (runningIn(ctx, await readJson(ctx.paths.fix, null))) return reason("fixing");
  const job = await ctx.longJob(ctx, config);
  if (job) return { code: job.code, reason: job.update };
  if (here && !here.claude && !here.codex) return reason("no-plugin");
  return null;
}

/** Everything the status and the start read: main's version, what runs here, and what the button would do. */
async function assess(ctx, options) {
  const config = await ctx.config();
  const [check, here, current] = await Promise.all([
    latestVersion({ ...options, force: options.force === true }),
    hereVersions(ctx, config),
    readJson(ctx.paths.update, null),
  ]);
  const latest = check?.version || null;
  const behind = (version) => compareVersions(version, latest) < 0;
  const present = [here.app, here.claude?.version, here.codex?.version, here.runtime].filter(Boolean);
  const newer = Boolean(latest) && present.some(behind);
  const going = runningIn(ctx, current);
  // A rebuild that is going is not asked about again (docker, every few seconds).
  const server = newer && !going ? await serverChange(ctx, config) : null;
  const progress = { host: here.claude ? "claude" : "codex", rows: [] };
  if (newer) {
    // A plugin whose version cannot be read is brought up too.
    if (here.claude && (!here.claude.version || behind(here.claude.version))) progress.rows.push(row("claude"));
    if (here.codex && (!here.codex.version || behind(here.codex.version))) progress.rows.push(row("codex"));
    if (here.runtime && behind(here.runtime)) progress.rows.push(row("runtime"));
    if (server?.rebuild) progress.rows.push(row("server", server.running, server.gateway));
    if (here.app && behind(here.app)) progress.rows.push(row("app"));
    sortRows(progress);
  }
  return {
    check,
    latest,
    here,
    newer,
    server,
    host: progress.host,
    rows: progress.rows,
    lowest: [...present].sort(compareVersions)[0] || null,
    blocked: newer ? await blockedNow(ctx, config, here) : null,
    going,
  };
}

// ------------------------------------------------------------------ progress
//
// update.json and fix.json: { version: 1, kind, state, rows, todo, ... }, state
// running, login, failed or done, each row's state wait, run, ok, bad or login. The
// next version's copy reads what this one wrote, so the shape changes only with a
// new `version`.

/** A progress without what only the steps read: the process, the plugin folder, the host. */
function shown({ pid, folder, host, ...view }) {
  return view;
}

/** The progress as the app shows it: a run whose process is gone has failed at the row it was on. */
async function progressView(ctx, file) {
  const progress = await readJson(file, null);
  if (!progress || progress.version !== 1 || !Array.isArray(progress.rows)) return null;
  const view = shown(progress);
  if (view.state === "running" && !ctx.alive(progress.pid)) {
    const at = view.rows.findIndex((item) => item.state !== "ok");
    view.state = "failed";
    view.error = STALLED;
    if (at >= 0) view.rows = view.rows.map((item, index) => (index === at ? { ...item, state: "bad", error: STALLED } : item));
  }
  // 팀 주소 다시 올리기 goes once the hub runs this version.
  if (view.state === "done" && view.todo?.some((item) => item.id === "hub") && !(await ctx.hubBehind().catch(() => null))?.behind) {
    view.todo = view.todo.filter((item) => item.id !== "hub");
  }
  return view;
}

/** The update's progress (update.json) as the app shows it, or null before any. */
export async function updateProgress(options = {}) {
  const ctx = context(options);
  return progressView(ctx, ctx.paths.update);
}

/** doctor --fix's progress (fix.json) as the app shows it, or null before any. */
export async function fixProgress(options = {}) {
  const ctx = context(options);
  return progressView(ctx, ctx.paths.fix);
}

/**
 * The CLI 다시 시도 runs: the new plugin folder's once the update reached it, else
 * `own` (the app's), else the plugin's folder now, since a Codex update can take away
 * the folder the app runs from.
 */
export async function retryCli(own, options = {}) {
  const ctx = context(options);
  const progress = await readJson(ctx.paths.update, null);
  const cliIn = (folder) => (typeof folder === "string" && folder ? path.join(folder, "scripts", "cli.mjs") : null);
  const plugin = await pluginOf(ctx, progress?.host === "codex" ? "codex" : "claude");
  for (const cli of [cliIn(progress?.folder), own, cliIn(plugin?.folder)]) {
    if (cli && (await exists(cli))) return cli;
  }
  return own;
}

/**
 * fix.mjs's onStep on a progress's rows: the row of `step` in `state`. A login that
 * ended puts the login row before the server's, and the server's next run takes it
 * as done; the server's run names the row by whether the server runs. A reason is
 * kept with its addresses cleaned.
 */
export function stepRow(progress, step, state, info = {}) {
  let at = progress.rows.find((item) => item.id === step);
  if (!at) {
    at = { ...row(step), state: "wait" };
    progress.rows.push(at);
  }
  const login = () => progress.rows.find((item) => item.id === "login");
  if (state === "login") {
    at.state = "wait";
    if (!login()) progress.rows.push({ ...row("login"), state: "wait" });
    Object.assign(login(), { state: "login" });
    sortRows(progress);
    return;
  }
  if (step === "server" && state === "run") {
    Object.assign(at, row("server", info.running, at.gateway));
    if (login()) login().state = "ok";
  }
  at.state = state;
  delete at.error;
  delete at.detail;
  if (state === "bad") {
    if (info.error) at.error = clean(info.error);
    if (info.detail) at.detail = clean(info.detail);
  }
  sortRows(progress);
}

function recorder(ctx, file, progress) {
  const write = async () => {
    progress.updatedAt = iso(ctx.now());
    await writeJson(file, progress).catch(() => {});
  };
  return {
    write,
    step: async (step, state, info) => {
      stepRow(progress, step, state, info);
      await write();
    },
    /** The run stops at `id` with the reason `result` gives. */
    fail: async (id, result) => {
      stepRow(progress, id, "bad", { error: result.error, detail: result.detail });
      progress.state = "failed";
      progress.error = result.error ? clean(result.error) : null;
      progress.finishedAt = iso(ctx.now());
      await write();
      return { ok: false, error: progress.error };
    },
  };
}

/**
 * The rows doctor's checks ask fix.mjs for, as doctor sees them in this copy: ones it
 * no longer marks are done. The app's row is not done just because doctor has no
 * check of it: doctor checks only an app it knows answering, and the update was
 * started from one (see checksFor).
 */
function reconcile(progress, checks) {
  const behind = fixable(checks);
  for (const [check, id] of Object.entries(FIX_ROWS)) {
    const at = progress.rows.find((item) => item.id === id);
    const unseen = check === "app" && !checks.some((item) => item.name === "app");
    if (behind.has(check) && !at) progress.rows.push({ ...row(id), state: "wait" });
    else if (!behind.has(check) && !unseen && at && at.state !== "ok") {
      at.state = "ok";
      delete at.error;
      delete at.detail;
    }
  }
  sortRows(progress);
}

/**
 * The checks fix.mjs gets in the new folder: doctor's, and the app's when the app's
 * row is left and doctor saw no app of ours (none answering, or one it did not know):
 * restartApp then starts this copy's app, or says what answers in its place.
 */
function checksFor(progress, checks) {
  const app = progress.rows.find((item) => item.id === "app");
  if (!app || app.state === "ok" || checks.some((item) => item.name === "app")) return checks;
  return [...checks, { name: "app", ok: false, fix: "update" }];
}

/** What is left to do once it went through: new sessions in the agents, the server kept off, the team hub. */
async function todoOf(ctx, progress, { hub = true } = {}) {
  const ran = new Set(progress.rows.map((item) => item.id));
  const [claude, codex] = await Promise.all([claudePlugin(ctx.home), codexPlugin(ctx.home)]);
  const todo = [];
  if (claude && (ran.has("claude") || ran.has("runtime"))) todo.push({ id: "claude", title: "Claude Code", text: SESSIONS });
  if (codex && (ran.has("codex") || ran.has("runtime"))) todo.push({ id: "codex", title: "Codex", text: SESSIONS });
  if (progress.serverOff) {
    todo.push({ id: "server", title: "기억 서버", text: KEPT_OFF_HERE, action: "server-start" });
  }
  // On the computer that made the team, a version whose hub changed: the update does
  // not deploy it, since logins stop for the whole team while it goes up.
  const team = hub ? await ctx.hubBehind().catch(() => null) : null;
  if (team?.behind) {
    todo.push(team.canDeploy
      ? { id: "hub", title: "팀 주소", text: "팀 주소 다시 올리기를 누르세요. 올리는 동안 팀원의 로그인이 잠깐 멈춥니다.", action: "hub" }
      : { id: "hub", title: "팀 주소", text: "관리자 탭의 Cloudflare에서 token 바꾸기를 누르세요." });
  }
  return todo;
}

// ------------------------------------------------------------------ the plugins

/** The calls that bring the plugin in `host` up to its marketplace's newest version. */
export function pluginUpdateArgs(host, { marketplace, scope }) {
  const id = `${PLUGIN_NAME}@${marketplace}`;
  if (host === "codex") return [["plugin", "marketplace", "upgrade", marketplace], ["plugin", "add", id]];
  return [["plugin", "marketplace", "update", marketplace], ["plugin", "update", id, ...(scope === "user" ? ["--scope", "user"] : [])]];
}

/** Brings the plugin in `host` up to `to` or above: { ok, record } or { ok: false, error } in the host's own words. */
async function updatePlugin(ctx, host, to) {
  const name = CLIENT_NAMES[host];
  const record = await pluginOf(ctx, host);
  if (!record) return { ok: false, error: `${name}에 팀 메모리 플러그인이 없습니다.` };
  const binary = await hostCli(host, { home: ctx.home, env: ctx.env, platform: ctx.platform });
  const missing = { ok: false, error: `${name} CLI(${host})를 이 컴퓨터에서 찾지 못했습니다.` };
  if (!binary && !ctx.clientRunner) return missing;
  for (const args of pluginUpdateArgs(host, record)) {
    let result;
    try {
      result = await runClient(ctx, host, args, { binary, timeoutMs: PLUGIN_INSTALL_TIMEOUT_MS });
    } catch (error) {
      return { ok: false, error: String(error?.message || error).slice(0, 300) };
    }
    if (result.missing) return missing;
    if (result.timedOut) return { ok: false, error: `${[host, ...args].join(" ")}: ${PLUGIN_INSTALL_TIMEOUT_MS / 1000}초 안에 끝나지 않았습니다.` };
    if (result.code !== 0) return { ok: false, error: clientFailure(result) };
  }
  const after = await pluginOf(ctx, host);
  if (!after?.folder || !after.version || compareVersions(after.version, to) < 0) {
    return { ok: false, error: `${name} 플러그인이 ${toVersion(to)} 바뀌지 않았습니다. 지금 판: ${after?.version || "알 수 없음"}` };
  }
  return { ok: true, record: after };
}

// ------------------------------------------------------------------ the steps

const warningOf = (server) => (server?.rebuild && server.running ? WARNING : null);

/** The bell's view of what `assess` found. */
async function statusOf(ctx, seen) {
  return {
    ok: true,
    latest: seen.latest,
    checkedAt: seen.check?.checkedAt || null,
    ...(seen.check?.error ? { error: seen.check.error, failedAt: seen.check.failedAt || null } : {}),
    newer: seen.newer,
    here: {
      app: seen.here.app,
      claude: seen.here.claude?.version || null,
      codex: seen.here.codex?.version || null,
      runtime: seen.here.runtime,
    },
    rows: seen.rows,
    summary: summaryOf(seen.rows),
    server: seen.server,
    warning: warningOf(seen.server),
    blocked: seen.blocked,
    progress: await progressView(ctx, ctx.paths.update),
  };
}

/**
 * The bell's view: main's version and when it was read, the versions here, the rows
 * 업데이트 would run, the line saying what it brings up, the warning when it rebuilds
 * a running server, why it cannot be pressed now, and the update going or last done.
 */
export async function updateStatus(options = {}) {
  const ctx = context(options);
  return statusOf(ctx, await assess(ctx, options));
}

/**
 * 업데이트: main read again, the rows written, and `update run` started in a process
 * of its own. `options.seen` is what the screen showed, { latest, warning }: main's
 * version and whether it warned that teammates' reading stops. When either is no
 * longer so, nothing starts: { ok: false, code: "changed", status } has the status as
 * it is now, for the screen to show before the button is pressed again. Nor does it
 * when main cannot be read now (code "unread"): what it would bring is not known.
 */
export async function updateStart(options = {}) {
  const ctx = context(options);
  return withLock(ctx, async () => {
    const seen = await assess(ctx, { ...options, force: true });
    if (seen.going) return { ok: false, code: "running", error: "업데이트가 이미 도는 중입니다." };
    if (seen.check?.error) return { ok: false, code: "unread", error: UNREAD, detail: clean(seen.check.error) };
    if (!seen.newer) return { ok: false, code: "current", error: "이 컴퓨터는 새 판입니다." };
    const warned = Boolean(warningOf(seen.server));
    if (options.seen && (seen.latest !== options.seen.latest || warned !== Boolean(options.seen.warning))) {
      const error = seen.latest !== options.seen.latest ? CHANGED : warned ? WARNED : UNWARNED;
      return { ok: false, code: "changed", error, status: await statusOf(ctx, seen) };
    }
    if (seen.blocked) return { ok: false, code: seen.blocked.code, error: seen.blocked.reason };
    const now = iso(ctx.now());
    const progress = {
      version: 1,
      kind: "update",
      state: "running",
      from: seen.lowest,
      // main's version until the plugin the rest runs from went up: then the version it went to.
      to: seen.latest,
      host: seen.host,
      folder: null,
      startedAt: now,
      updatedAt: now,
      finishedAt: null,
      // This process until the next one is started, so the run never reads as stopped.
      pid: process.pid,
      rows: seen.rows.map((item) => ({ ...item, state: "wait" })),
      todo: [],
    };
    await writeJson(ctx.paths.update, progress);
    return start(ctx, progress, path.join(ctx.scriptDir, "cli.mjs"), "run");
  });
}

/** Starts the next step's process from `cli` and keeps its pid. */
async function start(ctx, progress, cli, action) {
  const pid = ctx.spawn(cli, ["update", action], { cwd: ctx.paths.dir, env: ctx.env });
  const save = recorder(ctx, ctx.paths.update, progress);
  if (!pid) return save.fail(firstLeft(progress), { error: `업데이트를 이어 갈 프로세스를 띄우지 못했습니다: ${cli}` });
  progress.pid = pid;
  await save.write();
  return { ok: true, progress: shown(progress) };
}

const firstLeft = (progress) => progress.rows.find((item) => item.state !== "ok")?.id || progress.host;

/** Runs a step's process; what it throws stops the update at the row it was on, with that reason. */
async function stepProcess(ctx, body) {
  const progress = await readJson(ctx.paths.update, null);
  if (progress?.state !== "running") return { ok: false, error: "No update is going" };
  // The one that started this may not have written this pid yet.
  progress.pid = process.pid;
  const save = recorder(ctx, ctx.paths.update, progress);
  try {
    return await body(progress, save);
  } catch (error) {
    return save.fail(firstLeft(progress), { error: String(error?.message || error).split(/\r?\n/)[0] });
  }
}

/** `update run`, in the copy the app ran: the plugin the rest runs from, then that folder's `update continue`. */
export async function updateRun(options = {}) {
  const ctx = context(options);
  return stepProcess(ctx, (progress, save) => runPlugin(ctx, progress, save));
}

async function runPlugin(ctx, progress, save) {
  const host = progress.host;
  let record = await pluginOf(ctx, host);
  const own = progress.rows.find((item) => item.id === host);
  if (own && own.state !== "ok") {
    await save.step(host, "run");
    const updated = await updatePlugin(ctx, host, progress.to);
    if (!updated.ok) return save.fail(host, updated);
    record = updated.record;
    own.version = record.version;
    await save.step(host, "ok");
  }
  const cli = record?.folder ? path.join(record.folder, "scripts", "cli.mjs") : null;
  if (!cli || !(await exists(cli))) return save.fail(host, { error: `새 ${CLIENT_NAMES[host]} 플러그인 폴더에 scripts/cli.mjs가 없습니다.` });
  // Written before that folder's process starts, which reads it at once: the rest
  // goes up to the version that folder is.
  progress.folder = record.folder;
  if (record.version) progress.to = record.version;
  await save.write();
  return start(ctx, progress, cli, "continue");
}

/**
 * `update continue`, in the new plugin's folder: doctor's checks there, fix.mjs for
 * the collector, the server and the app (which starts the app again from here), the
 * Codex plugin last, and what is left to do. With Codex only, the app goes first, in
 * a fix of its own (sortRows).
 */
export async function updateContinue(options = {}) {
  const ctx = context(options);
  return stepProcess(ctx, (progress, save) => continueHere(ctx, progress, save));
}

async function continueHere(ctx, progress, save) {
  const before = await ctx.doctor();
  reconcile(progress, before.checks);
  await save.write();
  const checks = checksFor(progress, before.checks);
  const parts = progress.host === "codex"
    ? [checks.filter((check) => check.name === "app"), checks.filter((check) => check.name !== "app")]
    : [checks];
  const said = [];
  let fixed;
  for (const part of parts) {
    fixed = await ctx.fix(part, save.step);
    if (fixed.said) said.push(inApp(fixed.said));
    if (!fixed.ok) break;
  }
  progress.said = clean(said.join(" "));
  if (fixed.login) {
    progress.state = "login";
    await save.write();
    return { ok: false, login: true, said: progress.said };
  }
  if (fixed.serverOff) progress.serverOff = true;
  if (!fixed.ok) {
    progress.state = "failed";
    progress.error = fixed.error ? clean(fixed.error) : null;
    progress.finishedAt = iso(ctx.now());
    await save.write();
    return { ok: false, error: progress.error, said: progress.said };
  }
  const codex = progress.rows.find((item) => item.id === "codex");
  if (codex && codex.state !== "ok" && progress.host !== "codex") {
    await save.step("codex", "run");
    const updated = await updatePlugin(ctx, "codex", progress.to);
    if (!updated.ok) return save.fail("codex", updated);
    codex.version = updated.record.version;
    await save.step("codex", "ok");
  }
  const plugins = progress.rows.filter((item) => item.id === "claude" || item.id === "codex")
    .map((item) => `${CLIENT_NAMES[item.id]} 플러그인을 ${toVersion(item.version || progress.to)} 올렸습니다.`);
  progress.said = clean([...plugins, ...said].join(" "));
  progress.todo = await todoOf(ctx, progress);
  progress.state = "done";
  progress.finishedAt = iso(ctx.now());
  await save.write();
  return { ok: true, said: progress.said };
}

/**
 * 다시 시도: from the row that stopped (a login row as done, asked again when it was
 * not). Before the plugin the rest runs from went up, `update run` again from this
 * copy; after it, `update continue` from that plugin's folder.
 */
export async function updateRetry(options = {}) {
  const ctx = context(options);
  return withLock(ctx, async () => {
    const progress = await readJson(ctx.paths.update, null);
    if (!progress || progress.version !== 1 || !Array.isArray(progress.rows)) return { ok: false, code: "none", error: "다시 할 업데이트가 없습니다." };
    if (runningIn(ctx, progress)) return { ok: false, code: "running", error: "업데이트가 이미 도는 중입니다." };
    if (progress.state === "done") return { ok: false, code: "done", error: "업데이트가 이미 끝났습니다." };
    const blocked = await blockedNow(ctx, await ctx.config());
    if (blocked) return { ok: false, code: blocked.code, error: blocked.reason };
    const first = progress.rows.find((item) => item.state !== "ok");
    const again = !progress.folder || first?.id === progress.host;
    for (const item of progress.rows) {
      if (item.state === "ok") continue;
      item.state = "wait";
      delete item.error;
      delete item.detail;
    }
    Object.assign(progress, { state: "running", pid: process.pid, finishedAt: null, todo: [] });
    delete progress.error;
    delete progress.said;
    // A server prepared only, as it was off, stays so: its row does not run again.
    if (progress.rows.find((item) => item.id === "server")?.state !== "ok") delete progress.serverOff;
    let cli = path.join(ctx.scriptDir, "cli.mjs");
    if (again) progress.folder = null;
    else {
      // The folder may have gone since (a newer plugin took its place): the plugin's own one now.
      const folder = (await exists(path.join(progress.folder, "scripts", "cli.mjs"))) ? progress.folder : (await pluginOf(ctx, progress.host))?.folder;
      if (folder) {
        progress.folder = folder;
        cli = path.join(folder, "scripts", "cli.mjs");
      }
    }
    await writeJson(ctx.paths.update, progress);
    return start(ctx, progress, cli, again ? "run" : "continue");
  });
}

/**
 * doctor --fix with its rows in fix.json as it goes, for the app's 고치기, whose app
 * it may restart: { fixed } or, while an update or another fix runs, { refused }. One
 * that would make the server again is refused too while a long job runs, by that
 * job's code (past, rederive) and why, as the update is: the restart would cut it.
 * Why is said for the 고치기 pressed (`said`) and for the bell's 업데이트 that runs
 * one (`update`). fix.json says the end in the app's words (inApp).
 * `fix(checks, onStep)` is fix.mjs with this copy's steps.
 */
export async function recordFix(checks, fix, options = {}) {
  const ctx = context(options);
  const progress = {
    version: 1,
    kind: "fix",
    state: "running",
    startedAt: iso(ctx.now()),
    updatedAt: iso(ctx.now()),
    finishedAt: null,
    pid: process.pid,
    rows: [],
    todo: [],
  };
  for (const name of fixable(checks)) if (FIX_ROWS[name]) progress.rows.push({ ...row(FIX_ROWS[name]), state: "wait" });
  sortRows(progress);
  const lock = await acquireFileLock(ctx.paths.lock, LOCK);
  if (!lock) return { refused: { code: "busy", said: STARTING } };
  try {
    // A long job's hours first, before another update's or fix's minutes.
    if (fixable(checks).has("server-version")) {
      const job = await ctx.longJob(ctx, await ctx.config());
      if (job) return { refused: { code: job.code, said: job.fix, update: job.update } };
    }
    if (runningIn(ctx, await readJson(ctx.paths.update, null))) return { refused: { code: "updating", said: UPDATING } };
    if (runningIn(ctx, await readJson(ctx.paths.fix, null))) return { refused: { code: "fixing", said: FIXING } };
    await writeJson(ctx.paths.fix, progress);
  } finally {
    await releaseFileLock(lock);
  }
  const save = recorder(ctx, ctx.paths.fix, progress);
  const fixed = await fix(checks, save.step);
  progress.state = fixed.login ? "login" : fixed.ok ? "done" : "failed";
  if (fixed.serverOff) progress.serverOff = true;
  if (fixed.error) progress.error = clean(fixed.error);
  progress.said = clean(inApp(fixed.said || ""));
  if (progress.state !== "login") progress.finishedAt = iso(ctx.now());
  if (fixed.ok) progress.todo = await todoOf(ctx, progress, { hub: false });
  await save.write();
  return { fixed };
}

/** `update <action>`: status [--check], start and retry; run and continue are started by them. */
export async function updateCommand(action, options = {}) {
  if (action === "status") return updateStatus(options);
  if (action === "start") return updateStart(options);
  if (action === "retry") return updateRetry(options);
  if (action === "run") return updateRun(options);
  if (action === "continue") return updateContinue(options);
  return { ok: false, error: `Unknown update action: ${action}. Expected status, start or retry.` };
}
