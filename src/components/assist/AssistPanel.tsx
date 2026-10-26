import { useState, Suspense } from "react";
import { usePresetsStore } from "../../stores/presets";
import { useNotesStore } from "../../stores/notes";
import { useSettingsStore } from "../../stores/settings";
import { useAiPresetsStore } from "../../stores/aiPresets";
import { getActiveSection } from "../../lib/aiSectionBridge";
import { useAiGlow, AI_GLOW_KEYS } from "../../stores/ai";
import type { AskAiTarget } from "../AskAiModal";
import { AskAiModal, SheetAssist, TextAssist } from "../../lazySurfaces";
import { IconAi } from "../icons";
import { Toggle } from "../settings/Toggle";
import { t } from "../../i18n/t";
import { usePresetEntries } from "./usePresetEntries";
import { DiagramAssist } from "./DiagramAssist";
import { PresetStylePopover } from "../presets/PresetStylePopover";
import { PresetManageDialogs } from "../presets/PresetManageDialogs";

/**
 * 어시스트 패널 — SourcePanel 이 노트가 비었을 때 그리는 자리(PLAN-2026-09-21 W1, PresetList.tsx
 * 의 strips 분기를 여기로 옮겼다). 판정은 `{ kind, blank }` 딱 두 축(계획 §2) 한 번뿐이고, 그 값을
 * 종류별 컴포넌트에 그대로 넘긴다 — 다른 조건으로 그룹을 켜지 않는다.
 *   kind  = 활성 섹션 종류(text/sheet/diagram)
 *   blank = targetState === "ready"(라이브 에디터가 게시, stores/presets.ts 그대로)
 * PresetList 는 이제 variant="menu"(탭바 "+")·mode="manage"(관리 모달) 전용으로 남는다.
 */

/** "AI 액션" 그룹 헤더 — text/sheet/diagram × 시작/작업 여러 자리에서 반복되는 동일 블록.
 *  W5: 바로 실행 토글(assist_preset_autorun) 추가. */
export function AiActionsGroupHeader({
  autorun,
  onToggleAutorun,
}: {
  autorun?: boolean;
  onToggleAutorun?: (v: boolean) => void;
} = {}) {
  return (
    <div
      className="label-caps"
      style={{
        color: "var(--accent)",
        fontSize: "var(--text-xs)",
        fontWeight: 600,
        padding: "var(--space-2xs) var(--space-2)",
        marginBottom: "var(--space-1)",
        letterSpacing: "0.04em",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <IconAi size={13} strokeWidth={2} />
        <span>{t("presets.ai_actions_title")}</span>
      </div>
      {onToggleAutorun && (
        <label
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            cursor: "pointer",
            fontSize: "var(--text-2xs, 11px)",
            color: "var(--muted)",
            fontWeight: 400,
            textTransform: "none",
            letterSpacing: "normal",
          }}
          title={t("presets.assist_autorun")}
        >
          <span>{t("presets.assist_autorun")}</span>
          <Toggle
            checked={!!autorun}
            onChange={onToggleAutorun}
            aria-label={t("presets.assist_autorun")}
            data-testid="assist-preset-autorun-toggle"
          />
        </label>
      )}
    </div>
  );
}

/** "형식명" 뮤트 헤더 — 목록 위에 반복되던 라벨만 다른 동일 스타일 블록. */
export function MutedFormatHeader({ label }: { label: string }) {
  return (
    <div
      className="label-caps"
      style={{
        color: "var(--faint)",
        fontSize: "var(--text-xs)",
        fontWeight: 600,
        padding: "var(--space-2xs) var(--space-2)",
        marginBottom: "var(--space-1)",
        letterSpacing: "0.04em",
      }}
    >
      {label}
    </div>
  );
}

