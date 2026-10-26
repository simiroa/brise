/**
 * MobileNote intentionally mounts a REDUCED Tiptap schema vs desktop (no Table/Details/Highlight/
 * TextStyle/Color …). The authoritative extension list — and the desktop comparison table with the
 * reason for each difference — is mobileEditorExtensions.ts; this file does not re-enumerate it
 * (an inline copy here went stale once already). Loading a body that needs a missing extension and
 * then letting the 700ms autosave reserialize would silently drop that content (PRODUCT.md principle
 * 5: "저장은 자동, 유실 경로는 버그").
 *
 * canEditBodyOnMobile() sniffs body_md for constructs mobile cannot round-trip. P0-1/P0-2
 * (2026-07-31): images are NO LONGER unsupported — BriseImage + @tiptap/markdown are registered
 * on mobile, so `![alt](path){width=…}` and HTML <img> both preserve. **Never** add `![` to
 * this guard (that would permanently lock every image note read-only on phone).
 *
 * Still blocked — exactly the arms of UNSUPPORTED_BODY_RE below: tables (HTML or GFM pipe rows),
 * details (HTML or :::details fences), highlight (<mark> or ==…==), and color/style spans.
 * Markdown links (including note://) stay editable via the Link extension; a raw HTML <a> is not
 * sniffed (the regex has no arm for it).
 */
const UNSUPPORTED_BODY_RE =
  /<(table|thead|tbody|tr|t[dh]|details|summary|mark|span[^>]*style)|^\|.+\|[\r\n]+\|[-:| ]+\||:::details|==[^=]+==/im;

export function canEditBodyOnMobile(bodyMd: string): boolean {
  return !UNSUPPORTED_BODY_RE.test(bodyMd);
}

/** Read-only fallback display text — strips tags so a passthrough-HTML body (table/details/...)
 *  reads as plain text instead of raw markup. Same tag-strip shape as notes.ts::isNoteBodyEmpty. */
export function stripHtmlForDisplay(bodyMd: string): string {
  // 태그를 그냥 지우면 표 셀·문단이 붙는다("성명 정보점수김하늘…" — 조각 표는 읽기 전용이라 이 글자가 노트의 전부다).
  // 블록 끝 태그는 공백, 행 끝은 줄바꿈으로 바꾼다. 인라인 태그(`<strong>`…)는 단어 한가운데일 수 있어 그냥 지운다.
  // 임시 표식(\u0001 칸/블록 끝 · \u0002 행 끝)을 쓰는 이유: 본문에 원래 있던 공백(목록 들여쓰기 등)은 건드리지 않고
  // 우리가 넣은 것만 하나로 접기 위해서다. Rust 쪽(repo/checklist.rs::strip_tags_and_collapse)은 같은 발상이지만 피드
  // 발췌가 한 줄이라 행 끝도 공백이고, 여는 태그도 블록 경계로 본다 — 규칙이 글자 하나까지 같은 것은 아니다.
  return bodyMd
    .replace(/<\/(?:p|li|h[1-6]|t[dh])>|<br\s*\/?>/gi, "\u0001")
    .replace(/<\/tr>/gi, "\u0002")
    .replace(/<[^>]*>/g, "")
    .replace(/\u0001*\u0002\u0001*/g, "\n")
    .replace(/\u0001+/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Capture-screen preset stack visibility (owner feedback item 1) — `activeBodyEmpty` alone isn't
 *  enough: applying the 할 일 목록 builtin writes checkbox HTML with no text nodes, which
 *  notes.ts::isNoteBodyEmpty still reads as "empty" (tag-strip leaves ""). Without the
 *  `presetApplied` latch, the stack would stay glued to the screen after that one preset. A plain
 *  boolean function (not a component) so this rule is testable without mounting Tiptap. */
export function shouldShowCapturePresets(activeBodyEmpty: boolean, presetApplied: boolean): boolean {
  return activeBodyEmpty && !presetApplied;
}
