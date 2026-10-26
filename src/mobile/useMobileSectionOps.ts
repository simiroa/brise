/**
 * 폰 노트 화면의 섹션 조작 — 섹션 스트립 길게 누르기(이름 변경·순서·삭제), 새 섹션 만들기(+ 버튼·AI 삽입·전사 폴백),
 * AI 가 관계도/시트 소스를 통째로 바꾸는 경로. 모두 "서버가 확인한 뒤에 activeNote.sections 를 로컬로 맞춘다".
 * 어떤 섹션을 어떤 모양으로 칠하는지는 useMobileBodyEditor/useMobileSectionView 가 쥐고, 여기는 그걸 부른다.
 */
import { useNotesStore, renameSection as renameSectionInStore } from "../stores/notes";
import type { Section } from "../lib/commands.gen";
import { call, emitNotice } from "../lib/invoke";
import { withSectionTokenRefresh } from "../lib/sectionTokens";
import { patchSectionBodyCache } from "../lib/sectionBodyCache";
import { clearSaveFailed, hasSaveFailed, markSaveFailed } from "../lib/sectionSaveFailures";
import { isSectionGated } from "../lib/sectionTokens";
import { prepareAiInsertNoteId } from "../lib/aiSectionBridge";
import { diagramBody } from "../components/diagram/diagramStarter";
import { createBudgetSheetJson } from "../components/sheet/sheetStarter";
import { t } from "../i18n/t";
import type { MobileBodyEditor } from "./useMobileBodyEditor";

