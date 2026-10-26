/**
 * PLAN-2026-09-19-date-region-ui.md §P3 Phase A (D7) — fetch + cache for the `region_registry`
 * command ("이 워크스페이스에 이미 등록된 지역명" 전체 목록, 지역 사전 매칭 넛지의 후보 소스).
 *
 * Shape follows stores/notesTree.ts's `tagCounts` idiom (grep `tagCounts` there): load once,
 * keep a module-level cache, invalidate + reload after a relevant write.
 *
 * §P3 Phase B 배선 완료: `components/titlebar/RegionMetaBadge.tsx`가 `attachmentRevision` +
 * 활성 노트의 `region`/`lat`/`lng`가 바뀔 때마다(첫 렌더는 건너뛴다 — 노트를 여는 것만으로 따뜻한
 * 캐시를 버리지 않게) `invalidateRegionRegistry()`를 부른다. 이건 다섯 쓰기 커맨드 각각을 손으로
 * 훅킹하는 대신 "이 노트의 지역 정보가 바뀌었다"는 더 넓은 신호(attachmentRevision — 모든 첨부
 * 쓰기가 이미 공유하는 카운터, RegionDetectedSection.tsx의 accept 경로도 이걸 bump한다) 하나로
 * 다섯 지점을 한 번에 덮는다 — notesTree.ts::loadTree()에 별도로 걸 필요는 없었다(이 캐시는
 * lazy-load라 노트북 로드 시점 선행 호출 없이도 첫 소비자, regionDetect.ts::useRegionDetect가
 * 알아서 채운다). `loadRegionRegistry()`는 여전히 어떤 소비자에서든 지연 호출해도 안전하다 —
 * 멱등이고 동시 호출자를 하나의 in-flight 요청으로 묶는다.
 */
import { callSilent } from "./invoke";
import { useSettingsStore } from "../stores/settings";
import type { RegionRegistryEntry } from "./commands.gen";

export type { RegionRegistryEntry };

let cache: RegionRegistryEntry[] | null = null;
let inflight: Promise<RegionRegistryEntry[]> | null = null;
/** 캐시/진행 중 조회가 **어느 노트북(= 기존 workspace)** 것인지. `region_registry` 는 인자 없이 부르면
 *  활성 노트북을 읽는데, 이 모듈 캐시는 프로세스 수명이라 노트북을 바꿔도 남는다 — 키 없이는 A
 *  노트북의 지역명이 B 노트북 본문에서 "감지됨"으로 뜬다(§P3 Phase B 검증 중 발견). */
let cacheFor: string | null = null;
let inflightFor: string | null = null;
/** 무효화 세대. 진행 중이던 조회가 **무효화 뒤에** 끝나면 그 결과(쓰기 이전 스냅샷일 수 있다)를
 *  캐시에 도로 심어 무효화를 덮어쓴다 — 시작할 때의 세대가 그대로일 때만 캐시에 쓴다
 *  (stores/notesTree.ts 의 `loadTreeSeq` 와 같은 가드). */
let gen = 0;

function activeNotebookId(): string | null {
  return useSettingsStore.getState().activeWorkspaceId ?? null;
}

/**
 * Returns the cached registry, fetching it first if there is no cache yet (or `force` is set, or
 * the cache belongs to a different notebook). Concurrent callers during the first fetch share the
 * same in-flight request rather than firing duplicate IPC calls. Uses `callSilent` (CLAUDE.md 함정
 * 8) — this is a background/optional data source for a nudge feature, not a user-initiated action,
 * so a failed fetch must not toast; the caller gets an empty array and can retry later (e.g. the
 * next debounce cycle).
 */
export async function loadRegionRegistry(opts?: { force?: boolean }): Promise<RegionRegistryEntry[]> {
  const notebookId = activeNotebookId();
  if (!opts?.force && cache && cacheFor === notebookId) return cache;
  if (!opts?.force && inflight && inflightFor === notebookId) return inflight;
  // 다른 노트북용 조회가 아직 돌고 있었다면 그 결과가 캐시에 앉지 못하게 세대를 올린다.
  const startedGen = ++gen;
  inflightFor = notebookId;
  const request: Promise<RegionRegistryEntry[]> = callSilent<{ entries: RegionRegistryEntry[] }>("region_registry")
    .then((r) => {
      const entries = r?.entries ?? [];
      if (gen === startedGen) {
        cache = entries;
        cacheFor = notebookId;
        inflight = null;
      }
      return entries;
    })
    .catch(() => {
      if (gen === startedGen) inflight = null;
      // Background fetch — swallow and hand back whatever we had for THIS notebook (possibly
      // empty). The matching engine treats "no registry yet" the same as "no candidates".
      return cacheFor === notebookId ? cache ?? [] : [];
    });
  inflight = request;
  return request;
}

/** Synchronous read of whatever is cached right now (null = never successfully loaded). */
export function getCachedRegionRegistry(): RegionRegistryEntry[] | null {
  return cache;
}

/** Drop the cache so the next `loadRegionRegistry()` call re-fetches. Call after a region write
 *  succeeds. A fetch that is still in flight is orphaned too (see `gen`) — it may have read the
 *  table before the write landed. */
export function invalidateRegionRegistry(): void {
  gen++;
  cache = null;
  cacheFor = null;
  inflight = null;
  inflightFor = null;
}
