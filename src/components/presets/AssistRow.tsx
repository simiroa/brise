import type { ReactNode } from "react";
import { rowStyle } from "./presetConstants";

/**
 * 어시스트 패널(picker/panel — SourcePanel 임베드) 전용 한 줄 리스트 행 — PresetChip(칩 스트립)을
 * 대체한다(오너 3차 피드백: 칩 그리드가 줄바꿈돼 복잡했다, 세로 한 줄씩으로). PresetRow 를 재사용하지
 * 않는 이유: PresetRow 는 "+" 섹션 메뉴·관리 모달과 공유돼 그쪽 스타일(진한 텍스트)까지 바뀌면
 * 범위 밖이다. 레이아웃(패딩/정렬/호버 배경)은 기존 rowStyle + .menu-row.menu-item 그대로 재사용하고,
 * 텍스트 톤(--muted → hover --text)만 새 클래스 하나(.assist-row, tokens.css)로 얹는다.
 */
export function AssistRow({
  icon,
  label,
  indent,
  testid,
  isGlow,
  onClick,
  onContextMenu,
  onMouseEnter,
  onMouseLeave,
  preview,
  active,
  title,
}: {
  icon: ReactNode;
  label: string;
  /** 프리셋 위계(오너 3차): "내 프리셋" 구분줄 아래 사용자 프리셋은 들여써 하위 항목임을 표시. */
  indent?: boolean;
  testid?: string;
  isGlow?: string | null | false;
  onClick: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  /** 라벨 줄 아래 미리보기(시트 Explore 의 차트 카드) — 있으면 행이 세로로 늘어나고 통째로 한 버튼이다. */
  preview?: ReactNode;
  /** 토글형 행(관계도 배치 바꾸기 베타 등) — 현재 선택된 행임을 aria-pressed·data-active 로 표시. */
  active?: boolean;
  /** 힌트 툴팁(네이티브 title). */
  title?: string;
}) {
  const style = indent ? { ...rowStyle, paddingLeft: "var(--space-8)" } : rowStyle;
  return (
    <button
      type="button"
      className="menu-row menu-item assist-row"
      data-testid={testid}
      data-ai-glow={isGlow || undefined}
      data-ai-glow-inset="true"
      data-active={active || undefined}
      aria-pressed={active !== undefined ? active : undefined}
      title={title}
      style={preview ? { ...style, flexDirection: "column", alignItems: "stretch" } : style}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {preview ? (
        <>
          <span style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
            {icon}
            <span>{label}</span>
          </span>
          {preview}
        </>
      ) : (
        <>
          {icon}
          <span>{label}</span>
        </>
      )}
    </button>
  );
}
