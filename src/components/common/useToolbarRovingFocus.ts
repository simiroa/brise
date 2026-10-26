import { useEffect, useRef, type RefObject, type KeyboardEvent } from "react";

/** role="toolbar" 세 곳이 공유하는 로빙 탭인덱스. 컨테이너에 ref + onKeyDown 만 붙인다 —
 *  자식 JSX 는 한 줄도 바뀌지 않는다(VerbButtons 는 W4 계약상 무수정이어야 한다). */
export function useToolbarRovingFocus<T extends HTMLElement = HTMLDivElement>(): {
  ref: RefObject<T | null>;
  onKeyDown: (e: KeyboardEvent) => void;
} {
  const ref = useRef<T | null>(null);
  const activeIndexRef = useRef<number>(0);
  const hadFocusRef = useRef<boolean>(false);

  useEffect(() => {
    const container = ref.current;
    if (!container) return;

    const handleFocusIn = (e: FocusEvent) => {
      hadFocusRef.current = true;
      const target = (e.target as HTMLElement | null)?.closest("button:not([disabled])") as HTMLButtonElement | null;
      if (target && container.contains(target)) {
        const items = Array.from(container.querySelectorAll<HTMLButtonElement>("button:not([disabled])"));
        const idx = items.indexOf(target);
        if (idx !== -1) {
          activeIndexRef.current = idx;
          items.forEach((btn, i) => {
            btn.tabIndex = i === idx ? 0 : -1;
          });
        }
      }
    };

    const handleFocusOut = (e: FocusEvent) => {
      if (e.relatedTarget && !container.contains(e.relatedTarget as Node)) {
        hadFocusRef.current = false;
      }
    };

    container.addEventListener("focusin", handleFocusIn);
    container.addEventListener("focusout", handleFocusOut);

    const items = Array.from(container.querySelectorAll<HTMLButtonElement>("button:not([disabled])"));
    if (items.length > 0) {
      activeIndexRef.current = Math.max(0, Math.min(activeIndexRef.current, items.length - 1));
      items.forEach((btn, idx) => {
        btn.tabIndex = idx === activeIndexRef.current ? 0 : -1;
      });

      if (hadFocusRef.current && document.activeElement === document.body) {
        items[activeIndexRef.current]?.focus();
      }
    }

    return () => {
      container.removeEventListener("focusin", handleFocusIn);
      container.removeEventListener("focusout", handleFocusOut);
    };
  });

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if ((e.target as HTMLElement | null)?.closest("input, textarea")) return;
    if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(e.key)) return;

    const container = ref.current;
    if (!container) return;

    const items = Array.from(container.querySelectorAll<HTMLButtonElement>("button:not([disabled])"));
    if (items.length === 0) return;

    const currentTarget = (e.target as HTMLElement | null)?.closest("button:not([disabled])") as HTMLButtonElement | null;
    let currentIndex = currentTarget ? items.indexOf(currentTarget) : -1;
    if (currentIndex === -1) {
      currentIndex = Math.max(0, Math.min(activeIndexRef.current, items.length - 1));
    }

    let nextIndex = 0;
    if (e.key === "Home") {
      nextIndex = 0;
    } else if (e.key === "End") {
      nextIndex = items.length - 1;
    } else if (e.key === "ArrowRight") {
      nextIndex = (currentIndex + 1) % items.length;
    } else if (e.key === "ArrowLeft") {
      nextIndex = (currentIndex - 1 + items.length) % items.length;
    }

    activeIndexRef.current = nextIndex;
    items.forEach((btn, idx) => {
      btn.tabIndex = idx === nextIndex ? 0 : -1;
    });

    e.preventDefault();
    // ponytail: 로빙 그룹은 한 줄(1D)만 다룬다. 가로 스크롤로 밀려 시야 밖에 있는 버튼으로 이동할 때 scrollIntoView 는 하지 않는다 — 브라우저의 기본 포커스 스크롤에 맡긴다. 업그레이드 경로는 items[nextIndex].scrollIntoView({block: "nearest", inline: "nearest"}) 한 줄.
    items[nextIndex]?.focus();
  };

  return { ref, onKeyDown };
}
