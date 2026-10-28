/**
 * N-way 선택 띠 — 표시가 칸 사이를 미끄러진다. `settings/SegGroup`(균등 분할·고정 폭)의 일반형:
 * 칸 폭이 글자 길이대로 달라도 되고(실제 칸을 재서 표시를 맞춘다), 아이콘·개수·underline 모양,
 * 좁은 자리의 가로 스크롤을 갖는다. 접근성은 radiogroup — 활성 칸만 탭 정지점(roving tabindex),
 * ←→↑↓·Home·End 가 이동과 선택을 같이 한다.
 *
 * 라벨은 호출자가 i18n 으로 넘긴다(이 파일에 사용자 문구 없음). 설정의 `SegGroup`(18곳)과 펫 설정이 쓴다.
 * ponytail: 표시를 끌어 고르기(드래그 스크럽)는 뺐다 — 쓸 자리가 생기면 pointer 핸들러만 더하면 된다.
 */
import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import "./uiKit.css";

export type SegmentOption<T extends string = string> = {
  value: T;
  label: ReactNode;
  icon?: ReactNode;
  /** 라벨 뒤 작은 숫자(예: 안 읽은 개수). */
  count?: number | string;
  disabled?: boolean;
  title?: string;
  /** 아이콘만 있는 칸의 접근 가능한 이름. */
  ariaLabel?: string;
};

export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  variant = "tray",
  fill = false,
}: {
  value: T;
  onChange: (v: T) => void;
  options: SegmentOption<T>[];
  ariaLabel: string;
  /** tray = 회색 트랙 + 활성 칸 채움, underline = 글자 탭 + 밑줄. */
  variant?: "tray" | "underline";
  /** 부모 폭을 채우고 칸을 균등 분할한다(설정 행의 고정 폭 컨트롤 자리). 기본은 글자 폭대로. */
  fill?: boolean;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const optRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const activeIdx = options.findIndex((o) => o.value === value);
  const [box, setBox] = useState<{ x: number; w: number } | null>(null);

  // 활성 칸의 실제 자리를 잰다. 폰트 로딩·창 크기·라벨 변경으로 폭이 바뀌면 ResizeObserver 가 다시 잰다.
  // (jsdom 에는 ResizeObserver 가 없어 첫 측정만 한다 — 크기 0 이면 표시를 그리지 않는다.)
  useLayoutEffect(() => {
    const el = optRefs.current[activeIdx];
    const root = rootRef.current;
    if (!el || !root) {
      setBox(null);
      return;
    }
    const measure = () => {
      const next = { x: el.offsetLeft, w: el.offsetWidth };
      setBox((cur) => (cur && cur.x === next.x && cur.w === next.w ? cur : next));
    };
    measure();
    // 좁아서 가로로 구르는 경우 활성 칸이 보이게 한다. scrollIntoView 는 쓰지 않는다 — 조상 스크롤 컨테이너(설정 본문
    // 포함)까지 움직여, 페이지를 맨 위로 되돌린 직후 아래쪽 띠의 이 효과가 본문을 도로 끌어내렸다(SettingsPanel 앵커
    // 소비 주석이 금지한 바로 그 동작). 이 띠(.seg, position: relative 라 칸의 offsetParent)의 가로 스크롤만 직접 맞춘다.
    if (root.scrollWidth > root.clientWidth) {
      const left = el.offsetLeft;
      const right = left + el.offsetWidth;
      if (left < root.scrollLeft) root.scrollLeft = left;
      else if (right > root.scrollLeft + root.clientWidth) root.scrollLeft = right - root.clientWidth;
    }
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    ro.observe(el);
    return () => ro.disconnect();
  }, [activeIdx, options.length, variant]);

  const move = (from: number, step: 1 | -1) => {
    for (let n = 1; n <= options.length; n++) {
      const idx = (((from + step * n) % options.length) + options.length) % options.length;
      if (!options[idx].disabled) {
        optRefs.current[idx]?.focus();
        onChange(options[idx].value);
        return;
      }
    }
  };
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, idx: number) => {
    if (e.key === "ArrowRight" || e.key === "ArrowDown") move(idx, 1);
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") move(idx, -1);
    else if (e.key === "Home") move(-1, 1);
    else if (e.key === "End") move(options.length, -1);
    else return;
    e.preventDefault();
  };

  return (
    <div ref={rootRef} role="radiogroup" aria-label={ariaLabel} className={`seg seg--${variant}${fill ? " seg--fill" : ""}`}>
      {box && box.w > 0 && (
        <span
          aria-hidden
          data-testid="seg-indicator"
          className="seg__indicator"
          style={{ transform: `translateX(${box.x}px)`, width: box.w }}
        />
      )}
      {options.map((opt, idx) => {
        const on = idx === activeIdx;
        return (
          <button
            key={opt.value}
            ref={(el) => {
              optRefs.current[idx] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            aria-disabled={opt.disabled || undefined}
            aria-label={opt.ariaLabel}
            title={opt.title}
            // 활성 칸이 없으면(값이 목록 밖) 첫 칸이 탭 정지점이다.
            tabIndex={on || (activeIdx < 0 && idx === 0) ? 0 : -1}
            className="seg__opt"
            onClick={() => {
              if (!opt.disabled) onChange(opt.value);
            }}
            onKeyDown={(e) => onKeyDown(e, idx)}
          >
            {opt.icon}
            {opt.label}
            {opt.count !== undefined && <span className="seg__count">{opt.count}</span>}
          </button>
        );
      })}
    </div>
  );
}
