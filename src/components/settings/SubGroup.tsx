import type { CSSProperties, ReactNode } from "react";
import { HintBadge } from "./HintBadge";

/**
 * 카드 안 하위 그룹 (docs/DESIGN.md §설정 레이아웃 ①/②).
 *
 * 제목은 `--text-md / 600 / --text` — `SectionHeader`(`--text-section`)보다 한 단 아래다.
 * 선은 **앞 그룹과의 경계에만** 긋고(`--divider` 하나), 그 안의 옵션 행 아래에는 긋지 않는다.
 *
 * ViewSection 에서 처음 만들어졌다가(지역 페이지: 날씨/달력 두 하위그룹) GeneralSection의
 * 데이터 보관 카드(저장소 통계·자동 백업·원본 처리)가 두 번째 사용처가 되며 여기로 옮겼다.
 */
export function SubGroup({
  title,
  hint,
  divider,
  actions,
  children,
  "data-testid": testId,
}: {
  title: string;
  hint?: string;
  divider?: boolean;
  actions?: ReactNode;
  children: ReactNode;
  "data-testid"?: string;
}) {
  const wrapperStyle: CSSProperties = {
    minWidth: 0,
    ...(divider
      ? {
          borderTop: "1px solid var(--divider)",
          marginTop: "var(--space-6)",
          paddingTop: "var(--space-6)",
        }
      : null),
  };

  return (
    <div style={wrapperStyle} data-testid={testId}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "var(--space-2)",
          marginBottom: "var(--space-3)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-1)" }}>
          <span style={{ fontSize: "var(--text-md)", fontWeight: 600, color: "var(--text)" }}>{title}</span>
          {hint && <HintBadge hint={hint} />}
        </div>
        {actions}
      </div>
      {children}
    </div>
  );
}
