/**
 * 노트 하나를 곁다리 컨텍스트로 읽는 함수 — AI에게 묻기의 `note` 참조(askAiDispatch.resolveRefs)와
 * AI로 표 편집의 근거 노트(editor/TableAiModal)가 **같은 함수**로 읽는다(코드 방침: 두 벌 금지).
 *
 * askAiDispatch 와 따로 둔 이유: 그쪽은 runAiAction·관계도/시트 파서·날씨까지 끌고 와서 AI에게 묻기
 * 모달(lazy)에만 실린다. 표 편집 모달은 에디터와 함께 정적으로 실리므로, 이 한 줄짜리 읽기 때문에
 * 그 그래프를 에디터 청크로 끌어오지 않는다.
 */
import { callSilent } from "../../lib/invoke";
import type { NoteDetail } from "../../lib/commands.gen";

/**
 * 제목 + 섹션 body_md 를 빈 줄로 이은 본문. `noteBodyForAi` 와 달리 그 노트를 **선택하지 않는다**
 * (탭 전환 없음 — 곁다리 컨텍스트가 사용자 화면을 바꾸면 안 된다). 못 읽으면(삭제됨 등) null.
 * `skipSectionId` — 그 섹션 하나만 뺀다(표를 고치는 섹션 자신을 근거에서 빼는 용도).
 */
export async function readNoteForContext(
  id: string,
  opts: { skipSectionId?: string | null } = {},
): Promise<{ title: string; body: string } | null> {
  const detail = await callSilent<NoteDetail>("note_get", { id }).catch(() => null);
  if (!detail) return null;
  const sections = opts.skipSectionId ? detail.sections.filter((s) => s.id !== opts.skipSectionId) : detail.sections;
  return { title: detail.note.title, body: sections.map((s) => s.body_md).join("\n\n") };
}
