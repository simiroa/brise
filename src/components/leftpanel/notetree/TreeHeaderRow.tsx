import React from "react";
import { IconCaret, type CaretDir } from "../../icons";
import { Pill } from "../../common/Pill";

export interface TreeHeaderRowProps {
  /** 라벨 왼쪽 글리프. 색·fill 은 호출부가 정한다(즐겨찾기 별은 열림에 따라 채워진다). */
  icon: React.ReactNode;
  /** 펼침/접힘 캐럿 방향. 없으면(휴지통·아카이브처럼 펼칠 것이 없는 행) 캐럿을 그리지 않는다. */
  caret?: CaretDir;
  label: string;
  count: number;
  onClick: () => void;
  /**
   * 미분류 행만 쓴다 — 우클릭·롱프레스(AI 진입점)와 드롭 타깃 속성. onClick/style/className 은
   * 이 컴포넌트가 소유하므로 받지 않는다.
   */
  buttonProps?: Omit<
    React.ButtonHTMLAttributes<HTMLButtonElement>,
    "onClick" | "style" | "className" | "type" | "children"
  >;
}

/**
 * 헤더 4행이 손으로 복제해 오던 버튼 chrome(캐럿·아이콘·굵은 라벨·우측 개수 뱃지) 한 벌.
 * 훅이 없는 표시 컴포넌트다 — react-window 가 행 인스턴스를 인덱스마다 재사용하므로
 * 상태·구독은 TreeListRow 쪽에 두지 않는 규칙을 그대로 지킨다.
 */
export function TreeHeaderRow({
  icon,
  caret,
  label,
  count,
  onClick,
  buttonProps,
}: TreeHeaderRowProps): React.ReactElement {
  return (
    <button
      type="button"
      className="menu-row menu-item"
      onClick={onClick}
      {...buttonProps}
      style={{
        gap: "var(--space-3)",
        padding: "var(--space-2) var(--sidebar-pad) var(--space-2) var(--space-3)",
        color: "var(--text)",
        height: "100%",
        width: "100%",
      }}
    >
      {caret ? (
        <IconCaret
          dir={caret}
          size={13}
          style={{ color: "var(--faint)", transition: "transform var(--dur-med)" }}
        />
      ) : null}
      {icon}
      <span style={{ fontSize: "var(--text-sm)", fontWeight: 600 }}>{label}</span>
      {/* 색이 다른 검색 개수 칩(notetree/index.tsx, accent)과는 색만 다르다 — tone="soft" 로
          그 구분을 유지한 채 셸(패딩·radius·굵기)만 Pill 과 공유한다. */}
      <Pill tone="soft" style={{ marginLeft: "auto", padding: "0 var(--space-2)" }}>
        {count}
      </Pill>
    </button>
  );
}
