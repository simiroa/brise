/**
 * Fixed home/dashboard surface — all dashboard waves (tabs + header).
 *
 * Layout reference only: docs/mockups/dashboard-home-tab.html.
 * Tokens only — no mockup CSS copy-paste.
 *
 * Font-role rule for src/components/home/** (dashboard QA cleanup — apply consistently, don't
 * reintroduce the CalendarTab/TimelineTab mix this fixed):
 *   - Tab labels, column titles, calendar month title → var(--font-heading).
 *   - Note-content-ish text (calendar day-detail excerpt, filmstrip subtitle, etc.) →
 *     var(--font-editor). The calendar excerpts (AllDayStrip `cal-detail-excerpt-*`, TimeChip
 *     `cal-chip-excerpt-*`) are the canonical examples — keep them serif. (The old header quote,
 *     PhraseRow, moved to the briefing window on 2026-10-19 — GRILL-2026-10-19 R4.)
 *   - Everything else (badges, buttons, labels, numeric readouts) → inherit (--font-body),
 *     i.e. no explicit fontFamily. The calendar day-detail *heading* (h3, e.g. "July 15,
 *     Wednesday") stays heading-font like a section title even though it's not literally a
 *     tab/column/month label — it plays the same role. The meta line under it (due date /
 *     event-range text) is NOT content, so it inherits body rather than editor.
 *
 * Inner-tabs row (QA8 2A): 3-column grid `minmax(0,1fr) minmax(0,220px) minmax(0,1fr)` so the
 * search box is truly viewport-centered (left = tabs, center = search, right = empty spacer).
 * The old `marginLeft: auto` pinned search to the right and drifted with tab label length /
 * locale. Horizontal inset matches HomeHeader (--content-inset, W24) so left edges align.
 */
import { Suspense, useCallback, useEffect, useMemo, useState, type CSSProperties, type KeyboardEvent } from "react";
// 대시보드 공용 스타일(nav 우측 컨트롤 = 폴더 필터 · 검색 히트 네비 · 상태 액션, 그리고
// graph/map/calendar 우측 패널). 예전에는 HomeMapPane 이 혼자 import 했는데 그 페인이
// 지연 로드로 바뀌면서, 지도 탭을 한 번도 안 열면 항상 보이는 nav 의 .folder-dot 이
// 브라우저 기본 버튼 스타일(회색 배경 + 흰 테두리)로 남는 사고가 났다. 대시보드 셸이
// 소유해야 지연 로드 순서와 무관하게 항상 적용된다.
import "../../styles/dashboardList.css";
import { useUiStore, type HomeInnerTab } from "../../stores/ui";
import { useSearchStore, filterRecentSearches } from "../../stores/search";
import { useSettingsStore } from "../../stores/settings";
import { t } from "../../i18n/t";
import { IconCaret, IconClose } from "../icons";
import { orderedVisibleTabs } from "../../lib/dashboardTabs";
import { DashboardTabStrip } from "./DashboardTabStrip";
import {
  SearchHistoryDropdown,
  handleSearchHistoryKeyDown,
} from "../SearchHistoryDropdown";
import { useDashboardSearchOrderedHits } from "./useDashboardSearchHits";
import { BoardPane } from "./BoardPane";
import { HomeHeader } from "./HomeHeader";
import { HomeTabActions } from "./HomeTabActions";
import { ErrorBoundary } from "../common/ErrorBoundary";
import { CalendarTab, TimelineTab, HomeMapPane, GraphTab, WorldMapGL } from "../../lazySurfaces";






const HOME_HISTORY_LIST_ID = "brise-search-history-home";

