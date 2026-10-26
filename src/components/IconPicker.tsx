import { useCallback, useEffect, useRef, useState, type ComponentType, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { NOTE_ICONS } from "../lib/noteIcons";
import type { IconProps } from "./icons";
import { t } from "../i18n/t";
import { useDismiss } from "../lib/ui";

/**
 * 큐레이션 아이콘 팔레트 그리드 — 노트북(= workspace) 편집 패널과 노트 아이콘 다이얼로그가 공용으로 쓴다.
 * value = 현재 선택된 키(null = 기본/미지정). 첫 스와치("기본")를 누르면 onPick(null) 로 폴백으로
 * 되돌린다. 스와치 스타일은 tokens.css 의 `.icon-swatch` 가 소유한다(hover/active).
 */
export function IconGrid({
  value,
  onPick,
  defaultComp,
}: {
  value: string | null;
  onPick: (key: string | null) => void;
  defaultComp: ComponentType<IconProps>;
}) {
  const Default = defaultComp;
  return (
    <div
      className="scroll"
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(38px, 1fr))",
        gap: "var(--space-2)",
        maxHeight: 224,
        overflowY: "auto",
      }}
    >
      <button
        type="button"
        onClick={() => onPick(null)}
        title={t("ctx.icon_default")}
        aria-label={t("ctx.icon_default")}
        aria-pressed={value === null}
        className="icon-swatch"
        data-active={value === null}
      >
        <Default size={18} strokeWidth={1.7} />
      </button>
      {NOTE_ICONS.map(({ key, Comp }) => (
        <button
          type="button"
          key={key}
          onClick={() => onPick(key)}
          title={key}
          aria-label={key}
          aria-pressed={value === key}
          className="icon-swatch"
          data-active={value === key}
        >
          <Comp size={18} strokeWidth={1.7} />
        </button>
      ))}
    </div>
  );
}


/**
 * 아이콘 픽커 팝오버의 껍데기 — 앵커 옆 위치 계산 · 바깥 클릭/Escape 닫기 · `.overlay` 표면.
 * 노트 한 줄의 아이콘 메뉴(NoteIconControl)와 폴더 설정의 아이콘 버튼이 같은 껍데기를 쓴다.
 * "폴더 아이콘도 파일 아이콘 메뉴처럼 뜨면 좋겠다"는 요구를 CSS 를 두 벌 맞추는 대신 컴포넌트
 * 하나로 해결한다 — 안에 무엇을 넣을지(탭+이모지 / 색 스와치+격자)는 호출부가 정한다.
 *
 * `ignoreRef` 는 팝오버를 여는 트리거 자신 — 클릭 토글로 여는 호출부에서 이게 없으면 트리거를
 * 다시 눌렀을 때 "바깥 클릭으로 닫힘 → 그 click 이 다시 염" 이 되어 영영 안 닫힌다.
 */
export function IconPickerPopover({
  anchorRect,
  onClose,
  ignoreRef,
  children,
}: {
  anchorRect: DOMRect;
  onClose: () => void;
  ignoreRef?: RefObject<Element | null>;
  children: ReactNode;
}) {
  const popRef = useRef<HTMLDivElement>(null);
  const emptyRef = useRef<Element | null>(null);
  useDismiss(true, [popRef, ignoreRef ?? emptyRef], onClose);

  const W = 310;
  // H 는 "가장 클 때"의 값이다 — 실제 높이는 내용에 맞춰 줄어든다(색 스와치 없이 격자만 있는
  // 폴더 픽커는 340 을 다 못 채워 아래가 휑했다). 화면 밖으로 나가지 않게 잡는 계산에는 최대값을
  // 그대로 쓴다: 줄어든 높이를 기준으로 잡으면 내용이 늘었을 때 아래가 잘린다.
  const H = 340;

  const computePos = useCallback(() => ({
    left: Math.max(12, Math.min(anchorRect.right + 6, window.innerWidth - W - 12)),
    top: Math.max(12, Math.min(anchorRect.top, window.innerHeight - H - 12)),
  }), [anchorRect]);

  const [{ left, top }, setPos] = useState(computePos);

  useEffect(() => {
    setPos(computePos());
    const onResize = () => setPos(computePos());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [computePos]);

  return createPortal(
    <div
      ref={popRef}
      className="overlay"
      role="dialog"
      data-testid="icon-picker-popover"
      style={{
        position: "fixed",
        top,
        left,
        width: W,
        maxHeight: H,
        zIndex: "var(--z-modal)",
        padding: "10px",
        border: "2px solid var(--divider)",
        borderRadius: "var(--radius-md)",
        boxShadow: "var(--shadow-lg)",
        display: "flex",
        flexDirection: "column",
        gap: "8px",
        overflow: "hidden",
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
