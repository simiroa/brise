import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { call, callSilent } from "../../../lib/invoke";
import { useWorkspacesStore } from "../../../stores/workspaces";
import { useNotesStore } from "../../../stores/notes";
import type {
  AttachmentQueryItem,
  AttachmentQueryOutput,
  AttachmentThumbsForIdsOutput,
} from "../../../lib/commands.gen";

export const GALLERY_PAGE_SIZE = 60;
export const GALLERY_FILTER_DEBOUNCE_MS = 300;

/** Type tabs → `kinds` arg. Empty array = every kind except internal. */
export type GalleryKindTab = "all" | "image" | "doc" | "audio" | "link" | "note" | "chart";

export const GALLERY_KIND_TABS: GalleryKindTab[] = [
  "all",
  "image",
  "doc",
  "audio",
  "link",
  "note",
  "chart",
];

export function kindsForTab(tab: GalleryKindTab): string[] {
  if (tab === "all") return [];
  return [tab];
}

export function kindsForTabs(
  tabs: GalleryKindTab | GalleryKindTab[] | Set<GalleryKindTab>,
): string[] {
  if (typeof tabs === "string") {
    return kindsForTab(tabs);
  }
  const set = tabs instanceof Set ? tabs : new Set(tabs);
  if (set.has("all") || set.size === 0) return [];
  const kinds: string[] = [];
  for (const t of GALLERY_KIND_TABS) {
    if (t !== "all" && set.has(t)) {
      kinds.push(t);
    }
  }
  if (kinds.length === GALLERY_KIND_TABS.length - 1) {
    return [];
  }
  return kinds;
}

/**
 * Offset-based gallery pages for the workspace attachment index.
 * - Does not re-request an offset already claimed for the current filter session.
 * - Cancels in-flight pages when kind tab or name filter changes (stale results drop).
 * - After each page, requests missing thumbs and merges them onto items.
 */
export function useGalleryQuery(
  kindTab: GalleryKindTab | GalleryKindTab[] | Set<GalleryKindTab>,
  nameQuery: string,
) {
  const query = nameQuery.trim();
  // 갤러리는 활성 워크스페이스 스코프다(백엔드가 workspace_id 생략 시 active 로 해석). 다른
  // 뷰는 워크스페이스별 스토어(taxonomy 등)를 읽어 전환 때 저절로 갱신되지만 갤러리는 그런
  // 의존이 없어서, 전환을 세션 키에 직접 넣지 않으면 이전 워크스페이스의 첨부가 남는다.
  const workspaceId = useWorkspacesStore((s) => s.activeId);
  const attachmentRevision = useNotesStore((s) => s.attachmentRevision);

  const [items, setItems] = useState<AttachmentQueryItem[]>([]);
  // 첫 페이지는 마운트 직후 무조건 나간다. false 로 시작하면 이펙트 전 첫 페인트에
  // "첨부 없음" 이 한 프레임 스친다.
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(true);

  const kinds = useMemo(() => kindsForTabs(kindTab), [kindTab]);
  const kindsKey = kinds.join(",");

  const genRef = useRef(0);
  const claimedRef = useRef(new Set<number>());
  const hasMoreRef = useRef(true);
  const loadingRef = useRef(true);
  // Stable inputs for fetch
  const kindsRef = useRef(kinds);
  const queryRef = useRef(query);
  kindsRef.current = kinds;
  queryRef.current = query;

  /* 썸네일 병합은 페이지 로딩과 분리해서 붙는다. 같은 try 안에 두면 loading 이 생성이 끝날
     때까지 켜져 있고, 그동안 loadMore 가 전부 막힌다 — 신선한 코퍼스에서 한 페이지 60장이면
     장당 ~300ms 로 최대 ~18초다(재방문은 1ms). gen 가드가 있으니 늦게 도착해도 안전하다. */
  const mergeThumbs = useCallback(async (page: AttachmentQueryItem[], gen: number) => {
    const ids = page.map((i) => i.id).filter(Boolean);
    if (ids.length === 0) return;
    try {
      const res = await callSilent<AttachmentThumbsForIdsOutput>(
        "attachment_thumbs_for_ids",
        { ids },
      );
      if (gen !== genRef.current) return;
      const thumbs = res?.thumbs;
      if (!Array.isArray(thumbs) || thumbs.length === 0) return;
      const byId = new Map(
        thumbs.filter((t) => t.id && t.rel_path).map((t) => [t.id, t.rel_path] as const),
      );
      if (byId.size === 0) return;
      setItems((prev) =>
        prev.map((item) => {
          const rel = byId.get(item.id);
          if (!rel || item.thumb_rel_path === rel) return item;
          return { ...item, thumb_rel_path: rel };
        }),
      );
    } catch {
      // Thumbs are best-effort; keep placeholders.
    }
  }, []);

  const fetchPage = useCallback(
    async (offset: number, gen: number) => {
      if (claimedRef.current.has(offset)) return;
      claimedRef.current.add(offset);
      loadingRef.current = true;
      setLoading(true);

      const kinds = kindsRef.current;
      const q = queryRef.current;
      let page: AttachmentQueryItem[] = [];

      try {
        const res = await call<AttachmentQueryOutput>("attachment_query", {
          kinds,
          query: q || undefined,
          offset,
          limit: GALLERY_PAGE_SIZE,
        });
        // Stale session: tab/filter changed while this page was in flight.
        if (gen !== genRef.current) return;

        page = Array.isArray(res?.items) ? res.items : [];
        setItems((prev) => {
          if (offset === 0) return page;
          const seen = new Set(prev.map((i) => i.id));
          const extra = page.filter((i) => !seen.has(i.id));
          return extra.length === 0 ? prev : [...prev, ...extra];
        });
        const more = page.length >= GALLERY_PAGE_SIZE;
        hasMoreRef.current = more;
        setHasMore(more);
      } catch {
        if (gen === genRef.current) {
          claimedRef.current.delete(offset);
        }
        return;
      } finally {
        if (gen === genRef.current) {
          loadingRef.current = false;
          setLoading(false);
        }
      }

      void mergeThumbs(page, gen);
    },
    [mergeThumbs],
  );

  // Reset and load first page when the filter session changes or attachment revision bumps.
  // Note: Bumping attachmentRevision resets gallery to page 0. This is correct as newest
  // attachments are sorted first — do not optimize into an append.
  useEffect(() => {
    genRef.current += 1;
    const gen = genRef.current;
    claimedRef.current = new Set();
    hasMoreRef.current = true;
    loadingRef.current = false;
    setItems([]);
    setHasMore(true);
    setLoading(false);
    void fetchPage(0, gen);
    return () => {
      genRef.current += 1;
    };
  }, [kindsKey, query, workspaceId, attachmentRevision, fetchPage]);

  const loadMore = useCallback(() => {
    if (!hasMoreRef.current || loadingRef.current) return;
    const offset = claimedRef.current.size * GALLERY_PAGE_SIZE;
    if (claimedRef.current.has(offset)) return;
    void fetchPage(offset, genRef.current);
  }, [fetchPage]);

  return { items, loading, hasMore, loadMore };
}
