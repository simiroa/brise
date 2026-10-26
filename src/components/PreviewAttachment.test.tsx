import { createElement } from "react";
import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { render, screen, waitFor, act, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PreviewAttachment } from "./PreviewAttachment";
import { useUiStore } from "../stores/ui";
import { useNotesStore } from "../stores/notes";
import { useSettingsStore } from "../stores/settings";
import { useAiStore } from "../stores/ai";
import { useAiPresetsStore } from "../stores/aiPresets";
import { useAiInstructionsStore } from "../stores/aiInstructions";
import type { MapMarker } from "./map/WorldMap";
import { AskAiModal as LazyAskAiModal } from "../lazySurfaces";

// 이 화면들은 지연 청크다(lazySurfaces) — 앱이 유휴 시간에 미리 받듯 여기서 미리 받아 클릭 직후 바로 그려지게 한다.
beforeAll(async () => {
  await LazyAskAiModal.preload();
}, 30_000);

const callMock = vi.fn();
const emitNoticeMock = vi.fn();

vi.mock("../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  emitNotice: (...args: unknown[]) => emitNoticeMock(...args),
  registerFlush: vi.fn(() => () => {}),
  flushAll: vi.fn(async () => {}),
}));

// D4 drag (owner: waypoint pins on the 지역보기 card become movable): capture the props
// WorldMap is mounted with so a test can inspect markers[].interactive and invoke
// onMarkerMove directly, same pattern as HomeMapPane.test.tsx.
let lastMapProps: {
  markers: MapMarker[];
  onMarkerMove?: (id: string, lat: number, lng: number) => void;
  onMapClick?: (lat: number, lng: number) => void;
} | null = null;

vi.mock("./map/WorldMapAuto", () => ({
  WorldMapAuto: (props: {
    markers: MapMarker[];
    onMarkerMove?: (id: string, lat: number, lng: number) => void;
    onMapClick?: (lat: number, lng: number) => void;
  }) => {
    lastMapProps = props;
    return createElement("div", { "data-testid": "mock-world-map" });
  },
}));

// Inline place search on the preview map (owner: 모달 없이 이 창에서 전부) — mock it down to a
// single "pick" trigger so the test doesn't need to drive the geocode-search debounce.
vi.mock("./home/MapPlaceSearch", () => ({
  MapPlaceSearch: ({ onPick }: { onPick: (item: { label: string; lat: number; lng: number }) => void }) =>
    createElement(
      "div",
      { "data-testid": "region-inline-search" },
      createElement(
        "button",
        { type: "button", onClick: () => onPick({ label: "부산, 대한민국", lat: 35.18, lng: 129.08 }) },
        "pick",
      ),
    ),
}));

function seedNote(noteId: string) {
  useNotesStore.setState({
    activeNote: {
      note: { id: noteId, region: "서울", lat: 37.56, lng: 126.97 },
      sections: [],
      sources: [],
      attachments: [],
    } as never,
    activeDraft: false,
  } as never);
  useUiStore.setState({ previewItem: { kind: "region", id: noteId } } as never);
}

