import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, act, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NoteRegionsList } from "./NoteRegionsList";
import { useNotesStore } from "../../stores/notes";
import { useSettingsStore } from "../../stores/settings";
import { useSearchStore } from "../../stores/search";
import { t } from "../../i18n/t";
import { SINGLE_NOTE_FOCUS_ZOOM, PICK_FLYTO_ZOOM } from "../map/mapZoomScale";

const callMock = vi.fn();

vi.mock("../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  emitNotice: vi.fn(),
  // N1-3: NoteRegionsList now bumps useNotesStore's attachmentRevision on mutation (so
  // AttachmentsBar's region-tile badge and PreviewAttachment's map stay in sync) — importing the
  // real store pulls in stores/notes.ts, which calls registerFlush at module load.
  registerFlush: vi.fn(() => () => {}),
}));

// PLAN-2026-09-19-date-region-ui.md §P4 D3′ — the popover's map is now WorldMapAuto (always
// visible when !inline), not the old SVG-only WorldMap gated behind addTarget. Stubbed the same
// way RegionPickerDialog.test.tsx stubs it elsewhere: a div exposing the props this suite cares
// about as data-* attributes, plus a button that fires onMapClick with a fixed coordinate pair.
// RegionPickerDialog itself is no longer imported by NoteRegionsList (the modal escape hatch is
// gone — §P4 D3′), so its mock is removed too.
vi.mock("../map/WorldMapAuto", () => ({
  WorldMapAuto: (props: {
    markers?: unknown[];
    onMapClick?: (lat: number, lng: number) => void;
    defaultLocation?: unknown;
  }) => (
    <div
      data-testid="world-map-stub"
      data-markers={props.markers?.length ?? 0}
      data-has-click={String(!!props.onMapClick)}
      data-seed={JSON.stringify(props.defaultLocation)}
    >
      <button type="button" data-testid="world-map-stub-click" onClick={() => props.onMapClick?.(37.5, 127.0)}>
        stub
      </button>
    </div>
  ),
}));

describe("NoteRegionsList", () => {
  beforeEach(() => {
    callMock.mockReset();
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "note_regions_list") {
        return {
          regions: [
            {
              id: "wp-g",
              note_id: "n1",
              name: "경주",
              lat: 35.85,
              lng: 129.22,
              position: 0,
            },
          ],
        };
      }
      if (cmd === "note_region_add") return { id: "wp-new" };
      if (cmd === "note_region_remove") return { ok: true };
      if (cmd === "note_region_reorder") return { ok: true };
      if (cmd === "geocode_search") return { results: [] };
      return {};
    });
  });

  it("renders primary + waypoints and add place control", async () => {
    render(
      <NoteRegionsList
        noteId="n1"
        primary={{ region: "서울", lat: 37.56, lng: 126.97 }}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("note-region-primary")).toBeTruthy();
    });
    expect(screen.getByText("서울")).toBeTruthy();
    expect(screen.getByText("경주")).toBeTruthy();
    expect(screen.getByTestId("note-region-add")).toBeTruthy();
  });

  it("dedupes waypoint that matches primary name", async () => {
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "note_regions_list") {
        return {
          regions: [
            {
              id: "wp-dup",
              note_id: "n1",
              name: "서울",
              lat: 37.56,
              lng: 126.97,
              position: 0,
            },
            {
              id: "wp-g",
              note_id: "n1",
              name: "경주",
              lat: 35.85,
              lng: 129.22,
              position: 1,
            },
          ],
        };
      }
      return {};
    });

    render(
      <NoteRegionsList
        noteId="n1"
        primary={{ region: "서울", lat: 37.56, lng: 126.97 }}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("경주")).toBeTruthy();
    });
    // Primary shows 서울 once; the duplicate waypoint row must not appear as a second 서울.
    const seoulNodes = screen.getAllByText("서울");
    expect(seoulNodes).toHaveLength(1);
    expect(screen.queryByTestId("note-region-waypoint-wp-dup")).toBeNull();
  });

  // §P4 D3′/D14 — the "지도에서 고르기" escape hatch is gone; adding now goes through the map
  // that's always on screen (or search — covered by the next describe block).
  it("calls note_region_add after a map click commit", async () => {
    const user = userEvent.setup();
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "note_regions_list") {
        return {
          regions: [{ id: "wp-g", note_id: "n1", name: "경주", lat: 35.85, lng: 129.22, position: 0 }],
        };
      }
      if (cmd === "note_region_add") return { id: "wp-new" };
      if (cmd === "geocode_reverse") return { label: "부산" };
      return {};
    });
    render(
      <NoteRegionsList
        noteId="n1"
        primary={{ region: "서울", lat: 37.56, lng: 126.97 }}
      />,
    );
    await waitFor(() => expect(screen.getByTestId("note-region-add")).toBeTruthy());
    await user.click(screen.getByTestId("note-region-add"));
    await waitFor(() => expect(screen.getByTestId("world-map-stub").getAttribute("data-has-click")).toBe("true"));
    await user.click(screen.getByTestId("world-map-stub-click"));

    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith(
        "note_region_add",
        expect.objectContaining({
          note_id: "n1",
          name: "부산",
          lat: 37.5,
          lng: 127,
          position: 1,
        }),
      );
    });
  });
});

