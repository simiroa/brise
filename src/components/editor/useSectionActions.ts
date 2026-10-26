import { useEffect, type MutableRefObject } from "react";
import { useNotesStore, markSnapshotDirty } from "../../stores/notes";
import { useUiStore } from "../../stores/ui";
import { registerNoteDropHandler } from "../../lib/noteDrag";
import { call, emitNotice } from "../../lib/invoke";
import { withSectionTokenRefresh } from "../../lib/sectionTokens";
import { showUndoToast } from "../../lib/undo";
import { t } from "../../i18n/t";
import type { Section } from "../../lib/commands.gen";

type SectionRef = MutableRefObject<{ id: string; body: string; kind: string } | null>;

/** Wave R3: section CRUD extracted out of EditorPanel.tsx (handleAddSection/handleDeleteSection/
 *  handleReorderSection/handleDropReorder) — the side effect that matters more than the line count:
 *  moving these out lets EditorPanel's early return sit right after its last hook, closing the
 *  "hook after a conditional return" trap structurally (nothing but this hook call + JSX follows it
 *  now). `handleAddDiagramSection`/the AI-insert bridge stay in EditorPanel.tsx — both need
 *  buildDiagramSectionArgs/buildAiInsertSectionArgs, which stay there for
 *  EditorPanel.diagram.test.tsx; importing them here would be a circular EditorPanel<->this-file
 *  dependency for no real gain. `appendSectionLocally` is returned so EditorPanel's diagram/AI-insert
 *  call sites (and this hook's own handleAddSection) share the exact same patch-locally-instead-of
 *  -reload logic instead of three copies of it. */
