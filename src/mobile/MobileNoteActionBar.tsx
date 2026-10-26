import { useEffect, useRef, useState, type JSX, type ReactNode } from "react";
import { keepEditorFocus } from "./keepEditorFocus";

export interface MobileNoteActionBarProps {
  /** 왼쪽 도구 슬롯(MobileDockSlot) — 프리셋 | 서식 | 이미지 크기. 남는 폭을 다 받고 넘치면 가로 스크롤한다. */
  slot?: ReactNode;
}

/**
 * How far the dock's un-transformed bottom edge sits below the visible viewport.
 * Same `visualViewport` box MobileModal uses — iOS does not resize layout/`100dvh`, so a
 * flex-end bar lands under the keyboard unless it is lifted by this overlap.
 */
function barOverflowPx(el: HTMLElement, currentLift: number): number {
  const vv = typeof window !== "undefined" ? window.visualViewport : null;
  if (!vv) return 0;
  const visualBottom = vv.offsetTop + vv.height;
  const unliftedBottom = el.getBoundingClientRect().bottom + currentLift;
  return Math.max(0, Math.round(unliftedBottom - visualBottom));
}

/**
 * 하단 독 — 한 줄: [도구 슬롯 ··········]. 예전엔 [도구 슬롯 ····· ✨ 저장하기] 였다(오너 2026-10-07). 2026-10-10 오너
 * 피드백으로 ✨ 는 ＋ 스피드 다이얼의 항목이 됐고(MobileSpeedDial), 저장하기는 없앴다 — 타이핑이 700ms 디바운스로 이미
 * 저장하고(useMobileBodyEditor onUpdate), 저장 상태는 제목 줄 오른쪽 끝(MobileSaveStatus)이 보여 준다. 맨 위 서식 툴바 줄·
 * 프리셋 줄이 사라진 자리를 이 한 줄이 맡는다. iOS 보정(barOverflowPx)은 그대로다.
 *
 * 독의 모든 버튼은 에디터 포커스를 뺏지 않는다 — 루트에 위임 핸들러 하나(keepEditorFocus). 키보드가 열린 채로
 * 서식·프리셋을 눌러도 키보드가 안 내려간다. 한 가지 예외: IME 조합 중의 서식 눌림(☑·B·I)은
 * 버튼이 위임을 끊어(MobileNoteToolbar::releaseFocusWhileComposing) 포커스를 놓게 한다 — 조합을 확정한 뒤 명령을 돌리려고.
 */
export function MobileNoteActionBar({ slot }: MobileNoteActionBarProps): JSX.Element {
  const barRef = useRef<HTMLDivElement>(null);
  const liftRef = useRef(0);
  const [lift, setLift] = useState(0);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const sync = () => {
      const el = barRef.current;
      if (!el) return;
      const next = barOverflowPx(el, liftRef.current);
      if (next === liftRef.current) return;
      liftRef.current = next;
      setLift(next);
    };
    vv.addEventListener("resize", sync);
    vv.addEventListener("scroll", sync);
    sync();
    return () => {
      vv.removeEventListener("resize", sync);
      vv.removeEventListener("scroll", sync);
    };
  }, []);

  return (
    <div
      ref={barRef}
      className="mobile-capture-bar"
      data-testid="mobile-dock"
      onMouseDown={keepEditorFocus}
      // Geometry only — same contract as MobileModal's visualViewport box. No transition:
      // prefers-reduced-motion already covers this surface; don't add a new animation.
      style={lift > 0 ? { transform: `translateY(-${lift}px)` } : undefined}
    >
      {slot}
    </div>
  );
}
