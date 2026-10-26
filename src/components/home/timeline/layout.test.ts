import { describe, it, expect } from "vitest";
import type { TimelineNoteItem } from "../../../lib/commands.gen";
import type { PackedItem } from "./layout";
import {
  assignItemLanes,
  bucketByYear,
  bucketByStep,
  isTimelineDense,
  formatBucketLabel,
  itemIntersectsView,
  yearToX,
  xToYear,
  tickStepForSpan,
  tickStepForView,
  AXIS_TICK_MIN_PX,
  MINOR_TICK_MIN_PX,
  minorTickStepForView,
  yearTicks,
  clampView,
  defaultTimelineView,
  isYearFilterNarrowed,
  resolveTimelineView,
  zoomView,
  shouldShowLabels,
  MIN_VIEW_SPAN,
  dateToFractionalYear,
  itemTimeRange,
  daysInYear,
  TICK_STEP_DAY,
  TICK_STEP_MONTH,
  TICK_STEPS,
  TICK_STEP_WEEK,
  FIT_MIN_SPAN,
  endDateBeforeBoundary,
  fitViewToItems,
  fractionalYearToDate,
  nearestTick,
  precisionRange,
  snapUnitForStep,
  snapYearToStep,
  startDateAtBoundary,
  tripleToFraction,
  coarserUnit,
  laneGeometry,
  shiftTriple,
  unitsBetween,
  BAR_HEIGHT,
  LANE_HEIGHT,
  LANE_TOP_PAD,
  SUB_LANE_PITCH,
  pointLabelMaxWidth,
  LABEL_MIN_GAP_PX,
  LABEL_GAP_PAD_PX,
} from "./layout";

function item(
  partial: Partial<TimelineNoteItem> & Pick<TimelineNoteItem, "note_id" | "year">,
): TimelineNoteItem {
  return {
    title: partial.title ?? partial.note_id,
    kind: partial.kind ?? (partial.end_year != null ? "bar" : "point"),
    month: partial.month ?? null,
    day: partial.day ?? null,
    end_year: partial.end_year ?? null,
    end_month: partial.end_month ?? null,
    end_day: partial.end_day ?? null,
    folder_id: partial.folder_id ?? "f1",
    ...partial,
  };
}

const TEST_VIEW = { from: 0, to: 3000 };
const TEST_WIDTH = 1000;

describe("assignItemLanes (single canvas since 2026-08-09)", () => {
  it("every item lands on lane 0 regardless of folder — no per-folder lane anymore", () => {
    const items = [
      item({ note_id: "a1", year: 1794, folder_id: "fA" }),
      item({ note_id: "b1", year: 1795, folder_id: "fB" }),
      item({ note_id: "c1", year: 1000, folder_id: "unresolvable-folder" }),
    ];
    const packed = assignItemLanes(items, TEST_VIEW, TEST_WIDTH);
    expect(packed.every((p) => p.lane === 0)).toBe(true);
  });

  it("non-overlapping bars from different folders still share sub-lane 0 (single row, not one per folder)", () => {
    const packed = assignItemLanes([
      item({ note_id: "a", year: 1990, end_year: 1995, folder_id: "fA" }),
      item({ note_id: "b", year: 2000, end_year: 2005, folder_id: "fB" }), // disjoint from a
    ], TEST_VIEW, TEST_WIDTH);
    const by = (id: string) => packed.find((p) => p.noteId === id)!;
    expect(by("a").subLane).toBe(0);
    expect(by("b").subLane).toBe(0);
  });

  it("overlapping bars (any folders) drop into sub-lane 1+ — the greedy packer, reused as-is", () => {
    const packed = assignItemLanes([
      item({ note_id: "a", year: 1990, end_year: 1995, folder_id: "fA" }),
      item({ note_id: "b", year: 1992, end_year: 1997, folder_id: "fB" }), // overlaps a, different folder
    ], TEST_VIEW, TEST_WIDTH);
    const by = (id: string) => packed.find((p) => p.noteId === id)!;
    expect(by("a").subLane).toBe(0);
    expect(by("b").subLane).toBe(1);
  });

  it("assigns kind=bar when end_year is set even if kind string is wrong", () => {
    const packed = assignItemLanes([
      item({ note_id: "x", year: 1, end_year: 3, kind: "point", folder_id: "fA" }),
    ], TEST_VIEW, TEST_WIDTH);
    expect(packed[0]!.kind).toBe("bar");
    // Year-only end expands to end of year 3 → exclusive 4.
    expect(packed[0]!.endYear).toBe(4);
  });

  it("day-precision note lands at the correct fractional year position", () => {
    // 2026-08-03 (non-leap): day-of-year 215 → frac = 2026 + 214/365
    const packed = assignItemLanes([
      item({ note_id: "d", year: 2026, month: 8, day: 3, folder_id: "fA" }),
    ], TEST_VIEW, TEST_WIDTH);
    const expected = dateToFractionalYear(2026, 8, 3);
    expect(packed[0]!.kind).toBe("point");
    expect(packed[0]!.startYear).toBeCloseTo(expected, 10);
    expect(packed[0]!.endYear).toBeCloseTo(expected, 10);
    expect(expected).toBeCloseTo(2026 + 214 / 365, 10);
  });

  it("year-only note spans the full year as a bar (not a Jan-1 point)", () => {
    const packed = assignItemLanes([
      item({ note_id: "y", year: 1592, month: null, day: null, kind: "point", folder_id: "fA" }),
    ], TEST_VIEW, TEST_WIDTH);
    expect(packed[0]!.kind).toBe("bar");
    expect(packed[0]!.startYear).toBe(1592);
    expect(packed[0]!.endYear).toBe(1593);
  });

  it("month-only note spans the whole month; leap years count Feb 29", () => {
    const r = itemTimeRange(
      item({ note_id: "m", year: 2024, month: 2, day: null, folder_id: "fA" }),
    );
    expect(r.kind).toBe("bar");
    expect(r.start).toBeCloseTo(dateToFractionalYear(2024, 2, 1), 10);
    expect(r.end).toBeCloseTo(dateToFractionalYear(2024, 3, 1), 10);
    expect(daysInYear(2024)).toBe(366);
    // Feb 29 2024 is day 60 → frac = 2024 + 59/366
    expect(dateToFractionalYear(2024, 2, 29)).toBeCloseTo(2024 + 59 / 366, 10);
  });
});

