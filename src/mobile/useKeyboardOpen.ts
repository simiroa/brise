import { useEffect, useState } from "react";

/**
 * 화면 키보드가 열려 있는가 — 앱 루트(`.mobile-app[data-kbd="open"]`)가 하단 탭·프리셋 칩처럼
 * 입력 중에 자리만 먹는 크롬을 숨기는 데 쓴다(2026-10-04 실기기 캡처: 입력 화면에서 키보드 위에
 * 하단 탭 + 저장 바 + 프리셋 칩 2줄이 남아 실제 입력 줄이 1줄만 보였다).
 *
 * 왜 두 조건을 AND 하나: 안드로이드 WebView 는 키보드가 열리면 레이아웃 뷰포트 자체가 줄고, iOS
 * Safari 는 `visualViewport` 만 줄어든다(MobileModal.tsx 헤더 참고). 그래서 높이는 항상
 * `visualViewport.height` 로 보되, 주소창 접힘·분할 화면처럼 키보드 없이 높이가 바뀌는 경우를
 * 키보드로 오인하지 않도록 "편집 가능한 요소에 포커스가 있다"를 함께 요구한다.
 *
 * ponytail: 임계값은 고정 150px(가장 작은 화면 키보드도 이보다 크다). 외장 키보드를 붙인
 * 태블릿은 높이가 줄지 않으므로 "열림"이 아니다 — 의도대로다(크롬을 숨길 이유가 없다).
 */
const KEYBOARD_MIN_PX = 150;

function isEditableFocused(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled;
  if (el instanceof HTMLInputElement) {
    if (el.readOnly || el.disabled) return false;
    // 체크박스·버튼류는 키보드를 띄우지 않는다.
    return !["checkbox", "radio", "button", "submit", "reset", "file", "range", "color"].includes(el.type);
  }
  return false;
}

function viewportHeight(): number {
  return window.visualViewport?.height ?? window.innerHeight;
}

export function useKeyboardOpen(): boolean {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    // 키보드가 닫힌 상태의 높이 — 지금까지 본 최댓값. 회전하면 기준이 바뀌므로 다시 잰다.
    let baseline = Math.max(window.innerHeight, viewportHeight());
    const sync = () => {
      const h = viewportHeight();
      if (h > baseline) baseline = h;
      setOpen(isEditableFocused() && baseline - h > KEYBOARD_MIN_PX);
    };
    const resetBaseline = () => {
      baseline = Math.max(window.innerHeight, viewportHeight());
      sync();
    };
    // focusout 직후에는 activeElement 가 아직 body 로 넘어가기 전일 수 있어 한 틱 미룬다.
    const syncSoon = () => setTimeout(sync, 0);

    const vv = window.visualViewport;
    vv?.addEventListener("resize", sync);
    vv?.addEventListener("scroll", sync);
    window.addEventListener("resize", sync);
    window.addEventListener("orientationchange", resetBaseline);
    document.addEventListener("focusin", sync);
    document.addEventListener("focusout", syncSoon);
    sync();
    return () => {
      vv?.removeEventListener("resize", sync);
      vv?.removeEventListener("scroll", sync);
      window.removeEventListener("resize", sync);
      window.removeEventListener("orientationchange", resetBaseline);
      document.removeEventListener("focusin", sync);
      document.removeEventListener("focusout", syncSoon);
    };
  }, []);

  return open;
}
