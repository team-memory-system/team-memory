// Where an address in the app lands on this computer. Until it is set up, every
// address opens first setup's window over an empty page, a team link
// (#/start?team=<address>) at that team. Once it is set up, an address opens its
// screen, such as computer/collect, which `/team-memory setup` opens: 기억 설정
// with 대화 수집's 수정 window, first setup's own steps (views/settings.js). `start`
// opens first setup's window again over the screen on view, unless it is a link to
// the team this computer is in already, which opens the team screen. Kept apart
// from app.js, which starts the page as it loads, so the tests can load it.
import { joinCase } from "./team.js";

/**
 * `path` is the address without its query and `link` a team link's address;
 * `setUp` whether this computer is set up and `team` the team it is in (the
 * context's). Answers `{ setup: { firstRun, team } }` for first setup's window, or
 * `{ screen }` for the address to show.
 */
export function landing(path, { setUp, link = "", team = null } = {}) {
  if (!setUp) return { setup: { firstRun: true, team: link } };
  if (path.split("/")[0] !== "start") return { screen: path };
  if (link && joinCase(team, link) === "in") return { screen: "team" };
  return { setup: { firstRun: false, team: link } };
}
