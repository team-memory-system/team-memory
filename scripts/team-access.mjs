// Who may log in to the team's memory servers, and how a teammate's server joins.
//
// The owner keeps one email list: the reusable Access policy "Team Memory people",
// which every server's people app uses. `teammates add|remove` edit it with the
// owner's Cloudflare API token. `teammates add <email> --share <name>` also makes a
// second server's Cloudflare half (tunnel, memory-<name>.<zone>, ingress, Access
// apps) and writes an invite; the teammate's `server share join` does the local half
// with it and needs no API token. `teammates unshare <name>` removes that half.
//
// Files, beside the installed server under <runtime>:
//   cloudflare/api-token   the owner's API token, owner-only (0600 / owner ACL)
//   team-access.json       ids and names only, no secret: the account, zone, team
//                          domain, Google login, both policies, the owner's server
//                          and every teammate's shared server
// An invite is `tm1.` + base64url(JSON {v:1, host, tunnelToken, teamDomain, aud,
// team:[{name, host}]}). It holds a tunnel token, so it is only ever written to an
// owner-only file the user names, or handed to the app to show once; nothing here
// prints it.
//
// At the end: taking out the team-<name> entries older versions put into Claude Code
// and Codex for each teammate's server (dropTeamEntries).
import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  CLOUDFLARE_API_BASE,
  CloudflareApiError,
  cloudflareClient,
  ensurePeoplePolicy,
  ensureServerHost,
  normalizeEmail,
  policyEmails,
  removeServerHost,
  TUNNEL_PREFIX,
} from "./cloudflare-api.mjs";
import { acquireFileLock, releaseFileLock } from "./file-lock.mjs";
import { writePrivateFileAtomic } from "./private-file-permissions.mjs";
import { installedServerDir } from "./server-manager.mjs";
import { readTeamAuth, teamAuthPaths } from "./team-auth.mjs";

export const INVITE_PREFIX = "tm1.";
export const INVITE_ENV = "HONCHO_SHARE_INVITE";
export const API_TOKEN_ENV = "CLOUDFLARE_API_TOKEN";
// Tests point the client at a local fake; only a loopback address is taken from here.
export const API_BASE_ENV = "HONCHO_CLOUDFLARE_API_BASE";
export const TUNNEL_TOKEN_PATTERN = /^[A-Za-z0-9+/=_.-]{20,8192}$/;
const API_TOKEN_PATTERN = /^[A-Za-z0-9_.-]{20,400}$/;
const HOSTNAME = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const AUD = /^[A-Za-z0-9_-]{16,256}$/;
const MAX_INVITE_LENGTH = 32_768;
const MAX_TEAM = 200;

// ------------------------------------------------------------------ checks

export function validHostname(value) {
  return typeof value === "string" && HOSTNAME.test(value);
}

/** A server's short name: one DNS label, lower case, up to 32 characters. */
export function validName(value) {
  return typeof value === "string" && LABEL.test(value);
}

/** The owner's server is <name>.<zone>; a teammate's is memory-<name>.<zone>. */
export function ownerHost(name, zone) {
  return `${name}.${zone}`;
}

export function sharerHost(name, zone) {
  return `memory-${name}.${zone}`;
}

export function tunnelName(name) {
  return `${TUNNEL_PREFIX}${name}`;
}

// ------------------------------------------------------------------ invites

function inviteError(reason) {
  // Never the code itself: it holds a tunnel token.
  return new Error(`The invite code is not valid: ${reason}`);
}

function checkInvite(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw inviteError("it holds no invite");
  if (value.v !== 1) throw inviteError("it is from another version of Team Memory");
  if (!validHostname(value.host)) throw inviteError("its server address is missing or wrong");
  if (typeof value.tunnelToken !== "string" || !TUNNEL_TOKEN_PATTERN.test(value.tunnelToken)) throw inviteError("its tunnel token is missing or wrong");
  if (!validHostname(value.teamDomain)) throw inviteError("its team domain is missing or wrong");
  if (typeof value.aud !== "string" || !AUD.test(value.aud)) throw inviteError("its Access AUD tag is missing or wrong");
  if (!Array.isArray(value.team) || value.team.length > MAX_TEAM) throw inviteError("its team list is missing or too long");
  const team = value.team.map((item) => {
    if (!item || typeof item !== "object" || !validName(item.name) || !validHostname(item.host)) throw inviteError("its team list has a wrong entry");
    return { name: item.name, host: item.host };
  });
  return { v: 1, host: value.host, tunnelToken: value.tunnelToken, teamDomain: value.teamDomain, aud: value.aud, team };
}