// 오너 요청: 지역 추가/대표 교체의 흔한 경로는 팝오버 안 검색만으로 끝나야 한다 — 지도 모달은
// 없다(§P4 D3′). useGeocodeSearch(1100ms 디바운스)를 그대로 태우므로 fake timers로 검증한다
// (MapPlaceSearch.test.tsx와 같은 패턴).
describe("NoteRegionsList — inline geocode search (no modal for the common path)", () => {
  beforeEach(() => {
    callMock.mockReset();
    callMock.mockImplementation(async (cmd: string, args: Record<string, unknown> = {}) => {
      if (cmd === "note_regions_list") {
        return { regions: [{ id: "wp-g", note_id: "n1", name: "경주", lat: 35.85, lng: 129.22, position: 0 }] };
      }
      if (cmd === "note_region_add") return { id: "wp-new" };
      if (cmd === "note_set_region") return { region: args.region };
      if (cmd === "note_set_location") return { lat: args.lat, lng: args.lng };
      if (cmd === "geocode_search") {
        const query = args.query as string;
        if (query === "unavailable") return Promise.reject(new Error("network down"));
        if (query === "nomatch") return { results: [] };
        return { results: [{ label: "부산, 대한민국", lat: 35.18, lng: 129.08 }] };
      }
      return {};
    });
    useNotesStore.setState({
      activeNote: {
        note: { id: "n1", region: "서울", lat: 37.56, lng: 126.97 } as never,
        sections: [],
        sources: [],
        attachments: [],
      } as never,
      activeDraft: false,
    } as never);
  });

  afterEach(() => {
    vi.useRealTimers();
    useNotesStore.setState({ activeNote: null, activeDraft: false } as never);
  });

  // useGeocodeSearch's 1100ms debounce needs fake timers, but real timers everywhere else
  // (waitFor's own polling depends on them) — so fake timers are scoped to just the advance call,
  // matching the MapPlaceSearch.test.tsx pattern (only that test file's search box has no waitFor
  // at all; this one still needs it after picking a result, since add/edit go through async
  // call() chains).
  const typeAndDebounce = async (input: HTMLElement, query: string) => {
    vi.useFakeTimers();
    fireEvent.change(input, { target: { value: query } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    vi.useRealTimers();
  };

  it("does not call geocode_search just from opening the add search box", async () => {
    render(<NoteRegionsList noteId="n1" primary={{ region: "서울", lat: 37.56, lng: 126.97 }} />);
    await waitFor(() => expect(screen.getByTestId("note-region-add")).toBeTruthy());
    fireEvent.click(screen.getByTestId("note-region-add"));
    expect(screen.getByTestId("note-region-search-input")).toBeTruthy();

    vi.useFakeTimers();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    vi.useRealTimers();
    expect(callMock).not.toHaveBeenCalledWith("geocode_search", expect.anything());
  });

  it("typing a query and picking a result adds a waypoint via note_region_add", async () => {
    render(<NoteRegionsList noteId="n1" primary={{ region: "서울", lat: 37.56, lng: 126.97 }} />);
    await waitFor(() => expect(screen.getByTestId("note-region-add")).toBeTruthy());
    fireEvent.click(screen.getByTestId("note-region-add"));
    await typeAndDebounce(screen.getByTestId("note-region-search-input"), "부산");

    await waitFor(() => expect(screen.getByTestId("note-region-search-result-0")).toBeTruthy());
    fireEvent.click(screen.getByTestId("note-region-search-result-0"));

    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith(
        "note_region_add",
        expect.objectContaining({ note_id: "n1", name: "부산", lat: 35.18, lng: 129.08 }),
      );
    });
  });

  // §P4 D14 — a search pick also flies the map camera to the picked coordinates.
  it("picking a search result flies the map to the picked coords at PICK_FLYTO_ZOOM", async () => {
    render(<NoteRegionsList noteId="n1" primary={{ region: "서울", lat: 37.56, lng: 126.97 }} />);
    await waitFor(() => expect(screen.getByTestId("note-region-add")).toBeTruthy());
    fireEvent.click(screen.getByTestId("note-region-add"));
    await typeAndDebounce(screen.getByTestId("note-region-search-input"), "부산");

    await waitFor(() => expect(screen.getByTestId("note-region-search-result-0")).toBeTruthy());
    fireEvent.click(screen.getByTestId("note-region-search-result-0"));

    await waitFor(() => {
      const seed = JSON.parse(screen.getByTestId("world-map-stub").getAttribute("data-seed") ?? "null");
      expect(seed).toEqual({ lat: 35.18, lng: 129.08, zoom: PICK_FLYTO_ZOOM });
    });
  });

  it("setting the primary also goes through the same inline search", async () => {
    render(<NoteRegionsList noteId="n1" primary={{ region: "서울", lat: 37.56, lng: 126.97 }} />);
    // §P2 — edit/clear now live in the expanded row body; open it first (D4: the chevron, not the
    // name, is the expand trigger).
    await waitFor(() => expect(screen.getByTestId("note-region-primary-toggle")).toBeTruthy());
    fireEvent.click(screen.getByTestId("note-region-primary-toggle"));
    await waitFor(() => expect(screen.getByRole("button", { name: t("region.edit_primary") })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: t("region.edit_primary") }));
    await typeAndDebounce(screen.getByTestId("note-region-search-input"), "부산");

    await waitFor(() => expect(screen.getByTestId("note-region-search-result-0")).toBeTruthy());
    fireEvent.click(screen.getByTestId("note-region-search-result-0"));

    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("note_set_region", expect.objectContaining({ id: "n1", region: "부산" }));
      expect(callMock).toHaveBeenCalledWith(
        "note_set_location",
        expect.objectContaining({ id: "n1", lat: 35.18, lng: 129.08 }),
      );
    });
  });

  it("shows a hint (no crash) when there are no results", async () => {
    render(<NoteRegionsList noteId="n1" primary={{ region: "서울", lat: 37.56, lng: 126.97 }} />);
    await waitFor(() => expect(screen.getByTestId("note-region-add")).toBeTruthy());
    fireEvent.click(screen.getByTestId("note-region-add"));
    await typeAndDebounce(screen.getByTestId("note-region-search-input"), "nomatch");

    await waitFor(() => expect(screen.getByText("—")).toBeTruthy());
  });

  it("shows an unavailable hint (no crash) when geocoding fails", async () => {
    render(<NoteRegionsList noteId="n1" primary={{ region: "서울", lat: 37.56, lng: 126.97 }} />);
    await waitFor(() => expect(screen.getByTestId("note-region-add")).toBeTruthy());
    fireEvent.click(screen.getByTestId("note-region-add"));
    await typeAndDebounce(screen.getByTestId("note-region-search-input"), "unavailable");

    await waitFor(() => expect(screen.getByText(t("note.search_unavailable"))).toBeTruthy());
  });

  // §P4 D3′ — replaces the old "'지도에서 고르기' still opens RegionPickerDialog as an escape
  // hatch" test: that escape hatch (and the modal it opened) no longer exists.
  it("'지도에서 고르기' button no longer exists — the map itself replaces it", async () => {
    render(<NoteRegionsList noteId="n1" primary={{ region: "서울", lat: 37.56, lng: 126.97 }} />);
    await waitFor(() => expect(screen.getByTestId("note-region-add")).toBeTruthy());
    fireEvent.click(screen.getByTestId("note-region-add"));

    expect(screen.queryByTestId("note-region-pick-on-map")).toBeNull();
    expect(screen.queryByTestId("region-picker-mock")).toBeNull();
  });
});

