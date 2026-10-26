import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor, cleanup, fireEvent, act } from "@testing-library/react";
import { TimelineTab } from "./TimelineTab";
import { spanLabel } from "./ItemsLayer";
import { TICK_STEP_MONTH, itemTimeRange } from "./layout";
import { useSettingsStore } from "../../../stores/settings";
import { useTaxonomyStore } from "../../../stores/taxonomy";
import { useSearchStore } from "../../../stores/search";
import { useNotesStore } from "../../../stores/notes";
import type { Folder, TimelineNoteItem, TimelineResult } from "../../../lib/commands.gen";

const callMock = vi.fn();
vi.mock("../../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  registerFlush: () => () => {},
  flushAll: async () => {},
  emitNotice: () => {},
}));

const selectNoteMock = vi.fn().mockResolvedValue(undefined);
const loadTreeMock = vi.fn().mockResolvedValue(undefined);
const ensureInboxIdMock = vi.fn().mockResolvedValue("inbox1");

// jsdom lacks ResizeObserver — useElementSize needs it (same stub as GalleryExpanded.test).
global.ResizeObserver = class {
  private cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
  }
  observe(target: Element) {
    this.cb(
      [
        {
          target,
          contentRect: {
            width: 800,
            height: 400,
            top: 0,
            left: 0,
            right: 800,
            bottom: 400,
            x: 0,
            y: 0,
          },
        } as unknown as ResizeObserverEntry,
      ],
      this as unknown as ResizeObserver,
    );
  }
  unobserve() {}
  disconnect() {}
};

function folder(over: Partial<Folder> & Pick<Folder, "id" | "name">): Folder {
  return {
    workspace_id: "ws1",
    position: 0,
    is_open: true,
    note_count: 0,
    color_hue: null,
    icon: null,
    rules: null,
    search_excluded: false,
    ai_excluded: false,
    ...over,
  };
}

const FOLDER_A = folder({ id: "fA", name: "Alpha", color_hue: 120 });
const FOLDER_B = folder({ id: "fB", name: "Beta", color_hue: 240 });

function sampleResult(over: Partial<TimelineResult> = {}): TimelineResult {
  return {
    from_year: 900,
    to_year: 2020,
    items: [
      {
        note_id: "n1",
        title: "진주성 전투",
        kind: "point",
        // Full day precision → point mark (year-only would expand to a full-year bar).
        year: 1592,
        month: 11,
        day: 25,
        end_year: null,
        end_month: null,
        end_day: null,
        folder_id: "fA",
      },
      {
        note_id: "n2",
        title: "수원 화성 축성",
        kind: "bar",
        year: 1794,
        month: null,
        day: null,
        end_year: 1796,
        end_month: null,
        end_day: null,
        folder_id: "fA",
      },
    ],
    year_buckets: [],
    eras: [
      {
        id: "e1",
        name: "조선",
        from_year: 1392,
        to_year: 1897,
        position: 0,
      },
    ],
    total_matched: 2,
    cap: 2000,
    capped: false,
    ...over,
  };
}

type Ui = {
  getByTestId: (id: string) => HTMLElement;
  queryByTestId: (id: string) => HTMLElement | null;
};

/** Wait for the first fetch to land and make sure the sample items are framed. W8-e opens fit to
 *  the notes that exist, so this is usually already true — the explicit fit click just removes
 *  the timing question from every test that then counts item marks. */
async function frameItems(ui: Ui) {
  await waitFor(() => expect(ui.getByTestId("timeline-brush")).toBeDefined());
  const fit = ui.queryByTestId("timeline-fit") as HTMLButtonElement | null;
  // Disabled only when there is nothing to fit (empty payload / capped aggregate view).
  if (fit && !fit.disabled) fireEvent.click(fit);
}

/** Narrow the view to a ±0.5y window around its centre. The scale presets are the scripted way
 *  to zoom now that the readout is read-only — wheel/brush are pointer gestures jsdom can't size. */
function zoomToMonth(ui: Ui) {
  fireEvent.click(ui.getByTestId("timeline-scale-month"));
}