describe("bucketByYear", () => {
  it("aggregates counts per year", () => {
    const counts = bucketByYear([{ year: 1900 }, { year: 1900 }, { year: 1950 }]);
    expect(counts.get(1900)).toBe(2);
    expect(counts.get(1950)).toBe(1);
    expect(counts.get(2000)).toBeUndefined();
  });
});

describe("isTimelineDense (Q12 기하학적 밀도 기반 판정)", () => {
  it("오늘날의 데이터(3년간 53개 아이템, subCount 5, 폭 1000px)는 dense가 아니다 (bars 렌더링)", () => {
    // 53 items / 1000px = 0.053 < 0.25, subCount = 5 < 25
    const dummyItems = Array.from({ length: 53 }, (_, i) => ({
      noteId: `n${i}`,
      title: `Item ${i}`,
      kind: "point" as const,
      startYear: 2026 + (i * 3) / 53,
      endYear: 2026 + (i * 3) / 53,
      folderId: "f1",
      lane: 0,
      subLane: i % 5,
      precision: "day" as const,
    }));
    expect(isTimelineDense(dummyItems, 1000, 5)).toBe(false);
  });

  it("한 달에 500개가 몰린 합성 데이터는 dense로 판정된다 (버킷 모드 전환)", () => {
    const crowdedItems = Array.from({ length: 500 }, (_, i) => ({
      noteId: `c${i}`,
      title: `Crowded ${i}`,
      kind: "point" as const,
      startYear: 2026 + i * (1 / 12 / 500),
      endYear: 2026 + i * (1 / 12 / 500),
      folderId: "f1",
      lane: 0,
      subLane: i % 40,
      precision: "day" as const,
    }));
    // 500 items / 1000px = 0.5 > 0.25, subCount = 40 > 25
    expect(isTimelineDense(crowdedItems, 1000, 40)).toBe(true);
  });

  it("아이템이 없으면 false", () => {
    expect(isTimelineDense([], 1000, 0)).toBe(false);
  });
});

describe("bucketByStep (Q12 눈금 단위 버킷팅)", () => {
  it("step=1 (연 단위) 버킷: [year, year+1) 구간으로 묶임", () => {
    const items = [
      { startYear: 2026.1 },
      { startYear: 2026.8 },
      { startYear: 2027.2 },
    ];
    const buckets = bucketByStep(items, 1);
    expect(buckets).toHaveLength(2);
    expect(buckets[0]).toEqual({ year: 2026, endYear: 2027, count: 2 });
    expect(buckets[1]).toEqual({ year: 2027, endYear: 2028, count: 1 });
  });

  it("step=1/12 (월 단위) 버킷: 한 달에 500개 아이템이 월 버킷으로 묶임", () => {
    // 2026년 3월 (약 2026 + 2/12)
    const marchStart = 2026 + 2 / 12;
    const items = Array.from({ length: 500 }, (_, i) => ({
      startYear: marchStart + (i * 0.07) / 500,
    }));
    const buckets = bucketByStep(items, 1 / 12);
    expect(buckets.length).toBeGreaterThanOrEqual(1);
    const totalCount = buckets.reduce((sum, b) => sum + b.count, 0);
    expect(totalCount).toBe(500);
  });
});

describe("버킷 [year, year+1) 인터벌 교차 필터링 (Q12 결함 수정)", () => {
  it("2026-01-05(2026.008)부터 시작하는 뷰에서도 2026년 버킷 [2026, 2027)이 유지된다", () => {
    const viewFrom = 2026.008;
    const viewTo = 2029.32;
    const bucket = { year: 2026, endYear: 2027, count: 50 };

    // 예전 방식(단일 점): 2026 >= 2026.008 -> false (버킷 누락 버그)
    expect(itemIntersectsView(bucket.year, bucket.year, viewFrom, viewTo)).toBe(false);

    // 수정된 방식([year, year+1) 인터벌): 2027 >= 2026.008 -> true (정상 표시)
    expect(itemIntersectsView(bucket.year, bucket.endYear, viewFrom, viewTo)).toBe(true);

    // formatBucketLabel 툴팁 검증
    expect(formatBucketLabel(2026, 2027)).toBe("2026");
    expect(formatBucketLabel(2026, 2026 + 1 / 12)).toContain("2026-01");
  });
});

describe("itemIntersectsView / year mapping", () => {
  it("culls items fully left or right of the view", () => {
    expect(itemIntersectsView(900, 920, 1000, 1100)).toBe(false);
    expect(itemIntersectsView(1200, 1210, 1000, 1100)).toBe(false);
    expect(itemIntersectsView(1050, 1050, 1000, 1100)).toBe(true);
    // straddling edges stay
    expect(itemIntersectsView(990, 1010, 1000, 1100)).toBe(true);
    expect(itemIntersectsView(1090, 1110, 1000, 1100)).toBe(true);
  });

  it("yearToX / xToYear are inverses at endpoints", () => {
    const w = 800;
    expect(yearToX(1000, 1000, 1200, w)).toBeCloseTo(0);
    expect(yearToX(1200, 1000, 1200, w)).toBeCloseTo(w);
    expect(xToYear(0, 1000, 1200, w)).toBeCloseTo(1000);
    expect(xToYear(w, 1000, 1200, w)).toBeCloseTo(1200);
    expect(xToYear(yearToX(1100, 1000, 1200, w), 1000, 1200, w)).toBeCloseTo(1100);
  });
});

