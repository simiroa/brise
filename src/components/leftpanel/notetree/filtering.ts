import type { NoteSummary } from "../../../lib/commands.gen";
import type { DateRangeKey, RegionFilter } from "../../../stores/search";
// Leaf import (not lib/noteQuery.ts) — noteQuery.ts statically imports invoke.ts, and the
// notetree hooks deliberately `await import("../../../lib/noteQuery")` to defer that edge.
// filtering.ts is statically imported by notetree/index.tsx, so pulling resolveDateRange from
// noteQuery.ts here would drag invoke.ts back into the eager bundle. dateRange.ts has zero
// runtime imports (DateRangeKey below is type-only, erased at build time).
import { resolveDateRange } from "../../../lib/dateRange";

export type MatchesTagRegionInput = {
  selectedTags: string[];
  tagMode?: "or" | "and";
  regionFilter: RegionFilter;
  statusFilter: string[];
  /** §2.8: date-range chip, applied to search_notes results too (not just note_query) so it
   * doesn't silently stop narrowing the instant a keyword query is also active. Compared against
   * the UTC calendar-day part of updated_at — see resolveDateRange for the UTC-day boundary
   * rule (same convention as note_query's server-side predicate). */
  dateRange?: DateRangeKey | null;
};

// Wave 12: Tags/Région 필터 축 — 연도 필터(searchActive)와는 독립적으로 조합된다(AND).
// 태그는 기본 OR(tagMode='and'일 때는 선택된 태그 모두를 포함해야 통과), 지역은 단일 선택. 어느 목록(트리 그룹핑
// 뷰든, 키워드 검색 결과든)에도 동일하게 적용되는 후처리 필터라 여기 한 곳에만 둔다.
// Wave 15: Statut 축(statusFilter) 추가 — 태그와 동일한 모양(다중 선택 OR), 나머지 축과는
// AND로 합성된다. 시맨틱/하이브리드 검색 경로(search_notes 커맨드)는 건드리지 않고, 이미
// 로드된 결과 위에 클라이언트 쪽에서만 후처리한다(태그/지역과 동일한 방식).
export function createMatchesTagRegion(
  input: MatchesTagRegionInput
): (n: NoteSummary) => boolean {
  const { selectedTags, tagMode = "or", regionFilter, statusFilter, dateRange } = input;
  const { from, to } = resolveDateRange(dateRange ?? null);
  return (n: NoteSummary) => {
    if (selectedTags.length > 0) {
      if (tagMode === "and") {
        if (!selectedTags.every((tg) => n.tag_names.includes(tg))) {
          return false;
        }
      } else {
        if (!selectedTags.some((tg) => n.tag_names.includes(tg))) {
          return false;
        }
      }
    }
    if (regionFilter) {
      // D4/N2-2: server note_query matches primary ∪ waypoints, treating them as equal (no
      // "waypoint" label in the chip — owner decision). The client post-filter (search_notes
      // path) now mirrors that union via region_names (backend: repo::notes::note_summaries_map,
      // populated only on this path — see commands.gen.ts NoteSummary comment; optional there
      // because most NoteSummary producers/fixtures never set it, always [] when absent). We
      // still check n.region too as a fallback for any producer that hasn't hydrated it.
      const waypoints = n.region_names ?? [];
      if (regionFilter.kind === "none") {
        if (n.region || waypoints.length > 0) return false;
      } else if (n.region !== regionFilter.name && !waypoints.includes(regionFilter.name)) {
        return false;
      }
    }
    if (statusFilter.length > 0 && !(n.status && statusFilter.includes(n.status))) {
      return false;
    }
    if (from || to) {
      const day = n.updated_at.slice(0, 10);
      if (from && day < from) return false;
      if (to && day > to) return false;
    }
    return true;
  };
}