describe("TimelineTab (static chronology)", () => {
  beforeEach(() => {
    callMock.mockReset();
    selectNoteMock.mockReset().mockResolvedValue(undefined);
    loadTreeMock.mockReset().mockResolvedValue(undefined);
    ensureInboxIdMock.mockReset().mockResolvedValue("inbox1");
    useSettingsStore.setState({ activeWorkspaceId: "ws1", uiLang: "en" });
    // Full reset (not just yearBounds) — this store is a module-level singleton shared across
    // every test in this file; the period-control and dashboard-search tests below write
    // yearFrom/yearTo/query/searchResults, and a leftover value from one test would silently
    // poison the next (setYearRange also clamps against yearBounds, so the effect isn't obvious).
    useSearchStore.setState({
      yearBounds: { min: 900, max: 2020 },
      yearFrom: 900,
      yearTo: 2020,
      query: "",
      searchResults: [],
    });
    useNotesStore.setState({
      selectNote: selectNoteMock,
      loadTree: loadTreeMock,
      ensureInboxId: ensureInboxIdMock,
      inboxId: "inbox1",
      folders: [FOLDER_A, FOLDER_B],
    } as never);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("fetches dashboard_timeline and paints points, bars, eras, axis", async () => {
    callMock.mockResolvedValue(sampleResult());
    const ui = render(<TimelineTab />);
    const { getByTestId, getAllByTestId } = ui;

    expect(getByTestId("timeline-tab")).toBeDefined();
    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith(
        "dashboard_timeline",
        expect.objectContaining({ workspace_id: "ws1" }),
      );
    });
    await frameItems(ui);

    await waitFor(() => {
      const items = getAllByTestId("timeline-item");
      expect(items.length).toBe(2);
      expect(items.some((el) => el.getAttribute("data-kind") === "point")).toBe(true);
      expect(items.some((el) => el.getAttribute("data-kind") === "bar")).toBe(true);
      // VERTICAL ANCHOR RULE (layout.ts): lane 0 sits at LANE_TOP_PAD from the canvas top, not
      // pinned to the bottom axis — both sample items share folder_id "fA", so both land in the
      // single (only) lane, lane 0. LANE_TOP_PAD is AXIS_HEIGHT(28) + 36 now that the axis moved
      // to the top of the canvas (dashboard QA fix) — see layout.ts.
      for (const el of items) {
        expect((el as HTMLElement).style.top).toBe("64px");
      }
    });

    expect(getAllByTestId("timeline-era").length).toBe(1);
    expect(getByTestId("timeline-axis")).toBeDefined();
    expect(getByTestId("timeline-range").textContent).toMatch(/\d/);
  });

  it("single canvas: items from different folders share row 0 — no per-folder lane/gutter (2026-08-09)", async () => {
    callMock.mockResolvedValue(
      sampleResult({
        items: [
          { note_id: "n1", title: "A1", kind: "point", year: 1592, month: null, day: null, end_year: null, end_month: null, end_day: null, folder_id: "fA" },
          { note_id: "n2", title: "A2", kind: "point", year: 1600, month: null, day: null, end_year: null, end_month: null, end_day: null, folder_id: "fA" },
          { note_id: "n3", title: "B1", kind: "point", year: 1700, month: null, day: null, end_year: null, end_month: null, end_day: null, folder_id: "fB" },
        ],
      }),
    );
    const ui = render(<TimelineTab />);
    const { getAllByTestId, queryAllByTestId } = ui;
    await frameItems(ui);

    await waitFor(() => expect(getAllByTestId("timeline-item").length).toBe(3));
    // No lane label chip anywhere — folders no longer earn a row.
    expect(queryAllByTestId("timeline-lane-gutter").length).toBe(0);

    // None of these three overlap (all distinct years) → every one sits on row 0, regardless
    // of which folder it belongs to.
    for (const el of getAllByTestId("timeline-item")) {
      expect((el as HTMLElement).style.top).toBe("64px");
    }
  });

  it("bars/points paint in their folder's color; an unresolvable folder falls back to accent (2026-08-09)", async () => {
    callMock.mockResolvedValue(
      sampleResult({
        items: [
          { note_id: "a1", title: "A1", kind: "bar", year: 1990, month: null, day: null, end_year: 1995, end_month: null, end_day: null, folder_id: "fA" },
          { note_id: "a2", title: "A2", kind: "bar", year: 2000, month: null, day: null, end_year: 2005, end_month: null, end_day: null, folder_id: "fB" },
          { note_id: "a3", title: "A3", kind: "bar", year: 2010, month: null, day: null, end_year: 2015, end_month: null, end_day: null, folder_id: "unresolvable-folder" },
        ],
        eras: [],
      }),
    );
    const ui = render(<TimelineTab />);
    const { getAllByTestId } = ui;
    await frameItems(ui);
    await waitFor(() => expect(getAllByTestId("timeline-item").length).toBe(3));

    const byId = (id: string) =>
      getAllByTestId("timeline-item").find((el) => el.getAttribute("data-note-id") === id) as HTMLElement;
    const a1 = byId("a1"); // fA, color_hue 120
    const a2 = byId("a2"); // fB, color_hue 240
    const a3 = byId("a3"); // not in the folders store → var(--accent) fallback

    expect(a1.style.border).not.toBe("");
    expect(a1.style.border).not.toContain("var(--accent)"); // resolved folder color
    expect(a2.style.border).not.toContain("var(--accent)");
    expect(a1.style.border).not.toBe(a2.style.border); // fA and fB paint differently
    expect(a3.style.border).toContain("var(--accent)"); // unresolvable folder → fallback
  });

  it("overlapping bars (any folders) stack into sub-lanes on the single row; disjoint bars share row 0", async () => {
    callMock.mockResolvedValue(
      sampleResult({
        items: [
          { note_id: "a1", title: "A1", kind: "bar", year: 1990, month: null, day: null, end_year: 1995, end_month: null, end_day: null, folder_id: "fA" },
          // Overlaps a1, DIFFERENT folder — still drops into sub-lane 1 (packing no longer cares
          // which folder an item belongs to, see layout.ts::assignItemLanes).
          { note_id: "a2", title: "A2", kind: "bar", year: 1992, month: null, day: null, end_year: 1997, end_month: null, end_day: null, folder_id: "fB" },
          // Disjoint from both — back on row 0.
          { note_id: "b1", title: "B1", kind: "bar", year: 2000, month: null, day: null, end_year: 2001, end_month: null, end_day: null, folder_id: "fA" },
        ],
        eras: [],
      }),
    );
    const ui = render(<TimelineTab />);
    const { getAllByTestId, queryAllByTestId } = ui;
    await frameItems(ui);
    await waitFor(() => expect(getAllByTestId("timeline-item").length).toBe(3));

    const topOf = (id: string) =>
      (getAllByTestId("timeline-item").find((el) => el.getAttribute("data-note-id") === id) as
        HTMLElement).style.top;
    // LANE_TOP_PAD 64, SUB_LANE_PITCH = BAR_HEIGHT(22) + 6 = 28.
    expect(topOf("a1")).toBe("64px");
    expect(topOf("a2")).toBe("92px");
    expect(topOf("b1")).toBe("64px");
    expect(queryAllByTestId("timeline-lane-gutter").length).toBe(0);
  });

  it("capped mode renders one density histogram on the single row, merged across folders (2026-08-09)", async () => {
    callMock.mockResolvedValue(
      sampleResult({
        capped: true,
        items: [],
        total_matched: 3500,
        year_buckets: [
          { folder_id: "fA", year: 1592, count: 40 },
          { folder_id: "fB", year: 1794, count: 12 },
        ],
      }),
    );
    const ui = render(<TimelineTab />);
    const { getByTestId, getAllByTestId, queryAllByTestId } = ui;
    await frameItems(ui);

    await waitFor(() => {
      const buckets = getAllByTestId("timeline-bucket");
      expect(buckets.length).toBe(2);
    });
    const buckets = getAllByTestId("timeline-bucket");
    // Every bucket paints on the SAME row now — no per-folder lane to rank into.
    for (const el of buckets) {
      expect((el as HTMLElement).style.top).toBe("64px");
      expect((el as HTMLElement).style.bottom).toBe("");
    }
    expect(queryAllByTestId("timeline-item").length).toBe(0);
    expect(getByTestId("timeline-capped-banner").textContent).toMatch(/3500|2000/);
  });

  it("capped mode sums counts from different folders landing on the same year into one bucket", async () => {
    callMock.mockResolvedValue(
      sampleResult({
        capped: true,
        items: [],
        total_matched: 52,
        year_buckets: [
          { folder_id: "fA", year: 1592, count: 40 },
          { folder_id: "fB", year: 1592, count: 12 },
        ],
      }),
    );
    const ui = render(<TimelineTab />);
    const { getAllByTestId } = ui;
    await frameItems(ui);

    await waitFor(() => expect(getAllByTestId("timeline-bucket").length).toBe(1));
    expect(getAllByTestId("timeline-bucket")[0]!.title).toBe("1592: 52");
  });

  it("axis renders at the top of the canvas, above the lanes (dashboard QA fix — numbers used to " +
    "sit at the bottom, invisible until a tall canvas was scrolled all the way down)", async () => {
    callMock.mockResolvedValue(sampleResult());
    const ui = render(<TimelineTab />);
    const { getByTestId, getAllByTestId } = ui;
    await frameItems(ui);
    await waitFor(() => expect(getAllByTestId("timeline-item").length).toBe(2));

    const axis = getByTestId("timeline-axis") as HTMLElement;
    expect(axis.style.top).toBe("0px");
    expect(axis.style.bottom).toBe(""); // no bottom-anchoring left over
    const axisHeight = parseInt(axis.style.height, 10);

    // Every lane row starts at or below the axis's own bottom edge — never behind/under it.
    const laneTops = getAllByTestId("timeline-lane-bg").map((el) =>
      parseInt((el as HTMLElement).style.top, 10),
    );
    for (const top of laneTops) expect(top).toBeGreaterThanOrEqual(axisHeight);
  });

  it("scroll container reserves a stable scrollbar gutter and the inner content fills it via " +
    "CSS (not a self-measured px height) — regression guard for the scrollbar oscillation bug " +
    "(canvasH, the container's own ResizeObserver height, used to be echoed back as an explicit " +
    "child height, closing a feedback loop through the scrollbar it caused)", async () => {
    callMock.mockResolvedValue(sampleResult());
    const { getByTestId } = render(<TimelineTab />);
    await waitFor(() => expect(getByTestId("timeline-canvas")).toBeDefined());

    const canvas = getByTestId("timeline-canvas") as HTMLElement;
    expect(canvas.getAttribute("style")).toContain("scrollbar-gutter: stable");

    const content = canvas.firstElementChild as HTMLElement;
    expect(content.style.height).toBe("100%");
  });

  it("wheel: horizontal pans the view window, plain vertical is left to the scroll container, Ctrl+wheel zooms", async () => {
    callMock.mockResolvedValue(sampleResult());
    const ui = render(<TimelineTab />);
    const { getByTestId } = ui;
    await frameItems(ui);
    const canvas = getByTestId("timeline-canvas");
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, top: 0, left: 0, bottom: 400, right: 800, width: 800, height: 400,
      toJSON: () => ({}),
    } as DOMRect);
    const readSpan = () => {
      const [from, to] = (getByTestId("timeline-brush").getAttribute("aria-valuetext") ?? "")
        .split(" – ")
        .map(Number);
      return { from, to, span: to - from };
    };
    await waitFor(() => expect(Number.isFinite(readSpan().span)).toBe(true));
    const before = readSpan();

    // A horizontal notch (tilt wheel) slides the window forward in time, span untouched. It used
    // to fall into the zoom path, where deltaY === 0 read as "not < 0" and zoomed OUT instead.
    const hEvt = new WheelEvent("wheel", { deltaX: 80, deltaY: 0, cancelable: true, bubbles: true, clientX: 400, clientY: 200 });
    act(() => { canvas.dispatchEvent(hEvt); });
    const panned = readSpan();
    expect(hEvt.defaultPrevented).toBe(true);
    expect(panned.span).toBeCloseTo(before.span, 6);
    expect(panned.from).toBeGreaterThan(before.from);

    // A plain vertical notch is NOT consumed — the lane stack lives in this overflow:auto
    // container, and swallowing the wheel left the lower lanes reachable only by the scrollbar.
    const vEvt = new WheelEvent("wheel", { deltaY: -100, cancelable: true, bubbles: true, clientX: 400, clientY: 200 });
    act(() => { canvas.dispatchEvent(vEvt); });
    expect(vEvt.defaultPrevented).toBe(false);
    expect(readSpan().span).toBeCloseTo(panned.span, 6);

    // Ctrl+wheel up is the zoom.
    const zEvt = new WheelEvent("wheel", { deltaY: -100, ctrlKey: true, cancelable: true, bubbles: true, clientX: 400, clientY: 200 });
    act(() => { canvas.dispatchEvent(zEvt); });
    expect(zEvt.defaultPrevented).toBe(true);
    expect(readSpan().span).toBeLessThan(panned.span);
  });

  it("empty workspace shows empty state", async () => {
    callMock.mockResolvedValue(
      sampleResult({ items: [], eras: [], total_matched: 0 }),
    );
    const { getByTestId } = render(<TimelineTab />);
    await waitFor(() => {
      expect(getByTestId("timeline-empty")).toBeDefined();
    });
  });

  it("skips fetch when no workspace is active", async () => {
    useSettingsStore.setState({ activeWorkspaceId: null });
    render(<TimelineTab />);
    await new Promise((r) => setTimeout(r, 30));
    expect(callMock).not.toHaveBeenCalled();
  });

  it("one range chip: read-only numbers, era picker behind its modal, brush centred in the same row", async () => {
    callMock.mockResolvedValue(sampleResult());
    const ui = render(<TimelineTab />);
    const { getByTestId, queryByTestId } = ui;
    await frameItems(ui);
    await waitFor(() => {
      expect(getByTestId("timeline-brush")).toBeDefined();
      expect(getByTestId("timeline-brush-window")).toBeDefined();
    });

    // ONE chip, and it only shows numbers — clicking it must not spawn bound inputs (the range
    // "editor" was deleted; every range INPUT lives behind the chip's modal now).
    expect(getByTestId("timeline-range-readout")).toBeDefined();
    expect(queryByTestId("timeline-period")).toBeNull();

    // W8-h: the zoom slider is gone — wheel zoom + the brush cover zooming — and the brush moved
    // into the header row it used to share with the slider, between the readout and the fit button.
    expect(queryByTestId("timeline-zoom-slider")).toBeNull();
    const header = getByTestId("timeline-range");
    expect(header.contains(getByTestId("timeline-brush"))).toBe(true);
    expect(header.contains(getByTestId("timeline-range-readout"))).toBe(true);
    expect(header.contains(getByTestId("timeline-fit"))).toBe(true);

    // The era dropdown is NOT on the row — it lives in the modal the chip opens.
    expect(queryByTestId("timeline-era-select")).toBeNull();

    fireEvent.click(getByTestId("timeline-range-readout"));
    expect(queryByTestId("timeline-period")).toBeNull();
    expect(queryByTestId("timeline-period-from")).toBeNull();
    expect(getByTestId("modal-shell")).toBeDefined();
    expect(getByTestId("timeline-era-select")).toBeDefined();
  });

  it("virtualizes: items outside a tight view are not mounted", async () => {
    callMock.mockResolvedValue(sampleResult());
    const ui = render(<TimelineTab />);
    const { getAllByTestId, queryAllByTestId } = ui;
    await frameItems(ui);
    await waitFor(() => expect(getAllByTestId("timeline-item").length).toBe(2));

    // A ±0.5y window around the fitted centre (~1694) holds no notes — 1592 and 1794 both drop out.
    zoomToMonth(ui);
    await waitFor(() => expect(queryAllByTestId("timeline-item").length).toBe(0));

    // Fit re-frames every note, whatever the range edit did.
    fireEvent.click(getAllByTestId("timeline-fit")[0]);
    await waitFor(() => expect(getAllByTestId("timeline-item").length).toBe(2));
  });

  it("double-clicking an item opens the note tab", async () => {
    callMock.mockResolvedValue(sampleResult());
    const ui = render(<TimelineTab />);
    const { getAllByTestId } = ui;
    await frameItems(ui);
    await waitFor(() => expect(getAllByTestId("timeline-item").length).toBe(2));
    const bar = getAllByTestId("timeline-item").find(
      (el) => el.getAttribute("data-note-id") === "n2",
    )!;
    fireEvent.dblClick(bar);
    expect(selectNoteMock).toHaveBeenCalledWith("n2");
  });

  it("a single click focuses the item in place instead of opening it", async () => {
    callMock.mockResolvedValue(sampleResult());
    const ui = render(<TimelineTab />);
    const { getAllByTestId } = ui;
    await frameItems(ui);
    await waitFor(() => expect(getAllByTestId("timeline-item").length).toBe(2));
    const bar = getAllByTestId("timeline-item").find(
      (el) => el.getAttribute("data-note-id") === "n2",
    )!;
    fireEvent.click(bar);
    expect(selectNoteMock).not.toHaveBeenCalled();
    expect(bar.getAttribute("data-focused")).toBe("true");

    // Clicking empty canvas clears it (map view pattern: focus moves/clears, never sticks).
    fireEvent.click(ui.getByTestId("timeline-canvas"));
    expect(bar.getAttribute("data-focused")).toBeNull();
  });

  function mockCreateFlow() {
    const createdNotes: Record<string, Record<string, unknown>> = {};
    callMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "dashboard_timeline") return sampleResult();
      if (cmd === "note_create") {
        const note = {
          id: "new1",
          folder_id: args?.folder_id ?? "inbox1",
          title: args?.title ?? "Untitled Note",
          year: args?.year ?? 1800,
          month: args?.month ?? null,
          day: args?.day ?? null,
        };
        createdNotes[note.id] = note;
        return { note, sections: [], sources: [], attachments: [] };
      }
      // PLAN-2026-09-08-dates-rebuild.md W4: note_set_event_end/note_set_event_precision/
      // note_update(year)'s old sequencing were replaced by lib/primaryDate.ts::
      // replacePrimaryDate, which always fetches the note's current full state first — including
      // for pre-existing sample items (n1/n2) that commitResize/commitMove edit via drag.
      if (cmd === "note_get") {
        const id = args?.id as string;
        const note = createdNotes[id] ?? {
          ...sampleResult().items.find((it) => it.note_id === id),
          id,
          remind: false, start_time: null, end_time: null, remind_offset_min: null, rrule: null,
        };
        return { note, sections: [], sources: [], attachments: [] };
      }
      // W4b: 대표 편집은 note_date_update 한 번(옛 add+승격+삭제 컴포지트는 사라졌다).
      if (cmd === "note_dates_list") return { dates: [{ id: "primary-row", note_id: "n", position: 0, year: 2026, month: null, day: null, end_year: null, end_month: null, end_day: null, remind: false, created_at: "", start_time: null, end_time: null, remind_offset_min: null, rrule: null }] };
      if (cmd === "note_date_update") return { id: "primary-row", note_id: "n", position: 0, year: 2026, month: null, day: null, end_year: null, end_month: null, end_day: null, remind: false, created_at: "", start_time: null, end_time: null, remind_offset_min: null, rrule: null };
      return {};
    });
  }

  function dragCreate(canvas: HTMLElement, clientY: number) {
    canvas.dispatchEvent(
      new MouseEvent("mousedown", { button: 0, clientX: 100, clientY, bubbles: true }),
    );
    document.dispatchEvent(
      new MouseEvent("mousemove", { clientX: 400, clientY, bubbles: true }),
    );
    document.dispatchEvent(
      new MouseEvent("mouseup", { clientX: 400, clientY, bubbles: true }),
    );
  }

  it("drag-create always resolves to the inbox — no lane to infer a folder from (2026-08-09, title input, Enter creates)", async () => {
    mockCreateFlow();
    const ui = render(<TimelineTab />);
    const { getByTestId, getAllByTestId } = ui;
    await frameItems(ui);
    await waitFor(() => expect(getAllByTestId("timeline-item").length).toBe(2));
    const canvas = getByTestId("timeline-canvas");
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, top: 0, left: 0, bottom: 400, right: 800, width: 800, height: 400,
      toJSON: () => ({}),
    } as DOMRect);

    // Wherever the drag starts (here clientY=80, inside the single item row) the target folder is
    // always the inbox now — single canvas has no lane to read a folder id off of.
    dragCreate(canvas, 80);

    await waitFor(() => expect(getByTestId("timeline-create-pop")).toBeDefined());
    // Popover shows the inbox as the target, not a resolved folder name.
    expect(getByTestId("timeline-create-pop").textContent).toContain("Inbox");
    // Ghost/create still paint on the single row, LANE_TOP_PAD 64px — see layout.ts.

    const titleInput = getByTestId("timeline-create-title") as HTMLInputElement;
    fireEvent.change(titleInput, { target: { value: "My New Note" } });
    fireEvent.keyDown(titleInput, { key: "Enter" });

    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith(
        "note_create",
        expect.objectContaining({ folder_id: "inbox1", title: "My New Note", year: expect.any(Number) }),
      );
    });
    // note_set_event_end was deleted — replacePrimaryDate's add+promote composite absorbs it.
    expect(callMock).not.toHaveBeenCalledWith("note_set_event_end", expect.anything());
    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith(
        "note_date_update",
        expect.objectContaining({ id: "primary-row", end_year: expect.any(Number) }),
      );
    });
    // W8-e: creating must NOT navigate — that was the flow break. The timeline refetches so the
    // new bar appears in place, and the user clicks it if they want the editor.
    const fetches = callMock.mock.calls.filter((c) => c[0] === "dashboard_timeline").length;
    await waitFor(() => {
      expect(
        callMock.mock.calls.filter((c) => c[0] === "dashboard_timeline").length,
      ).toBeGreaterThanOrEqual(fetches);
    });
    expect(selectNoteMock).not.toHaveBeenCalled();
  });

  it("drag over empty canvas shows a ghost bar with its live date range before anything is created", async () => {
    mockCreateFlow();
    const ui = render(<TimelineTab />);
    const { getByTestId, queryByTestId } = ui;
    await frameItems(ui);
    const canvas = getByTestId("timeline-canvas");
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, top: 0, left: 0, bottom: 400, right: 800, width: 800, height: 400,
      toJSON: () => ({}),
    } as DOMRect);

    canvas.dispatchEvent(
      new MouseEvent("mousedown", { button: 0, clientX: 100, clientY: 80, bubbles: true }),
    );
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 400, clientY: 80, bubbles: true }));

    const ghost = await waitFor(() => getByTestId("timeline-ghost"));
    // The span is legible BEFORE committing — a real date range, not a bare pixel rectangle.
    expect(ghost.getAttribute("data-ghost-label")).toMatch(/\d/);
    expect(getByTestId("timeline-span-chip").textContent).toBe(
      ghost.getAttribute("data-ghost-label"),
    );
    // Ghost sits in the lane the drag started in (lane 0 here), i.e. where the bar will land.
    expect((ghost as HTMLElement).style.top).toBe("64px");
    // Nothing written yet.
    expect(callMock.mock.calls.some((c) => c[0] === "note_create")).toBe(false);

    document.dispatchEvent(new MouseEvent("mouseup", { clientX: 400, clientY: 80, bubbles: true }));
    await waitFor(() => expect(getByTestId("timeline-create-pop")).toBeDefined());
    expect(queryByTestId("timeline-ghost")).toBeNull();
  });

  it("dragging a bar's edge handle previews the new span and commits it through replacePrimaryDate (note_date_update)", async () => {
    mockCreateFlow();
    const ui = render(<TimelineTab />);
    const { getByTestId, getAllByTestId } = ui;
    await frameItems(ui);
    await waitFor(() => expect(getAllByTestId("timeline-item").length).toBe(2));
    const canvas = getByTestId("timeline-canvas");
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, top: 0, left: 0, bottom: 400, right: 800, width: 800, height: 400,
      toJSON: () => ({}),
    } as DOMRect);

    const bar = getAllByTestId("timeline-item").find(
      (el) => el.getAttribute("data-note-id") === "n2",
    )!;
    const toHandle = [...bar.querySelectorAll("[data-tl-resize]")].find(
      (el) => el.getAttribute("data-edge") === "to",
    )!;

    toHandle.dispatchEvent(
      new MouseEvent("mousedown", { button: 0, clientX: 700, clientY: 80, bubbles: true }),
    );
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 760, clientY: 80, bubbles: true }));
    // Live readout of the resulting range while still dragging.
    await waitFor(() => expect(getByTestId("timeline-span-chip").textContent).toMatch(/\d/));
    document.dispatchEvent(new MouseEvent("mouseup", { clientX: 760, clientY: 80, bubbles: true }));

    // note_set_event_end was deleted — replacePrimaryDate's add+promote composite absorbs it.
    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith(
        "note_date_update",
        expect.objectContaining({ id: "primary-row", end_year: expect.any(Number) }),
      );
    });
    // Editing a bar never navigates either.
    expect(selectNoteMock).not.toHaveBeenCalled();
  });

  it("dragging a bar's BODY moves the whole note (duration preserved) and does not open it", async () => {
    mockCreateFlow();
    const ui = render(<TimelineTab />);
    const { getByTestId, getAllByTestId } = ui;
    await frameItems(ui);
    await waitFor(() => expect(getAllByTestId("timeline-item").length).toBe(2));
    const canvas = getByTestId("timeline-canvas");
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, top: 0, left: 0, bottom: 400, right: 800, width: 800, height: 400,
      toJSON: () => ({}),
    } as DOMRect);

    const bar = getAllByTestId("timeline-item").find(
      (el) => el.getAttribute("data-note-id") === "n2",
    )!;
    // The hook's whole input is on the element (same contract as the edge handles).
    expect(Number(bar.getAttribute("data-start"))).toBe(1794);
    expect(Number(bar.getAttribute("data-end"))).toBe(1797);
    expect(bar.getAttribute("data-precision")).toBe("year"); // n2 stores year-only dates

    act(() => {
      bar.dispatchEvent(
        new MouseEvent("mousedown", { button: 0, clientX: 100, clientY: 80, bubbles: true }),
      );
      document.dispatchEvent(
        new MouseEvent("mousemove", { clientX: 300, clientY: 80, bubbles: true }),
      );
    });
    // Live preview chip while moving, same language as resize/ghost.
    expect(getByTestId("timeline-span-chip").textContent).toMatch(/\d/);
    act(() => {
      document.dispatchEvent(
        new MouseEvent("mouseup", { clientX: 300, clientY: 80, bubbles: true }),
      );
      // The browser fires this click right after mouseup, in the same task — the suppression
      // listener is a one-shot, so it must be exercised here and not after an await.
      fireEvent.click(bar);
    });
    expect(selectNoteMock).not.toHaveBeenCalled();

    // note_update(year)/note_set_event_precision/note_set_event_end's old three-call sequence
    // (timelineOps.ts, deleted this wave) collapses to one replacePrimaryDate call — there's no
    // intermediate state to sequence around any more (see TimelineTab.tsx::commitMove).
    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith(
        "note_date_update",
        expect.objectContaining({ id: "primary-row", year: expect.any(Number), end_year: expect.any(Number) }),
      );
    });
    const moved = callMock.mock.calls.find((c) => c[0] === "note_date_update")![1] as {
      year: number; end_year: number; month: number | null; day: number | null;
    };
    expect(moved.year).not.toBe(1794); // it actually moved
    // Duration preserved exactly (1794–1796 stays a 2-year span).
    expect(moved.end_year - moved.year).toBe(2);
    // Year-only note on a year-snapping axis keeps its precision (no invented month/day).
    expect(moved.month).toBeNull();
    expect(moved.day).toBeNull();
    expect(callMock).not.toHaveBeenCalledWith("note_set_event_precision", expect.anything());
    expect(callMock).not.toHaveBeenCalledWith("note_set_event_end", expect.anything());
  });

  it("a bar mousedown below the drag threshold is still a plain double-click that opens the note", async () => {
    mockCreateFlow();
    const ui = render(<TimelineTab />);
    const { getByTestId, getAllByTestId } = ui;
    await frameItems(ui);
    await waitFor(() => expect(getAllByTestId("timeline-item").length).toBe(2));
    const canvas = getByTestId("timeline-canvas");
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, top: 0, left: 0, bottom: 400, right: 800, width: 800, height: 400,
      toJSON: () => ({}),
    } as DOMRect);

    const bar = getAllByTestId("timeline-item").find(
      (el) => el.getAttribute("data-note-id") === "n2",
    )!;
    bar.dispatchEvent(
      new MouseEvent("mousedown", { button: 0, clientX: 100, clientY: 80, bubbles: true }),
    );
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 101, clientY: 80, bubbles: true }));
    document.dispatchEvent(new MouseEvent("mouseup", { clientX: 101, clientY: 80, bubbles: true }));

    // Below-threshold movement never enters "move" mode, so it's still a plain double-click that
    // opens the note (not a drag the suppression trap should swallow).
    fireEvent.dblClick(bar);
    expect(selectNoteMock).toHaveBeenCalledWith("n2");
    expect(callMock.mock.calls.some((c) => c[0] === "note_update")).toBe(false);
  });

  it("right-click a bar opens a move-to-folder menu, and choosing a folder calls note_update with the note+folder ids", async () => {
    callMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "dashboard_timeline") return sampleResult();
      if (cmd === "note_update") return { id: args?.id };
      return {};
    });
    const ui = render(<TimelineTab />);
    const { getAllByTestId, getByText } = ui;
    await frameItems(ui);
    await waitFor(() => expect(getAllByTestId("timeline-item").length).toBe(2));

    const bar = getAllByTestId("timeline-item").find(
      (el) => el.getAttribute("data-note-id") === "n2",
    )!;
    // n2 is in folder fA (see sampleResult) — the menu offers the OTHER folder, Beta (fB), not
    // Alpha again and not the inbox (mirrors ContextMenu.tsx's own move-to-folder exclusions).
    fireEvent.contextMenu(bar);

    await waitFor(() => expect(getByText("Beta")).toBeDefined());

    fireEvent.click(getByText("Beta"));

    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith(
        "note_update",
        expect.objectContaining({ id: "n2", folder_id: "fB" }),
      );
    });
    // Moving a note is not opening it.
    expect(selectNoteMock).not.toHaveBeenCalled();
  });

  it("right-click on empty canvas does not open the move-to-folder menu", async () => {
    callMock.mockResolvedValue(sampleResult());
    const ui = render(<TimelineTab />);
    const { getByTestId, queryByText, queryByTestId } = ui;
    await frameItems(ui);
    const canvas = getByTestId("timeline-canvas");
    fireEvent.contextMenu(canvas);
    // The move-to-folder choice list (folder names) never appears from an empty-canvas right-click.
    expect(queryByText("Alpha")).toBeNull();
    expect(queryByText("Beta")).toBeNull();
    expect(queryByTestId("timeline-create-pop")).toBeNull();
  });

  // Local quick-search is gone (owner decision, "완전 공유") — the timeline now reads the SAME
  // useSearchStore the sidebar and HomeTab's global search box write. These tests seed the store
  // directly with setState (never setQuery/setYearRange's own IPC-triggering path — that's
  // HomeTab's job) so they exercise TimelineTab's consumption of the store, not the store itself.
  it("dashboard search hit ticks appear on the brush, and non-matching items dim in place", async () => {
    callMock.mockResolvedValue(sampleResult());
    const ui = render(<TimelineTab />);
    const { getByTestId, getAllByTestId, queryByTestId } = ui;
    await frameItems(ui);
    await waitFor(() => expect(getAllByTestId("timeline-item").length).toBe(2));

    // No query yet — no ticks, nothing dimmed.
    expect(queryByTestId("timeline-brush-hit-tick")).toBeNull();
    for (const el of getAllByTestId("timeline-item")) {
      expect(el.getAttribute("data-search-dim")).toBeNull();
    }

    act(() => {
      useSearchStore.setState({
        query: "진주",
        searchResults: [
          { id: "n1", folder_id: "fA", title: "진주성 전투", year: 1592, is_favorite: false, exported_at: null, has_image: false, tag_names: [], region: null, status: null, icon: null, lat: null, lng: null, created_at: "", updated_at: "", month: null, day: null },
        ],
      });
    });

    await waitFor(() => expect(getByTestId("timeline-brush-hit-tick")).toBeDefined());
    const items = getAllByTestId("timeline-item");
    const n1 = items.find((el) => el.getAttribute("data-note-id") === "n1")!;
    const n2 = items.find((el) => el.getAttribute("data-note-id") === "n2")!;
    expect(n1.getAttribute("data-search-dim")).toBeNull();
    expect(n2.getAttribute("data-search-dim")).toBe("true");

    // Shared accent-family token (QA8 2C) — same token the sidebar rail uses.
    const tick = getByTestId("timeline-brush-hit-tick");
    expect((tick as HTMLElement).style.background).toContain("search-hit");
    // Tick is keyboard-reachable (not aria-hidden / pointer-events none).
    expect(tick.getAttribute("aria-hidden")).toBeNull();
    expect(tick.tagName).toBe("BUTTON");

    // Clearing the query clears both the ticks and the dim.
    act(() => {
      useSearchStore.setState({ query: "", searchResults: [] });
    });
    await waitFor(() => expect(queryByTestId("timeline-brush-hit-tick")).toBeNull());
    expect(n2.getAttribute("data-search-dim")).toBeNull();
  });

  it("clicking a brush search-hit tick brackets the view to that bucket's year range", async () => {
    callMock.mockResolvedValue(sampleResult());
    const ui = render(<TimelineTab />);
    const { getByTestId, getAllByTestId } = ui;
    await frameItems(ui);
    await waitFor(() => expect(getAllByTestId("timeline-item").length).toBe(2));

    act(() => {
      useSearchStore.setState({
        query: "진주",
        searchResults: [
          { id: "n1", folder_id: "fA", title: "진주성 전투", year: 1592, is_favorite: false, exported_at: null, has_image: false, tag_names: [], region: null, status: null, icon: null, lat: null, lng: null, created_at: "", updated_at: "", month: null, day: null },
        ],
      });
    });

    const tick = await waitFor(() => getByTestId("timeline-brush-hit-tick"));
    const before = getByTestId("timeline-range").textContent ?? "";
    const from = Number(tick.getAttribute("data-from"));
    const to = Number(tick.getAttribute("data-to"));
    expect(Number.isFinite(from)).toBe(true);
    expect(Number.isFinite(to)).toBe(true);
    expect(to).toBeGreaterThan(from);

    fireEvent.click(tick);

    await waitFor(() => {
      const after = getByTestId("timeline-range").textContent ?? "";
      expect(after).not.toBe(before);
      // Range readout shows the bracketed years (rounded in display).
      expect(after).toMatch(String(Math.round(from)));
    });
    // Brush → readout stay in lockstep (one source of truth).
    await waitFor(() => {
      expect(getByTestId("timeline-range-readout").textContent).toContain(
        String(Math.round(from)),
      );
    });
  });

  it("default view FITS the notes that exist (not the full corpus axis) and leaves the sidebar year filter full", async () => {
    callMock.mockResolvedValue(sampleResult());
    const { getByTestId } = render(<TimelineTab />);
    await waitFor(() => expect(getByTestId("timeline-range-readout")).toBeDefined());
    await waitFor(() => expect(callMock).toHaveBeenCalled());

    // Sidebar/global filter must remain the full corpus bounds we seeded.
    expect(useSearchStore.getState().yearFrom).toBe(900);
    expect(useSearchStore.getState().yearTo).toBe(2020);

    await waitFor(() => {
      const brush = getByTestId("timeline-brush");
      const [from, to] = (brush.getAttribute("aria-valuetext") ?? "").split(" – ").map(Number);
      // Sample notes run 1592(day) → 1796; fit frames them with ~12% padding on each side …
      expect(from).toBeGreaterThan(1500);
      expect(to).toBeLessThan(1900);
      // … and is narrower than the padded corpus axis (~1382–1907) it used to open on.
      expect(to - from).toBeLessThan(500);
      // Chip agrees with the brush (one viewport state). Numbers only — no "View " prefix, and
      // no era name here because the sidebar filter is still the full corpus.
      expect(getByTestId("timeline-range-readout").textContent).toContain(String(from));
      expect(getByTestId("timeline-range-readout").textContent).not.toMatch(/View |보기/);
    });
  });

  it("empty notebook has nothing to fit — falls back to today±1", async () => {
    callMock.mockResolvedValue(sampleResult({ items: [], eras: [], total_matched: 0 }));
    const { getByTestId } = render(<TimelineTab />);
    await waitFor(() => expect(callMock).toHaveBeenCalled());
    await waitFor(() => {
      const [from, to] = (
        getByTestId("timeline-brush").getAttribute("aria-valuetext") ?? ""
      )
        .split(" – ")
        .map(Number);
      expect(to - from).toBe(2);
    });
  });

  it("zooming commits into the view only; brush and readout never diverge", async () => {
    callMock.mockResolvedValue(sampleResult());
    const ui = render(<TimelineTab />);
    const { getByTestId } = ui;
    await frameItems(ui);

    const storeBefore = {
      from: useSearchStore.getState().yearFrom,
      to: useSearchStore.getState().yearTo,
    };

    zoomToMonth(ui);

    await waitFor(() => {
      const [from, to] = (getByTestId("timeline-brush").getAttribute("aria-valuetext") ?? "")
        .split(" – ")
        .map(Number);
      expect(to - from).toBeCloseTo(1, 1);
      // Readout reports the same window the brush does (one viewport state).
      const shown = getByTestId("timeline-range-readout").textContent ?? "";
      expect(shown).toContain(String(Math.floor(from)));
    });
    // Global sidebar filter unchanged — the camera never writes the filter.
    expect(useSearchStore.getState().yearFrom).toBe(storeBefore.from);
    expect(useSearchStore.getState().yearTo).toBe(storeBefore.to);
  });

  it("the chip names the active era preset next to the numbers", async () => {
    useTaxonomyStore.setState({
      eras: [{ id: "e-grow", workspace_id: "ws", name: "성장기", from_year: 1500, to_year: 1700, position: 0 }],
    });
    useSearchStore.setState({ yearFrom: 1500, yearTo: 1700 });
    callMock.mockResolvedValue(sampleResult());
    const { getByTestId } = render(<TimelineTab />);

    await waitFor(() => {
      const shown = getByTestId("timeline-range-readout").textContent ?? "";
      expect(shown).toContain("1500 – 1700");
      expect(shown).toContain("성장기");
    });

    // Same match rule the era dropdown uses — widen the filter and the name drops off.
    useSearchStore.setState({ yearFrom: 900, yearTo: 2020 });
    await waitFor(() =>
      expect(getByTestId("timeline-range-readout").textContent).not.toContain("성장기"),
    );
  });

  it("'전체로' clears the year filter AND widens the camera back to the full axis", async () => {
    // Narrowed period on mount → the view brackets it and the reset link is offered.
    useSearchStore.setState({ yearFrom: 1500, yearTo: 1700 });
    callMock.mockResolvedValue(sampleResult());
    const { getByTestId } = render(<TimelineTab />);
    await waitFor(() => expect(callMock).toHaveBeenCalled());
    await waitFor(() =>
      expect(getByTestId("timeline-range-readout").textContent).toContain("1500 – 1700"),
    );

    fireEvent.click(getByTestId("timeline-range-readout"));
    fireEvent.click(getByTestId("timeline-era-reset"));

    // Filter cleared…
    expect(useSearchStore.getState().yearFrom).toBe(900);
    expect(useSearchStore.getState().yearTo).toBe(2020);
    // …and the camera followed. Widening used to be a no-op (the period→view effect only reacts
    // to a NARROWED period), so "전체로" left the view stuck at 1500–1700.
    await waitFor(() => {
      const [from, to] = (getByTestId("timeline-brush").getAttribute("aria-valuetext") ?? "")
        .split(" – ")
        .map(Number);
      expect(to - from).toBeGreaterThan(200);
    });
  });

  it("mounting with an already-narrowed store period brackets the view immediately (beats both fit and today±1)", async () => {
    useSearchStore.setState({ yearFrom: 1500, yearTo: 1700 });
    callMock.mockResolvedValue(sampleResult());
    const { getByTestId } = render(<TimelineTab />);

    // A store that arrives pre-narrowed (sidebar/era/map) must win on the first paint and stay
    // after fetch — readout and brush in lockstep.
    expect(getByTestId("timeline-range-readout").textContent).toContain("1500 – 1700");

    // After fetch clamps into deriveFullRange (~1382–1907) the bracketed period remains.
    await waitFor(() => {
      expect(callMock).toHaveBeenCalled();
      expect(getByTestId("timeline-range-readout").textContent).toContain("1500 – 1700");
      expect(getByTestId("timeline-brush").getAttribute("aria-valuetext")).toBe("1500 – 1700");
    });
  });

  it("real mount sequence: applyYearCounts expanding corpus does not blow view from today±1 to full axis", async () => {
    // Release race: Timeline mounts while search store still has the pre-histogram fallback
    // bounds; loadTree later rewrites yearBounds/yearFrom/yearTo to the real corpus full range
    // while remaining "full" (not user-narrowed). The period-sync effect must NOT treat that
    // rewrite as a user period choice and expand the local view to the full axis.
    useSearchStore.setState({
      yearBounds: { min: 1926, max: 2026 },
      yearFrom: 1926,
      yearTo: 2026,
    });
    // Wide corpus like the release build (-241…2075-ish) via eras + items.
    callMock.mockResolvedValue(
      sampleResult({
        items: [
          {
            note_id: "n-old",
            title: "Ancient",
            kind: "point",
            year: -241,
            month: null,
            day: null,
            end_year: null,
            end_month: null,
            end_day: null,
            folder_id: "fA",
          },
          {
            note_id: "n-far",
            title: "Future",
            kind: "point",
            year: 2075,
            month: null,
            day: null,
            end_year: null,
            end_month: null,
            end_day: null,
            folder_id: "fA",
          },
        ],
        eras: [{ id: "e1", name: "All", from_year: -241, to_year: 2075, position: 0 }],
        total_matched: 2,
      }),
    );
    const { getByTestId } = render(<TimelineTab />);
    await waitFor(() => expect(callMock).toHaveBeenCalled());

    const readSpan = () => {
      const [from, to] = (getByTestId("timeline-brush").getAttribute("aria-valuetext") ?? "")
        .split(" – ")
        .map(Number);
      return { from, to, span: to - from };
    };

    await waitFor(() => expect(Number.isFinite(readSpan().span)).toBe(true));
    const before = readSpan();

    // Histogram lands (same path loadTree → refreshYearHistogram → applyYearCounts).
    act(() => {
      useSearchStore.getState().applyYearCounts({ [-241]: 1, 1592: 2, 2075: 1 });
    });

    // The corpus-bounds rewrite is not a user period choice: the seeded view must survive it
    // untouched (it also must not re-seed — the view is seeded once per notebook).
    await waitFor(() => {
      const s = useSearchStore.getState();
      expect(s.yearFrom).toBe(s.yearBounds.min);
      expect(s.yearTo).toBe(s.yearBounds.max);
    });
    const after = readSpan();
    expect(after.span).toBe(before.span);
    expect(after.from).toBe(before.from);
  });

  it("surfaces the shared EraChips add control (기간 추가) on the Timeline tab itself", async () => {
    callMock.mockResolvedValue(sampleResult());
    const { getByRole, getByTestId } = render(<TimelineTab />);
    await waitFor(() => expect(getByTestId("timeline-range-readout")).toBeDefined());
    fireEvent.click(getByTestId("timeline-range-readout"));
    await waitFor(() => {
      // Same button TimelineFilter mounts — reuse, not a parallel implementation.
      expect(
        getByRole("button", { name: /add period|ajouter une période|기간 추가/i }),
      ).toBeDefined();
    });
  });

  describe("Q12: 실제 밀도 기반 dense 전환 및 버킷 결함 수정", () => {
    it("오늘날 형태의 53개 아이템(3년에 걸침)은 밀집 모드로 강등되지 않고 막대로 렌더링된다", async () => {
      // 53 items: 50 in 2026, 3 in 2027
      const items: TimelineNoteItem[] = [];
      for (let i = 0; i < 50; i++) {
        items.push({
          note_id: `note-2026-${i}`,
          title: `Item 2026 ${i}`,
          kind: i % 4 === 0 ? "bar" : "point",
          year: 2026,
          month: 1 + Math.floor(i / 5),
          day: 1 + (i % 25),
          end_year: i % 4 === 0 ? 2026 : null,
          end_month: i % 4 === 0 ? 6 : null,
          end_day: i % 4 === 0 ? 30 : null,
          folder_id: "fA",
        });
      }
      for (let i = 0; i < 3; i++) {
        items.push({
          note_id: `note-2027-${i}`,
          title: `Item 2027 ${i}`,
          kind: "point",
          year: 2027,
          month: 3 + i * 2,
          day: 15,
          end_year: null,
          end_month: null,
          end_day: null,
          folder_id: "fA",
        });
      }

      callMock.mockResolvedValue(
        sampleResult({
          from_year: 2026,
          to_year: 2029,
          items,
          total_matched: 53,
          capped: false,
        }),
      );

      const ui = render(<TimelineTab />);
      const { getAllByTestId, queryAllByTestId } = ui;
      await frameItems(ui);

      // 개수가 50을 넘어도 기하학적 밀도가 낮으므로 버킷이 아닌 아이템들이 정상 렌더링됨
      await waitFor(() => {
        expect(getAllByTestId("timeline-item").length).toBeGreaterThan(0);
      });
      expect(queryAllByTestId("timeline-bucket").length).toBe(0);
    });

    it("한 달에 500개가 몰린 합성 데이터는 눈금 단위 버킷 막대로 전환된다", async () => {
      const items: TimelineNoteItem[] = [];
      for (let i = 0; i < 500; i++) {
        items.push({
          note_id: `crowd-${i}`,
          title: `Crowd ${i}`,
          kind: "point",
          year: 2026,
          month: 3,
          day: 1 + (i % 28),
          end_year: null,
          end_month: null,
          end_day: null,
          folder_id: "fA",
        });
      }

      callMock.mockResolvedValue(
        sampleResult({
          from_year: 2026,
          to_year: 2027,
          items,
          total_matched: 500,
          capped: false,
        }),
      );

      const ui = render(<TimelineTab />);
      const { getAllByTestId, queryAllByTestId } = ui;
      await frameItems(ui);

      await waitFor(() => {
        expect(getAllByTestId("timeline-bucket").length).toBeGreaterThan(0);
      });
      expect(queryAllByTestId("timeline-item").length).toBe(0);
    });
  });
});

