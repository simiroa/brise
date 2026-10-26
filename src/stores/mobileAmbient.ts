import { create } from "zustand";

/**
 * 폰 UI 배경 신호(MobileAmbient)가 읽는 아주 작은 스토어.
 *
 *  · `rec` — "녹음 중인가". 쓰는 곳은 `mobile/useVoiceRecorder.ts` **한 군데**다 — 머신 상태(recording/paused)를
 *    따라 on/paused 로, 그 밖의 모든 상태(idle·finishing·done·failed·인터럽트)와 언마운트에서는 off 로 내린다.
 *    켜 둔 채 남는 경로가 없도록 "끄는 쪽"을 기본값으로 둔 것이다.
 *  · `aiWork` — 스토어 신호가 없는 AI 호출의 진행 수. AI 쪽 신호는 대부분 이미 있는 상태(`stores/ai` 의 글로우 맵·
 *    pending 플래그, `stores/aiResultGate` 의 세션)를 그대로 읽는다. 이건 그 어디에도 안 걸리는 호출만을 위한
 *    예외다 — 지금은 음성 받아쓰기의 `audio_transcribe`(runAiAction 밖, 글로우 키 없음) 하나. 녹음이 끝난 직후
 *    글로우가 사라지고 빛줄기가 켜지기 전 화면이 깜깜해지는 틈이 이 호출이다.
 */
export type MobileRecAmbient = "off" | "on" | "paused";

/**
 * 녹음 입력 레벨 — 의도적으로 zustand 상태가 **아니다**. 마이크 레벨은 초당 10번 넘게 바뀌는데, 상태로 두면 그때마다
 * 이 스토어 구독자 전부의 셀렉터가 돌고(리렌더는 안 나도 낭비), "프레임마다 React 가 다시 그린다"는 오해의 여지가 생긴다.
 * 소비자는 MobileAmbient 의 RecEqualizer 한 곳 — rAF 루프가 프레임마다 `readRecLevel()` 로 읽어 DOM 에 직접 쓴다.
 *
 *  · 발행은 `useVoiceRecorder` 의 레벨 미터 콜백 한 곳. 미터는 녹음 중(`isRecording`)에만 부르므로, 일시정지·
 *    권한 대기·AudioContext 없는 웹뷰에서는 발행이 없다 — 소비자는 `seq` 가 멈춘 것으로 "신호 없음"을 판정해 잔잔한
 *    흔들림으로 넘어간다.
 *  · 최소 간격(REC_LEVEL_MIN_MS ≈ 18fps)으로 솎는다. 미터는 100ms 틱이라 지금은 걸리지 않지만, 미터 주기를 줄여도
 *    소비자 쪽 부하가 늘지 않게 하는 상한이다.
 *  · `rec` 가 바뀌면(on↔paused↔off) 비운다 — 다음 녹음이 지난 녹음의 마지막 피크에서 시작하지 않게.
 */
export const REC_LEVEL_MIN_MS = 55;
const recLevelState = { level: 0, seq: 0, at: 0 };

/** 0..1 레벨 하나를 발행한다. 녹음이 "on" 이 아니거나 너무 빠르면 버린다. */
export function publishRecLevel(level: number): void {
  if (!Number.isFinite(level)) return;
  if (useMobileAmbientStore.getState().rec !== "on") return;
  const now = Date.now();
  if (recLevelState.seq > 0 && now - recLevelState.at < REC_LEVEL_MIN_MS) return;
  recLevelState.level = Math.min(1, Math.max(0, level));
  recLevelState.seq += 1;
  recLevelState.at = now;
}
/** 마지막으로 발행된 레벨. `seq` 는 발행마다 늘고 0 이면 아직 하나도 없다(소비자가 신선도를 판정하는 근거). */
export function readRecLevel(): { level: number; seq: number } {
  return { level: recLevelState.level, seq: recLevelState.seq };
}
export function resetRecLevel(): void {
  recLevelState.level = 0;
  recLevelState.seq = 0;
  recLevelState.at = 0;
}

interface MobileAmbientState {
  rec: MobileRecAmbient;
  setRec: (rec: MobileRecAmbient) => void;
  aiWork: number;
  /** AI 호출 하나의 시작을 알린다. 돌려주는 해제 함수를 `finally` 에서 부른다 — 여러 번 불러도 한 번만 센다. */
  beginAiWork: () => () => void;
}

export const useMobileAmbientStore = create<MobileAmbientState>((set) => ({
  rec: "off",
  setRec: (rec) =>
    set((s) => {
      if (s.rec === rec) return s;
      resetRecLevel();
      return { rec };
    }),
  aiWork: 0,
  beginAiWork: () => {
    set((s) => ({ aiWork: s.aiWork + 1 }));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      set((s) => ({ aiWork: Math.max(0, s.aiWork - 1) }));
    };
  },
}));
