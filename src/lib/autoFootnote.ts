/**
 * 자동 각주 (AI) — 활성 섹션 본문에서 약어·어려운 용어를 골라내 각주를 달아준다.
 * PLAN-2026-09-27 §7-5 (Q10): 생성 → 결과 확인 → [적용] 3단계 파이프라인.
 *
 * 1단계: `generateAutoFootnotes(docText)` - LLM 호출 및 용어/설명 파싱
 * 2단계: `formatAutoFootnotesAsMarkdown(terms)` - 결과 상자에서 확인 가능한 마크다운 표현
 * 3단계: `applyAutoFootnotes(terms, editor)` - 에디터에 각주 첨부 및 인라인 마크 적용
 */
import type { Editor } from "@tiptap/core";
import { call, emitNotice } from "./invoke";
import { t } from "../i18n/t";
import type { Attachment } from "./commands.gen";
import { getActiveEditor } from "./aiSectionBridge";
import { useAiStore } from "../stores/ai";
import { useNotesStore } from "../stores/notes";
import { findUnmarkedTermRange } from "../components/editor/footnoteMark";

export const AUTO_FOOTNOTE_PROMPT =
  "당신은 노트에 각주를 다는 도우미입니다. 아래 노트 본문에서 처음 읽는 사람이 모를 만한 약어·전문용어·" +
  "고유명사를 골라, 각각에 대한 짧은 설명을 만드세요.\n\n" +
  "지켜야 할 것:\n" +
  "- term 은 노트 본문에 나온 **표기 그대로**(글자 단위로 동일하게) 옮겨 적으세요. 조사·어미를 붙이거나 " +
  "원형으로 바꾸거나 다시 쓰지 마세요. 본문에 없는 표기는 버려집니다.\n" +
  "- definition 은 1~2문장으로 간결하게 쓰고, 노트 원문과 동일한 언어로 쓰세요.\n" +
  "- 누구나 아는 흔한 단어는 고르지 마세요. 정말 설명이 필요한 것만 최대 10개까지 고르세요.\n" +
  "- 확실하지 않은 것은 지어내지 말고 그냥 빼세요. 고를 것이 없으면 빈 배열 []을 출력하세요.\n\n" +
  "출력 형식(JSON 배열 하나만 출력, 설명·서론·맺음말·코드 펜스 금지):\n" +
  '[{"term": "본문에 나온 표기", "definition": "짧은 설명"}]';

export const AUTO_FOOTNOTE_MAX = 12;

export interface AutoFootnoteTerm {
  term: string;
  definition: string;
}

/** 모델 출력 문자열을 AutoFootnoteTerm 배열로 파싱 */
export function parseAutoFootnoteTerms(raw: string): AutoFootnoteTerm[] {
  if (!raw || !raw.trim()) return [];

  let text = raw.trim();
  const fence = text.match(/^```(?:json)?[ \t]*\r?\n?([\s\S]*?)\r?\n?```$/i);
  if (fence) text = fence[1].trim();

  const arr = text.match(/\[[\s\S]*\]/);
  if (!arr) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(arr[0]);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const seen = new Set<string>();
  const out: AutoFootnoteTerm[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const rec = entry as Record<string, unknown>;
    const term = typeof rec.term === "string" ? rec.term.trim() : "";
    const definition = typeof rec.definition === "string" ? rec.definition.trim() : "";
    if (!term || !definition || seen.has(term)) continue;
    seen.add(term);
    out.push({ term, definition });
    if (out.length >= AUTO_FOOTNOTE_MAX) break;
  }
  return out;
}

/** 1단계: 모델을 호출하여 용어 및 설명 목록을 생성 */
/** 1단계: 용어 추출. **안내는 부른 쪽이 한다**(AI 모달은 결과 상자, 바로 실행은 토스트 — 두 번 알리지 않게).
 *  null = 호출이 막혔거나 실패했다(generateFromPrompt 가 이미 알렸다), [] = 찾은 용어가 없다(또는 본문이 비었다). */
export async function generateAutoFootnotes(docText: string): Promise<AutoFootnoteTerm[] | null> {
  if (!docText.trim()) return [];
  const raw = await useAiStore.getState().generateFromPrompt(AUTO_FOOTNOTE_PROMPT, docText);
  if (raw == null) return null;
  return parseAutoFootnoteTerms(raw);
}

/** 2단계: 결과 상자에서 확인할 수 있도록 마크다운으로 렌더링 */
export function formatAutoFootnotesAsMarkdown(terms: AutoFootnoteTerm[]): string {
  if (!terms.length) return "";
  return terms.map((item) => `- **${item.term}**: ${item.definition}`).join("\n");
}

/** 3단계: 확정된 각주 목록을 에디터에 적용 */
export async function applyAutoFootnotes(
  terms: AutoFootnoteTerm[],
  targetEditor?: Editor | null,
): Promise<number> {
  const editor = targetEditor ?? getActiveEditor();
  if (!editor) {
    emitNotice(t("ai.auto_footnote_no_section"));
    return 0;
  }

  const noteId = await useNotesStore.getState().ensureMaterialized();
  if (!noteId) {
    emitNotice(t("editor.note_required_for_section"));
    return 0;
  }

  let added = 0;
  for (const { term, definition } of terms) {
    if (editor.isDestroyed) break;
    if (!findUnmarkedTermRange(editor.state.doc, term)) continue;

    let att: Attachment;
    try {
      att = await call<Attachment>("attachment_add_footnote", {
        note_id: noteId,
        text: definition,
        anchor_text: term,
      });
    } catch {
      continue;
    }
    if (editor.isDestroyed) break;

    const range = findUnmarkedTermRange(editor.state.doc, term);
    if (!range) continue;
    editor.chain().setTextSelection(range).setMark("footnote", { id: att.id }).run();
    added += 1;
  }

  if (!added) {
    emitNotice(t("ai.auto_footnote_none"));
    return 0;
  }

  if (!editor.isDestroyed) {
    editor.commands.setTextSelection(editor.state.selection.to);
  }
  await useNotesStore.getState().reloadActive();
  emitNotice(t("ai.auto_footnote_done", { count: added }));
  return added;
}

/** 단발 실행 호환용 레거시 실행기 */
export async function runAutoFootnoteAction(): Promise<void> {
  const editor = getActiveEditor();
  if (!editor) {
    emitNotice(t("ai.auto_footnote_no_section"));
    return;
  }
  const docText = editor.state.doc.textBetween(0, editor.state.doc.content.size, "\n", " ");
  if (!docText.trim()) {
    emitNotice(t("editor.ai_empty_result"));
    return;
  }
  const terms = await generateAutoFootnotes(docText);
  if (terms == null) return;
  if (!terms.length) {
    emitNotice(t("ai.auto_footnote_none"));
    return;
  }
  await applyAutoFootnotes(terms, editor);
}
