import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useSearchStore } from "../../../stores/search";
import { useSettingsStore } from "../../../stores/settings";
import { useTaxonomyStore } from "../../../stores/taxonomy";
import { useUiStore } from "../../../stores/ui";
import { useTabsStore, HOME_TAB_ID } from "../../../stores/tabs";
import { t } from "../../../i18n/t";
import { clamp, useFloatingPopover } from "../../../lib/ui";
import { IconPlus, IconMaximize2, IconCaret } from "../../icons";
import { TimelineBrush } from "../../home/timeline/Brush";
import { useYearBounds, draftInputStyle } from "./shared";
import { yearRangeLabel, yearRangeDisplay, expandToYearAxis, isFullYearRange, yearDensity, densityMarkWidth } from "./yearAxis";
import { useElementSize } from "../../../lib/useElementSize";
import { Select, type SelectOption } from "../../Select";

type YearPair = { from: number; to: number };

/* ── Year filter: Timeline ── */
export function TimelineFilter() {
  const yearBounds = useYearBounds();
  const { min: MIN_YEAR, max: MAX_YEAR } = yearBounds;
  const yearFrom = useSearchStore((s) => s.yearFrom);
  const yearTo = useSearchStore((s) => s.yearTo);
  const setYearRange = useSearchStore((s) => s.setYearRange);
  const yearCounts = useSearchStore((s) => s.yearCounts);
  const trackRef = useRef<HTMLDivElement>(null);

  // Axis zoom domain. null = full corpus yearBounds.
  const [zoomDomain, setZoomDomain] = useState<YearPair | null>(null);

  // Direct range edit popover (E-2) — from–to only. 기간(era) 목록/추가는 EraChips 한 벌뿐이고
  // 아래 슬라이더 밑에 붙는다: 여기 중첩하면 EraChips 의 Select/추가 팝오버가 body 로 portal 돼
  // 이 팝오버의 useDismiss 에 "바깥 클릭"으로 잡혀 부모째 닫힌다.
  const [editOpen, setEditOpen] = useState(false);
  const [editFrom, setEditFrom] = useState(String(yearFrom));
  const [editTo, setEditTo] = useState(String(yearTo));
  const [editError, setEditError] = useState<string | null>(null);
  const { anchorRef: rangeReadoutRef, popRef: editPopRef, x: editX, y: editY } =
    useFloatingPopover<HTMLButtonElement>(editOpen, () => setEditOpen(false));

  const startEditRange = () => {
    // 라벨과 같은 숫자로 연다(QA7 — 읽은 숫자와 입력칸 숫자가 달랐던 클릭 버그).
    const shown = yearRangeDisplay(yearFrom, yearTo, yearBounds);
    setEditFrom(String(shown.from));
    setEditTo(String(shown.to));
    setEditError(null);
    setEditOpen(true);
  };

  const commitEditRange = () => {
    const f = parseInt(editFrom, 10);
    const tVal = parseInt(editTo, 10);
    if (!Number.isFinite(f) || !Number.isFinite(tVal) || f > tVal) {
      setEditError(t("search.era_invalid_range"));
      return;
    }
    const wide = expandToYearAxis(f, tVal, yearBounds);
    const cFrom = clamp(wide.from, MIN_YEAR, MAX_YEAR);
    const cTo = clamp(wide.to, MIN_YEAR, MAX_YEAR);
    setYearRange(cFrom, cTo);
    setEditOpen(false);
  };

  // yearBounds identity change → drop a stale zoom that may point outside the new corpus.
  useEffect(() => {
    setZoomDomain(null);
  }, [MIN_YEAR, MAX_YEAR]);

  const axisMin = zoomDomain ? zoomDomain.from : MIN_YEAR;
  const axisMax = zoomDomain ? zoomDomain.to : MAX_YEAR;
  const isZoomed = zoomDomain !== null;

  // If an external filter (era chip, etc.) lands outside the zoomed axis, restore full domain
  // so the readout and axis never disagree about where the selection lives.
  useEffect(() => {
    if (!zoomDomain) return;
    if (yearFrom < zoomDomain.from || yearTo > zoomDomain.to) {
      setZoomDomain(null);
    }
  }, [yearFrom, yearTo, zoomDomain]);

  const currentFrom = yearFrom;
  const currentTo = yearTo;

  const atFullRange = isFullYearRange(currentFrom, currentTo, yearBounds);
  // 라벨은 노트가 실제로 있는 해로 자른 선택 구간 — 축의 패딩 연도는 이름에 넣지 않는다(yearAxis.ts).
  const rangeLabel = yearRangeLabel(currentFrom, currentTo, yearBounds);
  const labelMuted = atFullRange;

  // 눈금 px 는 트랙의 **실측** 폭으로 잡는다. 예전엔 leftWidth-44 로 어림했는데 실제 트랙은
  // leftWidth − 사이드바 패딩·브러시 래퍼 패딩이라 몇 px 어긋났다. 어림값은 측정 전 폴백으로만.
  const leftWidth = useSettingsStore((s) => s.leftWidth);
  const { width: trackWidth } = useElementSize(trackRef, { width: Math.max(0, leftWidth - 44), height: 46 });

  // 눈금은 그 해의 **위치에 가운데** 맞춘다(예전엔 왼쪽 끝이 해에 붙어 눈금이 오른쪽으로 치우쳤다).
  // 폭 = 노트 수(2px/건, 2~8px) — 노트가 4건 이상인 해는 8×8 정사각형이 된다(의도된 밀도 표시).
  const marks = useMemo(() => {
    if (trackWidth <= 0) return [];
    return yearDensity(yearCounts, axisMin, axisMax).map(({ year, frac, count }) => {
      const width = densityMarkWidth(count);
      return { left: frac * trackWidth - width / 2, width, key: String(year) };
    });
  }, [yearCounts, axisMin, axisMax, trackWidth]);

  const resetZoom = () => {
    setZoomDomain(null);
    setYearRange(MIN_YEAR, MAX_YEAR);
  };

  // Active era check
  const customEras = useTaxonomyStore((s) => s.eras);
  const activeEra = customEras.find(
    (era) => yearFrom === era.from_year && yearTo === era.to_year,
  );

  return (
    <div data-perf="year-slider" style={{ marginTop: "var(--space-4)", flex: "none", display: "flex", flexDirection: "column" }}>
      <div style={{ marginBottom: "var(--space-2)" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr", alignItems: "center" }}>
          <span aria-hidden />
          <button
            ref={rangeReadoutRef}
            type="button"
            onClick={startEditRange}
            title={t("search.timeline_range_edit")}
            aria-label={t("search.timeline_range_edit")}
            aria-haspopup="dialog"
            aria-expanded={editOpen}
            data-testid="timeline-range-readout-btn"
            className="timeline-range-chip"
            data-active={editOpen || Boolean(activeEra) ? "true" : undefined}
          >
            <span
              style={{
                fontFamily: "var(--font-heading)",
                fontWeight: 600,
                fontVariantNumeric: "tabular-nums",
                fontSize: "var(--text-md)",
                lineHeight: 1,
                color: labelMuted && !activeEra ? "var(--muted)" : "var(--accent)",
                transition: "color var(--dur-med) ease",
                whiteSpace: "nowrap",
              }}
            >
              {rangeLabel}
            </span>
            {activeEra && (
              <span
                style={{
                  fontSize: "var(--text-xs)",
                  fontWeight: 400,
                  color: "var(--text-muted, var(--muted))",
                  maxWidth: 90,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                · {activeEra.name}
              </span>
            )}
            <IconCaret dir={editOpen ? "up" : "down"} size={11} style={{ opacity: 0.7, marginLeft: "var(--space-2xs)" }} />
          </button>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button
              type="button"
              data-testid="timeline-open-dashboard"
              className="icon-btn icon-btn--sm icon-btn--glow"
              title={t("search.timeline_open_dashboard")}
              aria-label={t("search.timeline_open_dashboard")}
              onClick={() => {
                useUiStore.getState().setHomeInnerTab("timeline");
                useTabsStore.getState().setActiveTab(HOME_TAB_ID);
              }}
            >
              <IconMaximize2 size={14} strokeWidth={2} />
            </button>
          </div>
        </div>
        {editOpen &&
          createPortal(
            <div
              ref={editPopRef}
              role="dialog"
              aria-label={t("search.timeline_range_edit")}
              data-testid="timeline-range-edit-dialog"
              className="overlay timeline-range-menu"
              style={{
                position: "fixed",
                top: editY,
                left: editX,
                zIndex: "var(--z-dropdown)",
              }}
            >
              {/* 직접 범위 입력 섹션 */}
              <div className="timeline-range-menu-section">
                <div className="timeline-range-menu-title">
                  <span>{t("search.timeline_range_edit")}</span>
                  {!atFullRange && (
                    <button
                      type="button"
                      onClick={() => {
                        resetZoom();
                        setEditOpen(false);
                      }}
                      style={{
                        background: "none",
                        border: "none",
                        padding: 0,
                        color: "var(--muted)",
                        fontSize: "var(--text-2xs)",
                        cursor: "pointer",
                        textDecoration: "underline",
                      }}
                    >
                      {t("search.timeline_show_all")}
                    </button>
                  )}
                </div>
                <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: "var(--space-1)" }}>
                  <input
                    autoFocus
                    value={editFrom}
                    onChange={(e) => {
                      setEditFrom(e.target.value.replace(/[^-\d]/g, ""));
                      setEditError(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitEditRange();
                      if (e.key === "Escape") setEditOpen(false);
                    }}
                    placeholder={t("search.era_from_placeholder")}
                    inputMode="numeric"
                    style={{ ...draftInputStyle, width: 68, textAlign: "center" }}
                  />
                  <span style={{ color: "var(--faint)" }}>&ndash;</span>
                  <input
                    value={editTo}
                    onChange={(e) => {
                      setEditTo(e.target.value.replace(/[^-\d]/g, ""));
                      setEditError(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitEditRange();
                      if (e.key === "Escape") setEditOpen(false);
                    }}
                    placeholder={t("search.era_to_placeholder")}
                    inputMode="numeric"
                    style={{ ...draftInputStyle, width: 68, textAlign: "center" }}
                  />
                  <button type="button" onClick={commitEditRange} style={popoverConfirmBtnStyle}>
                    {t("search.era_confirm")}
                  </button>
                </div>
                {editError && (
                  <div
                    role="alert"
                    style={{
                      fontSize: "var(--text-2xs)",
                      color: "var(--danger)",
                      lineHeight: 1.3,
                      marginTop: "var(--space-2xs)",
                    }}
                  >
                    {editError}
                  </div>
                )}
              </div>

              {/* 시대(Era) 프리셋 선택 및 추가 통합 섹션 */}
              <div
                style={{
                  borderTop: "1px solid var(--divider)",
                  paddingTop: "var(--space-2)",
                  marginTop: "var(--space-1)",
                }}
              >
                <div className="timeline-range-menu-title" style={{ marginBottom: "var(--space-1)" }}>
                  <span>{t("search.era_select")}</span>
                </div>
                <EraChips />
              </div>
            </div>,
            document.body,
          )}
        {(isZoomed || !atFullRange) && (
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "var(--space-2xs)" }}>
            <button
              type="button"
              onClick={resetZoom}
              title={t("search.timeline_show_all")}
              aria-label={t("search.timeline_show_all")}
              style={{
                border: "none",
                background: "none",
                padding: 0,
                font: "inherit",
                fontSize: "var(--text-xs)",
                color: "var(--muted)",
                cursor: "pointer",
                whiteSpace: "nowrap",
                textDecoration: "underline",
                textUnderlineOffset: 2,
              }}
            >
              {t("search.timeline_show_all")}
            </button>
          </div>
        )}
      </div>

      {/* Shared TimelineBrush component */}
      <div style={{ padding: "0 var(--space-2)" }}>
        <TimelineBrush
          trackRef={trackRef}
          full={{ from: axisMin, to: axisMax }}
          view={{ from: currentFrom, to: currentTo }}
          width={trackWidth}
          marks={marks}
          onViewChange={(from, to) => {
            // U-9: 데이터 끝을 넘긴 브러시는 축 끝(패딩 포함)으로 확정한다.
            const wide = expandToYearAxis(Math.round(from), Math.round(to), yearBounds);
            setYearRange(wide.from, wide.to);
          }}
        />
      </div>
    </div>
  );
}

/* ── Timeline: 시대(era) 구간 빠른 선택 드롭다운 ──
   Wave B: 칩 나열 대신 Select 드롭다운으로 정리.
   기간 추가(+)는 드롭다운 옆 버튼으로, 삭제는 드롭다운 각 옵션 항목의 보조 액션으로 동작한다.
   Exported so the dashboard Timeline tab can surface the same "기간 추가/선택" control without
   reimplementing add/remove/select (W2 discoverability) — single handler, two mounts. */
export function EraChips() {
  const yearFrom = useSearchStore((s) => s.yearFrom);
  const yearTo = useSearchStore((s) => s.yearTo);
  const setYearRange = useSearchStore((s) => s.setYearRange);
  const yearBounds = useSearchStore((s) => s.yearBounds);
  const customEras = useTaxonomyStore((s) => s.eras);
  const addEra = useTaxonomyStore((s) => s.addEra);
  const removeEra = useTaxonomyStore((s) => s.removeEra);

  const [open, setOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [fromDraft, setFromDraft] = useState("");
  const [toDraft, setToDraft] = useState("");
  const [addError, setAddError] = useState<string | null>(null);

  const cancelAdd = () => {
    setOpen(false);
    setNameDraft("");
    setFromDraft("");
    setToDraft("");
    setAddError(null);
  };
  // 인라인 폼이다 — 떠 있는 팝오버가 아니다. 이게 열리는 두 자리(대시보드 헤더의 「기간 선택」
  // 모달, 좌측 필터)가 둘 다 이미 갇힌 공간이라, 포털·위치계산·바깥클릭 해제를 얹으면 모달 위에
  // 또 한 겹이 떠서 표면이 두 장으로 보였다(오너 스크린샷 2026-09-09).
  /**
   * Clamp era ends into the live corpus axis (same bounds the slider uses).
   * Partial overshoot (1800–5000 on a corpus ending 1900) becomes 1800–1900 and still saves —
   * refuse would punish a usable range. Fully outside / inverted still fails with a message
   * (silent no-op was already bad for to <= from).
   */
  const commitAdd = () => {
    const name = nameDraft.trim();
    const fromRaw = parseInt(fromDraft, 10);
    const toRaw = parseInt(toDraft, 10);
    if (!name || !Number.isFinite(fromRaw) || !Number.isFinite(toRaw)) return;
    if (!(toRaw > fromRaw)) {
      setAddError(t("search.era_invalid_range"));
      return;
    }
    const { min, max } = yearBounds;
    const from = Math.min(Math.max(fromRaw, min), max);
    const to = Math.min(Math.max(toRaw, min), max);
    if (!(to > from)) {
      setAddError(t("search.era_out_of_bounds", { min, max }));
      return;
    }
    void addEra(name, from, to);
    cancelAdd();
  };
  const onDraftKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitAdd();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      cancelAdd();
    }
  };

  const activeEra = customEras.find(
    (era) => yearFrom === era.from_year && yearTo === era.to_year,
  );

  const options: SelectOption[] = useMemo(() => {
    if (customEras.length === 0) {
      return [
        {
          value: "",
          label: t("search.era_none"),
          disabled: true,
        },
      ];
    }
    return [
      {
        value: "",
        label: t("search.era_select"),
      },
      ...customEras.map((era) => ({
        value: era.id,
        label: `${era.name} (${era.from_year}–${era.to_year})`,
        onRemove: () => void removeEra(era.id),
        removeLabel: t("search.era_remove_custom", { name: era.name }),
      })),
    ];
  }, [customEras, removeEra]);

  const onSelectChange = (value: string) => {
    if (!value) return;
    const era = customEras.find((e) => e.id === value);
    if (era) {
      setYearRange(era.from_year, era.to_year);
    }
  };

  return (
    // 바깥 여백 없음 — 대시보드 헤더는 이걸 flex 행 안에 세로 가운데로 두고, 좌측 필터는
    // 슬라이더 밑에 간격을 두고 놓는다. 간격은 각 마운트 지점이 정한다.
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)", flex: "none", minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-1)", minWidth: 0 }}>
        {/* 크기·글자는 .field-select 가 소유한다 — 인라인 fontSize/padding 으로 덮으면 옆의
            .field 입력·.icon-btn 과 높이가 어긋난다(그게 "요소마다 스타일이 다른" 정체였다). */}
        <Select
          value={activeEra ? activeEra.id : ""}
          onChange={onSelectChange}
          options={options}
          ariaLabel={t("search.era_select")}
          testid="timeline-era-select"
          style={{ flex: 1, minWidth: 0 }}
        />
        <button
          type="button"
          onClick={() => (open ? cancelAdd() : setOpen(true))}
          title={t("search.era_add")}
          aria-label={t("search.era_add")}
          aria-expanded={open}
          className="icon-btn icon-btn--lg"
          data-active={open ? "true" : undefined}
        >
          <IconPlus size={15} strokeWidth={2} />
        </button>
      </div>

      {open && (
        <div
          role="group"
          aria-label={t("search.era_add")}
          data-testid="era-add-form"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-2)",
            paddingTop: "var(--space-2)",
            borderTop: "1px solid var(--divider)",
          }}
        >
          <input
            autoFocus
            className="field"
            value={nameDraft}
            onChange={(e) => {
              setNameDraft(e.target.value);
              setAddError(null);
            }}
            onKeyDown={onDraftKeyDown}
            placeholder={t("search.era_name_placeholder")}
          />
          <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "center" }}>
            <input
              className="field"
              value={fromDraft}
              onChange={(e) => {
                setFromDraft(e.target.value.replace(/[^-\d]/g, ""));
                setAddError(null);
              }}
              onKeyDown={onDraftKeyDown}
              placeholder={t("search.era_from_placeholder")}
              inputMode="numeric"
              style={{ flex: 1, minWidth: 0, textAlign: "center" }}
            />
            <span aria-hidden style={{ color: "var(--faint)" }}>&ndash;</span>
            <input
              className="field"
              value={toDraft}
              onChange={(e) => {
                setToDraft(e.target.value.replace(/[^-\d]/g, ""));
                setAddError(null);
              }}
              onKeyDown={onDraftKeyDown}
              placeholder={t("search.era_to_placeholder")}
              inputMode="numeric"
              style={{ flex: 1, minWidth: 0, textAlign: "center" }}
            />
          </div>
          {addError && (
            <div role="alert" style={{ fontSize: "var(--text-xs)", color: "var(--danger)", lineHeight: 1.3 }}>
              {addError}
            </div>
          )}
          <div style={{ display: "flex", gap: "var(--space-2)", justifyContent: "flex-end" }}>
            <button type="button" className="btn btn--sm" onClick={cancelAdd}>
              {t("search.era_cancel")}
            </button>
            <button type="button" className="btn btn-primary btn--sm" onClick={commitAdd}>
              {t("search.era_confirm")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const popoverConfirmBtnStyle: React.CSSProperties = {
  padding: "var(--space-1) var(--space-4)",
  border: "1px solid var(--accent)",
  borderRadius: "var(--radius-sm)",
  background: "transparent",
  color: "var(--accent)",
  fontSize: "var(--text-xs)",
  fontWeight: 600,
  cursor: "pointer",
};
