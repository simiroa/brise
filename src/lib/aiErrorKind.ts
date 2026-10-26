// PLAN-2026-09-05 §2 (트랙 B, WE E1) — 실패 화면에서 "무엇을 눌러야 하는지"를 정하려면 먼저
// 실패 메시지를 몇 가지 종류로 분류해야 한다. 백엔드는 `AppError::Io`/`AppError::Validation`
// 문자열 하나로만 원인을 실어 보내므로(타입으로 안 갈라진다 — src-tauri/src/repo/ai/transport.rs
// 의 check_ai_status/DEADLINE_EXCEEDED/CALL_CANCELLED가 이미 이 관례다), 프런트도 같은 방식으로
// 메시지 부분 문자열을 본다. 순수 함수 — AiResultModal.tsx가 이 결과로 행동 버튼을 고른다.

export type AiErrorKind =
  | "no_key"
  | "model_missing"
  | "unreachable"
  | "rate_limited"
  | "deadline"
  | "cancelled"
  | "input_too_long"
  | "unknown";

// ponytail: transport.rs 의 DEADLINE_EXCEEDED/CALL_CANCELLED 상수를 손으로 미러한다. FFI 경계
// 너머로 상수 하나씩을 커맨드로 노출하는 건 이 판정 하나를 위해 과하다 — 드리프트 천장: 백엔드
// 문구가 바뀌면 이 두 판정만 "unknown"으로 조용히 떨어진다([다시 생성]은 여전히 뜨므로 치명적이지
// 않다). 실제로 드리프트가 발견되면 그때 문자열을 반환하는 커맨드로 승격한다.
const DEADLINE_EXCEEDED_TEXT =
  "AI operation deadline exceeded before a retry or fallback could finish".toLowerCase();
const CALL_CANCELLED_TEXT = "AI call was cancelled by the user".toLowerCase();

export function classifyAiError(message: string): AiErrorKind {
  const m = (message ?? "").toLowerCase();
  if (!m.trim()) return "unknown";

  if (m.includes(DEADLINE_EXCEEDED_TEXT)) return "deadline";
  if (m.includes(CALL_CANCELLED_TEXT)) return "cancelled";
  // generate_from_prompt_inner (repo/ai/mod.rs) 의 유일한 캡 초과 문구: "... exceed AI input
  // limit of N characters (...); reduce or summarize the input".
  if (m.includes("ai input limit") || (m.includes("exceed") && m.includes("character"))) {
    return "input_too_long";
  }
  if (/\b401\b|\b403\b|api key|unauthorized/.test(m)) return "no_key";
  if (/\b404\b/.test(m) || /no such model/.test(m) || (m.includes("model") && m.includes("not found"))) {
    return "model_missing";
  }
  if (/connection refused|econnrefused|error sending request|failed to connect|could not connect|\bdns\b|\bconnect\b/.test(m)) {
    return "unreachable";
  }
  if (/\b429\b|rate limit|quota/.test(m)) return "rate_limited";
  return "unknown";
}
