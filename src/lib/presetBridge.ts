import { useNotesStore } from "../stores/notes";
import { insertAiSection } from "./aiSectionBridge";

/**
 * Bridge between PresetList (rendered inside SourcePanel when no note is open) and EditorPanel's
 * empty-state note-creation flow — siblings, not parent/child, same shape as aiSectionBridge.ts
 * (TitleBar <-> EditorPanel). EditorPanel owns newNote()/updateSectionBody()/focus sequencing;
 * PresetList only ever calls through this module.
 */

/** 프리셋 착지 명시 — manage 모달의 "만들기" 메뉴가 쓴다(제자리 적용은 없음).
 *  "auto"는 기존 동작(빈 노트 제자리 / 본문 있으면 새 섹션, notesActive::applyPreset 판정). */
export type PresetLanding = "auto" | "new-note" | "new-section";

export interface PresetApplyRequest {
  /** Note title to set, or null to leave the default ("Untitled Note"). */
  title: string | null;
  /** Section body — a plain body_md string, same shape every note already stores (see
   *  stores/presets.ts's TODO_PRESET_BODY_MD comment for why even the checklist preset is one). */
  bodyMd: string;
  /** 착지 강제 — manage 모달 전용. 생략하면 "auto"(기존 targetState 판정). */
  landing?: PresetLanding;
}

type ApplyPresetFn = (req: PresetApplyRequest) => Promise<void>;

let applyPresetFn: ApplyPresetFn = async () => {};

export function registerApplyPreset(fn: ApplyPresetFn): () => void {
  applyPresetFn = fn;
  return () => {
    if (applyPresetFn === fn) applyPresetFn = async () => {};
  };
}

export function applyPreset(req: PresetApplyRequest): Promise<void> {
  return applyPresetFn(req);
}

/**
 * W8-f 관계도 프리셋 — a SEPARATE small entry point from applyPreset() above, not a `kind` field
 * folded into PresetApplyRequest. Reasoning (investigated before writing this): applyPreset()'s
 * only implementation is EditorPanel's registerApplyPreset callback, which loads bodyMd into the
 * live Tiptap instance (sectionRef/bodyCacheRef/editor.commands.setContent) — machinery that a
 * diagram section explicitly bypasses (DiagramSection renders body_md itself; Tiptap never sees
 * it, see EditorPanel's own "다이어그램 섹션은 Tiptap에는 아무것도 싣지 않는다" comments). Routing
 * a diagram request through that callback would mean teaching a Tiptap-loading function how to
 * *also* create a diagram-kind section — a second responsibility it doesn't otherwise need.
 *
 * Instead this reuses the pipeline that already creates diagram sections correctly end-to-end
 * with zero EditorPanel changes: lib/aiSectionBridge.ts's insertAiSection (registered by
 * EditorPanel via registerSectionInserter, already wired for AI's "관계도 만들기" — see
 * stores/aiPresets.ts) appends a NEW kind:'diagram' section and switches the editor to it.
 * applyDiagramPreset() below mirrors applyPreset()'s own "ensure some note is open" + title-fill
 * behavior by calling the store's existing applyPreset(bodyMd, title) action with an empty body —
 * empty because a diagram is never written into section 0 as text, only appended as its own
 * section — so no note/notesActive.ts logic is duplicated, just its "ensure a note" side effect.
 */
export interface DiagramPresetApplyRequest {
  /** Note title to set, or null to leave the default — same semantics as PresetApplyRequest. */
  title: string | null;
  /** Diagram source (JSON IR; mermaid text before the 2026-09-04 rebuild) to seed the new diagram
   *  section with (never empty — see diagramStarter.ts's diagramBody() guard, which every
   *  diagram-kind section-create already goes through). */
  bodyMd: string;
  /** New section's tab label. */
  sectionName: string;
  /** 만든 섹션 탭을 바로 이름 입력 상태로 연다("+" 새 섹션 메뉴). */
  renameOnInsert?: boolean;
  /** 착지 강제 — manage 모달 전용("new-section"은 열린 노트가 전제, 없으면 no-op). */
  landing?: PresetLanding;
}

export async function applyDiagramPreset(req: DiagramPresetApplyRequest): Promise<void> {
  if (req.landing === "new-section") {
    // 명시적 새 섹션 — ensure-a-note("applyPreset("") 호출)를 건너뛴다. 열린 노트가 없으면
    // 몰래 노트를 만들지 않는다(메뉴 항목 자체가 비활성이라 도달하지 않는 경로).
    const noteId = useNotesStore.getState().activeNote?.note.id;
    if (!noteId) return;
    await insertAiSection(req.sectionName, req.bodyMd, noteId, "diagram", { postProcess: false, renameOnInsert: req.renameOnInsert });
    return;
  }
  await useNotesStore.getState().applyPreset("", req.title, req.landing);
  const targetNoteId = useNotesStore.getState().activeNote?.note.id;
  if (!targetNoteId) return;
  // postProcess:false — this is a template skeleton, not AI-written content; proposing metadata
  // from it would just burn a model call on a blank starter diagram.
  await insertAiSection(req.sectionName, req.bodyMd, targetNoteId, "diagram", { postProcess: false, renameOnInsert: req.renameOnInsert });
}

export interface SheetPresetApplyRequest {
  title: string | null;
  bodyMd: string;
  sectionName: string;
  renameOnInsert?: boolean;
  /** 착지 강제 — manage 모달 전용(applyDiagramPreset 과 같은 규약). */
  landing?: PresetLanding;
}

export async function applySheetPreset(req: SheetPresetApplyRequest): Promise<void> {
  if (req.landing === "new-section") {
    const noteId = useNotesStore.getState().activeNote?.note.id;
    if (!noteId) return;
    await insertAiSection(req.sectionName, req.bodyMd, noteId, "sheet", { postProcess: false, renameOnInsert: req.renameOnInsert });
    return;
  }
  await useNotesStore.getState().applyPreset("", req.title, req.landing);
  const targetNoteId = useNotesStore.getState().activeNote?.note.id;
  if (!targetNoteId) return;
  await insertAiSection(req.sectionName, req.bodyMd, targetNoteId, "sheet", { postProcess: false, renameOnInsert: req.renameOnInsert });
}


/**
 * Bridge for footnote/preview links jumping to a section — same register/dispatch pair shape as
 * applyPreset above. EditorPanel registers the navigator; footnoteMark.ts and SectionPreview.tsx
 * call navigateToSection.
 */
type SectionNavigator = (sectionId: string) => Promise<void>;

let sectionNavigator: SectionNavigator = async () => {};

export function registerSectionNavigator(fn: SectionNavigator): () => void {
  sectionNavigator = fn;
  return () => {
    if (sectionNavigator === fn) sectionNavigator = async () => {};
  };
}

export async function navigateToSection(sectionId: string): Promise<void> {
  await sectionNavigator(sectionId);
}
