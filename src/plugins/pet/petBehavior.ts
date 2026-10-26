import type { CodexPetState } from "./CodexPetAtlas";

/**
 * 펫의 "무슨 일이 있었나" 축. emotion(기쁨/화남 등) 축은 v1에서 의도적으로 제거했다 —
 * activity 하나만으로 그리기 로직(activity → animation 매핑)을 단순하게 유지한다.
 */
export type PetActivity =
  | "resting"
  | "greeting"
  | "listening"
  | "thinking"
  | "working"
  | "moving"
  | "succeeded"
  | "failed"
  | "needs-attention";

export type PetSnapshot = {
  activity: PetActivity;
  animation: CodexPetState | "look"; // "look"은 Phase 2 아틀라스가 노출할 정적 시선 상태
  facing?: number; // 도(deg), animation "look"일 때만 의미 있음
  expiresAt?: number; // TTL 있는 상태만 — 렌더 쪽이 이 시각에 재평가 setTimeout 1개를 건다
};

export type PetSignalKind =
  | "greet"
  | "drag-start"
  | "drag-end"
  | "listen-start"
  | "listen-stop"
  | "think-start"
  | "work-start"
  | "task-done" // thinking/working 둘 다 종료
  | "success"
  | "failure"
  | "attention"
  | "attention-clear";

export type PetSignal = { kind: PetSignalKind; at?: number };

export type PetTransition = {
  activity: PetActivity;
  cause: PetSignalKind | "ttl-expired";
  at: number;
};

/** 우선순위 높음→낮음. resting은 "아무것도 활성이 아닐 때"의 기본값이라 목록에 없다. */
const PRIORITY: readonly Exclude<PetActivity, "resting">[] = [
  "moving",
  "failed",
  "succeeded",
  "greeting",
  "listening",
  "needs-attention",
  "thinking",
  "working",
];

const ANIMATION: Record<PetActivity, CodexPetState | "look"> = {
  resting: "idle",
  greeting: "waving",
  succeeded: "jumping",
  failed: "failed",
  // ponytail: 방향 없는 편도 애니메이션만 노출. 좌/우 구분은 드래그 방향을 실제로 추적해야
  // 하는 v2 작업 — 지금은 running-right 고정.
  moving: "running-right",
  thinking: "review",
  working: "running",
  "needs-attention": "waiting",
  listening: "look",
};

const BURST_WINDOW_MS = 1500;

type StartConfig = { activity: Exclude<PetActivity, "resting">; ttlMs: number; persistent: boolean };

const START_CONFIG: Partial<Record<PetSignalKind, StartConfig>> = {
  greet: { activity: "greeting", ttlMs: 1600, persistent: false },
  success: { activity: "succeeded", ttlMs: 1800, persistent: false },
  failure: { activity: "failed", ttlMs: 2500, persistent: false },
  "drag-start": { activity: "moving", ttlMs: 60_000, persistent: true },
  "listen-start": { activity: "listening", ttlMs: 10 * 60_000, persistent: true },
  // 화면 저장의 비전 왕복 상한이 75초(src-tauri/src/repo/ai/transport.rs
  // VISION_OPERATION_DEADLINE)이고 그 감시 타이머가 85초다(PetApp.tsx SHOT_TIMEOUT_MS) —
  // TTL 이 그보다 짧으면 결과가 오기도 전에 펫이 idle 로 돌아가 "다 됐나?" 로 보인다.
  "think-start": { activity: "thinking", ttlMs: 90_000, persistent: true },
  "work-start": { activity: "working", ttlMs: 60_000, persistent: true },
  attention: { activity: "needs-attention", ttlMs: 5 * 60_000, persistent: true },
};

/** 종료 신호 → 해제할 슬롯들. task-done은 thinking/working 어느 쪽이 활성이든 둘 다 끈다. */
const END_CONFIG: Partial<Record<PetSignalKind, readonly Exclude<PetActivity, "resting">[]>> = {
  "drag-end": ["moving"],
  "listen-stop": ["listening"],
  "task-done": ["thinking", "working"],
  "attention-clear": ["needs-attention"],
};

const HISTORY_LIMIT = 32;

