import { flushSync } from "react-dom";

type VT = { skipTransition(): void; finished?: Promise<unknown> };
type DocWithVT = Document & { startViewTransition?: (cb: () => void) => VT };

let running: VT | null = null;

/**
 * React 상태 갱신을 View Transition 안에서 실행해 요소가 부드럽게 재배치되게 한다.
 * 미지원·reduced-motion 이면 그냥 동기 실행. 전환 중 또 불리면 이전 전환을 건너뛰고 최신으로.
 * 전환 시작이 던져도 update 는 반드시 실행된다(상태 갱신이 애니메이션에 의존하지 않는다).
 */
export function withViewTransition(update: () => void): void {
  const doc = typeof document === "undefined" ? null : (document as DocWithVT);
  const reduced = typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  if (!doc || typeof doc.startViewTransition !== "function" || reduced) {
    update();
    return;
  }
  try {
    running?.skipTransition();
  } catch {
    // silent-ok: 이미 끝난 전환을 건너뛰려는 시도
  }
  let started: VT;
  try {
    started = doc.startViewTransition(() => flushSync(update));
  } catch {
    running = null;
    update();
    return;
  }
  running = started;
  // 건너뜀·중단은 정상 경로라 rejection 만 삼킨다(상태는 이미 갱신됨).
  void Promise.resolve(started.finished)
    .catch(() => {}) // silent-ok: skipTransition/중단은 의도된 거절
    .finally(() => {
      if (running === started) running = null;
    });
}
