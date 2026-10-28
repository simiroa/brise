/**
 * 전역 툴팁 — 앱 전체의 `title="…"` 을 한 군데에서 같은 모양·같은 애니메이션으로 그린다(오너 2026-10-27:
 * "툴팁 스타일이 각자 중구난방, 마우스가 올라가면 스르륵 나오고 예쁘게 가독성 있게").
 *
 * 왜 위임(delegation)인가: `title=` 이 262개 파일 645곳이다. 파일마다 컴포넌트로 바꾸면 한 번에 못 끝나고,
 * 새로 쓰는 코드는 또 `title` 로 돌아간다. 그래서 `title` 을 그대로 쓰게 두고 호버 순간에만 가로챈다:
 * 올라가면 속성을 떼서(→ OS 기본 툴팁이 못 뜬다) 우리 말풍선에 보여 주고, 벗어나면 도로 붙인다.
 * 평소엔 `title` 이 그대로 있어 접근성 이름·`getByTitle` 테스트가 변하지 않는다.
 *
 * 말풍선은 불투명 `.overlay` 표면 + `.tip`(tokens.css). 투명 창이라 backdrop-filter 는 안 그려져서 안 쓴다.
 * 지연: 처음 400ms, 막 다른 툴팁을 보다 옮겨 간 경우(WARM_MS 안)는 즉시 — 툴바를 훑을 때 끊기지 않게.
 * ponytail: 칩/버튼 안쪽 자식(SVG 등)에서 시작된 호버는 closest("[title]") 로 올라가 잡는다. 이미 앵커 안에
 * 있는 호버(앵커 안 자식 사이 이동)는 앵커를 그대로 유지한다 — title 을 뗀 뒤라 closest 가 앵커를 못 찾기
 * 때문이다. 단 앵커 안쪽에 자기 title 을 가진 후손이 있어도 앵커가 살아 있는 동안은 그 후손을 따로 가로채지
 * 않는다. 호버 중 화면이 바뀌어 앵커가 사라지면 다음 mouseover/스크롤/키 입력에서 정리된다(별도 MutationObserver 는 두지 않았다).
 */
const SHOW_DELAY_MS = 400;
const WARM_MS = 300;
const GAP = 6;
const MARGIN = 8;

const installed = new WeakSet<Document>();

export function installTooltips(doc: Document = document): void {
  if (installed.has(doc)) return;
  installed.add(doc);

  let anchor: HTMLElement | null = null;
  let saved = "";
  let tip: HTMLDivElement | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let hiddenAt = 0;

  const restoreTitle = () => {
    // 호버 중 React 가 새 title 을 이미 썼다면 덮어쓰지 않는다.
    if (anchor && saved && !anchor.hasAttribute("title")) anchor.setAttribute("title", saved);
  };

  const hide = () => {
    clearTimeout(timer);
    if (tip) {
      tip.remove();
      tip = null;
      hiddenAt = Date.now();
    }
    restoreTitle();
    anchor = null;
    saved = "";
  };

  const place = (el: HTMLElement, t: HTMLDivElement) => {
    const r = el.getBoundingClientRect();
    const w = t.offsetWidth;
    const h = t.offsetHeight;
    const left = Math.min(Math.max(r.left + r.width / 2 - w / 2, MARGIN), Math.max(MARGIN, window.innerWidth - w - MARGIN));
    let top = r.bottom + GAP;
    let above = false;
    if (top + h > window.innerHeight - MARGIN) {
      top = Math.max(MARGIN, r.top - h - GAP);
      above = true;
    }
    t.style.left = `${left}px`;
    t.style.top = `${top}px`;
    t.dataset.side = above ? "above" : "below";
  };

  const show = (el: HTMLElement, text: string) => {
    if (!el.isConnected) return;
    const t = doc.createElement("div");
    t.className = "overlay tip";
    t.setAttribute("role", "tooltip");
    t.textContent = text;
    // 측정하려면 DOM 에 있어야 한다 — 숨긴 채 붙이고 자리를 잡은 뒤 보인다(위치 깜빡임 방지).
    t.style.visibility = "hidden";
    doc.body.appendChild(t);
    place(el, t);
    t.style.visibility = "";
    tip = t;
  };

  doc.addEventListener(
    "mouseover",
    (e) => {
      const target = e.target as Element | null;
      // 호버 중엔 앵커의 title 을 뗐으므로 포인터가 앵커 안쪽 자식(SVG 등)으로 옮겨 가도 closest("[title]") 는
      // 앵커를 못 찾는다 — 그대로 두면 hide() 가 title 을 돌려 OS 기본 툴팁이 뜬다. 앵커 안이면 아무것도 하지 않는다.
      if (anchor && target && anchor.contains(target)) return;
      const el = target?.closest?.("[title]") as HTMLElement | null;
      hide();
      const text = el?.getAttribute("title")?.trim();
      if (!el || !text) return;
      anchor = el;
      saved = el.getAttribute("title") ?? "";
      el.removeAttribute("title");
      const warm = Date.now() - hiddenAt < WARM_MS;
      if (warm) show(el, text);
      else timer = setTimeout(() => show(el, text), SHOW_DELAY_MS);
    },
    true,
  );
  // 앵커 밖으로 나갔을 때(문서를 떠날 때 포함) — relatedTarget 이 앵커 안이면 그대로 둔다.
  doc.addEventListener(
    "mouseout",
    (e) => {
      if (!anchor) return;
      const to = (e as MouseEvent).relatedTarget as Node | null;
      if (to && anchor.contains(to)) return;
      hide();
    },
    true,
  );
  // 누르기·스크롤·키 입력은 "이제 읽을 때가 아니다" 신호.
  for (const type of ["mousedown", "wheel", "keydown", "scroll", "blur"]) {
    doc.addEventListener(type, hide, true);
  }
}
