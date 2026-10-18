// The app comes back after a reboot: `ui open` writes a login autostart for the app it
// started, which starts nothing now (the app is running) and is never restarted (so
// doctor can swap the app), with a PATH that works outside the terminal it came from,
// in the app home rather than the plugin folder a plugin update replaces.
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { APP_LAUNCHD_LABEL, APP_RUN_VALUE, APP_SYSTEMD_UNIT, appEnvironment, registerAppAutostart, stableNode } from "../scripts/app-autostart.mjs";

const SCRIPT_DIR = "/Users/ana/.claude/plugins/cache/team-memory/team-memory/0.8.7/scripts";
const CELLAR_NODE = "/opt/homebrew/Cellar/node/26.8.1/bin/node";
// The PATH of an agent's terminal in cmux, as `ui open` gets it.
const TERMINAL_PATH = [
  "/Applications/cmux.app/Contents/Resources/bin",
  "/Users/ana/.cmuxterm/cmux-cli-shims",
  "/Users/ana/.local/bin",
  "/var/folders/xy/T/claude-shims",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/opt/homebrew/bin",
  "/Users/ana/.local/bin",
  "relative/bin",
].join(":");

async function fixture(t, platform) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "app-autostart-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const calls = [];
  const run = async (command, args) => {
    calls.push([String(command).split(/[\\/]/).pop(), ...args]);
    return { code: 0, stdout: "", stderr: "" };
  };
  const homeDir = path.join(root, "home");
  const appHome = path.join(root, "app");
  const env = {
    PATH: TERMINAL_PATH,
    HOME: "/Users/ana",
    LANG: "ko_KR.UTF-8",
    HONCHO_AGENT_BRIDGE_UI_HOST: "127.0.0.1",
    HONCHO_AGENT_BRIDGE_UI_PORT: "4180",
    HONCHO_AGENT_BRIDGE_TEAM_TOKEN: "secret",
    CLOUDFLARE_API_TOKEN: "secret",
    SystemRoot: "C:\\Windows",
  };
  // Homebrew's link to the versioned node.
  const realpath = (target) => {
    if (target === "/opt/homebrew/bin/node" || target === CELLAR_NODE) return CELLAR_NODE;
    throw Object.assign(new Error("missing"), { code: "ENOENT" });
  };
  const register = () => registerAppAutostart({
    scriptDir: SCRIPT_DIR, nodePath: CELLAR_NODE, appHome, env, platform, homeDir, uid: 501, run, realpath, tmpdir: "/var/folders/xy/T",
  });
  return { root, calls, homeDir, appHome, env, register };
}

test("the login keeps the PATH without cmux's folders or the temp folder, and no credential", () => {
  const environment = appEnvironment({
    PATH: TERMINAL_PATH, LANG: "ko_KR.UTF-8", HONCHO_AGENT_BRIDGE_UI_PORT: "4180", HONCHO_AGENT_BRIDGE_TEAM_TOKEN: "secret", OPENAI_API_KEY: "secret",
  }, { platform: "darwin", homeDir: "/Users/ana", tmpdir: "/var/folders/xy/T" });
  assert.deepEqual(environment, {
    PATH: "/Users/ana/.local/bin:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin",
    HOME: "/Users/ana",
    LANG: "ko_KR.UTF-8",
    HONCHO_AGENT_BRIDGE_UI_PORT: "4180",
  });
  // Windows gives a logon the user's own PATH.
  assert.deepEqual(appEnvironment({ Path: "C:\\nodejs", HONCHO_AGENT_BRIDGE_UI_PORT: "4180" }, { platform: "win32", homeDir: "C:\\Users\\ana" }), { HONCHO_AGENT_BRIDGE_UI_PORT: "4180" });
});

test("a Homebrew node is started through its link on the PATH, which outlives the next upgrade", () => {
  const realpath = (target) => {
    if (target === "/opt/homebrew/bin/node" || target === CELLAR_NODE) return CELLAR_NODE;
    if (target === "/usr/local/bin/node") return "/usr/local/Cellar/node/20.0.0/bin/node";
    throw new Error("missing");
  };
  assert.equal(stableNode(CELLAR_NODE, "/usr/local/bin:/opt/homebrew/bin", { platform: "darwin", realpath }), "/opt/homebrew/bin/node");
  assert.equal(stableNode(CELLAR_NODE, "/usr/local/bin", { platform: "darwin", realpath }), CELLAR_NODE, "no link to the same file: the node itself");
});

