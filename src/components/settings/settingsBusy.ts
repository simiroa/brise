import { create } from "zustand";

/**
 * 설정 창 전체가 아는 "지금 되돌릴 수 없는 작업이 도는 중" 표시 — 값은 작업 이름(restore·reset·
 * import·export·backup), 없으면 null. 데이터 페이지가 쓰고, 창 셸이 읽어 그동안 닫기(X)를 막는다.
 */
export const useSettingsBusy = create<{ busy: string | null; setBusy: (b: string | null) => void }>((set) => ({
  busy: null,
  setBusy: (busy) => set({ busy }),
}));
