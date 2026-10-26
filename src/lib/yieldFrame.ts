/** 무거운 동기 작업 사이에 화면이 그려질 한 프레임을 내준다(진행 표시가 보이게).
 *  숨은 창은 rAF 가 안 오므로 타이머로 상한을 둔다. */
export function yieldFrame(): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 80);
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => {
        clearTimeout(timer);
        resolve();
      });
    }
  });
}