test("macOS: a LaunchAgent that starts this copy at login, written only, never restarted", async (t) => {
  const f = await fixture(t, "darwin");
  const first = await f.register();
  const plistPath = path.join(f.homeDir, "Library", "LaunchAgents", `${APP_LAUNCHD_LABEL}.plist`);
  assert.deepEqual(first, { registered: true, kind: "launchd", path: plistPath, changed: true });
  assert.deepEqual(f.calls, [], "launchd reads the file at the next login; nothing is started now");
  const plist = await fsp.readFile(plistPath, "utf8");
  for (const piece of [
    "<key>Label</key>\n\t<string>team-memory-system.app</string>",
    `<key>ProgramArguments</key>\n\t<array>\n\t\t<string>/opt/homebrew/bin/node</string>\n\t\t<string>${SCRIPT_DIR}/ui.mjs</string>\n\t</array>`,
    "<key>RunAtLoad</key>\n\t<true/>",
    "<key>AbandonProcessGroup</key>\n\t<true/>",
    `<key>WorkingDirectory</key>\n\t<string>${f.appHome}</string>`,
    "<key>PATH</key>\n\t\t<string>/Users/ana/.local/bin:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>",
    "<key>HONCHO_AGENT_BRIDGE_UI_PORT</key>\n\t\t<string>4180</string>",
    `<key>StandardErrorPath</key>\n\t<string>${path.join(f.appHome, "runtime", "app", "app.error.log")}</string>`,
  ]) assert.ok(plist.includes(piece), `${piece}\n---\n${plist}`);
  assert.doesNotMatch(plist, /KeepAlive/, "doctor can stop it for a newer copy without launchd bringing it back");
  assert.doesNotMatch(plist, /secret|cmux/);

  assert.equal((await f.register()).changed, false, "the same copy again changes nothing");
});

test("Windows: a Run value whose script starts this copy hidden, with the app's settings", async (t) => {
  const f = await fixture(t, "win32");
  const vbsPath = path.join(f.appHome, "runtime", "app", "app.vbs");
  assert.deepEqual(await f.register(), { registered: true, kind: "windows-run", path: vbsPath, changed: true });
  assert.deepEqual(f.calls, [[
    "reg.exe", "add", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "/v", APP_RUN_VALUE, "/t", "REG_SZ", "/d",
    `"C:\\Windows\\System32\\wscript.exe" //B //NoLogo "${vbsPath}"`, "/f",
  ]], "registered for the next logon; nothing is started now");
  const vbs = (await fsp.readFile(vbsPath)).subarray(2).toString("utf16le");
  assert.ok(vbs.includes('shell.Environment("PROCESS")("HONCHO_AGENT_BRIDGE_UI_PORT") = "4180"'), vbs);
  assert.ok(vbs.includes(`shell.Run "${CELLAR_NODE} ${SCRIPT_DIR}/ui.mjs", 0, False`), vbs);
  assert.ok(vbs.includes(`shell.CurrentDirectory = "${f.appHome}"`), vbs);
  assert.doesNotMatch(vbs, /secret|PATH/);
});

test("Linux: a user unit enabled for the next login, not started now and not restarted", async (t) => {
  const f = await fixture(t, "linux");
  const unitPath = path.join(f.homeDir, ".config", "systemd", "user", APP_SYSTEMD_UNIT);
  assert.deepEqual(await f.register(), { registered: true, kind: "systemd", path: unitPath, changed: true });
  assert.deepEqual(f.calls, [["systemctl", "--user", "daemon-reload"], ["systemctl", "--user", "enable", APP_SYSTEMD_UNIT]]);
  const unit = await fsp.readFile(unitPath, "utf8");
  for (const line of ["Restart=no", "KillMode=process", `ExecStart="/opt/homebrew/bin/node" "${SCRIPT_DIR}/ui.mjs"`, `WorkingDirectory=${f.appHome}\n`]) assert.ok(unit.includes(line), unit);
  f.calls.length = 0;
  await f.register();
  assert.deepEqual(f.calls, [["systemctl", "--user", "enable", APP_SYSTEMD_UNIT]]);
});

test("a run with its own app home leaves this user's login alone, and a failure never stops the app", async (t) => {
  const f = await fixture(t, "linux");
  assert.deepEqual(await registerAppAutostart({ scriptDir: SCRIPT_DIR, env: { HONCHO_AGENT_BRIDGE_HOME: f.appHome }, homeDir: f.homeDir }),
    { registered: false, skipped: "this run has its own app home" });
  const failed = await registerAppAutostart({
    scriptDir: SCRIPT_DIR, appHome: f.appHome, env: f.env, platform: "linux", homeDir: f.homeDir,
    run: async () => ({ code: 1, stdout: "", stderr: "Failed to connect to bus" }),
  });
  assert.deepEqual(failed, { registered: false, kind: "systemd", error: "systemctl --user daemon-reload failed: Failed to connect to bus" });
});
