/**
 * ToneSwatches — 플로팅 버블의 톤(색상) 드롭다운 항목 목록.
 *
 * DiagramFloatingBubble 의 다중·노드·엣지·그룹 네 곳에서 같은 모양으로 반복되던 것을 모았다.
 * (2026-10-19 부터 단일 노드는 이 드롭다운 대신 글자 붙은 색 칩 한 줄 — DiagramBubbleNode, GRILL R6.
 *  지금 쓰는 곳은 다중·엣지·그룹 셋이다.)
 * 네 곳의 차이는 셋뿐이고 전부 props 로 표현된다:
 *  - 현재 톤: 노드·엣지·그룹은 자기 톤을 `current` 로 넘기고, 다중 선택은 "현재 톤"이 없어 생략한다
 *    (그러면 항목에 data-selected 속성 자체가 붙지 않는다).
 *  - 칩 모양: `variant="dot"`(다중·노드·엣지) 은 노드 상태 점 클래스를, `"swatch"`(그룹) 는 그룹 전용
 *    색 견본 클래스 + data-tone 을 쓴다. 두 클래스 모두 정의된 CSS 가 없다 — 옮기면서 그대로 뒀다.
 *    swatch 변형은 data-selected 도 "참일 때만 붙는" 옛 그룹 표기를 그대로 따른다
 *    (dot 은 참/거짓 문자열 둘 다 붙는다 — DOM 을 한 글자도 바꾸지 않으려고 표기를 변형에 묶었다).
 *  - 선택 동작: `onPick` — 톤 적용과 서브메뉴 닫기는 호출자가 정한다.
 */
import { t } from "../../i18n/t";
import { DIAGRAM_TONES, toneLabelKey, type DiagramTone } from "./diagramStyles";

export interface ToneSwatchesProps {
  onPick: (tone: DiagramTone) => void;
  /** 현재 톤. 생략하면 어떤 항목도 선택 표시(data-selected)를 갖지 않는다. */
  current?: DiagramTone;
  variant?: "dot" | "swatch";
}

/** 톤 → 칩 색. default 는 투명 + 점선 테두리. */
function toneChipStyle(tone: DiagramTone) {
  return {
    background:
      tone === "accent"
        ? "var(--accent)"
        : tone === "warn"
        ? "var(--danger-soft)"
        : tone === "done"
        ? "var(--ok)"
        : tone === "muted"
        ? "var(--muted)"
        : "transparent",
    border: tone === "default" ? "1px dashed var(--muted)" : "none",
  };
}

export function ToneSwatches({ onPick, current, variant = "dot" }: ToneSwatchesProps) {
  const swatch = variant === "swatch";
  return (
    <>
      {DIAGRAM_TONES.map((tone) => {
        const isSelected = current === tone;
        return (
          <button
            key={tone}
            type="button"
            className="diagram-floating-bubble-dropdown-item"
            data-selected={current === undefined ? undefined : swatch ? (isSelected ? "true" : undefined) : isSelected}
            onClick={() => onPick(tone)}
          >
            <span
              className={swatch ? "diagram-floating-bubble-color-swatch" : "diagram-flow-node-state-dot"}
              data-tone={swatch ? tone : undefined}
              style={toneChipStyle(tone)}
            />
            <span>{t(toneLabelKey(tone))}</span>
          </button>
        );
      })}
    </>
  );
}
