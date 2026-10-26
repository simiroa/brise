import type { CSSProperties, ReactNode } from "react";
import { HintBadge } from "./HintBadge";
import { Toggle } from "./Toggle";
import { anchorId } from "./settingsAnchor";

export interface SwitchGridItem {
  /** 안정적인 키. data-testid 를 따로 주지 않으면 `switch-grid-cell-<id>` 로도 쓰인다. */
  id: string;
  label: ReactNode;
  /** 한 줄 힌트(규칙 ③). 두 줄이 필요하면 FeatureBriefModal 로 내린다. */
  hint?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  /** 왜 못 켜는지 — title 툴팁으로만 준다(규칙 ④). 화면 텍스트로 상주시키지 않는다. */
  disabledReason?: string;
  busy?: boolean;
  /** 토글의 접근 이름. 라벨이 문자열이 아니면(아이콘·강조 마크업) 반드시 준다. */
  ariaLabel?: string;
  /** 설정 검색·딥링크 앵커 이름 — 셀 루트 id 가 된다. */
  anchor?: string;
  "data-testid"?: string;
}

interface SwitchGridProps {
  items: SwitchGridItem[];
  /** 그리드 자체의 접근 이름 — `role="group"` 과 짝이다. 무엇들의 묶음인지 말한다. */
  "aria-label": string;
  "data-testid"?: string;
  /** 고정 열 수. 없으면 auto-fit(210px 최소)으로 붕괴한다. */
  columns?: number;
}

/** 셀 최소 폭. 본문 740px 에서 3열, 좁히면 2열 → 1열로 자동 붕괴한다
 *  (설정 창 최소 폭 560px 에서 본문 ≈400px = 1열). */
const MIN_COL = "210px";
export const SWITCH_GRID_COLUMNS = `repeat(auto-fit, minmax(${MIN_COL}, 1fr))`;

/**
 * 독립 on/off 토글 **3개 이상**을 병렬로 놓는 부품 (PLAN-2026-09-12 §3, D3).
 *
 * 왜 `SettingsRow` 를 여러 개 쌓지 않는가: 서로 독립인 스위치가 한 줄에 하나씩 서면 세로로만
 * 길어지고, 라벨과 토글 사이에 폭만큼의 빈 강이 생겨 둘이 같은 행인지 눈으로 다시 확인해야 한다.
 * 그래서 **셀 안에서 토글은 라벨 바로 뒤에 붙는다** — 우측 정렬하지 않는다. 폭이 고정인
 * 컨트롤은 우측 정렬의 이득이 0이고 거리만 만든다.
 *
 * 여기 넣지 **않는** 것: 값 컨트롤(셀렉트·슬라이더·입력). 그것들은 폭이 필요하고, 우측 정렬이
 * 값 비교를 돕는다 — 1열 `SettingsRow` + 220px 우측 정렬을 그대로 쓴다.
 */
export function SwitchGrid({ items, "aria-label": ariaLabel, "data-testid": testId, columns }: SwitchGridProps) {
  const gridStyle: CSSProperties = {
    display: "grid",
    gridTemplateColumns: columns ? `repeat(${columns}, minmax(0, 1fr))` : SWITCH_GRID_COLUMNS,
    columnGap: "var(--space-5)",
    rowGap: "var(--space-2)",
    width: "100%",
    boxSizing: "border-box",
  };

  return (
    <div role="group" aria-label={ariaLabel} data-testid={testId ?? "switch-grid"} style={gridStyle}>
      {items.map((it) => {
        const blocked = !!it.disabled;
        return (
          <div
            key={it.id}
            id={it.anchor ? anchorId(it.anchor) : undefined}
            data-testid={it["data-testid"] ?? `switch-grid-cell-${it.id}`}
            title={blocked ? it.disabledReason : undefined}
            data-disabled-reason={blocked ? it.disabledReason : undefined}
            aria-disabled={blocked || undefined}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--space-3)",
              minWidth: 0,
              minHeight: "calc(var(--ctrl-h-lg) + var(--space-2) * 2)",
              boxSizing: "border-box",
              padding: "var(--space-2) 0",
              // 규칙 ④: 사유는 title 로, 표현은 행 전체 opacity 로.
              ...(blocked ? { opacity: "var(--dim-disabled)" } : {}),
            }}
          >
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "var(--space-1)",
                minWidth: 0,
                fontSize: "var(--text-md)",
              }}
            >
              {/* 라벨은 줄바꿈한다(말줄임 아님, 2026-10-18 화면 보드 31-settings-ai_chat/ai_permissions). 한 줄 말줄임이면
                  2열 셀(≈200px)에서 "사용자 폴더와 파일을 봅니다" 가 "…봅…" 으로 잘려 무엇을 켜는지 읽을 수 없었다.
                  한국어는 어절 단위로 먼저 끊고(keep-all), 한 어절이 셀보다 길면(en/fr 긴 낱말) 아무 데서나 끊는다(anywhere). */}
              <span style={{ minWidth: 0, wordBreak: "keep-all", overflowWrap: "anywhere" }}>{it.label}</span>
              {it.hint && <HintBadge hint={it.hint} />}
            </span>
            <Toggle
              checked={it.checked}
              disabled={it.disabled}
              busy={it.busy}
              onChange={it.onChange}
              aria-label={it.ariaLabel ?? (typeof it.label === "string" ? it.label : it.id)}
              data-testid={`switch-grid-toggle-${it.id}`}
            />
          </div>
        );
      })}
    </div>
  );
}
