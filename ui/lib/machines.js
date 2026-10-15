// 컴퓨터 고르기: the box at the top of the menu that says which of the owner's
// computers this window shows, and opens the other. This computer's app answers
// /api/viewer on its own port and on the one where it shows the server computer's
// app (scripts/viewer.mjs), so the box is the same on both. While the window shows
// another computer, the box and a strip over the page take the accent colour, and
// what the app does only in front of that computer is locked (here-only).
import { get } from "./api.js";
import { h, clear, svg, $ } from "./dom.js";
import { icon } from "./icons.js";
import { josa } from "./format.js";
import { app } from "./state.js";
import { button } from "./ui.js";

const glyph = (body) => svg(`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`);
const LAPTOP = '<rect x="3" y="3.5" width="10" height="7" rx="1"/><path d="M1.5 12.5h13"/>';
const DESKTOP = '<rect x="2.5" y="2.5" width="11" height="8" rx="1"/><path d="M6 13.5h4M8 10.5v3"/>';
const LOCK = '<rect x="3.5" y="7" width="9" height="6.5" rx="1"/><path d="M5.5 7V5a2.5 2.5 0 015 0v2"/>';

// Why the server computer cannot be shown now, in a few words (viewer.mjs's reasons).
const REASONS = {
  login: "팀 로그인이 끝나 다시 로그인해야 함",
  owner: "이 컴퓨터가 주인 컴퓨터로 등록되지 않음",
  old: "그 컴퓨터를 업데이트해야 함",
  off: "그 컴퓨터의 앱이 꺼져 있음",
  unreachable: "닿지 않음",
  port: "이 컴퓨터의 다른 프로그램이 길을 쓰는 중",
};
export const machineReason = (reason) => REASONS[reason] || REASONS.unreachable;

/** The line under a computer's name in the list. */
export function machineSub(computer) {
  if (computer.here) return "이 컴퓨터";
  if (!computer.ok) return machineReason(computer.reason);
  return `기억 서버 · ${computer.host}`;
}

// A computer by its name: a desk one (Mac Studio, mini, iMac, a Windows DESKTOP-…) or a laptop.
const machineGlyph = (computer) => glyph(/studio|mini|imac|desktop|\bpc\b/i.test(computer?.name || "") ? DESKTOP : LAPTOP);

/** Opens `computer` in this window, on the same screen when it has one. */
function open(computer) {
  if (!computer.url) return;
  location.href = `${computer.url}${location.hash || "#/dashboard"}`;
}

let closer = null;

/** The box, and while another computer shows, the strip over the page. Nothing when there is only this one. */
export async function renderMachines() {
  const box = $("#machine");
  if (!box) return;
  const viewer = await get("/api/viewer").catch(() => null);
  const computers = viewer?.computers || [];
  const current = computers.find((computer) => computer.id === viewer?.current) || computers[0];
  const here = computers.find((computer) => computer.here);
  const away = Boolean(current && !current.here);
  drawStrip(away ? current : null, here);
  if (computers.length < 2) {
    box.hidden = true;
    clear(box);
    return;
  }
  box.hidden = false;
  box.className = `machine${away ? " away" : ""}`;
  const toggle = h("button", {
    class: "machine-btn",
    type: "button",
    "aria-haspopup": "listbox",
    "aria-expanded": "false",
    title: "보는 컴퓨터 바꾸기",
    onclick: (event) => { event.stopPropagation(); box.classList.contains("open") ? close() : openList(); },
  },
  h("span", { class: "glyph" }, machineGlyph(current)),
  h("span", {}, h("b", {}, current.name), h("small", {}, away ? `${here?.name || "이 컴퓨터"}에서 보는 중` : "이 컴퓨터")),
  icon("chevron"));
  clear(box, toggle);
  box.onkeydown = (event) => { if (event.key === "Escape") close(); };

  function close() {
    box.classList.remove("open");
    toggle.setAttribute("aria-expanded", "false");
    box.querySelector(".machine-pop")?.remove();
    if (closer) document.removeEventListener("click", closer);
    closer = null;
  }

  function rows(list) {
    return list.map((computer) => {
      const chosen = computer.id === current.id;
      const usable = computer.here || computer.ok;
      return h("button", {
        class: "machine-row",
        type: "button",
        role: "option",
        "aria-selected": String(chosen),
        disabled: !usable && !chosen ? true : null,
        onclick: () => { close(); if (!chosen) open(computer); },
      },
      h("span", { class: "glyph" }, machineGlyph(computer)),
      h("span", {}, h("b", {}, computer.name), h("small", {}, machineSub(computer))),
      chosen ? icon("check") : h("span"));
    });
  }

  function openList() {
    box.classList.add("open");
    toggle.setAttribute("aria-expanded", "true");
    const list = h("div", { class: "machine-rows" }, rows(computers));
    box.append(h("div", { class: "machine-pop", role: "listbox", "aria-label": "내 컴퓨터" },
      h("h4", {}, "내 컴퓨터"),
      list,
      h("footer", {}, "같은 계정으로 기억 서버의 주인인 컴퓨터만 나옵니다.")));
    closer = (event) => { if (!box.contains(event.target)) close(); };
    document.addEventListener("click", closer);
    // Asked again, so a computer that came back or went away shows as it is now.
    get("/api/viewer?fresh=1").then((fresh) => {
      if (box.classList.contains("open") && fresh?.computers?.length) clear(list, rows(fresh.computers));
    }).catch(() => {});
  }
}

function drawStrip(shown, here) {
  const main = $(".main");
  if (!main) return;
  main.classList.toggle("away", Boolean(shown));
  main.querySelector(".away-strip")?.remove();
  if (!shown) return;
  // Under the phone's menu bar, over the page.
  $("#page").before(h("div", { class: "away-strip", role: "status" },
    machineGlyph(shown),
    h("b", {}, shown.name),
    h("span", {}, "화면을 보고 있습니다. 여기서 바꾼 설정은 그 컴퓨터에 적용됩니다."),
    here ? button(josa(here.name, "으로/로"), { kind: "small", iconName: "back", onClick: () => open(here) }) : null));
}

/** Whether this page is shown on another of the owner's computers. */
export const shownElsewhere = () => Boolean(app.context?.viewer);

/**
 * A button the app takes only in front of its own computer, while another shows the
 * page: there, but locked, with why in its title.
 */
export function hereOnlyButton(label, why) {
  return h("button", { class: "btn small here-only", type: "button", disabled: true, title: why },
    glyph(LOCK), h("span", {}, label));
}

/** The line under a section with a here-only button: what to do instead. */
export function hereOnlyNote(text) {
  return h("p", { class: "here-only-note" }, glyph(LOCK), text);
}