describe("ticks / clamp / zoom", () => {
  it("picks nicer steps for wider spans", () => {
    expect(tickStepForSpan(500)).toBe(100);
    expect(tickStepForSpan(80)).toBe(10);
    expect(tickStepForSpan(5)).toBe(1);
  });

  it("yearTicks aligns to step boundaries", () => {
    expect(yearTicks(903, 950, 10)).toEqual([910, 920, 930, 940, 950]);
  });

  it("tickStepForView picks the smallest step whose label spacing clears AXIS_TICK_MIN_PX", () => {
    const from = 1000;
    const to = 1200; // 200y span
    const wide = tickStepForView(from, to, 1600); // 8 px/year
    expect((wide * 1600) / (to - from)).toBeGreaterThanOrEqual(AXIS_TICK_MIN_PX);
    // A narrower viewport at the same span must not pick a *finer* step — labels would overlap.
    const narrow = tickStepForView(from, to, 400); // 2 px/year
    expect((narrow * 400) / (to - from)).toBeGreaterThanOrEqual(AXIS_TICK_MIN_PX);
    expect(narrow).toBeGreaterThanOrEqual(wide);
  });

  it("tick step crosses year → month → day at a fixed width as the span shrinks", () => {
    const width = 800;
    // Wide: multi-decade → year (or coarser) step
    const yearish = tickStepForView(2000, 2050, width);
    expect(yearish).toBeGreaterThanOrEqual(1);
    // ~half-year window: month step must be available and preferred over year
    const monthish = tickStepForView(2026, 2026.5, width);
    expect(monthish).toBeLessThan(1);
    expect(monthish).toBeGreaterThanOrEqual(TICK_STEP_MONTH - 1e-12);
    // ~10-day window: day step
    const dayish = tickStepForView(2026.5, 2026.5 + 10 / 365, width);
    expect(dayish).toBe(TICK_STEP_DAY);
    // Ladder order: finer as span shrinks
    expect(dayish).toBeLessThan(monthish);
    expect(monthish).toBeLessThan(yearish);
    // tickStepForSpan stays on the same ladder (invariant #5)
    expect(TICK_STEPS).toContain(tickStepForSpan(50));
    expect(TICK_STEPS).toContain(tickStepForSpan(0.4));
    expect(TICK_STEPS).toContain(tickStepForSpan(0.02));
  });

  it("yearTicks emits calendar month starts and day starts for sub-year steps", () => {
    const months = yearTicks(2026, 2026 + 3 / 12, TICK_STEP_MONTH);
    expect(months[0]).toBeCloseTo(dateToFractionalYear(2026, 1, 1), 10);
    expect(months.some((t) => Math.abs(t - dateToFractionalYear(2026, 2, 1)) < 1e-9)).toBe(true);
    const days = yearTicks(dateToFractionalYear(2026, 8, 1), dateToFractionalYear(2026, 8, 5), TICK_STEP_DAY);
    expect(days.length).toBeGreaterThanOrEqual(4);
    expect(days[0]).toBeCloseTo(dateToFractionalYear(2026, 8, 1), 10);
  });

  it("defaultTimelineView is system year ± 1 (Timeline tab only — not sidebar filter)", () => {
    expect(defaultTimelineView(2026)).toEqual({ from: 2025, to: 2027 });
    expect(defaultTimelineView(1)).toEqual({ from: 0, to: 2 });
    // No-arg form uses the real clock; just assert span and centering.
    const now = new Date().getFullYear();
    const d = defaultTimelineView();
    expect(d.to - d.from).toBe(2);
    expect(d.from).toBe(now - 1);
    expect(d.to).toBe(now + 1);
  });

  it("resolveTimelineView honours a pre-narrowed store period over today±1", () => {
    const full = { from: 1000, to: 2100 };
    const narrowed = {
      yearFrom: 1500,
      yearTo: 1700,
      yearBounds: { min: 900, max: 2020 },
    };
    expect(isYearFilterNarrowed(narrowed.yearFrom, narrowed.yearTo, narrowed.yearBounds)).toBe(
      true,
    );
    expect(resolveTimelineView(narrowed, full, 2026)).toEqual({ from: 1500, to: 1700 });

    // Full corpus filter → default today±1 clamped into full (not the full axis).
    const open = {
      yearFrom: 900,
      yearTo: 2020,
      yearBounds: { min: 900, max: 2020 },
    };
    expect(isYearFilterNarrowed(open.yearFrom, open.yearTo, open.yearBounds)).toBe(false);
    expect(resolveTimelineView(open, full, 2026)).toEqual({ from: 2025, to: 2027 });
  });

  it("resolveTimelineView treats a 'narrowed' period that still covers the full axis as open", () => {
    // Decade-padded yearBounds wider than the note-derived full axis: store period equals the
    // raw note min/max and counts as narrowed vs bounds, but after clamp it is the full axis.
    const full = { from: -241, to: 2075 };
    const almostFull = {
      yearFrom: -241,
      yearTo: 2075,
      yearBounds: { min: -250, max: 2080 },
    };
    expect(isYearFilterNarrowed(almostFull.yearFrom, almostFull.yearTo, almostFull.yearBounds)).toBe(
      true,
    );
    expect(resolveTimelineView(almostFull, full, 2026)).toEqual({ from: 2025, to: 2027 });
  });

  it("clampView enforces MIN_VIEW_SPAN and stays inside full range", () => {
    const c = clampView(1000, 1000, 900, 2000);
    // Float mid±half can be a few ulps under the constant — close is enough.
    expect(c.to - c.from).toBeCloseTo(MIN_VIEW_SPAN, 12);
    expect(c.from).toBeGreaterThanOrEqual(900);
    expect(c.to).toBeLessThanOrEqual(2000);
  });

  it("clampView preserves span when panning past an edge", () => {
    const c = clampView(850, 950, 900, 2000); // 100y span starting too low
    expect(c.to - c.from).toBe(100);
    expect(c.from).toBe(900);
  });

  it("zoom clamp refuses to exceed corpus bounds (no -241—2075 regression)", () => {
    const fullFrom = -241;
    const fullTo = 2075;
    // Try to zoom out past the corpus — must pin to full, never invent a wider window.
    const out = zoomView({ from: 1000, to: 1100 }, 100, fullFrom, fullTo);
    expect(out.from).toBe(fullFrom);
    expect(out.to).toBe(fullTo);
    // Try to pan/zoom past the left edge — stay inside.
    const pan = clampView(fullFrom - 500, fullFrom - 400, fullFrom, fullTo);
    expect(pan.from).toBeGreaterThanOrEqual(fullFrom);
    expect(pan.to).toBeLessThanOrEqual(fullTo);
    expect(pan.to - pan.from).toBeCloseTo(100, 5);
    // Zoom in past MIN_VIEW_SPAN floors at the min span, still inside corpus.
    let v = { from: 1500, to: 1600 };
    for (let i = 0; i < 40; i++) {
      v = zoomView(v, 0.5, fullFrom, fullTo, 1550);
    }
    expect(v.to - v.from).toBeGreaterThanOrEqual(MIN_VIEW_SPAN - 1e-12);
    expect(v.from).toBeGreaterThanOrEqual(fullFrom);
    expect(v.to).toBeLessThanOrEqual(fullTo);
  });

  it("zoomView zooms in around focus", () => {
    const z = zoomView({ from: 1000, to: 2000 }, 0.5, 900, 2100, 1500);
    expect(z.to - z.from).toBeLessThan(1000);
    // focus stays roughly centered in the new window
    const mid = (z.from + z.to) / 2;
    expect(Math.abs(mid - 1500)).toBeLessThan(50);
  });

  it("shouldShowLabels depends on px density", () => {
    expect(shouldShowLabels(1000, 2000, 100)).toBe(false); // 0.1 px/year
    expect(shouldShowLabels(1000, 1010, 800)).toBe(true);
  });
});