export function useSectionActions(
  sectionRef: SectionRef,
  switchSection: (s: Section) => Promise<void>,
  bodyCacheRef: MutableRefObject<Record<string, string>>
) {
  const previewItem = useUiStore((s) => s.previewItem);
  const setPreviewItem = useUiStore((s) => s.setPreviewItem);

  // section_create*/create_with_body already return the full new Section — patch it into
  // activeNote.sections locally rather than reloading the whole note over IPC.
  // 본체는 스토어(appendActiveSection) — 새 섹션의 토큰 심기(D2② W4)를 폰 경로와 한 곳에서 한다.
  const appendSectionLocally = (noteId: string, newSec: Section) => {
    useNotesStore.getState().appendActiveSection(noteId, newSec);
  };

  const handleAddSection = async () => {
    // 더보기 메뉴 "내용잠금"(TitleBar.tsx) — 모든 섹션 추가 호출자(이 함수)가 지나는 단일
    // 지점에서 한 번 막는다(SectionTabBar.tsx의 "+" 버튼 disabled는 UI 단의 첫 방어선일 뿐).
    if (useNotesStore.getState().activeNote?.note.content_locked) {
      emitNotice(t("editor.content_locked_tooltip"));
      return;
    }
    try {
      const id = await useNotesStore.getState().ensureMaterialized();
      if (!id) {
        emitNotice(t("editor.note_required_for_section"));
        return;
      }
      const newSec = await call<Section>("section_create", { note_id: id });
      // section_create already returns the new Section — append it locally instead of
      // selectNote(id) (flushAll + a full note_get reload of every section's body) just to see
      // it. Same local-patch pattern as handleReorderSection below.
      appendSectionLocally(id, newSec);
      markSnapshotDirty();
      await switchSection(newSec);
    } catch {
      /* call() 이 AppError 토스트를 이미 표출함 */
    }
  };

  // 섹션 삭제. 순서가 중요하다:
  //  1) 삭제 대상이 현재 편집 중인 섹션이면 먼저 다른 섹션으로 전환한다. switchSection 이
  //     flush 를 수행하므로, 디바운스에 걸려 있던 편집분이 이미 사라진 행에 write 되는 일이 없다.
  //  2) 그 다음 삭제하고, 로컬 body 캐시에서도 지운다(안 지우면 같은 id 가 재사용될 때 유령 본문).
  const handleDeleteSection = async (s: Section) => {
    const n = useNotesStore.getState().activeNote;
    if (!n) return;
    if (n.sections.length <= 1) {
      emitNotice(t("editor.section_last_cannot_delete"));
      return;
    }
    // 더보기 메뉴 "내용잠금" — 삭제 호출자 셋(탭 X 버튼/키보드 Delete/우클릭 "휴지통으로 이동")이
    // 전부 이 함수 하나로 모이므로 여기 한 번만 막는다(SectionTabBar.tsx의 X 버튼 disabled는
    // UI 단의 첫 방어선일 뿐 — 우클릭 메뉴는 이 체크가 유일한 방어선이다).
    if (n.note.content_locked) {
      emitNotice(t("editor.content_locked_tooltip"));
      return;
    }
    try {
      if (sectionRef.current?.id === s.id) {
        const fallback = n.sections.find((sec) => sec.id !== s.id);
        if (fallback) await switchSection(fallback);
      }
      if (previewItem?.kind === "section" && previewItem.sectionId === s.id) {
        setPreviewItem(null);
      }
      const originalOrder = n.sections.map((sec) => sec.id);
      await call("section_delete", { id: s.id });
      delete bodyCacheRef.current[s.id];
      markSnapshotDirty();
      await useNotesStore.getState().selectNote(n.note.id);
      // 휴지통 경유라 바로 되돌릴 수 있다 — 우측 하단 토스트 + 전역 Ctrl+Z(undo.ts latestUndo).
      // 창이 지나면 휴지통 화면에서 복구한다.
      showUndoToast(t("editor.section_trashed", { name: s.name || t("editor.new_section") }), () => {
        void restoreDeletedSection(n.note.id, s.id, originalOrder);
      });
    } catch {
      /* call() 이 AppError 토스트를 이미 표출함 */
    }
  };

  // 삭제 되돌리기. section_restore 는 노트 맨 뒤에 붙이므로(specs/commands/sections.yaml) 삭제 직전
  // 순서로 다시 맞추고, 그 노트가 아직 열려 있으면 되살린 탭으로 돌아간다.
  const restoreDeletedSection = async (noteId: string, sectionId: string, originalOrder: string[]) => {
    try {
      await call("section_restore", { id: sectionId });
      const store = useNotesStore.getState();
      if (store.activeNote?.note.id !== noteId) return; // 다른 노트로 옮겨 갔으면 맨 뒤 복구로 충분
      await store.selectNote(noteId);
      const current = useNotesStore.getState().activeNote;
      if (!current || current.note.id !== noteId) return;
      const present = new Set(current.sections.map((sec) => sec.id));
      const ordered = [
        ...originalOrder.filter((id) => present.has(id)),
        ...current.sections.map((sec) => sec.id).filter((id) => !originalOrder.includes(id)),
      ];
      // 정렬은 노트의 모든 섹션 토큰을 올린다(D2②) — 토큰을 다시 읽어야 다음 저장이 자기 자신과 충돌하지 않는다.
      await withSectionTokenRefresh(noteId, ordered, () => call("section_reorder", { note_id: noteId, ordered_ids: ordered }));
      const byId = new Map(current.sections.map((sec) => [sec.id, sec] as const));
      const reordered = ordered.map((id) => byId.get(id)!);
      useNotesStore.setState({ activeNote: { ...current, sections: reordered } });
      markSnapshotDirty();
      const restored = byId.get(sectionId);
      if (restored) await switchSection(restored);
    } catch {
      /* call() 이 AppError 토스트를 이미 표출함(원 노트가 휴지통이면 CONFLICT) */
    }
  };

  // 섹션 재정렬 — 이웃과 자리를 맞바꾼다. 마우스 경로는 이제 탭 드래그앤드롭(아래
  // handleDropReorder)이 맡고, 이 함수는 키보드 경로(탭에 포커스 후 Ctrl+←/→)로 남겨둔다
  // — 드래그가 유일한 재정렬 수단이 되면 마우스 없이는 순서를 못 바꾸게 되므로. 활성 섹션은
  // 재정렬 후에도 그대로 선택된 채 남는다(순서만 바뀔 뿐 sectionRef/switchSection 은 건드리지 않는다).
  const handleReorderSection = async (s: Section, direction: -1 | 1) => {
    const n = useNotesStore.getState().activeNote;
    if (!n) return;
    const ids = n.sections.map((sec) => sec.id);
    const idx = ids.indexOf(s.id);
    const swapIdx = idx + direction;
    if (idx < 0 || swapIdx < 0 || swapIdx >= ids.length) return;
    [ids[idx], ids[swapIdx]] = [ids[swapIdx], ids[idx]];
    try {
      await withSectionTokenRefresh(n.note.id, ids, () => call("section_reorder", { note_id: n.note.id, ordered_ids: ids }));
      const byId = new Map(n.sections.map((sec) => [sec.id, sec] as const));
      const reordered = ids.map((id) => byId.get(id)!);
      useNotesStore.setState({ activeNote: { ...n, sections: reordered } });
      markSnapshotDirty();
    } catch {
      /* call() 이 AppError 토스트를 이미 표출함 */
    }
  };

  // 탭 드래그 재정렬(마우스 경로) — 아래 registerNoteDropHandler 가 부른다.
  // draggedId 를 targetId 자리로 옮긴 전체 순서 배열을 만들어 section_reorder 를 한 번만 호출.
  // handleReorderSection 은 키보드 재정렬(Ctrl+화살표)용으로 남겨둔다.
  const handleDropReorder = async (draggedId: string, targetId: string) => {
    const n = useNotesStore.getState().activeNote;
    if (!n) return;
    const ids = n.sections.map((sec) => sec.id);
    const from = ids.indexOf(draggedId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0 || from === to) return;
    ids.splice(from, 1);
    ids.splice(to, 0, draggedId);
    try {
      await withSectionTokenRefresh(n.note.id, ids, () => call("section_reorder", { note_id: n.note.id, ordered_ids: ids }));
      const byId = new Map(n.sections.map((sec) => [sec.id, sec] as const));
      const reordered = ids.map((id) => byId.get(id)!);
      useNotesStore.setState({ activeNote: { ...n, sections: reordered } });
      markSnapshotDirty();
    } catch {
      /* call() 이 AppError 토스트를 이미 표출함 */
    }
  };

  // 섹션을 다른 노트로 이동 — 드래그(트리 노트 행)와 우클릭 메뉴가 함께 쓰는 유일한 경로다.
  // 순서는 삭제 경로와 같다(위 handleDeleteSection 주석): 활성 섹션이면 먼저 전환해 switchSection
  // 의 flush 가 곧 사라질 행에 쓰이지 않게 한다. 낙관적 갱신은 하지 않는다 — 두 노트를 건드려
  // 롤백이 복잡하고 왕복이 짧다(PLAN-2026-09-10 D3). 유일 섹션·휴지통 노트 판정은 Rust 가 하고
  // 토스트는 call() 이 띄운다.
  const handleMoveSection = async (sectionId: string, targetNoteId: string) => {
    const n = useNotesStore.getState().activeNote;
    if (!n || !targetNoteId || n.note.id === targetNoteId) return;
    try {
      if (sectionRef.current?.id === sectionId) {
        const fallback = n.sections.find((sec) => sec.id !== sectionId);
        if (fallback) await switchSection(fallback);
      }
      await call("section_move", { id: sectionId, target_note_id: targetNoteId });
    } catch {
      return; /* call() 이 AppError 토스트를 이미 표출함 */
    }
    // getState() 로 읽는다 — 이 함수는 한 번만 등록되는 드롭 핸들러에서도 불려서 구독 값
    // (previewItem) 이 첫 렌더에 굳은 채일 수 있다.
    const ui = useUiStore.getState();
    if (ui.previewItem?.kind === "section" && ui.previewItem.sectionId === sectionId) {
      ui.setPreviewItem(null);
    }
    delete bodyCacheRef.current[sectionId];
    markSnapshotDirty();
    await useNotesStore.getState().selectNote(n.note.id);
    // 대상 노트는 따로 무효화하지 않는다 — stores/tabs.ts 는 탭 id 배열만 들고 노트 본문 캐시가
    // 없어서(탭 전환은 매번 selectNote 로 다시 읽는다) 무효화할 대상 자체가 없다.
  };

  // 탭 드래그 드롭 — 대상은 DOM 속성(data-note-drop-target)이 표시하고 처리는 여기 한 곳이다
  // (lib/noteDrag.ts 규약). 빈 deps 로 한 번만 등록한다: 핸들러가 쓰는 상태는 전부
  // useNotesStore.getState() 로 그 자리에서 읽으므로 첫 클로저가 계속 옳다.
  useEffect(
    () =>
      registerNoteDropHandler((_noteId, targetId, _x, _y, _image, section) => {
        if (!section) return; // 노트·이미지 드래그는 우리 것이 아니다
        const n = useNotesStore.getState().activeNote;
        // 다른 노트의 섹션이면(멀티 창 등) 이 노트를 건드리지 않는다.
        if (!n || n.note.id !== section.noteId) return;
        // 미리보기 카드에 드롭 → 그 섹션을 미리보기에 고정(첨부 바의 시트 파생 타일을 대신하는
        // 진입점, 오너 2026-09-10). IPC/DB 없이 순수 UI 상태라
        // getState() 로 한 번 쏘고 끝(구독이 아니므로 첫 렌더 클로저로도 최신 setter 를 잡는다).
        if (targetId === "preview:card") {
          useUiStore.getState().setPreviewItem({ kind: "section", noteId: n.note.id, sectionId: section.id });
          return;
        }
        if (targetId.startsWith("note:")) {
          void handleMoveSection(section.id, targetId.slice("note:".length));
          return;
        }
        if (!targetId.startsWith("section:")) return;
        const targetSectionId = targetId.slice("section:".length);
        if (!targetSectionId || targetSectionId === section.id) return;
        void handleDropReorder(section.id, targetSectionId);
      }),
    []
  );

  return {
    appendSectionLocally,
    handleAddSection,
    handleDeleteSection,
    handleReorderSection,
    handleDropReorder,
    handleMoveSection,
  };
}
