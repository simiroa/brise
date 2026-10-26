/**
 * 브리핑 창 요청 캐시 — 같은 조회를 카드마다(그리고 StrictMode 이중 실행에서) 각자 부르던 것을 한 번으로.
 * 모듈 스코프 = 창 단위(창은 별도 웹뷰라 창이 열릴 때마다 비어 시작한다). 진행 중 Promise 도 공유하고,
 * 실패는 캐시하지 않는다. fresh(=사용자 reload·포커스 복귀 뒤 TTL 경과)는 캐시를 우회하고 덮어쓴다.
 * 키 접두: cal:/rt: 일정, habit: 습관, src: 수집 소스, recent: 최근 수집, od: 지난 알림.
 * ponytail: 본 창에서의 변경은 이벤트가 아니라 TTL+포커스 복귀(+습관 체크 시 즉시 무효화)로만 반영된다(새 IPC 채널 금지 결정).
 */
export const REQUEST_TTL_MS = 60_000;

interface Entry {
  at: number;
  p: Promise<unknown>;
}
const cache = new Map<string, Entry>();

/** key 접두로 시작하는 항목을 전부 버린다. */
export function invalidate(prefix: string): void {
  for (const k of [...cache.keys()]) if (k.startsWith(prefix)) cache.delete(k);
}

// 설정 창에서 반복 일정을 고치고 돌아온 경우 — 반복 일정(가벼운 조회)은 포커스마다 만료, 나머지는 TTL 규칙 그대로.
if (typeof window !== "undefined") window.addEventListener("focus", () => invalidate("rt:")); // 모듈은 한 번 평가된다

/** 테스트 간 오염 방지. */
export function resetRequestCache(): void {
  cache.clear();
}

export function cachedRequest<T>(
  key: string,
  load: () => Promise<T>,
  opts: { ttl?: number; fresh?: boolean } = {},
  now = Date.now(),
): Promise<T> {
  const hit = cache.get(key);
  if (hit && !opts.fresh && now - hit.at < (opts.ttl ?? REQUEST_TTL_MS)) return hit.p as Promise<T>;
  const entry: Entry = { at: now, p: load() };
  cache.set(key, entry);
  // 실패한 응답이 TTL 동안 남아 재시도를 막지 않게 — 더 새 항목으로 바뀌었으면 건드리지 않는다.
  entry.p.catch(() => {
    if (cache.get(key) === entry) cache.delete(key);
  });
  return entry.p as Promise<T>;
}
