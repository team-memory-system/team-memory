// The owner's MCP tools a teammate may call, as the 수정 window's MCP 도구 tab and
// the 모든 팀원 도구 window show them: one switch per tool, in the three kinds
// gate-access.mjs OPENABLE_TOOLS keeps, each only to read. A whole-memory tool says,
// once one is on, that it reads past the folders chosen.
import { h, clear } from "./dom.js";
import { button, toggle } from "./ui.js";

/** Each kind, what it reads, and its tools with what each does, in gate-access.mjs order. */
export const TOOL_KINDS = [
  {
    key: "folder",
    title: "열린 폴더 안에서만",
    sub: "고른 폴더의 대화만 찾고 읽습니다",
    tools: [
      ["search", "낱말과 뜻으로 메시지 찾기"],
      ["list_sessions", "대화 목록 보기"],
      ["get_session_messages", "대화 읽기"],
      ["get_session_message", "메시지 하나 읽기"],
      ["get_session_context", "대화 요약과 최근 메시지"],
      ["inspect_session", "대화 정보 보기"],
      ["get_session_peers", "대화에 낀 사람 보기"],
      ["query_conclusions", "결론 찾기 (한 대화에서 나온 것만)"],
      ["list_conclusions", "결론 목록 (한 대화에서 나온 것만)"],
    ],
  },
  {
    key: "whole",
    title: "기억 전체를 섞어 답함",
    sub: "폴더로 나눌 수 없습니다",
    warn: "켜면 고르지 않은 폴더의 내용도 답에 섞일 수 있습니다. 사적인 내용은 Jev 가드가 막습니다.",
    tools: [
      ["chat", "내 기억에 묻기 (내 서버 모델이 답을 씀)"],
      ["get_representation", "나에 대해 정리된 것 보기"],
      ["get_peer_context", "정리된 것과 내 카드 함께 보기"],
      ["get_peer_card", "내 카드 보기"],
    ],
  },
  {
    key: "server",
    title: "서버 정보",
    sub: "대화 내용은 없습니다",
    tools: [
      ["server_info", "서버 버전과 설정"],
      ["list_peers", "이 서버의 사람·에이전트 이름"],
      ["get_metadata", "메타데이터 보기"],
      ["inspect_workspace", "워크스페이스 정보"],
      ["list_workspaces", "워크스페이스 목록"],
      ["get_queue_status", "기억 정리 대기열"],
    ],
  },
];

const ORDER = TOOL_KINDS.flatMap((kind) => kind.tools.map(([name]) => name));

/** What a teammate starts with when nothing else was chosen: gate-access.mjs DEFAULT_TOOLS. */
export const DEFAULT_TOOLS = TOOL_KINDS[0].tools.map(([name]) => name);

/**
 * The switches, ticked as `chosen`. `onChange` hears every change. The returned
 * `node` is the tab's content and `tools()` what is on, in the order above.
 */
export function toolPicker(chosen = DEFAULT_TOOLS, { onChange } = {}) {
  const on = new Set(chosen);
  const node = h("div", { class: "tool-kinds" });
  const tools = () => ORDER.filter((name) => on.has(name));
  const draw = () => {
    clear(node, ...TOOL_KINDS.map((kind) => {
      const names = kind.tools.map(([name]) => name);
      const all = names.every((name) => on.has(name));
      return h("section", { class: "tool-kind" },
        h("div", { class: "tool-kind-h" },
          h("h4", {}, kind.title), h("span", { class: "sub" }, kind.sub), h("span", { class: "sp" }),
          button(all ? "모두 끄기" : "모두 켜기", { kind: "small quiet", onClick: () => {
            for (const name of names) all ? on.delete(name) : on.add(name);
            draw();
            onChange?.(tools());
          } })),
        h("div", { class: "tool-rows" }, kind.tools.map(([name, does]) => h("div", { class: "tool-row" },
          h("div", { class: "v" }, h("code", {}, name), h("div", { class: "d" }, does)),
          toggle(on.has(name), (next) => {
            next ? on.add(name) : on.delete(name);
            draw();
            onChange?.(tools());
          }, { label: name })))),
        kind.warn && names.some((name) => on.has(name)) ? h("p", { class: "tool-warn" }, kind.warn) : null);
    }));
  };
  draw();
  return { node, tools };
}

/** How many tools are on, for a row or a tab: "MCP 도구 9개". */
export function toolsText(tools) {
  return `MCP 도구 ${(tools || []).length}개`;
}
