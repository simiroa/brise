import { useState, type KeyboardEvent } from "react";

interface ToggleProps {
  checked: boolean;
  disabled?: boolean;
  busy?: boolean;
  onChange: (next: boolean) => void;
  "aria-label": string;
  "data-testid"?: string;
}

/** Settings on/off control. Tactile spring switch with squash-and-stretch thumb mechanics. */
export function Toggle({
  checked,
  disabled,
  busy,
  onChange,
  "aria-label": ariaLabel,
  "data-testid": testId,
}: ToggleProps) {
  const [pressing, setPressing] = useState(false);
  const blocked = !!disabled || !!busy;

  const activate = () => {
    if (blocked) return;
    onChange(!checked);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setPressing(true);
    }
  };

  const onKeyUp = (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setPressing(false);
      activate();
    }
  };

  const H = "calc(6px + 12px*var(--fs))";

  return (
    <div
      role="switch"
      tabIndex={blocked ? -1 : 0}
      aria-checked={checked}
      aria-label={ariaLabel}
      aria-disabled={blocked || undefined}
      data-testid={testId}
      onClick={activate}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onMouseDown={() => !blocked && setPressing(true)}
      onMouseUp={() => setPressing(false)}
      onMouseLeave={() => setPressing(false)}
      style={{
        width: `calc(${H} * 1.85)`,
        minHeight: H,
        height: H,
        boxSizing: "border-box",
        flex: "none",
        borderRadius: "var(--radius-pill)",
        background: checked ? "var(--accent)" : "var(--divider)",
        cursor: busy ? "wait" : blocked ? "not-allowed" : "pointer",
        position: "relative",
        transition: "background var(--dur-med), transform var(--dur-fast) ease, box-shadow var(--dur-med)",
        transform: pressing ? "scale(0.96)" : "scale(1)",
        // PLAN-2026-09-12 §7: 여기 있던 rgba(0,0,0,…) 생값 셋을 토큰으로 옮겼다.
        //
        // **`--overlay` 파생은 쓰지 마라**(W2 가 그렇게 했다가 되돌렸다). `--overlay` 는 알파가
        // 테마마다 다르고(다크 .62 / 라이트 .45), `color-mix(… N%, transparent)` 는 그 알파에
        // N 을 **곱한다**. 그래서 다크 기준으로 고른 N 이 라이트에서는 .45/.62 = 0.73 배가 되어
        // 그림자가 25~28% 옅어졌다 — 인라인 스타일에는 테마별 분기가 없으니 한 N 으로 두 테마를
        // 맞출 방법이 없다.
        //
        // 대신 §7 표가 원래 지시한 `--shadow-*` 를 쓴다. `--shadow-sm`(0 1px 2px, #000 20%)은
        // 라이트에서 재정의되지 않아 **두 테마에서 같은 무게**가 나온다 — 예전 생값 .22/.18 과
        // 사실상 같은 자리다. var() 치환은 값 파싱 전에 문자열로 일어나므로 `inset var(--shadow-sm)`
        // 은 `inset 0 1px 2px …` 로 펼쳐져 그대로 inset 그림자가 된다.
        // (켜짐/꺼짐이 .18/.22 로 갈려 있던 것은 알파 2% 차이라 눈에 띄지 않았다 — 한 값으로 합쳤다.)
        boxShadow: checked
          ? "inset var(--shadow-sm), 0 0 0 1px color-mix(in srgb, var(--accent) 35%, transparent)"
          : "inset var(--shadow-sm)",
        opacity: busy ? "var(--dim-ghost)" : disabled ? "var(--dim-disabled)" : 1,
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 2,
          left: checked ? `calc(100% - ${H} + 2px)` : 2,
          width: `calc(${H} - 4px)`,
          height: `calc(${H} - 4px)`,
          borderRadius: "var(--radius-pill)",
          background: "var(--on-solid)",
          pointerEvents: "none",
          // 썸의 2겹(접촉 + 앰비언트) 그림자. 예전 생값은 .32 + .16 이었고 합성하면 코어에서
          // ≈.43 이다. 알파를 직접 쓰려면 색 토큰(--shadow-color)이 필요한데 tokens.css 는 이
          // 레인 밖이라, **같은 접촉 레이어를 두 번 겹쳐** 그 무게를 근사한다(1-(1-.2)² = .36).
          // 위 트랙과 같은 이유로 --overlay 파생은 쓰지 않는다 — 그러면 라이트에서만 옅어진다.
          boxShadow: "var(--shadow-sm), var(--shadow-sm)",
          transition: "left var(--dur-slow) cubic-bezier(0.34, 1.25, 0.64, 1), transform var(--dur-med) cubic-bezier(0.34, 1.25, 0.64, 1), width var(--dur-med) ease",
          transform: pressing ? "scaleX(1.3)" : "scaleX(1)",
          transformOrigin: checked ? "right center" : "left center",
        }}
      />
    </div>
  );
}
