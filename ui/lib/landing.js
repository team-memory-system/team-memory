// Where an address in the app lands on this computer. Until it is set up, every
// address opens first setup's window over an empty page, a team link
// (#/start?team=<address>) at that team. Once it is set up, an address opens its
// screen, such as computer/collect, which `/team-memory setup` opens: 기억 설정
// with 대화 수집's 수정 window, first setup's own steps (views/settings.js). `start`
// opens first setup's window again over the screen on view, unless it is a link to
// the team this computer is in already, which opens the team screen. A setup kept
// half way (lib/state.js) opens first setup's window as the app starts, also on a
// computer set up since. Kept apart from app.js, which starts the page as it loads,
// so the tests can load it.
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

/**
 * The window an address opens with 기억 설정's page (views/settings.js): 대화 수집's
 * 수정 on any computer that is set up (computer/collect, what `/team-memory setup`
 * opens), even one that does not collect yet; 지난 대화 and MCP 도구 once it
 * collects (`configured`).
 */
export function windowOf(name, configured) {
  if (name === "collect") return name;
  return configured && (name === "past" || name === "tools") ? name : null;
}

/**
 * Whether the app, as it starts on `path`, opens first setup's window for a setup
 * kept half way (`kept`), where the window shows its rows with 이어서 하기 and
 * 처음부터: on a computer set up already, such as one whose server that setup has
 * installed. One not set up opens the window anyway, as `start` does; an address
 * that opens a window of its own here (windowOf) is left to it, and its 적용 drops
 * what was kept.
 */
export function resumeAtBoot(path, { setUp, kept, configured = false }) {
  const [name, page] = path.split("/");
  return Boolean(setUp && kept && name !== "start" && !(name === "computer" && windowOf(page, configured)));
}
