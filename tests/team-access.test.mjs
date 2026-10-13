// The team's email list and a teammate's shared server, through the owner's API token
// against a local fake of Cloudflare; the invite format; and the CLI, which never
// prints the API token, a tunnel token or an invite.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { shareEnable } from "../scripts/share-manager.mjs";
import {
  decodeInvite,
  dropTeamEntries,
  encodeInvite,
  knownTeamServers,
  teamAddress,
  teamAddressText,
  teammateAdd,
  teammateRemove,
  teammatesList,
  teammateUnshare,
  tunnelIdFromToken,
} from "../scripts/team-access.mjs";
import { API_TOKEN, connectorToken, startFakeCloudflare, TEAM_DOMAIN } from "./fake-cloudflare.mjs";

// Sharing a server asks the team hub for its Jev guard token with this computer's
// team login; no test here reaches a real one.
process.env.HONCHO_AGENT_TEAM_AUTH = path.join(os.tmpdir(), `no-team-login-${process.pid}`, "team-auth.json");

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "scripts", "cli.mjs");
const TUNNEL_TOKEN = "eyJhIjoiYWNjb3VudCIsInQiOiJ0dW5uZWwiLCJzIjoic2VjcmV0In0=";
const INVITE = { host: "memory-bob.example.com", tunnelToken: TUNNEL_TOKEN, teamDomain: TEAM_DOMAIN, aud: "e".repeat(64), team: [{ name: "memory", host: "memory.example.com" }] };

function code(value) {
  return `tm1.${Buffer.from(JSON.stringify(value)).toString("base64url")}`;
}

test("an invite is tm1. and base64url JSON, and a wrong one is refused without quoting it", () => {
  const encoded = encodeInvite(INVITE);
  assert.match(encoded, /^tm1\.[A-Za-z0-9_-]+$/);
  assert.deepEqual(JSON.parse(Buffer.from(encoded.slice(4), "base64url").toString("utf8")), { v: 1, ...INVITE });
  assert.deepEqual(decodeInvite(`  ${encoded}\n`), { v: 1, ...INVITE }, "a pasted code with spaces and a newline still works");
  assert.deepEqual(decodeInvite(code({ v: 1, ...INVITE, extra: "ignored" })), { v: 1, ...INVITE });

  const cases = [
    ["", /empty/],
    ["tm2.abc", /does not start with tm1\./],
    ["tm1.not base64!", /characters an invite never has/],
    ["tm1.bm90IGpzb24", /cut off or changed/],
    [code([1, 2]), /holds no invite/],
    [code({ ...INVITE, v: 2 }), /another version/],
    [code({ ...INVITE, v: 1, host: "https://memory-bob.example.com" }), /server address/],
    [code({ ...INVITE, v: 1, host: "localhost" }), /server address/],
    [code({ ...INVITE, v: 1, tunnelToken: "short" }), /tunnel token/],
    [code({ ...INVITE, v: 1, tunnelToken: `${TUNNEL_TOKEN} rm -rf` }), /tunnel token/],
    [code({ ...INVITE, v: 1, teamDomain: "" }), /team domain/],
    [code({ ...INVITE, v: 1, aud: "x" }), /AUD tag/],
    [code({ ...INVITE, v: 1, team: "memory" }), /team list/],
    [code({ ...INVITE, v: 1, team: [{ name: "Bad Name", host: "memory.example.com" }] }), /team list has a wrong entry/],
    [`tm1.${"A".repeat(40_000)}`, /too long/],
  ];
  for (const [value, pattern] of cases) {
    assert.throws(() => decodeInvite(value), (error) => {
      assert.match(error.message, /^The invite code is not valid: /);
      assert.match(error.message, pattern);
      assert.equal(error.message.includes(TUNNEL_TOKEN), false);
      if (value.length > 8) assert.equal(error.message.includes(value.slice(4, 24)), false, "the code is never quoted");
      return true;
    }, value.slice(0, 30));
  }
  assert.throws(() => encodeInvite({ ...INVITE, aud: "" }), /AUD tag/);

  const tunnelId = "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
  assert.equal(tunnelIdFromToken(connectorToken(tunnelId)), tunnelId);
  assert.equal(tunnelIdFromToken("not a token"), null);
});