// QA feedback (dashboard integrate, 항목 2): primary edit/clear/promote all write through
// notes-store setRegion/setLocation, which are no-ops unless activeNote matches the noteId this
// list was mounted for (see canEditPrimary in NoteRegionsList.tsx) — so these tests seed the real
// store's activeNote (not just assert on callMock) to actually exercise that path, per the review
// note that a mock-only assertion here would pass green while the primary never changed.
describe("NoteRegionsList — primary edit/clear/promote (only when noteId matches activeNote)", () => {
  const seedActiveNote = (region: string | null, lat: number | null, lng: number | null) => {
    useNotesStore.setState({
      activeNote: {
        note: { id: "n1", region, lat, lng } as never,
        sections: [],
        sources: [],
        attachments: [],
      } as never,
      activeDraft: false,
    } as never);
  };

  beforeEach(() => {
    callMock.mockReset();
    callMock.mockImplementation(async (cmd: string, args: Record<string, unknown> = {}) => {
      if (cmd === "note_regions_list") {
        return {
          regions: [
            { id: "wp-g", note_id: "n1", name: "경주", lat: 35.85, lng: 129.22, position: 0 },
          ],
        };
      }
      if (cmd === "note_region_add") return { id: "wp-new" };
      if (cmd === "note_region_remove") return { ok: true };
      if (cmd === "note_set_region") return { region: args.region };
      if (cmd === "note_set_location") return { lat: args.lat, lng: args.lng };
      if (cmd === "geocode_reverse") return { label: "부산" };
      return {};
    });
    useNotesStore.setState({ activeNote: null, activeDraft: false } as never);
  });

  it("edit button rewrites the primary through the store (seeded activeNote)", async () => {
    const user = userEvent.setup();
    seedActiveNote("서울", 37.56, 126.97);
    render(<NoteRegionsList noteId="n1" primary={{ region: "서울", lat: 37.56, lng: 126.97 }} />);

    await waitFor(() => expect(screen.getByTestId("note-region-primary")).toBeTruthy());
    // §P2 D4 — edit/clear moved into the expanded row body; the chevron opens it (name click stays
    // the filter trigger and must not expand anything).
    await user.click(screen.getByTestId("note-region-primary-toggle"));
    await user.click(screen.getByRole("button", { name: t("region.edit_primary") }));
    // §P4 D3′ — the common path (and this test) now goes through the always-visible map instead
    // of the removed "지도에서 고르기" escape hatch.
    await waitFor(() => expect(screen.getByTestId("world-map-stub").getAttribute("data-has-click")).toBe("true"));
    await user.click(screen.getByTestId("world-map-stub-click"));

    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("note_set_region", expect.objectContaining({ id: "n1", region: "부산" }));
      expect(callMock).toHaveBeenCalledWith("note_set_location", expect.objectContaining({ id: "n1", lat: 37.5, lng: 127 }));
    });
    await waitFor(() => {
      expect(useNotesStore.getState().activeNote?.note.region).toBe("부산");
    });
  });

  it("inline mode: edit button opens an in-card input; Enter saves the name, Escape discards", async () => {
    const user = userEvent.setup();
    seedActiveNote("서울", 37.56, 126.97);
    render(<NoteRegionsList noteId="n1" primary={{ region: "서울", lat: 37.56, lng: 126.97 }} inline />);

    await waitFor(() => expect(screen.getByTestId("note-region-primary")).toBeTruthy());
    // §P4 D14 — inline 모드는 추가 컨트롤(모달이든 지도든) 자체가 없다: 모달 진입점이던 추가
    // 버튼도, 이제는 지도도 없다.
    expect(screen.queryByTestId("note-region-add")).toBeNull();
    expect(screen.queryByTestId("note-region-map")).toBeNull();

    // §P2 D4 — accordion structure applies in inline mode too (only the inline SVG map is
    // !inline-gated); edit/clear still live in the expanded body.
    await user.click(screen.getByTestId("note-region-primary-toggle"));
    await user.click(screen.getByRole("button", { name: t("region.edit_primary") }));
    const input = screen.getByTestId("note-region-primary-rename");
    await user.clear(input);
    await user.type(input, "경주{Escape}");
    expect(callMock).not.toHaveBeenCalledWith("note_set_region", expect.anything());

    await user.click(screen.getByRole("button", { name: t("region.edit_primary") }));
    const input2 = screen.getByTestId("note-region-primary-rename");
    await user.clear(input2);
    await user.type(input2, "부산{Enter}");

    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("note_set_region", expect.objectContaining({ id: "n1", region: "부산" }));
    });
  });

  it("clear button (x) clears both region name and coords through the store, so the primary row actually disappears", async () => {
    const user = userEvent.setup();
    seedActiveNote("서울", 37.56, 126.97);
    const { rerender } = render(<NoteRegionsList noteId="n1" primary={{ region: "서울", lat: 37.56, lng: 126.97 }} />);

    await waitFor(() => expect(screen.getByTestId("note-region-primary")).toBeTruthy());
    await user.click(screen.getByTestId("note-region-primary-toggle"));
    // §P4 D14 — clear is now a header icon button (testid unchanged), not a body chip.
    await user.click(screen.getByRole("button", { name: t("note.remove_region") }));

    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("note_set_region", expect.objectContaining({ id: "n1", region: null }));
      // Regression: region-only would leave lat/lng behind, and hasPrimary (which also keys off
      // coords, unlike the old single-field RegionEditor) would keep the row stuck as "Unnamed
      // place" instead of actually clearing.
      expect(callMock).toHaveBeenCalledWith("note_set_location", expect.objectContaining({ id: "n1", lat: null, lng: null }));
    });
    await waitFor(() => {
      expect(useNotesStore.getState().activeNote?.note.region).toBeNull();
      expect(useNotesStore.getState().activeNote?.note.lat).toBeNull();
    });

    // Simulate the parent (TitleBar) re-deriving `primary` from the now-cleared note and passing
    // it back down — this is what actually makes the row disappear in the real app.
    rerender(<NoteRegionsList noteId="n1" primary={{ region: null, lat: null, lng: null }} />);
    expect(screen.queryByTestId("note-region-primary")).toBeNull();
  });

  it("'set as primary' on a waypoint swaps it with the current primary through the store", async () => {
    const user = userEvent.setup();
    seedActiveNote("서울", 37.56, 126.97);
    render(<NoteRegionsList noteId="n1" primary={{ region: "서울", lat: 37.56, lng: 126.97 }} />);

    await waitFor(() => expect(screen.getByText("경주")).toBeTruthy());
    await user.click(screen.getByTestId("note-region-toggle-wp-g"));
    await user.click(screen.getByRole("button", { name: t("region.set_primary") }));

    await waitFor(() => {
      // Old primary (서울) demoted into a waypoint row before the promoted one is removed —
      // failing this order would lose 서울 outright instead of merely risking a duplicate.
      expect(callMock).toHaveBeenCalledWith(
        "note_region_add",
        expect.objectContaining({ note_id: "n1", name: "서울", lat: 37.56, lng: 126.97 }),
      );
      expect(callMock).toHaveBeenCalledWith("note_region_remove", { id: "wp-g" });
      expect(callMock).toHaveBeenCalledWith("note_set_region", expect.objectContaining({ id: "n1", region: "경주" }));
      expect(callMock).toHaveBeenCalledWith(
        "note_set_location",
        expect.objectContaining({ id: "n1", lat: 35.85, lng: 129.22 }),
      );
    });
    await waitFor(() => expect(useNotesStore.getState().activeNote?.note.region).toBe("경주"));
  });

  // §P4 D14 — canEditPrimary=false now means the primary row's body is not rendered at all (it
  // would only ever hold the edit button, itself canEditPrimary-gated — see NoteRegionsList.tsx's
  // "본문이 통째로 비어 렌더할 이유가 없다" comment). Adapted from the old assertion, which
  // expected an empty-but-present note-region-primary-body.
  it("edit/clear/promote controls are hidden when noteId doesn't match the active note", async () => {
    const user = userEvent.setup();
    seedActiveNote("서울", 37.56, 126.97); // active note is n1
    render(<NoteRegionsList noteId="n2" primary={{ region: "부산", lat: 35.18, lng: 129.08 }} />);

    await waitFor(() => expect(screen.getByTestId("note-region-primary")).toBeTruthy());
    await user.click(screen.getByTestId("note-region-primary-toggle"));
    expect(screen.queryByTestId("note-region-primary-body")).toBeNull();
    expect(screen.queryByRole("button", { name: t("region.edit_primary") })).toBeNull();
    expect(screen.queryByRole("button", { name: t("note.remove_region") })).toBeNull();

    await waitFor(() => expect(screen.getByText("경주")).toBeTruthy());
    await user.click(screen.getByTestId("note-region-toggle-wp-g"));
    expect(screen.getByTestId("note-region-body-wp-g")).toBeTruthy();
    expect(screen.queryByRole("button", { name: t("region.set_primary") })).toBeNull();
    // move-up/down/remove are NOT gated on canEditPrimary (existing asymmetry, kept as-is).
    expect(screen.getByTestId("note-region-move-up-wp-g")).toBeTruthy();
    expect(screen.getByTestId("note-region-move-down-wp-g")).toBeTruthy();
    expect(screen.getByTestId("note-region-remove-wp-g")).toBeTruthy();
  });
});

