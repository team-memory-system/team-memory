// The Jev guard in the owner's words: what the bridge's reasons mean, how a
// verdict is labelled, and what a trial (가드 시험) comes to for the teammate. No
// DOM here, so the tests can load it.

// The bridge's names for a number that picks out one person (redact.py IDENTIFIERS).
const IDENTIFIERS = {
  "resident registration number": "주민등록번호",
  "foreign registration number": "외국인등록번호",
  "passport number": "여권번호",
  "driver's license number": "운전면허번호",
  "card number": "카드번호",
};

// What the bridge hides in a teammate's answer, by its kind (redact.py NAMES).
const MASKED = {
  resident: "주민등록번호",
  foreign: "외국인등록번호",
  passport: "여권번호",
  driver: "운전면허번호",
  card: "카드번호",
  account: "계좌번호",
  phone: "휴대폰 번호",
  email: "이메일",
  coordinate: "좌표",
  api_key: "API 키",
  private_key: "비밀 키",
  password: "비밀번호",
  encoded: "인코딩된 값",
};

/** What was hidden in an answer, as {kind: count} came from the bridge: "카드번호 1개 가림". */
export function maskedText(masked) {
  if (!masked || typeof masked !== "object") return "";
  const parts = Object.entries(masked)
    .filter(([, count]) => Number.isFinite(count) && count > 0)
    .map(([kind, count]) => `${MASKED[kind] || kind} ${count}개`);
  return parts.length ? `${parts.join(", ")} 가림` : "";
}

/**
 * One of the bridge's reasons for a verdict, in a few words. `allowed` is how the
 * question or answer went: when Jev does not answer, the server's fail mode lets it
 * through or stops it. With `cause`, only why, for beside a tag that already says
 * what happened. A reason the screen does not know stays as it came.
 */
export function reasonText(reason, allowed, { cause = false } = {}) {
  const text = String(reason || "").trim();
  const said = (whole, why) => (cause ? why : whole);
  if (text === "out of scope") return "사적인 질문으로 판정";
  // A number that picks out one person, refused by its form before Jev is asked.
  const held = /^(out of scope|answer withheld): it holds a (.+)$/.exec(text);
  if (held && IDENTIFIERS[held[2]]) {
    const number = IDENTIFIERS[held[2]];
    return held[1] === "out of scope" ? `${number}가 든 질문` : said(`${number}가 든 답이라 막음`, `${number}가 든 답`);
  }
  // "access" since teammates search; "chat" in the rows from before.
  if (/^The owner of this memory has turned your (access|chat) off/.test(text)) return "꺼 둔 동안 물음";
  if (text.startsWith("No conversation with that id is open to you")) return "열리지 않은 대화를 찾음";
  if (text.startsWith("No conversation in the folders open")) return "열린 폴더에 대화 없음";
  if (text.startsWith("The folders open to you on this MCP server hold more than")) return "열린 폴더의 대화가 너무 많음";
  if (text.startsWith("The conversations in the folders open to you could not be listed")) return "열린 폴더의 대화를 읽지 못함";
  if (text.includes("cannot be used with folders")) return "팀원에게 없는 도구";
  if (text === "query too long to judge") return said("너무 길어 판정하지 않고 거부", "너무 길어 판정하지 않음");
  if (text.startsWith("answer withheld")) return said("답에 민감한 내용이 있어 막음", "민감한 내용이 든 답으로 판정");
  if (text === "answer too long to judge") return said("답이 너무 길어 판정하지 않고 막음", "너무 길어 판정하지 않음");
  if (text.startsWith("answer not judged")) return said("답 판정 없이 통과 · 허브가 답 검사를 하지 않음", "허브가 답 검사를 하지 않음");
  if (text.startsWith("not judged")) return said("판정 없이 통과 · 팀에 Jev 키 없음", "팀에 Jev 키 없음");
  if (text.startsWith("jev unavailable for the answer")) {
    return said(allowed ? "답 판정 없이 통과 · Jev가 답하지 않음" : "Jev가 답을 판정하지 못해 막음", "Jev가 답하지 않음");
  }
  if (text.startsWith("jev unavailable")) return said(allowed ? "판정 없이 통과 · Jev가 답하지 않음" : "Jev가 답하지 않아 거부", "Jev가 답하지 않음");
  return text;
}

// Why a call failed on the server, by the kind of failure the bridge wrote: the
// exception's type, then its words (RuntimeError: Honcho API 500 for …).
const FAILURES = [
  [/Timeout|timed out/i, () => "기억 서버가 제때 답하지 않음"],
  [/Connect(?:ion)?Error|Connection refused|connection error/i, () => "기억 서버에 닿지 못함"],
  [/^(?:\w+: )?Honcho API (\d{3}) /, (match) => `기억 서버가 오류로 답함 (HTTP ${match[1]})`],
  [/^(?:\w+: )?Resource not found/, () => "찾는 대화나 메시지가 없음"],
];