describe("PreviewAttachment — region card (D4 drag + address-add)", () => {
  beforeEach(() => {
    lastMapProps = null;
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
      if (cmd === "note_region_move") return { ok: true };
      if (cmd === "geocode_reverse") return { label: null };
      void args;
      return {};
    });
    seedNote("n1");
  });

  it("primary marker stays non-interactive; waypoint marker is interactive (draggable)", async () => {
    render(<PreviewAttachment />);

    await waitFor(
      () => {
        expect(lastMapProps?.markers.some((m) => m.id === "wp:wp-g")).toBe(true);
        const primary = lastMapProps?.markers.find((m) => m.pinSize === "primary");
        const waypoint = lastMapProps?.markers.find((m) => m.id === "wp:wp-g");
        expect(primary).toBeDefined();
        expect(primary?.interactive).toBe(false);
        expect(waypoint).toBeDefined();
        expect(waypoint?.interactive).toBe(true);
      },
      { timeout: 5000 }
    );
  });

  it("dragging a waypoint marker commits via note_region_move (wp: id stripped)", async () => {
    render(<PreviewAttachment />);
    await waitFor(() => expect(lastMapProps?.onMarkerMove).toBeTruthy(), { timeout: 5000 });

    await act(async () => {
      lastMapProps!.onMarkerMove!("wp:wp-g", 40.0, 135.0);
    });

    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("note_region_move", { id: "wp-g", lat: 40.0, lng: 135.0 });
    });
  });

  it("a failed drag rolls back the optimistic move (note_regions_list is re-fetched with original coords)", async () => {
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "note_regions_list") {
        return {
          regions: [
            { id: "wp-g", note_id: "n1", name: "경주", lat: 35.85, lng: 129.22, position: 0 },
          ],
        };
      }
      if (cmd === "note_region_move") throw new Error("boom");
      return {};
    });
    render(<PreviewAttachment />);
    await waitFor(() => expect(lastMapProps?.onMarkerMove).toBeTruthy());

    await act(async () => {
      lastMapProps!.onMarkerMove!("wp:wp-g", 40.0, 135.0);
    });

    // Rollback restores the pre-drag coords on the marker (no lasting corruption from the
    // failed call), rather than leaving the optimistic (wrong) position stuck on screen.
    await waitFor(
      () => {
        const waypoint = lastMapProps!.markers.find((m) => m.id === "wp:wp-g");
        expect(waypoint?.lat).toBe(35.85);
        expect(waypoint?.lng).toBe(129.22);
      },
      { timeout: 5000 }
    );
  });

  it("dragging the primary marker id is a no-op (defensive: interactive:false already blocks it at the WorldMap layer)", async () => {
    render(<PreviewAttachment />);
    await waitFor(() => expect(lastMapProps?.onMarkerMove).toBeTruthy(), { timeout: 5000 });

    await act(async () => {
      lastMapProps!.onMarkerMove!("n1", 1, 1);
    });

    expect(callMock).not.toHaveBeenCalledWith("note_region_move", expect.anything());
  });

  it("two rapid map clicks during the in-flight geocode_reverse round trip only add one waypoint (synchronous lock, not the async `adding` state)", async () => {
    let resolveGeocode: (v: { label: string | null }) => void = () => {};
    const geocodePromise = new Promise<{ label: string | null }>((resolve) => {
      resolveGeocode = resolve;
    });
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "note_regions_list") return { regions: [] };
      if (cmd === "geocode_reverse") return geocodePromise;
      if (cmd === "note_region_add") return { id: "wp-new" };
      return {};
    });
    render(<PreviewAttachment />);
    await waitFor(() => expect(lastMapProps?.onMapClick).toBeTruthy());

    // Both fire synchronously in the same tick — an async-function body runs up to its first
    // `await` before yielding, so the first call claims addingRef before the second one runs.
    act(() => {
      lastMapProps!.onMapClick!(1, 2);
      lastMapProps!.onMapClick!(1, 2);
    });

    await act(async () => {
      resolveGeocode({ label: null });
      await geocodePromise;
    });

    await waitFor(() => {
      const addCalls = callMock.mock.calls.filter((c) => c[0] === "note_region_add");
      expect(addCalls).toHaveLength(1);
    });
  });

  it("a map click right after a marker drag commits is suppressed (drag's trailing click must not add a duplicate waypoint)", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
    render(<PreviewAttachment />);
    await waitFor(() => expect(lastMapProps?.onMarkerMove).toBeTruthy());

    await act(async () => {
      lastMapProps!.onMarkerMove!("wp:wp-g", 40.0, 135.0);
    });
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("note_region_move", expect.anything()));
    callMock.mockClear();

    // 100ms after the drag — still inside the suppression window.
    nowSpy.mockReturnValue(1_100);
    act(() => {
      lastMapProps!.onMapClick!(10, 20);
    });
    expect(callMock).not.toHaveBeenCalledWith("note_region_add", expect.anything());

    // 400ms after the drag — outside the window, a real click must still work.
    nowSpy.mockReturnValue(1_400);
    await act(async () => {
      lastMapProps!.onMapClick!(10, 20);
    });
    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("note_region_add", expect.objectContaining({ lat: 10, lng: 20 }));
    });

    nowSpy.mockRestore();
  });

  it("picking an inline search result adds the place immediately (no modal)", async () => {
    const user = userEvent.setup();
    render(<PreviewAttachment />);

    await waitFor(() => expect(screen.getByTestId("region-inline-search")).toBeTruthy());
    await user.click(screen.getByText("pick"));

    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith(
        "note_region_add",
        expect.objectContaining({ note_id: "n1", name: "부산", lat: 35.18, lng: 129.08 }),
      );
    });
  });
});

