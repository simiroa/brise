// 애니메이션 아이콘의 hover 트리거 — 아이콘 자신이 아니라 그 아이콘이 든 "눌리는 요소"(버튼·링크·
// 메뉴 행·탭·트리 행)에 마우스가 올라갈 때 움직인다. 30px 버튼의 여백이나 폭이 넓은 메뉴 행 어디에
// 올려도 같은 줄의 아이콘이 모두 똑같이 반응해야 해서다(아이콘 div 에 onMouseEnter 를 다는 원본
// 방식은 아이콘 픽셀 위에서만 발동 → 같은 줄에서 어떤 건 움직이고 어떤 건 안 움직이는 문제).
// 아이콘마다 리스너를 달지 않고 document 에 위임 리스너를 **하나만** 둔다 — 목록에 아이콘이 수백
// 개여도 리스너·이펙트 비용이 늘지 않는다. tokens.css 의 "아이콘 hover 반응" 블록과 같은 대상 목록을
// 써야 한다(CSS 는 data-anim 이 없는 아이콘만, 여기는 data-anim 아이콘만 맡는다).
export interface HoverHandle {
  start: () => void;
  stop: () => void;
}

const HOST_SELECTOR =
  'button, a[href], [role="button"], [role="menuitem"], [role="tab"], summary, .menu-row, .treerow';
const OFF_SELECTOR = ':disabled, [aria-disabled="true"], .icon-btn--static, .no-icon-hover';

const handles = new Map<SVGSVGElement, HoverHandle>();
let current: Element | null = null;
let installed = false;

function canHover(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' && // jsdom 등 matchMedia 없는 환경은 애니메이션 없이 정적 아이콘
    window.matchMedia('(hover: hover)').matches &&
    !window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

function each(host: Element, fn: (h: HoverHandle) => void) {
  for (const svg of host.querySelectorAll<SVGSVGElement>('svg[data-anim]')) {
    const h = handles.get(svg);
    if (h) fn(h);
  }
}

function onOver(e: MouseEvent) {
  const target = e.target;
  const host = target instanceof Element ? target.closest(HOST_SELECTOR) : null;
  if (host === current) return;
  if (current) each(current, (h) => h.stop());
  current = host && !host.closest(OFF_SELECTOR) ? host : null;
  if (current) each(current, (h) => h.start());
}

function onLeaveWindow() {
  if (current) each(current, (h) => h.stop());
  current = null;
}

export function registerHoverIcon(svg: SVGSVGElement, handle: HoverHandle): () => void {
  if (!installed && canHover()) {
    installed = true;
    document.addEventListener('mouseover', onOver, { passive: true });
    document.documentElement.addEventListener('mouseleave', onLeaveWindow);
  }
  handles.set(svg, handle);
  return () => {
    handles.delete(svg);
  };
}
