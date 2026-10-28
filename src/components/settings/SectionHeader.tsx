import type { ReactNode } from "react";
import { HintBadge } from "./HintBadge";
import { IconChip } from "./IconChip";

interface SectionHeaderProps {
  title: string;
  hint?: string;
  badge?: ReactNode;
  /** 카드 아이콘 배지 — `IconChip 24`(PLAN-2026-09-15 D2, accent 틴트). 아이콘은 14 로 준다. */
  icon?: ReactNode;
  /** 카드 최상단의 트레일링 액션(토글/버튼) — SubGroup의 `actions`와 같은 계약(design-review
   *  2026-09-14 §4-A). 우측 정렬, title 옆 한 줄. 카드 전체를 켜고 끄는 "마스터 토글"은 항상
   *  여기 꽂는다(§4-E) — 손으로 justify-content:space-between 래퍼를 다시 마는 대신. */
  actions?: ReactNode;
}

/** Settings section heading — label-caps + accent + one margin. Replaces the 17 drifted copies. */
export function SectionHeader({ title, hint, badge, icon, actions }: SectionHeaderProps) {
  return (
    // 카드의 첫 자식이면 settingsLayout.css 가 박스 밖(옅은 색)으로 올린다 — 그 규칙의 단일 출처.
    <div className="settings-section-header">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--space-2)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", minWidth: 0 }}>
          {icon && <IconChip size={24}>{icon}</IconChip>}
          <div
            style={{
              fontSize: "var(--text-section)",
              fontWeight: 600,
              color: "var(--settings-title-color, var(--text))",
            }}
          >
            {title}
          </div>
          {badge}
          {hint && <HintBadge hint={hint} />}
        </div>
        {/* 액션은 한 묶음으로 오른쪽에 붙는다 — 프래그먼트로 단추 여럿을 넘기면 바깥 space-between 이
            그 사이를 벌려 단추 하나가 제목과 + 사이 한가운데에 떴다(수집 › 소스, 2026-10-21 실앱). */}
        {actions && (
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", flexShrink: 0 }}>{actions}</div>
        )}
      </div>
    </div>
  );
}
