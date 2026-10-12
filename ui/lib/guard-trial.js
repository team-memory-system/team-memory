// 가드 시험: the owner asks a question as a teammate would and sees each step the
// team server takes with it: the question judged, the answer made from one
// project's memory or written here, the answer judged, and what the teammate gets.
// It is one line at the top of 조회 기록, a question and a chip for the answer, and
// Enter judges it. This visit's trials stay under it, newest first, the earlier
// ones folded to a line. The memory server's own MCP bridge runs it (the dashboard
// relays it to the bridge's /guard-trial), so it is judged as a teammate's chat is,
// by the same hub with the same token. Nothing of it is recorded.
import { post } from "./api.js";
import { h, clear } from "./dom.js";
import { number } from "./format.js";
import { callScores, reasonText, scoreText, trialOutcome, trialTag, verdictTag } from "./guard.js";
import { icon } from "./icons.js";
import { kv } from "./kit.js";
import { app, savePrefs } from "./state.js";
import { teamCall } from "./team.js";
import { details, errorNotice, notice, spinner, tag } from "./ui.js";

// No length limit here: a question longer than Jev reads at once is for the bridge
// to refuse, and the trial shows that too.
const SOURCES = ["memory", "typed", "none"];
// The trials one visit keeps; older ones drop off the end.
const KEPT = 20;

const clock = new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
const seconds = (ms) => `${(ms / 1000).toFixed(1)}초`;

/** Why the trial could not run, in the owner's words. */
function problem(error) {
  // A bridge or a dashboard from before the trial.
  if (error.status === 404) {
    return notice("warn", h("b", {}, "이 기억 서버는 아직 가드 시험을 모릅니다."), " 서버 화면에서 기억 서버를 업데이트하고 다시 시작하세요.");
  }
  if (error.payload?.trial_url) {
    return notice("warn", h("b", {}, "공유가 꺼져 있어 시험할 수 없습니다."), " 팀원의 질문을 받는 MCP는 공유가 켜져 있을 때만 돕니다. 서버 → 공유에서 켜세요.");
  }
  if (error.unreachable) return notice("warn", "이 컴퓨터에서는 기억 서버에 닿지 않습니다. 기억 서버를 둔 컴퓨터에서 여세요.");
  return errorNotice(error);
}

/** One judged step: its tag, the reason when it was not a plain pass, and the score. */
function step(label, view, part, gate) {
  const shown = verdictTag(view, part, gate);
  if (!shown) return null;
  const [text, kind] = shown;
  const said = gate && (view.unjudged || !view.allowed) ? reasonText(view.reason, view.allowed, { cause: true }) : "";
  return kv(label, [tag(text, kind), said ? h("div", { class: "s" }, said) : null],
    gate && view.score != null ? h("span", { class: "trial-score", title: "1에 가까울수록 민감합니다." }, `Jev ${scoreText(view.score)}`) : null);
}

function drawTrial(trial, asked) {
  const gate = trial.gate !== false;
  const outcome = trialOutcome(trial);
  const skipped = trial.outcome === "refused" ? "질문에서 막혀 답을 만들지 않았습니다." : "하지 않았습니다.";
  const source = asked.answer != null ? "직접 쓴 답" : `${asked.project?.name || "프로젝트"}의 기억에서 만든 답`;
  return h("div", { class: "trial-result" },
    h("div", { class: "audit-facts" },
      step("질문 검사", trial.query, "query", gate),
      step("답 검사", trial.answer_check, "answer", gate) || kv("답 검사", h("span", { class: "muted" }, skipped))),
    trial.answer != null ? h("div", {}, h("div", { class: "audit-label" }, source), h("pre", { class: "audit-full" }, trial.answer)) : null,
    notice(outcome.kind, h("b", {}, outcome.title), outcome.text ? ` ${outcome.text}` : "",
      outcome.message ? h("div", { class: "trial-message" }, outcome.message) : null),
    trial.error ? details("서버가 남긴 이유 원문", trial.error) : null);
}

