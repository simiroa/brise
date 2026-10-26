import { create } from "zustand";

/**
 * 온보딩의 **이번 실행** 상태(PLAN-2026-09-28 §4). 영속하지 않는다 — 다음 실행은 첫 화면부터.
 *
 * 컴포넌트 state 가 아니라 스토어인 이유: 온보딩 페이지는 App.tsx 의 `.app`(key={uiLang}) 안에
 * 있어서 언어를 바꾸면 통째로 리마운트된다. 첫 화면에서 언어를 고르는 순간 입력한 노트북 이름·
 * 보던 화면이 날아가던 것을 여기서 막는다. `dismissed`(X) 도 App 의 표시 게이트가 읽어야 해서 여기.
 */
export type OnboardingScreen = "first" | "import" | "setup" | "done";

interface OnboardingSessionState {
  dismissed: boolean;
  screen: OnboardingScreen;
  setupPage: number;
  /** 첫 화면 노트북 이름 입력 — null 이면 아직 손대지 않음(재밌는 이름 제안을 보여준다). */
  notebookDraft: string | null;
  /** 첫 화면에 제안하는 재밌는 노트북 이름의 순번 — 목록은 언어별 i18n(onboarding.notebook_name_ideas). */
  nameIdeaIdx: number;
  /** 새로고침(shuffle)을 한 번이라도 눌렀는지 — 이미 지은 이름이 있는 노트북은 이때부터만 재밌는 제안을 보인다. */
  nameShuffled: boolean;
  dismiss: () => void;
  /** 설정의 "온보딩 다시 시작하기" — 첫 화면부터, 초안 없이. 데이터·설정은 건드리지 않는다. */
  restart: () => void;
  setScreen: (s: OnboardingScreen) => void;
  setSetupPage: (n: number) => void;
  setNotebookDraft: (v: string) => void;
  /** 다른 이름 추천 — 손대지 않은 상태(초안 없음)로 되돌려 새 제안이 보이게 한다. */
  shuffleNameIdea: () => void;
  /**
   * 데이터 관리 쪽에서 고른 새 저장 위치 — PLAN-2026-09-28-onboarding-rebuild.md §6 D4: 온보딩에서는
   * 위치만 골라 두고 실제 이동(복사+재시작)은 요약 화면 "내 노트 시작하기"에서 한 번만 일어난다.
   * null = 기본 위치 유지(아무것도 옮기지 않는다).
   */
  pendingDataPath: string | null;
  setPendingDataPath: (v: string | null) => void;
}

const randomIdx = () => Math.floor(Math.random() * 1000);

export const useOnboardingSession = create<OnboardingSessionState>((set) => ({
  dismissed: false,
  screen: "first",
  setupPage: 1,
  notebookDraft: null,
  nameIdeaIdx: randomIdx(),
  nameShuffled: false,
  pendingDataPath: null,
  dismiss: () => set({ dismissed: true }),
  restart: () =>
    set({
      dismissed: false,
      screen: "first",
      setupPage: 1,
      notebookDraft: null,
      nameIdeaIdx: randomIdx(),
      nameShuffled: false,
      pendingDataPath: null,
    }),
  setScreen: (screen) => set({ screen }),
  setSetupPage: (setupPage) => set({ setupPage }),
  setNotebookDraft: (notebookDraft) => set({ notebookDraft }),
  shuffleNameIdea: () => set((s) => ({ nameIdeaIdx: s.nameIdeaIdx + 1, nameShuffled: true, notebookDraft: null })),
  setPendingDataPath: (pendingDataPath) => set({ pendingDataPath }),
}));
