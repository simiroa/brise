import { useState } from "react";
import { useSearchStore, countActiveFilterAxes } from "../stores/search";
import { t } from "../i18n/t";
import { IconSearch, IconFilter } from "../components/icons";
import { MobileWorkspaceSwitcher } from "./MobileWorkspaceSwitcher";
import { MobileViewSwitcher } from "./MobileViewSwitcher";
import { MobileNoteTree } from "./MobileNoteTree";
import { MobileExpandedView } from "./MobileExpandedView";
import { MobileFilterSheet } from "./MobileFilterSheet";
import { MobileActiveFilterChips } from "./MobileActiveFilterChips";

interface MobileHomeProps {
  onOpenNote: (id: string) => void;
  onOpenSearch: () => void;
  /** 폴더 보기 ＋ → 노트 추가: 입력 화면을 새 초안으로(MobileApp::enterCapture — 탭 바 가운데 ＋ 와 같은 경로). */
  onNewNote?: () => void;
}

/**
 * `필터` 탭 — top bar (notebook switcher + search), view switcher, filter chip/sheet, then one of
 * two bodies: MobileNoteTree for the tree view, MobileExpandedView (the dispatcher for every other
 * view) otherwise. Mobile mirror of desktop's `filterMode === "tree" ? <NoteTree/> :
 * <ExpandedFilterView/>` in leftpanel/index.tsx — same two-way split.
 */
export function MobileHome({ onOpenNote, onOpenSearch, onNewNote }: MobileHomeProps) {
  const filterMode = useSearchStore((s) => s.filterMode);
  const query = useSearchStore((s) => s.query);
  const yearFrom = useSearchStore((s) => s.yearFrom);
  const yearTo = useSearchStore((s) => s.yearTo);
  const yearBounds = useSearchStore((s) => s.yearBounds);
  const selectedTags = useSearchStore((s) => s.selectedTags);
  const regionFilter = useSearchStore((s) => s.regionFilter);
  const statusFilter = useSearchStore((s) => s.statusFilter);
  const dateRange = useSearchStore((s) => s.dateRange);
  const activeAxes = countActiveFilterAxes({ query, yearFrom, yearTo, yearBounds, selectedTags, regionFilter, statusFilter, dateRange });

  // The chip is always present (so the filter sheet can be opened from a clean state, not only once
  // an axis is active) and always opens MobileFilterSheet; "clear everything" lives in that sheet's
  // own footer button.
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);

  return (
    <>
      <div className="mobile-topbar">
        <MobileWorkspaceSwitcher />
        <button type="button" className="mobile-icon-btn mobile-topbar-search" onClick={onOpenSearch} aria-label={t("search.placeholder")}>
          <IconSearch size={22} strokeWidth={2} />
        </button>
      </div>

      <div className="mobile-subbar">
        <MobileViewSwitcher />
        <button
          type="button"
          className="mobile-filter-chip"
          onClick={() => setFilterSheetOpen(true)}
          aria-label={t("mobile.filter_open")}
          title={t("mobile.filter_open")}
          data-testid="mobile-filter-chip"
        >
          {activeAxes > 0 ? (
            <span className="mobile-filter-chip-dot" data-testid="mobile-filter-badge">{activeAxes}</span>
          ) : (
            <IconFilter size={20} strokeWidth={2} aria-hidden />
          )}
        </button>
      </div>

      <MobileActiveFilterChips onOpenSheet={() => setFilterSheetOpen(true)} />

      {/* ＋(폴더 추가·노트 추가·AI)는 폴더 보기에만 뜬다(MobileNoteTree → MobileTreeFab) — 폴더 관리가 그 보기의 일이고,
          다른 보기는 오른쪽 아래에 자기 컨트롤(채팅 입력줄·지도 조작)이 있어 떠 있는 버튼이 그것을 가린다. */}
      {filterMode === "tree" ? <MobileNoteTree onOpenNote={onOpenNote} onNewNote={onNewNote} /> : <MobileExpandedView onOpenNote={onOpenNote} />}

      {filterSheetOpen && <MobileFilterSheet onClose={() => setFilterSheetOpen(false)} />}
    </>
  );
}
