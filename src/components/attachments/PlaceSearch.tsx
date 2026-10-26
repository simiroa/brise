/**
 * 장소 검색 입력 + 결과 목록의 공용 조각 — NoteRegionsList(지역 팝오버)와 RegionEntryPopover(슬래시
 * /지역) 가 똑같은 geocode 검색·키보드 탐색·결과 렌더를 따로 들고 있던 것을 한 곳으로 모았다.
 *
 * 입력은 ARIA combobox, 목록은 listbox/option 이다. ↑↓ 로 선택을 옮기고 Enter 로 확정하며(선택이
 * 없으면 Enter 는 디바운스를 건너뛰는 즉시 검색), Esc 는 `onEscape` 가 있을 때만 가로챈다. 한글 IME
 * 조합 중의 Enter/방향키는 조합 확정용이라 무시한다.
 */
import React, { useEffect, useId, useRef, useState } from "react";
import { t } from "../../i18n/t";
import { useGeocodeSearch, type GeocodeResultItem, type GeocodeSearch } from "../../lib/useGeocodeSearch";
import { splitPlaceLabel } from "../../lib/placeLabel";

interface Options {
  query: string;
  uiLang: string;
  onPick: (item: GeocodeResultItem) => void;
  /** 있으면 Esc 를 가로채(전파 중단) 이것을 부른다. 없으면 Esc 는 그대로 흘려보낸다. */
  onEscape?: () => void;
  /** 확정 중(저장 왕복)에는 Enter/클릭으로 또 확정되지 않게 한다. */
  disabled?: boolean;
  /** 이미 등록된 장소인지(약 50m 이내) — 참이면 결과 행을 비활성("등록됨")으로 보이고 고를 수 없다. 알림 대신 가드. */
  isRegistered?: (item: GeocodeResultItem) => boolean;
}

export interface PlaceSearchBinding {
  search: GeocodeSearch;
  activeIndex: number;
  setActiveIndex: (i: number) => void;
  listId: string;
  /** 결과 목록이 실제로 떠 있는지(로딩·실패 중이면 false). */
  showList: boolean;
  /** `<input>` 에 펼친다. */
  inputProps: React.InputHTMLAttributes<HTMLInputElement>;
  onPick: (item: GeocodeResultItem) => void;
  disabled: boolean;
  isRegistered: (item: GeocodeResultItem) => boolean;
}

export function usePlaceSearch({ query, uiLang, onPick, onEscape, disabled = false, isRegistered = () => false }: Options): PlaceSearchBinding {
  const search = useGeocodeSearch(query, uiLang);
  const [activeIndex, setActiveIndex] = useState(-1);
  const listId = useId();
  const { results, searching, unavailable } = search;
  const showList = !searching && !unavailable && results.length > 0;

  // 결과가 바뀌면 선택은 처음부터(없음)다 — 옛 인덱스가 새 목록의 엉뚱한 항목을 가리키지 않게.
  useEffect(() => {
    setActiveIndex(-1);
  }, [results]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!showList) return;
      e.preventDefault();
      const n = results.length;
      setActiveIndex((i) => (e.key === "ArrowDown" ? (i + 1) % n : i <= 0 ? n - 1 : i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (showList && activeIndex >= 0 && activeIndex < results.length) {
        if (!disabled && !isRegistered(results[activeIndex])) onPick(results[activeIndex]);
      } else {
        search.searchNow();
      }
    } else if (e.key === "Escape" && onEscape) {
      e.preventDefault();
      e.stopPropagation();
      onEscape();
    }
  };

  return {
    search,
    activeIndex,
    setActiveIndex,
    listId,
    showList,
    onPick,
    disabled,
    isRegistered,
    inputProps: {
      role: "combobox",
      "aria-autocomplete": "list",
      "aria-expanded": showList,
      "aria-controls": listId,
      "aria-activedescendant": showList && activeIndex >= 0 ? `${listId}-opt-${activeIndex}` : undefined,
      onKeyDown,
      ...search.compositionProps,
    },
  };
}

