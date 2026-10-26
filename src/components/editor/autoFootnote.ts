/**
 * 자동 각주 (AI) — 활성 섹션 본문에서 약어·어려운 용어를 골라내 각주를 달아준다.
 * PLAN-2026-09-27 §7-5 (Q10): `src/lib/autoFootnote.ts`로 핵심 로직 분리 및 3단계 파이프라인 제공.
 */
export {
  AUTO_FOOTNOTE_PROMPT,
  AUTO_FOOTNOTE_MAX,
  type AutoFootnoteTerm,
  parseAutoFootnoteTerms,
  generateAutoFootnotes,
  formatAutoFootnotesAsMarkdown,
  applyAutoFootnotes,
  runAutoFootnoteAction,
} from "../../lib/autoFootnote";
