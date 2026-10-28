import { create } from "zustand";
import { emitNotice } from "./invoke";
import { dismissToast, showToastOnly } from "./undo";

/**
 * 앱 알림(프레임 알림) 한 곳 — 토스트 + 벨 메뉴 두 표면이 같은 목록을 본다(오너 2026-10-27: 알림은 토스트 + 벨 두 곳으로 통일).
 *
 * 왜 스토어인가: 예전엔 벨 컴포넌트가 자기만의 알림 모델(`FrameNotice`)을 갖고 백업 권유·펫 제안만 거기 올렸다 — 다른 알림(용량 한도)은
 * `emitNotice` 라 토스트만 뜨고 사라졌고, 토스트 버튼은 처음 마운트의 낡은 클로저를 쥐었다(벨에서 이미 처리한 제안을 토스트로 다시
 * 수락할 수 있었다). 이제 생산자(백업 권유·펫 제안·용량 알림)가 `pushNotice` 로 올리고, 벨은 이 스토어를 **그리기만** 한다.
 *
 * - `pushNotice`: 같은 key 가 있으면 내용을 바꾼다(재토스트 없음). **처음 생길 때만** 토스트 한 번 — 모듈 수준 기억이라 `.app` 이 언어
 *   변경으로 리마운트돼도 다시 안 뜬다. 행동(onAction)이 있으면 행동 토스트, 없으면 글만 있는 알림 토스트.
 * - 토스트 버튼은 **누를 때 key 로 현재 알림을 찾아** 실행한다 — 이미 처리돼 사라졌으면 아무 일도 없다(낡은 클로저 무효).
 * - `removeNotice`: 생산자가 "이 알림의 근거가 사라졌다"고 칠 때(조용히 지움). `dismissNotice`: 사용자가 닫을 때(onDismiss 를 부르고 지운다).
 *   둘 다 떠 있는 토스트를 같이 닫는다.
 * ponytail: 토스트 기억은 실행 한 번 동안만이다 — 다음 실행에 다시 한 번 토스트된다(설정 키 없이).
 */
export interface FrameNotice {
  key: string;
  text: string;
  /** 없으면 글만 있는 알림(닫기만 있다). */
  actionLabel?: string;
  dismissLabel?: string;
  /** 행동 실행 중이면 벨의 행동 단추를 잠근다(예: 백업 중). */
  busy?: boolean;
  onAction?: () => void;
  /** 사용자가 닫을 때의 부수효과(설정 플래그 내리기·펫에 알리기 …). 지우는 것은 스토어가 한다. */
  onDismiss?: () => void;
}

interface FrameNoticesState {
  notices: FrameNotice[];
}

export const useFrameNotices = create<FrameNoticesState>(() => ({ notices: [] }));

/** 이미 토스트를 띄운 key — 모듈 수준(리마운트에 안 지워진다). */
const toasted = new Set<string>();
/** 떠 있는 행동 토스트의 id — 알림이 지워지면 그 토스트도 닫는다. */
const toastIds = new Map<string, number>();

const find = (key: string) => useFrameNotices.getState().notices.find((n) => n.key === key);

export function pushNotice(n: FrameNotice): void {
  useFrameNotices.setState((s) =>
    s.notices.some((x) => x.key === n.key)
      ? { notices: s.notices.map((x) => (x.key === n.key ? n : x)) }
      : { notices: [...s.notices, n] },
  );
  if (toasted.has(n.key)) return;
  toasted.add(n.key);
  if (n.onAction) {
    const id = showToastOnly(n.text, () => runNoticeAction(n.key), { ttlMs: 10_000, actionLabel: n.actionLabel });
    if (typeof id === "number") toastIds.set(n.key, id);
  } else {
    emitNotice(n.text);
  }
}

/** key 의 **현재** 알림의 행동을 실행한다(없으면 무시) — 토스트 버튼·벨 단추가 같은 길을 지난다. */
export function runNoticeAction(key: string): void {
  find(key)?.onAction?.();
}

function removeAndCloseToast(key: string): void {
  useFrameNotices.setState((s) => ({ notices: s.notices.filter((n) => n.key !== key) }));
  const id = toastIds.get(key);
  if (id !== undefined) {
    toastIds.delete(key);
    dismissToast(id);
  }
}

/** 생산자가 알림의 근거가 사라졌다고 칠 때 — 조용히 지운다(onDismiss 를 부르지 않는다). */
export function removeNotice(key: string): void {
  removeAndCloseToast(key);
}

/** 사용자가 닫을 때 — onDismiss 의 부수효과를 부르고 지운다. */
export function dismissNotice(key: string): void {
  const n = find(key);
  if (!n) return;
  n.onDismiss?.();
  removeAndCloseToast(key);
}

/** 테스트용 — 스토어와 토스트 기억을 비운다. */
export function resetFrameNoticesForTests(): void {
  useFrameNotices.setState({ notices: [] });
  toasted.clear();
  toastIds.clear();
}
