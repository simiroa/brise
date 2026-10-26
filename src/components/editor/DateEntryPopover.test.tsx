import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { DateEntryPopover, formatDateEntryLine } from "./DateEntryPopover";
import { openDateEntry } from "../../lib/dateEntryBridge";
import { getActiveEditor } from "../../lib/aiSectionBridge";

// DatesPanel itself is fully covered by DatesPanel.test.tsx (calendar grid, weather fetch,
// note_dates_list/note_date_add calls). This popover only needs to know DatesPanel receives the
// right props and that its onRowAdded callback drives the popover's own close/insert behavior — so
// it's replaced with a minimal stub that exposes both.
vi.mock("../titlebar/DatesPanel", () => ({
  DatesPanel: (props: {
    noteId: string | null;
    seed?: { year: number; month: number | null; day: number | null };
    initialLabel?: string;
    initialStartTime?: string;
    initialEndTime?: string;
    onRowAdded?: (row: {
      id: string;
      year: number;
      month: number | null;
      day: number | null;
      end_year: number | null;
      end_month: number | null;
      end_day: number | null;
      label: string | null;
      start_time: string | null;
      end_time: string | null;
    }) => void;
  }) => (
    <div data-testid="dates-panel-stub">
      <span data-testid="stub-note-id">{props.noteId}</span>
      <span data-testid="stub-seed">{props.seed ? JSON.stringify(props.seed) : "none"}</span>
      <span data-testid="stub-label">{props.initialLabel ?? "none"}</span>
      <span data-testid="stub-start-time">{props.initialStartTime ?? "none"}</span>
      <span data-testid="stub-end-time">{props.initialEndTime ?? "none"}</span>
      <button
        type="button"
        data-testid="stub-add-row"
        onClick={() =>
          props.onRowAdded?.({
            id: "new-row",
            year: 2026,
            month: 9,
            day: 19,
            end_year: null,
            end_month: null,
            end_day: null,
            label: "경복궁방문",
            start_time: null,
            end_time: null,
          })
        }
      >
        add
      </button>
      <button
        type="button"
        data-testid="stub-add-row-timed"
        onClick={() =>
          props.onRowAdded?.({
            id: "new-row-timed",
            year: 2026,
            month: 9,
            day: 19,
            end_year: null,
            end_month: null,
            end_day: null,
            label: "경복궁방문",
            start_time: "14:00",
            end_time: "22:00",
          })
        }
      >
        add timed
      </button>
    </div>
  ),
}));

vi.mock("../../lib/aiSectionBridge", () => ({
  getActiveEditor: vi.fn(),
}));

afterEach(() => {
  cleanup();
});

// §W3a — handleRowAdded now also reads editor.schema.marks.date (to build the DateMark instance
// for the insertText path) and, for the "일정으로 등록" (no replaceRangeOnSave) path, chains
// setTextSelection/setMark directly. Both are stubbed here alongside the existing insertText
// tracking; `marked` exposes what got tagged for tests that care (most of the ones below only
// care that body text (`inserted`) stayed/didn't stay untouched, per their own names).
function makeFakeEditor(docSize = 100) {
  const inserted: { text: string; start: number; end: number }[] = [];
  const marked: { id: string; from: number; to: number }[] = [];
  const editor = {
    schema: { marks: { date: { create: (attrs: { id: string }) => ({ attrs }) } } },
    state: { doc: { content: { size: docSize } } },
    chain: () => ({
      focus: () => ({
        command: (fn: (ctx: {
          tr: {
            doc: { content: { size: number } };
            insertText: (t: string, s: number, e: number) => void;
            addMark: (from: number, to: number, mark: { attrs: { id: string } }) => void;
          };
        }) => boolean) => {
          const tr = {
            doc: { content: { size: docSize } },
            insertText: (text: string, start: number, end: number) => {
              inserted.push({ text, start, end });
            },
            addMark: (from: number, to: number, mark: { attrs: { id: string } }) => {
              marked.push({ id: mark.attrs.id, from, to });
            },
          };
          fn({ tr });
          return { run: vi.fn() };
        },
        setTextSelection: ({ from, to }: { from: number; to: number }) => ({
          setMark: (_type: string, attrs: { id: string }) => ({
            run: () => {
              marked.push({ id: attrs.id, from, to });
            },
          }),
        }),
      }),
    }),
  };
  return { editor, inserted, marked };
}