// PLAN-2026-09-19-date-region-ui.md §P2 D4 / §P4 D14 — row accordion: chevron-only expand, name
// click keeps its existing filterByRegion meaning and never expands a row; §P4 D14 additionally
// moves make-primary/remove/clear into the header, visible only while the row is open.
describe("NoteRegionsList — row accordion (§P2 D4 / §P4 D14)", () => {
  beforeEach(() => {
    callMock.mockReset();
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "note_regions_list") {
        return { regions: [{ id: "wp-g", note_id: "n1", name: "경주", lat: 35.85, lng: 129.22, position: 0 }] };
      }
      return {};
    });
    useSearchStore.setState({ regionFilter: null });
    useNotesStore.setState({
      activeNote: {
        note: { id: "n1", region: "서울", lat: 37.56, lng: 126.97 } as never,
        sections: [],
        sources: [],
        attachments: [],
      } as never,
      activeDraft: false,
    } as never);
  });

  afterEach(() => {
    useNotesStore.setState({ activeNote: null, activeDraft: false } as never);
  });

  it("primary name click still filters and does not expand the row", async () => {
    const user = userEvent.setup();
    render(<NoteRegionsList noteId="n1" primary={{ region: "서울", lat: 37.56, lng: 126.97 }} />);
    await waitFor(() => expect(screen.getByTestId("note-region-primary")).toBeTruthy());
    await user.click(screen.getByTestId("note-region-filter-primary"));
    expect(useSearchStore.getState().regionFilter).toEqual({ kind: "region", name: "서울" });
    expect(screen.queryByTestId("note-region-primary-body")).toBeNull();
  });

  it("waypoint name click still filters and does not expand the row", async () => {
    const user = userEvent.setup();
    render(<NoteRegionsList noteId="n1" primary={{ region: "서울", lat: 37.56, lng: 126.97 }} />);
    await waitFor(() => expect(screen.getByText("경주")).toBeTruthy());
    await user.click(screen.getByTestId("note-region-filter-wp-g"));
    expect(useSearchStore.getState().regionFilter).toEqual({ kind: "region", name: "경주" });
    expect(screen.queryByTestId("note-region-body-wp-g")).toBeNull();
  });

  it("chevron click expands the row without calling the name filter", async () => {
    const user = userEvent.setup();
    render(<NoteRegionsList noteId="n1" primary={{ region: "서울", lat: 37.56, lng: 126.97 }} />);
    await waitFor(() => expect(screen.getByTestId("note-region-primary")).toBeTruthy());
    await user.click(screen.getByTestId("note-region-primary-toggle"));
    expect(screen.getByTestId("note-region-primary-body")).toBeTruthy();
    expect(useSearchStore.getState().regionFilter).toBeNull();
  });

  it("expanding one row collapses the other (single-open, list-wide)", async () => {
    const user = userEvent.setup();
    render(<NoteRegionsList noteId="n1" primary={{ region: "서울", lat: 37.56, lng: 126.97 }} />);
    await waitFor(() => expect(screen.getByText("경주")).toBeTruthy());
    await user.click(screen.getByTestId("note-region-primary-toggle"));
    expect(screen.getByTestId("note-region-primary-body")).toBeTruthy();
    await user.click(screen.getByTestId("note-region-toggle-wp-g"));
    expect(screen.queryByTestId("note-region-primary-body")).toBeNull();
    expect(screen.getByTestId("note-region-body-wp-g")).toBeTruthy();
  });

  it("expanded primary body has edit; expanded waypoint body has up/down (promote/remove moved to the header)", async () => {
    const user = userEvent.setup();
    render(<NoteRegionsList noteId="n1" primary={{ region: "서울", lat: 37.56, lng: 126.97 }} />);
    await waitFor(() => expect(screen.getByText("경주")).toBeTruthy());

    await user.click(screen.getByTestId("note-region-primary-toggle"));
    expect(screen.getByTestId("note-region-primary-edit")).toBeTruthy();
    expect(screen.getByTestId("note-region-primary-clear")).toBeTruthy();

    await user.click(screen.getByTestId("note-region-toggle-wp-g"));
    expect(screen.getByTestId("note-region-make-primary-wp-g")).toBeTruthy();
    expect(screen.getByTestId("note-region-move-up-wp-g")).toBeTruthy();
    expect(screen.getByTestId("note-region-move-down-wp-g")).toBeTruthy();
    expect(screen.getByTestId("note-region-remove-wp-g")).toBeTruthy();
  });

  // §P4 D14 — header icons only exist while their row is open (접힌 행마다 버튼이 늘어서면 안
  // 된다는 오너 우려, D13 짝).
  it("header icons (make-primary/remove/primary-clear) are absent while a row is closed and present once opened", async () => {
    render(<NoteRegionsList noteId="n1" primary={{ region: "서울", lat: 37.56, lng: 126.97 }} />);
    await waitFor(() => expect(screen.getByText("경주")).toBeTruthy());

    expect(screen.queryByTestId("note-region-primary-clear")).toBeNull();
    expect(screen.queryByTestId("note-region-make-primary-wp-g")).toBeNull();
    expect(screen.queryByTestId("note-region-remove-wp-g")).toBeNull();

    fireEvent.click(screen.getByTestId("note-region-primary-toggle"));
    expect(screen.getByTestId("note-region-primary-clear")).toBeTruthy();

    fireEvent.click(screen.getByTestId("note-region-toggle-wp-g"));
    expect(screen.getByTestId("note-region-make-primary-wp-g")).toBeTruthy();
    expect(screen.getByTestId("note-region-remove-wp-g")).toBeTruthy();
    // single-open accordion: opening the waypoint row collapsed the primary row's header icon too.
    expect(screen.queryByTestId("note-region-primary-clear")).toBeNull();
  });

  // §P4 D14 — up/down stay in the body (only make-primary/remove moved to the header).
  it("move up/down stay in the row body, not the header", async () => {
    render(<NoteRegionsList noteId="n1" primary={{ region: "서울", lat: 37.56, lng: 126.97 }} />);
    await waitFor(() => expect(screen.getByText("경주")).toBeTruthy());
    fireEvent.click(screen.getByTestId("note-region-toggle-wp-g"));

    const body = screen.getByTestId("note-region-body-wp-g");
    expect(within(body).getByTestId("note-region-move-up-wp-g")).toBeTruthy();
    expect(within(body).getByTestId("note-region-move-down-wp-g")).toBeTruthy();
    expect(within(body).queryByTestId("note-region-make-primary-wp-g")).toBeNull();
    expect(within(body).queryByTestId("note-region-remove-wp-g")).toBeNull();
  });
});

