import type { ButtonHTMLAttributes, ReactNode } from "react";

/**
 * 설정 창의 동작 버튼(내보내기·가져오기·삭제·초기화·추가·열기·새로고침…) 한 벌
 * (PLAN-2026-09-19-settings-icon-actions §1).
 *
 * 아이콘만 그린다 — 이름은 `aria-label` 과 `title`(툴팁) 로만, **둘 다 같은 `label`** 이다.
 * 40곳에 손으로 aria-label·title 을 맞추면 반드시 어긋나므로(조사 당시 title 누락 3곳) 이 컴포넌트
 * 하나로 강제한다. 모양은 tokens.css 의 `.icon-btn` 가족을 그대로 쓴다(새 CSS 없음).
 *
 * - `titleOverride` — 툴팁만 따로 둘 때(브라우저 모드의 "데스크톱 전용" 안내 등). 아이콘뿐이면
 *   툴팁이 눈에 보이는 유일한 이름이라, 넘기지 않으면 `label` 이 툴팁이 된다.
 * - `busy` — 진행 중(연결 테스트·백업 등): 아이콘을 스피너로 바꾸고 `aria-busy`. 누름은 호출자가
 *   `disabled` 로 막는다(여기서 강제하면 busy 중에도 취소를 받는 버튼을 못 만든다).
 * - `disabled` — 흐림(`--dim-disabled`)과 `not-allowed` 커서를 **여기서** 준다. `.icon-btn` 에는
 *   :disabled 모양이 없어서 호출자마다 opacity 를 손으로 달았다 — 그러지 마라. busy 중의 disabled 는
 *   흐리지 않는다(스피너가 진행을 말해야 하므로 커서만 wait).
 *   꺼진 버튼은 hover 칠·눌림 축소·아이콘 반응도 받지 않는다 — `.icon-btn:hover` 에는 :disabled 제외가
 *   없어서 꺼진 버튼이 누를 수 있는 것처럼 밝아졌다. 전역 `.icon-btn` 을 고치는 대신(앱 전체 수백 곳)
 *   이미 있는 "누를 수 없는 슬롯" 수식자 `.icon-btn--static` 을 붙여 그 셋을 한 번에 끈다. 그 hover 는
 *   `color:inherit` 이라 쉼 색이 바뀌지 않게 색을 여기서 고정한다(danger 도 쉼 색은 --muted 다).
 */
export interface IconActionProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "title" | "aria-label"> {
  icon: ReactNode;
  label: string;
  danger?: boolean;
  size?: "sm" | "md" | "lg";
  busy?: boolean;
  titleOverride?: string;
}

export function IconAction({
  icon,
  label,
  danger,
  size = "md",
  busy,
  titleOverride,
  className,
  type = "button",
  style,
  ...rest
}: IconActionProps) {
  const cls = [
    "icon-btn",
    size === "sm" ? "icon-btn--sm" : size === "lg" ? "icon-btn--lg" : null,
    danger ? "icon-btn--danger" : null,
    rest.disabled ? "icon-btn--static" : null,
    className ?? null,
  ]
    .filter(Boolean)
    .join(" ");
  const stateStyle = busy
    ? { cursor: "wait", ...(rest.disabled ? { color: "var(--muted)" } : null) }
    : rest.disabled
      ? { opacity: "var(--dim-disabled)", cursor: "not-allowed", color: "var(--muted)" }
      : undefined;
  return (
    <button
      {...rest}
      type={type}
      className={cls}
      style={stateStyle || style ? { ...stateStyle, ...style } : undefined}
      aria-label={label}
      title={titleOverride ?? label}
      aria-busy={busy ? true : undefined}
    >
      {busy ? <ActionSpinner /> : icon}
    </button>
  );
}

/** 아이콘 자리를 그대로 차지하는 회전 링 — tokens.css 의 `@keyframes spin` 을 쓴다. */
function ActionSpinner() {
  return (
    <span
      data-testid="icon-action-spinner"
      aria-hidden="true"
      style={{
        width: 14,
        height: 14,
        borderRadius: "50%",
        border: "2px solid currentColor",
        borderTopColor: "transparent",
        animation: "spin 1s linear infinite",
        display: "inline-block",
        boxSizing: "border-box",
      }}
    />
  );
}