describe("PreviewAttachment — empty-state 'AI 정리' suggestion card (owner Q6)", () => {
  beforeEach(() => {
    callMock.mockReset();
    emitNoticeMock.mockReset();
    useAiStore.setState({ translateGateOk: null, organizePending: false, lastProposal: null, lastProposalNoteId: null });
    useAiPresetsStore.setState({
      list: [{ id: "metadata", name: "데이터 자동 채우기", prompt: "", kind: "metadata", isBuiltin: true, hidden: false }],
      loaded: true,
    });
    // 메타데이터 기준은 엔진 지침(PLAN-2026-09-27 §7.1) — 사용자가 고친 값이 이렇게 실린다.
    useAiInstructionsStore.setState({ instructions: { metadata: "GUIDANCE" }, loaded: true });
    useUiStore.setState({ previewItem: null });
    useNotesStore.setState({
      activeNote: {
        note: { id: "n1", title: "My Note" },
        sections: [{ id: "s1", name: "Overview", body_md: "body text", position: 0, kind: "text" }],
        sources: [],
        attachments: [],
      } as never,
      activeDraft: false,
    });
  });

  it("shows the plain 'select an item' hint when AI is off, even with a note open", () => {
    useSettingsStore.setState({ aiEnabled: false });
    render(<PreviewAttachment />);
    expect(screen.getByText(/항목을 선택하세요|Select an item|Sélectionnez un élément/)).toBeTruthy();
    expect(screen.queryByText(/AI에게 묻기|Ask AI/)).toBeNull();
  });

  it("shows the plain hint when AI is on but no note is open (nothing to organize)", () => {
    useSettingsStore.setState({ aiEnabled: true });
    useNotesStore.setState({ activeNote: null, activeDraft: false });
    render(<PreviewAttachment />);
    expect(screen.getByText(/항목을 선택하세요|Select an item|Sélectionnez un élément/)).toBeTruthy();
  });

  it("swaps to the AI suggestion card when AI is on and a note is open", () => {
    useSettingsStore.setState({ aiEnabled: true });
    render(<PreviewAttachment />);
    expect(screen.getByText(/AI에게 묻기|Ask AI/)).toBeTruthy();
    expect(screen.queryByText(/^(항목을 선택하세요|Select an item|Sélectionnez un élément)$/)).toBeNull();
  });

  it("'메타데이터 제안' chip runs the gated organize call for the active note directly (no intermediate modal)", async () => {
    useSettingsStore.setState({ aiEnabled: true });
    const organizeCurrentNote = vi.fn(async () => {});
    useAiStore.setState({ organizeCurrentNote } as never);
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "settings_get_all") {
        return Promise.resolve({ settings: { ai_enabled: false, ai_provider: "ollama", ai_endpoint: "" } });
      }
      return Promise.resolve({});
    });
    render(<PreviewAttachment />);

    fireEvent.click(screen.getByText("Auto-fill metadata"));

    await waitFor(() => expect(organizeCurrentNote).toHaveBeenCalledWith("n1", ["title", "tags", "year", "region", "folder"], "GUIDANCE"));
  });

  it("'AI에게 묻기…' chip opens the full modal instead of running immediately", async () => {
    useSettingsStore.setState({ aiEnabled: true });
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "settings_get_all") {
        return Promise.resolve({ settings: { ai_enabled: false, ai_provider: "ollama", ai_endpoint: "" } });
      }
      return Promise.resolve({});
    });
    render(<PreviewAttachment />);

    fireEvent.click(screen.getByText(/AI에게 묻기|Ask AI/));

    await waitFor(() => expect(screen.getByTestId("modal-shell")).toBeTruthy());
  });
});

describe("PreviewAttachment — kind='chart' routes to ChartRefPreview (live sheet chart reference)", () => {
  beforeEach(() => {
    callMock.mockReset();
    callMock.mockResolvedValue({});
    useSettingsStore.setState({ aiEnabled: false } as never);
    useNotesStore.setState({
      activeNote: {
        note: { id: "n1" },
        sections: [
          {
            id: "sec-1",
            name: "가계부",
            kind: "sheet",
            position: 0,
            body_md: JSON.stringify({
              v: 1,
              rows: 2,
              cols: [{ w: 80 }, { w: 80 }],
              cells: { A1: { raw: "1월" }, B1: { raw: "100" }, B2: { raw: "200" } },
              charts: [{ id: "c1", type: "total", title: "합계", series: ["B1:B2"] }],
            }),
          },
        ],
        sources: [],
        attachments: [
          { id: "att-c", name: "합계", kind: "chart", rel_path: null, url: "sec-1#c1", size_bytes: null, position: 0 },
        ],
      } as never,
      activeDraft: false,
    } as never);
    useUiStore.setState({ previewItem: { kind: "attachment", id: "att-c" } } as never);
  });

  it("renders the chart from the sheet body, not from a file", async () => {
    render(<PreviewAttachment />);
    await waitFor(() => expect(screen.getByTestId("chart-ref-preview")).toBeTruthy());
    expect(screen.getByText("300")).toBeTruthy();
    // 파일 첨부 경로(attachments_base_dir 등)를 타지 않는다 — url 참조뿐이다.
    expect(callMock.mock.calls.some(([cmd]) => cmd === "attachment_read_text")).toBe(false);
  });
});
