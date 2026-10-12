// 추출·드림·묻기: the three jobs the memory server gives a chat model, each with its
// own model and effort (scripts/gateway.mjs CHAT_ROLES). The same three rows are
// first setup's 모델 step and 서버 → 모델's 수정 window.
import { h } from "./dom.js";
import { segmented } from "./ui.js";

export const ROLES = [["deriver", "추출"], ["dream", "드림"], ["dialectic", "묻기"]];
const SUBSCRIPTION = { codex: "ChatGPT", claude: "Claude" };
// The router lists what Ollama serves as well, and an embedding model cannot chat.
const EMBEDDING_MODEL = /embed/i;

/** What a person subscribes to, by the gateway's backend. */
export function subscriptionName(backend) {
  return SUBSCRIPTION[backend] || backend || "기타";
}

/**
 * The model and effort of each role when nothing is chosen yet, from the models on
 * offer: the first of `preferred` among them, at the role's own effort. The memory
 * server fills a role left alone the same way (gateway.mjs chooseChatRoles).
 */
export function defaultRoles(offered, { preferred = [], roleEfforts = {} } = {}) {
  const model = preferred.find((id) => offered.includes(id)) || offered.find((id) => !EMBEDDING_MODEL.test(id)) || "";
  return Object.fromEntries(ROLES.map(([key]) => [key, { model, effort: roleEfforts[key] || "low" }]));
}

/**
 * The rows, bound to `values` ({ deriver: { model, effort }, ... }), which they
 * change in place. `groups` is [{ backend, models }]; `current`, what the server runs
 * now, marks its model 지금 씀; `onChange(key, part)` hears which role changed and
 * whether its "model" or its "effort". `tried[key]` is the line under a row for what
 * 써 보기 says about it.
 */
export function roleRows(values, { groups, efforts, current = null, onChange } = {}) {
  const tried = {};
  const rows = ROLES.map(([key, name]) => {
    const value = values[key];
    const line = h("div", { class: "tried", "aria-live": "polite" });
    tried[key] = line;
    const select = h("select", { class: "select", "aria-label": `${name} 모델` },
      groups.map((group) => {
        const models = group.models.filter((id) => !EMBEDDING_MODEL.test(id));
        return models.length ? h("optgroup", { label: subscriptionName(group.backend) },
          models.map((id) => h("option", { value: id, selected: id === value.model }, current?.[key]?.model === id ? `${id} · 지금 씀` : id))) : null;
      }));
    select.addEventListener("change", () => {
      value.model = select.value;
      line.textContent = "";
      line.className = "tried";
      onChange?.(key, "model");
    });
    const effort = segmented(efforts.map((item) => [item, item]), value.effort, (item) => {
      value.effort = item;
      onChange?.(key, "effort");
    });
    effort.setAttribute("aria-label", `${name} effort`);
    return h("div", { class: "role" },
      h("div", { class: "rn" }, h("b", {}, name), h("span", {}, key)),
      h("div", { class: "pick" }, select),
      h("div", { class: "ef" }, h("span", {}, "effort"), effort),
      line);
  });
  return { root: h("div", { class: "roles" }, rows), tried };
}
