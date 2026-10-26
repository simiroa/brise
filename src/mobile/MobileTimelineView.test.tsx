import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, fireEvent, waitFor } from "@testing-library/react";
import type { NoteSummary } from "../lib/commands.gen";

const noteQueryCollectMock = vi.fn();
vi.mock("../lib/noteQuery", () => ({
  noteQueryCollect: (...args: unknown[]) => noteQueryCollectMock(...args),
  useNoteQueryVersion: () => 0,
  EXPANDED_BOARD_MAX_NOTES: 5000,
}));

import { useSearchStore } from "../stores/search";
import { MobileTimelineView } from "./MobileTimelineView";

function note(patch: Partial<NoteSummary> & { id: string }): NoteSummary {
  return {
    folder_id: "f1",
    title: patch.title ?? patch.id,
    year: 2026,
    is_favorite: false,
    exported_at: null,
    has_image: false,
    tag_names: [],
    region: null,
    status: null,
    icon: null,
    lat: null,
    lng: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    month: null,
    day: null,
    ...patch,
  };
}

beforeEach(() => {
  noteQueryCollectMock.mockReset().mockResolvedValue({ notes: [], total: 0 });
  useSearchStore.setState({
    yearFrom: 1900,
    yearTo: 2100,
    selectedTags: [],
    tagMode: "and",
    regionFilter: null,
    statusFilter: [],
    dateRange: null,
  } as any);
  // jsdom does not implement scrollIntoView.
  Element.prototype.scrollIntoView = vi.fn();
});

describe("MobileTimelineView", () => {
  it("fetches notes sorted year_asc, capped at the shared EXPANDED_BOARD_MAX_NOTES", async () => {
    render(<MobileTimelineView onOpenNote={() => {}} />);
    await waitFor(() => expect(noteQueryCollectMock).toHaveBeenCalled());
    const [axes, opts] = noteQueryCollectMock.mock.calls[0]!;
    expect(axes.sort).toBe("year_asc");
    expect(opts).toEqual({ maxNotes: 5000 });
  });

  it("reflects the shared filter axes (tags/status/date range) into the note_query it issues", async () => {
    useSearchStore.setState({ selectedTags: ["travel"], statusFilter: ["done"], dateRange: "last7" } as any);
    render(<MobileTimelineView onOpenNote={() => {}} />);
    await waitFor(() => expect(noteQueryCollectMock).toHaveBeenCalled());
    const [axes] = noteQueryCollectMock.mock.calls[0]!;
    expect(axes.selectedTags).toEqual(["travel"]);
    expect(axes.statusFilter).toEqual(["done"]);
    expect(axes.dateRange).toBe("last7");
  });

  it("groups notes under year/month headers via the shared flattenTimelineRows module", async () => {
    noteQueryCollectMock.mockResolvedValue({
      notes: [
        note({ id: "n1", year: 2025, month: 3, day: 10, title: "March note" }),
        note({ id: "n2", year: 2026, month: null, day: null, title: "Unknown-month note" }),
      ],
      total: 2,
    });
    render(<MobileTimelineView onOpenNote={() => {}} />);

    // Scoped to the list body — the range slider's label above also renders years.
    const list = screen.getByTestId("mobile-timeline-view");
    expect(await within(list).findByText("2025")).toBeTruthy();
    expect(within(list).getByText("2025.03")).toBeTruthy();
    expect(within(list).getByText("March note")).toBeTruthy();
    expect(within(list).getByText("2026")).toBeTruthy();
    expect(within(list).getByText("Month unknown")).toBeTruthy();
    expect(within(list).getByText("Unknown-month note")).toBeTruthy();
  });

  it("tapping a note row opens it", async () => {
    noteQueryCollectMock.mockResolvedValue({ notes: [note({ id: "n1", title: "Tap me" })], total: 1 });
    const onOpenNote = vi.fn();
    render(<MobileTimelineView onOpenNote={onOpenNote} />);
    fireEvent.click(await screen.findByText("Tap me"));
    expect(onOpenNote).toHaveBeenCalledWith("n1");
  });

  it("shows the timeline-specific empty state when there are no notes in range", async () => {
    render(<MobileTimelineView onOpenNote={() => {}} />);
    await waitFor(() => expect(screen.getByText("No notes in this range")).toBeTruthy());
  });

  it("row date is the note's event day (left badge), not updated_at (2026-10-10)", async () => {
    noteQueryCollectMock.mockResolvedValue({
      notes: [
        note({ id: "n1", year: 2026, month: 5, day: 3, title: "Event note", updated_at: "2026-09-17T10:00:00Z" }),
        note({ id: "n2", year: 2026, month: 5, day: null, title: "No day" }),
      ],
      total: 2,
    });
    render(<MobileTimelineView onOpenNote={() => {}} />);
    const row = (await screen.findByText("Event note")).closest("button")!;
    // Intl day-only: "3" (en/fr) / "3일" (ko) — locale wording is Intl's, the number is the event day.
    expect(row.querySelector(".mobile-timeline-day")?.textContent).toMatch(/^3(일)?$/);
    expect(row.textContent).not.toMatch(/Sep|17/);
    const noDay = screen.getByText("No day").closest("button")!;
    expect(noDay.querySelector(".mobile-timeline-day")).toBeNull();
  });

  it("top control is the year-range slider on the shared search axis (always shown)", async () => {
    noteQueryCollectMock.mockResolvedValue({ notes: [note({ id: "n1", year: 2026 })], total: 1 });
    render(<MobileTimelineView onOpenNote={() => {}} />);
    await within(screen.getByTestId("mobile-timeline-view")).findByText("2026");
    expect(screen.getByTestId("mobile-year-range")).toBeTruthy();
    // One year → nothing to jump between.
    expect(screen.queryByTestId("mobile-timeline-jump-next")).toBeNull();
  });

  it("jump buttons only scroll to a year header — they never narrow the range", async () => {
    noteQueryCollectMock.mockResolvedValue({
      notes: [note({ id: "n1", year: 2024 }), note({ id: "n2", year: 2026 })],
      total: 2,
    });
    render(<MobileTimelineView onOpenNote={() => {}} />);
    const prevBtn = (await screen.findByTestId("mobile-timeline-jump-prev")) as HTMLButtonElement;
    const nextBtn = screen.getByTestId("mobile-timeline-jump-next") as HTMLButtonElement;
    noteQueryCollectMock.mockClear();
    // M-23: 기준은 화면에 보이는 머리글 — 목록 맨 위(0)에 2024 머리글, 아래(500)에 2026 머리글.
    const tops: Record<string, number> = { "mobile-tl-y-2024": 0, "mobile-tl-y-2026": 500, "mobile-timeline-view": 0 };
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const key = this.id || this.getAttribute("data-testid") || "";
      return { top: tops[key] ?? 0 } as DOMRect;
    });
    const scrollSpy = Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>;
    scrollSpy.mockClear();
    fireEvent.click(prevBtn); // nothing above the top header
    expect(scrollSpy).not.toHaveBeenCalled();

    fireEvent.click(nextBtn);
    expect(scrollSpy).toHaveBeenCalledTimes(1);
    expect((scrollSpy.mock.contexts[0] as HTMLElement).id).toBe("mobile-tl-y-2026");
    rectSpy.mockRestore();
    expect(noteQueryCollectMock).not.toHaveBeenCalled();
    expect(useSearchStore.getState().yearFrom).toBe(1900);
    expect(useSearchStore.getState().yearTo).toBe(2100);
  });
});
