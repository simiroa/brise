import { useRef, useState } from "react";
import { AiActionEditor, type AiActionAutoAdd } from "./presets/AiActionEditor";
import { PresetRow } from "./presets/PresetRow";
import { PresetManageDialogs } from "./presets/PresetManageDialogs";
import { PresetStylePopover } from "./presets/PresetStylePopover";
import { usePresetEntries } from "./assist/usePresetEntries";
import { t } from "../i18n/t";

/**
 * 프리셋 리스트 — 이제 두 곳에서만 쓰인다(PLAN-2026-09-21 W1: 어시스트 패널(SourcePanel 프리뷰 칸)은
 * `assist/AssistPanel.tsx` 가 대신한다. strips 분기와 그 전용 코드(ASSIST_ROWS·Explore·관계도 타입
 * 그룹·`stores/sheetFocus` 구독·`SheetChartsPanel` 등)는 전부 그쪽으로 옮겼다):
 *   1. SectionTabBar 의 "+" 메뉴 (variant="menu") — 세로 목록. "무엇으로 새 섹션을 만들까"만 묻는
 *      자리라 종류 3개(빈 노트/관계도/시트)만 보인다.
 *   2. TreeHeaderActions/설정의 관리 모달 (mode="manage", PresetManageModal 이 감싼다) — 탭 2개:
 *      "노트 프리셋"(세로 목록, 순서·이름변경·아이콘/색·제거·실행이 전부 명시적 버튼)과
 *      "AI 액션"(AiActionEditor — PLAN-2026-08-30 §3 W4).
 *
 * 빌트인·커스텀·AI 템플릿(kind:"template") → Entry[] + 호버/컨텍스트 메뉴/적용 헬퍼는 어시스트의
 * 시작 모드와 공유하는 `usePresetEntries` 훅(assist/usePresetEntries.tsx)에서 온다.
 */