// PLAN-2026-09-19-date-region-ui.md §P4 D3′ — the popover map is WorldMapAuto, always rendered
// when !inline (addTarget only gates whether map clicks register a place), replacing the old
// addTarget-gated SVG-only WorldMap this suite used to cover.
describe("NoteRegionsList — map (§P4 D3′)", () => {
  beforeEach(() => {
    callMock.mockReset();
  });

  it("does not render the map in inline mode (RegionPreview already has its own big map)", async () => {
    callMock.mockImplementation(async (cmd: string) => (cmd === "note_regions_list" ? { regions: [] } : {}));
    render(<NoteRegionsList noteId="n1" primary={{ region: null, lat: null, lng: null }} inline />);
    await waitFor(() => expect(screen.getByTestId("note-regions-list")).toBeTruthy());
    expect(screen.queryByTestId("note-region-map")).toBeNull();
    expect(screen.queryByTestId("world-map-stub")).toBeNull();
  });

  it("renders the map immediately in non-inline mode with no add target set", async () => {
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "note_regions_list") {
        return { regions: [{ id: "wp-g", note_id: "n1", name: "경주", lat: 35.85, lng: 129.22, position: 0 }] };
      }
      return {};
    });
    render(<NoteRegionsList noteId="n1" primary={{ region: "서울", lat: 37.56, lng: 126.97 }} />);
    await waitFor(() => expect(screen.getByTestId("note-region-map")).toBeTruthy());
    expect(screen.getByTestId("world-map-stub")).toBeTruthy();
  });

  it("renders the map in the empty state too (no primary, no waypoints)", async () => {
    callMock.mockImplementation(async (cmd: string) => (cmd === "note_regions_list" ? { regions: [] } : {}));
    render(<NoteRegionsList noteId="n1" primary={{ region: null, lat: null, lng: null }} />);
    await waitFor(() => expect(screen.getByTestId("note-region-map")).toBeTruthy());
    expect(screen.getByTestId("note-region-add")).toBeTruthy();
  });

  it("data-has-click is false without an add target and true once one is set", async () => {
    callMock.mockImplementation(async (cmd: string) => (cmd === "note_regions_list" ? { regions: [] } : {}));
    render(<NoteRegionsList noteId="n1" primary={{ region: "서울", lat: 37.56, lng: 126.97 }} />);
    await waitFor(() => expect(screen.getByTestId("world-map-stub")).toBeTruthy());
    expect(screen.getByTestId("world-map-stub").getAttribute("data-has-click")).toBe("false");

    fireEvent.click(screen.getByTestId("note-region-add"));
    await waitFor(() => expect(screen.getByTestId("world-map-stub").getAttribute("data-has-click")).toBe("true"));
  });

  it("clicking the map stub with no add target does nothing (view-only)", async () => {
    callMock.mockImplementation(async (cmd: string) => (cmd === "note_regions_list" ? { regions: [] } : {}));
    render(<NoteRegionsList noteId="n1" primary={{ region: "서울", lat: 37.56, lng: 126.97 }} />);
    await waitFor(() => expect(screen.getByTestId("world-map-stub")).toBeTruthy());
    expect(screen.getByTestId("world-map-stub").getAttribute("data-has-click")).toBe("false");

    fireEvent.click(screen.getByTestId("world-map-stub-click"));
    expect(callMock).not.toHaveBeenCalledWith("geocode_reverse", expect.anything());
    expect(callMock).not.toHaveBeenCalledWith("note_region_add", expect.anything());
  });

  it("map markers count = primary + waypoints", async () => {
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "note_regions_list") {
        return { regions: [{ id: "wp-g", note_id: "n1", name: "경주", lat: 35.85, lng: 129.22, position: 0 }] };
      }
      return {};
    });
    render(<NoteRegionsList noteId="n1" primary={{ region: "서울", lat: 37.56, lng: 126.97 }} />);
    await waitFor(() => expect(screen.getByText("경주")).toBeTruthy());
    expect(screen.getByTestId("world-map-stub").getAttribute("data-markers")).toBe("2");
  });

  it("opening a row with coords flies the map camera to that place", async () => {
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "note_regions_list") {
        return { regions: [{ id: "wp-g", note_id: "n1", name: "경주", lat: 35.85, lng: 129.22, position: 0 }] };
      }
      return {};
    });
    render(<NoteRegionsList noteId="n1" primary={{ region: "서울", lat: 37.56, lng: 126.97 }} />);
    await waitFor(() => expect(screen.getByText("경주")).toBeTruthy());
    fireEvent.click(screen.getByTestId("note-region-toggle-wp-g"));

    await waitFor(() => {
      const seed = JSON.parse(screen.getByTestId("world-map-stub").getAttribute("data-seed") ?? "null");
      expect(seed).toEqual({ lat: 35.85, lng: 129.22, zoom: SINGLE_NOTE_FOCUS_ZOOM });
    });
  });

  it("map click reverse-geocodes then commits through the existing addTarget dispatch (geocode_reverse succeeds)", async () => {
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "note_regions_list") return { regions: [] };
      if (cmd === "note_region_add") return { id: "wp-new" };
      if (cmd === "geocode_reverse") return { label: "테스트 지역" };
      return {};
    });
    render(<NoteRegionsList noteId="n1" primary={{ region: "서울", lat: 37.56, lng: 126.97 }} />);
    await waitFor(() => expect(screen.getByTestId("note-region-add")).toBeTruthy());
    fireEvent.click(screen.getByTestId("note-region-add")); // addTarget = "waypoint" (primary already set)
    await waitFor(() => expect(screen.getByTestId("world-map-stub").getAttribute("data-has-click")).toBe("true"));
    fireEvent.click(screen.getByTestId("world-map-stub-click"));

    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("geocode_reverse", expect.objectContaining({ lat: 37.5, lng: 127 }));
      expect(callMock).toHaveBeenCalledWith(
        "note_region_add",
        expect.objectContaining({ note_id: "n1", name: "테스트 지역", lat: 37.5, lng: 127 }),
      );
    });
  });

  it("map click still commits (coordinate fallback name) when geocode_reverse fails", async () => {
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "note_regions_list") return { regions: [] };
      if (cmd === "note_region_add") return { id: "wp-new" };
      if (cmd === "geocode_reverse") return Promise.reject(new Error("network down"));
      return {};
    });
    render(<NoteRegionsList noteId="n1" primary={{ region: "서울", lat: 37.56, lng: 126.97 }} />);
    await waitFor(() => expect(screen.getByTestId("note-region-add")).toBeTruthy());
    fireEvent.click(screen.getByTestId("note-region-add"));
    await waitFor(() => expect(screen.getByTestId("world-map-stub").getAttribute("data-has-click")).toBe("true"));
    fireEvent.click(screen.getByTestId("world-map-stub-click"));

    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith(
        "note_region_add",
        expect.objectContaining({ note_id: "n1", name: "37.500, 127.000", lat: 37.5, lng: 127 }),
      );
    });
  });

  // §P4 D14 — after a map-click commit, the camera re-centers on the clicked point without
  // zooming out (it keeps the last reported view zoom, falling back to PICK_FLYTO_ZOOM when the
  // map hasn't reported a view yet — as here, since the stub never calls onViewChange).
  it("re-centers on the clicked point after commit (keeps zoom, no zoom-out)", async () => {
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "note_regions_list") return { regions: [] };
      if (cmd === "note_region_add") return { id: "wp-new" };
      if (cmd === "geocode_reverse") return { label: "테스트 지역" };
      return {};
    });
    render(<NoteRegionsList noteId="n1" primary={{ region: "서울", lat: 37.56, lng: 126.97 }} />);
    await waitFor(() => expect(screen.getByTestId("note-region-add")).toBeTruthy());
    fireEvent.click(screen.getByTestId("note-region-add"));
    await waitFor(() => expect(screen.getByTestId("world-map-stub").getAttribute("data-has-click")).toBe("true"));
    fireEvent.click(screen.getByTestId("world-map-stub-click"));

    await waitFor(() => {
      const seed = JSON.parse(screen.getByTestId("world-map-stub").getAttribute("data-seed") ?? "null");
      expect(seed).toEqual({ lat: 37.5, lng: 127, zoom: PICK_FLYTO_ZOOM });
    });
  });
});

