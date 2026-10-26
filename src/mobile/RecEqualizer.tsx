import { useEffect, useRef, useState, type CSSProperties } from "react";
import { readRecLevel } from "../stores/mobileAmbient";
import { barSeed, barTarget, EQ_BARS, EQ_FLOOR, EQ_FRAME_MS, EQ_STALE_S, stepToward } from "./recEqualizerMath";

/**
 * 녹음 신호 — 화면 바닥에 깔리는 은은한 이퀄라이저 띠. 세로로 번지는 부드러운 빛기둥 24개가 마이크 레벨을 따라
 * 출렁이되, 열마다 위상·이득이 달라 막대그래프로는 읽히지 않는다(수학은 recEqualizerMath.ts — 같은 이름에 대소문자만 다른 .ts 를 두면 Windows 에서 import 가 뒤섞인다).
 *
 * 렌더 규율 — 이 컴포넌트는 React 상태를 프레임마다 바꾸지 않는다. rAF 루프가 ~18fps 로 `readRecLevel()`(스토어의
 * 비반응 채널)을 읽어 열마다 CSS 변수 `--eq-h` 를 직접 쓰고, CSS 가 `scaleY(var(--eq-h))` 로 그린다(합성 전용).
 * 그래서 앱 루트는 레벨이 바뀌어도 한 번도 다시 그려지지 않는다.
 *
 *  · 레벨이 있으면(신선도: 마지막 발행 후 EQ_STALE_S 안) 레벨 구동, 없으면(권한 대기·AudioContext 없는 웹뷰) 잔잔한 흔들림.
 *  · `frozen`(일시정지) = 루프를 멈춰 그 자리에 둔다 — 높이는 ref 에 남아 재개하면 거기서 이어진다. 흐려지는 건 부모의 몫.
 *  · 모션 줄이기 = 루프 없음. CSS 가 열마다 다른 고정 높이의 낮은 띠를 그린다.
 */

const BAR_STYLES: CSSProperties[] = Array.from({ length: EQ_BARS }, (_, i) => ({
  "--i": i,
  "--g": barSeed(i).gain.toFixed(2),
}) as CSSProperties);

const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => typeof window.matchMedia === "function" && window.matchMedia(REDUCED_QUERY).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(REDUCED_QUERY);
    const on = () => setReduced(mq.matches);
    on();
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);
  return reduced;
}

export function RecEqualizer({ frozen }: { frozen: boolean }) {
  const reduced = useReducedMotion();
  const hostRef = useRef<HTMLDivElement>(null);
  const barsRef = useRef<Array<HTMLSpanElement | null>>([]);
  // 루프가 멈췄다 다시 돌아도 이어지는 값들 — 일시정지 중엔 높이도 시간도 그대로다.
  const heightsRef = useRef<number[]>(Array.from({ length: EQ_BARS }, () => EQ_FLOOR));
  const clockRef = useRef({ t: 0, seq: 0, sinceLevel: 0 });

  useEffect(() => {
    if (frozen || reduced) return;
    const heights = heightsRef.current;
    const clock = clockRef.current;
    let raf = 0;
    let last: number | null = null;
    let source = "";
    const frame = (ts: number) => {
      raf = requestAnimationFrame(frame);
      if (last !== null && ts - last < EQ_FRAME_MS) return;
      const dt = last === null ? EQ_FRAME_MS / 1000 : Math.min(0.25, (ts - last) / 1000);
      last = ts;
      clock.t += dt;
      const { level, seq } = readRecLevel();
      if (seq !== clock.seq) {
        clock.seq = seq;
        clock.sinceLevel = 0;
      } else {
        clock.sinceLevel += dt;
      }
      const live = seq > 0 && clock.sinceLevel < EQ_STALE_S;
      const bars = barsRef.current;
      for (let i = 0; i < EQ_BARS; i++) {
        heights[i] = stepToward(heights[i], barTarget(i, clock.t, live ? level : null), dt);
        bars[i]?.style.setProperty("--eq-h", heights[i].toFixed(3));
      }
      const next = live ? "level" : "idle";
      if (next !== source) {
        source = next;
        hostRef.current?.setAttribute("data-source", next);
      }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [frozen, reduced]);

  return (
    <div
      ref={hostRef}
      className="mobile-rec-eq"
      data-testid="mobile-rec-eq"
      style={{ "--n": EQ_BARS } as CSSProperties}
    >
      {BAR_STYLES.map((style, i) => (
        <span
          key={i}
          className="mobile-rec-bar"
          style={style}
          ref={(el) => {
            barsRef.current[i] = el;
          }}
        />
      ))}
    </div>
  );
}
