import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NoteRegionsList } from "./NoteRegionsList";
import { useNotesStore } from "../../stores/notes";
import { useSettingsStore } from "../../stores/settings";
import { t } from "../../i18n/t";

const callMock = vi.fn();

vi.mock("../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  emitNotice: vi.fn(),
  registerFlush: vi.fn(() => () => {}),
}));

vi.mock("../map/WorldMapAuto", () => ({
  WorldMapAuto: (props: { onMapClick?: (lat: number, lng: number) => void; defaultLocation?: unknown }) => (
    <div data-testid="world-map-stub" data-seed={JSON.stringify(props.defaultLocation)}>
      <button type="button" data-testid="world-map-stub-click" onClick={() => props.onMapClick?.(37.5, 127.0)}>
        stub
      </button>
    </div>
  ),
}));

// W2/W3/W4 — 안정화: 같은 장소 가드 · 대표 쓰기 롤백 · 검색 키보드 · 지도 컨트롤 위치.
describe("NoteRegionsList — W3 안정화", () => {
  const seed = (region: string | null, lat: number | null, lng: number | null) => {
    useNotesStore.setState({
      activeNote: { note: { id: "n1", region, lat, lng } as never, sections: [], sources: [], attachments: [] } as never,
      activeDraft: false,
    } as never);
  };
  let failLocation = false;
  let failRegionOnce = false;
  let noRegions = false;

  beforeEach(() => {
    failLocation = false;
    failRegionOnce = false;
    noRegions = false;
    callMock.mockReset();
    callMock.mockImplementation(async (cmd: string, args: Record<string, unknown> = {}) => {
      if (cmd === "note_regions_list") {
        if (noRegions) return { regions: [] };
        return { regions: [{ id: "wp-g", note_id: "n1", name: "경주", lat: 35.85, lng: 129.22, position: 0 }] };
      }
      if (cmd === "note_region_add") return { id: "wp-new" };
      if (cmd === "note_region_remove") return { ok: true };
      if (cmd === "note_set_region") {
        if (failRegionOnce) {
          failRegionOnce = false;
          throw new Error("region write failed");
        }
        return { region: args.region };
      }
      if (cmd === "note_set_location") {
        if (failLocation) throw new Error("location write failed");
        return { lat: args.lat, lng: args.lng };
      }
      if (cmd === "geocode_search") {
        const dup = args.query === "dup";
        return { results: [{ label: "12, 서울시청, 중구", lat: dup ? 35.8501 : 35.18, lng: dup ? 129.2201 : 129.08 }] };
      }
      if (cmd === "geocode_reverse") return { label: "부산" };
      return {};
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    useNotesStore.setState({ activeNote: null, activeDraft: false } as never);
  });

  const typeAndDebounce = async (input: HTMLElement, query: string) => {
    vi.useFakeTimers();
    fireEvent.change(input, { target: { value: query } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    vi.useRealTimers();
  };

  const primary = { region: "서울", lat: 37.56, lng: 126.97 };

  it("검색 결과 이름은 번지수가 아니라 의미 있는 조각 (12, 서울시청, 중구 → 서울시청)", async () => {
    const user = userEvent.setup();
    seed("서울", 37.56, 126.97);
    render(<NoteRegionsList noteId="n1" primary={primary} />);
    await waitFor(() => expect(screen.getByTestId("note-region-add")).toBeTruthy());
    await user.click(screen.getByTestId("note-region-add"));
    await typeAndDebounce(screen.getByTestId("note-region-search-input"), "city");
    await waitFor(() => expect(screen.getByTestId("note-region-search-result-0")).toBeTruthy());
    fireEvent.click(screen.getByTestId("note-region-search-result-0"));
    await waitFor(() =>
      expect(callMock).toHaveBeenCalledWith("note_region_add", expect.objectContaining({ name: "서울시청" })),
    );
  });

  it("기존 장소와 약 50m 이내인 결과는 '등록됨'으로 비활성이라 고를 수 없다 (검색은 열려 있다)", async () => {
    const user = userEvent.setup();
    seed("서울", 37.56, 126.97);
    render(<NoteRegionsList noteId="n1" primary={primary} />);
    await waitFor(() => expect(screen.getByText("경주")).toBeTruthy());
    await user.click(screen.getByTestId("note-region-add"));
    await typeAndDebounce(screen.getByTestId("note-region-search-input"), "dup");
    await waitFor(() => expect(screen.getByTestId("note-region-search-result-0")).toBeTruthy());
    const row = screen.getByTestId("note-region-search-result-0");
    expect(row.getAttribute("aria-disabled")).toBe("true");
    expect(row.getAttribute("data-registered")).toBe("true");
    fireEvent.click(row);
    await Promise.resolve();
    expect(callMock).not.toHaveBeenCalledWith("note_region_add", expect.anything());
    expect(screen.getByTestId("note-region-search-input")).toBeTruthy();
  });

  it("첫 장소 쓰기에서 좌표가 실패하면 이름도 직전 값(null)으로 롤백한다", async () => {
    seed(null, null, null);
    noRegions = true;
    failLocation = true;
    const user = userEvent.setup();
    render(<NoteRegionsList noteId="n1" primary={{ region: null, lat: null, lng: null }} autoOpenSearch />);
    await waitFor(() => expect(screen.getByTestId("note-region-search-input")).toBeTruthy());
    await user.click(screen.getByTestId("world-map-stub-click"));

    await waitFor(() => expect(callMock).toHaveBeenCalledWith("note_set_location", expect.anything()));
    // 롤백: setRegion(null) 이 한 번 더 나가고 activeNote 는 비어 있다.
    await waitFor(() => {
      const regionCalls = callMock.mock.calls.filter((c) => c[0] === "note_set_region");
      expect(regionCalls.map((c) => (c[1] as { region: string | null }).region)).toEqual(["부산", null]);
    });
    await waitFor(() => expect(useNotesStore.getState().activeNote?.note.region).toBeNull());
    expect(useNotesStore.getState().activeNote?.note.lat).toBeNull();
  });

  it("대표 해제에서 좌표 쓰기가 실패하면 이름을 되돌려 행이 그대로 남는다", async () => {
    seed("서울", 37.56, 126.97);
    failLocation = true;
    const user = userEvent.setup();
    render(<NoteRegionsList noteId="n1" primary={primary} />);
    await waitFor(() => expect(screen.getByTestId("note-region-primary")).toBeTruthy());
    await user.click(screen.getByTestId("note-region-primary-toggle"));
    await user.click(screen.getByTestId("note-region-primary-clear"));

    await waitFor(() => expect(callMock).toHaveBeenCalledWith("note_set_location", expect.anything()));
    await waitFor(() => {
      const regionCalls = callMock.mock.calls.filter((c) => c[0] === "note_set_region");
      expect(regionCalls.map((c) => (c[1] as { region: string | null }).region)).toEqual([null, "서울"]);
    });
    await waitFor(() => expect(useNotesStore.getState().activeNote?.note.region).toBe("서울"));
    expect(useNotesStore.getState().activeNote?.note.lat).toBe(37.56);
  });

  it("대표로 지정 쓰기가 실패하면 강등용으로 만든 행을 지우고 승격 대상 행은 지우지 않는다", async () => {
    seed("서울", 37.56, 126.97);
    failRegionOnce = true;
    const user = userEvent.setup();
    render(<NoteRegionsList noteId="n1" primary={primary} />);
    await waitFor(() => expect(screen.getByText("경주")).toBeTruthy());
    await user.click(screen.getByTestId("note-region-toggle-wp-g"));
    await user.click(screen.getByRole("button", { name: t("region.set_primary") }));

    await waitFor(() => expect(callMock).toHaveBeenCalledWith("note_region_remove", { id: "wp-new" }));
    expect(callMock).not.toHaveBeenCalledWith("note_region_remove", { id: "wp-g" });
    expect(useNotesStore.getState().activeNote?.note.region).toBe("서울");
  });

  it("검색창에서 ↓ + Enter 로 결과를 확정하고, Esc 로 검색을 닫는다", async () => {
    const user = userEvent.setup();
    seed("서울", 37.56, 126.97);
    render(<NoteRegionsList noteId="n1" primary={primary} />);
    await waitFor(() => expect(screen.getByTestId("note-region-add")).toBeTruthy());
    await user.click(screen.getByTestId("note-region-add"));
    const input = screen.getByTestId("note-region-search-input");
    await typeAndDebounce(input, "busan");
    await waitFor(() => expect(screen.getByTestId("note-region-search-result-0")).toBeTruthy());
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(callMock).toHaveBeenCalledWith("note_region_add", expect.objectContaining({ name: "서울시청" })),
    );

    await user.click(screen.getByTestId("note-region-add"));
    fireEvent.keyDown(screen.getByTestId("note-region-search-input"), { key: "Escape" });
    expect(screen.queryByTestId("note-region-search-input")).toBeNull();
  });

  it("검색 닫기 버튼은 검색 닫기 라벨을 갖는다", async () => {
    seed("서울", 37.56, 126.97);
    const user = userEvent.setup();
    render(<NoteRegionsList noteId="n1" primary={primary} />);
    await waitFor(() => expect(screen.getByTestId("note-region-add")).toBeTruthy());
    await user.click(screen.getByTestId("note-region-add"));
    const close = screen.getByTestId("note-region-search-close");
    expect(close.getAttribute("aria-label")).toBe(t("region.search_close"));
    await user.click(close);
    expect(screen.queryByTestId("note-region-search-input")).toBeNull();
  });

  it("지도 아래 한 줄에 잠금/홈 컨트롤이 있고(지도 안이 아니다), 높이는 200px, 잠금은 눌림 상태를 토글한다", async () => {
    seed("서울", 37.56, 126.97);
    const user = userEvent.setup();
    render(<NoteRegionsList noteId="n1" primary={primary} />);
    await waitFor(() => expect(screen.getByTestId("note-region-map")).toBeTruthy());
    const lock = screen.getByTestId("note-region-map-lock");
    const map = screen.getByTestId("note-region-map");
    expect(map.contains(lock)).toBe(false);
    expect(map.style.height).toBe("200px");
    expect(lock.getAttribute("aria-pressed")).toBe("false");
    await user.click(lock);
    expect(lock.getAttribute("aria-pressed")).toBe("true");
    await user.click(screen.getByTestId("note-region-map-home"));
    expect(screen.getByTestId("world-map-stub").getAttribute("data-seed")).toContain("lat");
  });

  it("안내문과 기본 위치 사용 링크는 서로 다른 줄(형제 요소)이다", async () => {
    useSettingsStore.setState({ defaultMapLocationCustomized: true } as never);
    seed("서울", 37.56, 126.97);
    const user = userEvent.setup();
    render(<NoteRegionsList noteId="n1" primary={primary} />);
    await waitFor(() => expect(screen.getByTestId("note-region-add")).toBeTruthy());
    await user.click(screen.getByTestId("note-region-add"));
    const hint = screen.getByText(t("region.map_click_hint"));
    const link = screen.getByTestId("note-region-use-default-location");
    expect(hint.contains(link)).toBe(false);
    expect(hint.parentElement).toBe(link.parentElement?.parentElement);
    useSettingsStore.setState({ defaultMapLocationCustomized: false } as never);
  });
});
