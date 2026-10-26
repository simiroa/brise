import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { RegionEntryPopover } from "./RegionEntryPopover";
import { openRegionEntry } from "../../lib/regionEntryBridge";
import { getActiveEditor } from "../../lib/aiSectionBridge";

const callMock = vi.fn();
vi.mock("../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
}));

vi.mock("../../lib/aiSectionBridge", () => ({
  getActiveEditor: vi.fn(),
}));

vi.mock("../../stores/settings", () => {
  const state = { uiLang: "ko" };
  const useSettingsStore = (sel: (s: typeof state) => unknown) => sel(state);
  useSettingsStore.getState = () => state;
  return { useSettingsStore };
});

let activeNote: { note: { id: string; region: string | null; lat?: number | null; lng?: number | null } } | null = {
  note: { id: "note-1", region: null },
};
const setRegionMock = vi.fn(async (region: string | null) => {
  if (activeNote) activeNote = { note: { ...activeNote.note, region } };
});
// writePrimaryPlace(lib/placeCommit.ts) 가 쓰기 뒤 activeNote 를 다시 읽어 성공을 판정하므로, 가짜 스토어도
// 실제 patchActiveNote 처럼 좌표를 반영한다.
const setLocationMock = vi.fn(async (lat: number | null, lng: number | null) => {
  if (activeNote) activeNote = { note: { ...activeNote.note, lat, lng } };
});
const bumpAttachmentRevisionMock = vi.fn();

vi.mock("../../stores/notes", () => ({
  useNotesStore: {
    getState: () => ({
      activeNote,
      setRegion: setRegionMock,
      setLocation: setLocationMock,
      bumpAttachmentRevision: bumpAttachmentRevisionMock,
    }),
  },
}));

// DatesPanel(경유지) 흐름과 같은 관용구 — insertText 를 추적하는 최소 가짜 editor. 지역은 마크가
// 없으니 DateEntryPopover.test.tsx의 makeFakeEditor보다 얕다(addMark 트래킹 불필요).
function makeFakeEditor(docSize = 100) {
  const inserted: { text: string; start: number; end: number }[] = [];
  const editor = {
    state: { doc: { content: { size: docSize } } },
    chain: () => ({
      focus: () => ({
        command: (fn: (ctx: { tr: { doc: { content: { size: number } }; insertText: (t: string, s: number, e: number) => void } }) => boolean) => {
          const tr = {
            doc: { content: { size: docSize } },
            insertText: (text: string, start: number, end: number) => {
              inserted.push({ text, start, end });
            },
          };
          fn({ tr });
          return { run: vi.fn() };
        },
      }),
    }),
  };
  return { editor, inserted };
}

const openPopover = (over: Partial<Parameters<typeof openRegionEntry>[0]> = {}) => {
  act(() => {
    openRegionEntry({
      noteId: "note-1",
      anchorX: 5,
      anchorY: 5,
      range: { from: 2, to: 5 },
      ...over,
    });
  });
};

