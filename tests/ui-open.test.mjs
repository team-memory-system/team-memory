// `ui open` starts the app's screen once, detached, in the app home, and reuses it; it
// tells it apart from another program on the same port by the page's marker, or by
// what an app whose pages went with its plugin folder says of itself, and replaces
// that one, but stops no program other than node. `bridge disconnect` clears what the
// shared bridge of 0.3.28 and before left in the configuration.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "scripts", "cli.mjs");

async function workspace(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-ui-open-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "user");
  const appHome = path.join(root, "app");
  await fsp.mkdir(home, { recursive: true });
  const env = { HONCHO_AGENT_BRIDGE_HOME: appHome, HONCHO_AGENT_BRIDGE_USER_HOME: home, HOME: home, USERPROFILE: home };
  for (const name of ["HONCHO_MCP_BEARER_TOKEN", "CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET", "HONCHO_AGENT_BRIDGE_CONFIG"]) env[name] = "";
  return { root, appHome, configPath: path.join(appHome, "config.json"), env };
}

async function freePort() {
  const probe = http.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(() => resolve()));
  return port;
}

// The app of an older copy whose plugin folder an update took away: its page is not
// found, and it still says what it is.
const PAGELESS_APP = `import http from "node:http";
http.createServer((request, response) => {
  response.setHeader("content-type", "application/json");
  if (request.url === "/api/app/context") return response.end(JSON.stringify({ ok: true, version: "0.0.1", configured: true, workspace: "memory", agents: { codex: true, claude: false } }));
  response.statusCode = 404;
  response.end(JSON.stringify({ error: "Not found" }));
}).listen(Number(process.env.PAGELESS_PORT), "127.0.0.1", () => process.stdout.write("ready\\n"));
`;

// The old app is found with lsof, as a process of its own, as it is on a computer.
const NO_LSOF = !["/usr/sbin/lsof", "/usr/bin/lsof"].some((file) => fs.existsSync(file));

/**
 * This node under another name, which lsof gives as the process's command: a program
 * that answers on the port for another computer's app (an SSH forward, say), without
 * starting one. A node that loads its library from beside it (Homebrew's) has it
 * copied too. Null where the copy does not run.
 */
async function otherProgram(root, name) {
  const real = await fsp.realpath(process.execPath);
  const program = path.join(root, "bin", name);
  await fsp.mkdir(path.dirname(program), { recursive: true });
  await fsp.copyFile(real, program, fs.constants.COPYFILE_FICLONE);
  const lib = path.join(path.dirname(real), "..", "lib");
  for (const file of (await fsp.readdir(lib).catch(() => [])).filter((item) => item.startsWith("libnode"))) {
    await fsp.mkdir(path.join(root, "lib"), { recursive: true });
    await fsp.copyFile(path.join(lib, file), path.join(root, "lib", file), fs.constants.COPYFILE_FICLONE);
  }
  return execFileAsync(program, ["-e", ""]).then(() => program, () => null);
}

/** `script` run by `program` on `port`, once it listens. */
async function serve(t, program, script, port) {
  const child = spawn(program, [script], { env: { ...process.env, PAGELESS_PORT: String(port) }, stdio: ["ignore", "pipe", "ignore"] });
  t.after(() => { try { process.kill(child.pid); } catch {} });
  await new Promise((resolve, reject) => { child.stdout.once("data", resolve); child.once("exit", reject); });
  return child;
}

async function cli(args, env) {
  const merged = { ...process.env, ...env };
  for (const [name, value] of Object.entries(env)) if (value === "") delete merged[name];
  try {
    const { stdout } = await execFileAsync(process.execPath, [CLI, ...args], { env: merged, timeout: 60_000 });
    return { stdout, body: JSON.parse(stdout) };
  } catch (error) {
    if (!error.stdout) throw error;
    return { stdout: error.stdout, body: JSON.parse(error.stdout) };
  }
}

