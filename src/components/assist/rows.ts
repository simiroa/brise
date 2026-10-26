import { getActiveSection } from "../../lib/aiSectionBridge";
import { useNotesStore, displayTitle } from "../../stores/notes";
import type { AskAiTarget } from "../AskAiModal";
import type { AiActionPreset } from "../../stores/aiPrompts";
import { isActionSlot } from "../../stores/aiPresets";

export type SectionAiContextKind = "text" | "sheet" | "diagram";

/** `AskAiTarget(kind:"section")` 조립 — sectionId/sectionName/sectionBody 폴백 체인과 isDiagram/isSheet 플래그를 통합.
 *  W5: presetId, autoSend 추가. */
export function buildSectionAskAiTarget(
  ctx: {
    sec?: { id: string; name: string; body_md: string } | null;
    snap?: { body_md: string } | null;
  },
  kind: SectionAiContextKind,
  initialPrompt?: string,
  extra?: { presetId?: string; autoSend?: boolean },
): AskAiTarget {
  const fallbackId = kind === "sheet" ? "sheet" : kind === "diagram" ? "diagram" : "text";
  const fallbackName = kind === "sheet" ? "Sheet" : kind === "diagram" ? "Diagram" : "Note";
  return {
    kind: "section",
    sectionId: ctx.sec?.id ?? fallbackId,
    sectionName: ctx.sec?.name ?? fallbackName,
    sectionBody: ctx.snap?.body_md ?? ctx.sec?.body_md ?? "",
    isDiagram: kind === "diagram",
    diagramMounted: kind === "diagram",
    ...(kind === "sheet" ? { isSheet: true as const, sheetMounted: true as const } : {}),
    ...(initialPrompt ? { initialPrompt } : {}),
    ...(extra?.presetId ? { presetId: extra.presetId } : {}),
    ...(extra?.autoSend !== undefined ? { autoSend: extra.autoSend } : {}),
  };
}

/** 기존 테스트 호환을 위한 testid 매핑 */
export const LEGACY_TEST_IDS: Record<string, string> = {
  proofread: "assist-ai-spellcheck",
  list: "assist-ai-reorganize-list",
  metadata: "assist-ai-metadata",
  tags: "assist-ai-tags",
  summarize: "assist-ai-summary",
  translate: "assist-ai-translate",
  auto_footnote: "assist-ai-auto-footnote",
  start_text: "assist-ai-prompt-start",
  start_sheet: "assist-ai-sheet-start",
  sheet_formula: "assist-ai-sheet-formula-helper",
  sheet_sum: "assist-ai-sheet-summary-row",
  sheet_format: "assist-ai-sheet-format",
  diagram_add_node: "assist-ai-diagram-add-node",
  diagram_simplify: "assist-ai-diagram-simplify",
  diagram_align: "assist-ai-diagram-layout",
  diagram_progress: "assist-ai-diagram-progress",
};

export function assistTestId(id: string): string {
  return LEGACY_TEST_IDS[id] ?? `assist-ai-${id}`;
}

/**
 * 어시스트 패널의 AI 프리셋 목록 (PLAN-2026-09-27 §7-3, 7-4 W5).
 * 단일 저장소 `useAiPresetsStore.list`에서 대상별로 걸러낸다.
 * 순서는 단일 순서를 그대로 유지한다(Q7 확정).
 */
export function getAssistPresets(
  kind: SectionAiContextKind,
  blank: boolean,
  presets: AiActionPreset[],
): AiActionPreset[] {
  return presets.filter((p) => {
    // 바로 실행 액션의 숨김 자리(타일 없는 빌트인)는 AI 프리셋이 아니다 — 보이지 않는다.
    if (p.hidden || p.kind === "template" || isActionSlot(p)) return false;
    const isBlank = Boolean(p.blank);
    if (blank !== isBlank) return false;

    const targets =
      p.targets ??
      (p.kind === "sheet"
        ? ["sheet"]
        : p.kind === "diagram"
          ? ["diagram"]
          : ["note", "section"]);
    // 텍스트는 **노트 대상 목록**(§7-3) — 어시스트의 요약·번역·태그는 노트 전체에 도는 일이다. 섹션 전용 타일
    // (섹션 재구성 등)은 섹션 툴바·AI 모달의 섹션 대상에서 쓴다.
    if (kind === "text") {
      return targets.includes("note");
    }
    if (kind === "sheet") {
      return targets.includes("sheet");
    }
    if (kind === "diagram") {
      return targets.includes("diagram");
    }
    return false;
  });
}

/** 활성 섹션 컨텍스트 — AI 액션 행 실행 시 대상 섹션을 찾는다. */
export function getActiveSectionContext() {
  const note = useNotesStore.getState().activeNote;
  const snap = getActiveSection();
  const sec = snap ? note?.sections.find((s) => s.id === snap.id) : note?.sections[0];
  return { note, sec, snap };
}

/**
 * 어시스트에서 프리셋 클릭 시 문장이 찍힌 AI 모달을 연다(PLAN-2026-09-27 §7-4).
 * autorun 이 true 면 열린 직후 모달이 자동으로 send()를 호출한다.
 */
export function runAssistPreset(
  preset: AiActionPreset,
  kind: SectionAiContextKind,
  autorun: boolean,
  setAskAiTarget: (target: AskAiTarget) => void,
) {
  // 텍스트는 노트 대상으로 연다 — 섹션 대상으로 열면 요약·번역이 활성 섹션 하나만 읽는다(예전 어시스트의 요약은
  // 노트 전체를 읽었다, 2026-09-28 검토 S5). 시트·관계도는 그 섹션이 대상이다.
  const note = useNotesStore.getState().activeNote;
  if (kind === "text" && note) {
    setAskAiTarget({
      kind: "note",
      noteId: note.note.id,
      noteTitle: displayTitle(note.note.title),
      presetId: preset.id,
      autoSend: autorun,
    });
    return;
  }
  setAskAiTarget(
    buildSectionAskAiTarget(getActiveSectionContext(), kind, undefined, {
      presetId: preset.id,
      autoSend: autorun,
    }),
  );
}
