/**
 * 브리핑 왼쪽 축의 날짜 이동 · 새 일정 초안 · 머리줄 날씨 조각 — 순수 함수만(테스트는 dayNav.test.ts).
 *
 * PLAN-2026-10-19 §12.1 Q2(오너): 저녁에도 축은 **오늘**이고, 대신 날짜 바꾸기가 아주 쉬워야 한다 —
 * `‹ 날짜 ›` + 오늘 복귀 + 가로 쓸어넘기기(트랙패드 가로 휠·터치 스와이프) + `[`/`]`.
 * 쓸어넘기기는 축의 세로 스크롤과 다투면 안 되므로 **가로 성분이 클 때만** 하루를 넘긴다.
 */
import { MIN_SLOT_MIN, SNAP_MIN } from "../components/home/calendarLayout";
import type { HourlyForecast } from "../lib/weather";

/* ───────────────────────── 쓸어넘기기 ───────────────────────── */

/** 트랙패드 가로 휠 누적 임계(px). 한 번 넘기면 휠이 멈출 때까지 잠근다 — 한 번 쓸면 하루. */
export const SWIPE_WHEEL_THRESHOLD = 80;
/** 이만큼 휠 이벤트가 없으면 한 제스처가 끝난 것으로 본다. */
export const SWIPE_IDLE_MS = 220;
/** 터치 스와이프 최소 가로 이동(px)·최대 길이(ms) — 길게 누르기(축 드래그, 450ms)와 갈린다. */
export const SWIPE_TOUCH_MIN_PX = 60;
export const SWIPE_TOUCH_MAX_MS = 400;

/** 가로 성분이 세로보다 확실히 클 때만(1.5배) 가로 제스처로 본다. */
export function horizontalDominates(dx: number, dy: number): boolean {
  return Math.abs(dx) > Math.abs(dy) * 1.5;
}

/**
 * 가로 휠 누적기 — 제스처 하나에 한 번만 `onStep` 을 부른다. 반환값 true = 이 이벤트를 소비했다
 * (호출자가 preventDefault — 브라우저의 가로 스크롤/뒤로가기 제스처와 겹치지 않게). Ctrl/Cmd+휠은
 * 축 확대 몫이라 손대지 않는다.
 */
export function createWheelSwipe(onStep: (dir: 1 | -1) => void, now: () => number = () => Date.now()) {
  let acc = 0;
  let locked = false;
  let lastAt = -Infinity;
  return (e: { deltaX: number; deltaY: number; ctrlKey?: boolean; metaKey?: boolean }): boolean => {
    if (e.ctrlKey || e.metaKey) return false;
    const t = now();
    if (t - lastAt > SWIPE_IDLE_MS) {
      acc = 0;
      locked = false;
    }
    if (!horizontalDominates(e.deltaX, e.deltaY)) return false;
    lastAt = t;
    if (locked) return true;
    acc += e.deltaX;
    if (Math.abs(acc) >= SWIPE_WHEEL_THRESHOLD) {
      onStep(acc > 0 ? 1 : -1);
      acc = 0;
      locked = true;
    }
    return true;
  };
}

/** 터치 스와이프 한 번의 판정 — 손가락이 왼쪽으로 가면(dx<0) 다음 날. 아니면 null. */
export function touchSwipeStep(dx: number, dy: number, durationMs: number): 1 | -1 | null {
  if (durationMs > SWIPE_TOUCH_MAX_MS) return null;
  if (Math.abs(dx) < SWIPE_TOUCH_MIN_PX || !horizontalDominates(dx, dy)) return null;
  return dx < 0 ? 1 : -1;
}

/** 단축키가 글자 입력을 가로채지 않게 — 입력칸·편집 영역에 포커스가 있으면 날짜 키를 쓰지 않는다. */
export function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable === true;
}

/* ───────────────────────── 새 일정 초안 ───────────────────────── */

export interface DraftRange {
  startMin: number;
  endMin: number;
}

/** 키보드로 만드는 새 일정의 첫 자리(§4.4) — 오늘이면 지금 이후 첫 15분 경계, 다른 날이면 09:00. 길이 30분. */
export function defaultDraftRange(day: string, todayIso: string, nowMin: number): DraftRange {
  const raw = day === todayIso ? Math.ceil((nowMin + 1) / SNAP_MIN) * SNAP_MIN : 9 * 60;
  const startMin = Math.min(raw, 24 * 60 - MIN_SLOT_MIN);
  return { startMin, endMin: startMin + MIN_SLOT_MIN };
}

/** 초안의 시작(↑/↓) 또는 끝(Shift+↑/↓)을 15분 옮긴다. 하루 밖·최소 길이 미만으로는 안 간다. */
export function nudgeDraft(r: DraftRange, part: "start" | "end", dir: 1 | -1): DraftRange {
  const step = SNAP_MIN * dir;
  if (part === "end") {
    const endMin = Math.max(r.startMin + MIN_SLOT_MIN, Math.min(24 * 60, r.endMin + step));
    return { startMin: r.startMin, endMin };
  }
  const len = r.endMin - r.startMin;
  const startMin = Math.max(0, Math.min(24 * 60 - len, r.startMin + step));
  return { startMin, endMin: startMin + len };
}

/* ───────────────────────── 머리줄 날씨 ───────────────────────── */

/** 비·눈·소나기·뇌우(WMO 51–67, 71–77, 80–86, 95–99) — "몇 시부터 비"의 판정. */
export function isPrecipCode(code: number): boolean {
  return (code >= 51 && code <= 67) || (code >= 71 && code <= 77) || (code >= 80 && code <= 86) || code >= 95;
}

/** 오늘 남은 시간 중 처음으로 비(눈)가 오는 시각 "HH:00". 지금 이미 오고 있거나 없으면 null. */
export function rainOnset(hourly: HourlyForecast | null, nowHour: number): string | null {
  if (!hourly) return null;
  let current: boolean | null = null;
  for (let i = 0; i < hourly.time.length; i++) {
    const h = Number(hourly.time[i].slice(11, 13));
    if (!Number.isFinite(h) || h < nowHour) continue;
    const wet = isPrecipCode(hourly.weatherCode[i]);
    if (current === null) {
      current = wet;
      if (wet) return null; // 지금 오는 비는 아이콘이 이미 말한다.
      continue;
    }
    if (wet) return `${String(h).padStart(2, "0")}:00`;
  }
  return null;
}

export interface HourlyCell {
  hour: number;
  tempC: number;
  code: number;
}

/** 시간별 날씨 띠 — 지금 시각부터 `step` 시간 간격으로 최대 `max` 칸. */
export function hourlyCells(hourly: HourlyForecast | null, nowHour: number, step = 3, max = 6): HourlyCell[] {
  if (!hourly) return [];
  const out: HourlyCell[] = [];
  let next = nowHour;
  for (let i = 0; i < hourly.time.length && out.length < max; i++) {
    const h = Number(hourly.time[i].slice(11, 13));
    if (!Number.isFinite(h) || h < next) continue;
    out.push({ hour: h, tempC: Math.round(hourly.tempC[i]), code: hourly.weatherCode[i] });
    next = h + step;
  }
  return out;
}