test("bridge disconnect removes a configuration that only held the old shared bridge", async (t) => {
  const { appHome, configPath, env } = await workspace(t);
  await fsp.mkdir(appHome, { recursive: true });
  // What `bridge connect` of 0.3.28 and before wrote on a computer that never ran setup.
  await fsp.writeFile(configPath, JSON.stringify({
    version: 1,
    honcho: { mcpBridgeUrl: "https://bridge.example.com/mcp", mcpBridgeToken: "old-bridge-token", accessClientId: "bridge-id", accessClientSecret: "bridge-secret" },
    agents: { codex: false, claude: false },
  }, null, 2));

  const { body } = await cli(["bridge", "disconnect"], env);
  assert.equal(body.ok, true, JSON.stringify(body));
  assert.equal(body.changed, true);
  assert.equal(body.removedConfig, true);
  await assert.rejects(fsp.access(configPath));

  const again = await cli(["bridge", "disconnect"], env);
  assert.equal(again.body.ok, true);
  assert.equal(again.body.changed, false);
});

test("ui open starts one detached setup screen and reuses it", async (t) => {
  const { env } = await workspace(t);
  const probe = http.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(() => resolve()));
  const uiEnv = { ...env, HONCHO_AGENT_BRIDGE_UI_PORT: String(port) };

  const first = await cli(["ui", "open", "--no-browser"], uiEnv);
  t.after(() => { try { process.kill(first.body.pid); } catch {} });
  assert.equal(first.body.ok, true, first.stdout);
  assert.equal(first.body.started, true);
  assert.equal(first.body.url, `http://127.0.0.1:${port}`);
  assert.deepEqual(first.body.autostart, { registered: false, skipped: "this run has its own app home" }, "a test's app is not this user's login item");

  const page = await fetch(`http://127.0.0.1:${port}/`);
  assert.match(await page.text(), /id="team-memory-app"/, "it outlived the command that started it");

  const second = await cli(["ui", "open", "--no-browser"], uiEnv);
  assert.equal(second.body.ok, true);
  assert.equal(second.body.started, false, "a running screen is reused, not doubled");

  const onScreen = await cli(["ui", "open", "--screen", "models", "--no-browser"], uiEnv);
  assert.equal(onScreen.body.ok, true);
  assert.match(onScreen.body.url, /#\/models$/, "--screen opens the app on that screen");
  const link = await cli(["ui", "open", "--screen", "start?team=team.example.com", "--no-browser"], uiEnv);
  assert.equal(link.body.ok, true);
  assert.equal(link.body.url, `http://127.0.0.1:${port}/#/start?team=team.example.com`, "the address the agent says is the team's link");
  const bad = await cli(["ui", "open", "--screen", "x?y=1", "--no-browser"], uiEnv);
  assert.equal(bad.body.ok, false);
});

test("ui open writes the login autostart for the app it started, with a PATH that works outside this terminal", { skip: process.platform !== "darwin" }, async (t) => {
  const { env } = await workspace(t);
  const home = env.HOME;
  const probe = http.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(() => resolve()));
  // This user's own install: no app home of its own, so the app's is under the (test's) home.
  const userEnv = { ...env, HONCHO_AGENT_BRIDGE_HOME: "", HONCHO_AGENT_BRIDGE_UI_PORT: String(port), PATH: `/Applications/cmux.app/Contents/Resources/bin:${process.env.PATH}` };

  const opened = await cli(["ui", "open", "--no-browser"], userEnv);
  t.after(() => { try { process.kill(opened.body.pid); } catch {} });
  assert.equal(opened.body.ok, true, opened.stdout);
  const plistPath = path.join(home, "Library", "LaunchAgents", "team-memory-system.app.plist");
  assert.deepEqual(opened.body.autostart, { registered: true, kind: "launchd", path: plistPath, changed: true });
  const plist = await fsp.readFile(plistPath, "utf8");
  assert.ok(plist.includes(`<string>${path.join(ROOT, "scripts", "ui.mjs")}</string>`), plist);
  assert.ok(plist.includes(`<key>WorkingDirectory</key>\n\t<string>${path.join(home, "Library", "Application Support", "HonchoAgentBridge")}</string>`), plist);
  assert.ok(plist.includes(`<key>HONCHO_AGENT_BRIDGE_UI_PORT</key>\n\t\t<string>${port}</string>`), plist);
  assert.doesNotMatch(plist, /cmux/);

  const again = await cli(["ui", "open", "--no-browser"], userEnv);
  assert.equal(again.body.started, false);
  assert.equal(again.body.autostart, undefined, "only an app this started is written down");
});

