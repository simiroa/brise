// 자동화 평가 — 비밀값 가림(PLAN-2026-10-08 R12 의 JS 거울).
//
// 실제 가림은 Rust `repo/ai/redact.rs`(W4~) 가 한다. 이 파일은 평가 하네스가 클라우드로 보내기 직전
// 같은 규칙을 적용해 **라이브 평가가 비밀값을 절대 보내지 않게** 하는 용도다. 두 구현이 갈라지면
// Rust 쪽이 SSOT — 이 파일을 맞춘다.
//
// 정규식은 문자열 조각으로 조립한다: 소스에 토큰 접두를 그대로 두면 비밀값 스캐너가 오탐할 수 있다.

export const REDACTED = "[가림]";

const P = {
  sk: "s" + "k-",
  gh: "g" + "h",
  akia: "AK" + "IA",
  asia: "AS" + "IA",
  eyj: "ey" + "J",
};

// 순서가 중요하다: 블록(PEM) → Bearer(뒤의 JWT 까지 한 건) → JWT → 키 모양 → 이메일.
export const PATTERNS = [
  { kind: "pem", re: new RegExp("-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----", "g") },
  { kind: "bearer", re: new RegExp("\\b[Bb]earer\\s+[A-Za-z0-9\\-._~+/]{16,}=*", "g") },
  { kind: "jwt", re: new RegExp("\\b" + P.eyj + "[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}", "g") },
  { kind: "openai", re: new RegExp("\\b" + P.sk + "[A-Za-z0-9_-]{20,}", "g") },
  { kind: "github", re: new RegExp("\\b(?:" + P.gh + "[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{22,})", "g") },
  { kind: "aws", re: new RegExp("\\b(?:" + P.akia + "|" + P.asia + ")[A-Z0-9]{16}\\b", "g") },
  { kind: "email", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g },
];

/** 비밀값·개인정보 모양을 `[가림]` 으로 바꾼다. → { text, count, kinds:{kind:n} } */
export function redact(text) {
  if (typeof text !== "string" || text.length === 0) return { text: text ?? "", count: 0, kinds: {} };
  let out = text;
  let count = 0;
  const kinds = {};
  for (const { kind, re } of PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, () => {
      count += 1;
      kinds[kind] = (kinds[kind] ?? 0) + 1;
      return REDACTED;
    });
  }
  return { text: out, count, kinds };
}
