/**
 * 길게 누르기(long-press) 감지 — 한 벌만 둔다.
 *
 * 원래는 `leftpanel/NoteIconControl.tsx` 안에만 있었는데(아이콘 픽커 열기), W7-g 에서 모바일
 * 노트 카드가 같은 제스처로 다중선택에 진입하게 되면서 두 번째 사용처가 생겼다 — 두 벌을 두는
 * 대신 여기로 끌어냈다.
 *
 * 훅이 아니라 모듈 함수인 이유: 호출부 중 일부(react-window 가 인스턴스를 재활용하는 트리 행
 * 계열)는 훅을 쓸 수 없고, 상태가 진짜로 전역적이기 때문이다 —
 * ponytail: 포인터는 한 번에 하나만 눌려 있다고 가정한다(두 손가락으로 서로 다른 요소를 동시에
 * 길게 누르는 UI 는 이 앱에 없다). 천장: 동시 롱프레스 불가. 필요해지면 pointerId 로 맵을 나눈다.
 *
 * 중첩 요소(행 안의 아이콘)에서 둘 다 begin 을 부르면 **먼저 부른 쪽이 이긴다**. 포인터 이벤트는
 * 타깃에서 위로 버블하므로 안쪽 요소가 먼저 부르고, 바깥쪽의 호출은 무시된다 — 아이콘을 길게
 * 눌렀는데 행의 롱프레스까지 같이 발동하는 사고를 이 규칙 하나로 막는다.
 */

const HOLD_MS = 400;

let timer: number | null = null;
let armed = false;
let fired = false;
let startX: number | null = null;
let startY: number | null = null;

/** 손가락 떨림 허용 반경(CSS px). 이 안의 움직임은 롱프레스를 취소하지 않는다(V12). */
const SLOP_PX = 10;

export function beginLongPress(
  onFire: () => void,
  ms: number = HOLD_MS,
  startEvent?: { clientX: number; clientY: number },
): void {
  if (armed) return; // 이 제스처의 주인은 이미 정해졌다(안쪽 요소가 선점)
  armed = true;
  fired = false;
  startX = startEvent ? startEvent.clientX : null;
  startY = startEvent ? startEvent.clientY : null;
  timer = window.setTimeout(() => {
    timer = null;
    fired = true;
    // 발동 시점엔 armed 도 같이 내린다 — "안쪽이 이긴다" 규칙은 begin 호출들이 같은 포인터
    // 이벤트 안에서 동기적으로 버블할 때만 의미가 있고(inner begin → armed=true → outer begin
    // 은 즉시 리턴), 그 경합은 이 타이머가 돌기 훨씬 전에 이미 끝나 있다. armed 를 계속 true
    // 로 남겨두면 pointerup/pointercancel 이 끝내 안 오는 경우(브라우저가 제스처를 스크롤이나
    // 자체 롱프레스 메뉴로 가져간 케이스) 다음 롱프레스가 영구히 무시된다 — 발동 자체를
    // "이 제스처는 끝났다"는 신호로 삼아 스스로 회복시킨다.
    armed = false;
    suppressNativeLongPress();
    onFire();
  }, ms);
}

/**
 * 발동 뒤에도 손가락은 아직 눌려 있다. 터치 브라우저(Android WebView)는 그 같은 누름을 자기
 * 롱프레스로 이어받아, 방금 onFire 가 띄운 대화창의 글자(손가락 아래 놓인 "취소"·제목 등)를
 * 선택하고 "번역·복사·모두 선택·공유" 툴바를 그 위에 얹는다(레드팀 V4, 2026-10-05). 요소마다
 * user-select 로 막으면 새로 뜨는 요소가 무엇이냐에 따라 계속 샌다 — 그래서 이 제스처가 끝날
 * 때까지 문서 전체에서 선택 시작·컨텍스트 메뉴만 막는다. 손을 떼면(또는 안전 시한 뒤) 해제.
 */
function suppressNativeLongPress(): void {
  if (typeof document === "undefined") return;
  const block = (e: Event) => e.preventDefault();
  const release = () => {
    window.clearTimeout(safety);
    document.removeEventListener("selectstart", block, true);
    document.removeEventListener("contextmenu", block, true);
    document.removeEventListener("pointerup", release, true);
    document.removeEventListener("pointercancel", release, true);
    document.removeEventListener("touchend", release, true);
    // 막기 전에 이미 잡힌 선택이 있으면 지운다(입력칸 안 선택은 건드리지 않는다).
    const sel = document.getSelection?.();
    const a = sel?.anchorNode?.parentElement;
    if (sel && !sel.isCollapsed && !a?.closest("input, textarea, [contenteditable='true']")) {
      sel.removeAllRanges();
    }
  };
  const safety = window.setTimeout(release, 3000);
  document.addEventListener("selectstart", block, true);
  document.addEventListener("contextmenu", block, true);
  document.addEventListener("pointerup", release, true);
  document.addEventListener("pointercancel", release, true);
  document.addEventListener("touchend", release, true);
}

export function cancelLongPress(): void {
  if (timer !== null) {
    window.clearTimeout(timer);
    timer = null;
  }
  armed = false;
  startX = null;
  startY = null;
}

/**
 * pointermove 용 — 시작점에서 SLOP_PX 넘게 벗어났을 때만 취소한다. `beginLongPress` 에 시작
 * 이벤트를 넘기지 않았으면(옛 호출부) 예전처럼 어떤 움직임이든 취소한다.
 */
export function moveLongPress(e: { clientX: number; clientY: number }): void {
  if (startX === null || startY === null) {
    cancelLongPress();
    return;
  }
  if (Math.hypot(e.clientX - startX, e.clientY - startY) > SLOP_PX) cancelLongPress();
}

/**
 * 롱프레스가 방금 발동했으면 true 를 **한 번만** 돌려준다. 이어서 날아오는 click 을 삼켜
 * "길게 눌렀는데 노트가 열려버리는" 동작을 막는 용도.
 */
export function consumeLongPress(): boolean {
  const was = fired;
  fired = false;
  return was;
}
