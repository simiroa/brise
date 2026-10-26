/**
 * DiagramBubbleMenu — 플로팅 버블의 "아이콘 버튼 + 드롭다운" 뼈대.
 *
 * DiagramFloatingBubble 안에서 열 곳에 같은 모양으로 반복되던 것을 모았다: 앵커 div, 토글 버튼
 * (title = aria-label), 열렸을 때만 그려지는 드롭다운(버블이 대상 아래로 뒤집히면 아래로 펼친다).
 * 열림 상태는 버블 셸이 쥐고(바깥 클릭 닫기가 셸의 포인터 리스너라서) 여기엔 `menu` 로 내려온다.
 */
import type { Dispatch, ReactNode, SetStateAction } from "react";

export type BubbleMenuId =
  | "shape"
  | "tone"
  | "line"
  | "arrow"
  | "edge-tone"
  | "group-tone"
  | "multi-align"
  | "multi-tone"
  | "multi-shape";

/** 버블 셸이 쥔 서브메뉴 상태 — 선택 종류별 블록이 같은 상태를 공유한다. */
export interface BubbleMenuCtl {
  /** 지금 열려 있는 서브메뉴(없으면 null). */
  active: BubbleMenuId | null;
  setActive: Dispatch<SetStateAction<BubbleMenuId | null>>;
  /** 버블이 대상 아래로 뒤집혔는가 → 드롭다운도 아래로 펼친다. */
  flipped: boolean;
}

export interface BubbleMenuProps {
  id: BubbleMenuId;
  menu: BubbleMenuCtl;
  /** 버튼의 title 이자 aria-label. */
  label: string;
  icon: ReactNode;
  /** 메뉴가 닫혀 있어도 버튼을 활성 표시로 둘 조건(예: 이미 기본값이 아닌 톤·상태가 걸려 있음). */
  highlight?: boolean;
  /**
   * 드롭다운 항목. 함수인 이유: 버블은 위치 추적 때문에 매 프레임 리렌더되므로, 닫힌 메뉴의 항목
   * 계산(옵션 목록·현재 톤 조회 등)이 매 프레임 돌지 않게 **열렸을 때만** 호출한다.
   */
  children: () => ReactNode;
}

export function BubbleMenu({ id, menu, label, icon, highlight, children }: BubbleMenuProps) {
  const open = menu.active === id;
  return (
    <div className="diagram-floating-bubble-menu-anchor">
      <button
        type="button"
        className="diagram-floating-bubble-btn"
        data-active={open || highlight ? "true" : undefined}
        title={label}
        aria-label={label}
        onClick={() => menu.setActive((m) => (m === id ? null : id))}
      >
        {icon}
      </button>
      {open && (
        <div
          className="diagram-floating-bubble-dropdown"
          data-placement={menu.flipped ? "bottom" : "top"}
          style={{
            [menu.flipped ? "top" : "bottom"]: "calc(100% + 8px)",
          }}
        >
          {children()}
        </div>
      )}
    </div>
  );
}
