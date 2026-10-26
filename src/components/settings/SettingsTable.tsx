import React, { createContext, useContext } from "react";

interface SettingsTableContextValue {
  columns: string;
}

const SettingsTableContext = createContext<SettingsTableContextValue>({
  columns: "1fr",
});

export interface SettingsTableProps {
  /** CSS grid-template-columns (예: "100px minmax(120px, 1.2fr) minmax(160px, 2fr) 210px") */
  columns: string;
  /** 테이블 헤더 영역에 들어갈 노드들 (각 셀이 grid 자식으로 배치됨) */
  header: React.ReactNode;
  /** 테이블 행 목록 */
  children?: React.ReactNode;
  /** 데이터가 비어 있는지 여부 */
  isEmpty?: boolean;
  /** 데이터가 비어 있을 때 표시할 문구 */
  emptyText?: React.ReactNode;
  /** 최대 높이 (기본 430, 넘으면 내부 스크롤) */
  maxHeight?: number | string;
  /** 최외곽 컨테이너 data-testid */
  "data-testid"?: string;
  /** 스크롤 래퍼 data-testid */
  scrollTestId?: string;
  /** 데이터가 존재할 때 행 목록을 감싸는 래퍼의 data-testid (선택) */
  bodyTestId?: string;
  /** 최외곽 컨테이너 추가 클래스 */
  className?: string;
  /** 최외곽 컨테이너 추가 인라인 스타일 */
  style?: React.CSSProperties;
}

/**
 * 설정 화면 전용 경량 재사용 Table 컴포넌트.
 * 수집 소스 목록(CollectSection)과 챗 메모리 목록(ChatMemorySection) 등의 그리드 표에 일관된 스타일 계약을 제공합니다.
 * DESIGN.md §설정 레이아웃 ⑧(빈 상태) 및 단일 구분선(--divider) 계약 준수.
 */
export function SettingsTable({
  columns,
  header,
  children,
  isEmpty = false,
  emptyText,
  maxHeight = 430,
  "data-testid": testId,
  scrollTestId,
  bodyTestId,
  className,
  style,
}: SettingsTableProps) {
  return (
    <SettingsTableContext.Provider value={{ columns }}>
      <div
        className={className}
        data-testid={testId}
        style={{
          marginTop: "var(--space-4)",
          border: "1px solid var(--divider)",
          borderRadius: "var(--radius-md)",
          overflow: "hidden",
          ...style,
        }}
      >
        {/* 테이블 헤더 */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: columns,
            padding: "var(--space-3) var(--space-5)",
            background: "var(--surface-sunken)",
            borderBottom: "1px solid var(--divider)",
            fontSize: "var(--text-xs)",
            fontWeight: 600,
            color: "var(--muted)",
            userSelect: "none",
          }}
        >
          {header}
        </div>

        {/* 본문 스크롤 영역 */}
        <div
          className="scroll"
          style={{
            maxHeight,
            overflowY: "auto",
          }}
          data-testid={scrollTestId}
        >
          {isEmpty ? (
            <div
              style={{
                padding: "var(--space-6) var(--space-4)",
                textAlign: "center",
                color: "var(--muted)",
                fontSize: "var(--text-sm)",
              }}
            >
              {emptyText}
            </div>
          ) : bodyTestId ? (
            <div data-testid={bodyTestId}>{children}</div>
          ) : (
            children
          )}
        </div>
      </div>
    </SettingsTableContext.Provider>
  );
}

export interface SettingsTableRowProps {
  children: React.ReactNode;
  /** 마지막 행 여부 (true면 borderBottom을 그리지 않음) */
  isLast?: boolean;
  /** 비활성화 여부 */
  disabled?: boolean;
  /** 툴팁 텍스트 */
  title?: string;
  /** aria-disabled */
  "aria-disabled"?: boolean | "true" | "false";
  /** data-testid */
  "data-testid"?: string;
  /** 추가 클래스 */
  className?: string;
  /** 추가 인라인 스타일 */
  style?: React.CSSProperties;
  /** 클릭 핸들러 */
  onClick?: () => void;
}

/**
 * SettingsTable 내 개별 행 컴포넌트.
 * 부모 SettingsTable의 columns를 전달받아 헤더와 동일한 그리드 열 너비로 정렬됩니다.
 */
export function SettingsTableRow({
  children,
  isLast = false,
  disabled = false,
  title,
  "aria-disabled": ariaDisabled,
  "data-testid": testId,
  className,
  style,
  onClick,
}: SettingsTableRowProps) {
  const { columns } = useContext(SettingsTableContext);

  return (
    <div
      className={className}
      data-testid={testId}
      title={title}
      aria-disabled={disabled ? true : ariaDisabled}
      onClick={onClick}
      style={{
        display: "grid",
        gridTemplateColumns: columns,
        padding: "var(--space-3) var(--space-5)",
        alignItems: "center",
        borderBottom: isLast ? "none" : "1px solid var(--divider)",
        fontSize: "var(--text-sm)",
        opacity: disabled ? "var(--dim-disabled)" : 1,
        ...style,
      }}
    >
      {children}
    </div>
  );
}