export function AssistPanel({ onApplied }: { onApplied?: () => void } = {}) {
  const targetState = usePresetsStore((s) => s.targetState);
  const activeEditorKind = usePresetsStore((s) => s.activeEditorKind);
  const activeNote = useNotesStore((s) => s.activeNote);
  const assistPresetAutorun = useSettingsStore((s) => s.assistPresetAutorun);
  const setAssistPresetAutorun = useSettingsStore((s) => s.setAssistPresetAutorun);
  const aiPresets = useAiPresetsStore((s) => s.list);

  const secSnapshot = getActiveSection();
  const activeSec = secSnapshot
    ? activeNote?.sections.find((s) => s.id === secSnapshot.id)
    : activeNote?.sections[0];
  const isDiagram = activeSec?.kind === "diagram" || targetState === "diagram" || activeEditorKind === "diagram";
  const isSheet = activeSec?.kind === "sheet" || targetState === "sheet" || activeEditorKind === "sheet";
  const kind: "text" | "sheet" | "diagram" = isDiagram ? "diagram" : isSheet ? "sheet" : "text";
  const blank = targetState === "ready";

  const entries = usePresetEntries({ manage: false, inMenu: false, onApplied });

  const [askAiTarget, setAskAiTarget] = useState<AskAiTarget | null>(null);
  const isMetadataGlow = useAiGlow(AI_GLOW_KEYS.action("metadata"));
  const isTagsGlow = useAiGlow(AI_GLOW_KEYS.action("tags"));
  const isSummaryGlow = useAiGlow(AI_GLOW_KEYS.action("summarize"));
  const isTranslateGlow = useAiGlow(AI_GLOW_KEYS.action("translate"));
  const isAutoFootnoteGlow = useAiGlow(AI_GLOW_KEYS.action("auto_footnote"));
  const glowOf = {
    metadata: isMetadataGlow,
    tags: isTagsGlow,
    summarize: isSummaryGlow,
    translate: isTranslateGlow,
    auto_footnote: isAutoFootnoteGlow,
  };

  return (
    <div
      data-testid="preset-list"
      style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", position: "relative" }}
    >
      <div
        className="scroll"
        style={{
          flex: 1,
          overflow: "auto",
          padding: "var(--space-4)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-5)",
        }}
      >
        <div data-testid="note-templates-group">
          {kind === "text" && (
            // 지연 청크(Text·Sheet 둘 다) — 텍스트는 표·선택 처리가 에디터 스택(ProseMirror)을, 시트는 차트 패널이
            // recharts 를 정적으로 쓴다. 맨 import 로 두면 보조 패널이 부팅 때 실리면서 대시보드만 여는 부팅에도
            // 그 라이브러리들이 딸려 온다(lazySurfaces 에서 유휴 시간에 미리 받는다).
            <Suspense fallback={null}>
              <TextAssist
                blank={blank}
                entries={entries}
                glowOf={glowOf}
                setAskAiTarget={setAskAiTarget}
                presets={aiPresets}
                autorun={assistPresetAutorun}
                onToggleAutorun={setAssistPresetAutorun}
              />
            </Suspense>
          )}
          {kind === "sheet" && (
            <Suspense fallback={null}>
              <SheetAssist
                blank={blank}
                entries={entries}
                glowOf={glowOf}
                setAskAiTarget={setAskAiTarget}
                presets={aiPresets}
                autorun={assistPresetAutorun}
                onToggleAutorun={setAssistPresetAutorun}
              />
            </Suspense>
          )}
          {kind === "diagram" && (
            <DiagramAssist
              blank={blank}
              entries={entries}
              glowOf={glowOf}
              setAskAiTarget={setAskAiTarget}
              presets={aiPresets}
              autorun={assistPresetAutorun}
              onToggleAutorun={setAssistPresetAutorun}
            />
          )}
        </div>
      </div>

      {askAiTarget && (
        <Suspense fallback={null}>
          <AskAiModal target={askAiTarget} onClose={() => setAskAiTarget(null)} />
        </Suspense>
      )}

      <PresetManageDialogs
        rootEl={null}
        ctx={entries.ctx}
        onCloseCtx={() => entries.setCtx(null)}
        onOpenRename={(target) => entries.setRenameTarget(target)}
        onOpenStyle={(id, x, y) => entries.setStyleCtx({ id, x, y })}
        onOpenDelete={(target) => entries.setDeleteTarget(target)}
        makeMenu={entries.makeMenu}
        onCloseMakeMenu={() => entries.setMakeMenu(null)}
        hasOpenNote={entries.hasOpenNote}
        renameTarget={entries.renameTarget}
        onCloseRename={() => entries.setRenameTarget(null)}
        onRename={(id, newName) => void entries.renamePreset(id, newName)}
        deleteTarget={entries.deleteTarget}
        onCloseDelete={() => entries.setDeleteTarget(null)}
        onDelete={(id) => void entries.removePreset(id)}
        deleteBuiltinTarget={entries.deleteBuiltinTarget}
        onCloseDeleteBuiltin={() => entries.setDeleteBuiltinTarget(null)}
        onDeleteBuiltin={(id) => void entries.hideBuiltin(id)}
      />

      {entries.styleTarget && (
        <PresetStylePopover
          styleTarget={entries.styleTarget}
          styleCtx={entries.styleCtx}
          styleRef={entries.styleRef}
          styleX={entries.styleX}
          styleY={entries.styleY}
          rootEl={null}
          onClose={() => entries.setStyleCtx(null)}
          onSetStyle={(id, patch) => void entries.setPresetStyle(id, patch)}
        />
      )}
    </div>
  );
}
