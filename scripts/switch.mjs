// /team-memory in Claude Code (commands/team-memory.md), `switch` in a terminal: the
// switches a person reaches for most, each doing what its button in the app does.
//
//   (nothing)                   what is on: the memory server, sharing, and each
//                               teammate this server's memory is opened to
//   off | on                    서버 → 기억 서버 → 멈추기 | 시작: the whole memory
//                               server, so this computer's own search and collecting
//                               stop with it
//   shared-off | shared-on      서버 → 공유 → 공유 끄기 | 다시 켜기: every teammate
//                               and the owner's other computers
//   shared-off|-on <teammate>   팀 → 내 기억을 여는 팀원 → that teammate's switch:
//                               their chat refused for now, what is open to them kept
//
// Typing the option is the confirmation, so nothing asks again. Every answer carries
// `said`, the one line the command shows, with how to undo what it did.
import { loadConfig } from "./config.mjs";
import { gateGrants, gateStatePaths, setChatOff } from "./gate-access.mjs";
import { serverStart, serverStatus, serverStop } from "./server-manager.mjs";
import { shareDisable, shareStatus } from "./share-manager.mjs";
import { teamShare } from "./team-hub.mjs";

export const SWITCH_ACTIONS = ["off", "on", "shared-off", "shared-on"];
const NO_SERVER = "이 컴퓨터에는 기억 서버가 없습니다.";

// Letters and digits whose sound ends in a consonant, as a Korean reader says them
// (ui/lib/format.js keeps the same rule for the app).
const CLOSED_LETTERS = /(?:[bcdgklmnpt]|le)$/i;
const CLOSED_DIGITS = /[013678]$/;

/** `word` with the particle its last sound takes, the closed form first: josa("철수", "을/를") is 철수를. */
export function josa(word, pair) {
  const [closed, open] = pair.split("/");
  const text = String(word || "");
  const code = text.charCodeAt(text.length - 1);
  const ends = code >= 0xac00 && code <= 0xd7a3 ? (code - 0xac00) % 28 !== 0 : CLOSED_LETTERS.test(text) || CLOSED_DIGITS.test(text);
  return `${text}${ends ? closed : open}`;
}

/** A teammate as the team names them: their peer, else the start of their email. */
const nameOf = (grant) => grant.peer || grant.email.split("@")[0];

/**
 * The teammate `who` names among those chat is opened to: by email, else by team
 * name, else by the start of the email, whatever the case. `{ grant }`, `{ many }`
 * when the name fits more than one, or `{ none: true }`.
 */
export function findTeammate(grants, who) {
  const asked = String(who || "").trim().toLowerCase();
  const open = grants.filter((grant) => grant.chat);
  const byEmail = open.find((grant) => grant.email === asked);
  if (byEmail) return { grant: byEmail };
  for (const named of [
    open.filter((grant) => nameOf(grant).toLowerCase() === asked),
    open.filter((grant) => grant.email.split("@")[0] === asked),
  ]) {
    if (named.length === 1) return { grant: named[0] };
    if (named.length) return { many: named };
  }
  return { none: true };
}

/** How a command names `grant`: by team name, or by email when the name finds someone else too. */
function handleOf(grants, grant) {
  return findTeammate(grants, nameOf(grant)).grant === grant ? nameOf(grant) : grant.email;
}

/** The first reason a result gives for not working, on one line. */
function reasonOf(result) {
  return String(result?.error || result?.issues?.[0] || result?.next || "").trim().split(/\r?\n/)[0];
}

function failed(what, result) {
  const reason = reasonOf(result);
  return { ok: false, ...(reason ? { error: reason } : {}), said: reason ? `${what}: ${reason}` : `${what}.` };
}

const sharingOn = (share) => Boolean(share.tunnel?.enabled ?? share.enabled);

async function status(use, gate) {
  const server = await use.serverStatus({ profile: "personal" });
  if (!server.installed) return { ok: true, installed: false, said: NO_SERVER };
  const shared = sharingOn(await use.shareStatus());
  const teammates = (await use.gateGrants(gate)).filter((grant) => grant.chat)
    .map((grant) => ({ name: nameOf(grant), email: grant.email, off: grant.chat.off === true }));
  const parts = [
    `기억 서버 ${server.running ? "켜짐" : "꺼짐"}`,
    `공유 ${shared ? "켜짐" : "꺼짐"}`,
    ...teammates.map((one) => `${one.name} ${one.off ? "꺼 둠" : "켜짐"}`),
  ];
  return { ok: true, installed: true, running: Boolean(server.running), shared, teammates, said: parts.join(" · ") };
}

