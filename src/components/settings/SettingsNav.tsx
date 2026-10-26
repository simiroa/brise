import { Fragment, useRef, type ReactNode } from "react";
import { t } from "../../i18n/t";
import { SettingsNavFooter } from "./SettingsNavFooter";
import { FluidHoverHighlight, useFluidHover } from "../common/FluidHover";
import { preloadIntentProps } from "../../lib/lazyPreload";

/** 레일 그룹 키 (PLAN-2026-09-12 §1, D1 — 고아 항목 없음, 모든 항목이 그룹에 속한다).
 *  순서는 `SettingsPanel` 의 `allPages` 배열이 정한다 — 여기서 정렬하지 않는다. */
export type SettingsNavGroup = "general" | "feature" | "ai" | "system" | "plugins";

/** 그룹 키 → 헤더 i18n 키. 리터럴이라 `check-i18n` 의 미사용 키 검사에 잡힌다(의도).
 *  PLAN-2026-08-27 당시 주석이 "두 번째 그룹이 실제로 생기면 group→키 맵으로 승격"이라고
 *  예고해 둔 지점이고, 지금이 그때다. */
const GROUP_LABEL_KEY: Record<SettingsNavGroup, string> = {
  general: "settings.group_general",
  feature: "settings.group_feature",
  ai: "settings.group_ai",
  system: "settings.group_system",
  plugins: "settings.group_plugins",
};

export interface SettingsNavItem {
  id: string;
  label: string;
  /** 이 항목이 속한 그룹. 헤더는 그룹의 **첫 항목 앞에만** 선다. */
  group?: SettingsNavGroup;
  /** 라벨 뒤에 붙는 작은 카운트 필(예: 수집 자동 감지 후보 수). 0 이하면 렌더하지 않는다. */
  badge?: number;
  /** 라벨 뒤 작은 accent 점(예: 업데이트 있음 — 일반). 숫자가 없는 알림이라 badge 와 따로 둔다. */
  dot?: { label: string };
  /** 레일 항목 아이콘 배지 (D2) */
  icon?: ReactNode;
  /** 이 페이지가 그리는 지연 화면(src/lazySurfaces.ts). 항목에 마우스를 올리거나 포커스하면 미리 받는다. */
  surfaces?: ReadonlyArray<{ preload: () => Promise<void> }>;
}

/**
 * 설정 좌측 레일 (PLAN-2026-09-12 §1: 5그룹 · 고아 항목 없음).
 * 레일은 헤더 아래 전체 높이를 차지하고 **칠도 우측 선도 없다** — 메인 사이드바처럼 맨 시트 위에 서고,
 * 본문과의 경계는 본문 `.content-canvas` 의 좌측 외곽선 + 틴트가 만든다(GRILL-2026-10-19 R1-D 가
 * PLAN-2026-09-15 D10 ②의 "자기 면(--surface-sunken) + 우측 --divider" 를 대체 — 되돌리지 말 것).
 * 맨 위 한 줄(톱니·범위 칩·검색·닫기)은 레일 밖 창 헤더(SettingsHeader)로 이사했다 — 레일은 항목만 싣는다
 * (PLAN-2026-10-24 D1).
 * D4: 들여쓰기 없음 — 그룹 라벨이 계층을 말한다.
 * 항목 목록 아래 남는 여백에 버전이 상주한다(SettingsNavFooter).
 */
