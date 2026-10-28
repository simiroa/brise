/* --sidebar-pad(tokens.css:75 = --space-6 = 14px)의 사본이다. 행의 좌우 여백은 CSS 가 그리고
   타일 한 변은 여기서 계산하므로 두 값이 어긋나면 타일이 행을 넘치거나 남긴다. react-window 는
   행 높이를 숫자로 요구하는데 CSS 변수는 런타임에 읽어야 해서 지금은 사본을 둔다 —
   --sidebar-pad 를 바꾸면 이 숫자도 같이 바꿀 것. */
export const GALLERY_SIDEBAR_PAD = 14;
export const GALLERY_GAP = 6;
/** 기본 사이드바 폭(≈308px)에서 나오는 열 수 — 넓히면 늘고 좁히면 줄어든다(아래 MIN_TILE). */
export const GALLERY_COLS = 4;
/** 열 수의 바닥. 이보다 적으면 갤러리가 아니라 목록이 된다. */
export const GALLERY_MIN_COLS = 3;
/** 타일 한 변의 최소치. 56 이면 4열 띠가 약 278~339px 로, 기본 사이드바 폭(≈308)이 띠 한가운데에 놓인다 —
 *  경계에 걸쳐 두면 사이드바를 몇 px 만 줄여도 4↔3 열이 깜빡인다. */
export const GALLERY_MIN_TILE = 56;

/** 폭 기반 열 수: 타일이 GALLERY_MIN_TILE 아래로 내려가지 않는 한 최대한 많이(바닥 GALLERY_MIN_COLS).
 *  폭을 아직 모르면(0) 기본 4열. */
export function galleryColumnCount(listWidth: number, size: "small" | "medium" | "large" = "medium"): number {
  const base = (() => {
    if (!(listWidth > 0)) return GALLERY_COLS;
    const net = listWidth - 2 * GALLERY_SIDEBAR_PAD;
    const fit = Math.floor((net + GALLERY_GAP) / (GALLERY_MIN_TILE + GALLERY_GAP));
    return Math.max(GALLERY_MIN_COLS, fit);
  })();
  // 설정 › 첨부파일의 타일 크기: 작게 = 한 열 더, 크게 = 한 열 덜(바닥 2열). 보통은 위 폭 기반 값 그대로.
  if (size === "small") return base + 1;
  if (size === "large") return Math.max(2, base - 1);
  return base;
}

/** Tile width calculated from container width minus sidebar padding and column gaps. */
export function galleryTileWidth(listWidth: number, cols = galleryColumnCount(listWidth)): number {
  if (listWidth <= 0) return 0;
  const netWidth = listWidth - 2 * GALLERY_SIDEBAR_PAD - (cols - 1) * GALLERY_GAP;
  return Math.max(0, netWidth / cols);
}

/** Row height for react-window: square tile height + vertical row gap. */
export function galleryRowHeight(listWidth: number, cols = galleryColumnCount(listWidth)): number {
  const tileWidth = galleryTileWidth(listWidth, cols);
  return tileWidth + GALLERY_GAP;
}

/** Pack flat item indices into rows of `cols` columns. */
export function packGalleryRows<T>(items: T[], cols: number): T[][] {
  const c = Math.max(1, cols);
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += c) {
    rows.push(items.slice(i, i + c));
  }
  return rows;
}

