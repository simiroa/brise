// Scale Phase 1: shared tag→count helpers for TagsFilter / TitleBar.
// Prefer server tag_counts (O(tags)); fall back to client flatten of notesByFolder (O(notes))
// when the IPC has not loaded yet or failed — avoids empty chips on first paint.

import type { NoteSummary } from "./commands.gen";

/** Client-side scan matching the pre-IPC TagsFilter semantics (soft-deleted notes already absent from notesByFolder). */
export function clientTagCounts(
  notesByFolder: Record<string, NoteSummary[]>,
): Map<string, number> {
  const m = new Map<string, number>();
  for (const notes of Object.values(notesByFolder)) {
    for (const n of notes) {
      for (const tg of n.tag_names) m.set(tg, (m.get(tg) ?? 0) + 1);
    }
  }
  return m;
}

/** Prefer server map when present; otherwise client flatten. */
export function resolveTagCounts(
  server: Record<string, number> | null,
  notesByFolder: Record<string, NoteSummary[]>,
): Map<string, number> {
  if (server && Object.keys(server).length > 0) {
    const m = new Map<string, number>();
    for (const [k, v] of Object.entries(server)) m.set(k, v);
    return m;
  }
  return clientTagCounts(notesByFolder);
}

/** Sorted unique tag names for suggestion chips (TitleBar). */
export function resolveAllTags(
  server: Record<string, number> | null,
  notesByFolder: Record<string, NoteSummary[]>,
): string[] {
  // server가 빈 객체({})여도 truthy라 이전엔 Object.keys({})=[] 를 그대로 반환해 notesByFolder
  // 폴백을 타지 않았다 — 워크스페이스가 아직 태그를 하나도 안 쓴 게 아니라 IPC가 비어 있을 때
  // (로드 실패/타이밍)도 태그 추천이 빈 채로 굳어버리는 버그였다. 빈 맵이면 폴백을 타게 한다.
  if (server && Object.keys(server).length > 0) {
    return Object.keys(server).sort((a, b) => a.localeCompare(b));
  }
  const set = new Set<string>();
  for (const notes of Object.values(notesByFolder)) {
    for (const n of notes) for (const tg of n.tag_names) set.add(tg);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}
