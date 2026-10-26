import React from "react";
import { IconClose } from "./icons";
import { t } from "../i18n/t";

export interface SelectionActionBarProps {
  count: number;
  onClear: () => void;
  /** 실행 중이면 버튼을 잠근다. */
  busy?: boolean;
  /** 긴 배치의 진행 상황 — `{done, total}`. 짧은 배치에서는 생략. */
  progress?: { done: number; total: number } | null;
  /** 표면별 액션 버튼들. */
  children: React.ReactNode;
  /**
   * W8-c: 배치는 표면마다 다르다(오너 피드백 — 트리 선택인데 바가 화면 중앙에 있어 너무 멀다).
   * - `"screen"`(기본) — 뷰포트 기준 고정, 화면 하단 중앙. 원래 유일했던 동작 그대로이고
   *   지금은 **모바일**(`MobileHome.tsx`) 전용이다 — 그 표면은 화면 자체가 카드라 중앙 고정이
   *   맞다.
   * - `"panel"` — 가장 가까운 `position:relative` 조상 기준 하단 중앙(절대 위치). 노트 트리가
   *   쓴다: 좌측 패널 안, 선택 중인 그 목록 바로 아래에 뜬다. `document.body` 로 포탈하지
   *   않는다 — `lib/ui.ts::popoverRoot` 는 `<dialog>` 를 벗어나야 하는 팝오버용이고, 이 바는
   *   다이얼로그 안에 있지 않으니 조상 컨테인먼트 안에 그대로 둔다.
   * - `"inline"` — 절대/고정 위치를 아예 쓰지 않고 문서 흐름에 그대로 놓인다. 첨부 바가 쓴다:
   *   카드 자체가 이미 화면 하단부에 있고 스크롤 가능한 별도 패널이 아니라서, 오버레이보다
   *   카드 안에 붙는 쪽이 자연스럽다.
   */
  placement?: "screen" | "panel" | "inline";
}

/**
 * W7-g 다중선택 하단 액션 바 — 노트 트리와 첨부 바가 공유하는 껍데기(개수 + 해제 + 액션 슬롯).
 * 표면마다 액션이 다르므로 버튼은 children 으로 받는다(프레젠테이션 프롭을 늘리며 하나로
 * 접지 않는다 — Select.tsx 헤더 주석과 같은 판단).
 *
 * 2개 이상일 때만 띄우는 판정은 **호출자**가 한다. 1개일 때 띄우지 않는 이유: 단일 노트에는
 * 이미 우클릭 컨텍스트 메뉴가, 단일 첨부에는 이미 타일의 X 버튼이 같은 액션을 전부 갖고 있어
 * 바가 뜨면 같은 기능이 두 벌로 보인다.
 *
 * 배치(`placement`)는 위 프롭 주석 참고 — `"screen"`/`"panel"` 은 같은 모양(알약꼴 오버레이)을
 * 고정 기준점만 바꿔서 재사용하고, `"inline"` 만 오버레이 자체를 그만둔다.
 */
export function SelectionActionBar({
  count,
  onClear,
  busy,
  progress,
  children,
  placement = "screen",
}: SelectionActionBarProps) {
  const overlayStyle: React.CSSProperties =
    placement === "inline"
      ? {
          display: "flex",
          alignItems: "center",
          gap: "var(--space-3)",
          padding: "var(--space-2) var(--space-3)",
          flexWrap: "wrap",
        }
      : {
          position: placement === "panel" ? "absolute" : "fixed",
          left: "50%",
          bottom: placement === "panel" ? "var(--space-3)" : "var(--space-6)",
          transform: "translateX(-50%)",
          zIndex: "var(--z-dropdown)",
          display: "flex",
          alignItems: "center",
          gap: "var(--space-3)",
          padding: "var(--space-2) var(--space-3)",
          boxShadow: "var(--shadow-lg)",
          maxWidth: placement === "panel" ? "calc(100% - 24px)" : "calc(100vw - 24px)",
          flexWrap: "wrap",
        };
  return (
    <div
      className="overlay"
      role="toolbar"
      aria-label={t("selection.bar_label")}
      data-testid="selection-action-bar"
      style={overlayStyle}
    >
      <span
        style={{
          fontSize: "var(--text-sm)",
          fontWeight: 600,
          color: "var(--text)",
          padding: "0 var(--space-2)",
          whiteSpace: "nowrap",
        }}
      >
        {progress
          ? t("selection.progress", { done: progress.done, total: progress.total })
          : t("selection.n_selected", { n: count })}
      </span>
      <span aria-hidden style={{ width: 1, alignSelf: "stretch", background: "var(--line)" }} />
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-1)", opacity: busy ? 0.6 : 1 }}>
        {children}
      </div>
      <button
        type="button"
        className="icon-btn icon-btn--sm"
        onClick={onClear}
        disabled={busy}
        title={t("selection.clear")}
        aria-label={t("selection.clear")}
      >
        <IconClose size={14} strokeWidth={2} />
      </button>
    </div>
  );
}

/** 바 안의 액션 버튼 — `.menu-row .menu-item` 컨벤션을 그대로 쓴다(새 시각 언어 없음). */
export function SelectionActionButton({
  label,
  icon,
  onClick,
  disabled,
  danger,
  testid,
  intentProps,
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  testid?: string;
  /** 이 버튼이 여는 지연 화면을 미리 받는 핸들러 — `preloadIntentProps(X)` 결과를 그대로 넘긴다. */
  intentProps?: Pick<React.ButtonHTMLAttributes<HTMLButtonElement>, "onPointerEnter" | "onFocus" | "onPointerDown">;
}) {
  return (
    <button
      type="button"
      className="menu-row menu-item"
      data-testid={testid}
      {...intentProps}
      onClick={onClick}
      disabled={disabled}
      title={label}
      style={{
        gap: "var(--space-2)",
        padding: "var(--space-2) var(--space-3)",
        fontSize: "var(--text-sm)",
        whiteSpace: "nowrap",
        color: danger ? "var(--danger)" : undefined,
      }}
    >
      {icon}
      {label}
    </button>
  );
}