describe("formatDateEntryLine", () => {
  it("date + label, space-separated", () => {
    expect(
      formatDateEntryLine({
        id: "x",
        year: 2026,
        month: 9,
        day: 19,
        end_year: null,
        end_month: null,
        end_day: null,
        label: "경복궁방문",
        start_time: null,
        end_time: null,
      }),
    ).toBe("2026.09.19 경복궁방문");
  });

  it("no label — just the date", () => {
    expect(
      formatDateEntryLine({
        id: "x",
        year: 2026,
        month: 9,
        day: 19,
        end_year: null,
        end_month: null,
        end_day: null,
        label: null,
        start_time: null,
        end_time: null,
      }),
    ).toBe("2026.09.19");
  });

  // 2026-09-19 후속 — 오너의 원 예시("내일 2시부터 10시까지 경복궁방문")가 실제로 이 모양이 된다.
  it("date + time range + label — the owner's own example shape", () => {
    expect(
      formatDateEntryLine({
        id: "x",
        year: 2026,
        month: 9,
        day: 19,
        end_year: null,
        end_month: null,
        end_day: null,
        label: "경복궁방문",
        start_time: "14:00",
        end_time: "22:00",
      }),
    ).toBe("2026.09.19 14:00–22:00 경복궁방문");
  });

  it("start_time without end_time — just the start", () => {
    expect(
      formatDateEntryLine({
        id: "x",
        year: 2026,
        month: 9,
        day: 19,
        end_year: null,
        end_month: null,
        end_day: null,
        label: null,
        start_time: "14:00",
        end_time: null,
      }),
    ).toBe("2026.09.19 14:00");
  });
});

