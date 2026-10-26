/**
 * N1-2: BubbleMenu jitter fix.
 *
 * tiptap's BubbleMenuView recomputes its anchor rect from live DOM layout
 * (posToDOMRect / node.getBoundingClientRect) on every doc-changing transaction, not just
 * selection-changing ones — see BubbleMenuView.update in @tiptap/extension-bubble-menu, which
 * calls updatePosition() whenever `selectionChanged || docChanged`. Toggling bold/heading/
 * highlight while a selection is held changes font-weight/line-height/size, which shifts the
 * *pixel* rect by a few px even though the ProseMirror position (from,to) never moved — so the
 * menu visibly creeps and the next click lands on the wrong button (owner report: "굵게→제목1→
 * 제목2 연속으로 누르면 메뉴가 커서 밑에서 빠져나간다").
 *
 * Fix: cache the rect keyed by (from,to). A transaction that changes the document but not the
 * selection range reuses the last rect instead of asking the DOM again — the anchor only moves
 * when the user actually moves/extends the selection (or selects a different node). Wired into
 * BubbleMenu/ImageBubbleMenu via the `getReferencedVirtualElement` prop in EditorPanel.tsx.
 */
export type RectComputer = () => DOMRect;

/** Returns a memoizing accessor: `get(from, to, compute)` calls `compute()` only when (from,to)
 *  differs from the previous call, otherwise returns the cached rect unchanged. One instance
 *  per BubbleMenu (created once via useRef — see EditorPanel.tsx/ImageBubbleMenu). */
export function createStableRectAnchor(): (
  from: number,
  to: number,
  compute: RectComputer,
  /**
   * 호출자가 주는 "화면이 움직였는가" 지문. (from,to) 만으로 캐시하면 선택을 유지한 채
   * 스크롤할 때 프레임이 옛 화면 좌표에 얼어붙어, 글자는 흘러가고 메뉴만 제자리에 남는다.
   * 에디터는 창이 아니라 **안쪽 컨테이너**가 스크롤되므로 window.scrollY 로는 그 순간을
   * 잡을 수 없다 — EditorPanel 은 ProseMirror 콘텐츠 엘리먼트의 top 을 넘긴다(콘텐츠가
   * 컨테이너 안에서 밀려 올라가므로 스크롤에 따라 변한다). 서식 토글은 이 값을 바꾸지
   * 않으므로, 원래 막으려던 지터는 그대로 막힌다.
   */
  viewportEpoch?: number,
) => DOMRect {
  let lastFrom: number | null = null;
  let lastTo: number | null = null;
  let lastEpoch: number | undefined;
  let lastRect: DOMRect | null = null;
  return (from, to, compute, viewportEpoch) => {
    if (lastRect && from === lastFrom && to === lastTo && viewportEpoch === lastEpoch) return lastRect;
    lastFrom = from;
    lastTo = to;
    lastEpoch = viewportEpoch;
    lastRect = compute();
    return lastRect;
  };
}
