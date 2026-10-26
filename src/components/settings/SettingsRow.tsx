import { useId, type CSSProperties, type ReactNode } from "react";
import { HintBadge } from "./HintBadge";
import { anchorId } from "./settingsAnchor";

interface SettingsRowProps {
  label: ReactNode;
  hint?: string;            // 한 줄. 두 줄짜리는 여기 넣지 않는다(규칙 ③)
  control: ReactNode;
  disabled?: boolean;       // 행 전체 dim + 컨트롤 영역 조작 불가(규칙 ④)
  disabledReason?: string;  // title 툴팁 + aria-describedby — 화면 텍스트로 상주시키지 않는다
  /** 설정 검색·딥링크 앵커 이름(settingsSearchIndex.ts 의 anchor) — 행 루트 id 가 된다. */
  anchor?: string;
  "data-testid"?: string;
}

/** 화면에는 그리지 않고 보조기술에만 읽히는 텍스트(HintBadge 와 같은 클립 기법). */
const SR_ONLY: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: 0,
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  whiteSpace: "nowrap",
  border: 0,
};

export function SettingsRow(props: SettingsRowProps) {
  const reasonId = useId();
  // PLAN-2026-09-12 §2(D2): 선은 **영역 경계**에만 긋는다 — 카드와 카드 사이, 카드 안 하위
  // 그룹 사이. 옵션 행 아래에는 긋지 않는다. 행을 가르는 일은 여백(--space-4)이 한다.
  // "마지막 행"이라는 개념은 이 부품에 없다 — 카드 안 하위 그룹을 가르고 싶으면 그 그룹의
  // 컨테이너에 `borderTop: 1px solid var(--divider)` 를 준다.
  const style: CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "var(--space-5)",
    minHeight: "calc(var(--ctrl-h-lg) + var(--space-4) * 2)",
    boxSizing: "border-box",
    padding: "var(--space-4) 0",
    ...(props.disabled ? { opacity: "var(--dim-disabled)" } : {}),
  };
  const reason = props.disabled ? props.disabledReason : undefined;

  // 꺼진 행은 흐리기만 하지 않는다 — 컨트롤 영역에 `inert` 를 걸어 클릭·포커스·보조기술 조작을
  // 한 곳에서 막는다(호출자가 컨트롤마다 disabled 를 맞추지 않아도 된다). inert 영역은 히트
  // 테스트에서 빠지므로 컨트롤 위에 마우스를 올려도 바깥 행의 title(이유)이 그대로 뜬다.
  // inert 는 접근성 트리에서도 빠지므로, 이유 문구는 라벨 쪽(inert 밖)에 화면 밖 텍스트로 두고
  // 행의 aria-describedby 로 잇는다.
  return (
    <div
      id={props.anchor ? anchorId(props.anchor) : undefined}
      style={style}
      title={reason}
      data-testid={props["data-testid"]}
      data-disabled-reason={reason}
      aria-disabled={props.disabled || undefined}
      aria-describedby={reason ? reasonId : undefined}
    >
      <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}>
        <div style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-1)" }}>
          <span style={{ fontSize: "var(--text-md)" }}>{props.label}</span>
          {props.hint && <HintBadge hint={props.hint} />}
        </div>
        {reason && (
          <span id={reasonId} style={SR_ONLY}>
            {reason}
          </span>
        )}
      </div>
      <div
        data-settings-row-control=""
        inert={props.disabled || undefined}
        // 래퍼가 레이아웃을 바꾸지 않게: 기본 flex(0 1 auto) + minWidth 0 이라 예전처럼 컨트롤이
        // 직접 flex 자식이던 때와 같은 자리에서 줄어든다(SyncSection 의 말줄임 값 등).
        style={{ display: "flex", alignItems: "center", minWidth: 0 }}
      >
        {props.control}
      </div>
    </div>
  );
}
