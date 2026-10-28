import { create } from "zustand";

/**
 * 설정 창 전체가 아는 "지금 되돌릴 수 없는 작업이 도는 중" 표시 — 값은 작업 이름(restore·reset·
 * import·export·backup), 없으면 null. 데이터 페이지가 쓰고, 창 셸이 읽어 그동안 닫기(X)를 막는다.
 */
export const useSettingsBusy = create<{ busy: string | null; setBusy: (b: string | null) => void }>((set) => ({
  busy: null,
  setBusy: (busy) => set({ busy }),
}));

/**
 * 되돌릴 수 없는 작업 하나를 설정 창 전체의 busy 슬롯에 걸고 돈다 — 이미 무언가 돌면 무시(중복 클릭).
 * 데이터 관리 카드들(복원·초기화·가져오기·내보내기·백업)과 저장 및 백업 카드의 복구 목록이 같은 문을 쓴다.
 */
export async function runExclusive(name: string, fn: () => Promise<void>): Promise<void> {
  const store = useSettingsBusy.getState();
  if (store.busy !== null) return;
  store.setBusy(name);
  try {
    await fn();
  } finally {
    useSettingsBusy.getState().setBusy(null);
  }
}