describe("DateEntryPopover", () => {
  beforeEach(() => {
    vi.mocked(getActiveEditor).mockReset();
  });

  it("renders nothing until openDateEntry fires", () => {
    render(<DateEntryPopover noteId="note-1" />);
    expect(screen.queryByTestId("date-entry-popover")).toBeNull();
  });

  it("opens with the payload's noteId and prefill, closes on Escape", () => {
    render(<DateEntryPopover noteId="note-1" />);

    act(() => {
      openDateEntry({
        noteId: "note-2",
        anchorX: 10,
        anchorY: 20,
        range: { from: 0, to: 3 },
        prefill: { start: { year: 2026, month: 9, day: 19 }, end: { end_year: null, end_month: null, end_day: null }, label: "경복궁방문" },
      });
    });

    expect(screen.getByTestId("date-entry-popover")).toBeTruthy();
    expect(screen.getByTestId("stub-note-id").textContent).toBe("note-2");
    expect(screen.getByTestId("stub-label").textContent).toBe("경복궁방문");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("date-entry-popover")).toBeNull();
  });

  // 2026-09-19 후속 — prefill 의 startTime/endTime 이 DatesPanel 의 시각 입력 초기값까지 닿는다.
  it("passes prefill.startTime/endTime through to DatesPanel's initialStartTime/initialEndTime", () => {
    render(<DateEntryPopover noteId="note-1" />);

    act(() => {
      openDateEntry({
        noteId: "note-1",
        anchorX: 10,
        anchorY: 20,
        range: { from: 0, to: 3 },
        prefill: {
          start: { year: 2026, month: 9, day: 19 },
          end: { end_year: null, end_month: null, end_day: null },
          label: "경복궁방문",
          startTime: "14:00",
          endTime: "22:00",
        },
      });
    });

    expect(screen.getByTestId("stub-start-time").textContent).toBe("14:00");
    expect(screen.getByTestId("stub-end-time").textContent).toBe("22:00");
  });

  it("closes on backdrop click without touching the editor", () => {
    const { editor } = makeFakeEditor();
    vi.mocked(getActiveEditor).mockReturnValue(editor as never);
    const { container } = render(<DateEntryPopover noteId="note-1" />);

    act(() => {
      openDateEntry({ noteId: "note-1", anchorX: 5, anchorY: 5, range: { from: 0, to: 3 } });
    });
    expect(screen.getByTestId("date-entry-popover")).toBeTruthy();

    const backdrop = container.firstElementChild as HTMLElement;
    fireEvent.click(backdrop);
    expect(screen.queryByTestId("date-entry-popover")).toBeNull();
  });

  it("replaceRangeOnSave:true replaces the range with the formatted line on a successful add (slash flow)", () => {
    const { editor, inserted, marked } = makeFakeEditor();
    vi.mocked(getActiveEditor).mockReturnValue(editor as never);
    render(<DateEntryPopover noteId="note-1" />);

    act(() => {
      openDateEntry({
        noteId: "note-1",
        anchorX: 5,
        anchorY: 5,
        range: { from: 2, to: 5 },
        replaceRangeOnSave: true,
      });
    });

    fireEvent.click(screen.getByTestId("stub-add-row"));

    const line = "2026.09.19 경복궁방문";
    expect(inserted).toEqual([{ text: line, start: 2, end: 5 }]);
    // §W3a — the newly-inserted span (not the pre-replace range) is what gets DateMark-tagged.
    expect(marked).toEqual([{ id: "new-row", from: 2, to: 2 + line.length }]);
    // popover closes itself after a successful add
    expect(screen.queryByTestId("date-entry-popover")).toBeNull();
  });

  it("a timed add inserts the date + time-range + label line (owner's own example)", () => {
    const { editor, inserted } = makeFakeEditor();
    vi.mocked(getActiveEditor).mockReturnValue(editor as never);
    render(<DateEntryPopover noteId="note-1" />);

    act(() => {
      openDateEntry({
        noteId: "note-1",
        anchorX: 5,
        anchorY: 5,
        range: { from: 2, to: 5 },
        replaceRangeOnSave: true,
      });
    });

    fireEvent.click(screen.getByTestId("stub-add-row-timed"));

    expect(inserted).toEqual([{ text: "2026.09.19 14:00–22:00 경복궁방문", start: 2, end: 5 }]);
  });

  it("replaceRangeOnSave omitted leaves the editor's text untouched but marks the selected range (selection-menu flow, D6)", () => {
    const { editor, inserted, marked } = makeFakeEditor();
    vi.mocked(getActiveEditor).mockReturnValue(editor as never);
    render(<DateEntryPopover noteId="note-1" />);

    act(() => {
      openDateEntry({ noteId: "note-1", anchorX: 5, anchorY: 5, range: { from: 2, to: 5 } });
    });

    fireEvent.click(screen.getByTestId("stub-add-row"));

    expect(inserted).toEqual([]);
    // §W3a — body_md bytes stay untouched (D6), but the already-selected text at `range` gets
    // DateMark-tagged with the new row's id so a later click can jump back to it.
    expect(marked).toEqual([{ id: "new-row", from: 2, to: 5 }]);
    expect(screen.queryByTestId("date-entry-popover")).toBeNull();
  });

  // 2026-09-19 후속 (§W3a 검증 중 발견) — 기존 DateMark 를 클릭해 편집 뷰로 연 팝오버에서 "+"로
  // 무관한 새 행을 추가하면, editRowId 가 안 잡히기 전까진 클릭이 넘긴 실재 range(그 마크 자신의
  // 범위)가 새 행 id 로 재마킹되어 원래 마크의 올바른 연결이 조용히 다른 행을 가리키게 됐다.
  it("editRowId set (DateMark click → edit view) + '+' unrelated new row does NOT re-mark the clicked span", () => {
    const { editor, inserted, marked } = makeFakeEditor();
    vi.mocked(getActiveEditor).mockReturnValue(editor as never);
    render(<DateEntryPopover noteId="note-1" />);

    act(() => {
      // dateMark.ts's click handler shape: a real (non-collapsed) range — the clicked mark's own
      // span — plus editRowId, no prefill, no replaceRangeOnSave.
      openDateEntry({ noteId: "note-1", anchorX: 5, anchorY: 5, range: { from: 2, to: 5 }, editRowId: "old-row" });
    });

    fireEvent.click(screen.getByTestId("stub-add-row"));

    expect(inserted).toEqual([]);
    expect(marked).toEqual([]); // the old-row → [2,5) link must survive untouched
    expect(screen.queryByTestId("date-entry-popover")).toBeNull();
  });
});
