import { useCallback, useMemo, useState, type KeyboardEvent } from "react";
import {
  useSearchStore,
  useIsFiltered,
  useActiveFilterCount,
  isSearchModeActive,
  filterRecentSearches,
} from "../../stores/search";
import { useNotesStore } from "../../stores/notes";
import { useUiStore } from "../../stores/ui";
import { IconSearch, IconClose, IconFilter } from "../icons";
import { t } from "../../i18n/t";
import {
  SearchHistoryDropdown,
  handleSearchHistoryKeyDown,
} from "../SearchHistoryDropdown";

const HISTORY_LIST_ID = "brise-search-history-sidebar";
// 정사각(var(--row-search) × var(--row-search))으로 통일: 필터 토글은 단독 아이콘 액션 버튼이자 우상단 리셋 뱃지 앵커이므로 정사각 비율을 유지한다.

export interface SearchBoxProps {
  /** Chat view: hide toggle + badge entirely (filter state kept in store). */
  hideFilterChrome?: boolean;
}

export function SearchBox({ hideFilterChrome = false }: SearchBoxProps = {}) {
  const query = useSearchStore((s) => s.query);
  const setQuery = useSearchStore((s) => s.setQuery);
  const matchCursor = useSearchStore((s) => s.matchCursor);
  const matchIds = useSearchStore((s) => s.matchIds);
  const stepMatchCursor = useSearchStore((s) => s.stepMatchCursor);
  const recentSearches = useSearchStore((s) => s.recentSearches);
  const addRecentSearch = useSearchStore((s) => s.addRecentSearch);
  const yearFrom = useSearchStore((s) => s.yearFrom);
  const yearTo = useSearchStore((s) => s.yearTo);
  const yearBounds = useSearchStore((s) => s.yearBounds);
  const isFiltered = useIsFiltered();
  const activeFilterCount = useActiveFilterCount();
  const hasQuery = query !== "";

  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyIndex, setHistoryIndex] = useState(-1);

  const historyItems = useMemo(
    () => filterRecentSearches(recentSearches, query),
    [recentSearches, query],
  );
  const showHistory = historyOpen && historyItems.length > 0;

  // Find-next is live only for query/year search — not tag/region/status-only filters.
  const searchMode = isSearchModeActive({ query, yearFrom, yearTo, yearBounds });
  const matchCount = matchIds.length;
  const showMatchCounter = searchMode && matchCount > 0 && !showHistory;
  const activeDescendant = showHistory
    ? historyIndex >= 0
      ? `${HISTORY_LIST_ID}-opt-${historyIndex}`
      : undefined
    : searchMode && matchCursor !== null && matchIds[matchCursor]
      ? `search-match-${matchIds[matchCursor]}`
      : undefined;

  const closeHistory = useCallback(() => {
    setHistoryOpen(false);
    setHistoryIndex(-1);
  }, []);

  const pickHistory = useCallback(
    (q: string) => {
      setQuery(q);
      addRecentSearch(q);
      closeHistory();
    },
    [setQuery, addRecentSearch, closeHistory],
  );

  const commitQueryToHistory = () => {
    const tq = query.trim();
    if (tq) addRecentSearch(tq);
  };

  const onSearchKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (
      handleSearchHistoryKeyDown(e, {
        open: showHistory,
        items: historyItems,
        activeIndex: historyIndex,
        setActiveIndex: setHistoryIndex,
        onPick: pickHistory,
        onClose: closeHistory,
      })
    ) {
      return;
    }

    if (e.key === "Escape") {
      if (historyOpen) {
        e.preventDefault();
        closeHistory();
      }
      return;
    }

    if (e.key === "Enter") {
      commitQueryToHistory();
      // Open is deliberate — never a side effect of moving the cursor.
      if (!searchMode || matchCount === 0) return;
      const id = useSearchStore.getState().currentMatchId();
      if (!id) return;
      e.preventDefault();
      void useNotesStore.getState().selectNote(id);
      return;
    }

    if (!searchMode || matchCount === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      stepMatchCursor(1);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      stepMatchCursor(-1);
      return;
    }
  };

  const openFilters = useUiStore((s) => s.openFilters);
  const showToggle = !hideFilterChrome;
  // Numeric badge is the single reset affordance (click badge = clear all axes), visible whenever filters are active.
  const showResetBadge = showToggle && isFiltered && activeFilterCount > 0;

  return (
    <div
      data-testid="search-box"
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-2)",
        overflow: "visible",
      }}
    >
      <div
        className="search-box-input-wrap"
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          alignItems: "center",
          gap: "var(--space-3)",
          height: "var(--row-search)",
          boxSizing: "border-box",
          padding: "0 var(--space-4)",
          background: "transparent",
          borderRadius: "var(--radius-sm)",
          position: "relative",
        }}
      >
        <IconSearch size={15} strokeWidth={2} style={{ color: "var(--muted)", flex: "none" }} />
        <input
          id="brise-search-input"
          role="combobox"
          aria-autocomplete="list"
          aria-controls={showHistory ? HISTORY_LIST_ID : "brise-search-results"}
          aria-expanded={showHistory || searchMode}
          aria-activedescendant={activeDescendant}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setHistoryOpen(true);
            setHistoryIndex(-1);
          }}
          onFocus={() => {
            setHistoryOpen(true);
            setHistoryIndex(-1);
          }}
          onBlur={() => {
            // Delay so option click / × can run first (mousedown preventDefault also helps).
            window.setTimeout(() => closeHistory(), 120);
          }}
          onKeyDown={onSearchKeyDown}
          placeholder={t("search.placeholder")}
          title={`${t("search.placeholder")} (Ctrl+F)`}
          autoComplete="off"
          style={{
            flex: 1,
            minWidth: 0,
            background: "transparent",
            border: 0,
            outline: "none",
            color: "var(--text)",
            font: "inherit",
            fontSize: "var(--text-md)",
          }}
        />
        {showMatchCounter && (
          <span
            data-testid="search-match-counter"
            aria-live="polite"
            title={t("search.match.counter_title")}
            style={{
              flex: "none",
              fontSize: "var(--text-label)",
              fontVariantNumeric: "tabular-nums",
              color: "var(--muted)",
              whiteSpace: "nowrap",
              userSelect: "none",
            }}
          >
            {t("search.match.counter", {
              current: matchCursor === null ? 0 : matchCursor + 1,
              total: matchCount,
            })}
          </span>
        )}
        {hasQuery && (
          <button
            type="button"
            onClick={() => setQuery("")}
            title={t("search.clear")}
            aria-label={t("search.clear")}
            className="icon-btn icon-btn--sm"
            style={{ color: "var(--faint)" }}
          >
            <IconClose size={14} strokeWidth={2} />
          </button>
        )}
        <SearchHistoryDropdown
          query={query}
          open={showHistory}
          activeIndex={historyIndex}
          onActiveIndexChange={setHistoryIndex}
          onPick={pickHistory}
          onClose={closeHistory}
          testId="search-history"
          listboxId={HISTORY_LIST_ID}
        />
      </div>
      {showToggle ? (
        <div
          data-testid="filter-toggle-wrap"
          style={{
            position: "relative",
            flex: "none",
            width: "var(--row-search)",
            height: "var(--row-search)",
            overflow: "visible",
          }}
        >
          <button
            type="button"
            data-testid="filter-strip-toggle"
            onClick={openFilters}
            title={t("search.filter_toggle")}
            aria-label={t("search.filter_toggle")}
            data-active={isFiltered ? "true" : undefined}
            className="icon-btn icon-btn--glow"
            style={{
              width: "var(--row-search)",
              height: "var(--row-search)",
            }}
          >
            <IconFilter size={14} strokeWidth={2.2} />
          </button>
          {showResetBadge ? (
            <button
              type="button"
              data-testid="filter-reset-badge"
              onClick={(e) => {
                e.stopPropagation();
                useSearchStore.getState().resetAllFilters();
              }}
              title={t("search.filter_active_count", { n: activeFilterCount })}
              aria-label={t("search.filter_active_count", { n: activeFilterCount })}
              style={{
                position: "absolute",
                top: -6,
                right: -6,
                minWidth: 16,
                height: 16,
                padding: "0 4px",
                borderRadius: "var(--radius-pill)",
                border: "1px solid var(--surface)",
                background: "var(--danger)",
                color: "#fff",
                fontSize: "var(--text-label)",
                fontWeight: 600,
                lineHeight: "14px",
                cursor: "pointer",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {activeFilterCount}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