async function ownerFixture(t) {
  const cf = await startFakeCloudflare();
  t.after(() => cf.close());
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-team-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const serverDirectory = path.join(root, "app", "server");
  await fsp.mkdir(path.join(serverDirectory, "gate"), { recursive: true });
  await fsp.writeFile(path.join(serverDirectory, "compose.yaml"), "name: honcho-agent-bridge\n");
  await fsp.writeFile(path.join(serverDirectory, "gate", "gate.mjs"), "// gate\n");
  await fsp.writeFile(path.join(serverDirectory, ".env"), "EMBEDDING_MODEL_CONFIG__MODEL=qwen3-embedding-4b-honcho-8192\n", { mode: 0o600 });
  const options = {
    serverDirectory,
    homeDir: path.join(root, "home"),
    platform: "darwin",
    uid: 501,
    env: {},
    config: { user: { peerId: "owner_peer" } },
    run: async () => ({ code: 1, stdout: "", stderr: "" }),
    composeRunner: async () => ({ stdout: "", stderr: "" }),
    fetchImpl: async () => ({ ok: true, status: 200, body: { cancel: async () => {} } }),
    sleep: async () => {},
    portInUse: async () => false,
    gateWaitMs: 0,
    apiBaseUrl: cf.baseUrl,
  };
  const enabled = await shareEnable({ ...options, env: { CLOUDFLARE_API_TOKEN: API_TOKEN }, cloudflare: true, zone: "example.com", email: "owner@example.com" });
  assert.equal(enabled.ok, true, JSON.stringify(enabled));
  return { cf, root, serverDirectory, options, teamFile: path.join(root, "app", "runtime", "team-access.json") };
}

test("teammates add and remove edit the one email list; the owner's own email cannot be removed", async (t) => {
  const f = await ownerFixture(t);
  const people = () => f.cf.state.policies.find((item) => item.name === "Team Memory people").include.map((rule) => rule.email.email);

  const added = await teammateAdd({ ...f.options, email: " Mate@Example.com " });
  assert.equal(added.ok, true, JSON.stringify(added));
  assert.equal(added.added, true);
  assert.deepEqual(people(), ["owner@example.com", "mate@example.com"]);
  const writes = f.cf.writes().length;
  assert.equal((await teammateAdd({ ...f.options, email: "mate@example.com" })).added, false);
  assert.equal(f.cf.writes().length, writes, "adding twice writes nothing");

  const listed = await teammatesList(f.options);
  assert.deepEqual(listed, {
    ok: true,
    owner: "owner@example.com",
    people: ["owner@example.com", "mate@example.com"],
    servers: [{ name: "memory", host: "memory.example.com" }],
    shared: [],
    addressText: "memory https://memory.example.com/mcp",
  });

  const removed = await teammateRemove({ ...f.options, email: "mate@example.com" });
  assert.equal(removed.ok, true);
  assert.equal(removed.removed, true);
  assert.deepEqual(people(), ["owner@example.com"]);
  const owner = await teammateRemove({ ...f.options, email: "OWNER@example.com" });
  assert.equal(owner.ok, false);
  assert.match(owner.error, /lock the owner out/);
  assert.deepEqual(people(), ["owner@example.com"]);
  assert.match((await teammateAdd({ ...f.options, email: "not an email" })).error, /takes an email/);
  for (const request of f.cf.requests) assert.equal(request.authorization, `Bearer ${API_TOKEN}`, "the saved token is used");
});

