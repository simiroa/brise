import { useEffect, useRef, useState } from "react";
import { useNotesStore } from "../../../stores/notes";
import type { DateRangeKey, RegionFilter } from "../../../stores/search";
import { createOffsetTracker } from "./windowLoad";

export interface FolderWindowsInput {
  searchActive: boolean;
  openFolderKey: string;
  filterAxesKey: string;
  selectedTags: string[];
  tagMode: "or" | "and";
  regionFilter: RegionFilter | null;
  statusFilter: string[];
  dateRange: DateRangeKey | null;
}

export function useFolderWindows(input: FolderWindowsInput): { treePending: boolean } {
  const {
    searchActive,
    openFolderKey,
    filterAxesKey,
    selectedTags,
    tagMode,
    regionFilter,
    statusFilter,
    dateRange,
  } = input;

  const setFolderNotes = useNotesStore((s) => s.setFolderNotes);
  const setFolderQueryTotal = useNotesStore((s) => s.setFolderQueryTotal);
  const folderOffsets = useRef(createOffsetTracker()).current;
  const [treePending, setTreePending] = useState(false);

  const axesRef = useRef({ selectedTags, tagMode, regionFilter, statusFilter, dateRange });
  axesRef.current = { selectedTags, tagMode, regionFilter, statusFilter, dateRange };

  useEffect(() => {
    if (searchActive) return;
    const openIds = openFolderKey ? openFolderKey.split(",").filter(Boolean) : [];
    if (openIds.length === 0) return;

    folderOffsets.clear();
    for (const fid of openIds) folderOffsets.claim(fid, 0);

    const {
      selectedTags: tags,
      tagMode: mode,
      regionFilter: region,
      statusFilter: statuses,
      dateRange: range,
    } = axesRef.current;
    let cancelled = false;
    setTreePending(true);

    void (async () => {
      try {
        const { noteQuery, TREE_NOTE_WINDOW } = await import("../../../lib/noteQuery");
        const pages = await Promise.all(
          openIds.map((fid) =>
            noteQuery({
              folderIds: [fid],
              selectedTags: tags,
              tagMode: mode,
              regionFilter: region ?? undefined,
              statusFilter: statuses,
              dateRange: range,
              sort: "year_asc",
              offset: 0,
              limit: TREE_NOTE_WINDOW,
            }).then((r) => ({ fid, r }))
          )
        );
        if (cancelled) return;
        for (const { fid, r } of pages) {
          setFolderNotes(fid, r.notes);
          setFolderQueryTotal(fid, r.total);
        }
      } catch {
        for (const fid of openIds) folderOffsets.release(fid, 0);
      } finally {
        if (!cancelled) setTreePending(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [searchActive, openFolderKey, filterAxesKey, folderOffsets, setFolderNotes, setFolderQueryTotal]);

  return { treePending };
}
