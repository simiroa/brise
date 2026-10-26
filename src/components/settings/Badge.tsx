import type { ReactNode } from "react";

/**
 * 헤더 옆 상태 알약 (design-review 2026-09-14 §4-B) — `SyncSection.tsx`의 `BetaBadge`(테두리
 * 알약)와 `AiProviderSection.tsx`의 `external_badge`(테두리 없는 색상 텍스트)로 갈라져 있던
 * `SectionHeader.badge` 슬롯을 한 모양으로 합친다. 모든 헤더 배지는 **테두리 있는 알약** 하나로
 * 수렴한다 — tone만 중성/강조/위험(error)으로 갈린다.
 *
 * 모양은 앱 전체 배지 한 벌인 `.badge`(styles/tokens.css, GRILL-2026-10-19 R8)가 소유한다 — 이 파일의
 * 인라인 톤 표가 그 기준이었고, 그대로 토큰으로 올라갔다. 중성(neutral)은 `.badge` 의 muted 톤이다.
 */
export type BadgeTone = "accent" | "danger" | "neutral";

export function Badge({ tone = "neutral", children }: { tone?: BadgeTone; children: ReactNode }) {
  return (
    <span className="badge" data-tone={tone === "neutral" ? "muted" : tone}>
      {children}
    </span>
  );
}