// 탭 버튼에 마우스를 올리면 그 탭의 지연 화면을 미리 받는다 — 첫 클릭의 대기 화면(React 19 300ms)을 피한다.
// 지도 탭은 페인과 그 안의 지도 엔진(WorldMapGL)을 함께 받는다. 칸반은 지연 화면이 아니다.
const TAB_SURFACES: Partial<Record<HomeInnerTab, Array<{ preload: () => Promise<void> }>>> = {
  calendar: [CalendarTab],
  timeline: [TimelineTab],
  map: [HomeMapPane, WorldMapGL],
  graph: [GraphTab],
};
const preloadHomeTab = (id: HomeInnerTab) => {
  for (const c of TAB_SURFACES[id] ?? []) void c.preload();
};

function paneLayer(active: boolean, scroll: boolean): CSSProperties {
  return {
    position: "absolute",
    inset: 0,
    display: active ? "flex" : "none",
    flexDirection: "column",
    overflow: scroll ? "auto" : "hidden",
    pointerEvents: active ? "auto" : "none",
    zIndex: active ? 1 : 0,
  };
}

export function HomeTab() {
  const homeInnerTab = useUiStore((s) => s.homeInnerTab);
  const setHomeInnerTab = useUiStore((s) => s.setHomeInnerTab);
  const triggerDashboardReveal = useUiStore((s) => s.triggerDashboardReveal);
  const dashboardTabs = useSettingsStore((s) => s.dashboardTabs);

  // 순서·활성 규칙은 설정 미리보기와 같은 한 곳(lib/dashboardTabs.orderedVisibleTabs).
  const orderedTabs = useMemo(() => orderedVisibleTabs(dashboardTabs), [dashboardTabs]);

  // W23-a: 활성 탭이 꺼지면 탭 스트립 한 곳에서 첫 활성 탭으로 폴백 (W7 §7.3 이 미룬 처리).
  useEffect(() => {
    if (orderedTabs.length === 0) return;
    if (!orderedTabs.some((tab) => tab.id === homeInnerTab)) {
      setHomeInnerTab(orderedTabs[0].id);
    }
  }, [orderedTabs, homeInnerTab, setHomeInnerTab]);

  const [visited, setVisited] = useState<ReadonlySet<HomeInnerTab>>(() => new Set([homeInnerTab]));
  useEffect(() => {
    setVisited((prev) => {
      if (prev.has(homeInnerTab)) return prev;
      const next = new Set(prev);
      next.add(homeInnerTab);
      return next;
    });
  }, [homeInnerTab]);
  // Global search — owner-approved "완전 공유" design (docs/DASHBOARD.md wave notes): fully
  // shared with the sidebar's useSearchStore, not a local box. Side effect (the sidebar tree
  // flips into filtered/search-results mode while this is non-empty) is accepted. Lives in the
  // store, so it — and the period control in TimelineTab — survive switching inner tabs for free;
  // no pane may reset query/yearFrom/yearTo on mount/unmount. Recent history is the same store
  // list (QA8 Wave 3A) — sidebar + header share recentSearches.
  const query = useSearchStore((s) => s.query);
  const setQuery = useSearchStore((s) => s.setQuery);
  const recentSearches = useSearchStore((s) => s.recentSearches);
  const addRecentSearch = useSearchStore((s) => s.addRecentSearch);

  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyIndex, setHistoryIndex] = useState(-1);

  const historyItems = useMemo(
    () => filterRecentSearches(recentSearches, query),
    [recentSearches, query],
  );
  const showHistory = historyOpen && historyItems.length > 0;

  // Wave E: ordered search hits for < > cycling reveal
  const orderedHits = useDashboardSearchOrderedHits();
  const [hitIndex, setHitIndex] = useState(0);
  useEffect(() => {
    setHitIndex(0);
  }, [query]);

  const clampedHitIndex =
    orderedHits && orderedHits.length > 0 ? Math.min(hitIndex, orderedHits.length - 1) : 0;

  const goToPrevHit = useCallback(() => {
    if (!orderedHits || orderedHits.length === 0) return;
    const next = (clampedHitIndex - 1 + orderedHits.length) % orderedHits.length;
    setHitIndex(next);
    triggerDashboardReveal(orderedHits[next]);
  }, [orderedHits, clampedHitIndex, triggerDashboardReveal]);

  const goToNextHit = useCallback(() => {
    if (!orderedHits || orderedHits.length === 0) return;
    const next = (clampedHitIndex + 1) % orderedHits.length;
    setHitIndex(next);
    triggerDashboardReveal(orderedHits[next]);
  }, [orderedHits, clampedHitIndex, triggerDashboardReveal]);

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
    if (e.key === "Escape" && historyOpen) {
      e.preventDefault();
      closeHistory();
      return;
    }
    if (e.key === "Enter") {
      const tq = query.trim();
      if (tq) {
        addRecentSearch(tq);
        if (orderedHits && orderedHits.length > 0) {
          triggerDashboardReveal(orderedHits[clampedHitIndex]);
        }
      }
    }
  };

  return (
    <div
      data-testid="home-tab"
      style={{
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <HomeHeader />

      <div className="home-nav-wrap">
        <nav
          data-testid="home-inner-tabs"
          style={{
            flex: "none",
            display: "grid",
            // Wave F: 3-column symmetric grid restores center search alignment (검색 입력 폭이 결과 유무에 따라 흔들리는 것이 더 나쁘다).
            gridTemplateColumns: "minmax(0, 1fr) minmax(0, 220px) minmax(0, 1fr)",
            alignItems: "center",
            columnGap: "var(--space-2)",
            // W24: 좌우 --space-7 → --content-inset — HomeHeader와 함께 노트 TitleBar 인셋(14px)으로
            // 통일(홈↔노트 좌측 정렬).
            padding: "var(--space-5) var(--content-inset) var(--space-4)",
          }}
        >
          {/* The tab strip never wraps. The 3-column grid keeps the search box viewport-centered,
              which forces both side columns to the same 1fr — so the left column can't borrow the
              slack the right one leaves, and with wrap the 5 Korean labels (291px of buttons) fell
              to 3 rows under ~1200px, pushing this row to 143px tall and undoing the header
              slimming right above it. Measured: 1 row at ≥1280 (left 364px), 2 at 1100, 3 at 915.
              Panning the overflow keeps this row a fixed height at every width (W24: 칩 상하 7px→
              --space-2 로 사다리 스냅, 58→56px); .tag-strip-pan is the existing hide-the-scrollbar
              helper (tokens.css) the titlebar tag strip already uses. */}
          <DashboardTabStrip
            activeId={homeInnerTab}
            onSelect={setHomeInnerTab}
            onTabIntent={preloadHomeTab}
            orderedTabs={orderedTabs}
          />

        {/* Global dashboard search — center column of the 3-col grid. */}
        <div
          data-testid="home-search-slot"
          style={{
            position: "relative",
            width: "100%",
            minWidth: 0,
            display: "flex",
            alignItems: "center",
          }}
        >
          <div style={{ position: "relative", width: "100%", minWidth: 0 }}>
            <input
              type="text"
              data-testid="home-search-input"
              role="combobox"
              aria-autocomplete="list"
              aria-controls={HOME_HISTORY_LIST_ID}
              aria-expanded={showHistory}
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
                window.setTimeout(() => closeHistory(), 120);
              }}
              onKeyDown={onSearchKeyDown}
              placeholder={t("home.search_placeholder")}
              autoComplete="off"
              className="field"
              style={{
                minWidth: 0,
                height: 30,
                padding: query ? "0 26px 0 var(--space-3)" : "0 var(--space-3)",
                fontSize: "var(--text-sm)",
              }}
            />
            {query !== "" && (
              <button
                type="button"
                data-testid="home-search-clear"
                onClick={() => setQuery("")}
                title={t("search.clear")}
                aria-label={t("search.clear")}
                className="icon-btn icon-btn--sm"
                style={{
                  position: "absolute",
                  right: 4,
                  top: "50%",
                  transform: "translateY(-50%)",
                  color: "var(--faint)",
                }}
              >
                <IconClose size={13} strokeWidth={2} />
              </button>
            )}
          </div>

          {/* Search hits counter + prev/next navigation: exposed immediately next to the search bar when hits exist, without changing search bar width/position */}
          {orderedHits && orderedHits.length > 0 && (
            <div
              data-testid="home-search-hits-nav"
              style={{
                position: "absolute",
                left: "calc(100% + var(--space-2))",
                top: "50%",
                transform: "translateY(-50%)",
                display: "flex",
                alignItems: "center",
                gap: 1,
                fontSize: "var(--text-2xs)",
                color: "var(--muted)",
                flex: "none",
                userSelect: "none",
                height: 26,
                whiteSpace: "nowrap",
                zIndex: 1,
              }}
            >
              <span
                data-testid="home-search-hits-count"
                style={{ fontVariantNumeric: "tabular-nums", padding: "0 var(--space-2xs)" }}
              >
                {clampedHitIndex + 1}/{orderedHits.length}
              </span>
              <button
                type="button"
                data-testid="home-search-prev-hit"
                onClick={goToPrevHit}
                className="icon-btn icon-btn--sm"
                style={{ padding: "var(--space-2xs) 3px" }}
                title={t("home.search_prev_hit")}
                aria-label={t("home.search_prev_hit")}
              >
                <IconCaret dir="left" size={11} />
              </button>
              <button
                type="button"
                data-testid="home-search-next-hit"
                onClick={goToNextHit}
                className="icon-btn icon-btn--sm"
                style={{ padding: "var(--space-2xs) 3px" }}
                title={t("home.search_next_hit")}
                aria-label={t("home.search_next_hit")}
              >
                <IconCaret dir="right" size={11} />
              </button>
            </div>
          )}

          <SearchHistoryDropdown
            query={query}
            open={showHistory}
            activeIndex={historyIndex}
            onActiveIndexChange={setHistoryIndex}
            onPick={pickHistory}
            onClose={closeHistory}
            testId="home-search-history"
            listboxId={HOME_HISTORY_LIST_ID}
          />
        </div>

        <HomeTabActions homeInnerTab={homeInnerTab} />
      </nav>
    </div>


      <div
        data-testid="home-pane"
        data-pane={homeInnerTab}
        style={{
          flex: 1,
          minHeight: 0,
          position: "relative",
          overflow: "hidden",
        }}
      >
        {visited.has("board") && (
          <div data-testid="home-pane-board" style={paneLayer(homeInnerTab === "board", true)}>
            <ErrorBoundary><BoardPane /></ErrorBoundary>
          </div>
        )}
        {visited.has("calendar") && (
          <div data-testid="home-pane-calendar" style={paneLayer(homeInnerTab === "calendar", true)}>
            <ErrorBoundary><Suspense fallback={null}><CalendarTab /></Suspense></ErrorBoundary>
          </div>
        )}
        {visited.has("timeline") && (
          <div data-testid="home-pane-timeline" style={paneLayer(homeInnerTab === "timeline", true)}>
            <ErrorBoundary><Suspense fallback={null}><TimelineTab /></Suspense></ErrorBoundary>
          </div>
        )}
        {visited.has("map") && (
          <div data-testid="home-pane-map" style={paneLayer(homeInnerTab === "map", false)}>
            <ErrorBoundary><Suspense fallback={null}><HomeMapPane active={homeInnerTab === "map"} /></Suspense></ErrorBoundary>
          </div>
        )}
        {visited.has("graph") && (
          <div data-testid="home-pane-graph" style={paneLayer(homeInnerTab === "graph", false)}>
            <ErrorBoundary><Suspense fallback={null}><GraphTab active={homeInnerTab === "graph"} /></Suspense></ErrorBoundary>
          </div>
        )}
      </div>
    </div>
  );
}
