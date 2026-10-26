/**
 * 채팅 전송 실패 사유 분류 — 폰(원격)에서 "잘 안 됐어요" 한 줄로는 디버깅이 안 되므로, 프로바이더/게이트가
 * 돌려준 메시지(transport.rs::check_ai_status 문구 포함)에서 범주만 뽑아 사용자에게 보이고 진단 로그에도
 * 같은 범주를 남긴다. 노트 본문은 이 입력에 없다(에러 메시지만).
 */
export type ChatFailureKind = "quota" | "auth" | "privacy" | "timeout" | "network" | "empty" | "unknown";

export function classifyChatFailure(message: string): ChatFailureKind {
  const m = message.toLowerCase();
  if (/\b429\b|rate.?limit|quota|too many requests|resource.?exhausted/.test(m)) return "quota";
  if (/\b40[13]\b|api key|unauthor|forbidden|permission/.test(m)) return "auth";
  if (/ai_enabled|privacy|consent/.test(m)) return "privacy";
  if (/timed? ?out|timeout|deadline/.test(m)) return "timeout";
  if (/failed to fetch|network|connect|dns|unreachable|refused|offline|\b50[234]\b|unavailable/.test(m)) return "network";
  if (/is empty|no json object|empty/.test(m)) return "empty";
  return "unknown";
}

/** 진단 로그/화면용 짧은 사유 — 앞 120자만(프로바이더 본문은 이미 서버에서 마스킹·300자 캡). */
export function chatFailureDetail(message: string): string {
  return message.replace(/\s+/g, " ").trim().slice(0, 120);
}
