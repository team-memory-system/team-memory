// Where the app lands for the ways into it: the invite line an admin copies, the
// team link an agent opens from it (#/start?team=<address>), and computer/collect,
// which `/team-memory setup` opens. What matters: the invite line is the one
// sentence an agent reads, with the plugin's own repository and the team's address;
// on a computer set up already, a link to the team it is in opens the team screen
// with no login, one to another team says it leaves that team, with both teams,
// before any login, and leaves it before the login starts (a computer is in one
// team only), and one on a computer in no team opens that team's login;
// computer/collect is first setup until a computer is set up, then 대화 수집's 수정
// window, first setup's own steps; and the team screen, once the servers login is
// done, says to open a new session in windows open from before.
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import test, { afterEach } from "node:test";
import { fileURLToPath } from "node:url";

import { DEFAULT_SOURCE } from "../scripts/host-plugins.mjs";
import { landing, windowOf } from "../ui/lib/landing.js";
import { inviteLine, joinCase, leaveTeam, REPOSITORY } from "../ui/lib/team.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HUB = "team.example.com";
const OTHER = "team.other.example";
const ENDED = { at: "2026-10-19T00:00:00.000Z", email: "me@example.com", host: HUB };

const read = (file) => fsp.readFile(path.join(ROOT, "ui", file), "utf8");

/** A function of openSetup in views/setup.js, up to the next one. */
function setupPart(setup, name) {
  const from = setup.indexOf(`  ${name}`);
  assert.ok(from >= 0, `setup.js has no ${name}`);
  return setup.slice(from, setup.indexOf("\n  function ", from + 1));
}

const saved = globalThis.fetch;
afterEach(() => { globalThis.fetch = saved; });

test("the invite line is the plugin's repository and the team's address, as an agent reads it", async () => {
  assert.equal(inviteLine("team.chenjing.org"), "팀 메모리 설치해 줘. https://github.com/team-memory-system/team-memory 팀 주소 team.chenjing.org");
  // The repository the plugin installs itself from, so the line and the installs agree.
  assert.equal(REPOSITORY, `https://github.com/${DEFAULT_SOURCE}`);
  // 관리자 → 팀 주소 → 복사 copies that line, and says so.
  const admin = await read("views/admin.js");
  assert.match(admin, /copyText\(inviteLine\(team\.hub\)\); toast\("초대 문구를 복사했습니다"\);/);
  assert.equal(admin.includes("팀 주소를 복사했습니다"), false);
  assert.match(admin, /"복사를 눌러 초대 문구를 새 팀원에게 보내세요\. 팀원은 그 문구를 Claude Code나 Codex에 붙여 넣습니다\."/);
});

test("a team link on a computer set up already: the team screen in that team, leaving another first, the login in none", async () => {
  const inHub = { hub: HUB, name: "우리 팀", signedIn: true, loginEnded: null };
  const inOther = { hub: OTHER, name: "다른 팀", signedIn: true, loginEnded: null };
  const inNone = { hub: null, name: null, signedIn: false, loginEnded: null };

  // In that team already: the team screen, with no login.
  assert.equal(joinCase(inHub, HUB), "in");
  assert.deepEqual(landing("start", { setUp: true, link: HUB, team: inHub }), { screen: "team" });
  assert.equal(joinCase(inHub, "https://Team.Example.com/"), "in", "the address as an agent may write it");
  assert.equal(joinCase({ ...inHub, signedIn: false, loginEnded: ENDED }, HUB), "in", "a login that ended is still the team; its screen offers 다시 로그인");

  // In another team: first setup's window, which says it leaves that team before the login.
  assert.equal(joinCase(inOther, HUB), "move");
  assert.equal(joinCase({ ...inOther, signedIn: false, loginEnded: ENDED }, HUB), "move");
  assert.deepEqual(landing("start", { setUp: true, link: HUB, team: inOther }), { setup: { firstRun: false, team: HUB } });

  // In no team: the same window, at the team's login.
  assert.equal(joinCase(inNone, HUB), "join");
  assert.equal(joinCase(null, HUB), "join");
  assert.deepEqual(landing("start", { setUp: true, link: HUB, team: inNone }), { setup: { firstRun: false, team: HUB } });
  // The team's own address without a login (made here, or logged out): its login again, nothing to leave.
  assert.equal(joinCase({ hub: HUB, signedIn: false, loginEnded: null }, HUB), "join");
  // An address that is no team's leaves nothing: its login says what is wrong with it.
  assert.equal(joinCase(inOther, "localhost"), "join");
  assert.equal(joinCase(inOther, ""), "join");

  // `start` alone is first setup's window again, as the palette opens it.
  assert.deepEqual(landing("start", { setUp: true, team: inHub }), { setup: { firstRun: false, team: "" } });
  // Not set up yet: first setup over every address, a link's at that team.
  assert.deepEqual(landing("start", { setUp: false, link: HUB, team: inHub }), { setup: { firstRun: true, team: HUB } });

  // The shell lands every address this way, with whether this computer is set up and the team it is in,
  // and shows what landing() answers: first setup's window, or the screen it names in the address.
  const shell = await read("app.js");
  assert.match(shell, /const lands = landing\(path, \{ setUp: setupDone\(\), link: query\.get\("team"\) \|\| "", team: app\.context\?\.team \}\);/);
  assert.equal(shell.split("showSetup(lands.setup);").length - 1, 2, "first setup's window, before setup and after");
  assert.match(shell, /\} else if \(lands\.screen !== path\) \{\n\s*history\.replaceState\(null, "", `#\/\$\{lands\.screen\}`\);\n\s*\}\n\s*const \{ name, params \} = route\(\);/);
  // A window closed half way, after it left this computer's team, leaves nothing set up: first setup opens again.
  assert.match(shell, /onCancel: async \(\) => \{\n\s*setupWindow = null;\n\s*await loadContext\(\)\.catch\(\(\) => \{\}\);\n\s*if \(!setupDone\(\)\) show\(\{ force: true \}\);\n\s*\},/);
});