// ── W8-e: snapping, boundary↔date round-trips, fit, zoom slider ──────────────────────────────

describe("snapYearToStep", () => {
  it("picks the calendar unit the axis is showing", () => {
    expect(snapUnitForStep(5)).toBe("year");
    expect(snapUnitForStep(1)).toBe("year");
    expect(snapUnitForStep(TICK_STEP_MONTH)).toBe("month");
    expect(snapUnitForStep(TICK_STEP_WEEK)).toBe("day");
    expect(snapUnitForStep(TICK_STEP_DAY)).toBe("day");
  });

  it("year axis snaps to whole years — including a 5y step (unit, not step multiple)", () => {
    expect(snapYearToStep(1592.4, 1)).toBe(1592);
    expect(snapYearToStep(1592.7, 1)).toBe(1593);
    // 5y labels must not force dates onto 5y multiples: 1593 stays reachable.
    expect(snapYearToStep(1592.7, 5)).toBe(1593);
  });

  it("month axis snaps to the nearest month start", () => {
    const augStart = dateToFractionalYear(2026, 8, 1);
    const sepStart = dateToFractionalYear(2026, 9, 1);
    expect(snapYearToStep(dateToFractionalYear(2026, 8, 5), TICK_STEP_MONTH)).toBeCloseTo(augStart, 9);
    expect(snapYearToStep(dateToFractionalYear(2026, 8, 28), TICK_STEP_MONTH)).toBeCloseTo(sepStart, 9);
  });

  it("day axis snaps to the nearest day start", () => {
    const d = dateToFractionalYear(2026, 8, 5);
    const diy = daysInYear(2026);
    expect(snapYearToStep(d + 0.2 / diy, TICK_STEP_DAY)).toBeCloseTo(d, 9);
    expect(snapYearToStep(d + 0.8 / diy, TICK_STEP_DAY)).toBeCloseTo(d + 1 / diy, 9);
  });
});

describe("boundary ↔ date round-trip (what makes a ghost repaint where it was drawn)", () => {
  const cases: { step: number; frac: number }[] = [
    { step: 1, frac: 1600.3 },
    { step: 10, frac: 1600.3 },
    { step: TICK_STEP_MONTH, frac: dateToFractionalYear(2026, 8, 9) },
    { step: TICK_STEP_DAY, frac: dateToFractionalYear(2026, 8, 9) + 0.1 / 365 },
  ];

  it("startDateAtBoundary's precisionRange().start IS the snapped boundary", () => {
    for (const { step, frac } of cases) {
      const b = snapYearToStep(frac, step);
      const tri = startDateAtBoundary(frac, step);
      expect(precisionRange(tri.year, tri.month, tri.day).start).toBeCloseTo(b, 9);
      expect(tripleToFraction(tri)).toBeCloseTo(b, 9);
    }
  });

  it("endDateBeforeBoundary's precisionRange().end IS the snapped boundary", () => {
    for (const { step, frac } of cases) {
      const b = snapYearToStep(frac, step);
      const tri = endDateBeforeBoundary(frac, step);
      expect(precisionRange(tri.year, tri.month, tri.day).end).toBeCloseTo(b, 9);
    }
  });

  it("a drawn span survives the note round-trip unchanged (year / month / day)", () => {
    const check = (step: number, from: number, to: number) => {
      const start = startDateAtBoundary(from, step);
      const end = endDateBeforeBoundary(to, step);
      const painted = itemTimeRange(
        item({
          note_id: "n",
          year: start.year,
          month: start.month,
          day: start.day,
          end_year: end.year,
          end_month: end.month,
          end_day: end.day,
        }),
      );
      expect(painted.start).toBeCloseTo(snapYearToStep(from, step), 9);
      expect(painted.end).toBeCloseTo(snapYearToStep(to, step), 9);
      expect(painted.kind).toBe("bar");
    };
    check(1, 1600, 1603);
    check(TICK_STEP_MONTH, dateToFractionalYear(2026, 8, 1), dateToFractionalYear(2026, 11, 1));
    check(TICK_STEP_DAY, dateToFractionalYear(2026, 8, 1), dateToFractionalYear(2026, 8, 8));
  });

  it("a day-precision end covers the WHOLE last day (5 days drawn = 5 days stored)", () => {
    // Regression: precisionRange used to make a full triple zero-length, so an 8/1–8/5 note
    // painted only through the start of 8/5 and short periods were impossible to judge.
    const r = itemTimeRange(
      item({ note_id: "n", year: 2026, month: 8, day: 1, end_year: 2026, end_month: 8, end_day: 5 }),
    );
    expect(r.end - r.start).toBeCloseTo(5 / daysInYear(2026), 9);
  });

  it("a start-only day note is still a point, not a one-day bar", () => {
    const r = itemTimeRange(item({ note_id: "n", year: 2026, month: 8, day: 1 }));
    expect(r.kind).toBe("point");
    expect(r.end).toBe(r.start);
  });
});