/**
 * 순수 상태 머신. setTimeout/setInterval 없음 — 시간은 항상 호출자(signal.at 또는 now())가 준다.
 * 지속 상태(모션/리스닝/씽킹/워킹/니즈어텐션)는 "활성 플래그 + TTL 상한" 슬롯으로 관리하고,
 * 매 순간의 표시 activity는 슬롯들 중 살아있는(now < expiresAt) 것을 우선순위 순으로 골라 계산한다
 * (스택이 아니다 — 낮은 우선순위 신호가 와도 슬롯은 활성화되지만 화면에는 안 보이다가, 위에 있던
 * 상태가 꺼지면 자연히 드러난다).
 */
export function createPetBehavior(now: () => number = () => Date.now()) {
  const slots: Record<Exclude<PetActivity, "resting">, { active: boolean; expiresAt: number }> = {
    moving: { active: false, expiresAt: 0 },
    failed: { active: false, expiresAt: 0 },
    succeeded: { active: false, expiresAt: 0 },
    greeting: { active: false, expiresAt: 0 },
    listening: { active: false, expiresAt: 0 },
    "needs-attention": { active: false, expiresAt: 0 },
    thinking: { active: false, expiresAt: 0 },
    working: { active: false, expiresAt: 0 },
  };
  const lastSignalAt = new Map<PetSignalKind, number>();
  const log: PetTransition[] = [];
  let lastDisplayed: PetActivity = "resting";

  function computeDisplay(at: number): PetActivity {
    for (const activity of PRIORITY) {
      const slot = slots[activity];
      if (slot.active && at < slot.expiresAt) return activity;
    }
    return "resting";
  }

  function pushHistory(t: PetTransition): void {
    log.push(t);
    if (log.length > HISTORY_LIMIT) log.shift();
  }

  /** 신호 없이도 흐른 시간만으로 TTL이 지나 화면이 바뀌었으면 지연 반영 + 기록. */
  function catchUpExpiry(at: number): void {
    const display = computeDisplay(at);
    if (display !== lastDisplayed) {
      pushHistory({ activity: display, cause: "ttl-expired", at });
      lastDisplayed = display;
    }
  }

  function applySignal(kind: PetSignalKind, at: number): void {
    const startCfg = START_CONFIG[kind];
    if (startCfg) {
      const last = lastSignalAt.get(kind);
      const slot = slots[startCfg.activity];
      // 지속 상태의 burst 무시는 슬롯이 살아있을 때만 — 이미 종료(task-done 등)된 슬롯이면
      // 창(1.5s) 안이라도 새 시작이다 (연속 클립 저장 2회에서 두 번째 thinking이 안 보이던 결함).
      const burst =
        last !== undefined && at - last <= BURST_WINDOW_MS && (!startCfg.persistent || slot.active);
      lastSignalAt.set(kind, at);
      if (burst) {
        // 일시 상태: TTL만 연장. 지속 상태: "무시"(연타가 60초 상한을 계속 밀어내지 못하게).
        if (!startCfg.persistent) slot.expiresAt = at + startCfg.ttlMs;
        return;
      }
      slot.active = true;
      slot.expiresAt = at + startCfg.ttlMs;
      return;
    }
    const endCfg = END_CONFIG[kind];
    if (endCfg) {
      for (const activity of endCfg) slots[activity].active = false;
    }
  }

  function snapshotFor(activity: PetActivity): PetSnapshot {
    if (activity === "resting") return { activity, animation: ANIMATION[activity] };
    const slot = slots[activity];
    if (activity === "listening") {
      return { activity, animation: "look", facing: 90, expiresAt: slot.expiresAt };
    }
    return { activity, animation: ANIMATION[activity], expiresAt: slot.expiresAt };
  }

  return {
    dispatch(signal: PetSignal): PetSnapshot {
      const at = signal.at ?? now();
      catchUpExpiry(at);
      applySignal(signal.kind, at);
      const display = computeDisplay(at);
      if (display !== lastDisplayed) {
        pushHistory({ activity: display, cause: signal.kind, at });
        lastDisplayed = display;
      }
      return snapshotFor(display);
    },
    snapshot(): PetSnapshot {
      const at = now();
      catchUpExpiry(at);
      return snapshotFor(lastDisplayed);
    },
    history(): readonly PetTransition[] {
      return [...log];
    },
  };
}
