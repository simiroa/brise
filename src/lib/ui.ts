import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { pushOverlay, dismissTopOverlay } from "./overlayStack";

export function clamp(v: number, a: number, b: number) {
  return Math.max(a, Math.min(b, v));
}

/** KB/MB/GB byte-size label (no B tier — used for DB/backup/attachment totals, not per-file
 *  displays that care about very small sizes). Shared by DataManagementSection,
 *  BackupNudgeBanner, and PetAssetGrid (Wave R1-b dedup — was a byte-identical copy in each).
 *  Per-file / per-attachment labels use `formatFileSize`. */
export function formatSize(bytes: number): string {
  if (bytes === 0) return "0 KB";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** Per-file / per-attachment byte-size label (B/KB/MB). `formatSize` is the DB/backup total
 *  (no B tier). `emptyLabel` lets Mobile keep "" for null without a second function. */
export function formatFileSize(bytes: number | null, emptyLabel = "—"): string {
  if (bytes == null) return emptyLabel;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Sole consumer is WeatherVignette.tsx (its decorative scene animations have a real JS branch,
 *  not just a CSS transition, so — unlike AttachmentsBar's hover-frame, folded into a tokens.css
 *  media query instead — this needs the live boolean). Wave R1-b dedup: was duplicated verbatim
 *  in both files; AttachmentsBar no longer needs it at all. */
export function usePrefersReducedMotion(): boolean {
  return useMediaQuery("(prefers-reduced-motion: reduce)");
}

/**
 * Live boolean for any CSS media query. Prefer a CSS `@media`/`@container` rule whenever the
 * response is purely visual — this exists for the cases with a real JS branch (a decorative
 * animation loop, a layout decision React owns like App.tsx's narrow-window sidebar).
 *
 * matchMedia?. — jsdom 에는 matchMedia 가 아예 없다. 호출부마다 스텁을 심는 대신(테스트 3곳이
 * 이미 그렇게 하고 있었다) 여기서 한 번 없음을 "매치 안 함"으로 처리한다. mobile/MobileApp.tsx
 * 도 같은 옵셔널 호출 규약을 쓴다.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof window !== "undefined" && (window.matchMedia?.(query).matches ?? false),
  );
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    setMatches(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

/**
 * 창이 좁아 사이드바(324px 기본)와 본문이 함께 서기 어려운 구간. 창 자체의 하한은
 * tauri.conf.json 의 minWidth(900) 가 잡고, 그 위 구간에서 먼저 사이드바를 접어 본문 폭을
 * 돌려주는 게 이 값이다 — 900 에서는 이미 접혀 있어야 하므로 그보다 넉넉히 위에 둔다.
 */
export const NARROW_WINDOW_QUERY = "(max-width: 1100px)";

/**
 * 다음 단계 — 사이드바가 이미 접힌 뒤에도 창이 더 좁아지면(하한 900 쪽으로) 어시스트(SourcePanel)
 * 패널도 접어 에디터에 폭을 돌려준다. 사이드바와 달리 되돌리지 않는다 — 창을 다시 넓혀도 자동으로
 * 펴지지 않고, 접힘은 previewCollapsed(비영속) 를 직접 세팅하는 일회성 전이다(App.tsx).
 */
export const ASSIST_COLLAPSE_QUERY = "(max-width: 950px)";

/**
 * Flips a popup/menu to open toward whichever side has room, given its *real* measured size
 * (width/height) instead of a guessed constant — a hardcoded size clips or misplaces the menu
 * whenever the actual content differs (long titles, i18n string length, item count). `altY`
 * is the anchor to flip *up* from when the popup doesn't open flush against the cursor on the
 * Y axis (e.g. suggestionPopup opens a few px below a text caret; flipping up should still hug
 * the caret, not the point 6px below it). Defaults to `y`.
 */
export function flipMenuPos(
  x: number,
  y: number,
  width: number,
  height: number,
  margin = 8,
  altY: number = y
): { x: number; y: number } {
  const fx = x + width > window.innerWidth - margin ? Math.max(margin, x - width) : x;
  const overflowsBelow = y + height > window.innerHeight - margin;
  const fy = overflowsBelow ? Math.max(margin, altY - height) : y;
  return { x: fx, y: fy };
}

/** 포털 목적지 — 열려 있는 모달 안이면 그 모달의 스크림, 아니면 body.
 *  2026-08-14: ModalShell 이 <dialog>.showModal() 을 버리고 일반 레이어 스크림(.modal-scrim,
 *  z-index --z-modal)으로 내려왔다. body 로 포털한 드롭다운은 --z-dropdown(20) 이라 스크림(80)
 *  뒤에 깔리고, 모달 바깥은 열려 있는 동안 inert 라 클릭도 안 먹는다. 스크림의 자식으로 넣으면
 *  같은 스택 안에서 카드보다 뒤(=위)에 그려지고 inert 밖이다. position:fixed 좌표는 그대로
 *  유효하다 — 스크림에 transform/filter 가 없어 containing block 이 되지 않는다. */
export function popoverRoot(anchor: Element | null | undefined): HTMLElement {
  return (anchor?.closest(".modal-scrim") as HTMLElement | null) ?? document.body;
}

/**
 * React-side companion to flipMenuPos: renders the menu at the raw anchor point first, measures
 * its real size once mounted (useLayoutEffect runs before paint, so there's no flash), then
 * flips into view if it would overflow. Shared by ContextMenu, TabBar's tab menu, and
 * EditorPanel's selCtx/sectionCtx menus so positioning logic lives in exactly one place.
 */
export function useMenuPos(anchor: { x: number; y: number } | null | undefined) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const ax = anchor?.x;
  const ay = anchor?.y;

  useLayoutEffect(() => {
    if (ax == null || ay == null || !ref.current) {
      setPos(null);
      return;
    }
    const update = () => {
      if (!ref.current) return;
      const { width, height } = ref.current.getBoundingClientRect();
      setPos(flipMenuPos(ax, ay, width, height));
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [ax, ay]);

  return { ref, x: pos?.x ?? ax ?? 0, y: pos?.y ?? ay ?? 0 };
}

/**
 * Shared click-outside + Escape dismiss effect — factored out of useFloatingPopover so the many
 * components that only need "close when the user clicks elsewhere or hits Escape" (no floating
 * position math) don't hand-roll the same mousedown/keydown pair (Wave R1-b dedup; 14 call sites
 * are listed in docs/PLAN-refactor-2026-08-04.md).
 *
 * `active` gates subscription exactly like each call site's own `if (!open) return` used to —
 * kept as a plain boolean (not derived internally) so callers whose "open" isn't a simple state
 * flag (e.g. MapPlaceSearch, which never gates at all) can still opt in or stay always-on.
 * `refs` are the elements a click INSIDE which should NOT close (trigger button, popover surface,
 * …) — pass `[]` for sites that close unconditionally on any outside mousedown (GalleryExpanded's
 * LocalContextMenu, TitleBar's "..." menu). `onClose`/`onEscape` are read through a ref each render
 * so the effect only resubscribes when `active` (or `escape`) flips — matching the original
 * per-site effects, which all depended on `[open]` alone and never resubscribed on every render.
 * `onEscape` receives the raw keydown so a caller can `preventDefault()` it (WidgetConfigPopover:
 * Escape must cancel a transient config dialog without committing a half-edited value).
 */
export function useDismiss(
  active: boolean,
  refs: Array<RefObject<Element | null>>,
  onClose: () => void,
  opts?: { onEscape?: (e: KeyboardEvent) => void; escape?: boolean },
) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const escapeRef = useRef<(e: KeyboardEvent) => void>(opts?.onEscape ?? onClose);
  escapeRef.current = opts?.onEscape ?? onClose;
  const escapeEnabled = opts?.escape !== false;

  useEffect(() => {
    if (!active) return;
    const onDown = (e: MouseEvent) => {
      const tgt = e.target as Node;
      if (refs.some((r) => r.current?.contains(tgt))) return;
      closeRef.current();
    };
    // window, not document: a handful of the original per-site effects listened on window
    // specifically (and tests fire synthetic events straight at window), and every real bubbling
    // mousedown/keydown reaches window regardless, so this is a strict superset.
    window.addEventListener("mousedown", onDown);

    let removeOverlay: (() => void) | undefined;
    if (escapeEnabled) {
      removeOverlay = pushOverlay(() => {
        // dummy event to satisfy signature (we already prevent default in the global listener)
        escapeRef.current(new KeyboardEvent("keydown", { key: "Escape" }));
      });
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) {
        if (dismissTopOverlay()) {
          e.preventDefault();
        }
      }
    };
    if (escapeEnabled) window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      if (escapeEnabled) {
        window.removeEventListener("keydown", onKey);
        removeOverlay?.();
      }
    };
    // refs/onClose/onEscape read via closure+ref above — only active/escapeEnabled toggling
    // should resubscribe (same shape as each original hand-rolled effect's `[open]` deps).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, escapeEnabled]);
}

/**
 * Shared floating mechanics for LinkButton/ColorButton's popovers (buttons.tsx).
 *
 * Both popovers used to render as a plain `position: absolute` div inside their own trigger
 * wrapper. That's harmless when the toolbar sits directly on the page, but both LinkButton and
 * ColorButton are also mounted inside the selection BubbleMenu (TextBubbleMenu.tsx) — a
 * `.overlay` element — and `.overlay` sets `overflow: hidden` (tokens.css, SINGLE-SHEET ACRYLIC
 * CONTRACT). The fixed top toolbar row clips the same way (its `overflow-x: auto` computes
 * `overflow-y` to `auto` too). Either ancestor clips the popover to zero visible/clickable area
 * the moment it extends past its parent's box — the link input and color swatches were
 * rendering, just invisible and un-clickable, which is why picking a color silently did nothing.
 *
 * Portalling to <body> with `position: fixed` escapes every clipping ancestor — the same
 * pattern EmojiPicker.tsx already uses next to these two buttons (see also ContextMenu.tsx,
 * the diagram bubbles, and tokens.css's ".scroll(overflow:auto)" comment for the same fix
 * applied elsewhere in this codebase). useMenuPos supplies the same flip-into-view
 * measurement the app's other floating menus already share instead of a third copy of it.
 */
export function useFloatingPopover<T extends HTMLElement = HTMLDivElement>(open: boolean, onClose: () => void) {
  const anchorRef = useRef<T>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);

  const measure = useCallback(() => {
    if (!anchorRef.current) return;
    const r = anchorRef.current.getBoundingClientRect();
    setAnchor({ x: r.left, y: r.bottom + 6 });
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setAnchor(null);
      return;
    }
    measure();
  }, [open, measure]);

  // N1-3 (owner QA 6, item 1): this popover's trigger button can itself be inside a scrolling
  // ancestor — the selection BubbleMenu (TextBubbleMenu.tsx), which now tracks scroll via
  // options.scrollTarget, or the fixed toolbar row's own overflow-x scrollbar. Recomputing once at
  // `open` time (the old behavior) left the popover stuck at its opening screen position while its
  // own anchor button scrolled away underneath. `capture: true` on `document` catches every
  // nested scroll container's `scroll` event even though `scroll` itself doesn't bubble — the
  // standard technique for "listen to scroll anywhere in the tree" without knowing which ancestor
  // scrolls (see stableAnchor.ts's viewportEpoch comment for the same underlying constraint).
  useEffect(() => {
    if (!open) return;
    document.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      document.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [open, measure]);

  const { ref: popRef, x, y } = useMenuPos(anchor);

  useDismiss(open, [popRef, anchorRef], onClose);

  return { anchorRef, popRef, x, y };
}

/**
 * Wave 11: derive a theme-legible CSS color from a folder's stored `color_hue` (0..359, free
 * slider — owner decision, not a fixed palette). We deliberately do NOT store a hex: a single
 * fixed color always goes invisible on one of the two surfaces (light hanji vs. near-black
 * dark). Saturation is fixed; only lightness differs per theme, and CSS `light-dark()` — not a
 * new tokens.css variable — picks the right one. This works because tokens.css already flips
 * the inherited `color-scheme` property (dark at :root, light at :root[data-theme='light']),
 * which is exactly what `light-dark()` reads to choose its first vs. second argument. Shared
 * here so both the color picker (ContextMenu.tsx) and the folder row painter (NoteTree.tsx,
 * owned by another agent) derive the identical color from the same hue.
 */
export function folderColorCss(hue: number): string {
  return `light-dark(hsl(${hue} 55% 38%), hsl(${hue} 60% 62%))`;
}

/** Folder / tag color-preset hues. One list so the tree popover and TagColorDialog stay in lockstep. */
export const FOLDER_PRESET_HUES = [0, 45, 90, 140, 190, 240, 280, 320] as const;

/** Tiptap HTML → 평문 스니펫. GraphTab(관계도 탭)에 있었으나 그 파일이 @xyflow/react 를 정적
 *  임포트해서, HomeMapPane 같은 가벼운 소비자가 이 함수 하나 때문에 137KB xyflow 청크를 같이
 *  받아버렸다(HomeTab 의 lazy() 무효화). 의존성 없는 순수 함수라 공용 ui.ts 로 이전 — 다시
 *  GraphTab 으로 되돌리면 누수가 재발한다. */
export function snippetText(html: string): string {
  if (typeof DOMParser !== "undefined") {
    const spaced = html.replace(/<\/(p|div|li|h[1-6])>/gi, " ");
    return new DOMParser().parseFromString(spaced, "text/html").body.textContent?.replace(/\s+/g, " ").trim() ?? "";
  }
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

