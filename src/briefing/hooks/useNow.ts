import { useCallback, useSyncExternalStore } from "react";

// tickMs 별 단일 타이머 + 구독 공유. 탭이 숨겨지면 멈추고, 보이게 되면 즉시 한 번 갱신한다.
interface Store {
  now: Date;
  subs: Set<() => void>;
  id: ReturnType<typeof setTimeout> | null;
  onVis: (() => void) | null;
}
const stores = new Map<number, Store>();

function store(tickMs: number): Store {
  let s = stores.get(tickMs);
  if (!s) stores.set(tickMs, (s = { now: new Date(), subs: new Set(), id: null, onVis: null }));
  return s;
}

function bump(s: Store): void {
  s.now = new Date();
  s.subs.forEach((l) => l());
}

function start(s: Store, tickMs: number): void {
  if (s.id !== null || document.hidden) return;
  // 벽시계 배수(예: 정각 분)에 맞춰 틱한다 — 마운트 시점 기준 setInterval 이면 분 표시가 최대 tickMs 늦다.
  const arm = () => {
    s.id = setTimeout(() => {
      bump(s);
      arm();
    }, tickMs - (Date.now() % tickMs) + 5);
  };
  arm();
}
function stop(s: Store): void {
  if (s.id !== null) clearTimeout(s.id);
  s.id = null;
}

function subscribe(tickMs: number, l: () => void): () => void {
  const s = store(tickMs);
  s.subs.add(l);
  if (s.subs.size === 1) {
    s.onVis = () => {
      if (document.hidden) return stop(s);
      bump(s);
      start(s, tickMs);
    };
    document.addEventListener("visibilitychange", s.onVis);
    start(s, tickMs);
  }
  return () => {
    s.subs.delete(l);
    if (s.subs.size) return;
    stop(s);
    if (s.onVis) document.removeEventListener("visibilitychange", s.onVis);
    s.onVis = null;
  };
}

function snapshot(tickMs: number): Date {
  const s = store(tickMs);
  // 구독이 없는 동안(첫 렌더·재마운트)엔 오래된 값이 남을 수 있어 한 틱 넘었으면 새로 잡는다.
  if (!s.subs.size && Date.now() - s.now.getTime() >= tickMs) s.now = new Date();
  return s.now;
}

/** 분 단위로 갱신되는 "지금" — 시계·시간축 현재 시각 마커용. */
export function useNow(tickMs = 30_000): Date {
  const sub = useCallback((l: () => void) => subscribe(tickMs, l), [tickMs]);
  return useSyncExternalStore(sub, () => snapshot(tickMs));
}

/** 테스트 간 오염 방지. */
export function resetNowStores(): void {
  for (const s of stores.values()) {
    stop(s);
    if (s.onVis) document.removeEventListener("visibilitychange", s.onVis);
  }
  stores.clear();
}