test("leaving another team is said with both teams before the login, and done before the login starts", async () => {
  const posts = [];
  globalThis.fetch = async (url, init = {}) => {
    posts.push({ url, body: init.body ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
  };
  await leaveTeam();
  assert.deepEqual(posts, [{ url: "/api/team/logout", body: {} }], "this computer's team login and device keys go");
  // The one way out of a team: a login as someone else leaves it the same way.
  const team = await read("lib/team.js");
  assert.equal(team.split('"/api/team/logout"').length - 1, 1);
  assert.match(team, /export async function switchAccount\([^)]*\) \{\n\s*await leaveTeam\(\)\.catch\(\(\) => null\);/);

  const setup = await read("views/setup.js");
  // Only a login to a team's address (a link, or 팀에 들어가기) leaves one, and only another team's.
  assert.match(setup, /const teamToLeave = \(\) => \(\["join", "link"\]\.includes\(state\.path\) && joinCase\(ownTeam, state\.team\.hub\) === "move" \? ownTeam : null\);/);
  // The login step asks first, with both teams, and opens the login only on 옮기고 로그인.
  const step = setupPart(setup, "function loginStep(");
  const ask = step.slice(step.indexOf("teamToLeave()"), step.indexOf("if (login.phase === \"idle\" && !login.tab) {"));
  assert.match(ask, /h\("h3", \{\}, "지금 팀에서 빠지고 새 팀으로 옮깁니다"\)/);
  assert.match(ask, /kv\("지금 팀", named\(from\.name, from\.hub\)\), kv\("새 팀", named\(state\.team\.name, state\.team\.hub\)\)/);
  assert.match(ask, /button\("옮기고 로그인", \{ kind: "primary", onClick: \(\) => \{\n\s*\/\/[^\n]*\n\s*login\.tab = loginTab\([^)]*\);\n\s*login\.leave = true;/);
  // No login tab ahead of that question, so nothing starts before it is answered.
  assert.match(setup, /if \(keys\[at \+ 1\] === "login" && !teamToLeave\(\)\) state\.login\.tab = loginTab\(/);
  // The login leaves the team first: logging in to the new hub while still in the old team loses the new login.
  const start = setupPart(setup, "async function startLogin(");
  assert.ok(start.indexOf("await leaveTeam();") > 0 && start.indexOf("await leaveTeam();") < start.indexOf("teamLogin({"), "leaveTeam before teamLogin");
  assert.match(start, /await leaveTeam\(\);\n\s*login\.leave = false;\n\s*ownTeam = null;/);
  // A link on a computer set up already came for that team alone: 취소 closes the window.
  assert.match(setup, /if \(state\.path === "link" && keys\[at\] === "login" && !firstRun\) \{ win\.close\(\); return; \}/);
});

test("computer/collect is first setup on a computer not set up, and 대화 수집's 수정 window, first setup's own steps, on one that is", async () => {
  assert.deepEqual(landing("computer/collect", { setUp: false }), { setup: { firstRun: true, team: "" } });
  assert.deepEqual(landing("computer/collect", { setUp: true }), { screen: "computer/collect" });
  // 기억 설정 opens the 수정 window on any computer set up, one that does not collect yet too.
  assert.equal(windowOf("collect", true), "collect");
  assert.equal(windowOf("collect", false), "collect");
  assert.equal(windowOf("past", true), "past");
  assert.equal(windowOf("tools", true), "tools");
  assert.equal(windowOf("past", false), null, "지난 대화 is for a computer that collects");
  assert.equal(windowOf("tools", false), null);
  assert.equal(windowOf("nope", true), null);
  assert.equal(windowOf(undefined, true), null);
  // That window walks first setup's own steps, from the same functions.
  const settings = await read("views/settings.js");
  const build = settings.match(/const build = \(\) => \[([\s\S]*?)\n {2}\];/)[1];
  const steps = [...build.matchAll(/(\w+Step)\(/g)].map((match) => match[1]);
  assert.deepEqual(steps, ["serverStep", "agentsStep", "pastStep", "projectsStep"]);
  const setup = setupPart(await read("views/setup.js"), "function buildStep(");
  for (const name of steps) assert.match(setup, new RegExp(`return ${name}\\(`), `first setup does not use ${name}`);
  assert.match(settings, /const open = windows\[windowOf\(params\[0\], app\.context\?\.configured\)\];/);
});

test("the team screen, once the servers login is done, says to open a new session in windows open from before", async () => {
  const team = await read("views/team.js");
  assert.match(team, /const signedIn = Boolean\(status\?\.serversLogin\?\.signedIn\);/);
  assert.match(team, /팀원 이름을 넣어 말하면, 열린 대화에서 찾아 답합니다\.\$\{signedIn \? " 전부터 열려 있던 창은 새 세션을 여세요\." : ""\}`/);
});
