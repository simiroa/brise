import { useEffect, useRef } from "react";
import { useSearchStore } from "../stores/search";
import { useSettingsStore } from "../stores/settings";
import { t } from "../i18n/t";
import { IconSearch, IconHistory, IconClose } from "../components/icons";
import { HighlightedText, splitByQuery, splitSnippet } from "../components/leftpanel/notetree/highlight";
import { formatCompactDate } from "./compactDate";
import { PendingIndicator } from "../components/common/PendingIndicator";
import { preloadIntentProps } from "../lib/lazyPreload";
import { MobileNote } from "../lazySurfaces";

interface MobileSearchProps {
  onOpenNote: (id: string) => void;
  onClose: () => void;
}

/**
 * Full-screen search. Reuses the desktop search store as-is (stores/search.ts::setQuery already
 * carries the 200ms debounce + stale-response guard) and desktop's snippet-highlight helpers
 * (notetree/highlight.tsx) rather than re-implementing FTS sentinel parsing here.
 *
 * Also shows the recent-search list (`useSearchStore.recentSearches`, backed by the shared
 * `search_recent` setting — desktop and phone read/write the same list). Deliberately does NOT
 * import `components/SearchHistoryDropdown.tsx` — its rows are onMouseDown/onMouseEnter driven
 * (desktop's hover-highlight + "don't blur before click" pattern), neither of which exists on
 * touch, so this is a fresh, plain button-list rendering of the same store state instead of a
 * reuse of that component.
 */
export function MobileSearch({ onOpenNote, onClose }: MobileSearchProps) {
  const query = useSearchStore((s) => s.query);
  const setQuery = useSearchStore((s) => s.setQuery);
  const results = useSearchStore((s) => s.searchResults);
  const searching = useSearchStore((s) => s.searching);
  const recentSearches = useSearchStore((s) => s.recentSearches);
  const loadRecentSearches = useSearchStore((s) => s.loadRecentSearches);
  const addRecentSearch = useSearchStore((s) => s.addRecentSearch);
  const removeRecentSearch = useSearchStore((s) => s.removeRecentSearch);
  const clearRecentSearches = useSearchStore((s) => s.clearRecentSearches);
  const uiLang = useSettingsStore((s) => s.uiLang);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    void loadRecentSearches();
  }, [loadRecentSearches]);

  const cancel = () => {
    setQuery("");
    onClose();
  };

  // Commit point #1: opening a note from the results list records the query that found it.
  const openResult = (id: string) => {
    addRecentSearch(query);
    onOpenNote(id);
  };

  const hasQuery = query.trim() !== "";

  return (
    <>
      <div className="mobile-topbar mobile-search-bar">
        <div className="mobile-search-field">
          <IconSearch size={20} strokeWidth={2} style={{ color: "var(--muted)", flex: "none" }} />
          <input
            ref={inputRef}
            className="mobile-search-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              // Commit point #2: pressing the on-screen keyboard's search/return action records
              // the query even if the user never taps a specific result (still just fills the
              // input — search_notes already re-fires on every keystroke via setQuery's debounce).
              if (e.key === "Enter") {
                e.preventDefault();
                addRecentSearch(query);
              }
            }}
            placeholder={t("search.placeholder")}
            aria-label={t("search.placeholder")}
          />
        </div>
        <button type="button" className="mobile-text-btn" onClick={cancel}>
          {t("common.cancel")}
        </button>
      </div>

      <div className="mobile-list scroll" style={{ position: "relative" }}>
        <PendingIndicator active={searching && hasQuery} />
        {!hasQuery && recentSearches.length === 0 && (
          <div className="mobile-empty mobile-empty--hint">{t("mobile.search_hint")}</div>
        )}

        {!hasQuery && recentSearches.length > 0 && (
          <>
            <div className="mobile-group-label">{t("mobile.search_recent_title")}</div>
            {recentSearches.map((q) => (
              <div key={q} className="mobile-search-history-row-wrap">
                <button
                  type="button"
                  className="mobile-search-history-row"
                  onClick={() => setQuery(q)}
                  data-testid={`mobile-search-history-${q}`}
                >
                  <IconHistory size={16} strokeWidth={1.8} aria-hidden />
                  <span className="mobile-search-history-text">{q}</span>
                </button>
                <button
                  type="button"
                  className="mobile-search-history-remove"
                  onClick={() => removeRecentSearch(q)}
                  aria-label={t("search.history_remove")}
                  title={t("search.history_remove")}
                >
                  <IconClose size={14} strokeWidth={2} aria-hidden />
                </button>
              </div>
            ))}
            <button type="button" className="mobile-search-history-clear" onClick={() => clearRecentSearches()}>
              {t("search.history_clear_all")}
            </button>
          </>
        )}

        {hasQuery && !searching && results.length === 0 && (
          <div className="mobile-empty mobile-empty--hint">{t("mobile.search_no_results")}</div>
        )}
        {hasQuery &&
          results.map((n) => {
            const title = n.title.trim() && n.title !== "Untitled Note" ? n.title : null;
            return (
              <button type="button" key={n.id} className="mobile-card mobile-search-result card" {...preloadIntentProps(MobileNote)} onClick={() => openResult(n.id)}>
                <span className="mobile-row-top">
                  <span className={title ? "mobile-card-title" : "mobile-card-title mobile-card-title--empty"}>
                    {title ? <HighlightedText segments={splitByQuery(title, query)} /> : t("note.untitled_note")}
                  </span>
                  <span className="mobile-row-date">{formatCompactDate(n.updated_at, uiLang)}</span>
                </span>
                {n.snippet && (
                  <span className="mobile-card-excerpt">
                    <HighlightedText segments={splitSnippet(n.snippet)} />
                  </span>
                )}
              </button>
            );
          })}
      </div>
    </>
  );
}
