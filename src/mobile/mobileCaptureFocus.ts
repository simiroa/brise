/**
 * O-1(오너 2026-10-10): ＋(MobileApp::enterCapture)로 연 **빈 초안**만 키보드를 올린다. 가져온 초안·기존 노트·인터스티셜 뒤 새 노트는 안 올린다.
 * 요청은 화면 전환 직전에 걸고, 입력 화면의 에디터(useMobileBodyEditor)가 칠한 직후 한 번 가져간다. 걸어 둔 채 다른 길로 가면
 * (가져오기·노트 열기) 호출자가 `cancelCaptureFocus` 로 푼다 — 묵은 요청이 엉뚱한 화면에서 터지지 않게.
 */
let requested = false;

export const requestCaptureFocus = (): void => {
  requested = true;
};
export const cancelCaptureFocus = (): void => {
  requested = false;
};
export const hasCaptureFocusRequest = (): boolean => requested;