export function encodeInvite(invite) {
  const checked = checkInvite({ v: 1, ...invite });
  return `${INVITE_PREFIX}${Buffer.from(JSON.stringify(checked), "utf8").toString("base64url")}`;
}

/** The invite in a code, checked field by field. Throws an error that never quotes the code. */
export function decodeInvite(code) {
  const text = String(code ?? "").trim();
  if (!text) throw inviteError("it is empty");
  if (text.length > MAX_INVITE_LENGTH) throw inviteError("it is too long");
  if (!text.startsWith(INVITE_PREFIX)) throw inviteError(`it does not start with ${INVITE_PREFIX}`);
  const body = text.slice(INVITE_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(body)) throw inviteError("it has characters an invite never has");
  let value;
  try { value = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { throw inviteError("it is cut off or changed"); }
  return checkInvite(value);
}

/** The tunnel id a connector token names (`t`), when it can be read; not a secret. */
export function tunnelIdFromToken(token) {
  try {
    const id = JSON.parse(Buffer.from(String(token), "base64").toString("utf8"))?.t;
    return typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id) ? id : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------- files

export function teamAccessPaths({ serverDirectory, runtimeDirectory } = {}) {
  const serverDir = path.resolve(serverDirectory || installedServerDir());
  const runtimeDir = path.resolve(runtimeDirectory || path.join(path.dirname(serverDir), "runtime"));
  return {
    serverDir,
    runtimeDir,
    apiTokenFile: path.join(runtimeDir, "cloudflare", "api-token"),
    teamFile: path.join(runtimeDir, "team-access.json"),
  };
}

export function privateFileOptionsFrom(options = {}) {
  return {
    platform: options.filePlatform || process.platform,
    env: options.env || process.env,
    ...(options.privateFileRunner ? { run: options.privateFileRunner } : {}),
  };
}

export async function readTeamState(paths) {
  try {
    const value = JSON.parse(await fsp.readFile(paths.teamFile, "utf8"));
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

export async function writeTeamState(paths, state, privateFileOptions) {
  await writePrivateFileAtomic(paths.teamFile, `${JSON.stringify({ version: 1, ...state }, null, 2)}\n`, privateFileOptions);
}

/** The API token from CLOUDFLARE_API_TOKEN, else the one saved before. */
export async function readApiToken(paths, env = process.env) {
  const fromEnv = String(env[API_TOKEN_ENV] || "").trim();
  if (fromEnv) {
    if (!API_TOKEN_PATTERN.test(fromEnv)) throw new Error(`${API_TOKEN_ENV} does not look like a Cloudflare API token`);
    return { token: fromEnv, source: "env" };
  }
  const saved = (await fsp.readFile(paths.apiTokenFile, "utf8").catch(() => "")).trim();
  if (saved) return { token: saved, source: "saved" };
  return { token: "", source: null };
}

/** Kept owner-only after a call has worked, so a mistyped token is never saved. */
export async function saveApiToken(paths, token, privateFileOptions) {
  const previous = (await fsp.readFile(paths.apiTokenFile, "utf8").catch(() => "")).trim();
  await writePrivateFileAtomic(paths.apiTokenFile, `${token}\n`, privateFileOptions);
  return previous !== token;
}

export async function apiTokenSaved(paths) {
  return Boolean((await fsp.readFile(paths.apiTokenFile, "utf8").catch(() => "")).trim());
}

function apiBaseUrl(options) {
  if (options.apiBaseUrl) return options.apiBaseUrl;
  const fromEnv = String((options.env || process.env)[API_BASE_ENV] || "").trim();
  if (fromEnv) {
    try {
      const url = new URL(fromEnv);
      if (["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return fromEnv;
    } catch {}
  }
  return CLOUDFLARE_API_BASE;
}

/** A client for the owner's token, or a result to stop with. */
export async function ownerClient(paths, options = {}) {
  let found;
  try { found = await readApiToken(paths, options.env || process.env); } catch (error) { return { ok: false, error: error.message }; }
  if (!found.token) {
    return { ok: false, error: `The Cloudflare API token is needed: put it in ${API_TOKEN_ENV} (never on the command line)` };
  }
  const client = cloudflareClient({ token: found.token, baseUrl: apiBaseUrl(options), fetchImpl: options.cloudflareFetch || globalThis.fetch });
  return { ok: true, client, token: found.token, source: found.source };
}

/** Writes the invite to a file only the user can read. An existing other file is not replaced. */
export async function writeInviteFile(target, code, privateFileOptions) {
  const file = path.resolve(String(target));
  const existing = await fsp.readFile(file, "utf8").catch((error) => (error?.code === "ENOENT" ? null : ""));
  if (existing !== null && existing.trim() && !existing.trim().startsWith(INVITE_PREFIX)) {
    throw new Error(`${file} already exists and is not an invite; name a new file`);
  }
  await writePrivateFileAtomic(file, `${code}\n`, privateFileOptions);
  return file;
}

// --------------------------------------------------------------- teammates

function failure(error) {
  const message = error instanceof CloudflareApiError || error instanceof Error ? error.message : String(error);
  return { ok: false, error: message };
}

async function ownerContext(options) {
  const paths = teamAccessPaths(options);
  const state = await readTeamState(paths);
  if (!state?.accountId || !state?.peoplePolicyId) {
    return { ok: false, error: "This computer has not shared its server through Cloudflare yet; run server share enable --cloudflare first" };
  }
  const owner = await ownerClient(paths, options);
  if (!owner.ok) return owner;
  return { ok: true, paths, state, ...owner, privateFileOptions: privateFileOptionsFrom(options) };
}

async function afterFirstCall(ctx) {
  // The token worked, so it is worth keeping.
  if (ctx.source === "env") await saveApiToken(ctx.paths, ctx.token, ctx.privateFileOptions);
}

function sharerList(state) {
  return Object.entries(state.sharers || {}).map(([name, item]) => ({ name, host: item.host, email: item.email || null }));
}

/** The servers of the team, for an invite's team list: the owner's first. */
export function teamServers(state) {
  const owner = state.owner?.name && state.owner?.host ? [{ name: state.owner.name, host: state.owner.host }] : [];
  return [...owner, ...sharerList(state).map(({ name, host }) => ({ name, host }))];
}

/**
 * One change to the team at a time: team-access.json and the people list are read,
 * changed and written back. Separate from the server's own lifecycle lock, so the
 * list can be edited while the server starts.
 */
export async function withTeamAccessLock(paths, operation, callback) {
  const lock = await acquireFileLock(`${paths.teamFile}.lock`, { attempts: 1, staleMs: 600_000, reclaimDeadImmediately: true });
  if (!lock) throw new Error(`Another change to the team is already running, so ${operation} did not start; try again when it ends`);
  try { return await callback(); }
  finally { await releaseFileLock(lock); }
}

async function withTeamLock(options, operation, callback) {
  try { return await withTeamAccessLock(teamAccessPaths(options), operation, callback); }
  catch (error) { return failure(error); }
}

/** Who may log in: the people policy's emails, and the teammates' shared servers. */
export async function teammatesList(options = {}) {
  const ctx = await ownerContext(options);
  if (!ctx.ok) return ctx;
  try {
    const policy = await ctx.client.get(`/accounts/${encodeURIComponent(ctx.state.accountId)}/access/policies/${encodeURIComponent(ctx.state.peoplePolicyId)}`);
    await afterFirstCall(ctx);
    const servers = teamServers(ctx.state);
    return {
      ok: true,
      owner: ctx.state.ownerEmail || null,
      people: policyEmails(policy),
      servers,
      shared: sharerList(ctx.state),
      // The 팀 주소 the owner hands to teammates who only ask; no secret in it.
      addressText: teamAddressText(servers),
    };
  } catch (error) {
    return failure(error);
  }
}

async function teammateAddUnlocked(options) {
  const email = normalizeEmail(options.email);
  if (!email) return { ok: false, error: "teammates add takes an email address" };
  const share = options.share === undefined || options.share === null || options.share === "" ? null : String(options.share).trim().toLowerCase();
  if (share !== null) {
    if (!validName(share)) return { ok: false, error: "--share takes a short name: lower-case letters, digits and -, up to 32 characters" };
    if (!options.inviteOut && !options.returnInvite) return { ok: false, error: "--share needs --invite-out <file>: the invite holds a tunnel token, so it is only written to a file" };
  }
  const ctx = await ownerContext(options);
  if (!ctx.ok) return ctx;
  const { state, client } = ctx;
  if (share !== null && share === state.owner?.name) return { ok: false, error: `${share} is the name of this server; choose another name for the teammate's` };
  try {
    const policy = await ensurePeoplePolicy(client, state.accountId, { id: state.peoplePolicyId, add: [email] });
    await afterFirstCall(ctx);
    const next = { ...state, peoplePolicyId: policy.id };
    const result = { ok: true, email, added: policy.updated || policy.created, people: policy.emails };
    if (share === null) {
      await writeTeamState(ctx.paths, next, ctx.privateFileOptions);
      return result;
    }
    const host = sharerHost(share, state.zone);
    const known = state.sharers?.[share] || {};
    const made = await ensureServerHost(client, {
      accountId: state.accountId,
      zoneId: state.zoneId,
      host,
      tunnelName: tunnelName(share),
      idpId: state.idpId,
      peoplePolicyId: policy.id,
      bypassPolicyId: state.bypassPolicyId,
      known,
    });
    next.sharers = {
      ...(state.sharers || {}),
      [share]: {
        host,
        email,
        tunnelId: made.tunnelId,
        aud: made.aud,
        peopleAppId: made.peopleAppId,
        bypassAppId: made.bypassAppId,
        dnsRecordId: made.dnsRecordId,
        invitedAt: new Date().toISOString(),
      },
    };
    await writeTeamState(ctx.paths, next, ctx.privateFileOptions);
    const code = encodeInvite({
      host,
      tunnelToken: made.tunnelToken,
      teamDomain: state.teamDomain,
      aud: made.aud,
      team: teamServers(next),
    });
    result.share = { name: share, host, publicUrl: `https://${host}`, tunnelId: made.tunnelId, changes: made.changes };
    if (options.inviteOut) result.inviteFile = await writeInviteFile(options.inviteOut, code, ctx.privateFileOptions);
    if (options.returnInvite) result.invite = code;
    result.next = "Give the teammate the invite file over a private channel; on their computer: server share join --invite-file <file>";
    return result;
  } catch (error) {
    return failure(error);
  }
}

/**
 * Adds an email to the people list. With `share`, also makes that teammate's server
 * reachable at memory-<share>.<zone> and writes the invite to `inviteOut`, or, for
 * the app, returns it as `invite` when `returnInvite` is set. Nothing starts here.
 */
export async function teammateAdd(options = {}) {
  return withTeamLock(options, "teammates-add", () => teammateAddUnlocked(options));
}

async function teammateRemoveUnlocked(options) {
  const email = normalizeEmail(options.email);
  if (!email) return { ok: false, error: "teammates remove takes an email address" };
  const ctx = await ownerContext(options);
  if (!ctx.ok) return ctx;
  if (email === ctx.state.ownerEmail) return { ok: false, error: "That is the owner's own email; removing it would lock the owner out" };
  try {
    const policy = await ensurePeoplePolicy(ctx.client, ctx.state.accountId, { id: ctx.state.peoplePolicyId, remove: [email] });
    await afterFirstCall(ctx);
    const servers = sharerList(ctx.state).filter((item) => item.email === email).map((item) => item.name);
    return {
      ok: true,
      email,
      removed: policy.updated,
      people: policy.emails,
      ...(servers.length ? { stillShared: servers, next: `Their server stays reachable to the others; remove it with teammates unshare ${servers[0]}` } : {}),
    };
  } catch (error) {
    return failure(error);
  }
}

/** Takes an email off the people list. Any server that teammate shares stays. */
export async function teammateRemove(options = {}) {
  return withTeamLock(options, "teammates-remove", () => teammateRemoveUnlocked(options));
}

async function teammateUnshareUnlocked(options) {
  const name = String(options.name || "").trim().toLowerCase();
  if (!validName(name)) return { ok: false, error: "teammates unshare takes the short name given to --share" };
  const ctx = await ownerContext(options);
  if (!ctx.ok) return ctx;
  const { state } = ctx;
  if (name === state.owner?.name) return { ok: false, error: `${name} is this server; turn it off with server share disable` };
  const known = state.sharers?.[name] || {};
  const host = known.host || sharerHost(name, state.zone);
  try {
    const removed = await removeServerHost(ctx.client, {
      accountId: state.accountId,
      zoneId: state.zoneId,
      host,
      tunnelName: tunnelName(name),
      known,
    });
    await afterFirstCall(ctx);
    const sharers = { ...(state.sharers || {}) };
    delete sharers[name];
    await writeTeamState(ctx.paths, { ...state, sharers }, ctx.privateFileOptions);
    return { ok: true, name, host, removed, next: "The teammate's computer can turn its sharing off with server share disable" };
  } catch (error) {
    return failure(error);
  }
}

/** Removes a teammate's shared server from Cloudflare: its apps, hostname and tunnel. */
export async function teammateUnshare(options = {}) {
  return withTeamLock(options, "teammates-unshare", () => teammateUnshareUnlocked(options));
}

// ------------------------------------------- the team-<name> entries of before
//
// Up to 0.6.8 a teammate's memory went into Claude Code and Codex as a remote MCP
// server of its own, `team-<name>` at https://<host>/mcp, which each client logged in
// to by itself (Codex's entry also carried `[mcp_servers.team-<name>.tools.chat]`
// with approval_mode = "approve"). Now every teammate is asked through the plugin's
// own `team-memory` server (team-memory-tools.mjs) with this computer's team login,
// so those entries go: `dropTeamEntries` takes out each one this app made, with the
// client's own CLI (run with an argument array and no shell), and Codex's approval
// table after it. An entry is this app's when its address is https://<host>/mcp on a
// team server this computer knows, or on a host under the team hub's zone; any other
// team-* entry is the user's own and stays.
//
// Which servers this computer knows is read from files only:
//   <runtime>/share.json       the invite's team list, on a teammate's computer
//   <runtime>/team-access.json the owner's server and the teammates' shared ones
//   team-auth.json             the team hub, whose zone holds every member's server

export const TEAM_ENTRY_PREFIX = "team-";
export const CLIENT_NAMES = Object.freeze({ claude: "Claude Code", codex: "Codex" });
const CLIENTS = Object.keys(CLIENT_NAMES);
const CLIENT_TIMEOUT_MS = 60_000;
// What may go to a client CLI: names and https URLs only, so even cmd.exe (Windows
// runs an npm .cmd shim through it) reads every argument as plain text. # is there
// for a marketplace source's ref (owner/repo#main), which cmd.exe leaves alone.
const SAFE_ARGUMENT = /^[A-Za-z0-9._:/@=#-]+$/;
const UNSAFE_PATH = /["%^&|<>!\r\n]/;
// The tool whose calls Codex was told to approve, in the table beside an entry.
const CODEX_APPROVED_TOOL = "chat";

/** The short name in `team-<name>`: lower-case letters, digits and -, up to 32. */
export function teamName(value) {
  const name = String(value ?? "").trim().toLowerCase().replace(/^team-/, "");
  return validName(name) ? name : null;
}

/** A server's address as host, https://host or https://host/mcp; the URL is always https://host/mcp. */
export function teamAddress(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return { ok: false, error: "The server address is missing: give its host, such as memory-bob.example.com" };
  let url;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`); }
  catch { return { ok: false, error: "The server address is not a host or a URL" }; }
  if (url.protocol !== "https:") return { ok: false, error: "The server address must use https" };
  if (url.username || url.password || url.port || url.search || url.hash || /[?#]/.test(raw)) {
    return { ok: false, error: "The server address must be only the host, https://<host> or https://<host>/mcp" };
  }
  if (!["/", "/mcp", "/mcp/"].includes(url.pathname)) {
    return { ok: false, error: "The server address must be only the host, https://<host> or https://<host>/mcp" };
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!validHostname(host)) return { ok: false, error: "The server address needs a full host name such as memory-bob.example.com" };
  return { ok: true, host, url: `https://${host}/mcp` };
}

/** The 팀 주소 text: one `<name> https://<host>/mcp` line per server. */
export function teamAddressText(servers) {
  return (servers || []).map(({ name, host }) => `${name} https://${host}/mcp`).join("\n");
}

function clientContext(options = {}) {
  const env = options.env || process.env;
  const home = path.resolve(options.homeDir || env.HONCHO_AGENT_BRIDGE_USER_HOME || os.homedir());
  return {
    env,
    platform: options.platform || process.platform,
    files: {
      claude: path.join(env.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : home, ".claude.json"),
      codex: path.join(env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(home, ".codex"), "config.toml"),
    },
    clientRunner: options.clientRunner || null,
    options,
  };
}

async function claudeEntries(file) {
  let document;
  try { document = JSON.parse(await fsp.readFile(file, "utf8")); } catch { return {}; }
  const servers = document?.mcpServers && typeof document.mcpServers === "object" ? document.mcpServers : {};
  return Object.fromEntries(Object.entries(servers)
    .filter(([name, entry]) => name.startsWith(TEAM_ENTRY_PREFIX) && entry && typeof entry === "object")
    .map(([name, entry]) => [name, { url: typeof entry.url === "string" ? entry.url : null, type: entry.type || null }]));
}

/** `[mcp_servers.<name>]` tables and their `url`, read without a TOML parser. */
async function codexEntries(file) {
  const text = await fsp.readFile(file, "utf8").catch(() => "");
  const entries = {};
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const header = line.match(/^\s*\[\s*mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))\s*\]\s*(?:#.*)?$/);
    if (header) {
      const name = header[1] || header[2];
      current = name.startsWith(TEAM_ENTRY_PREFIX) ? name : null;
      if (current) entries[current] = { url: null };
      continue;
    }
    if (/^\s*\[/.test(line)) { current = null; continue; }
    const url = current && line.match(/^\s*url\s*=\s*"([^"]*)"/);
    if (url) entries[current].url = url[1];
  }
  return entries;
}

/** Lines with their own line ends, so a file put back together is the same file. */
function tomlLines(text) {
  return text.match(/[^\n]*\n|[^\n]+$/g) || [];
}

function bareLine(line) {
  return line.replace(/\r?\n$/, "");
}

/** A `[mcp_servers.<key>...]` header, each key bare or "quoted"; `under` also takes its sub-tables. */
function codexHeader(keys, { under = false } = {}) {
  const dotted = ["mcp_servers", ...keys].map((key) => `(?:"${key}"|${key})`).join("\\s*\\.\\s*");
  return new RegExp(`^\\s*\\[\\s*${dotted}${under ? "\\s*\\." : "\\s*\\]\\s*(?:#.*)?$"}`);
}

/** Where the table whose header is line `at` ends: at the next header, or the end. */
function tableEnd(lines, at) {
  const next = lines.findIndex((line, index) => index > at && /^\s*\[/.test(line));
  return next < 0 ? lines.length : next;
}

const APPROVED_LINE = /^\s*approval_mode\s*=\s*"approve"\s*(?:#.*)?$/;

/** Writes a client's file back over the real file (a link stays a link, its mode kept), or makes it. */
async function writeClientFile(file, text) {
  let target;
  try {
    target = await fsp.realpath(file);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, text, { flag: "wx" });
    return;
  }
  const { mode } = await fsp.stat(target);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fsp.writeFile(temporary, text, { mode: mode & 0o777, flag: "wx" });
    await fsp.rename(temporary, target);
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Once the entry is gone: its tools.chat table, when it holds only what connecting
 * wrote. Codex reads no config at all with that table and no entry. A table with
 * anything else in it is the user's and stays, and so do comments.
 */
async function dropCodexApproval(file, entry) {
  const text = await fsp.readFile(file, "utf8").catch(() => "");
  const lines = tomlLines(text);
  if (lines.some((line) => codexHeader([entry]).test(bareLine(line)))) return {};
  const at = lines.findIndex((line) => codexHeader([entry, "tools", CODEX_APPROVED_TOOL]).test(bareLine(line)));
  if (at < 0) return {};
  const end = tableEnd(lines, at);
  const body = lines.slice(at + 1, end).map(bareLine);
  if (!body.every((line) => !line.trim() || /^\s*#/.test(line) || APPROVED_LINE.test(line))) return {};
  const kept = body.map((line, index) => (/^\s*#/.test(line) ? lines[at + 1 + index] : null)).filter(Boolean);
  // The blank line connecting put before the table goes with it.
  const start = at > 0 && !bareLine(lines[at - 1]).trim() ? at - 1 : at;
  lines.splice(start, end - start, ...kept);
  try { await writeClientFile(file, lines.join("")); } catch (error) { return { approval: "failed", approvalError: String(error?.message || error) }; }
  return { approval: "removed" };
}

/** The team-* entries Claude Code and Codex have, by name, from their own files. */
export async function registeredTeamServers(options = {}) {
  const ctx = options.files ? options : clientContext(options);
  const [claude, codex] = await Promise.all([claudeEntries(ctx.files.claude), codexEntries(ctx.files.codex)]);
  return { claude, codex };
}

/** The client's executable on PATH, or null. On Windows an npm .cmd shim counts. */
export function findClient(command, { env = process.env, platform = process.platform } = {}) {
  const extensions = platform === "win32"
    ? String(env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter((item) => /^\.(exe|cmd|bat|com)$/i.test(item))
    : [""];
  for (const directory of String(env.PATH || env.Path || "").split(path.delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension}`);
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        if (platform !== "win32") fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {}
    }
  }
  return null;
}

/** Whether a value may go to a client CLI as one argument. */
export function safeClientArgument(value) {
  return typeof value === "string" && SAFE_ARGUMENT.test(value);
}

/** How to start a client: the binary itself, or cmd.exe for a .cmd shim, with plain-text arguments only. */
export function clientCommand(binary, args, platform, env) {
  for (const arg of args) if (!SAFE_ARGUMENT.test(arg)) throw new Error("A client argument holds characters a name or an https address never has");
  if (platform === "win32" && /\.(cmd|bat)$/i.test(binary)) {
    if (UNSAFE_PATH.test(binary)) throw new Error(`The path of ${path.basename(binary)} holds characters cmd.exe would read as commands`);
    return {
      command: env.ComSpec || env.COMSPEC || "cmd.exe",
      args: ["/d", "/s", "/c", `""${binary}" ${args.join(" ")}"`],
      extra: { windowsVerbatimArguments: true },
    };
  }
  return { command: binary, args, extra: {} };
}

function execClient(command, args, extra, env, timeout = CLIENT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    execFile(command, args, { env, timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024, ...extra }, (error, stdout, stderr) => {
      resolve({
        code: error ? (typeof error.code === "number" ? error.code : -1) : 0,
        stdout: String(stdout || ""),
        stderr: String(stderr || ""),
        ...(error?.killed ? { timedOut: true } : {}),
      });
    });
  });
}

/**
 * One client CLI call: {missing} when the client is not installed, else {code, stdout, stderr}.
 * `binary` runs that executable instead of the one on PATH; `timeoutMs` replaces the 60 s limit.
 */
export async function runClient(ctx, client, args, { binary: given = null, timeoutMs = CLIENT_TIMEOUT_MS } = {}) {
  if (ctx.clientRunner) return ctx.clientRunner(client, args, { binary: given, timeoutMs });
  const binary = given || findClient(client, ctx);
  if (!binary) return { missing: true };
  const { command, args: list, extra } = clientCommand(binary, args, ctx.platform, ctx.env);
  return execClient(command, list, extra, ctx.env, timeoutMs);
}

export function clientFailure(result) {
  const text = `${result.stderr || ""}\n${result.stdout || ""}`.trim().split(/\r?\n/).find(Boolean) || `exit ${result.code}`;
  return text.slice(0, 300);
}

const REMOVE_ARGS = {
  claude: (entry) => ["mcp", "remove", entry, "--scope", "user"],
  codex: (entry) => ["mcp", "remove", entry],
};

async function readJsonFile(file) {
  try { return JSON.parse(await fsp.readFile(file, "utf8")); } catch { return null; }
}

/** The team's servers this computer knows from its own files, its own server left out. */
export async function knownTeamServers(options = {}) {
  const paths = teamAccessPaths(options);
  const [share, team] = await Promise.all([readJsonFile(path.join(paths.runtimeDir, "share.json")), readTeamState(paths)]);
  const self = typeof share?.host === "string" ? share.host : null;
  const known = new Map();
  const add = (item, source) => {
    const name = teamName(item?.name);
    if (!name || !validHostname(item?.host) || item.host === self) return;
    const current = known.get(name);
    if (current) { if (!current.sources.includes(source)) current.sources.push(source); return; }
    known.set(name, { name, host: item.host, url: `https://${item.host}/mcp`, sources: [source] });
  };
  for (const item of Array.isArray(share?.team) ? share.team : []) add(item, "invite");
  if (team) for (const item of teamServers(team)) add(item, "team");
  return [...known.values()];
}

/** The team hub's zone (team.example.com is in example.com), from this computer's team login. */
async function hubZone(options) {
  const paths = options.authPaths || teamAuthPaths(options.config || null, options.env || process.env);
  const hub = (await readTeamAuth(paths)).hub;
  const zone = hub ? hub.split(".").slice(1).join(".") : "";
  return zone.includes(".") ? zone : null;
}

/**
 * Takes out of Claude Code and Codex the team-<name> entries this app once made for
 * teammates' memories (see above), and Codex's approval table with each. Answers
 * what went from each client, and what could not go and why; a client that is not
 * on this computer is left as it is.
 */
export async function dropTeamEntries(options = {}) {
  const ctx = clientContext(options);
  const [registered, known, zone] = await Promise.all([registeredTeamServers(ctx), knownTeamServers(options), hubZone(options)]);
  const share = await readJsonFile(path.join(teamAccessPaths(options).runtimeDir, "share.json"));
  const hosts = new Set([...known.map((server) => server.host), ...(typeof share?.host === "string" ? [share.host] : [])]);
  const ours = (url) => {
    const address = teamAddress(url);
    return address.ok && address.url === url && (hosts.has(address.host) || Boolean(zone && address.host.endsWith(`.${zone}`)));
  };
  const removed = { claude: [], codex: [] };
  const failed = [];
  for (const client of CLIENTS) {
    for (const [entry, value] of Object.entries(registered[client])) {
      if (!ours(value.url)) continue;
      const result = await runClient(ctx, client, REMOVE_ARGS[client](entry));
      if (result.missing) break;
      if (result.code !== 0) failed.push({ client, entry, error: clientFailure(result) });
      else removed[client].push(entry);
      if (client === "codex") {
        const dropped = await dropCodexApproval(ctx.files.codex, entry);
        if (dropped.approval === "failed") failed.push({ client, entry, error: dropped.approvalError });
      }
    }
  }
  return { ok: failed.length === 0, removed, ...(failed.length ? { failed } : {}) };
}
