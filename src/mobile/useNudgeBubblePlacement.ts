import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { Editor } from "@tiptap/core";
import type { Transaction } from "@tiptap/pm/state";
import { reportFallback } from "../lib/diag";

/**
 * 문장 위 말풍선(MobileNudgeBubble)의 자리 계산 — 날짜·지역 제안이 감지된 문단의 첫 줄 위.
 *
 * 문서에는 아무것도 넣지 않는다(Decoration 없음). 에디터 밖의 오버레이라서 한글 IME 조합을 건드리지 않는다 —
 * 여기서 하는 일은 `view.coordsAtPos` 로 사각형을 **읽는** 것뿐이다.
 *
 * 두 조각이다: 순수 함수 `computeBubblePlacement`(표로 테스트한다)와, 사각형을 재서 그 함수에 넘기고
 * 스크롤·리사이즈·트랜잭션마다 다시 재는 훅 `useNudgeBubblePlacement`.
 *
 * 규칙(docs/mockups/2026-10-07-mobile-capture/README.md §10.2):
 *  - 문단 첫 줄 **위**, 글자 시작(왼쪽)에 맞춘다. 문단이 몇 줄이든 같다 — 타이핑하는 아래 줄을 가리지 않는다.
 *  - 위에 자리가 없으면(스크롤 영역 맨 위) 문단 **마지막 줄 아래**로 뒤집는다.
 *  - 문단 첫 줄이 스크롤로 보이는 영역 밖으로 나가면 숨긴다. 뒤집은 자리도 영역을 넘으면 숨긴다.
 *  - 가로는 영역 안에 16px 여백을 두고 가둔다.
 */

/** 버블 아랫면(꼬리 포함)과 글자 사이. 꼬리 6px + 숨 2px. */
export const BUBBLE_GAP_PX = 8;
/** 좌우 여백 — CSS `--m-gutter`(shell.css)와 같다. */
export const BUBBLE_GUTTER_PX = 16;

export interface LineRect {
  left: number;
  top: number;
  bottom: number;
}
export interface PlacementInput {
  /** 문단 첫 줄 (client 좌표) */
  first: LineRect;
  /** 문단 마지막 줄의 아랫변 (한 줄짜리면 first.bottom 과 같다) */
  lastBottom: number;
  /** 지금 보이는 스크롤 영역 (client 좌표) */
  view: { left: number; right: number; top: number; bottom: number };
  /** 버블 크기 */
  bubble: { width: number; height: number };
}
export interface PlacementResult {
  placement: "above" | "below" | "hidden";
  /** 버블 왼쪽 위 모서리 (입력과 같은 좌표계) */
  x: number;
  y: number;
}

export function computeBubblePlacement({ first, lastBottom, view, bubble }: PlacementInput): PlacementResult {
  const hidden: PlacementResult = { placement: "hidden", x: 0, y: 0 };
  // 첫 줄이 영역 밖(위로 스크롤돼 나갔거나 아래에 아직 안 들어왔다) — 숨긴다. 걸쳐 있으면(일부만 보이면) 아직 산다.
  if (first.bottom <= view.top || first.top >= view.bottom) return hidden;

  // 가로: 글자 시작에 맞추되 영역 안 16px 여백 안으로. 버블이 영역보다 넓으면 왼쪽 여백에 붙인다(CSS max-width 가 줄인다).
  const minX = view.left + BUBBLE_GUTTER_PX;
  const maxX = view.right - BUBBLE_GUTTER_PX - bubble.width;
  const x = maxX < minX ? minX : Math.min(Math.max(first.left, minX), maxX);

  const aboveY = first.top - BUBBLE_GAP_PX - bubble.height;
  if (aboveY >= view.top) return { placement: "above", x, y: aboveY };

  // 위에 자리가 없다 → 문단 마지막 줄 아래. 그것도 영역을 넘으면 숨긴다.
  const belowY = Math.max(lastBottom, first.bottom) + BUBBLE_GAP_PX;
  if (belowY + bubble.height <= view.bottom) return { placement: "below", x, y: belowY };
  return hidden;
}

