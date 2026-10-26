import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { assertRenderSettles } from "../../../test/renderLoop";
import { TimelineExpanded } from "./TimelineExpanded";
import { useSearchStore } from "../../../stores/search";
import { useNotesStore } from "../../../stores/notes";
import type { NoteSummary } from "../../../lib/commands.gen";

const noteQueryCollectMock = vi.fn();

vi.mock("../../../lib/invoke", () => ({
  call: vi.fn().mockResolvedValue({ notes: [] }),
  callSilent: vi.fn().mockResolvedValue({ notes: [] }),
  flushAll: vi.fn(),
  registerFlush: vi.fn(() => () => {}),
  emitNotice: vi.fn(),
}));

vi.mock("../../../lib/noteQuery", () => ({
  EXPANDED_BOARD_MAX_NOTES: 1000,
  noteQuery: vi.fn().mockResolvedValue({ notes: [] }),
  noteQueryCollect: (...args: unknown[]) => noteQueryCollectMock(...args),
  useNoteQueryVersion: () => 0,
}));

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
            width: 280,
            height: 400,
            top: 0,
            left: 0,
            right: 280,
            bottom: 400,
            x: 0,
            y: 0,
            toJSON: () => {},
          },
        } as unknown as ResizeObserverEntry,
      ],
      this as unknown as ResizeObserver,
    );
  }
  unobserve() {}
  disconnect() {}
};

function makeNote(partial: Partial<NoteSummary> & { id: string }): NoteSummary {
  return {
    folder_id: "f1",
    title: partial.title ?? partial.id,
    year: partial.year ?? 1500,
    is_favorite: false,
    exported_at: null,
    has_image: false,
    tag_names: [],
    region: null,
    status: null,
    icon: null,
    lat: null,
    lng: null,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
    month: null,
    day: null,
    ...partial,
  };
}

