import { create } from "zustand";
// 원시 @tauri-apps/api invoke 를 여기서 쓰지 않는다 — 브라우저(동기화 웹/모바일)에서는
// window.__TAURI_INTERNALS__ 자체가 없어 "Cannot read properties of undefined (reading 'invoke')"
// 로 죽는다(2026-07-30 폰에서 실제 발생: 제목/연도 저장 경로). lib/invoke 의 callSilent 가
// Tauri IPC ↔ HTTP 브리지를 알아서 고른다 — 새 커맨드 호출도 반드시 이쪽을 쓸 것. (아래 슬라이스
// 파일들 — notesTree.ts/notesActive.ts/lib/noteAutosave.ts/lib/noteSnapshots.ts — 도 전부 이
// 규칙을 따른다.)
import type { Section, SectionUpdateOutput } from "../lib/commands.gen";
import { createNotesTreeSlice, type NotesTreeSlice } from "./notesTree";
import { createNotesActiveSlice, type NotesActiveSlice } from "./notesActive";
import { wireSnapshotScheduler, markSnapshotDirty } from "../lib/noteSnapshots";
import { call, emitNotice } from "../lib/invoke";
import { setSectionToken } from "../lib/sectionTokens";
import { t } from "../i18n/t";

// R2-a 분리(2026-08-04): 이 파일은 원래 ~974L의 단일 zustand 스토어였다(트리 캐시 + 활성 노트
// 문서 + 자동저장 디바운스 + 스냅샷 타이머 + 태그 카운트가 한 파일에 있었다). zustand 슬라이스
// 패턴으로 4개 파일로 쪼갰다 — 이 파일은 순수 조립 지점: 하나의 스토어를 만들어 export할 뿐,
// 소비처(컴포넌트 130여곳)는 여전히 `useNotesStore` 하나만 import한다(변경 없음).
//   - stores/notesTree.ts   — 폴더/노트 트리 캐시 + 태그 카운트(loadTree 계열)
//   - stores/notesActive.ts — 활성 노트 문서 + draft 상태기계 + 메타 setter
//   - lib/noteAutosave.ts   — 제목/연도 디바운스 자동저장
//   - lib/noteSnapshots.ts  — 60초 스냅샷 타이머 사이드카
export type NotesState = NotesTreeSlice & NotesActiveSlice;

export const useNotesStore = create<NotesState>((set, get, api) => ({
  ...createNotesTreeSlice(set, get, api),
  ...createNotesActiveSlice(set, get, api),
}));

wireSnapshotScheduler(useNotesStore);

export { displayTitle, isNoteBodyEmpty, type SavedState } from "./notesActive";
export { markSnapshotDirty };
export type { Section };

/**
 * 섹션 이름 바꾸기 — 탭 개명(SectionTabBar)과 분리 창 제목(SectionWindowApp)이 같이 쓴다. 두 UI 는
 * draft 만 들고 규칙은 여기 하나: 앞뒤 공백 제거, 빈 이름은 안내 후 거부, 같은 이름은 무동작.
 * 성공하면 저장된 이름, 아니면 null(거부·무동작·실패 — 실패는 call() 이 토스트+진단). 절대 throw 하지 않는다.
 */
export async function renameSection(sectionId: string, currentName: string, raw: string): Promise<string | null> {
  const name = raw.trim();
  if (!name) {
    emitNotice(t("editor.section_name_empty"));
    return null;
  }
  if (name === currentName) return null;
  try {
    // 이름 변경도 섹션 토큰을 올린다(D2②) — 응답 토큰을 받아 두지 않으면 다음 본문 저장이 자기 자신과 충돌한다.
    const w = await call<SectionUpdateOutput>("section_update", { id: sectionId, name });
    setSectionToken(sectionId, w?.section_updated_at);
  } catch {
    return null;
  }
  const n = useNotesStore.getState().activeNote;
  if (n) {
    useNotesStore.setState({
      activeNote: { ...n, sections: n.sections.map((s) => (s.id === sectionId ? { ...s, name } : s)) },
    });
  }
  markSnapshotDirty();
  return name;
}

/**
 * id-keyed 잠금 조회 — moveNote/insertAiSection/applyProposal처럼 **열려 있지 않을 수도 있는**
 * 노트를 대상으로 쓰기를 시도하는 경로용이다. activeNote.note.content_locked만 읽으면 두 가지로
 * 틀린다: (a) 지금 열려 있지 않은 잠긴 노트로의 쓰기를 못 막고(트리 다중선택 이동, 다른 탭/트리
 * 행에 대한 Ask-AI), (b) 잠긴 노트가 우연히 열려 있는 동안 무관한 노트로의 쓰기를 잘못 막는다.
 * activeNote 쪽이 더 최신이므로(옵티미스틱 갱신이 먼저 반영되는 곳) id가 일치하면 그쪽을,
 * 아니면 트리 캐시(noteIndex)를 본다. 어느 쪽에도 없으면 false(다른 모든 락 체크와 같은
 * "모르면 열어준다" 모양 — 실수로 영구히 잠그는 쪽보다 안전).
 */
export function isNoteContentLocked(id: string): boolean {
  const s = useNotesStore.getState();
  if (s.activeNote?.note.id === id) return !!s.activeNote.note.content_locked;
  return !!s.noteIndex.get(id)?.content_locked;
}
