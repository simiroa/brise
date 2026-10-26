/**
 * 필터 로스터(사이드바 필터 켜짐/순서)와 대시보드 탭(켜짐/순서)의 **순수 정규화**.
 *
 * stores/settings.ts 에서 옮겼다 — 스토어·zustand·window 어느 것에도 기대지 않는 입력→출력 함수라
 * 스토어 없이 리터럴 단위로 테스트된다. stores/settings.ts 가 같은 이름으로 다시 내보내므로
 * 기존 import 지점(`from "../stores/settings"`)은 그대로다. 이 파일은 stores/* 를 import 하지
 * 않는다(순환 금지).
 */

// §2.4 HANDOFF-calendar-onboarding.md: filter roster (checked on/off + order). "tree" is
// excluded — it's the base note list, not a filter, and has no fallback screen when off.
// "chat" replaced the old exclusive "advanced" filter view (status/tags now live on the strip).
export type RosterMode = "region" | "timeline" | "chat" | "gallery" | "calendar";
export type FilterRosterEntry = { mode: RosterMode; enabled: boolean };
// Default tab order after tree: region (map) · timeline · calendar · gallery · chat.
export const CANONICAL_ROSTER: RosterMode[] = ["region", "timeline", "calendar", "gallery", "chat"];

// W7 §7.3: 대시보드 탭 순서
export type DashboardTabId = "board" | "calendar" | "timeline" | "map" | "graph";
export type DashboardTabEntry = { id: DashboardTabId; enabled: boolean };
export const CANONICAL_DASHBOARD_TABS: DashboardTabId[] = [
  "board",
  "calendar",
  "timeline",
  "map",
  "graph",
];

/** Map a persisted roster mode string onto the current RosterMode set. */
function normalizeRosterMode(raw: unknown): RosterMode | null {
  if (raw === "advanced") return "chat";
  if (typeof raw === "string" && (CANONICAL_ROSTER as readonly string[]).includes(raw)) {
    return raw as RosterMode;
  }
  return null;
}

/** Persisted [] ("never saved") -> all-enabled canonical order. A saved roster missing a mode
 * (e.g. a mode added after the user last edited their roster) gets that mode appended, enabled —
 * new capabilities should show up rather than silently vanish for existing users.
 * W7 §7.0: 재정렬이 다시 열렸으므로 사용자 순서를 덮어쓰지 않는다 (LEGACY_DEFAULT_ROSTER 재작성 삭제). */
function normalizeKeyedList<K extends string, E>(
  raw: unknown,
  canonical: readonly K[],
  keyOf: (entry: unknown) => K | null,
  wrap: (key: K, enabled: boolean) => E,
): E[] {
  const seen = new Set<K>();
  const out: E[] = [];
  const keys: K[] = [];
  let anyEnabled = false;
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const key = keyOf(entry);
      const enabledRaw = (entry as { enabled?: unknown })?.enabled;
      const enabled = typeof enabledRaw === "boolean" ? enabledRaw : true;
      if (key && !seen.has(key)) {
        seen.add(key);
        keys.push(key);
        out.push(wrap(key, enabled));
        if (enabled) anyEnabled = true;
      }
    }
  }
  for (const key of canonical) {
    if (!seen.has(key)) {
      keys.push(key);
      out.push(wrap(key, true));
      anyEnabled = true;
    }
  }
  // W23-a: sidebar filters and dashboard tabs both require ≥1 enabled.
  if (out.length > 0 && !anyEnabled) {
    out[0] = wrap(keys[0], true);
  }
  return out;
}

/** Persist-path twin of the load-time min-1-enabled guard. Does not re-append canonical keys. */
export function ensureOneEnabled<T extends { enabled: boolean }>(entries: T[]): T[] {
  if (entries.length === 0 || entries.some((e) => e.enabled)) return entries;
  return entries.map((e, i) => (i === 0 ? { ...e, enabled: true } : e));
}

export function normalizeFilterRoster(raw: unknown): FilterRosterEntry[] {
  return normalizeKeyedList(
    raw,
    CANONICAL_ROSTER,
    (entry) => normalizeRosterMode((entry as { mode?: unknown })?.mode),
    (mode, enabled) => ({ mode, enabled }),
  );
}

function normalizeDashboardTabId(raw: unknown): DashboardTabId | null {
  if (typeof raw === "string" && (CANONICAL_DASHBOARD_TABS as readonly string[]).includes(raw)) {
    return raw as DashboardTabId;
  }
  return null;
}

/**
 * W7 §7.3 / W23-a: 대시보드 탭 순서·활성 정규화.
 * 빈 배열 / 누락 = 저장된 적 없음 -> CANONICAL_DASHBOARD_TABS 순서대로 전부 활성.
 * 누락된 탭은 뒤에 활성으로 추가. enabled=false 를 존중하되 전부 꺼짐은 첫 항목을 켠다.
 */
export function normalizeDashboardTabs(raw: unknown): DashboardTabEntry[] {
  return normalizeKeyedList(
    raw,
    CANONICAL_DASHBOARD_TABS,
    (entry) => normalizeDashboardTabId((entry as { id?: unknown })?.id),
    (id, enabled) => ({ id, enabled }),
  );
}
