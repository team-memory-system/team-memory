// The app's own login autostart, so the app is back after a reboot without anyone
// opening it on this computer. Another computer shows this one's screens through it
// (viewer.mjs), and until someone did, that computer could only say it was unreachable.
//
//   launchd      ~/Library/LaunchAgents/team-memory-system.app.plist (RunAtLoad,
//                no KeepAlive)
//   windows-run  the value "TeamMemoryApp" under HKCU\...\CurrentVersion\Run, which
//                runs <app home>/runtime/app/app.vbs through a hidden wscript at logon
//   systemd      ~/.config/systemd/user/team-memory-app.service, enabled for the next
//                login (Restart=no)
//
// `ui open` writes it each time it starts the app, with what it started: a node, that
// copy's ui.mjs and the settings the app ran with. Nothing is started through it then,
// since the app `ui open` started is running already; the next login starts the copy
// `ui open` started last. Nothing starts the app again after it exits either, so
// `doctor` can swap it for a newer copy without the old one coming back on its port.
//
// launchd needs no call: it reads the file at the next login. reg and systemctl go
// through `ctx.run` (autostart.mjs), which refuses them under `node --test`.
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { failure, launchAgent, registerWindowsRun, runCommand, systemdUnit, windowsRun, writeIfChanged } from "./autostart.mjs";
import { defaultAppHome } from "./config.mjs";

export const APP_LAUNCHD_LABEL = "team-memory-system.app";
export const APP_RUN_VALUE = "TeamMemoryApp";
export const APP_SYSTEMD_UNIT = "team-memory-app.service";

// Folders on a PATH that belong to one cmux terminal: its per-terminal shims, and the
// app's own bin, whose `open` and agent wrappers work only inside cmux.
const TERMINAL_ONLY = /(?:^|[\\/])(?:\.cmuxterm|cmux\.app)(?:[\\/]|$)/i;
const CREDENTIAL = /(?:KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL)/i;

function inside(entry, folders) {
  return folders.some((folder) => entry === folder || entry.startsWith(`${folder}${path.sep}`));
}

/**
 * The environment the app runs with after a login, from the one `ui open` started it
 * with. A login has no terminal to take a PATH from, and the app runs docker, claude
 * and codex through it, so the PATH is written down, less what belongs to one
 * terminal: cmux's folders and anything in the temp folder. Windows gives a logon the
 * user's own PATH, so there it is left out. Of the rest only this app's own
 * HONCHO_AGENT_BRIDGE_* settings come along, and none named like a credential.
 */
export function appEnvironment(env, { platform = process.platform, homeDir, tmpdir = os.tmpdir() } = {}) {
  const output = {};
  if (platform !== "win32") {
    const temp = [path.resolve(tmpdir)];
    try { temp.push(fs.realpathSync(tmpdir)); } catch {}
    const entries = String(env.PATH || "").split(":")
      .filter((entry) => path.isAbsolute(entry) && !TERMINAL_ONLY.test(entry) && !inside(path.resolve(entry), temp));
    output.PATH = [...new Set(entries)].join(":") || "/usr/bin:/bin:/usr/sbin:/sbin";
    if (homeDir) output.HOME = homeDir;
    for (const name of ["LANG", "LC_ALL"]) if (env[name]) output[name] = env[name];
  }
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("HONCHO_AGENT_BRIDGE_") && !CREDENTIAL.test(key)
      && typeof value === "string" && value && !/[\r\n]/.test(value)) output[key] = value;
  }
  return output;
}

/**
 * The node the next login starts the app with. Homebrew's node runs from a folder
 * named for its version (/opt/homebrew/Cellar/node/26.8.1/bin/node) that the next
 * upgrade removes, so a link on the PATH to the same file (/opt/homebrew/bin/node) is
 * written instead when there is one.
 */
export function stableNode(execPath, pathValue, { platform = process.platform, realpath = fs.realpathSync } = {}) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  let real;
  try { real = realpath(execPath); } catch { return execPath; }
  for (const folder of String(pathValue || "").split(platform === "win32" ? ";" : ":")) {
    if (!folder || !paths.isAbsolute(folder)) continue;
    const candidate = paths.join(folder, platform === "win32" ? "node.exe" : "node");
    try { if (realpath(candidate) === real) return candidate; } catch {}
  }
  return execPath;
}

