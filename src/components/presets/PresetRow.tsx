import type { ReactNode } from "react";
import { rowStyle } from "./presetConstants";
import {
  IconArrowUp,
  IconArrowDown,
  IconEdit,
  IconPalette,
  IconTrash,
} from "../icons";
import { t } from "../../i18n/t";

/** 관리 모드 한 행의 아이콘 버튼 하나(이동/이름변경/아이콘·색/제거) — icon-btn--sm 재사용, 새 CSS 없음. */
export function RowIconBtn({
  onClick,
  disabled,
  label,
  testid,
  children,
}: {
  onClick?: (e: React.MouseEvent) => void;
  disabled?: boolean;
  label: string;
  testid?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="icon-btn icon-btn--sm"
      data-testid={testid}
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      style={disabled ? { opacity: 0.35, cursor: "not-allowed" } : undefined}
    >
      {children}
    </button>
  );
}

/**
 * 프리셋 한 행 — 두 가지 역할(모드)을 명확히 분리한다(W7-d, 오너 피드백: "관리 모달인데 클릭하면
 * 바로 적용돼서 실행기처럼 느껴진다"):
 *   - picker (variant="menu", 섹션 "+" 메뉴): 행 전체가 버튼 — 클릭 = 즉시 적용,
 *     hover = 미리보기(EditorPanel 이 store 의 hovered.bodyMd 를 읽어 배경에 고스트로 그린다),
 *     커스텀 프리셋은 우클릭 메뉴로 이름변경/제거. 행은 항상 눌린다 — 착지점(제자리/새 섹션)만
 *     targetState 로 갈리고, 고스트는 겹칠 본문이 없는 ready 에서만 그린다.
 *   - manage (TreeHeaderActions/설정의 관리 모달 전용): 행은 클릭해도 아무 일도 없다 —
 *     순서(커스텀만) · 이름변경 · 아이콘·색(커스텀만) · 제거 · 만들기(새 노트/새 섹션) 가 전부
 *     명시적 아이콘 버튼. hover 미리보기·우클릭 메뉴 없음 (버튼이 그 역할을 대신하므로).
 *     "만들기"는 착지를 사용자가 고르게 한다(오너 2026-08-26: "적용"은 애매, 제자리 적용은
 *     없다) — 새 노트 / 새 섹션 2옵션 메뉴(presetBridge::PresetLanding).
 */
export function PresetRow({
  icon,
  label,
  manage,
  locked,
  canMoveUp,
  canMoveDown,
  onApply,
  onMake,
  onMoveUp,
  onMoveDown,
  onRename,
  onStyle,
  onRemove,
  onMouseEnter,
  onMouseLeave,
  onContextMenu,
}: {
  icon: ReactNode;
  label: string;
  manage: boolean;
  /** builtin(blank/todo/…) — 이름변경/제거 불가. 순서도 고정(항상 맨 위, 아래는 §결정 참고). */
  locked?: boolean;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
  onApply: () => void;
  /** manage 전용 — "만들기" 버튼이 이 좌표로 새 노트/새 섹션 2옵션 메뉴를 연다. */
  onMake?: (e: React.MouseEvent) => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onRename?: () => void;
  onStyle?: (e: React.MouseEvent) => void;
  onRemove?: () => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  if (!manage) {
    return (
      <button
        type="button"
        className="menu-row menu-item"
        style={rowStyle}
        onClick={onApply}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        onContextMenu={onContextMenu}
      >
        {icon}
        <span>{label}</span>
      </button>
    );
  }

  return (
    // 관리 모달 밀도(오너 2026-08-26) — 8행이 모달을 채우므로 .menu-row 기본/rowStyle 보다
    // 위아래 패딩을 한 단계 줄여 목록 밀도를 올린다. picker/menu 행은 그대로.
    <div
      className="menu-row menu-item"
      style={{ ...rowStyle, cursor: "default", padding: "var(--space-2) var(--space-4)" }}
    >
      {icon}
      <span
        style={{ flex: 1, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
      >
        {label}
      </span>
      {!locked && (
        <>
          <RowIconBtn onClick={onMoveUp} disabled={!canMoveUp} label={t("presets.move_up")}>
            <IconArrowUp size={13} strokeWidth={2} />
          </RowIconBtn>
          <RowIconBtn onClick={onMoveDown} disabled={!canMoveDown} label={t("presets.move_down")}>
            <IconArrowDown size={13} strokeWidth={2} />
          </RowIconBtn>
          <RowIconBtn onClick={onRename} label={t("ctx.rename")}>
            <IconEdit size={13} strokeWidth={1.8} />
          </RowIconBtn>
          {/* 이름변경 바로 옆 — 칩 우클릭 메뉴와 같은 진입점 하나(setStyleCtx)를 연다. */}
          <RowIconBtn onClick={onStyle} label={t("presets.style_title")}>
            <IconPalette size={13} strokeWidth={1.8} />
          </RowIconBtn>
        </>
      )}
      {/* Builtins get JUST the trash button (no move/rename — "제거" hides them, see
          stores/presets.ts::hideBuiltin); custom rows keep all four via the block above + this one. */}
      {onRemove && (
        <RowIconBtn onClick={onRemove} label={t("ctx.remove")}>
          <IconTrash size={13} strokeWidth={1.8} />
        </RowIconBtn>
      )}
      <button
        type="button"
        className="btn"
        style={{ flex: "none", padding: "var(--space-1) var(--space-3)" }}
        onClick={onMake}
      >
        {t("presets.make")}
      </button>
    </div>
  );
}
