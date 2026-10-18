// What `doctor --fix` (/team-memory doctor, and the app's 고치기) repairs on its own:
// the checks doctor marks with `fix`, each something an update of the plugin leaves
// behind. Updating the plugin, by hand or by Claude Code on its own, changes only the
// plugin files; what this computer runs stays on the old version until this runs.
// The app's 업데이트 runs it too, from the new plugin's folder (update.mjs), and
// shows its steps as rows through `onStep`.
//
//   runtime          setup apply with the saved settings: the collector and hooks
//   server-version   the memory server's Honcho source or its subscription gateway is
//                    behind this version's pins, or the files its containers run
//                    (compose.yaml, the gate's code) are not this version's: `server start`, which prepares again,
//                    rebuilds and starts it with the models it had. A server the person
//                    stopped is only prepared and stays off.
//   app              the app (port 4180) runs from an older copy of the plugin, whose
//                    pages it serves: started again from this one
//
// Only what is behind is touched, so a current server is never restarted. `setup
// apply` alone did none of the server's part: the gateway moved only with `server
// prepare`. Every answer carries `said`, one line on what was repaired; one that
// stops names the step and keeps its reason as the step gave it.
import { sanitizeUrlsInText } from "./redact.mjs";
import { VERSION } from "./version.mjs";

/**
 * The first reason a result gives for not working, on one line. A server start whose
 * containers came up but whose Honcho never answered says why in `health` alone.
 */
function reasonOf(result) {
  const health = result?.health?.error ? `Honcho /health: ${result.health.error}` : "";
  return String(result?.error || result?.issues?.[0] || health || result?.next || "").trim().split(/\r?\n/)[0];
}

/**
 * A step's result, or what it threw as one. A command that failed (docker compose
 * in `server start`) throws a message that only names the command: its reason is the
 * last line it wrote, kept with up to 20 lines before it in `detail`.
 */
async function attempt(run) {
  try {
    return await run();
  } catch (error) {
    const lines = String(error?.stderr || "").split(/\r?\n/).map((line) => sanitizeUrlsInText(line.trim())).filter(Boolean);
    const reason = lines.at(-1) || sanitizeUrlsInText(String(error?.message || error).trim().split(/\r?\n/)[0]);
    return { ok: false, error: reason, ...(lines.length > 1 ? { detail: lines.slice(-21, -1).join("\n") } : {}) };
  }
}

// What is said names the app's screens rather than a command: Codex has no
// /team-memory. The login line ends at the login, since what comes after it is not
// the same everywhere: Claude Code runs /team-memory doctor again, the app's rows
// have 다시 시도.
const LOGIN_NEEDED = "구독 계정의 로그인이 풀려 있습니다. 팀 메모리 앱의 서버 → 모델에서 로그인하세요.";

/** The names of the checks doctor marked as repaired here. */
export function fixable(checks) {
  return new Set((checks || []).filter((check) => !check.ok && check.fix).map((check) => check.name));
}

/**
 * `version` with 으로 or 로 as its last digit is read: 0 영, 3 삼 and 6 육 take 으로
 * (0.8.13으로, 0.8.10으로); the rest 로, 1 일, 7 칠 and 8 팔 too, since a word that
 * ends in ㄹ takes 로 (0.8.11로, 0.8.12로).
 */
export function toVersion(version) {
  return `${version}${/[036]$/.test(String(version)) ? "으로" : "로"}`;
}

/**
 * `checks` is doctor's list. `deps`: setupApply, serverStatus, serverStart,
 * serverPrepare and restartApp, the last answering { ok, restarted }, and onStep,
 * told (step, state, info) as each step goes: step runtime, server or app, state
 * run, ok, bad (info: { error, detail }) or login. The server's run says in
 * `info.running` whether the server was running.
 *
 * The answer: { ok, changed, steps, said }; one that stops also has `failed` (the
 * step), `error` and `detail`, and `login` when the subscription login ended.
 * `serverOff` says the memory server is off at the end: prepared only, as it was
 * off, or down after a start that failed.
 */
export async function fixChecks(checks, deps) {
  const behind = fixable(checks);
  const steps = [];
  const done = [];
  // The rows are a view: a progress file that cannot be written stops nothing.
  const told = async (step, state, info) => {
    try { await deps.onStep?.(step, state, info); } catch {}
  };
  // A reason keeps no secret in an address it names, as attempt's do.
  const stop = async (step, what, result, extra = {}) => {
    const reason = sanitizeUrlsInText(reasonOf(result));
    const detail = result?.detail ? sanitizeUrlsInText(result.detail) : null;
    await told(step, "bad", { error: reason || null, detail });
    return {
      ok: false,
      steps,
      failed: step,
      ...(reason ? { error: reason } : {}),
      ...(detail ? { detail } : {}),
      ...extra,
      said: [...done, reason ? `${what}: ${reason}` : `${what}.`].join(" "),
    };
  };
  if (!behind.size) return { ok: true, changed: false, steps, said: "" };

  if (behind.has("runtime")) {
    await told("runtime", "run");
    const setup = await attempt(() => deps.setupApply({}));
    steps.push({ step: "setup", ok: Boolean(setup?.ok) });
    if (!setup?.ok) return stop("runtime", "대화 모으기를 새 판으로 바꾸지 못했습니다", setup);
    await told("runtime", "ok");
    done.push(`대화 모으기를 ${toVersion(VERSION)} 바꿨습니다.`);
  }

  let serverOff = false;
  if (behind.has("server-version")) {
    const now = await attempt(() => deps.serverStatus({ profile: "personal" }));
    const running = Boolean(now?.running);
    await told("server", "run", { running });
    const result = await attempt(() => (running
      ? deps.serverStart({ profile: "personal", build: true })
      : deps.serverPrepare({ profile: "personal" })));
    steps.push({ step: running ? "server-start" : "server-prepare", ok: Boolean(result?.ok && result.ready !== false) });
    // A gateway with no login stops prepare before anything installed is touched.
    if (result?.nextAction?.kind === "gateway-login") {
      await told("server", "login");
      return { ok: false, steps, failed: "server", login: true, said: [...done, LOGIN_NEEDED].join(" ") };
    }
    if (!result?.ok || result.ready === false) {
      // A start that failed half way stops the host services with it.
      const after = running ? await attempt(() => deps.serverStatus({ profile: "personal" })) : null;
      return stop("server", running ? "기억 서버를 새 판으로 다시 시작하지 못했습니다" : "기억 서버를 새 판으로 준비하지 못했습니다", result,
        after?.running ? {} : { serverOff: true });
    }
    await told("server", "ok");
    serverOff = !running;
    done.push(running
      ? "기억 서버와 구독 게이트웨이를 새 판으로 다시 시작했습니다."
      : "꺼 둔 기억 서버는 새 판으로 준비만 했습니다. 켜려면 팀 메모리 앱의 서버 → 기억 서버에서 시작을 누르세요.");
  }

  if (behind.has("app")) {
    await told("app", "run");
    const app = await attempt(() => deps.restartApp());
    steps.push({ step: "app", ok: app?.ok !== false });
    if (app?.ok === false) return stop("app", "팀 메모리 앱을 새 판으로 다시 켜지 못했습니다", app, serverOff ? { serverOff } : {});
    await told("app", "ok");
    done.push("팀 메모리 앱을 새 판으로 다시 켰습니다.");
  }

  if (behind.has("runtime")) done.push("열려 있는 Claude Code와 Codex 창은 새로 시작해야 새 판을 씁니다.");
  return { ok: true, changed: true, steps, ...(serverOff ? { serverOff } : {}), said: done.join(" ") };
}