// 2026-10-19 화면 보드: 항목 툴팁 연도가 반올림됐다 — 연 단위 축에서 2026-07-29 가 "(2027)",
// 2027-09-30 이 "(2028)". 눈금용 Math.round 가 실제 날짜에도 쓰였기 때문(dateFmt.formatTimelineTick).
describe("spanLabel — item tooltip reads the item's own dates, not rounded axis boundaries", () => {
  const range = (
    y: number, m: number | null, d: number | null,
    ey: number | null = null, em: number | null = null, ed: number | null = null,
  ) => itemTimeRange({ year: y, month: m, day: d, end_year: ey, end_month: em, end_day: ed, kind: "point" });

  it("a late-July / late-September point keeps its own year on a year axis", () => {
    const jul = range(2026, 7, 29);
    const sep = range(2027, 9, 30);
    expect(spanLabel(jul.start, jul.end, 1, "ko")).toBe("2026");
    expect(spanLabel(sep.start, sep.end, 1, "ko")).toBe("2027");
  });

  it("a bar's end is its real last day, not its end snapped to the nearest year", () => {
    const r = range(2025, 11, 1, 2026, 3, 31);
    expect(spanLabel(r.start, r.end, 1, "en")).toBe("2025 – 2026");
    const r2 = range(2026, 7, 29, 2027, 9, 30);
    expect(spanLabel(r2.start, r2.end, 1, "en")).toBe("2026 – 2027");
  });

  it("same on a month axis — an end early in a month is not pulled back to the previous month", () => {
    const r = range(2026, 7, 10, 2026, 9, 5);
    expect(spanLabel(r.start, r.end, TICK_STEP_MONTH, "en")).toBe("Jul – Sep");
  });

  it("year-precision notes and snapped gesture spans read as before", () => {
    const y = range(1592, null, null);
    expect(spanLabel(y.start, y.end, 1, "en")).toBe("1592");
    // A create ghost snapped to year boundaries [2026, 2028) covers 2026 and 2027.
    expect(spanLabel(2026, 2028, 1, "en")).toBe("2026 – 2027");
  });
});