/**
 * - above/below: 보인다. x,y 는 `.mobile-note-stage`(위치 기준) 안의 좌표다.
 * - hidden: 앵커 문단이 영역 밖이거나 문서가 달라졌다 — CSS 가 visibility:hidden 으로 감춘다.
 * - unmeasured: 잴 수 없다(에디터 뷰에 coordsAtPos 가 없다·영역이 레이아웃되지 않았다). 실제 앱에서는 첫 페인트 전에
 *   동기로 풀린다 — 가짜 에디터 테스트가 버튼을 그대로 누를 수 있게 DOM 에는 남겨 둔다.
 */
export type BubblePlacementState = "above" | "below" | "hidden" | "unmeasured";
export interface BubblePosition {
  placement: BubblePlacementState;
  x: number;
  y: number;
}
const UNMEASURED: BubblePosition = { placement: "unmeasured", x: 0, y: 0 };
const HIDDEN: BubblePosition = { placement: "hidden", x: 0, y: 0 };

const same = (a: BubblePosition, b: BubblePosition) => a.placement === b.placement && a.x === b.x && a.y === b.y;

interface MeasureArgs {
  editor: Editor;
  anchorPos: number;
  stage: HTMLElement;
  scroll: HTMLElement;
  bubble: HTMLElement;
  onFail: () => void;
}

/** 지금의 사각형들로 자리를 잰다. 사이드 이펙트 없음(읽기만). */
export function measureBubble({ editor, anchorPos, stage, scroll, bubble, onFail }: MeasureArgs): BubblePosition {
  if (editor.isDestroyed) return HIDDEN;
  let first;
  let last;
  try {
    const view = editor.view;
    // MobileNote 계열 테스트의 가짜 에디터 뷰는 coordsAtPos 가 없다 — 잴 수 없을 뿐 오류가 아니다.
    if (typeof view?.coordsAtPos !== "function") return UNMEASURED;
    const doc = editor.state.doc;
    // 문서가 줄어 앵커가 문서 밖이면(감지 뒤 다른 문단이 지워졌다) 이 제안은 낡았다. 다음 스캔이 정리한다.
    if (anchorPos < 0 || anchorPos > doc.content.size) return HIDDEN;
    const $anchor = doc.resolve(anchorPos);
    if (!$anchor.parent.isTextblock) return HIDDEN;
    first = view.coordsAtPos($anchor.start(), 1);
    last = view.coordsAtPos($anchor.end(), -1);
  } catch {
    onFail();
    return HIDDEN;
  }
  const sr = scroll.getBoundingClientRect();
  // 아직 레이아웃되지 않았다(display:none 조상·jsdom) — 숨기는 게 아니라 "모름".
  if (sr.width === 0 && sr.height === 0) return UNMEASURED;
  const stageR = stage.getBoundingClientRect();
  const br = bubble.getBoundingClientRect();
  // iOS 는 키보드가 레이아웃 뷰포트를 줄이지 않고 visualViewport 만 줄인다 — 키보드 밑으로 들어가면 안 보인다.
  const vv = typeof window !== "undefined" ? window.visualViewport : null;
  const bottom = vv ? Math.min(sr.bottom, vv.offsetTop + vv.height) : sr.bottom;
  const r = computeBubblePlacement({
    first: { left: first.left, top: first.top, bottom: first.bottom },
    lastBottom: last.bottom,
    view: { left: sr.left, right: sr.right, top: sr.top, bottom },
    bubble: { width: br.width, height: br.height },
  });
  if (r.placement === "hidden") return HIDDEN;
  return { placement: r.placement, x: Math.round(r.x - stageR.left), y: Math.round(r.y - stageR.top) };
}

interface Args {
  editor: Editor | null;
  /** 말풍선이 앉을 문단의 시작 위치(문서 위치). 없으면 잴 수 없다. */
  anchorPos: number | null;
  /**
   * 위치 기준 상자(.mobile-note-stage) — 반환 좌표의 원점. ref 객체가 아니라 **요소(상태)**다: 말풍선은 이 상자의 자식이라
   * 자식의 첫 레이아웃 이펙트가 부모 div 의 ref 연결보다 먼저 돌아 `ref.current` 가 null 이다. 콜백 ref 로 상태에 담으면
   * 연결 직후 페인트 전에 동기로 다시 그려 이펙트가 요소를 받는다.
   */
  stage: HTMLElement | null;
  /** 에디터를 담은 스크롤 영역(.mobile-note-body-wrap) — 보이는 범위와 스크롤 이벤트의 출처. */
  scroll: HTMLElement | null;
  bubbleRef: RefObject<HTMLElement | null>;
  /** 버블 내용이 바뀌면(크기가 바뀐다) 다시 재라는 신호. */
  contentKey: string;
}