/** The line to try a question in, with this visit's trials under it. */
export function guardTrial() {
  // "memory" makes the answer from a project's memory, "typed" sends the answer
  // written here, "none" judges the question alone. The last choice is kept.
  let source = SOURCES.includes(app.prefs.trialSource) ? app.prefs.trialSource : "memory";
  let projectId = app.prefs.trialProject || "";
  // null while they load, then the projects this server holds conversations of.
  let projects = null;
  let running = false;

  const question = h("textarea", { class: "trial-text", rows: "1", placeholder: "팀원이 물을 질문을 쓰고 Enter", "aria-label": "질문", enterkeyhint: "go" });
  const written = h("textarea", { class: "trial-text", rows: "2", placeholder: "팀원에게 나갈 답을 그대로 쓰세요", "aria-label": "나갈 답" });
  const writtenRow = h("div", { class: "trial-written" }, h("span", { class: "trial-written-k" }, "답"), written);
  const chip = h("span", { class: "cchip trial-chip", title: "답" });
  const send = h("button", { class: "btn primary small", type: "button", title: "판정 (Enter) · 줄 바꿈은 Shift+Enter" });
  const note = h("div", { class: "composer-note trial-note" });
  const items = h("div", { class: "trial-items", "aria-live": "polite" });
  const box = h("div", { class: "trial-box" },
    h("div", { class: "trial-row" }, icon("shield"), question, h("div", { class: "trial-ends" }, chip, send)),
    writtenRow,
    note);

  const chosen = () => projects?.find((project) => project.id === projectId) || null;

  /** The answer's chip: what it shows is text; a native select over it does the choosing. */
  function drawChip() {
    const control = h("select", { class: "cchip-select", "aria-label": "답" },
      projects === null ? h("option", { value: "loading", disabled: true }, "프로젝트를 읽는 중…")
        : projects.length ? h("optgroup", { label: "기억에서 만들기" },
          projects.map((project) => h("option", { value: `p:${project.id}` }, `${project.name} · 대화 ${number(project.sessions)}개`)))
          : null,
      h("option", { value: "typed" }, "직접 쓰기"),
      h("option", { value: "none" }, "질문만"));
    control.value = source !== "memory" ? source : projects === null ? "loading" : `p:${projectId}`;
    control.addEventListener("change", () => {
      if (control.value.startsWith("p:")) {
        source = "memory";
        projectId = control.value.slice(2);
      } else {
        source = control.value;
      }
      savePrefs({ trialSource: source, trialProject: projectId });
      draw();
      (source === "typed" && !written.value.trim() && question.value.trim() ? written : question).focus();
    });
    const shown = source === "typed" ? "직접 쓰기"
      : source === "none" ? "질문만"
        : projects === null ? "프로젝트를 읽는 중…" : `기억에서 만들기 · ${chosen()?.name || "프로젝트"}`;
    clear(chip, h("span", { class: "trial-chip-k" }, "답"), h("span", { class: "cchip-v" }, shown), icon("chevron", "icon chev"), control);
  }

  function updateSend() {
    const ready = Boolean(question.value.trim())
      && (source !== "typed" || Boolean(written.value.trim()))
      && (source !== "memory" || Boolean(chosen()));
    send.disabled = running || !ready;
    clear(send, running ? spinner() : icon("shield"), h("span", {}, "판정"));
  }

  function draw() {
    drawChip();
    writtenRow.hidden = source !== "typed";
    updateSend();
  }

  function fit(area) {
    area.style.height = "auto";
    area.style.height = `${area.scrollHeight}px`;
  }

  async function loadProjects() {
    try {
      const listed = await teamCall("/api/team/projects", {});
      projects = listed.projects || [];
      if (!projects.length) clear(note, icon("warn"), "이 서버에 대화가 쌓인 프로젝트가 아직 없습니다. 직접 쓰기나 질문만으로 시험하세요.");
    } catch (error) {
      projects = [];
      clear(note, icon("warn"), `프로젝트를 읽지 못해 기억에서 답을 만들 수 없습니다. ${error.message}`);
    }
    if (!chosen()) projectId = projects[0]?.id || "";
    // With no project to answer from, the question alone is judged; the saved
    // choice stays for a server that has one.
    if (source === "memory" && !projects.length) source = "none";
    draw();
  }

  /** One trial's line, open while it runs and once it has its result. */
  function trialItem(asked) {
    for (const other of items.children) other.open = false;
    const from = asked.answer != null ? "직접 쓴 답" : asked.project ? `${asked.project.name}의 기억` : "질문만";
    const status = h("span", { class: "trial-status" }, tag("판정 중"));
    const meta = h("span", { class: "trial-meta" }, from);
    const body = h("div", { class: "trial-body" });
    items.prepend(h("details", { class: "trial-item", open: true },
      h("summary", {},
        status,
        h("span", { class: "trial-head" }, h("span", { class: "trial-q" }, asked.query), meta),
        h("span", { class: "audit-time" }, clock.format(new Date())),
        icon("chevron", "icon chev")),
      body));
    while (items.children.length > KEPT) items.lastElementChild.remove();
    return {
      wait: (text) => clear(body, h("div", { class: "trial-wait" }, spinner(), text)),
      done(trial, ms) {
        const [text, kind] = trialTag(trial);
        clear(status, tag(text, kind));
        meta.textContent = [from, callScores({ jev_score: trial.query?.score, answer_score: trial.answer_check?.score }), seconds(ms)].filter(Boolean).join(" · ");
        clear(body, drawTrial(trial, asked));
      },
      failed(view) {
        clear(status, tag("오류", "warn"));
        clear(body, view);
      },
    };
  }

  async function judge() {
    updateSend();
    if (send.disabled) return;
    const asked = { query: question.value };
    if (source === "typed") asked.answer = written.value;
    if (source === "memory") asked.project = { id: chosen().id, name: chosen().name };
    running = true;
    updateSend();
    const item = trialItem(asked);
    const started = performance.now();
    try {
      // A teammate's chat answers from the project's scope, which a project not opened
      // to anyone does not have yet: filled first, the trial answers the same way.
      if (asked.project) {
        item.wait("프로젝트의 대화를 모으는 중입니다. 처음에는 수십 초 걸릴 수 있습니다.");
        await teamCall("/api/team/scope", { project: asked.project });
      }
      item.wait(asked.project ? "질문을 판정하고 기억에서 답을 만드는 중입니다. 수십 초 걸릴 수 있습니다." : "판정하는 중입니다.");
      const trial = await post("/api/dashboard/guard-trial", asked);
      if (trial.enabled === false) {
        item.failed(notice("warn", h("b", {}, "이 기억 서버는 아직 가드 시험을 보여 주지 않습니다."), " 서버에서 기억 서버를 멈췄다가 다시 시작하면 됩니다."));
      } else {
        item.done(trial, performance.now() - started);
      }
    } catch (error) {
      item.failed(problem(error));
    } finally {
      running = false;
      updateSend();
    }
  }

  question.addEventListener("input", () => { fit(question); updateSend(); });
  written.addEventListener("input", () => { fit(written); updateSend(); });
  // Enter judges and Shift+Enter starts a new line. While a Korean syllable is
  // still being composed, Enter belongs to the IME; Safari reports that only
  // through keyCode 229, after compositionend has already fired.
  question.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    judge();
  });
  send.addEventListener("click", () => judge());
  // A click on the box that is not a control goes to the question.
  box.addEventListener("click", (event) => {
    if (event.target.matches(".trial-box, .trial-row, .trial-ends")) question.focus();
  });

  draw();
  loadProjects();
  return h("section", { class: "trial", "aria-label": "가드 시험" },
    h("div", { class: "trial-h" }, h("b", {}, "가드 시험"), h("span", {}, "시험은 조회 기록에 남지 않습니다.")),
    box,
    items);
}