/** 검색 상태(로딩·실패+다시 시도·빈 결과·너무 짧음) + 결과 목록. */
export function PlaceSearchResults({
  binding,
  query,
  testIdPrefix,
  maxHeight = 160,
}: {
  binding: PlaceSearchBinding;
  query: string;
  /** `${prefix}-${idx}` 가 결과 행, `${prefix}-retry` 가 다시 시도 버튼, `${prefix}-empty` 가 빈 결과. */
  testIdPrefix: string;
  maxHeight?: number;
}) {
  const { search, activeIndex, setActiveIndex, listId, showList, onPick, disabled, isRegistered } = binding;
  const listRef = useRef<HTMLDivElement>(null);

  // 키보드로 선택을 옮기면 그 행이 보이게 — 이 컨테이너의 scrollTop 만 민다(scrollIntoView 는
  // position:fixed 팝오버에서 조상까지 밀 수 있다 — NoteRegionsList 의 rowsRef effect 와 같은 이유).
  useEffect(() => {
    const c = listRef.current;
    if (!c || activeIndex < 0) return;
    const el = c.children[activeIndex] as HTMLElement | undefined;
    if (!el) return;
    const cr = c.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    if (er.bottom > cr.bottom) c.scrollTop += er.bottom - cr.bottom;
    else if (er.top < cr.top) c.scrollTop -= cr.top - er.top;
  }, [activeIndex]);

  const hint: React.CSSProperties = { fontSize: "var(--text-xs)", padding: "var(--space-2) var(--space-3)" };

  return (
    <>
      {search.searching && <div style={{ ...hint, color: "var(--muted)" }}>{t("common.loading")}</div>}
      {search.unavailable && !search.searching && (
        <div
          role="alert"
          style={{ ...hint, display: "flex", alignItems: "center", gap: "var(--space-3)", color: "var(--danger-soft)" }}
        >
          <span style={{ flex: 1, minWidth: 0 }}>{t("note.search_unavailable")}</span>
          <button
            type="button"
            className="tag-btn"
            data-testid={`${testIdPrefix}-retry`}
            onClick={search.searchNow}
            style={{ fontSize: "var(--text-xs)", fontWeight: 400, flex: "none" }}
          >
            {t("region.search_retry")}
          </button>
        </div>
      )}
      {search.tooShort && !search.searching && (
        <div style={{ ...hint, color: "var(--faint)" }}>{t("region.search_too_short")}</div>
      )}
      {showList && (
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          className="scroll"
          style={{ display: "flex", flexDirection: "column", gap: "var(--space-2xs)", maxHeight, overflowY: "auto" }}
        >
          {search.results.map((item, idx) => {
            const { name, detail } = splitPlaceLabel(item.label);
            const active = idx === activeIndex;
            const registered = isRegistered(item);
            const blocked = disabled || registered;
            return (
              <div
                key={`${item.lat},${item.lng},${idx}`}
                id={`${listId}-opt-${idx}`}
                role="option"
                aria-selected={active}
                aria-disabled={blocked || undefined}
                data-registered={registered ? "true" : undefined}
                data-testid={`${testIdPrefix}-${idx}`}
                data-selected={active ? "true" : undefined}
                title={item.label}
                className="menu-row menu-item"
                onMouseEnter={() => setActiveIndex(idx)}
                onClick={() => {
                  if (!blocked) onPick(item);
                }}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "stretch",
                  gap: 0,
                  padding: "var(--space-1) var(--space-2)",
                  cursor: blocked ? "default" : "pointer",
                  opacity: blocked ? 0.6 : 1,
                  minWidth: 0,
                }}
              >
                <span
                  style={{
                    fontSize: "var(--text-xs)",
                    fontWeight: 600,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {name || item.label}
                  {registered && (
                    <span style={{ marginLeft: "var(--space-2)", fontWeight: 400, color: "var(--faint)" }}>
                      {t("region.registered")}
                    </span>
                  )}
                </span>
                {detail && (
                  <span
                    style={{
                      fontSize: "var(--text-xs)",
                      color: "var(--muted)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {detail}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
      {!search.searching && !search.unavailable && !search.tooShort && query.trim() && search.results.length === 0 && (
        <div data-testid={`${testIdPrefix}-empty`} style={{ ...hint, color: "var(--faint)" }}>
          —
        </div>
      )}
    </>
  );
}