test("teammates add --share makes the teammate's server in Cloudflare and writes the invite to an owner-only file; unshare removes it", async (t) => {
  const f = await ownerFixture(t);
  const inviteFile = path.join(f.root, "alice.invite");
  assert.match((await teammateAdd({ ...f.options, email: "alice@example.com", share: "alice" })).error, /--share needs --invite-out/);
  assert.match((await teammateAdd({ ...f.options, email: "alice@example.com", share: "memory", inviteOut: inviteFile })).error, /name of this server/);
  assert.match((await teammateAdd({ ...f.options, email: "alice@example.com", share: "Alice!", inviteOut: inviteFile })).error, /short name/);

  const added = await teammateAdd({ ...f.options, email: "alice@example.com", share: "alice", inviteOut: inviteFile });
  assert.equal(added.ok, true, JSON.stringify(added));
  assert.equal(added.share.host, "memory-alice.example.com");
  assert.equal(added.inviteFile, inviteFile);
  assert.equal("invite" in added, false, "the invite only goes to the file");
  const tunnel = f.cf.state.tunnels.find((item) => item.name === "team-memory-alice");
  const app = f.cf.state.apps.find((item) => item.domain === "memory-alice.example.com");
  assert.ok(tunnel && app);
  assert.deepEqual(f.cf.state.configurations[tunnel.id].ingress[0], { hostname: "memory-alice.example.com", service: "http://gate:8010" });
  assert.ok(f.cf.state.records.some((record) => record.name === "memory-alice.example.com" && record.content === `${tunnel.id}.cfargotunnel.com`));
  assert.ok(f.cf.state.apps.some((item) => item.domain === "memory-alice.example.com/v3"));
  const peoplePolicy = f.cf.state.policies.find((item) => item.name === "Team Memory people");
  assert.deepEqual(app.policies, [{ id: peoplePolicy.id, precedence: 1 }], "the one people list guards every server");

  const text = await fsp.readFile(inviteFile, "utf8");
  if (process.platform !== "win32") assert.equal((await fsp.stat(inviteFile)).mode & 0o777, 0o600);
  const invite = decodeInvite(text);
  assert.deepEqual(invite, {
    v: 1,
    host: "memory-alice.example.com",
    tunnelToken: f.cf.state.tunnelTokens[tunnel.id],
    teamDomain: TEAM_DOMAIN,
    aud: app.aud,
    team: [{ name: "memory", host: "memory.example.com" }, { name: "alice", host: "memory-alice.example.com" }],
  });
  const team = await fsp.readFile(f.teamFile, "utf8");
  assert.equal(team.includes(invite.tunnelToken), false, "team-access.json holds ids only");
  assert.equal(JSON.stringify(added).includes(invite.tunnelToken), false);

  // For the app: handed back once instead of written.
  const forApp = await teammateAdd({ ...f.options, email: "alice@example.com", share: "alice", returnInvite: true });
  assert.equal(decodeInvite(forApp.invite).host, "memory-alice.example.com");
  assert.equal(f.cf.state.tunnels.filter((item) => !item.deleted_at).length, 2, "the same tunnel again, not a new one");

  await fsp.writeFile(path.join(f.root, "notes"), "my notes\n");
  const refused = await teammateAdd({ ...f.options, email: "alice@example.com", share: "alice", inviteOut: path.join(f.root, "notes") });
  assert.match(refused.error, /already exists and is not an invite/);
  assert.equal(await fsp.readFile(path.join(f.root, "notes"), "utf8"), "my notes\n");

  const listed = await teammatesList(f.options);
  assert.deepEqual(listed.shared, [{ name: "alice", host: "memory-alice.example.com", email: "alice@example.com" }]);
  assert.equal(listed.addressText, "memory https://memory.example.com/mcp\nalice https://memory-alice.example.com/mcp");
  assert.deepEqual(await knownTeamServers(f.options), [{ name: "alice", host: "memory-alice.example.com", url: "https://memory-alice.example.com/mcp", sources: ["team"] }], "the owner's own server is left out");
  const removed = await teammateRemove({ ...f.options, email: "alice@example.com" });
  assert.deepEqual(removed.stillShared, ["alice"], "taking the email off leaves the server to unshare");

  assert.match((await teammateUnshare({ ...f.options, name: "memory" })).error, /server share disable/);
  const unshared = await teammateUnshare({ ...f.options, name: "alice" });
  assert.equal(unshared.ok, true, JSON.stringify(unshared));
  assert.deepEqual(unshared.removed, { peopleApp: true, bypassApp: true, dnsRecords: 1, tunnel: true });
  assert.equal(f.cf.state.apps.some((item) => item.domain.startsWith("memory-alice.")), false);
  assert.equal(f.cf.state.records.some((record) => record.name === "memory-alice.example.com"), false);
  assert.ok(tunnel.deleted_at);
  assert.ok(f.cf.state.apps.some((item) => item.domain === "memory.example.com"), "the owner's server stays");
  assert.deepEqual((await teammatesList(f.options)).shared, []);
  assert.equal((await teammateUnshare({ ...f.options, name: "alice" })).ok, true, "unsharing twice is not an error");
});

test("teammates need the owner's Cloudflare sharing first", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-team-none-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const result = await teammatesList({ serverDirectory: path.join(root, "server"), env: { CLOUDFLARE_API_TOKEN: API_TOKEN } });
  assert.equal(result.ok, false);
  assert.match(result.error, /server share enable --cloudflare first/);
});

