import type { ReactNode } from "react";

/**
 * 기능 스위치가 꺼졌을 때 그 아래 설정 묶음을 한 번에 잠그는 래퍼(PLAN-2026-10-27 C3).
 * 꺼진 상태를 "그대로 두고 흐리게"가 아니라, 흐림 + 회색 + `inert`(클릭·포커스·보조기술 조작 차단)로 확실히 잠그고
 * 위에 한 줄 안내를 둔다 — off 에서 UI 가 어중간하게 남아 상태가 읽히지 않던 것을 막는다.
 * `inert` 영역은 접근성 트리에서도 빠지므로 안내는 inert 밖(위)에 둔다.
 * 켜져 있으면 자식을 그대로 통과시킨다(래퍼 DOM 없음 — 켜진 페이지 레이아웃이 바뀌지 않는다).
 */
export function DisabledGroup({
  disabled,
  reason,
  children,
  testId,
}: {
  disabled: boolean;
  /** 잠긴 이유 한 줄(예: "동기화가 꺼져 있습니다"). */
  reason?: string;
  children: ReactNode;
  testId?: string;
}) {
  if (!disabled) return <>{children}</>;
  return (
    <div data-testid={testId} data-disabled="true" style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
      {reason && (
        <div role="status" style={{ fontSize: "var(--text-sm)", color: "var(--muted)" }}>
          {reason}
        </div>
      )}
      <div
        inert
        style={{
          opacity: "var(--dim-disabled)",
          filter: "grayscale(1)",
          pointerEvents: "none",
          userSelect: "none",
          display: "flex",
          flexDirection: "column",
          gap: "inherit",
        }}
      >
        {children}
      </div>
    </div>
  );
}
