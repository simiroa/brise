import { useEffect, useRef, useState } from "react";
import { MobileSpeedDial, type SpeedDialHandlers } from "./MobileSpeedDial";
import { useKeyboardOpen } from "./useKeyboardOpen";

/**
 * FAB 가 본문 아래쪽을 가리는 높이(px) = ＋ 56 + 아래 여백 12 + 숨 쉴 틈 12.
 * (오너 2026-10-07: 마이크+＋ 두 버튼 스택 140 → ＋ 하나 80. 다이얼이 열려 위로 펼쳐진 동안은 본문 위에 잠깐 겹쳐 뜨는 것이라 여기 안 센다.)
 * 두 곳이 이 값을 쓴다 — ⓐ CSS `.mobile-note-stage { --m-fab-clear }`(맨 아래 줄·첨부가 FAB 위로 스크롤돼 오도록
 * 본문 아래 패딩) ⓑ useFabScrollMargin(캐럿이 FAB 밑으로 들어가지 않도록 ProseMirror scrollMargin).
 * CSS 쪽 숫자는 note-capture.css 에 리터럴로 있고, MobileNoteFab.test.tsx 가 둘이 같은지 본다.
 */
export const FAB_CLEARANCE_PX = 80;

export interface MobileNoteFabProps extends SpeedDialHandlers {
  scrollEl?: HTMLElement | null;
}

/**
 * 본문 오른쪽 아래에 겹쳐 뜨는 입력 버튼 — ＋ 하나(56)를 누르면 녹음 · 사진 · 파일 첨부가 위로 펼쳐지는 스피드 다이얼
 * (MobileSpeedDial). 텍스트 섹션 전용이다: 관계도·시트에서는 이 떠 있는 버튼이 본문 아래쪽 컨트롤("소스 편집"·시트 도구)을
 * 가려서, 같은 ＋ 를 하단 독의 도구 슬롯으로 옮긴다(MobileDockSlot::speedDial). 두 곳에 동시에 있지 않다.
 * 녹음·첨부는 노트 단위 동작이라 읽기 전용에서도 숨기지 않는다 — 첨부가 읽기 전용 노트에서 닿지 않게 되면 안 된다.
 *
 * Wave FAB (Q16): 본문을 아래로 스크롤(≥8px 누적)하는 동안 숨겨지고, 위로 스크롤·~600ms 유휴·바닥 도달 시 다시 표시된다.
 * 다이얼이 열려 있거나 키보드가 올라온 동안은 절대 숨기지 않는다.
 */
export function MobileNoteFab({ scrollEl, ...props }: MobileNoteFabProps) {
  const [hidden, setHidden] = useState(false);
  const [dialOpen, setDialOpen] = useState(false);
  const keyboardOpen = useKeyboardOpen();
  const fabRef = useRef<HTMLDivElement>(null);

  const lastScrollTopRef = useRef(0);
  const accumulatedDownRef = useRef(0);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 다이얼 열림 상태 관찰 (SpeedDial 래퍼 내부 MutationObserver)
  useEffect(() => {
    const el = fabRef.current;
    if (!el) return;

    const checkOpen = () => {
      const isOpen = el.querySelector('.mobile-speed-dial[data-open="true"]') !== null;
      setDialOpen(isOpen);
      if (isOpen) {
        setHidden(false);
        accumulatedDownRef.current = 0;
      }
    };

    const observer = new MutationObserver(checkOpen);
    observer.observe(el, { attributes: true, subtree: true, attributeFilter: ["data-open", "aria-expanded"] });
    checkOpen();

    return () => observer.disconnect();
  }, []);

  // 키보드가 올라오면 항상 표시
  useEffect(() => {
    if (keyboardOpen) {
      setHidden(false);
      accumulatedDownRef.current = 0;
    }
  }, [keyboardOpen]);

  // 스크롤 이벤트 감지
  useEffect(() => {
    if (!scrollEl) return;
    lastScrollTopRef.current = scrollEl.scrollTop;
    accumulatedDownRef.current = 0;

    const handleScroll = () => {
      const currentScrollTop = scrollEl.scrollTop;
      const delta = currentScrollTop - lastScrollTopRef.current;
      lastScrollTopRef.current = currentScrollTop;

      // ~600ms idle 후 show
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      idleTimerRef.current = setTimeout(() => {
        setHidden(false);
        accumulatedDownRef.current = 0;
      }, 600);

      // 다이얼이 열려 있거나 키보드가 열려 있으면 숨기지 않음
      const isDialActuallyOpen =
        dialOpen || (fabRef.current?.querySelector('.mobile-speed-dial[data-open="true"]') !== null);
      if (isDialActuallyOpen || keyboardOpen) {
        setHidden(false);
        accumulatedDownRef.current = 0;
        return;
      }

      // 바닥에 도달했는지 확인
      const isAtBottom = scrollEl.scrollTop + scrollEl.clientHeight >= scrollEl.scrollHeight - 2;
      if (isAtBottom) {
        setHidden(false);
        accumulatedDownRef.current = 0;
        return;
      }

      if (delta > 0) {
        // 아래로 스크롤: ≥ 8px 누적 시 숨김
        accumulatedDownRef.current += delta;
        if (accumulatedDownRef.current >= 8) {
          setHidden(true);
        }
      } else if (delta < 0) {
        // 위로 스크롤 시 즉시 표시
        accumulatedDownRef.current = 0;
        setHidden(false);
      }
    };

    scrollEl.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      scrollEl.removeEventListener("scroll", handleScroll);
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    };
  }, [scrollEl, dialOpen, keyboardOpen]);

  const isActuallyHidden = hidden && !dialOpen && !keyboardOpen;

  return (
    <div
      ref={fabRef}
      className="mobile-note-fab"
      data-testid="mobile-note-fab"
      data-hidden={isActuallyHidden || undefined}
    >
      <MobileSpeedDial placement="float" {...props} />
    </div>
  );
}
