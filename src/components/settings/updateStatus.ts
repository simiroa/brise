import { create } from "zustand";
import { isBrowser } from "../../lib/env";
import { probeUpdate, installUpdate } from "../../lib/updater";
import { reportFallback } from "../../lib/diag";

/**
 * 설정 창이 아는 업데이트 상태(PLAN-2026-10-24 D2). 제품·업데이트 카드(일반 페이지)와 레일 "일반"
 * 항목의 점이 같은 값을 읽는다. 설정 창은 별도 OS 창이라 본 창의 부팅 자동 확인(App.tsx)과 상태를
 * 나누지 않는다 — 창이 열릴 때 무음 확인 1회(SettingsPanel)로 스스로 채운다.
 */
export type UpdatePhase = "idle" | "checking" | "available" | "latest" | "error" | "installing";

interface UpdateStatusState {
  phase: UpdatePhase;
  version?: string;
  notes?: string | null;
  /** 새 버전이 있는지 확인한다(대화상자 없음). 브라우저(태블릿)에서는 아무것도 하지 않는다. */
  probe: () => Promise<void>;
  /** 찾아 둔 업데이트를 설치한다 — 성공하면 앱이 재시작되므로 installing 에 머문다. */
  install: () => Promise<void>;
}

export const useUpdateStatus = create<UpdateStatusState>((set) => ({
  phase: "idle",
  probe: async () => {
    if (isBrowser()) return;
    set({ phase: "checking" });
    try {
      const r = await probeUpdate();
      if (r.status === "available") set({ phase: "available", version: r.version, notes: r.notes });
      else if (r.status === "latest") set({ phase: "latest", version: undefined, notes: null });
      else if (r.status === "error") set({ phase: "error" });
      else set({ phase: "idle" });
    } catch (e) {
      // probeUpdate 는 실패를 "error" 로 돌려주게 돼 있다 — 그 약속이 깨져 throw 하면 "확인 중" 에 영영 묶인다.
      reportFallback("settings.update_check", "threw", e instanceof Error ? e.message : String(e));
      set({ phase: "error" });
    }
  },
  install: async () => {
    set({ phase: "installing" });
    try {
      if ((await installUpdate()) === "error") set({ phase: "error" });
    } catch (e) {
      reportFallback("settings.update_install", "threw", e instanceof Error ? e.message : String(e));
      set({ phase: "error" });
    }
  },
}));