/**
 * A failed call's cause in a few words, the listing of a teammate's conversations
 * named first when that is what failed. The bridge's own words stay in the call's
 * window (서버가 남긴 이유 원문).
 */
function failureText(text) {
  const listing = /^listing the sessions failed: (.*)$/.exec(text);
  const cause = listing ? listing[1] : text;
  const known = FAILURES.find(([pattern]) => pattern.test(cause));
  const why = known ? known[1](known[0].exec(cause)) : "서버에서 실패";
  return listing ? `열린 폴더의 대화 목록을 읽지 못함 · ${why}` : why;
}

/**
 * Why a call in the audit log was refused, failed or went through without a
 * judgment, in a few words; null for a plain pass. A call let through can carry a
 * reason for its question and another for its answer, joined by "; ", and a failed
 * one its cause and then what let it through unjudged. A refusal's own "; " (…;
 * omit it) stays inside it: only a Jev reason starts a second one.
 */
export function callReason(row) {
  const error = String(row?.error || "").split("\n")[0].trim();
  if (!error) return null;
  const allowed = row.status !== "denied";
  const parts = error.split(/; (?=out of scope|query too long|answer |not judged|jev unavailable)/);
  const said = parts.map((part, index) => (row.status === "error" && !index ? failureText(part) : reasonText(part, allowed)));
  return [...new Set(said)].join(" · ");
}

export const scoreText = (value) => Number(value).toFixed(2);

/** A call's scores as its row shows them: the question's, then the answer's. */
export function callScores(row) {
  return [
    row?.jev_score != null ? `Jev ${scoreText(row.jev_score)}` : "",
    row?.answer_score != null ? `답 ${scoreText(row.answer_score)}` : "",
  ].filter(Boolean).join(" · ");
}

/**
 * One step of a trial as a tag, [text, kind], or null for a step not taken. `part`
 * is "query", which is refused (거부), or "answer", which is held back (막음).
 */
export function verdictTag(view, part, gate = true) {
  if (!gate) return ["판정 꺼짐", "warn"];
  if (!view) return null;
  if (!view.allowed) return [part === "answer" ? "막음" : "거부", "bad"];
  if (view.unjudged) return ["판정 없이 통과", "warn"];
  return ["통과", "ok"];
}

/**
 * A whole trial as one tag, [text, kind], for its folded line: how it ends for the
 * teammate, and whether anything let it through without a judgment.
 */
export function trialTag(trial) {
  switch (trial?.outcome) {
    case "refused":
      return ["거부", "bad"];
    case "withheld":
      return ["막음", "bad"];
    case "no_answer":
      return ["답 없음", "warn"];
    case "passed":
      if (trial.gate === false) return ["판정 꺼짐", "warn"];
      if (trial.query?.unjudged || trial.answer_check?.unjudged) return ["판정 없이 통과", "warn"];
      return ["통과", "ok"];
    default:
      return ["알 수 없음", "warn"];
  }
}

/**
 * What a trial comes to for the teammate: { kind, title, text, message }, `kind` a
 * notice's. `message` is the one sentence a teammate gets in place of a refused
 * question or a withheld answer.
 */
export function trialOutcome(trial) {
  const off = trial?.gate === false;
  switch (trial?.outcome) {
    case "refused":
      return { kind: "bad", title: "질문에서 막힙니다.", text: "팀원은 아래 문구만 받습니다.", message: trial.message };
    case "withheld":
      return {
        kind: "bad",
        title: "답에서 막힙니다.",
        text: "팀원은 질문이 거부될 때와 같은 문구만 받아, 막힌 답이 있었는지도 알 수 없습니다.",
        message: trial.message,
      };
    case "no_answer":
      return { kind: "warn", title: "기억 서버에서 찾지 못했습니다.", text: "고른 폴더에 아직 대화가 없거나, 기억 서버가 답하지 못했습니다." };
    case "passed": {
      if (trial.answer == null) {
        return { kind: off ? "warn" : "ok", title: "질문은 통과합니다.", text: off ? "이 서버는 Jev 판정이 꺼져 있어 판정 없이 통과합니다." : "찾지 않아 답 검사는 하지 않았습니다." };
      }
      // What a teammate's agent searched for, or an answer written in the trial.
      const goes = Array.isArray(trial.found) ? "찾은 대화가 그대로 팀원에게 나갑니다." : "팀원에게 이 답이 그대로 나갑니다.";
      if (off) return { kind: "warn", title: goes, text: "이 서버는 Jev 판정이 꺼져 있어 질문과 답 모두 판정 없이 오갑니다." };
      if (trial.answer_check?.unjudged) return { kind: "warn", title: goes, text: "답은 판정 없이 나갑니다." };
      return { kind: "ok", title: goes, text: "" };
    }
    default:
      return { kind: "warn", title: "알 수 없는 결과입니다.", text: String(trial?.outcome ?? "") };
  }
}