// 오너 피드백: 팝오버(RegionMetaBadge)를 열었을 때 지역이 하나도 없으면 검색 입력이 바로
// 열려있어야 한다 — "+ 장소 추가"를 한 번 더 누르게 하지 않는다. 하지만 초기 로드가 끝나
// 실제로 비어있음이 확인되기 전까지 geocode_search 는 여전히 돌면 안 된다(기존 계약 유지).
describe("NoteRegionsList — autoOpenSearch (popover-only)", () => {
  beforeEach(() => {
    callMock.mockReset();
  });

  it("opens the search input automatically (and focuses it) when the note has no primary and no waypoints", async () => {
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "note_regions_list") return { regions: [] };
      return {};
    });

    render(
      <NoteRegionsList
        noteId="n1"
        primary={{ region: null, lat: null, lng: null }}
        autoOpenSearch
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("note-region-search-input")).toBeTruthy();
    });
    expect(document.activeElement).toBe(screen.getByTestId("note-region-search-input"));

    // Empty query — the debounced geocode_search must still not fire.
    vi.useFakeTimers();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    vi.useRealTimers();
    expect(callMock).not.toHaveBeenCalledWith("geocode_search", expect.anything());
  });

  it("does not auto-open search when the note already has a primary/waypoints — list shows first", async () => {
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "note_regions_list") {
        return { regions: [{ id: "wp-g", note_id: "n1", name: "경주", lat: 35.85, lng: 129.22, position: 0 }] };
      }
      return {};
    });

    render(
      <NoteRegionsList
        noteId="n1"
        primary={{ region: "서울", lat: 37.56, lng: 126.97 }}
        autoOpenSearch
      />,
    );

    await waitFor(() => expect(screen.getByTestId("note-region-primary")).toBeTruthy());
    expect(screen.getByText("경주")).toBeTruthy();
    expect(screen.queryByTestId("note-region-search-input")).toBeNull();
    expect(screen.getByTestId("note-region-add")).toBeTruthy();
  });

  it("does not auto-open in inline mode even when empty", async () => {
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "note_regions_list") return { regions: [] };
      return {};
    });

    render(
      <NoteRegionsList
        noteId="n1"
        primary={{ region: null, lat: null, lng: null }}
        autoOpenSearch
        inline
      />,
    );

    await waitFor(() => expect(screen.getByTestId("note-regions-list")).toBeTruthy());
    expect(screen.queryByTestId("note-region-search-input")).toBeNull();
  });
});