async function server(use, on) {
  const now = await use.serverStatus({ profile: "personal" });
  if (!now.installed) return { ok: false, said: NO_SERVER };
  if (!on) {
    const stopped = await use.serverStop({ profile: "personal" });
    if (!stopped.ok) return failed("기억 서버를 멈추지 못했습니다", stopped);
    return { ok: true, said: "기억 서버를 멈췄습니다. 다시 켜려면 /team-memory on" };
  }
  if (now.ok && now.running) return { ok: true, changed: false, said: "기억 서버는 이미 켜져 있습니다." };
  // As 시작 does: the models the server was set up with are kept.
  const started = await use.serverStart({ profile: "personal", build: true });
  if (!started.ok || started.ready === false) return failed("기억 서버를 시작하지 못했습니다", started);
  return { ok: true, changed: true, said: "기억 서버를 시작했습니다." };
}

async function sharing(use, config, on) {
  const share = await use.shareStatus();
  if (!share.installed) return { ok: false, said: NO_SERVER };
  if (sharingOn(share) === on) return { ok: true, changed: false, said: on ? "공유는 이미 켜져 있습니다." : "공유는 이미 꺼져 있습니다." };
  if (!on) {
    const closed = await use.shareDisable();
    if (!closed.ok) return failed("공유를 끄지 못했습니다", closed);
    return { ok: true, changed: true, said: "공유를 껐습니다. 다시 켜려면 /team-memory shared-on" };
  }
  // 다시 켜기 takes the address the team gave this server before; one never opened
  // through the team is turned on in the app, which asks what it needs.
  if (!share.team) return { ok: false, said: "이 서버는 팀으로 공유한 적이 없습니다. 앱의 서버 → 공유에서 켜세요." };
  const opened = await use.teamShare({ config, replace: true });
  if (opened.code === "no_login" || opened.code === "login_needed") {
    return { ok: false, error: reasonOf(opened), said: "팀 로그인이 필요합니다. 팀 메모리 앱에서 팀에 다시 로그인한 뒤 /team-memory shared-on 을 다시 입력하세요." };
  }
  if (!opened.ok) return failed("공유를 켜지 못했습니다", opened);
  return { ok: true, changed: true, said: "공유를 켰습니다." };
}

async function teammate(use, gate, who, off) {
  const grants = await use.gateGrants(gate);
  const found = findTeammate(grants, who);
  if (found.none) {
    const names = grants.filter((grant) => grant.chat).map(nameOf);
    return {
      ok: false,
      said: names.length
        ? `${josa(who, "은/는")} 내 기억을 여는 팀원이 아닙니다. 지금 여는 팀원: ${names.join(", ")}`
        : "내 기억을 여는 팀원이 아직 없습니다. 팀원이 chat을 요청하면 앱에서 승인하세요.",
    };
  }
  if (found.many) {
    return { ok: false, said: `${josa(who, "이/가")} 여러 명입니다. 이메일로 적으세요: ${found.many.map((grant) => grant.email).join(", ")}` };
  }
  const { grant } = found;
  const name = nameOf(grant);
  if ((grant.chat.off === true) === off) {
    return { ok: true, changed: false, email: grant.email, off, said: `${josa(name, "은/는")} 이미 ${off ? "꺼 두었습니다" : "켜져 있습니다"}.` };
  }
  await use.setChatOff(gate, { email: grant.email, off });
  return {
    ok: true,
    changed: true,
    email: grant.email,
    off,
    said: off ? `${josa(name, "을/를")} 껐습니다. 다시 켜려면 /team-memory shared-on ${handleOf(grants, grant)}` : `${josa(name, "을/를")} 켰습니다.`,
  };
}

const DEFAULTS = { loadConfig, serverStatus, serverStart, serverStop, shareStatus, shareDisable, teamShare, gateGrants, setChatOff };

/** `switch [off|on|shared-off|shared-on] [teammate]`; `deps` stands in for the server's parts in tests. */
export async function switchCommand(args, deps = {}) {
  const use = { ...DEFAULTS, ...deps };
  const [action = "", ...rest] = args;
  const who = rest.join(" ").trim();
  if (action && !SWITCH_ACTIONS.includes(action)) {
    return {
      ok: false,
      error: `Unknown switch: ${action}. Expected off, on, shared-off or shared-on.`,
      said: `${josa(action, "은/는")} 모르는 옵션입니다. on, off, shared-on, shared-off, setup, doctor 중 하나를 적으세요.`,
    };
  }
  if (who && (action === "on" || action === "off")) {
    return { ok: false, said: `${action === "off" ? "off는 기억 서버 전체를 멈춥니다" : "on은 기억 서버 전체를 켭니다"}. 한 사람만 ${action === "off" ? "끄려면" : "켜려면"} /team-memory shared-${action} ${who}` };
  }
  const config = await use.loadConfig().catch(() => null);
  const gate = gateStatePaths({ serverDirectory: config?.paths?.serverDir });
  if (!action) return status(use, gate);
  if (action === "off" || action === "on") return server(use, action === "on");
  if (who) return teammate(use, gate, who, action === "shared-off");
  return sharing(use, config, action === "shared-on");
}
