import { useEffect } from "react";
import type { Editor } from "@tiptap/core";
import { FAB_CLEARANCE_PX } from "./MobileNoteFab";

/**
 * 캐럿이 FAB 밑으로 들어가지 않게 한다. ProseMirror 의 scrollRectIntoView 는 스크롤 영역의 **경계 상자**에 대해
 * 캐럿을 맞추고 CSS `scroll-padding`·패딩을 보지 않는다(기본 여백 5px). 그래서 긴 줄 끝에서 타이핑하면 캐럿이 본문
 * 맨 아래 5px 위에 서고, 오른쪽 아래에 겹쳐 뜬 ＋ FAB(MobileNoteFab, 스피드 다이얼) 밑으로 숨는다. 본문 패딩은 "맨 끝까지 스크롤했을 때의
 * 마지막 줄"만 해결한다. 타이핑 중 캐럿은 이 훅이 건다.
 *
 * **두 값이 한 쌍이다**(prosemirror-view `scrollRectIntoView`): `scrollThreshold.bottom` = 캐럿이 가장자리 얼마 안쪽에
 * 들어오면 스크롤을 **시작**하는가(기본 0 = 가장자리를 넘어야 시작), `scrollMargin.bottom` = 시작한 뒤 가장자리에서 얼마
 * 띄워 **멈추는가**. margin 만 주면 FAB 가 덮는 맨 아래 띠(FAB_CLEARANCE_PX) 안의 캐럿은 아직 "가장자리를 안 넘었으니" 스크롤이 시작도
 * 안 된다 — 한 번 스크롤된 뒤에야 띄워지고 그다음 몇 줄은 다시 띠 안으로 걸어 들어가며 글자 끝이 FAB 밑에 가려진다.
 * 둘을 같은 값으로 두면 스크롤이 멈춘 자리가 곧 다음 스크롤의 시작선이라 어긋나지 않는다.
 *
 * 값은 **스크롤 영역 높이에 맞춰 줄인다**(clampClearance). 가로 모드 + 키보드처럼 영역이 FAB 띠(FAB_CLEARANCE_PX)보다 낮으면 띠가
 * 영역 전체라서 캐럿이 늘 "띠 안"이고, 키 하나마다 스크롤이 시도된다 — 영역에서 최소 MIN_VISIBLE_ABOVE_PX 는 띠 위로
 * 남도록 한다. 영역 높이는 키보드가 오르내릴 때 변하므로 ResizeObserver 로 따라간다.
 *
 * 왜 editorProps 가 아니라 `view.setProps`: editorProps 는 useMobileBodyEditor 소유고, Tiptap 은 렌더마다
 * `view.setProps(editorProps)` 를 부르지만 **주어진 키만** 덮으므로 여기서 건 값은 살아남는다
 * (MobileNote.realEditor.test.tsx 가 setOptions 뒤에도 남는지 본다). 플러그인(`registerPlugin`)은 안 된다 —
 * 뷰를 다시 만들 때 `createView` 가 플러그인 목록을 확장 목록으로 되돌린다.
 * Tiptap v3 의 Editor 는 생성자에서 뷰를 만들고(EditorContent 는 그 DOM 을 옮겨 붙일 뿐) 파괴될 때까지 같은 뷰를
 * 쓴다 — 그래서 에디터 인스턴스마다 한 번이면 된다(뷰 없는 에디터는 `isDestroyed` 가 true).
 *
 * ponytail: 띠는 오른쪽 아래 FAB 열 하나만 가리는데 스크롤은 줄의 어느 쪽 캐럿에서든 시작한다(왼쪽 캐럿도 띠 안이면
 * 한 번 올라온다). 캐럿의 가로 위치까지 보려면 handleScrollToSelection 으로 직접 계산해야 한다 — 지금은 단순함을 택한다.
 * 또 prosemirror 는 스크롤 가능한 **모든 조상**에 같은 문턱을 적용하지만, .mobile-app 은 overflow:hidden 에 높이가 꼭
 * 맞아 스크롤될 게 없다(조상 쪽 scrollTop 증가는 무시된다).
 */
const SIDE_MARGIN_PX = 5; // prosemirror 기본값 — top/left/right 는 그대로 둔다.
/** 띠 위로 항상 남겨 둘 영역 높이 — 본문 두 줄쯤(줄 높이 ≈ 28px). 영역이 이보다 낮으면 문턱을 0 으로 접는다. */
export const MIN_VISIBLE_ABOVE_PX = 64;

/** 스크롤 영역 높이(px)에 맞춰 줄인 FAB 띠 높이. 높이를 모르면(0·미측정) 전체 띠를 쓴다. */
export function clampClearance(scrollerHeight: number): number {
  if (!(scrollerHeight > 0)) return FAB_CLEARANCE_PX;
  return Math.max(0, Math.min(FAB_CLEARANCE_PX, Math.floor(scrollerHeight - MIN_VISIBLE_ABOVE_PX)));
}

export function useFabScrollMargin(editor: Editor | null, scroller?: HTMLElement | null): void {
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    // MobileNote 계열 테스트 몇 곳의 가짜 에디터 뷰는 setProps 가 없다.
    if (typeof editor.view?.setProps !== "function") return;

    let applied = -1;
    const apply = () => {
      if (editor.isDestroyed) return;
      const px = clampClearance(scroller?.clientHeight ?? 0);
      if (px === applied) return; // 키보드 애니메이션 동안 resize 가 쏟아져도 값이 같으면 건드리지 않는다
      applied = px;
      editor.view.setProps({
        scrollMargin: { top: SIDE_MARGIN_PX, right: SIDE_MARGIN_PX, bottom: px, left: SIDE_MARGIN_PX },
        scrollThreshold: { top: 0, right: 0, bottom: px, left: 0 },
      });
    };
    apply();

    if (!scroller || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(apply);
    ro.observe(scroller);
    return () => ro.disconnect();
  }, [editor, scroller]);
}
