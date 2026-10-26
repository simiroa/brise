import { create } from "zustand";

/**
 * FeatureBriefModal 의 열림 상태 — 설정 창 안 여러 트리거 지점(AiPermissionsSection·
 * AiCapabilityCatalog·SyncSection·BrowserCaptureSection)이 한 모달을 공유하므로, prop drilling 대신
 * 작은 전역 스토어 하나로 연결한다(docs/PLAN-2026-08-30-ai-surface-and-clients.md §4 W7).
 *
 * "onboarding" = 토글 OFF→ON 트리거(useFeatureBrief.ts::useFeatureBriefTrigger), 액션
 * [알겠습니다]+[사용법 자세히보기]+외부 링크. "read" = 카탈로그 "자세히 ▸", 액션 [닫기]만.
 */
interface FeatureBriefUiState {
  activeId: string | null;
  mode: "onboarding" | "read";
  open: (id: string, mode: "onboarding" | "read") => void;
  close: () => void;
}

export const useFeatureBriefStore = create<FeatureBriefUiState>((set) => ({
  activeId: null,
  mode: "read",
  open: (id, mode) => set({ activeId: id, mode }),
  close: () => set({ activeId: null }),
}));
