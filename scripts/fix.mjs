// What `doctor --fix` (/team-memory doctor) repairs on its own: the checks doctor
// marks with `fix`, each something an update of the plugin leaves behind. Updating
// the plugin, by hand or by Claude Code on its own, changes only the plugin files;
// what this computer runs stays on the old version until this runs.
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
// prepare`. Every answer carries `said`, one line on what was repaired.
import { VERSION } from "./version.mjs";

/** The first reason a result gives for not working, on one line. */
function reasonOf(result) {
  return String(result?.error || result?.issues?.[0] || result?.next || "").trim().split(/\r?\n/)[0];
}

// What is said names the app's screens rather than a command: Codex has no /team-memory.
const LOGIN_NEEDED = "구독 계정의 로그인이 풀려 있습니다. 팀 메모리 앱의 서버 → 모델에서 로그인한 뒤 다시 하세요.";

/** The names of the checks doctor marked as repaired here. */
export function fixable(checks) {
  return new Set((checks || []).filter((check) => !check.ok && check.fix).map((check) => check.name));
}

/**
 * `checks` is doctor's list. `deps`: setupApply, serverStatus, serverStart,
 * serverPrepare and restartApp, the last answering { ok, restarted }.
 */
export async function fixChecks(checks, deps) {
  const behind = fixable(checks);
  const steps = [];
  const done = [];
  const stop = (what, result) => {
    const reason = reasonOf(result);
    return { ok: false, steps, ...(reason ? { error: reason } : {}), said: [...done, reason ? `${what}: ${reason}` : `${what}.`].join(" ") };
  };
  if (!behind.size) return { ok: true, changed: false, steps, said: "" };

  if (behind.has("runtime")) {
    const setup = await deps.setupApply({});
    steps.push({ step: "setup", ok: Boolean(setup?.ok) });
    if (!setup?.ok) return stop("대화 모으기를 새 판으로 바꾸지 못했습니다", setup);
    done.push(`대화 모으기를 ${VERSION}로 바꿨습니다.`);
  }

  if (behind.has("server-version")) {
    const now = await deps.serverStatus({ profile: "personal" });
    const running = Boolean(now?.running);
    const result = running
      ? await deps.serverStart({ profile: "personal", build: true })
      : await deps.serverPrepare({ profile: "personal" });
    steps.push({ step: running ? "server-start" : "server-prepare", ok: Boolean(result?.ok && result.ready !== false) });
    if (result?.nextAction?.kind === "gateway-login") return { ok: false, steps, said: [...done, LOGIN_NEEDED].join(" ") };
    if (!result?.ok || result.ready === false) {
      return stop(running ? "기억 서버를 새 판으로 다시 시작하지 못했습니다" : "기억 서버를 새 판으로 준비하지 못했습니다", result);
    }
    done.push(running
      ? "기억 서버와 구독 게이트웨이를 새 판으로 다시 시작했습니다."
      : "꺼 둔 기억 서버는 새 판으로 준비만 했습니다. 켜려면 팀 메모리 앱의 서버 → 기억 서버에서 시작을 누르세요.");
  }

  if (behind.has("app")) {
    const app = await deps.restartApp().catch((error) => ({ ok: false, error: error?.message || String(error) }));
    steps.push({ step: "app", ok: app?.ok !== false });
    if (app?.ok === false) return stop("팀 메모리 앱을 새 판으로 다시 켜지 못했습니다", app);
    done.push("팀 메모리 앱을 새 판으로 다시 켰습니다.");
  }

  if (behind.has("runtime")) done.push("열려 있는 Claude Code와 Codex 창은 새로 시작해야 새 판을 씁니다.");
  return { ok: true, changed: true, steps, said: done.join(" ") };
}
