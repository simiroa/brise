import { useCallback, useEffect, useRef, useState } from "react";
import type { NoteSummary } from "../../../lib/commands.gen";
import { useSettingsStore } from "../../../stores/settings";
import type { DateRangeKey, RegionFilter } from "../../../stores/search";
import { createOffsetTracker, FAVORITES_OFFSET_KEY } from "./windowLoad";

export interface FavoritesWindowInput {
  searchActive: boolean;
  filterAxesKey: string;
  selectedTags: string[];
  tagMode: "or" | "and";
  regionFilter: RegionFilter | null;
  statusFilter: string[];
  dateRange: DateRangeKey | null;
}

export function useFavoritesWindow(input: FavoritesWindowInput) {
  const { searchActive, filterAxesKey, selectedTags, tagMode, regionFilter, statusFilter, dateRange } =
    input;

  const [favoriteNotes, setFavoriteNotes] = useState<NoteSummary[]>([]);
  const [favoritesTotal, setFavoritesTotal] = useState(0);
  // 펼침 여부는 설정 스토어가 부팅 load() 에서 이미 읽어 들고 있다 — 사이드바 보기를 바꿔 트리가
  // 다시 마운트될 때마다 settings_get_all 을 따로 부르지 않는다.
  const favoritesOpen = useSettingsStore((s) => s.favoritesOpen);

  const favoritesOffsets = useRef(createOffsetTracker()).current;
  const axesRef = useRef({ selectedTags, tagMode, regionFilter, statusFilter, dateRange, favoritesOpen });
  axesRef.current = { selectedTags, tagMode, regionFilter, statusFilter, dateRange, favoritesOpen };

  useEffect(() => {
    if (searchActive || !favoritesOpen) {
      if (!favoritesOpen) {
        setFavoriteNotes([]);
        setFavoritesTotal(0);
        favoritesOffsets.clear();
      }
      return;
    }
    favoritesOffsets.clear();
    favoritesOffsets.claim(FAVORITES_OFFSET_KEY, 0);

    const {
      selectedTags: tags,
      tagMode: mode,
      regionFilter: region,
      statusFilter: statuses,
      dateRange: range,
    } = axesRef.current;
    let cancelled = false;

    void (async () => {
      try {
        const { noteQuery, TREE_FAVORITES_WINDOW } = await import("../../../lib/noteQuery");
        const r = await noteQuery({
          favoritesOnly: true,
          selectedTags: tags,
          tagMode: mode,
          regionFilter: region ?? undefined,
          statusFilter: statuses,
          dateRange: range,
          sort: "year_asc",
          offset: 0,
          limit: TREE_FAVORITES_WINDOW,
        });
        if (!cancelled) {
          setFavoriteNotes(r.notes);
          setFavoritesTotal(r.total);
        }
      } catch {
        favoritesOffsets.release(FAVORITES_OFFSET_KEY, 0);
        if (!cancelled) {
          setFavoriteNotes([]);
          setFavoritesTotal(0);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [searchActive, favoritesOpen, filterAxesKey, favoritesOffsets]);

  // 낙관적 반영 + 저장 실패 시 롤백은 setSimplePref 가 맡는다.
  const toggleFavorites = useCallback(() => {
    const { favoritesOpen: prev, setFavoritesOpen } = useSettingsStore.getState();
    void setFavoritesOpen(!prev);
  }, []);

  return {
    favoriteNotes,
    favoritesTotal,
    favoritesOpen,
    setFavoriteNotes,
    setFavoritesTotal,
    toggleFavorites,
    favoritesOffsets,
  };
}