test("ui open does not mistake another program on its port for the setup screen", async (t) => {
  const { env } = await workspace(t);
  const other = http.createServer((request, response) => response.end("<html>something else</html>"));
  await new Promise((resolve) => other.listen(0, "127.0.0.1", resolve));
  t.after(() => other.close());

  const { body } = await cli(["ui", "open", "--no-browser"], { ...env, HONCHO_AGENT_BRIDGE_UI_PORT: String(other.address().port) });
  assert.equal(body.ok, false);
  assert.match(body.error, /Something else is answering/);
});

test("ui open replaces an app of ours whose pages went with its plugin folder, and starts the new one in the app home", { skip: NO_LSOF }, async (t) => {
  const { root, appHome, env } = await workspace(t);
  const port = await freePort();
  const script = path.join(root, "pageless-app.mjs");
  await fsp.writeFile(script, PAGELESS_APP);
  const old = await serve(t, process.execPath, script, port);
  const gone = new Promise((resolve) => old.once("exit", resolve));

  // Plain ui open, as /team-memory setup runs it: not only doctor --fix replaces it.
  const opened = await cli(["ui", "open", "--no-browser"], { ...env, HONCHO_AGENT_BRIDGE_UI_PORT: String(port) });
  t.after(() => { try { process.kill(opened.body.pid); } catch {} });
  assert.equal(opened.body.ok, true, opened.stdout);
  assert.deepEqual([opened.body.started, opened.body.replaced], [true, "0.0.1"]);
  await gone;
  const page = await fetch(`http://127.0.0.1:${port}/`);
  assert.match(await page.text(), /id="team-memory-app"/, "this copy's app answers in its place");
  if (process.platform === "darwin") {
    // The working folder of the app it started, by its pid.
    const { stdout } = await execFileAsync("/usr/sbin/lsof", ["-a", "-p", String(opened.body.pid), "-d", "cwd", "-Fn"]);
    assert.equal(stdout.split("\n").find((line) => line.startsWith("n"))?.slice(1), await fsp.realpath(appHome));
  }
});

test("ui open stops no program but node on its port, such as an SSH forward to another computer's app", { skip: NO_LSOF }, async (t) => {
  const { root, env } = await workspace(t);
  const ssh = await otherProgram(root, "ssh");
  if (!ssh) return t.skip("a copy of node does not run from another folder here");
  const port = await freePort();
  const script = path.join(root, "pageless-app.mjs");
  await fsp.writeFile(script, PAGELESS_APP);
  const forward = await serve(t, ssh, script, port);

  const opened = await cli(["ui", "open", "--no-browser"], { ...env, HONCHO_AGENT_BRIDGE_UI_PORT: String(port) });
  // An app it started in the forward's place, were it to, is stopped with the test.
  t.after(() => { try { if (opened.body.pid) process.kill(opened.body.pid); } catch {} });
  assert.equal(opened.body.ok, false, opened.stdout);
  assert.match(opened.body.error, /^Something else is answering at /);
  assert.equal(forward.exitCode, null, "it was not stopped");
  const context = await (await fetch(`http://127.0.0.1:${port}/api/app/context`)).json();
  assert.equal(context.version, "0.0.1", "and it still answers");
});