export function useMobileSectionOps(ed: MobileBodyEditor) {
  const { sectionRef, flushRef } = ed;

  // K2 (W6): section-strip long-press actions — rename / move forward / move backward / delete.
  // Desktop's equivalents live in components/editor/useSectionActions.ts, wired to EditorPanel's
  // bodyCacheRef/previewItem (neither exists on mobile — see MobileNote.tsx's component comment).
  // Mirrored here instead of imported for that reason, but same shape: flush the pending debounced
  // edit first (switchSection's own discipline), call the command, and patch activeNote.sections
  // locally only once the server has confirmed. Never optimistic — MobileActionSheet's own run()
  // helper (its 7 verbs) uses the same call-then-patch order, so there is nothing to roll back on
  // failure; call() already toasts, and MobileSectionStrip's run() helper just leaves the sheet open
  // so the user can retry.
  // ponytail: the sheet is reachable only by a 400ms long-press on a tab, no keyboard/right-click
  // path — the same gap the W1-W5 accessibility audit found on MobileTreeRow's note-row long-press.
  // Ceiling: a keyboard-only user cannot rename/reorder/delete a section on this screen at all.
  // Upgrade path: an onContextMenu handler (desktop already routes Shift+F10/Menu-key there for
  // free) opening the same sheet, mirroring TreeListRow's onContextMenu-alongside-long-press shape.
  const patchSections = (next: Section[]) => {
    const n = useNotesStore.getState().activeNote;
    if (!n) return;
    useNotesStore.setState({ activeNote: { ...n, sections: next } });
  };

  // 스토어 renameSection 한 곳으로 — 이름 변경 응답의 섹션 토큰을 받아 둬야 다음 본문 저장이 자기 자신과
  // 충돌하지 않는다(D2②). 스토어 쪽은 실패를 삼키고 null 을 주므로, 시트가 열린 채 남도록 여기서 던진다.
  const renameSection = async (id: string, name: string) => {
    await flushRef.current();
    const current = useNotesStore.getState().activeNote?.sections.find((s) => s.id === id)?.name ?? "";
    if (name.trim() === current) return;
    if ((await renameSectionInStore(id, current, name)) === null) throw new Error("section rename failed");
  };

  const reorderSection = async (id: string, direction: -1 | 1) => {
    const n = useNotesStore.getState().activeNote;
    if (!n) return;
    const ids = n.sections.map((s) => s.id);
    const idx = ids.indexOf(id);
    const swapIdx = idx + direction;
    if (idx < 0 || swapIdx < 0 || swapIdx >= ids.length) return; // already at the boundary — sheet disables the button too
    await flushRef.current();
    [ids[idx], ids[swapIdx]] = [ids[swapIdx], ids[idx]];
    await withSectionTokenRefresh(n.note.id, ids, () => call("section_reorder", { note_id: n.note.id, ordered_ids: ids }));
    const byId = new Map(n.sections.map((s) => [s.id, s]));
    patchSections(ids.map((sid) => byId.get(sid)!));
  };

  // Client-side last-section guard mirrors desktop's useSectionActions.ts::handleDeleteSection
  // (same editor.section_last_cannot_delete copy) — avoids a doomed round trip and a raw CONFLICT
  // code. The sheet already disables the delete row at sections.length<=1; this is the race-safety
  // net for "another device deleted the rest between opening the sheet and confirming".
  const deleteSection = async (id: string) => {
    const n = useNotesStore.getState().activeNote;
    if (!n) return;
    if (n.sections.length <= 1) {
      emitNotice(t("editor.section_last_cannot_delete"));
      return;
    }
    await flushRef.current();
    await call("section_delete", { id }); // CONFLICT (last section) surfaces via call()'s own toast
    const n2 = useNotesStore.getState().activeNote;
    if (!n2) return;
    const deletedIdx = n2.sections.findIndex((s) => s.id === id);
    const nextSections = n2.sections.filter((s) => s.id !== id);
    patchSections(nextSections);
    if (sectionRef.current?.id === id && nextSections.length > 0) {
      await ed.switchSection(nextSections[Math.min(deletedIdx, nextSections.length - 1)]);
    }
  };

  // Passed to MobileAiSheet as a prop (not lib/aiSectionBridge.ts — see MobileAiSheet's header
  // comment). Mirrors EditorPanel's registerSectionInserter callback: materialize a draft if
  // needed, create the new section server-side, patch it into activeNote locally, then jump the
  // single-section mobile view straight to it so the user sees the AI result immediately.
  // targetNoteId is required so a mid-flight note switch cannot land the result on B (same
  // prepareAiInsertNoteId policy as desktop's bridge).
  const insertSection = async (
    name: string,
    body_md: string,
    targetNoteId: string,
    kind?: "text" | "diagram" | "sheet",
  ) => {
    // P0-3: 지금 섹션의 대기분을 먼저 보내고, 그 저장이 실패했으면 새 섹션으로 옮기지 않는다 — 옮기면 실패한 본문이 화면에서
    // 사라진다(실패 배너가 떠 있다). 초안이면 prepareAiInsertNoteId 가 노트를 만들기 전에 본문부터 가야 한다.
    await flushRef.current();
    const curId = sectionRef.current?.id;
    if (curId && hasSaveFailed(curId)) return;
    const id = await prepareAiInsertNoteId(targetNoteId);
    if (!id) return;
    try {
      // section_create_with_body's `kind` param landed (concurrent agent's diagram-kind work,
      // src-tauri/src/commands/sections.rs) — passed straight through, same shape desktop's own
      // section-create path uses.
      // Same never-born-empty guard desktop's buildDiagramSectionArgs/buildAiInsertSectionArgs use
      // — the AI 관계도 만들기 path can hand us "" (see diagramBody), and mobile has its own
      // inserter, so the guard has to sit on both boundaries.
      const body = kind === "diagram" ? diagramBody(body_md) : body_md;
      const newSec = await call<Section>("section_create_with_body", { note_id: id, name, body_md: body, kind });
      const n = useNotesStore.getState().activeNote;
      if (n && n.note.id === id) {
        // 토큰까지 심는다(D2② W4) — 안 그러면 이 섹션은 다음 노트 로드까지 토큰 없이 저장된다.
        useNotesStore.getState().appendActiveSection(id, newSec);
        // D3(2026-10-10): 폰에서는 "+" 로 만든 섹션도 이름 입력을 띄우지 않는다 — 기본 이름 그대로, 이름 바꾸기는
        // 섹션 줄의 길게 누르기(MobileSectionStrip)가 맡는다.
      }
      // Trust the caller's requested kind for immediate UI feedback even if `newSec.kind` came back
      // "text" (an older/not-yet-updated backend that ignores the extra `kind` field) — the section
      // we're about to show is what the caller asked for, not necessarily what got persisted.
      ed.showSection({ ...newSec, kind: kind ?? newSec.kind }, { clearUneditable: false });
    } catch {
      /* call() already toasted */
    }
  };

  // 섹션 스트립 "+" 선택지와 관계도 템플릿 시트가 같은 insertSection 을 쓴다(노트 id 는 누른 순간의 활성 노트).
  const activeNoteId = () => useNotesStore.getState().activeNote?.note.id;
  const addTextSection = () => {
    const noteId = activeNoteId();
    if (noteId) void insertSection(t("editor.new_section_text"), "", noteId);
  };
  const addSheetSection = () => {
    const noteId = activeNoteId();
    if (noteId) void insertSection(t("editor.new_section_sheet"), createBudgetSheetJson(), noteId, "sheet");
  };
  /** 템플릿 → the SAME insertSection(name, source, "diagram") the AI diagram action uses. */
  const addDiagramSection = (name: string, source: string) => {
    const noteId = activeNoteId();
    if (noteId) return insertSection(name, source, noteId, "diagram");
  };

  // 관계도 수정하기 (AI, owner item ⑤) — the AI returns the FULL updated diagram source (JSON IR;
  // mermaid text before the 2026-09-04 rebuild) for the section that's already open, so this
  // REPLACES its body instead of inserting a new section.
  // Writes through the same two steps DiagramSection.saveNow uses (updateSectionBody +
  // patchSectionBodyCache — lib/sectionBodyCache.ts says why the local patch is required), then
  // remounts DiagramSection.
  //
  // ponytail: last-writer-wins — if the user somehow types into the source textarea while the AI
  // call is in flight, the AI result overwrites it. The sheet covers the diagram while it runs, so
  // this is near-unreachable; add a lock only if it ever actually bites.
  // AI 가 통째로 바꾼 본문의 쓰기 — 화면(다시 마운트된 편집기)은 이미 새 본문을 쥐어 편집기 쪽 flush 가 다시 보내지 못하므로,
  // 실패하면 실패 집합에 재전송 함수와 함께 남긴다(나가기 차단 + [다시 시도]). 충돌·사라진 섹션은 게이트가 쥔다.
  const writeReplaced = async (id: string, body_md: string): Promise<void> => {
    await useNotesStore.getState().updateSectionBody(id, body_md);
    patchSectionBodyCache(id, body_md);
    if (isSectionGated(id)) return;
    if (useNotesStore.getState().savedState === "failed") markSaveFailed(id, () => writeReplaced(id, body_md));
    else clearSaveFailed(id);
  };

  const replaceDiagramSource = async (body_md: string) => {
    const sec = sectionRef.current;
    if (!sec || sec.kind !== "diagram") return;
    sec.body = body_md;
    ed.replaceDiagramBody(body_md);
    await writeReplaced(sec.id, body_md);
  };

  const replaceSheetSource = async (body_md: string) => {
    const sec = sectionRef.current;
    if (!sec || sec.kind !== "sheet") return;
    sec.body = body_md;
    ed.replaceSheetBody(body_md);
    await writeReplaced(sec.id, body_md);
  };

  return {
    renameSection,
    reorderSection,
    deleteSection,
    insertSection,
    addTextSection,
    addSheetSection,
    addDiagramSection,
    replaceDiagramSource,
    replaceSheetSource,
  };
}

export type MobileSectionOps = ReturnType<typeof useMobileSectionOps>;
