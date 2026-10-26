import { useEffect, useState } from "react";
import { getHTMLFromFragment } from "@tiptap/core";
import type { AskAiTarget } from "../AskAiModal";
import { t } from "../../i18n/t";
import { BUILTIN_CHIPS, BUILTIN_VERB_LABEL_KEY } from "../presets/presetConstants";
import { AssistRow } from "../presets/AssistRow";
import { getAssistPresets, runAssistPreset, assistTestId } from "./rows";
import { tileIcon } from "../ai/askAiPresets";
import { useAiPresetsStore } from "../../stores/aiPresets";
import type { AiActionPreset } from "../../stores/aiPrompts";
import { AiActionsGroupHeader, MutedFormatHeader } from "./AssistPanel";
import type { usePresetEntries } from "./usePresetEntries";
import { getActiveEditor, getActiveSection, insertAiSection } from "../../lib/aiSectionBridge";
import { useNotesStore } from "../../stores/notes";
import { emitNotice } from "../../lib/invoke";
import { findMarkdownTables, listToDiagramText } from "../../lib/textDerive";
import { extractTableAiSnapshot } from "../editor/tableAiPlan";
import { parseDiagramText, type DiagramTextParseResult } from "../diagram/diagramText";
import { applyDiagramPreset, applySheetPreset } from "../../lib/presetBridge";
import { sheetFromMatrix } from "../../lib/sheet/fromMatrix";
import { serializeSheet } from "../../lib/sheet/types";
import { mdSerializeHtml } from "../../lib/mdSerialize";
import { deriveExcerptTitle } from "../../lib/selectionText";
import { IconTable, IconGraph, IconArrowRight } from "../icons";

type Entries = ReturnType<typeof usePresetEntries>;

/** 표 → 시트로 대상 행렬 — 캐럿이 표 안이면 그 표(extractTableAiSnapshot, tableAiPlan.ts 선례),
 *  아니면 본문의 첫 GFM 표(textDerive.ts::findMarkdownTables). 둘 다 없으면 undefined(행 부재). */
function findTableMatrix(bodyMd: string): string[][] | undefined {
  const editor = getActiveEditor();
  const caret = editor ? extractTableAiSnapshot(editor) : null;
  if (caret) return caret.rows;
  return findMarkdownTables(bodyMd)[0];
}

/** 표 → 시트로 적용 — useEditorPaste.ts::suggestSheetFromPaste 와 같은 관문
 *  (sheetFromMatrix → serializeSheet → applySheetPreset landing:"new-section", 곧 presetBridge.ts
 *  의 insertAiSection → section_create_with_body → appendSectionLocally → switchSection). 토스트
 *  제안 없이 바로 적용한다는 점만 다르다. */
async function applyTableToSheet(matrix: string[][]): Promise<void> {
  const { doc, truncated } = sheetFromMatrix(matrix);
  await applySheetPreset({
    title: null,
    bodyMd: serializeSheet(doc),
    sectionName: t("presets.sheet_name"),
    landing: "new-section",
  });
  if (truncated) emitNotice(t("editor.section_import_truncated"));
}

/** 선택 → 새 섹션으로 — 원본은 그대로 두고 선택 범위만 복사해 새 텍스트 섹션(발췌 제목은
 *  selectionText.ts::deriveExcerptTitle, 마크다운 변환은 SelectionContextMenu.tsx::excerptToNewNote
 *  와 같은 getHTMLFromFragment→mdSerializeHtml 경로 — 서식을 보존한다). AI 가 만든 내용이 아니므로
 *  postProcess:false(메타데이터 제안 안 태움) · ai_origin 없음(AI 표시 점 안 남음). */
async function applySelectionToSection(editor: NonNullable<ReturnType<typeof getActiveEditor>>): Promise<void> {
  const { from, to } = editor.state.selection;
  const slice = editor.state.doc.slice(from, to);
  const html = getHTMLFromFragment(slice.content, editor.schema);
  const bodyMd = mdSerializeHtml(html);
  if (!bodyMd.trim()) return;
  const plainText = editor.state.doc.textBetween(from, to, "\n");
  const name = deriveExcerptTitle(plainText) || t("note.untitled_note");
  const noteId = useNotesStore.getState().activeNote?.note.id;
  if (!noteId) return;
  await insertAiSection(name, bodyMd, noteId, "text", { postProcess: false });
}

/**
 * 작업 모드 파생 그룹(오너 제안 #6, PLAN-2026-09-21-assist-modes.md §6) — 선택/본문에서 비-AI 로
 * 파생되는 항목 셋. AI 행 위(위계상 "이 내용에 대한 AI"보다 "이 내용에서 곧바로 나오는 것"이 먼저).
 * 조건이 안 맞는 행은 **부재**(비활성이 아니다). 선택/본문은 aiSectionBridge 의 기존 접근 경로
 * (getActiveEditor/getActiveSection)로 매 렌더 다시 읽는다 — 새 전역 스토어는 만들지 않는다(계획 §6
 * 지시). 리렌더는 이 컴포넌트 로컬 상태로만 일으킨다: 활성 에디터의 selectionUpdate/update 이벤트를
 * 구독해 강제로 한 번 더 그린다(sheetFocus/diagramFocus 같은 전역 스토어의 대체).
 */
