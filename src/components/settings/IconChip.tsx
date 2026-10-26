import type { ReactNode } from "react";

/**
 * 설정 창 아이콘 배지 한 벌 (PLAN-2026-09-15 D2) — accent 틴트 배경 + accent 아이콘.
 * 히어로(48)·카드 헤더/행(32)·레일 타이틀(24). 호출자는 아이콘을 각각 24/16/14 로 준다.
 */
export function IconChip({ size, children, testId }: { size: 48 | 32 | 24; children: ReactNode; testId?: string }) {
  return (
    <div
      data-testid={testId}
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        minWidth: size,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: size === 48 ? "var(--radius-md)" : "var(--radius-sm)",
        background: "color-mix(in srgb, var(--accent) 15%, transparent)",
        color: "var(--accent)",
        boxSizing: "border-box",
      }}
    >
      {children}
    </div>
  );
}