describe("nearestTick", () => {
  it("returns the closest rendered tick, or null when there are none", () => {
    expect(nearestTick([], 5)).toBeNull();
    expect(nearestTick([1600, 1610, 1620], 1613)).toBe(1610);
    expect(nearestTick([1600, 1610, 1620], 1616)).toBe(1620);
  });
});

describe("fitViewToItems", () => {
  const full = { from: 1900, to: 2100 };

  it("frames a ~1-week note in a ~2-month window (owner's calibration)", () => {
    const start = dateToFractionalYear(2026, 8, 1);
    const end = dateToFractionalYear(2026, 8, 8);
    const fit = fitViewToItems([{ startYear: start, endYear: end }], full)!;
    const span = fit.to - fit.from;
    expect(span).toBeCloseTo(FIT_MIN_SPAN, 6); // 1/6 y ≈ 2 months
    // Centred on the note.
    expect((fit.from + fit.to) / 2).toBeCloseTo((start + end) / 2, 6);
  });

  it("pads a wide corpus instead of hugging the outermost notes", () => {
    const fit = fitViewToItems(
      [
        { startYear: 1990, endYear: 1991 },
        { startYear: 2010, endYear: 2012 },
      ],
      full,
    )!;
    expect(fit.from).toBeLessThan(1990);
    expect(fit.to).toBeGreaterThan(2012);
    // Still far narrower than the full axis — this is the whole point of opening fit.
    expect(fit.to - fit.from).toBeLessThan(full.to - full.from);
  });

  it("never escapes the full axis, and returns null when there is nothing to fit", () => {
    expect(fitViewToItems([], full)).toBeNull();
    const fit = fitViewToItems([{ startYear: 1000, endYear: 3000 }], full)!;
    expect(fit).toEqual(full);
  });
});

// ── W8-h: two-tier ticks, sub-lane packing, drag-to-move shift math ─────────────────────────

describe("minorTickStepForView (unlabeled second tier)", () => {
  it("makes the owner's ~2.5y screenshot read at month density instead of year-only", () => {
    // ~2.5y over a ~1500px canvas: month labels would be 50px apart (< AXIS_TICK_MIN_PX), so the
    // LABEL step stays year — which is exactly what looked too sparse. The minor tier fills it in.
    const from = 2025;
    const to = 2027.5;
    const width = 1500;
    expect(tickStepForView(from, to, width)).toBe(1);
    const minor = minorTickStepForView(from, to, width)!;
    expect(minor).toBeCloseTo(TICK_STEP_MONTH, 12);
    expect(minor * (width / (to - from))).toBeGreaterThanOrEqual(MINOR_TICK_MIN_PX);
    // …and those really are calendar month starts, not 1/12-year multiples.
    const ticks = yearTicks(from, to, minor);
    expect(ticks).toContain(dateToFractionalYear(2026, 3, 1));
  });

  it("picks exactly one rung below the label step, and only while it stays legible", () => {
    // Wide window: the rung below 100y is 50y, still ≫ 7px apart.
    expect(minorTickStepForView(1000, 2000, 800)).toBe(TICK_STEPS[TICK_STEPS.indexOf(tickStepForView(1000, 2000, 800)) - 1]);
    // Very narrow canvas: even the finer rung would smear → no minor tier at all.
    expect(minorTickStepForView(1000, 2000, 40)).toBeNull();
  });

  it("returns null when the label step is already the finest rung", () => {
    // ~3-day window: labels are already day steps, nothing finer on the ladder.
    const from = dateToFractionalYear(2026, 8, 1);
    const to = dateToFractionalYear(2026, 8, 4);
    expect(tickStepForView(from, to, 900)).toBe(TICK_STEP_DAY);
    expect(minorTickStepForView(from, to, 900)).toBeNull();
  });

  it("the SNAP step is the minor step when present, else the label step (snap to what you see)", () => {
    const snapStep = (from: number, to: number, w: number) =>
      minorTickStepForView(from, to, w) ?? tickStepForView(from, to, w);
    // 2.5y / 1500px: year labels + month gridlines → month snapping, not year.
    expect(snapUnitForStep(tickStepForView(2025, 2027.5, 1500))).toBe("year");
    expect(snapUnitForStep(snapStep(2025, 2027.5, 1500))).toBe("month");
    // Day-scale window has no minor tier — snap falls back to the label step.
    const d0 = dateToFractionalYear(2026, 8, 1);
    const d1 = dateToFractionalYear(2026, 8, 4);
    expect(snapStep(d0, d1, 900)).toBe(tickStepForView(d0, d1, 900));
  });
});

