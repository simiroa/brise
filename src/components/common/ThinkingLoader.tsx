/**
 * "AI 가 일하는 중" 알약 — 여덟 갈래 회전 표시 + 라벨. 라벨이 단계(phases)를 따라 바뀌고(옛 글자는 사라지고
 * 새 글자가 올라온다), 끝나면 회전 표시가 체크로, 라벨이 doneLabel(경과 초 포함 가능)로 굳는다.
 * 지금 `PendingIndicator`(상단 2px 선)와 `.pet-chat__dots`(점 셋 + "대기 중")가 따로 하는 일을 한 벌로 모으는 후보.
 *
 * 단계 문구·완료 문구는 호출자가 i18n 으로 넘긴다(기본 문구 없음). 단계는 `phase`(스트림 이벤트 등으로 직접
 * 지정)나 `interval`(타이머 순환) 중 하나로 정한다. 사이드바 챗·펫 챗의 대기 표시가 쓴다.
 */
import { useEffect, useRef, useState } from "react";
import "./uiKit.css";

const RAYS = [0, 1, 2, 3, 4, 5, 6, 7];

export function ThinkingLoader({
  phases,
  phase,
  interval = 2200,
  done = false,
  doneLabel,
  variant = "pill",
}: {
  /** 순서대로 보여 줄 라벨들. 하나면 그대로 고정. */
  phases: string[];
  /** 지정하면 타이머 대신 이 단계를 보인다. */
  phase?: number;
  interval?: number;
  done?: boolean;
  /** 완료 라벨 — 문자열, 또는 시작 뒤 경과 초를 받는 함수(예: s => `${s}초 동안 생각`). */
  doneLabel?: string | ((seconds: number) => string);
  /** pill = 테두리 있는 알약, plain = 말풍선 안 등에 쓰는 테두리 없는 줄. */
  variant?: "pill" | "plain";
}) {
  const [auto, setAuto] = useState(0);
  const startedAt = useRef(Date.now());

  useEffect(() => {
    if (done || phase !== undefined || phases.length < 2) return;
    // 마지막 단계에서 멈춘다 — 끝없이 돌면 "무한 로딩"처럼 읽힌다.
    const id = setInterval(() => setAuto((n) => Math.min(n + 1, phases.length - 1)), interval);
    return () => clearInterval(id);
  }, [done, phase, phases.length, interval]);

  const idx = Math.max(0, Math.min(phase ?? auto, phases.length - 1));
  const seconds = Math.max(0, Math.round((Date.now() - startedAt.current) / 1000));
  const label = done
    ? typeof doneLabel === "function"
      ? doneLabel(seconds)
      : (doneLabel ?? phases[idx])
    : phases[idx];

  return (
    <span
      role="status"
      aria-live="polite"
      className={`think think--${variant}${done ? " think--done" : ""}`}
    >
      {done ? (
        <svg className="think__check" viewBox="0 0 14 14" fill="none" aria-hidden>
          <path d="M3 7.5 6 10.5 11 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <span className="think__spin" aria-hidden>
          {RAYS.map((r) => (
            <i key={r} />
          ))}
        </span>
      )}
      {/* key 가 바뀌면 span 이 새로 만들어져 롤인 애니메이션이 다시 돈다. */}
      <span key={`${done ? "d" : "p"}${idx}`} className="think__label">
        {label}
      </span>
    </span>
  );
}