export function SettingsNav({
  items,
  activeId,
  onSelect,
}: {
  items: SettingsNavItem[];
  activeId: string;
  onSelect: (id: string) => void;
}) {
  const navRef = useRef<HTMLElement>(null);
  const hover = useFluidHover(navRef, {
    axis: "y",
    itemSelector: "[data-fh-item]",
    from: () => navRef.current?.querySelector('[data-selected="true"]'),
  });

  return (
    <nav
      ref={navRef}
      aria-label={t("settings.nav_aria")}
      data-testid="settings-nav"
      className="fh-host"
      {...hover.handlers}
      style={{
        flex: "none",
        // 레일 폭 168 고정(오너 QA 2026-09-15 R4 이래 좁혀 왔다).
        width: 168,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-2xs)",
        padding: "var(--space-2) var(--space-4) var(--space-6) var(--space-4)",
        overflowY: "auto",
        // 칠·우측 선 없음 — 위 doc 주석(GRILL-2026-10-19 R1-D).
      }}
    >
      <FluidHoverHighlight hover={hover} />
      {items.map((it, i) => {
        const isSelected = activeId === it.id;

        return (
          <Fragment key={it.id}>
            {it.group && it.group !== items[i - 1]?.group && (
              <div
                data-testid={`settings-nav-group-${it.group}`}
                style={{
                  // 첫 그룹은 레일 상단 패딩이 이미 자리를 만들어 뒀다 — 한 번 더 띄우면
                  // 목록이 아래로 밀려 내려간 것처럼 보인다.
                  padding:
                    i === 0
                      ? "0 var(--space-3) var(--space-1)"
                      : "var(--space-5) var(--space-3) var(--space-1)",
                  fontSize: "var(--text-xs)",
                  fontWeight: 400,
                  textAlign: "left",
                  letterSpacing: "0.14em",
                  color: "var(--text-tertiary)",
                }}
              >
                {t(GROUP_LABEL_KEY[it.group])}
              </div>
            )}
            <button
              type="button"
              data-testid={`settings-nav-${it.id}`}
              data-selected={isSelected}
              aria-current={isSelected ? "page" : undefined}
              data-fh-item="true"
              className="menu-row menu-item"
              {...(it.surfaces?.length ? preloadIntentProps(...it.surfaces) : null)}
              onClick={() => onSelect(it.id)}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "flex-start",
                gap: "var(--space-3)",
                paddingTop: "var(--space-2)",
                paddingBottom: "var(--space-2)",
                paddingRight: "var(--space-3)",
                paddingLeft: "var(--space-4)",
                borderRadius: "var(--radius-sm)",
                background: isSelected ? "var(--sel)" : undefined,
                fontSize: "var(--text-md)",
                fontWeight: isSelected ? 600 : 400,
                color: isSelected ? "var(--text)" : "var(--muted)",
                marginBottom: 0,
                textAlign: "center",
              }}
            >
              {it.icon && (
                <span
                  style={{
                    width: 16,
                    height: 16,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                    color: isSelected ? "var(--accent)" : "var(--muted)",
                    background: "transparent",
                  }}
                  aria-hidden="true"
                >
                  {it.icon}
                </span>
              )}
              <span style={{ flex: 1, textAlign: "left" }}>{it.label}</span>
              {!!it.badge && it.badge > 0 && (
                <span
                  data-testid={`settings-nav-badge-${it.id}`}
                  aria-label={t("settings.collect_detect_badge_aria", { n: it.badge })}
                  style={{
                    marginLeft: "auto",
                    display: "inline-block",
                    minWidth: "1.4em",
                    padding: "0 var(--space-2)",
                    borderRadius: "var(--radius-pill)",
                    background: "var(--accent)",
                    color: "var(--on-accent)",
                    fontSize: "var(--text-xs)",
                    fontWeight: 600,
                    lineHeight: "1.4em",
                    textAlign: "center",
                  }}
                >
                  {it.badge}
                </span>
              )}
              {it.dot && (
                <span
                  role="img"
                  data-testid={`settings-nav-dot-${it.id}`}
                  aria-label={it.dot.label}
                  title={it.dot.label}
                  style={{
                    marginLeft: "auto",
                    width: 8,
                    height: 8,
                    flexShrink: 0,
                    borderRadius: "var(--radius-pill)",
                    background: "var(--accent)",
                  }}
                />
              )}
            </button>
          </Fragment>
        );
      })}
      <SettingsNavFooter />
    </nav>
  );
}