describe("RegionEntryPopover", () => {
  beforeEach(() => {
    callMock.mockReset();
    vi.mocked(getActiveEditor).mockReset();
    setRegionMock.mockClear();
    setLocationMock.mockClear();
    bumpAttachmentRevisionMock.mockClear();
    activeNote = { note: { id: "note-1", region: null } };
    vi.useFakeTimers();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("renders nothing until openRegionEntry fires", () => {
    render(<RegionEntryPopover noteId="note-1" />);
    expect(screen.queryByTestId("region-entry-popover")).toBeNull();
  });

  it("opens at the payload's anchor and prefills the search box from payload.query", () => {
    render(<RegionEntryPopover noteId="note-1" />);
    openPopover({ query: "경복궁" });

    expect(screen.getByTestId("region-entry-popover")).toBeTruthy();
    expect((screen.getByTestId("region-entry-search-input") as HTMLInputElement).value).toBe("경복궁");
  });

  it("closes on Escape", () => {
    render(<RegionEntryPopover noteId="note-1" />);
    openPopover();
    expect(screen.getByTestId("region-entry-popover")).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("region-entry-popover")).toBeNull();
  });

  it("closes on backdrop click without touching the editor", () => {
    const { editor } = makeFakeEditor();
    vi.mocked(getActiveEditor).mockReturnValue(editor as never);
    const { container } = render(<RegionEntryPopover noteId="note-1" />);
    openPopover();

    const backdrop = container.firstElementChild as HTMLElement;
    fireEvent.click(backdrop);
    expect(screen.queryByTestId("region-entry-popover")).toBeNull();
  });

  it("closing before the debounce fires never calls geocode_search (network-save regression, mirrors NoteRegionsList's own guard)", async () => {
    render(<RegionEntryPopover noteId="note-1" />);
    openPopover();

    fireEvent.change(screen.getByTestId("region-entry-search-input"), { target: { value: "경복궁" } });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("region-entry-popover")).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });

    expect(callMock).not.toHaveBeenCalled();
  });

  it("debounces geocode_search as the user types and lists results", async () => {
    callMock.mockResolvedValue({ results: [{ label: "경복궁, 서울", lat: 37.58, lng: 126.97 }] });
    render(<RegionEntryPopover noteId="note-1" />);
    openPopover();

    fireEvent.change(screen.getByTestId("region-entry-search-input"), { target: { value: "경복궁" } });
    expect(callMock).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(callMock).toHaveBeenCalledWith("geocode_search", { query: "경복궁", lang: "ko" });
    // 두 줄 행: 이름 + 부가 주소. 원본 라벨은 title 툴팁에 남는다.
    const row = screen.getByTestId("region-entry-result-0");
    expect(row.textContent).toBe("경복궁서울");
    expect(row.getAttribute("title")).toBe("경복궁, 서울");
  });

  it("no primary region yet: picking a result sets region+location, replaces the trigger text, and closes", async () => {
    const { editor, inserted } = makeFakeEditor();
    vi.mocked(getActiveEditor).mockReturnValue(editor as never);
    render(<RegionEntryPopover noteId="note-1" />);
    openPopover({ query: "경복궁" });

    // Prime the search results via the real debounce.
    callMock.mockResolvedValue({ results: [{ label: "경복궁, 서울", lat: 37.58, lng: 126.97 }] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("region-entry-result-0"));
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });

    expect(setRegionMock).toHaveBeenCalledWith("경복궁");
    expect(setLocationMock).toHaveBeenCalledWith(37.58, 126.97);
    // Waypoint path (note_region_add) must NOT run when there was no primary region yet.
    expect(callMock).not.toHaveBeenCalledWith("note_region_add", expect.anything());
    expect(inserted).toEqual([{ text: "경복궁", start: 2, end: 5 }]);
    expect(screen.queryByTestId("region-entry-popover")).toBeNull();
  });

  it("setRegion silently failing (rolled back, per patchActiveNote) leaves the popover open and the body untouched", async () => {
    setRegionMock.mockImplementationOnce(async () => {
      // Simulate patchActiveNote's own failure path: call() already toasted internally, the
      // promise still resolves (doesn't reject), but activeNote.note.region stays unchanged.
    });
    const { editor, inserted } = makeFakeEditor();
    vi.mocked(getActiveEditor).mockReturnValue(editor as never);
    render(<RegionEntryPopover noteId="note-1" />);
    openPopover({ query: "경복궁" });

    callMock.mockResolvedValue({ results: [{ label: "경복궁, 서울", lat: 37.58, lng: 126.97 }] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("region-entry-result-0"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(inserted).toEqual([]);
    expect(screen.getByTestId("region-entry-popover")).toBeTruthy();
  });

  it("already has a primary region: picking a result reads note_regions_list, adds a waypoint at the next position, and closes", async () => {
    activeNote = { note: { id: "note-1", region: "서울" } };
    const { editor, inserted } = makeFakeEditor();
    vi.mocked(getActiveEditor).mockReturnValue(editor as never);
    render(<RegionEntryPopover noteId="note-1" />);
    openPopover({ query: "경복궁" });

    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "geocode_search") {
        return { results: [{ label: "경복궁, 서울", lat: 37.58, lng: 126.97 }] };
      }
      if (cmd === "note_regions_list") {
        return { regions: [{ position: 0 }, { position: 1 }] };
      }
      return { id: "new-waypoint" };
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("region-entry-result-0"));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(setRegionMock).not.toHaveBeenCalled();
    expect(callMock).toHaveBeenCalledWith("note_regions_list", { note_id: "note-1" });
    expect(callMock).toHaveBeenCalledWith("note_region_add", {
      note_id: "note-1",
      name: "경복궁",
      lat: 37.58,
      lng: 126.97,
      position: 2,
    });
    expect(bumpAttachmentRevisionMock).toHaveBeenCalledTimes(1);
    expect(inserted).toEqual([{ text: "경복궁", start: 2, end: 5 }]);
    expect(screen.queryByTestId("region-entry-popover")).toBeNull();
  });

  it("note_region_add failing keeps the popover open and the body untouched", async () => {
    activeNote = { note: { id: "note-1", region: "서울" } };
    const { editor, inserted } = makeFakeEditor();
    vi.mocked(getActiveEditor).mockReturnValue(editor as never);
    render(<RegionEntryPopover noteId="note-1" />);
    openPopover({ query: "경복궁" });

    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "geocode_search") {
        return { results: [{ label: "경복궁, 서울", lat: 37.58, lng: 126.97 }] };
      }
      if (cmd === "note_regions_list") {
        return { regions: [] };
      }
      throw { code: "IO", message: "network down" };
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("region-entry-result-0"));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(inserted).toEqual([]);
    expect(screen.getByTestId("region-entry-popover")).toBeTruthy();
  });

  it("W3: 대표 또는 기존 경유지와 약 50m 이내인 결과는 '등록됨'으로 비활성 — 고를 수 없고 note_region_add 도 없다", async () => {
    activeNote = { note: { id: "note-1", region: "서울", lat: 37.5, lng: 127.0 } };
    const { editor, inserted } = makeFakeEditor();
    vi.mocked(getActiveEditor).mockReturnValue(editor as never);
    render(<RegionEntryPopover noteId="note-1" />);
    openPopover({ query: "강남" });

    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "geocode_search") return { results: [{ label: "12, 강남역, 서울", lat: 37.5001, lng: 127.0001 }] };
      if (cmd === "note_regions_list") return { regions: [{ position: 0, name: "경주", lat: 35.85, lng: 129.22 }] };
      return { id: "x" };
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    // 번지수로 시작하는 라벨도 이름은 강남역 (행 첫 줄)
    expect(screen.getByTestId("region-entry-result-0").children[0].textContent).toContain("강남역");
    expect(screen.getByTestId("region-entry-result-0").getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByTestId("region-entry-result-0").getAttribute("data-registered")).toBe("true");

    await act(async () => {
      fireEvent.click(screen.getByTestId("region-entry-result-0"));
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });

    expect(callMock).not.toHaveBeenCalledWith("note_region_add", expect.anything());
    expect(inserted).toEqual([]);
    expect(screen.getByTestId("region-entry-popover")).toBeTruthy();
  });

  it("W3: 좌표 쓰기가 안 들어가면 이름을 되돌리고 팝오버를 열어 둔다 (대표 없음 경로)", async () => {
    setLocationMock.mockImplementationOnce(async () => {
      // patchActiveNote 실패 경로: 던지지 않고 좌표만 안 바뀐다.
    });
    const { editor, inserted } = makeFakeEditor();
    vi.mocked(getActiveEditor).mockReturnValue(editor as never);
    render(<RegionEntryPopover noteId="note-1" />);
    openPopover({ query: "경복궁" });

    callMock.mockResolvedValue({ results: [{ label: "경복궁, 서울", lat: 37.58, lng: 126.97 }] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("region-entry-result-0"));
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });

    expect(setRegionMock.mock.calls.map((c) => c[0])).toEqual(["경복궁", null]);
    expect(inserted).toEqual([]);
    expect(screen.getByTestId("region-entry-popover")).toBeTruthy();
  });
});
