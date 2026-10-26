import type { CSSProperties, ReactNode } from "react";
import { Toggle } from "./Toggle";

/**
 * 설정 모달 폼의 칸 한 벌 — 내 기념일·불러오기·반복 일정·습관 네 폼이 같은 라벨/간격/오류 문법을 쓴다.
 * 예전엔 폼마다 `field`/`labelText` 스타일과 px 리터럴(4·6·14)을 따로 들고 있어 간격이 조금씩 어긋났다.
 *
 * - `FormStack` — 폼 본문 세로 묶음(칸 사이 `--space-6`).
 * - `FormField` — 라벨 + 컨트롤. **네이티브 입력만 `<label>` 로 감싼다**(`as="label"`, 기본). 버튼으로 된
 *   `Select`·`SegGroup` 은 `as="div"` — `<label>` 안의 첫 버튼은 라벨 글자 클릭을 받아 드롭다운이 열리거나
 *   세그먼트가 바뀐다.
 * - `FormToggleRow` — 이름 + 한 줄 설명 + 우측 Toggle.
 * - `WeekdayMaskField` — 비트0=월..비트6=일 요일 토글 줄(반복 일정·습관 공용).
 * - `FormError` — 폼 아래 오류 한 줄. **클라이언트 검증 문구만** 넣는다 — `call()` 실패는 이미 토스트가
 *   떴으므로 여기 다시 쓰지 않는다(같은 오류가 두 번 보이던 것을 고쳤다).
 */

export function FormStack({ children }: { children: ReactNode }) {
  return <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-6)" }}>{children}</div>;
}

export function FormField({
  label,
  children,
  as = "label",
  style,
}: {
  label: ReactNode;
  children: ReactNode;
  as?: "label" | "div";
  style?: CSSProperties;
}) {
  const Tag = as;
  return (
    <Tag style={{ ...fieldStyle, ...style }}>
      <span style={labelStyle}>{label}</span>
      {children}
    </Tag>
  );
}

export function FormToggleRow({
  label,
  hint,
  checked,
  onChange,
  "data-testid": testId,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  "data-testid"?: string;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--space-5)" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2xs)", minWidth: 0 }}>
        <span style={{ fontSize: "var(--text-sm)" }}>{label}</span>
        {hint && <span style={{ fontSize: "var(--text-xs)", color: "var(--muted)" }}>{hint}</span>}
      </div>
      <Toggle checked={checked} onChange={onChange} aria-label={label} data-testid={testId} />
    </div>
  );
}

export function WeekdayMaskField({
  label,
  labels,
  mask,
  onToggle,
  testIdPrefix,
}: {
  label: string;
  /** 월요일부터 7개(저장 비트 순서와 같다 — 사용자의 주 시작일과 무관). */
  labels: string[];
  mask: number;
  onToggle: (bit: number) => void;
  testIdPrefix: string;
}) {
  return (
    <FormField as="div" label={label}>
      <div role="group" aria-label={label} style={{ display: "flex", gap: "var(--space-2)" }}>
        {labels.map((l, i) => {
          const bit = 1 << i;
          const active = (mask & bit) !== 0;
          return (
            <button
              key={i}
              type="button"
              data-testid={`${testIdPrefix}${i}`}
              aria-pressed={active}
              onClick={() => onToggle(bit)}
              style={{
                flex: 1,
                padding: "var(--space-2) 0",
                borderRadius: "var(--radius-sm)",
                border: active ? "1px solid var(--accent)" : "1px solid var(--divider)",
                background: active ? "color-mix(in srgb, var(--accent) 18%, transparent)" : "transparent",
                color: active ? "var(--accent)" : "var(--text)",
                fontSize: "var(--text-xs)",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              {l}
            </button>
          );
        })}
      </div>
    </FormField>
  );
}

export function FormError({ children, "data-testid": testId }: { children: ReactNode; "data-testid"?: string }) {
  return (
    <div role="alert" data-testid={testId} style={{ color: "var(--danger)", fontSize: "var(--text-sm)" }}>
      {children}
    </div>
  );
}

const fieldStyle: CSSProperties = { display: "flex", flexDirection: "column", gap: "var(--space-1)" };
const labelStyle: CSSProperties = { fontSize: "var(--text-sm)", color: "var(--muted)", fontWeight: 600 };