/**
 * 첫 측정은 레이아웃 이펙트에서 동기로 한다(첫 페인트 전에 자리가 잡힌다). 이후 스크롤·리사이즈·visualViewport·
 * 에디터 트랜잭션(문서·선택 변화 둘 다)마다 rAF 로 한 프레임에 한 번만 다시 잰다.
 *
 * 앵커(`anchorPos`)는 감지 시점의 문서 위치다. 그 뒤 앞 문단에서 글을 치거나 지우면 문단이 밀리는데 제안은 다음 스캔(700ms)까지
 * 남는다 — 낡은 숫자를 그대로 쓰면 버블이 방금 고치고 있는 앞 문단 위로 뛴다. 그래서 **문서가 바뀌는 트랜잭션마다 매핑**한다
 * (`mapping.mapResult(pos, -1)`; 지워졌으면 -1 → 숨김). prop 이 새로 오면(새 스캔) 그 값이 새 기준이다.
 */
export function useNudgeBubblePlacement({ editor, anchorPos, stage, scroll, bubbleRef, contentKey }: Args): BubblePosition {
  const [pos, setPos] = useState<BubblePosition>(UNMEASURED);
  const reportedRef = useRef(false);
  // 감지 시점의 값(base)과, 그 뒤 트랜잭션 매핑을 따라간 현재 값(pos). contentKey 가 바뀌어(동작 하나가 닫혀) 이펙트가 다시
  // 돌아도 pos 를 되돌리지 않는다 — 기준(base = prop)이 바뀔 때만 다시 잡는다.
  const anchorRef = useRef<{ editor: Editor | null; base: number | null; pos: number | null }>({ editor: null, base: null, pos: null });

  useLayoutEffect(() => {
    const bubble = bubbleRef.current;
    if (!editor || anchorPos === null || !stage || !scroll || !bubble) {
      setPos((p) => (same(p, UNMEASURED) ? p : UNMEASURED));
      return;
    }
    if (anchorRef.current.editor !== editor || anchorRef.current.base !== anchorPos) {
      anchorRef.current = { editor, base: anchorPos, pos: anchorPos };
    }
    const anchor = anchorRef.current;
    // 스크롤마다 같은 실패가 쏟아져도 기록은 한 번만.
    const onFail = () => {
      if (reportedRef.current) return;
      reportedRef.current = true;
      reportFallback("mobile-nudge-bubble", "coords_failed");
    };
    const run = () => {
      const next = measureBubble({ editor, anchorPos: anchor.pos ?? -1, stage, scroll, bubble, onFail });
      setPos((p) => (same(p, next) ? p : next));
    };
    run();

    let raf = 0;
    const raf1 = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (cb: FrameRequestCallback) => window.setTimeout(() => cb(0), 16);
    const caf = typeof cancelAnimationFrame === "function" ? cancelAnimationFrame : (id: number) => window.clearTimeout(id);
    const schedule = () => {
      if (raf) return;
      raf = raf1(() => {
        raf = 0;
        run();
      }) as unknown as number;
    };

    scroll.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    const vv = window.visualViewport;
    vv?.addEventListener("resize", schedule);
    vv?.addEventListener("scroll", schedule);
    const onTransaction = ({ transaction }: { transaction: Transaction }) => {
      if (transaction.docChanged && anchor.pos !== null && anchor.pos >= 0) {
        const mapped = transaction.mapping.mapResult(anchor.pos, -1);
        anchor.pos = mapped.deleted ? -1 : mapped.pos;
      }
      schedule();
    };
    editor.on("transaction", onTransaction);
    // 칩 줄이 생기고 사라지거나 키보드가 열리면 스크롤 영역 크기가 바뀐다(window resize 가 없는 경우도 있다).
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null;
    ro?.observe(scroll);
    ro?.observe(bubble);

    return () => {
      if (raf) caf(raf);
      raf = 0;
      scroll.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      vv?.removeEventListener("resize", schedule);
      vv?.removeEventListener("scroll", schedule);
      editor.off("transaction", onTransaction);
      ro?.disconnect();
    };
  }, [editor, anchorPos, contentKey, stage, scroll, bubbleRef]);

  return pos;
}
