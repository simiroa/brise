/**
 * 녹음 이퀄라이저 띠(RecEqualizer)의 순수 수학 — 열 높이 목표값과 비대칭 평활. DOM·React 를 모른다.
 *
 * 입력은 마이크 RMS 레벨 하나(0..1)뿐이라 진짜 주파수 이퀄라이저는 불가능하다. 그래서 "이퀄라이저인 듯 아닌 듯":
 * 레벨이 전체 에너지를 정하고, 열마다 고정된 위상·속도·이득이 그 에너지를 서로 다르게 나눠 받는다.
 * 위상은 황금비 걸음(`frac(i·φ)`)이라 `Math.random` 없이도 열끼리 상관이 없고, 렌더마다 같은 모양이 나온다.
 */

/** 가로로 늘어놓는 열 수(20–28 사이). CSS 는 인라인 `--n` 으로 이 값을 받는다. */
export const EQ_BARS = 24;
/** 쓰기 주기 ≈ 18fps. 사이는 CSS transform 전환(--dur-fast)이 메운다. */
export const EQ_FRAME_MS = 55;
/** 신호가 이만큼 끊기면(미터는 100ms 틱) "레벨 없음" — 잔잔한 흔들림으로 넘어간다. */
export const EQ_STALE_S = 0.5;
/** 평활 시상수 — 올라갈 땐 빠르게, 내려갈 땐 느리게. */
export const EQ_ATTACK_S = 0.07;
export const EQ_RELEASE_S = 0.45;
/** 어떤 신호에서도 남는 바닥 높이(scaleY). 조용한 녹음이 멈춘 것처럼 보이지 않게 한다. */
export const EQ_FLOOR = 0.16;

const TAU = Math.PI * 2;
const frac = (x: number) => x - Math.floor(x);
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

export interface BarSeed {
  /** 라디안. 열마다 다르다. */
  phase: number;
  /** 흔들림 속도 배수 0.7–1.6. */
  speed: number;
  /** 레벨을 받는 몫 0.55–1. */
  gain: number;
  /** 가운데가 가장자리보다 조금 더 크게 움직이는 포락선 0.6–1. */
  env: number;
}

export function barSeed(i: number, n = EQ_BARS): BarSeed {
  return {
    phase: frac(i * 0.6180339887) * TAU,
    speed: 0.7 + frac(i * 0.7548776662 + 0.2) * 0.9,
    gain: 0.55 + 0.45 * frac(i * 0.5698402909 + 0.35),
    env: 0.6 + 0.4 * Math.sin((Math.PI * (i + 0.5)) / n),
  };
}

/**
 * 시각 `t`(초)에서 열 `i` 의 목표 높이(scaleY, EQ_FLOOR..1).
 * `level` null = 레벨 없음 → 느리게 이웃과 이어지는 흔들림만. 숫자 = 레벨이 에너지를 정하고 열마다 다르게 출렁인다.
 */
export function barTarget(i: number, t: number, level: number | null, n = EQ_BARS): number {
  const s = barSeed(i, n);
  // 느린 흔들림 — 이웃 열과 위상이 이어져(i·0.45) 물결처럼 지나간다.
  const sway = 0.5 + 0.5 * Math.sin(t * 0.8 * s.speed + s.phase + i * 0.45);
  if (level === null) return clamp01(EQ_FLOOR + 0.12 * sway * s.env);
  // 작은 소리도 보이게 압축(0.2 → 0.38). 열마다 더 빠른 박동이 에너지를 서로 다르게 나눈다.
  const e = Math.pow(clamp01(level), 0.6);
  const beat = 0.5 + 0.5 * Math.sin(t * 4.2 * s.speed + s.phase * 2);
  return clamp01(EQ_FLOOR + 0.05 * sway * s.env + e * s.gain * s.env * (0.35 + 0.65 * beat));
}

/** `cur` 에서 `target` 으로 `dtS` 초만큼 — 프레임 간격에 상관없는 지수 평활, 올라갈 땐 attack·내려갈 땐 release. */
export function stepToward(cur: number, target: number, dtS: number): number {
  const tau = target > cur ? EQ_ATTACK_S : EQ_RELEASE_S;
  return cur + (target - cur) * (1 - Math.exp(-Math.max(0, dtS) / tau));
}
