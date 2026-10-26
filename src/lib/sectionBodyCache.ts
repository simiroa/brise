// 섹션 본문 저장 뒤 `activeNote.sections` 캐시를 맞추는 한 지점.
//
// CLAUDE.md 함정 4: `updateSectionBody` 는 캐럿 튐 방지로 `activeNote.sections` 를 **일부러**
// 갱신하지 않는다. 그래서 본문을 통째로 갈아끼우는 호출자(관계도·시트·모바일 AI 치환)는
// 저장 직후 여기서 같은 캐시를 맞춰야 탭 왕복 시 본문이 낡은 값으로 되돌아가지 않는다.
//
// ponytail: 저장(`updateSectionBody`) 호출은 일부러 여기에 안 묶었다 — 데스크톱은 fire-and-forget
// 뒤에 캐시를 맞추고 모바일은 `await` 뒤에 맞춘다. 순서가 다르니 한 함수로 합치면 플래그가 생긴다.

import { useNotesStore } from '../stores/notes';

export function patchSectionBodyCache(sectionId: string, bodyMd: string): void {
  const n = useNotesStore.getState().activeNote;
  if (!n) return;
  const idx = n.sections.findIndex((s) => s.id === sectionId);
  if (idx === -1 || n.sections[idx].body_md === bodyMd) return;
  const nextSections = [...n.sections];
  nextSections[idx] = { ...nextSections[idx], body_md: bodyMd };
  useNotesStore.setState({ activeNote: { ...n, sections: nextSections } });
}
