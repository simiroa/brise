import type { ReactNode } from "react";

export type BannerTone = "accent" | "warn" | "danger";

const TINT: Record<BannerTone, string> = {
  accent: "var(--accent)",
  warn: "var(--warn)",
  danger: "var(--danger)",
};

/**
 * 설정 페이지의 안내·경고 띠 한 벌 — 왼쪽 문구(+선택 아이콘), 오른쪽 동작.
 *
 * 면은 표면 토큰이 아니라 상태색에서 파생한 얇은 틴트다(`.card` 를 가리는 인라인 배경이 아니라
 * check:surface ⓐ 의 대상이 아니고, 테마가 바뀌면 상태색을 따라 움직인다). **바깥 여백을 갖지
 * 않는다** — 페이지·카드의 세로 간격은 부모의 gap 이 정한다(손으로 단 marginBottom 이 페이지 리듬을
 * 깨던 것을 여기로 모았다).
 */
export function Banner({
  tone = "accent",
  icon,
  children,
  actions,
  role = "status",
  ariaLabel,
  testId,
}: {
  tone?: BannerTone;
  icon?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  role?: "status" | "alert" | "region";
  ariaLabel?: string;
  testId?: string;
}) {
  return (
    <div
      role={role}
      aria-label={ariaLabel}
      data-testid={testId}
      data-tone={tone}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "var(--space-4)",
        flexWrap: "wrap",
        padding: "var(--space-4) var(--space-5)",
        borderRadius: "var(--radius-sm)",
        background: `color-mix(in srgb, ${TINT[tone]} 10%, transparent)`,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", minWidth: 0, flex: 1 }}>
        {icon}
        <div style={{ minWidth: 0, fontSize: "var(--text-sm)", color: "var(--text)", lineHeight: "var(--lh-ui)" }}>
          {children}
        </div>
      </div>
      {actions && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-3)", flexShrink: 0 }}>{actions}</div>
      )}
    </div>
  );
}
