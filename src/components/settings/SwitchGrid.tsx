import type { CSSProperties, ReactNode } from "react";
import { SettingsRow } from "./SettingsRow";
import { Toggle } from "./Toggle";

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

const gridStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  width: "100%",
  boxSizing: "border-box",
};
const labelWrapStyle: CSSProperties = { minWidth: 0, wordBreak: "keep-all", overflowWrap: "anywhere" };

interface SwitchGridProps {
  items: SwitchGridItem[];
  /** 그리드 자체의 접근 이름 — `role="group"` 과 짝이다. 무엇들의 묶음인지 말한다. */
  "aria-label": string;
  "data-testid"?: string;
}

/**
 * 독립 on/off 토글 **3개 이상**을 한 묶음(`role="group"`)으로 놓는 얇은 래퍼 — 항목마다 `SettingsRow`(라벨 | 토글 한 줄)를 그린다.
 *
 * 예전엔 좌우 2단 그리드였고 셀 구조·비활성 처리(title·aria-disabled·opacity)를 여기서 따로 들고 있었다. 2026-10-27 개편으로 한 열이
 * 되면서 `SettingsRow` 와 같은 구조가 됐으므로, 이제 행 그리기는 `SettingsRow` 한 곳이다 — 꺼진 행의 `inert`(컨트롤 조작 차단) 와
 * 사유의 `aria-describedby` 도 거기서 한 번에 처리한다. 이 부품이 더하는 것은 묶음 접근 이름(`role="group"`), 테스트 id 규칙
 * (`switch-grid-cell-<id>`·`switch-grid-toggle-<id>`), 라벨 줄바꿈 규칙뿐이다.
 *
 * 여기 넣지 **않는** 것: 값 컨트롤(셀렉트·슬라이더·입력). 그것들은 `SettingsRow` + 220px 우측 정렬을 그대로 쓴다.
 */
export function SwitchGrid({ items, "aria-label": ariaLabel, "data-testid": testId }: SwitchGridProps) {
  return (
    <div role="group" aria-label={ariaLabel} data-testid={testId ?? "switch-grid"} style={gridStyle}>
      {items.map((it) => (
        <SettingsRow
          key={it.id}
          anchor={it.anchor}
          data-testid={it["data-testid"] ?? `switch-grid-cell-${it.id}`}
          // 라벨은 줄바꿈한다(말줄임 아님, 2026-10-18 화면 보드 31-settings-ai_chat/ai_permissions). 한 줄 말줄임이면 좁은 셀에서
          // "사용자 폴더와 파일을 봅니다" 가 "…봅…" 으로 잘려 무엇을 켜는지 읽을 수 없었다. 한국어는 어절 단위로 먼저 끊고(keep-all),
          // 한 어절이 폭보다 길면(en/fr 긴 낱말) 아무 데서나 끊는다(anywhere).
          label={<span style={labelWrapStyle}>{it.label}</span>}
          hint={it.hint}
          disabled={it.disabled}
          disabledReason={it.disabledReason}
          control={
            <Toggle
              checked={it.checked}
              disabled={it.disabled}
              busy={it.busy}
              onChange={it.onChange}
              aria-label={it.ariaLabel ?? (typeof it.label === "string" ? it.label : it.id)}
              data-testid={`switch-grid-toggle-${it.id}`}
            />
          }
        />
      ))}
    </div>
  );
}