describe("sub-lane packing (owner: 기간이 겹치는 경우 라인구분; single canvas since 2026-08-09)", () => {
  it("overlapping bars get distinct sub-lanes; disjoint ones share sub-lane 0", () => {
    const packed = assignItemLanes([
      item({ note_id: "a", year: 1990, end_year: 1995, folder_id: "fA" }),
      item({ note_id: "b", year: 1992, end_year: 1997, folder_id: "fA" }), // overlaps a
      item({ note_id: "c", year: 2000, end_year: 2001, folder_id: "fA" }), // after both
    ], TEST_VIEW, TEST_WIDTH);
    const by = (id: string) => packed.find((p) => p.noteId === id)!;
    expect(by("a").subLane).toBe(0);
    expect(by("b").subLane).toBe(1);
    expect(by("c").subLane).toBe(0); // a ended in 1996 (exclusive) → row 0 is free again
  });

  it("bars that merely touch (a.end === b.start) share a sub-lane", () => {
    const packed = assignItemLanes([
      item({ note_id: "a", year: 1990, end_year: 1994, folder_id: "fA" }), // → exclusive 1995
      item({ note_id: "b", year: 1995, end_year: 1996, folder_id: "fA" }),
    ], TEST_VIEW, TEST_WIDTH);
    expect(packed.every((p) => p.subLane === 0)).toBe(true);
  });

  it("same-day points stack downward into adjacent sub-rows (2026-08-07 owner reversal)", () => {
    // 20-day window at 1000px → 1 day = 50px (>= 40px LABEL_MIN_GAP_PX)
    const dayView = {
      from: dateToFractionalYear(2026, 8, 1),
      to: dateToFractionalYear(2026, 8, 21),
    };
    const packed = assignItemLanes([
      item({ note_id: "p1", year: 2026, month: 8, day: 5, folder_id: "fA" }),
      item({ note_id: "p2", year: 2026, month: 8, day: 5, folder_id: "fA" }),
      item({ note_id: "p3", year: 2026, month: 8, day: 6, folder_id: "fA" }), // other day
    ], dayView, 1000);
    const by = (id: string) => packed.find((p) => p.noteId === id)!;
    expect(by("p1").subLane).toBe(0);
    expect(by("p2").subLane).toBe(1); // same day → next row down, tight vertical cluster
    expect(by("p3").subLane).toBe(0); // different day → back on row 0
  });

  it("same-day point stacks grow sub-lanes dynamically rather than capping at 4 (QA 4 C-2)", () => {
    const packed = assignItemLanes(
      Array.from({ length: 6 }, (_, i) =>
        item({ note_id: `p${i}`, year: 2026, month: 8, day: 5, folder_id: "fA" }),
      ),
      TEST_VIEW,
      TEST_WIDTH,
    );
    expect(packed.map((p) => p.subLane)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("overlapping bars stack into distinct sub-lanes without artificial 4-row cap (QA 4 C-2)", () => {
    const packed = assignItemLanes(
      // 8 mutually-overlapping periods, all inside 2000–2010.
      Array.from({ length: 8 }, (_, i) =>
        item({ note_id: `b${i}`, year: 2000 + i, end_year: 2009, folder_id: "fA" }),
      ),
      TEST_VIEW,
      TEST_WIDTH,
    );
    expect(packed.map((p) => p.subLane)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("nearby points whose labels would collide stack downward into adjacent sub-rows when view and width are provided (QA 4 C-3)", () => {
    // View from 2026 to 2027, width 800px → 1 day is ~800/365 ≈ 2.19px (< 40px LABEL_MIN_GAP_PX)
    const view = { from: 2026, to: 2027 };
    const width = 800;

    const items = [
      item({ note_id: "p1", year: 2026, month: 8, day: 1, folder_id: "fA" }),
      item({ note_id: "p2", year: 2026, month: 8, day: 2, folder_id: "fA" }),
    ];

    const packed = assignItemLanes(items, view, width);
    expect(packed.find((p) => p.noteId === "p1")!.subLane).toBe(0);
    expect(packed.find((p) => p.noteId === "p2")!.subLane).toBe(1);
    // Neither point's label is suppressed to null because they sit on different sub-lanes
    expect(pointLabelMaxWidth(packed[0]!, packed, view, width)).toBeUndefined();
    expect(pointLabelMaxWidth(packed[1]!, packed, view, width)).toBeUndefined();
  });

  it("zoomed-in points with ample gap share sub-lane 0 (QA 4 C-3)", () => {
    // Zoomed in view: 10 days span across 1000px → 1 day is 100px (>= 40px)
    const view = {
      from: dateToFractionalYear(2026, 8, 1),
      to: dateToFractionalYear(2026, 8, 11),
    };
    const width = 1000;

    const items = [
      item({ note_id: "p1", year: 2026, month: 8, day: 1, folder_id: "fA" }),
      item({ note_id: "p2", year: 2026, month: 8, day: 3, folder_id: "fA" }), // 2 days later = ~200px gap
    ];

    const packed = assignItemLanes(items, view, width);
    expect(packed.find((p) => p.noteId === "p1")!.subLane).toBe(0);
    expect(packed.find((p) => p.noteId === "p2")!.subLane).toBe(0);
  });

  it("FIX1: a point inside a covering bar's span does not share the bar's sub-lane", () => {
    const packed = assignItemLanes([
      item({ note_id: "bar", year: 1990, end_year: 2000, folder_id: "fA" }),
      item({ note_id: "pt", year: 1995, month: 6, day: 1, folder_id: "fA" }), // inside the bar
    ], TEST_VIEW, TEST_WIDTH);
    const by = (id: string) => packed.find((p) => p.noteId === id)!;
    expect(by("bar").subLane).toBe(0);
    expect(by("pt").subLane).not.toBe(by("bar").subLane);
  });

  it("FIX1: same-start points under a covering bar stack below it, not on top of it", () => {
    const packed = assignItemLanes([
      item({ note_id: "bar", year: 1990, end_year: 2000, folder_id: "fA" }),
      item({ note_id: "p1", year: 1995, month: 6, day: 1, folder_id: "fA" }),
      item({ note_id: "p2", year: 1995, month: 6, day: 1, folder_id: "fA" }), // same start as p1
    ], TEST_VIEW, TEST_WIDTH);
    const by = (id: string) => packed.find((p) => p.noteId === id)!;
    expect(by("bar").subLane).toBe(0);
    expect(by("p1").subLane).toBe(1);
    expect(by("p2").subLane).toBe(2);
  });

  it("FIX1: a point outside any bar's span still prefers sub-lane 0", () => {
    const packed = assignItemLanes([
      item({ note_id: "bar", year: 1990, end_year: 2000, folder_id: "fA" }),
      item({ note_id: "pt", year: 2010, month: 1, day: 1, folder_id: "fA" }), // after the bar ends
    ], TEST_VIEW, TEST_WIDTH);
    expect(packed.find((p) => p.noteId === "pt")!.subLane).toBe(0);
  });

  it("PackedItem.precision is the coarsest unit the note actually stores", () => {
    const packed = assignItemLanes([
      item({ note_id: "y", year: 1794, end_year: 1796, folder_id: "fA" }),
      item({ note_id: "m", year: 2026, month: 8, end_year: 2026, end_month: 11, folder_id: "fA" }),
      item({ note_id: "d", year: 2026, month: 8, day: 5, folder_id: "fA" }),
      // Mixed: a day start with a year-only end is only trustworthy at year granularity.
      item({ note_id: "mix", year: 2026, month: 8, day: 5, end_year: 2027, folder_id: "fA" }),
    ], TEST_VIEW, TEST_WIDTH);
    const by = (id: string) => packed.find((p) => p.noteId === id)!.precision;
    expect(by("y")).toBe("year");
    expect(by("m")).toBe("month");
    expect(by("d")).toBe("day");
    expect(by("mix")).toBe("year");
    expect(coarserUnit("day", "month")).toBe("month");
    expect(coarserUnit("month", "year")).toBe("year");
  });
});

describe("laneGeometry (single row, 2026-08-09)", () => {
  it("the row starts at LANE_TOP_PAD, and a 1-sub-lane row keeps the classic LANE_HEIGHT", () => {
    const geo = laneGeometry([]);
    expect(geo.tops).toEqual([LANE_TOP_PAD]);
    expect(geo.heights).toEqual([LANE_HEIGHT]);
    expect(geo.totalHeight).toBe(LANE_TOP_PAD + LANE_HEIGHT);
    expect(SUB_LANE_PITCH).toBe(BAR_HEIGHT + 6);
  });

  it("grows with the row's own sub-lane count, regardless of which items (or folders) need it", () => {
    const packed = assignItemLanes([
      item({ note_id: "a", year: 1990, end_year: 1995, folder_id: "fA" }),
      item({ note_id: "b", year: 1992, end_year: 1997, folder_id: "fA" }), // overlaps a → 2 sub-lanes
      item({ note_id: "c", year: 1990, end_year: 1991, folder_id: "fB" }), // disjoint, still row 0
    ], TEST_VIEW, TEST_WIDTH);
    const geo = laneGeometry(packed);
    expect(geo.heights[0]).toBeGreaterThan(LANE_HEIGHT); // 2 sub-lanes needed
    expect(geo.tops[0]).toBe(LANE_TOP_PAD);
    expect(geo.totalHeight).toBe(geo.tops[0]! + geo.heights[0]!);
  });
});

describe("shiftTriple (drag-to-move)", () => {
  it("shifts whole years, keeping the triple's own precision", () => {
    expect(shiftTriple({ year: 1794, month: null, day: null }, "year", 3)).toEqual({
      year: 1797,
      month: null,
      day: null,
    });
    // A day-precision note dragged on a YEAR axis keeps its month/day.
    expect(shiftTriple({ year: 2026, month: 8, day: 5 }, "year", -2)).toEqual({
      year: 2024,
      month: 8,
      day: 5,
    });
  });

  it("month shifts carry across the year boundary and clamp the day into the target month", () => {
    expect(shiftTriple({ year: 2026, month: 11, day: null }, "month", 3)).toEqual({
      year: 2027,
      month: 2,
      day: null,
    });
    expect(shiftTriple({ year: 2026, month: 2, day: null }, "month", -3)).toEqual({
      year: 2025,
      month: 11,
      day: null,
    });
    // Jan 31 + 1 month → Feb 28 (2026 is not a leap year), + 1 more → Mar 28.
    expect(shiftTriple({ year: 2026, month: 1, day: 31 }, "month", 1)).toEqual({
      year: 2026,
      month: 2,
      day: 28,
    });
    expect(shiftTriple({ year: 2024, month: 1, day: 31 }, "month", 1)).toEqual({
      year: 2024,
      month: 2,
      day: 29,
    });
  });

  it("day shifts use calendar arithmetic (month/year rollover, leap day)", () => {
    expect(shiftTriple({ year: 2026, month: 8, day: 30 }, "day", 3)).toEqual({
      year: 2026,
      month: 9,
      day: 2,
    });
    expect(shiftTriple({ year: 2024, month: 2, day: 28 }, "day", 1)).toEqual({
      year: 2024,
      month: 2,
      day: 29,
    });
    expect(shiftTriple({ year: 2026, month: 1, day: 1 }, "day", -1)).toEqual({
      year: 2025,
      month: 12,
      day: 31,
    });
  });

  it("a shift finer than the triple's precision is re-expressed, never promoted", () => {
    // Year-only note dragged 12 months → exactly 1 year, still year-only (no invented month).
    expect(shiftTriple({ year: 1794, month: null, day: null }, "month", 12)).toEqual({
      year: 1795,
      month: null,
      day: null,
    });
    // A sub-year nudge rounds to zero rather than corrupting the stored precision.
    expect(shiftTriple({ year: 1794, month: null, day: null }, "month", 2)).toEqual({
      year: 1794,
      month: null,
      day: null,
    });
    // Month-only note dragged ~2 months' worth of days.
    expect(shiftTriple({ year: 2026, month: 3, day: null }, "day", 61)).toEqual({
      year: 2026,
      month: 5,
      day: null,
    });
  });

  it("applied to both ends, the duration survives in calendar units", () => {
    const start = { year: 2026, month: 1, day: 31 };
    const end = { year: 2026, month: 4, day: 30 };
    const n = 1;
    expect(shiftTriple(start, "month", n)).toEqual({ year: 2026, month: 2, day: 28 });
    expect(shiftTriple(end, "month", n)).toEqual({ year: 2026, month: 5, day: 30 });
    // Still 3 months apart (the day clamp is the calendar's, not ours).
    const a = shiftTriple(start, "month", n);
    const b = shiftTriple(end, "month", n);
    expect((b.year - a.year) * 12 + (b.month! - a.month!)).toBe(3);
  });
});

describe("unitsBetween", () => {
  it("counts whole calendar units between two snapped boundaries", () => {
    expect(unitsBetween(1794, 1797, "year")).toBe(3);
    expect(unitsBetween(1797.2, 1794.4, "year")).toBe(-3);
    expect(
      unitsBetween(dateToFractionalYear(2026, 11, 1), dateToFractionalYear(2027, 2, 1), "month"),
    ).toBe(3);
    expect(
      unitsBetween(dateToFractionalYear(2026, 8, 30), dateToFractionalYear(2026, 9, 2), "day"),
    ).toBe(3);
    // Leap-year day counting stays exact.
    expect(
      unitsBetween(dateToFractionalYear(2024, 2, 28), dateToFractionalYear(2024, 3, 1), "day"),
    ).toBe(2);
  });
});

describe("resolveTimelineView with a fit range", () => {
  const full = { from: 1380, to: 1910 };
  const openPeriod = { yearFrom: 900, yearTo: 2020, yearBounds: { min: 900, max: 2020 } };

  it("prefers fit over today±1 when the store filter is open", () => {
    const fit = { from: 1590, to: 1800 };
    expect(resolveTimelineView(openPeriod, full, 2026, fit)).toEqual(fit);
  });

  it("falls back to today±1 when there is nothing to fit", () => {
    expect(resolveTimelineView(openPeriod, full, 1700, null)).toEqual({ from: 1699, to: 1701 });
  });

  it("a narrowed store period still wins over fit", () => {
    const narrowed = { yearFrom: 1500, yearTo: 1600, yearBounds: { min: 900, max: 2020 } };
    expect(resolveTimelineView(narrowed, full, 2026, { from: 1590, to: 1800 })).toEqual({
      from: 1500,
      to: 1600,
    });
  });
});

describe("fractionalYearToDate round-trip (used by every boundary label)", () => {
  it("recovers the calendar date a boundary was built from", () => {
    for (const [y, m, d] of [
      [2026, 1, 1],
      [2026, 8, 5],
      [2024, 2, 29],
      [2026, 12, 31],
    ] as const) {
      expect(fractionalYearToDate(dateToFractionalYear(y, m, d))).toEqual({
        year: y,
        month: m,
        day: d,
      });
    }
  });
});

describe("pointLabelMaxWidth (FIX2 — point label vs next item in the same row)", () => {
  const view = { from: 2000, to: 2010 };
  const width = 1000; // 100 px/year

  function pt(noteId: string, startYear: number, subLane = 0): PackedItem {
    return {
      noteId,
      title: noteId,
      kind: "point",
      startYear,
      endYear: startYear,
      folderId: "fA",
      lane: 0,
      subLane,
      precision: "day",
    };
  }
  function bar(noteId: string, startYear: number, endYear: number, subLane = 0): PackedItem {
    return { ...pt(noteId, startYear, subLane), kind: "bar", endYear };
  }

  it("clamps to the gap before the next point in the same (lane, subLane) row", () => {
    const a = pt("a", 2000);
    const b = pt("b", 2001); // 100px away — point-vs-point, the marker offset cancels out
    expect(pointLabelMaxWidth(a, [a, b], view, width)).toBe(100 - LABEL_GAP_PAD_PX);
  });

  it("hides the label outright when the gap is under LABEL_MIN_GAP_PX", () => {
    const a = pt("a", 2000);
    const b = pt("b", 2000.2); // 20px away — under the 40px floor
    expect(pointLabelMaxWidth(a, [a, b], view, width)).toBeNull();
    expect(20).toBeLessThan(LABEL_MIN_GAP_PX);
  });

  it("returns undefined (no clamp) when there is no neighbor in the row", () => {
    const a = pt("a", 2000);
    const other = pt("b", 2000, 1); // same start, different sub-lane — not a row neighbor
    expect(pointLabelMaxWidth(a, [a, other], view, width)).toBeUndefined();
    expect(pointLabelMaxWidth(a, [a], view, width)).toBeUndefined();
  });

  it("measures a bar neighbor's flush left edge (bars have no marker-centering offset)", () => {
    const a = pt("a", 2000);
    const b = bar("b", 2003, 2005);
    // a's painted left is yearToX(2000) - POINT_SIZE/2 = -4.5; b's is yearToX(2003) = 300.
    expect(pointLabelMaxWidth(a, [a, b], view, width)).toBeCloseTo(304.5 - LABEL_GAP_PAD_PX, 6);
  });
});

describe("bucketByStep — 월 눈금은 달력의 달로 묶는다", () => {
  it("5월 1일·5월 18일은 같은 2026-05 칸, 라벨도 그 달 하나", () => {
    const may1 = dateToFractionalYear(2026, 5, 1);
    const may18 = dateToFractionalYear(2026, 5, 18);
    const apr30 = dateToFractionalYear(2026, 4, 30);
    const b = bucketByStep([{ startYear: may1 }, { startYear: may18 }, { startYear: apr30 }], 1 / 12);
    expect(b.map((x) => [formatBucketLabel(x.year, x.endYear), x.count])).toEqual([["2026-04", 1], ["2026-05", 2]]);
    expect(b[1].year).toBeCloseTo(may1, 8);
    expect(b[1].endYear).toBeCloseTo(dateToFractionalYear(2026, 6, 1), 8);
  });
});