export function PresetList({
  mode = "picker",
  variant = "panel",
  onApplied,
  initialManageTab,
  aiOnly,
  autoAdd,
  initialId,
}: {
  mode?: "picker" | "manage";
  variant?: "panel" | "menu";
  /** 프리셋이 실제로 적용된 뒤 호출 — 이 리스트를 모달로 띄운 호출자가 스스로 닫을 수 있게. */
  onApplied?: () => void;
  /** mode="manage" 전용 — 어느 탭으로 열지("notes" 기본). menu 는 무시한다. */
  initialManageTab?: "notes" | "ai_actions";
  /** mode="manage" 전용 — AI 프리셋 편집기만(탭 줄 없음). AI 모달의 연필·"+추가"가 쓴다: 그 위에서
   *  노트 프리셋의 "만들기"를 누르면 새 노트가 AI 모달 뒤에서 열려 모달이 옛 노트를 가리키게 된다. */
  aiOnly?: boolean;
  /** AI 프리셋 편집기에 넘긴다 — 열리자마자 이 종류로 새 프리셋 하나(AiActionEditor 참고). */
  autoAdd?: AiActionAutoAdd;
  /** AI 프리셋 편집기가 처음 고를 항목(AiActionEditor 참고). */
  initialId?: string;
} = {}) {
  const manage = mode === "manage";
  const inMenu = !manage && variant === "menu";
  const [manageTab, setManageTab] = useState<"notes" | "ai_actions">(aiOnly ? "ai_actions" : (initialManageTab ?? "notes"));
  // manage 모드(ModalShell 안)에서 렌더될 때 이 컴포넌트 루트가 <dialog> 안에 있는지 판단하는
  // 앵커 — popoverRoot 참고.
  const rootRef = useRef<HTMLDivElement>(null);

  const entries = usePresetEntries({ manage, inMenu, onApplied });

  return (
    <div
      ref={rootRef}
      data-testid="preset-list"
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        position: "relative",
      }}
    >
      <div
        className="scroll"
        style={{
          flex: 1,
          overflow: "auto",
          // manage 모드에서만 리스트 자체에 상한을 둬 헤더/푸터는 고정하고 리스트만 스크롤되게 한다.
          ...(manage ? { maxHeight: "min(60vh, 480px)" } : {}),
          // "+" 메뉴(inMenu)는 바깥 ContextMenuShell 이 이미 패딩을 준다 — 여기서 또 주면 이 행들만 안쪽으로
          // 들어가 같은 메뉴의 AI 행(래퍼 밖)과 좌표가 어긋났다.
          padding: inMenu ? 0 : "var(--space-4)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-5)",
        }}
      >
        {/* manage 모드 전용 탭 — "노트 프리셋" / "AI 액션" (PLAN-2026-08-30 §3 W4). menu 는 이 블록
            자체가 렌더되지 않는다. */}
        {manage && !aiOnly && (
          <div className="picker-tabs" role="tablist" style={{ marginBottom: "var(--space-1)" }}>
            <button
              type="button"
              role="tab"
              aria-selected={manageTab === "notes"}
              className="picker-tab"
              data-active={manageTab === "notes"}
              data-testid="preset-manage-tab-notes"
              onClick={() => setManageTab("notes")}
            >
              {t("tree.presets_open")}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={manageTab === "ai_actions"}
              className="picker-tab"
              data-active={manageTab === "ai_actions"}
              data-testid="preset-manage-tab-ai-actions"
              onClick={() => setManageTab("ai_actions")}
            >
              {t("presets.ai_actions_title")}
            </button>
          </div>
        )}

        {(!manage || manageTab === "notes") && (
        <div data-testid="note-templates-group">
          {manage && (
            <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginBottom: "var(--space-2)" }}>
              <div className="label-caps" style={{ color: "var(--muted)", flex: 1 }}>
                {t("presets.panel_title")}
              </div>
              {entries.hasHiddenBuiltins && (
                <button
                  type="button"
                  onClick={() => void entries.restoreHiddenBuiltins()}
                  className="btn"
                  style={{ padding: "var(--space-1) var(--space-4)", fontSize: "var(--text-sm)" }}
                >
                  {t("presets.restore_hidden_builtins")}
                </button>
              )}
            </div>
          )}

          {/* manage 모달은 행 패딩과 마찬가지로 갭도 반 톤(2px) — 목록 밀도(오너 2026-08-26). */}
          <div style={{ display: "flex", flexDirection: "column", gap: manage ? "var(--space-2xs)" : "var(--space-1)" }}>
            {entries.entries.map((e) => (
              <PresetRow
                key={e.key}
                manage={manage}
                locked={e.locked}
                icon={e.icon}
                label={e.label}
                canMoveUp={e.canMoveUp}
                canMoveDown={e.canMoveDown}
                onApply={e.onApply}
                onMake={
                  e.onMake
                    ? (ev) => {
                        const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
                        entries.setMakeMenu({ entry: e, x: r.left, y: r.bottom + 4 });
                      }
                    : undefined
                }
                onMoveUp={e.onMoveUp}
                onMoveDown={e.onMoveDown}
                onRename={e.onRename}
                onStyle={e.custom ? (ev) => entries.openStyle(e.custom!.id, ev) : undefined}
                onRemove={e.onRemove}
                onContextMenu={entries.contextMenuFor(e)}
                {...e.hover}
              />
            ))}
          </div>
        </div>
        )}

        {/* "AI 프리셋" 탭(manage 전용) — 옛 설정 > AI 의 AiActionsSection 이 여기로 옮겨왔다
            (PLAN-2026-08-30 §3 W4). 같은 편집기를 설정 > AI > AI 프리셋 페이지도 그대로 싣는다. */}
        {manage && manageTab === "ai_actions" && <AiActionEditor autoAdd={autoAdd} initialId={initialId} />}
      </div>

      <PresetManageDialogs
        rootEl={rootRef.current}
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
          rootEl={rootRef.current}
          onClose={() => entries.setStyleCtx(null)}
          onSetStyle={(id, patch) => void entries.setPresetStyle(id, patch)}
        />
      )}
    </div>
  );
}
