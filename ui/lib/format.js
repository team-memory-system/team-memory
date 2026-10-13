// Names and dates the way a person reads them.

const SOURCES = {
  claude: "Claude Code",
  codex: "Codex",
  chatgpt: "ChatGPT",
  agy: "agy",
  hermes: "Hermes",
};

export function sourceLabel(source) {
  return SOURCES[source] || source || "기타";
}

/**
 * Conversations without a folder, by the app they came from (a session's
 * metadata.source, "unknown" when it names none): ChatGPT 기록 for ChatGPT imports.
 */
export function appRecords(source) {
  return source === "unknown" ? "기타 대화" : `${sourceLabel(source)} 기록`;
}

// Letters and digits whose sound ends in a consonant, as a Korean reader says them:
// naddle (내들), chenjing (첸징), 3 (삼). A name of other letters takes the open form.
const CLOSED_LETTERS = /(?:[bcdgklmnpt]|le)$/i;
const CLOSED_DIGITS = /[013678]$/;

/**
 * `word` with the particle its last sound takes, the pair written closed form first:
 * josa("철수", "을/를") is 철수를, josa("민준", "이/가") is 민준이.
 */
export function josa(word, pair) {
  const [closed, open] = pair.split("/");
  const text = String(word || "");
  const code = text.charCodeAt(text.length - 1);
  const ends = code >= 0xac00 && code <= 0xd7a3 ? (code - 0xac00) % 28 !== 0 : CLOSED_LETTERS.test(text) || CLOSED_DIGITS.test(text);
  return `${text}${ends ? closed : open}`;
}

export const SOURCE_FILTERS = [
  ["", "전체"],
  ["claude", "Claude Code"],
  ["codex", "Codex"],
  ["chatgpt", "ChatGPT"],
  ["agy", "agy"],
];

/** `user_chen` is the person; `assistant_codex` is Codex speaking. */
export function speakerLabel(peerId, me) {
  if (!peerId) return "";
  if (me && peerId === me) return "나";
  const assistant = /^assistant_(.+)$/.exec(peerId);
  if (assistant) return sourceLabel(assistant[1]);
  const automation = /^automation_(.+)$/.exec(peerId);
  if (automation) return `자동 작업 · ${automation[1].replace(/_/g, " ")}`;
  return peerId;
}

export function isAssistant(peerId) {
  return /^assistant_/.test(peerId || "");
}

/** Cron jobs, subagents and SDK calls write as peers too; they are not people. */
export function isAutomation(peerId) {
  return /^automation_/.test(peerId || "");
}

export function peerKind(peerId, me) {
  if (peerId === me) return "me";
  if (isAutomation(peerId)) return "automation";
  if (isAssistant(peerId)) return "agent";
  return "person";
}

const CARD_KINDS = {
  IDENTITY: "신원",
  ATTRIBUTE: "특징",
  PREFERENCE: "선호",
  TRAIT: "성향",
  INSTRUCTION: "지시",
  RELATIONSHIP: "관계",
  GOAL: "목표",
  INTEREST: "관심",
  SKILL: "기술",
};

/** A peer card line is "KIND: text"; show the kind as a label, not a shout. */
export function cardLine(line) {
  const match = /^([A-Z_]{3,20}):\s*(.*)$/.exec(String(line || ""));
  if (!match) return { kind: "", text: String(line || "") };
  return { kind: CARD_KINDS[match[1]] || match[1].toLowerCase(), text: match[2] };
}

const dayFormat = new Intl.DateTimeFormat("ko-KR", { month: "numeric", day: "numeric" });
const fullFormat = new Intl.DateTimeFormat("ko-KR", { year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
const timeFormat = new Intl.DateTimeFormat("ko-KR", { hour: "numeric", minute: "2-digit" });

export function relativeDay(value) {
  if (!value) return "";
  const date = new Date(value);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffDays = Math.floor((startOfToday - new Date(date.getFullYear(), date.getMonth(), date.getDate())) / 86_400_000);
  if (diffDays <= 0) return timeFormat.format(date);
  if (diffDays === 1) return "어제";
  if (diffDays < 7) return `${diffDays}일 전`;
  if (date.getFullYear() === now.getFullYear()) return dayFormat.format(date);
  return `${date.getFullYear()}. ${dayFormat.format(date)}`;
}

export function fullDate(value) {
  return value ? fullFormat.format(new Date(value)) : "";
}

export function time(value) {
  return value ? timeFormat.format(new Date(value)) : "";
}

/** "오후 3:40" today, "10월 14일 오후 3:40" on another day. */
export function dayTime(value) {
  if (!value) return "";
  const date = new Date(value);
  const day = date.toDateString() === new Date().toDateString() ? "" : `${date.getMonth() + 1}월 ${date.getDate()}일 `;
  return `${day}${timeFormat.format(date)}`;
}

export function number(value) {
  return new Intl.NumberFormat("ko-KR").format(value ?? 0);
}

export function ago(value) {
  if (!value) return "";
  const seconds = Math.round((Date.now() - new Date(value)) / 1000);
  if (seconds < 60) return "방금";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}분 전`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}시간 전`;
  return relativeDay(value);
}