async function cli(args, env) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], { env: { ...process.env, ...env } });
    return { code: 0, stdout, stderr, json: JSON.parse(stdout) };
  } catch (error) {
    return { code: error.code, stdout: String(error.stdout), stderr: String(error.stderr), json: JSON.parse(String(error.stdout || "{}")) };
  }
}

test("the CLI never prints the API token, a tunnel token or an invite, and refuses them as arguments", async (t) => {
  const f = await ownerFixture(t);
  const env = {
    HONCHO_AGENT_BRIDGE_SERVER_DIR: f.serverDirectory,
    HONCHO_AGENT_BRIDGE_HOME: path.join(f.root, "app"),
    HONCHO_CLOUDFLARE_API_BASE: f.cf.baseUrl,
    CLOUDFLARE_API_TOKEN: API_TOKEN,
    HONCHO_TUNNEL_TOKEN: "",
    HONCHO_SHARE_INVITE: "",
  };
  const inviteFile = path.join(f.root, "bob.invite");
  const added = await cli(["teammates", "add", "bob@example.com", "--share", "bob", "--invite-out", inviteFile], env);
  assert.equal(added.code, 0, added.stdout);
  assert.equal(added.json.ok, true);
  assert.equal(added.json.share.host, "memory-bob.example.com");
  const invite = (await fsp.readFile(inviteFile, "utf8")).trim();
  const { tunnelToken } = decodeInvite(invite);

  const listed = await cli(["teammates", "list"], { ...env, CLOUDFLARE_API_TOKEN: "" });
  assert.deepEqual(listed.json.people, ["owner@example.com", "bob@example.com"]);
  const removed = await cli(["teammates", "remove", "bob@example.com"], env);
  assert.equal(removed.json.removed, true);
  const unshared = await cli(["teammates", "unshare", "bob"], env);
  assert.equal(unshared.json.ok, true, unshared.stdout);

  const badInvite = path.join(f.root, "bad.invite");
  await fsp.writeFile(badInvite, `${invite.slice(0, -10)}$$$$$$$$$$\n`);
  const join = await cli(["server", "share", "join", "--invite-file", badInvite], env);
  assert.equal(join.json.ok, false);
  assert.match(join.json.error, /not valid/);

  const refusedFlags = [
    ["teammates", "add", "x@example.com", "--api-token", API_TOKEN],
    ["server", "share", "enable", "--cloudflare", "--api-token", API_TOKEN],
    ["server", "share", "join", "--invite", invite],
  ];
  const refused = [];
  for (const args of refusedFlags) {
    const result = await cli(args, env);
    assert.equal(result.json.ok, false);
    assert.match(result.json.error, /not the command line/);
    refused.push(result);
  }
  assert.match((await cli(["teammates", "add", "x@example.com", "--invite-out", inviteFile], env)).json.error, /goes with --share/);

  for (const result of [added, listed, removed, unshared, join, ...refused]) {
    for (const secret of [API_TOKEN, tunnelToken, invite, invite.slice(4, 40)]) {
      assert.equal(result.stdout.includes(secret), false, "stdout");
      assert.equal(result.stderr.includes(secret), false, "stderr");
    }
  }
});

// ------------------------------------------------------- the asking side

test("a team address is a host, https://host or https://host/mcp, and the 팀 주소 text reads back", () => {
  for (const value of ["memory-alice.example.com", " https://Memory-Alice.example.com ", "https://memory-alice.example.com/", "https://memory-alice.example.com/mcp", "https://memory-alice.example.com/mcp/"]) {
    assert.deepEqual(teamAddress(value), { ok: true, host: "memory-alice.example.com", url: "https://memory-alice.example.com/mcp" }, value);
  }
  for (const value of ["", "http://memory-alice.example.com/mcp", "https://memory-alice.example.com:8443/mcp", "https://memory-alice.example.com/mcp?x=1", "https://memory-alice.example.com/other", "https://user:pass@memory-alice.example.com/mcp", "localhost", "https://memory-alice.example.com/mcp#a"]) {
    assert.equal(teamAddress(value).ok, false, value);
  }
  assert.equal(teamAddressText([{ name: "memory", host: "memory.example.com" }, { name: "alice", host: "memory-alice.example.com" }]),
    "memory https://memory.example.com/mcp\nalice https://memory-alice.example.com/mcp");
});