function TextDeriveGroup() {
  const [, refresh] = useState(0);
  useEffect(() => {
    const editor = getActiveEditor();
    if (!editor) return;
    const bump = () => refresh((n) => n + 1);
    editor.on("selectionUpdate", bump);
    editor.on("update", bump);
    return () => {
      editor.off("selectionUpdate", bump);
      editor.off("update", bump);
    };
  });

  const editor = getActiveEditor();
  const bodyMd = getActiveSection()?.body_md ?? "";
  const tableMatrix = findTableMatrix(bodyMd);
  const diagramTextSrc = listToDiagramText(bodyMd);
  const diagramParsed: DiagramTextParseResult | null = diagramTextSrc ? parseDiagramText(diagramTextSrc) : null;
  const diagramJson = diagramParsed?.ok ? diagramParsed.json : null;
  const hasSelection = !!editor && !editor.state.selection.empty;

  if (!tableMatrix && !diagramJson && !hasSelection) return null;

  return (
    <div data-testid="text-derive-group">
      <MutedFormatHeader label={t("presets.text_derive_title")} />
      {tableMatrix && (
        <AssistRow
          testid="assist-derive-sheet"
          icon={<IconTable size={15} strokeWidth={1.8} style={{ color: "var(--accent)", flex: "none" }} />}
          label={t("presets.text_derive_to_sheet")}
          onClick={() => void applyTableToSheet(tableMatrix)}
        />
      )}
      {diagramJson && (
        <AssistRow
          testid="assist-derive-diagram"
          icon={<IconGraph size={15} strokeWidth={1.8} style={{ color: "var(--accent)", flex: "none" }} />}
          label={t("presets.text_derive_to_diagram")}
          onClick={() =>
            void applyDiagramPreset({
              title: null,
              bodyMd: JSON.stringify(diagramJson),
              sectionName: t("presets.diagram_name"),
              landing: "new-section",
            })
          }
        />
      )}
      {hasSelection && editor && (
        <AssistRow
          testid="assist-derive-selection"
          icon={<IconArrowRight size={15} strokeWidth={1.8} style={{ color: "var(--accent)", flex: "none" }} />}
          label={t("presets.text_derive_to_selection")}
          onClick={() => void applySelectionToSection(editor)}
        />
      )}
    </div>
  );
}

/**
 * 텍스트 어시스트 — PresetList.tsx strips 분기에서 그대로 옮김(PLAN-2026-09-21 W1, 목표 매트릭스 §2).
 *   start(blank): AI 시작 1행 · 마크다운 템플릿 · 커스텀
 *   work(!blank): 파생 그룹(오너 제안 #6, 조건부) · AI 6행
 */
export function TextAssist({
  blank,
  entries,
  glowOf,
  setAskAiTarget,
  presets,
  autorun,
  onToggleAutorun,
}: {
  blank: boolean;
  entries: Entries;
  glowOf: Record<string, import("../../stores/ai").AiGlowPhase | false>;
  setAskAiTarget: (target: AskAiTarget) => void;
  presets?: AiActionPreset[];
  autorun?: boolean;
  onToggleAutorun?: (v: boolean) => void;
}) {
  const list = presets ?? useAiPresetsStore.getState().list;
  const rows = getAssistPresets("text", blank, list);

  return (
    <div
      className="assist-list"
      style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}
      data-testid={!blank ? "note-assist" : undefined}
    >
      {!blank && <TextDeriveGroup />}

      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
        <AiActionsGroupHeader autorun={autorun} onToggleAutorun={onToggleAutorun} />
        {rows.map((preset) => {
          const Icon = tileIcon(preset.icon, preset.kind);
          return (
            <AssistRow
              key={preset.id}
              testid={assistTestId(preset.id)}
              icon={<Icon size={15} strokeWidth={1.8} style={{ color: "var(--accent)", flex: "none" }} />}
              label={preset.name}
              isGlow={glowOf[preset.id]}
              onClick={() => runAssistPreset(preset, "text", !!autorun, setAskAiTarget)}
            />
          );
        })}
      </div>

      {/* 마크다운 템플릿 — 빈 노트에서만(내용이 있으면 AI 제안만, D1). */}
      {blank && (
        <div>
          <MutedFormatHeader label={t("editor.markdown")} />
          {entries.textEntries
            .filter((e) => BUILTIN_CHIPS.some((b) => b.id === e.key))
            .map((e) => (
              <AssistRow
                key={e.key}
                icon={e.icon}
                label={t(BUILTIN_VERB_LABEL_KEY[e.key as keyof typeof BUILTIN_VERB_LABEL_KEY] ?? "") || e.label}
                onClick={e.onApply}
                onContextMenu={entries.contextMenuFor(e)}
                {...e.hover}
              />
            ))}
          {entries.textEntries.some((e) => !BUILTIN_CHIPS.some((b) => b.id === e.key)) && (
            <>
              <div
                className="label-caps"
                style={{ color: "var(--muted)", fontSize: "var(--text-xs)", padding: "var(--space-3) var(--space-2) var(--space-1)" }}
              >
                {t("presets.custom_section")}
              </div>
              {entries.textEntries
                .filter((e) => !BUILTIN_CHIPS.some((b) => b.id === e.key))
                .map((e) => (
                  <AssistRow
                    key={e.key}
                    indent
                    icon={e.icon}
                    label={e.label}
                    onClick={e.onApply}
                    onContextMenu={entries.contextMenuFor(e)}
                    {...e.hover}
                  />
                ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
