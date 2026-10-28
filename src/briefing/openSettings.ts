import { call } from "../lib/invoke";
import { isBrowser } from "../lib/env";

/**
 * 브리핑 → 설정 딥링크 목적지 한 벌. page 는 SettingsPanel 의 페이지 id, anchor 는 그 안 블록
 * (`settings-anchor-<anchor>`; 일부는 도착 시 추가 폼을 1회 연다). 문구로 "설정에서 하세요"만 두지 말고
 * 반드시 이 키로 버튼을 단다.
 */
export const SETTINGS_TARGETS = {
  habits: { page: "briefing", anchor: "habits_add" },
  habits_list: { page: "briefing", anchor: "habits" },
  schedule: { page: "briefing", anchor: "schedule" },
  collect: { page: "collect", anchor: "add" },
  collect_list: { page: "collect" },
  ai: { page: "ai" },
  // 날씨 기본 위치 = 설정 > "지역 및 날씨"(view) 의 MapSection 카드.
  weather: { page: "view", anchor: "weather" },
} as const;

export type SettingsTargetKey = keyof typeof SETTINGS_TARGETS;

/** 설정 창을 해당 위치로 연다. 실패는 call() 이 토스트로 알린다. 브라우저(태블릿) 모드는 OS 창이 없어 아무것도 안 한다. */
export async function openBriefingSettings(key: SettingsTargetKey): Promise<void> {
  // ponytail: 브라우저 모드는 브리핑 창 자체가 데스크톱 전용이라 인앱 오버레이 경로를 만들지 않는다.
  if (isBrowser()) return;
  const target: { page: string; anchor?: string } = SETTINGS_TARGETS[key];
  try {
    await call("settings_window_open", { page: target.page, anchor: target.anchor });
  } catch {
    // call() 이 이미 토스트를 띄웠다.
  }
}