// What 0.6.8 and before left on a teammate's computer: Claude Code and Codex entries
// named team-<name> for each teammate's memory, with Codex's approval of chat beside
// each. The clients' CLIs are stood in for, editing the same files the real ones do.
// `codex mcp remove` takes the entry's sub-tables with it, as 0.154 and 0.160 do; with
// `keepsTools` it leaves them. A client in `failing` refuses to remove anything.
const HUB_ZONE_HOST = "memory-dave.example.net";
const CODEX_BASE = 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "other"\n';

async function clientFixture(t, { missing = [], keepsTools = false, failing = [], claude = {}, codex = "", share = null, hub = null } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-team-clients-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  await fsp.mkdir(path.join(home, ".codex"), { recursive: true });
  const claudeFile = path.join(home, ".claude.json");
  const codexFile = path.join(home, ".codex", "config.toml");
  await fsp.writeFile(claudeFile, JSON.stringify({ numStartups: 3, mcpServers: { other: { type: "stdio", command: "other" }, ...claude } }, null, 2));
  await fsp.writeFile(codexFile, CODEX_BASE + codex);
  const runtime = path.join(root, "app", "runtime");
  await fsp.mkdir(runtime, { recursive: true });
  if (share) await fsp.writeFile(path.join(runtime, "share.json"), JSON.stringify(share));
  const authFile = path.join(root, "state", "team-auth.json");
  if (hub) {
    await fsp.mkdir(path.dirname(authFile), { recursive: true });
    await fsp.writeFile(authFile, JSON.stringify({ version: 1, hub, email: "bob@example.com" }));
  }
  const calls = [];
  const clientRunner = async (client, args) => {
    calls.push([client, ...args]);
    if (missing.includes(client)) return { missing: true };
    if (failing.includes(client)) return { code: 1, stdout: "", stderr: `${client} could not write its config\n` };
    if (client === "claude") {
      const document = JSON.parse(await fsp.readFile(claudeFile, "utf8"));
      delete document.mcpServers[args[2]];
      await fsp.writeFile(claudeFile, JSON.stringify(document, null, 2));
    } else {
      let text = await fsp.readFile(codexFile, "utf8");
      const name = args[2];
      const tables = keepsTools ? `\\[mcp_servers\\.${name}\\]` : `\\[mcp_servers\\.${name}(?:\\.[^\\]]+)?\\]`;
      const table = new RegExp(`\\n${tables}\\n[^\\[]*`);
      while (table.test(text)) text = text.replace(table, "\n");
      await fsp.writeFile(codexFile, text);
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const options = {
    homeDir: home,
    env: {},
    clientRunner,
    serverDirectory: path.join(root, "app", "server"),
    authPaths: { authFile, pendingFile: path.join(path.dirname(authFile), "team-login.json"), lockFile: `${authFile}.lock` },
  };
  return { root, home, claudeFile, codexFile, calls, options };
}

const BOB_SHARE = {
  host: "memory-bob.example.com",
  joined: true,
  team: [{ name: "memory", host: "memory.example.com" }, { name: "bob", host: "memory-bob.example.com" }, { name: "alice", host: "memory-alice.example.com" }],
};

async function claudeServers(f) {
  return JSON.parse(await fsp.readFile(f.claudeFile, "utf8")).mcpServers;
}

test("the team-<name> entries this app made go from Claude Code and Codex, with Codex's approval; the user's own stay", async (t) => {
  const f = await clientFixture(t, {
    share: BOB_SHARE,
    hub: "team.example.net",
    claude: {
      "team-alice": { type: "http", url: "https://memory-alice.example.com/mcp" },
      "team-memory": { type: "http", url: "https://memory.example.com/mcp" },
      "team-bob": { type: "http", url: "https://memory-bob.example.com/mcp" },
      "team-dave": { type: "http", url: `https://${HUB_ZONE_HOST}/mcp` },
      "team-tools": { type: "http", url: "https://tools.example.org/mcp" },
      "team-sse": { type: "sse", url: "https://memory-alice.example.com/sse" },
      "team-local": { type: "stdio", command: "local" },
      "alice": { type: "http", url: "https://memory-alice.example.com/mcp" },
    },
    codex: [
      "", "[mcp_servers.team-alice]", 'url = "https://memory-alice.example.com/mcp"',
      "", "[mcp_servers.team-alice.tools.chat]", 'approval_mode = "approve"',
      "", "[mcp_servers.team-dave]", `url = "https://${HUB_ZONE_HOST}/mcp"`,
      "", "[mcp_servers.team-tools]", 'url = "https://tools.example.org/mcp"', "",
    ].join("\n"),
  });
  const result = await dropTeamEntries(f.options);
  assert.deepEqual(result, { ok: true, removed: { claude: ["team-alice", "team-memory", "team-bob", "team-dave"], codex: ["team-alice", "team-dave"] } });
  assert.deepEqual(f.calls, [
    ["claude", "mcp", "remove", "team-alice", "--scope", "user"],
    ["claude", "mcp", "remove", "team-memory", "--scope", "user"],
    ["claude", "mcp", "remove", "team-bob", "--scope", "user"],
    ["claude", "mcp", "remove", "team-dave", "--scope", "user"],
    ["codex", "mcp", "remove", "team-alice"],
    ["codex", "mcp", "remove", "team-dave"],
  ], "a teammate's server, this computer's own, and any server under the team hub's zone");
  assert.deepEqual(Object.keys(await claudeServers(f)), ["other", "team-tools", "team-sse", "team-local", "alice"],
    "another host, another address on a team host, no address at all, and a name of the user's own stay");
  assert.equal(await fsp.readFile(f.codexFile, "utf8"), `${CODEX_BASE}\n[mcp_servers.team-tools]\nurl = "https://tools.example.org/mcp"\n`);

  f.calls.length = 0;
  assert.deepEqual(await dropTeamEntries(f.options), { ok: true, removed: { claude: [], codex: [] } });
  assert.deepEqual(f.calls, [], "once they are gone nothing runs");
});

test("without a team on this computer no entry is ours, and the team servers it knows come from its own files", async (t) => {
  const f = await clientFixture(t, {
    claude: { "team-alice": { type: "http", url: "https://memory-alice.example.com/mcp" } },
    codex: '\n[mcp_servers.team-alice]\nurl = "https://memory-alice.example.com/mcp"\n',
  });
  assert.deepEqual(await dropTeamEntries(f.options), { ok: true, removed: { claude: [], codex: [] } });
  assert.deepEqual(f.calls, []);

  const runtime = path.join(f.root, "app", "runtime");
  await fsp.writeFile(path.join(runtime, "share.json"), JSON.stringify(BOB_SHARE));
  assert.deepEqual((await knownTeamServers(f.options)).map((item) => [item.name, item.sources]), [["memory", ["invite"]], ["alice", ["invite"]]],
    "the invite's team, this computer's own server left out");
  await fsp.writeFile(path.join(runtime, "team-access.json"), JSON.stringify({
    version: 1,
    owner: { name: "memory", host: "memory.example.com" },
    sharers: { carol: { host: "memory-carol.example.com", email: "carol@example.com" } },
  }));
  assert.deepEqual((await knownTeamServers(f.options)).map((item) => [item.name, item.sources]), [["memory", ["invite", "team"]], ["alice", ["invite"]], ["carol", ["team"]]],
    "and the owner's list");
  assert.deepEqual(await dropTeamEntries(f.options), { ok: true, removed: { claude: ["team-alice"], codex: ["team-alice"] } });
});

test("Codex's approval table goes when its remove leaves it behind, and stays when it holds more than connecting wrote", async (t) => {
  const f = await clientFixture(t, {
    keepsTools: true,
    share: BOB_SHARE,
    codex: [
      "", "[mcp_servers.team-alice]", 'url = "https://memory-alice.example.com/mcp"',
      "", "[mcp_servers.team-alice.tools.chat]", 'approval_mode = "approve"', "# mine",
      "", "[mcp_servers.team-memory]", 'url = "https://memory.example.com/mcp"',
      "", "[mcp_servers.team-memory.tools.chat]", 'approval_mode = "approve"', "enabled = false", "",
    ].join("\n"),
  });
  assert.deepEqual(await dropTeamEntries(f.options), { ok: true, removed: { claude: [], codex: ["team-alice", "team-memory"] } });
  assert.equal(await fsp.readFile(f.codexFile, "utf8"),
    `${CODEX_BASE}# mine\n[mcp_servers.team-memory.tools.chat]\napproval_mode = "approve"\nenabled = false\n`,
    "a comment of the user's stays where it was, and a table with a setting of their own is theirs");
});

test("a client that is not on this computer is left as it is, and one that fails is named while the other is still cleaned", async (t) => {
  const entries = {
    share: BOB_SHARE,
    claude: { "team-alice": { type: "http", url: "https://memory-alice.example.com/mcp" } },
    codex: '\n[mcp_servers.team-alice]\nurl = "https://memory-alice.example.com/mcp"\n',
  };
  const noCodex = await clientFixture(t, { ...entries, missing: ["codex"] });
  assert.deepEqual(await dropTeamEntries(noCodex.options), { ok: true, removed: { claude: ["team-alice"], codex: [] } });
  assert.match(await fsp.readFile(noCodex.codexFile, "utf8"), /team-alice/, "without a codex CLI its config is not written");

  const failing = await clientFixture(t, { ...entries, failing: ["claude"] });
  assert.deepEqual(await dropTeamEntries(failing.options), {
    ok: false,
    removed: { claude: [], codex: ["team-alice"] },
    failed: [{ client: "claude", entry: "team-alice", error: "claude could not write its config" }],
  });
  assert.ok((await claudeServers(failing))["team-alice"]);
});

test("the CLI's teammates drop-entries goes through the real client commands on PATH", { skip: process.platform === "win32" }, async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-team-cli-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  await fsp.mkdir(path.join(home, ".codex"), { recursive: true });
  await fsp.mkdir(bin);
  const log = path.join(root, "calls.log");
  // Stand-ins for claude and codex that record their arguments and edit the same files the real ones do.
  const shim = (client) => `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify([${JSON.stringify(client)}, ...args]) + "\\n");
const home = process.env.HOME;
if (${JSON.stringify(client)} === "claude") {
  const file = path.join(home, ".claude.json");
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  if (args[1] === "remove") delete doc.mcpServers[args[2]];
  fs.writeFileSync(file, JSON.stringify(doc));
} else {
  const file = path.join(home, ".codex", "config.toml");
  const text = fs.readFileSync(file, "utf8");
  const at = args[1] === "remove" ? text.indexOf("[mcp_servers." + args[2] + "]") : -1;
  if (at >= 0) fs.writeFileSync(file, text.slice(0, at));
}
`;
  for (const client of ["claude", "codex"]) await fsp.writeFile(path.join(bin, client), shim(client), { mode: 0o755 });
  await fsp.writeFile(path.join(home, ".claude.json"), JSON.stringify({ mcpServers: {
    "team-alice": { type: "http", url: `https://${HUB_ZONE_HOST}/mcp` },
    "team-tools": { type: "http", url: "https://tools.example.org/mcp" },
  } }));
  await fsp.writeFile(path.join(home, ".codex", "config.toml"), `${CODEX_BASE}\n[mcp_servers.team-alice]\nurl = "https://${HUB_ZONE_HOST}/mcp"\n`);
  const authFile = path.join(root, "state", "team-auth.json");
  await fsp.mkdir(path.dirname(authFile), { recursive: true });
  await fsp.writeFile(authFile, JSON.stringify({ version: 1, hub: "team.example.net", email: "bob@example.com" }));
  const env = {
    PATH: bin,
    HOME: home,
    HONCHO_AGENT_BRIDGE_USER_HOME: home,
    HONCHO_AGENT_BRIDGE_HOME: path.join(root, "app"),
    HONCHO_AGENT_BRIDGE_SERVER_DIR: path.join(root, "app", "server"),
    HONCHO_AGENT_TEAM_AUTH: authFile,
    CLAUDE_CONFIG_DIR: "",
    CODEX_HOME: "",
  };
  const dropped = await cli(["teammates", "drop-entries"], env);
  assert.equal(dropped.code, 0, dropped.stdout + dropped.stderr);
  assert.deepEqual(dropped.json, { ok: true, removed: { claude: ["team-alice"], codex: ["team-alice"] } });
  const calls = (await fsp.readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(calls, [["claude", "mcp", "remove", "team-alice", "--scope", "user"], ["codex", "mcp", "remove", "team-alice"]]);
  assert.deepEqual(Object.keys(JSON.parse(await fsp.readFile(path.join(home, ".claude.json"), "utf8")).mcpServers), ["team-tools"]);
  assert.equal(await fsp.readFile(path.join(home, ".codex", "config.toml"), "utf8"), `${CODEX_BASE}\n`);
});