// 자동 감지 토글 — 지도 아래 아이콘 줄 우측. 기본 위치 한 번에 넣기 링크는 홈 버튼으로 대체돼 없어졌다.
describe("NoteRegionsList — 자동 감지 토글", () => {
  it("아이콘 줄에 토글이 있고 누르면 regionNudgeEnabled 가 바뀐다", async () => {
    const setter = vi.fn(async () => {});
    useSettingsStore.setState({ regionNudgeEnabled: true, setRegionNudgeEnabled: setter } as never);
    render(<NoteRegionsList noteId="n1" primary={{ region: "서울", lat: 37.56, lng: 126.97 }} />);
    const sw = await screen.findByTestId("note-region-auto-detect");
    expect(sw.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(sw);
    expect(setter).toHaveBeenCalledWith(false);
  });
});

// PLAN-2026-09-19 owner decision — same scroll threshold as NoteDatesList.tsx's list, adapted for
// the primary + waypoint row shape: SCROLL_AFTER_ROWS=10, ROWS_SCROLL_MAX_H=320. Up to 10 rows
// (primary + waypoints combined) show fully with no height cap; past that, only `note-region-rows`
// scrolls (never scrollIntoView — see the effect's comment in NoteRegionsList.tsx). inline mode
// never scrolls regardless of count (that card already has its own scroll — header comment on
// SCROLL_AFTER_ROWS).
describe("NoteRegionsList — rows scroll threshold", () => {
  // dedupeWaypoints hides a waypoint whose name matches the primary's — names here are distinct
  // from primary's "서울" so none get silently dropped.
  const waypoint = (i: number) => ({
    id: `wp${i}`,
    note_id: "n1",
    name: `동네${i}`,
    lat: 35 + i * 0.01,
    lng: 129 + i * 0.01,
    position: i,
  });
  const waypoints = (n: number) => Array.from({ length: n }, (_, i) => waypoint(i));
  const primaryFixture = { region: "서울", lat: 37.56, lng: 126.97 };

  function rect(top: number, bottom: number): DOMRect {
    return {
      top,
      bottom,
      left: 0,
      right: 0,
      width: 0,
      height: bottom - top,
      x: 0,
      y: top,
      toJSON: () => ({}),
    } as DOMRect;
  }

  let bcrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    callMock.mockReset();
    // jsdom has no layout: the real getBoundingClientRect always returns an all-zero rect. Spy so
    // individual tests can stub per-element (by identity) without touching production code.
    bcrSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
    // jsdom does not implement Element.scrollIntoView at all — define it so "not called" assertions
    // have something real to check.
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    bcrSpy.mockRestore();
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  it("primary + 9 waypoints (10 rows) do not scroll: data-scrolls=false, display:contents", async () => {
    callMock.mockImplementation(async (cmd: string) =>
      cmd === "note_regions_list" ? { regions: waypoints(9) } : {},
    );
    render(<NoteRegionsList noteId="n1" primary={primaryFixture} />);
    const rows = await screen.findByTestId("note-region-rows");
    await screen.findByTestId("note-region-waypoint-wp8");

    expect(rows.getAttribute("data-scrolls")).toBe("false");
    expect(rows.style.display).toBe("contents");
  });

  it("primary + 10 waypoints (11 rows) scroll: data-scrolls=true, scroll class, 320px maxHeight, auto overflow", async () => {
    callMock.mockImplementation(async (cmd: string) =>
      cmd === "note_regions_list" ? { regions: waypoints(10) } : {},
    );
    render(<NoteRegionsList noteId="n1" primary={primaryFixture} />);
    const rows = await screen.findByTestId("note-region-rows");
    await screen.findByTestId("note-region-waypoint-wp9");

    expect(rows.getAttribute("data-scrolls")).toBe("true");
    expect(rows.classList.contains("scroll")).toBe(true);
    expect(rows.style.maxHeight).toBe("320px");
    expect(rows.style.overflowY).toBe("auto");
  });

  it("inline mode never scrolls, even with 11 rows", async () => {
    callMock.mockImplementation(async (cmd: string) =>
      cmd === "note_regions_list" ? { regions: waypoints(10) } : {},
    );
    render(<NoteRegionsList noteId="n1" primary={primaryFixture} inline />);
    const rows = await screen.findByTestId("note-region-rows");
    await screen.findByTestId("note-region-waypoint-wp9");

    expect(rows.getAttribute("data-scrolls")).toBe("false");
    expect(rows.style.display).toBe("contents");
  });

  it("the map and the add button are not descendants of note-region-rows", async () => {
    callMock.mockImplementation(async (cmd: string) =>
      cmd === "note_regions_list" ? { regions: waypoints(10) } : {},
    );
    const { container } = render(<NoteRegionsList noteId="n1" primary={primaryFixture} />);
    const rows = await screen.findByTestId("note-region-rows");
    await screen.findByTestId("note-region-waypoint-wp9");
    const map = container.querySelector('[data-testid="note-region-map"]');
    const addBtn = container.querySelector('[data-testid="note-region-add"]');

    expect(map).toBeTruthy();
    expect(addBtn).toBeTruthy();
    expect(rows.contains(map)).toBe(false);
    expect(rows.contains(addBtn)).toBe(false);
  });

  it("data-row-id is 'primary' on the primary row wrapper and the waypoint id on the others", async () => {
    const wps = waypoints(10);
    callMock.mockImplementation(async (cmd: string) =>
      cmd === "note_regions_list" ? { regions: wps } : {},
    );
    const { container } = render(<NoteRegionsList noteId="n1" primary={primaryFixture} />);
    await screen.findByTestId("note-region-waypoint-wp9");

    expect(container.querySelector('[data-row-id="primary"]')).toBeTruthy();
    for (const wp of wps) {
      expect(container.querySelector(`[data-row-id="${wp.id}"]`)).toBeTruthy();
    }
  });

  it("opening a low waypoint row nudges note-region-rows's scrollTop by the overflow amount, without scrollIntoView", async () => {
    const wps = waypoints(10);
    callMock.mockImplementation(async (cmd: string) =>
      cmd === "note_regions_list" ? { regions: wps } : {},
    );
    const user = userEvent.setup();
    render(<NoteRegionsList noteId="n1" primary={primaryFixture} />);
    const rows = await screen.findByTestId("note-region-rows");
    const chevron = await screen.findByTestId("note-region-toggle-wp9");

    bcrSpy.mockImplementation(function (this: HTMLElement): DOMRect {
      if (this === rows) return rect(0, 320);
      if (this.dataset.rowId === "wp9") return rect(300, 460);
      return rect(0, 0);
    });

    await user.click(chevron);

    await waitFor(() => expect(rows.scrollTop).toBe(140));
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  });
});