/** The app's login autostart on this platform, or null where there is none. */
export function appAutostartSpec(ctx, { nodePath, scriptDir, environment, runtimeDir }) {
  const programArguments = [nodePath, path.join(scriptDir, "ui.mjs")];
  // What node prints when it cannot run the app at all (its copy gone, say).
  const errorLog = path.join(runtimeDir, "app.error.log");
  const written = "Written by `cli.mjs ui open` each time it starts the app.";
  if (ctx.platform === "darwin") {
    return launchAgent({
      label: APP_LAUNCHD_LABEL,
      homeDir: ctx.homeDir,
      uid: ctx.uid,
      programArguments,
      workingDirectory: scriptDir,
      stderrPath: errorLog,
      keepAlive: null,
      // What the app started (a server start it ran, say) outlives it, as it does
      // when `ui open` started the app.
      abandonProcessGroup: true,
      environment,
    });
  }
  if (ctx.platform === "win32") {
    return windowsRun({
      env: ctx.env,
      subject: "app",
      valueName: APP_RUN_VALUE,
      vbsPath: path.join(runtimeDir, "app.vbs"),
      workingDirectory: scriptDir,
      commandLine: programArguments,
      environment,
      comments: ["Team Memory: starts this computer's Team Memory app at logon, with no window.", written],
    });
  }
  if (ctx.platform === "linux") {
    return systemdUnit({
      env: ctx.env,
      homeDir: ctx.homeDir,
      subject: "app",
      unitName: APP_SYSTEMD_UNIT,
      comment: written,
      description: "Team Memory app",
      workingDirectory: scriptDir,
      execStart: programArguments,
      environment,
      stderrPath: errorLog,
      restart: "no",
      killMode: "process",
    });
  }
  return null;
}

/**
 * Writes the login autostart for the app `ui open` just started, from `scriptDir`
 * with `env`. Never throws: an app that cannot be made to come back after a reboot
 * still runs now, and `error` says why. A run with an app home of its own (a test, a
 * second copy) leaves this user's login alone.
 */
export async function registerAppAutostart({ scriptDir, nodePath = process.execPath, appHome, ...options } = {}) {
  const env = options.env || process.env;
  if (!appHome && env.HONCHO_AGENT_BRIDGE_HOME) return { registered: false, skipped: "this run has its own app home" };
  const ctx = {
    platform: options.platform || process.platform,
    env,
    homeDir: path.resolve(options.homeDir || env.HONCHO_AGENT_BRIDGE_USER_HOME || env.HOME || env.USERPROFILE || os.homedir()),
    uid: options.uid ?? (typeof process.getuid === "function" ? process.getuid() : 0),
    run: options.run || runCommand,
  };
  const runtimeDir = path.join(appHome || defaultAppHome(), "runtime", "app");
  const environment = appEnvironment(env, { platform: ctx.platform, homeDir: ctx.homeDir, ...(options.tmpdir ? { tmpdir: options.tmpdir } : {}) });
  const node = stableNode(nodePath, ctx.platform === "win32" ? env.Path || env.PATH : environment.PATH, { platform: ctx.platform, ...(options.realpath ? { realpath: options.realpath } : {}) });
  const spec = appAutostartSpec(ctx, { nodePath: node, scriptDir, environment, runtimeDir });
  if (!spec) return { registered: false, error: `There is no login autostart for ${ctx.platform}` };
  try {
    if (spec.kind === "launchd") {
      await fsp.mkdir(runtimeDir, { recursive: true });
      return { registered: true, kind: spec.kind, path: spec.plistPath, changed: await writeIfChanged(spec.plistPath, spec.text) };
    }
    if (spec.kind === "windows-run") {
      const installed = await registerWindowsRun(ctx, spec);
      return { registered: true, kind: spec.kind, path: installed.path, changed: installed.changed };
    }
    await fsp.mkdir(runtimeDir, { recursive: true });
    const changed = await writeIfChanged(spec.unitPath, spec.text, 0o644);
    for (const args of [...(changed ? [["daemon-reload"]] : []), ["enable", spec.unitName]]) {
      const result = await ctx.run("systemctl", ["--user", ...args]);
      if (result.code !== 0) throw new Error(`systemctl --user ${args.join(" ")} failed: ${failure(result, "systemctl")}`);
    }
    return { registered: true, kind: spec.kind, path: spec.unitPath, changed };
  } catch (error) {
    return { registered: false, kind: spec.kind, error: String(error?.message || error).slice(0, 300) };
  }
}