describe("TimelineExpanded", () => {
  beforeEach(() => {
    noteQueryCollectMock.mockReset();
    noteQueryCollectMock.mockResolvedValue({
      notes: [
        makeNote({ id: "a", year: 1592, title: "alpha" }),
        makeNote({ id: "b", year: 1610, title: "beta hit" }),
      ],
    });
    useSearchStore.setState({
      query: "",
      searchResults: [],
      yearFrom: 1000,
      yearTo: 2000,
      yearBounds: { min: 1000, max: 2000 },
      selectedTags: [],
      tagMode: "or",
      regionFilter: null,
      statusFilter: [],
    });
  });

  it("settles without a render storm when the hit strip depends on rows + query", () => {
    useSearchStore.setState({
      query: "hit",
      searchResults: [makeNote({ id: "b", year: 1610, title: "beta hit" })],
    });
    const { renders } = assertRenderSettles(() => <TimelineExpanded />, 40);
    expect(renders).toBeLessThanOrEqual(40);
    expect(renders).toBeGreaterThan(0);
  });

  it("builds hit ticks from server FTS searchResults (not title substring)", async () => {
    // Title has no "zzz" but FTS returned this id (e.g. body match) → rail still shows a tick.
    useSearchStore.setState({
      query: "zzz",
      searchResults: [makeNote({ id: "a", year: 1592, title: "alpha" })],
    });
    render(<TimelineExpanded />);
    await waitFor(() => expect(screen.getByTestId("timeline-hit-strip")).toBeTruthy());
    const tick = screen.getByTestId("timeline-hit-tick");
    expect(tick.getAttribute("data-row-index")).toBeTruthy();
    // Shared token with dashboard brush.
    expect((tick as HTMLElement).style.background).toContain("search-hit");
    // Keyboard-reachable group (not aria-hidden / tabIndex=-1-only strip).
    expect(screen.getByTestId("timeline-hit-strip").getAttribute("aria-hidden")).toBeNull();
    expect(tick.getAttribute("tabindex")).toBe("0");
  });

  it("does not paint hit ticks from title alone when searchResults is empty", async () => {
    useSearchStore.setState({
      query: "hit",
      searchResults: [],
    });
    render(<TimelineExpanded />);
    // Title still highlights "hit" in the list, but the rail uses server FTS ids only.
    await waitFor(() => expect(screen.getByText("1592")).toBeTruthy());
    expect(screen.queryByTestId("timeline-hit-strip")).toBeNull();
    expect(screen.queryByTestId("timeline-hit-tick")).toBeNull();
  });

  it("clicking a unique hit tick selects that note", async () => {
    const selectNoteSpy = vi.spyOn(useNotesStore.getState(), "selectNote").mockResolvedValue();
    useSearchStore.setState({
      query: "hit",
      searchResults: [makeNote({ id: "b", year: 1610, title: "beta hit" })],
    });
    render(<TimelineExpanded />);
    const tick = await screen.findByTestId("timeline-hit-tick");
    expect(tick.getAttribute("data-unique")).toBe("true");
    fireEvent.click(tick);
    expect(selectNoteSpy).toHaveBeenCalledWith("b");
    selectNoteSpy.mockRestore();
  });

  it("renders month-level granularity by default with collapsible headers", async () => {
    noteQueryCollectMock.mockResolvedValue({
      notes: [
        makeNote({ id: "a", year: 1592, month: 7, day: 8, title: "July 8 note" }),
        makeNote({ id: "b", year: 1592, month: null, day: null, title: "No month" }),
      ],
    });
    render(<TimelineExpanded />);

    await waitFor(() => expect(screen.getByText("1592")).toBeTruthy());
    // 일 정밀도 노트여도 헤더는 월 단위까지만 — "1592.07"은 표시되지만 "1592.07.08"은 표시되지 않는다.
    expect(await screen.findByText("1592.07")).toBeTruthy();
    expect(screen.queryByText("1592.07.08")).toBeNull();
    expect(screen.getByText("July 8 note")).toBeTruthy();
    expect(screen.getByText("No month")).toBeTruthy();
    // Segmented zoom buttons should not exist
    expect(screen.queryByTestId("timeline-zoom-segment")).toBeNull();
  });

  it("dragging past the move threshold suppresses the trailing click's note selection", async () => {
    const selectNoteSpy = vi.spyOn(useNotesStore.getState(), "selectNote").mockResolvedValue();
    render(<TimelineExpanded />);
    const noteButton = await screen.findByText("alpha");

    fireEvent.mouseDown(noteButton, { button: 0, clientY: 100 });
    fireEvent.mouseMove(document, { clientY: 130 }); // 30px > the 3px move threshold
    fireEvent.mouseUp(document);
    fireEvent.click(noteButton);

    expect(selectNoteSpy).not.toHaveBeenCalled();
    selectNoteSpy.mockRestore();
  });

  it("a plain click (no intervening move past the threshold) still selects the note", async () => {
    const selectNoteSpy = vi.spyOn(useNotesStore.getState(), "selectNote").mockResolvedValue();
    render(<TimelineExpanded />);
    const noteButton = await screen.findByText("alpha");

    fireEvent.mouseDown(noteButton, { button: 0, clientY: 100 });
    fireEvent.mouseUp(document);
    fireEvent.click(noteButton);

    expect(selectNoteSpy).toHaveBeenCalledWith("a");
    selectNoteSpy.mockRestore();
  });

  // 오너 QA7 후속: 크게보기 버튼은 TimelineFilter 의 범위 라벨 줄로 옮겼다(슬라이더 위).
  // 여기 남아 있던 전용 헤더 행이 슬라이더와 리스트 사이에 빈 띠를 만들었기 때문.
  // 라우팅 동작 검증은 TimelineFilter.test.tsx 가 소유한다.
  it("no longer renders its own open-dashboard button (moved to the range readout row)", () => {
    render(<TimelineExpanded />);
    expect(screen.queryByTestId("timeline-open-dashboard")).toBeNull();
  });

  it("clicking a header label folds the year and hides its notes", async () => {
    render(<TimelineExpanded />);
    await waitFor(() => expect(screen.getByText("alpha")).toBeTruthy());

    // v 캐럿 제거 — 라벨 자체가 접기 토글 역할.
    const label = screen.getByText("1592");
    fireEvent.click(label);
    expect(screen.queryByText("alpha")).toBeNull();

    fireEvent.click(label);
    expect(screen.getByText("alpha")).toBeDefined();
  });
});
