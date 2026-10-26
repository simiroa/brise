/**
 * Top-left place search for the home Map tab — reuses geocode_search (Nominatim via backend).
 * No new API keys / CSP domains.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useSettingsStore } from "../../stores/settings";
import { t } from "../../i18n/t";
import { useGeocodeSearch, type GeocodeResultItem } from "../../lib/useGeocodeSearch";
import { useDismiss } from "../../lib/ui";
import { IconSearch, IconClose } from "../icons";
import { FluidHoverHighlight, useFluidHover } from "../common/FluidHover";
import {
  readPlaceSearchHistory,
  recordPlaceSearchPick,
  clearPlaceSearchHistory,
  derivePlaceSearchSections,
  type PlaceSearchEntry,
} from "../../lib/placeSearchHistory";

interface MapPlaceSearchProps {
  onPick: (item: GeocodeResultItem, clientX: number, clientY: number) => void;
  /** Sidebar map is ~240-280px wide — shrink from the dashboard's fixed 300px to fit. */
  compact?: boolean;
  /** Phone (mobile region view): 48px input + taller result rows so a thumb can hit them, and the
   *  keyboard drops after a pick so the fly-to is visible. */
  touch?: boolean;
  style?: React.CSSProperties;
}

export function MapPlaceSearch({ onPick, compact, touch, style }: MapPlaceSearchProps) {
  const uiLang = useSettingsStore((s) => s.uiLang);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState<PlaceSearchEntry[]>(() => readPlaceSearchHistory());
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const hover = useFluidHover(resultsRef, { axis: "y" });
  // U-11: 고른 결과가 입력란을 라벨 앞부분으로 바꾼다 — 그 문자열은 다시 검색하지도, 목록을 다시 열지도 않는다.
  const pickedQueryRef = useRef<string | null>(null);
  const isPickedQuery = pickedQueryRef.current !== null && query === pickedQueryRef.current;
  const { results, searching, unavailable } = useGeocodeSearch(isPickedQuery ? "" : query, uiLang);
  const wasSearching = useRef(false);
  const { frequent, recent } = useMemo(() => derivePlaceSearchSections(history), [history]);
  const showHistoryPanel = open && !query.trim();

  const pick = (item: GeocodeResultItem, clientX: number, clientY: number) => {
    onPick(item, clientX, clientY);
    recordPlaceSearchPick(item);
    setHistory(readPlaceSearchHistory());
    const head = item.label.split(",")[0].trim();
    pickedQueryRef.current = head;
    setQuery(head);
    setOpen(false);
    if (touch) inputRef.current?.blur();
  };

  // Open the dropdown once a debounced search finishes (success or failure) — matches the old
  // inline setOpen(true) calls in both branches. Closing (input cleared) is explicit; reopening
  // on refocus is handled by the input's onFocus below.
  useEffect(() => {
    if (!query.trim() || isPickedQuery) {
      setOpen(false);
    } else if (searching) {
      // 처음 쓸 때 "검색 중" 표시가 닫힌 드롭다운 안에만 있으면 입력해도 무반응처럼 보인다.
      setOpen(true);
    } else if (wasSearching.current) {
      setOpen(true);
    }
    wasSearching.current = searching;
  }, [query, searching, isPickedQuery]);

  useDismiss(true, [wrapRef], () => setOpen(false));

  // useDismiss listens for mousedown, which a phone only synthesizes after a tap the page didn't
  // preventDefault — the map canvas does (MapLibre's touch pan), so tapping the map would leave the
  // dropdown hanging over it. pointerdown fires for touch regardless; only needed while open.
  useEffect(() => {
    if (!touch || !open) return;
    const onDown = (e: PointerEvent) => {
      if (wrapRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [touch, open]);

  const rowStyle: React.CSSProperties | undefined = touch
    ? { minHeight: 44, paddingTop: "var(--space-4)", paddingBottom: "var(--space-4)", fontSize: "var(--text-sm)" }
    : undefined;

  return (
    <div
      ref={wrapRef}
      data-testid="home-map-search"
      // Stop map click-to-create when interacting with the search chrome.
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      style={{
        position: "relative",
        width: compact ? "min(220px, 100%)" : "min(280px, calc(100vw - 360px))",
        ...style,
      }}
    >
      <div
        className="overlay map-search-input-wrap"
        data-active={open ? "true" : undefined}
        style={{
          position: "relative",
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2)",
          padding: "0 var(--space-3)",
          height: touch ? 48 : "var(--ctrl-h-sm)",
          boxSizing: "border-box",
          borderRadius: touch ? "var(--radius-md)" : "var(--radius-sm)",
          background: "color-mix(in srgb, var(--surface) 85%, transparent)",
        }}
      >
        <IconSearch size={touch ? 18 : 14} strokeWidth={2} style={{ color: "var(--muted)", flex: "none" }} />
        <input
          ref={inputRef}
          type="text"
          enterKeyHint={touch ? "search" : undefined}
          data-testid="home-map-search-input"
          value={query}
          onChange={(e) => {
            pickedQueryRef.current = null;
            setQuery(e.target.value);
          }}
          onFocus={() => {
            if (results.length > 0 || unavailable || history.length > 0) setOpen(true);
          }}
          placeholder={t("home.map_search_placeholder")}
          autoComplete="off"
          style={{
            flex: 1,
            minWidth: 0,
            border: "none",
            outline: "none",
            background: "transparent",
            color: "inherit",
            fontSize: touch ? "var(--text-sm)" : "var(--text-xs)",
          }}
        />
        {query.trim() && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setQuery("");
              setOpen(false);
            }}
            aria-label="clear search"
            style={{
              ...(touch ? { width: 44, height: 44, marginRight: "calc(-1 * var(--space-3))" } : null),
              border: "none",
              background: "transparent",
              color: "var(--faint)",
              cursor: "pointer",
              padding: 0,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              flex: "none",
            }}
          >
            <IconClose size={12} strokeWidth={2} />
          </button>
        )}
      </div>
      {open && (
        <div
          ref={resultsRef}
          data-testid="home-map-search-results"
          role="listbox"
          className="overlay scroll fh-host"
          {...hover.handlers}
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            right: 0,
            maxHeight: touch ? "min(320px, 50vh)" : 280,
            overflowY: "auto",
            borderRadius: "var(--radius-sm)",
            border: "1px solid var(--divider)",
            boxShadow: "var(--shadow-lg)",
            zIndex: "var(--z-dropdown)",
            padding: 4,
          }}
        >
          <FluidHoverHighlight hover={hover} />
          {showHistoryPanel ? (
            <PlaceHistoryPanel
              rowStyle={rowStyle}
              frequent={frequent}
              recent={recent}
              onPick={pick}
              onClear={() => {
                clearPlaceSearchHistory();
                setHistory([]);
              }}
            />
          ) : (
            <>
              {searching && (
                <div style={{ fontSize: "var(--text-xs)", color: "var(--muted)", padding: "6px 8px" }}>
                  {t("common.loading")}
                </div>
              )}
              {unavailable && !searching && (
                <div
                  style={{
                    fontSize: "var(--text-xs)",
                    color: "var(--danger-soft, var(--danger))",
                    padding: "6px 8px",
                  }}
                >
                  {t("note.search_unavailable")}
                </div>
              )}
              {!searching &&
                !unavailable &&
                results.map((item, idx) => (
                  <button
                    key={`${item.lat},${item.lng},${idx}`}
                    type="button"
                    data-testid={`home-map-search-result-${idx}`}
                    className="menu-row menu-item"
                    onClick={(e) => pick(item, e.clientX, e.clientY)}
                    style={{
                      display: "block",
                      ...rowStyle,
                      width: "100%",
                      textAlign: "left",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      border: "none",
                      background: "transparent",
                      color: "inherit",
                      cursor: "pointer",
                    }}
                  >
                    {item.label}
                  </button>
                ))}
              {!searching && !unavailable && results.length === 0 && query.trim() && (
                <div style={{ fontSize: "var(--text-xs)", color: "var(--faint)", padding: "6px 8px" }}>
                  —
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function PlaceHistoryPanel({
  frequent,
  recent,
  onPick,
  onClear,
  rowStyle,
}: {
  rowStyle?: React.CSSProperties;
  frequent: PlaceSearchEntry[];
  recent: PlaceSearchEntry[];
  onPick: (item: GeocodeResultItem, clientX: number, clientY: number) => void;
  onClear: () => void;
}) {
  if (frequent.length === 0 && recent.length === 0) return null;

  const section = (titleKey: string, items: PlaceSearchEntry[], prefix: string) =>
    items.length > 0 && (
      <div>
        <div
          style={{
            fontSize: "var(--text-xs)",
            color: "var(--faint)",
            padding: "4px 8px",
            textTransform: "uppercase",
          }}
        >
          {t(titleKey)}
        </div>
        {items.map((item, idx) => (
          <button
            key={`${prefix}-${item.lat},${item.lng},${idx}`}
            type="button"
            data-testid={`home-map-search-${prefix}-${idx}`}
            className="menu-row menu-item"
            onClick={(e) => onPick(item, e.clientX, e.clientY)}
            style={{
              display: "block",
              ...rowStyle,
              width: "100%",
              textAlign: "left",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              border: "none",
              background: "transparent",
              color: "inherit",
              cursor: "pointer",
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
    );

  return (
    <div>
      {section("home.map_search_frequent", frequent, "frequent")}
      {section("home.map_search_recent", recent, "recent")}
      <button
        type="button"
        data-testid="home-map-search-clear-history"
        onClick={onClear}
        style={{
          display: "block",
          width: "100%",
          textAlign: "left",
          padding: "6px 8px",
          fontSize: "var(--text-xs)",
          color: "var(--muted)",
          border: "none",
          background: "transparent",
          cursor: "pointer",
        }}
      >
        {t("home.map_search_clear_history")}
      </button>
    </div>
  );
}
