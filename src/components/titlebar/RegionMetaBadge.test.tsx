import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RegionMetaBadge } from "./RegionMetaBadge";
import { useNotesStore } from "../../stores/notes";
import { useSearchStore } from "../../stores/search";
import { useRegionNudgeStore } from "../../stores/regionNudge";

const callMock = vi.fn();

vi.mock("../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  emitNotice: vi.fn(),
  registerFlush: vi.fn(() => () => {}),
}));

// PLAN-2026-09-19-date-region-ui.md §P3 Phase B — this file only cares about the dot's rendering
// contract (does it show, does it carry the count), not the matching-engine's own reset/scan
// semantics (regionDetect.test.ts covers that hook directly). Stubbing it out lets these tests
// drive useRegionNudgeStore's state directly without racing the hook's own resetForNote effect.
vi.mock("../editor/regionDetect", () => ({
  useRegionDetect: () => {},
}));

// PLAN-2026-09-19-date-region-ui.md §P4 D3′ — the popover mounts NoteRegionsList non-inline,
// which now always renders WorldMapAuto (no longer gated behind an add target). jsdom has no
// ResizeObserver/WebGL, so any test that mounts NoteRegionsList non-inline must stub this the
// same way NoteRegionsList.test.tsx does. RegionPickerDialog is no longer imported by
// NoteRegionsList (the modal escape hatch it backed is gone), so that mock is removed.
vi.mock("../map/WorldMapAuto", () => ({
  WorldMapAuto: (props: { markers?: unknown[]; onMapClick?: (lat: number, lng: number) => void }) => (
    <div data-testid="world-map-stub" data-markers={props.markers?.length ?? 0} data-has-click={String(!!props.onMapClick)} />
  ),
}));

// QA feedback (dashboard integrate, 항목 2): this badge replaces the single-primary RegionEditor
// chip on the meta row — it now opens NoteRegionsList (add/remove/reorder/promote) in a popover.
describe("RegionMetaBadge — meta-row multi-region entry point (QA 항목 2)", () => {
  beforeEach(() => {
    callMock.mockReset();
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "note_regions_list") {
        return {
          regions: [
            { id: "wp-g", note_id: "n1", name: "경주", lat: 35.85, lng: 129.22, position: 0 },
          ],
        };
      }
      return {};
    });
    useNotesStore.setState({ activeNote: null, activeDraft: false } as never);
    useRegionNudgeStore.setState({ noteId: null, candidates: [], dismissedNames: new Set<string>() });
  });

  it("shows a dashed 'add region' placeholder when nothing is set", () => {
    callMock.mockImplementation(async (cmd: string) => (cmd === "note_regions_list" ? { regions: [] } : {}));
    render(<RegionMetaBadge noteId="n1" primary={{ region: null, lat: null, lng: null }} />);
    expect(screen.getByTestId("region-meta-badge").textContent).toContain("Region");
  });

  it("shows the primary name plus the waypoint count once fetched", async () => {
    render(<RegionMetaBadge noteId="n1" primary={{ region: "서울", lat: 37.56, lng: 126.97 }} />);
    await waitFor(() => {
      expect(screen.getByTestId("region-meta-badge").textContent).toBe("서울 +1");
    });
  });

  it("clicking the badge opens a popover containing the multi-region list", async () => {
    const user = userEvent.setup();
    render(<RegionMetaBadge noteId="n1" primary={{ region: "서울", lat: 37.56, lng: 126.97 }} />);
    await user.click(screen.getByTestId("region-meta-badge"));
    expect(screen.getByTestId("region-meta-popover")).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("note-regions-list")).toBeTruthy());
    await waitFor(() => expect(screen.getByText("경주")).toBeTruthy());
  });

  it("clicking a place name inside the popover closes it (the filter it applies is otherwise invisible behind the overlay)", async () => {
    const user = userEvent.setup();
    render(<RegionMetaBadge noteId="n1" primary={{ region: "서울", lat: 37.56, lng: 126.97 }} />);
    await user.click(screen.getByTestId("region-meta-badge"));
    await waitFor(() => expect(screen.getByText("경주")).toBeTruthy());

    await user.click(screen.getByTestId("note-region-filter-wp-g"));

    expect(screen.queryByTestId("region-meta-popover")).toBeNull();
    expect(useSearchStore.getState().regionFilter).toEqual({ kind: "region", name: "경주" });
  });

  it("Escape closes the popover", async () => {
    const user = userEvent.setup();
    render(<RegionMetaBadge noteId="n1" primary={{ region: "서울", lat: 37.56, lng: 126.97 }} />);
    await user.click(screen.getByTestId("region-meta-badge"));
    expect(screen.getByTestId("region-meta-popover")).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("region-meta-popover")).toBeNull();
  });

  // PLAN-2026-09-19-date-region-ui.md §P2 — matches DateBadge.tsx's fixed 296px popover (2026-09-08
  // owner decision), replacing the old minWidth/maxWidth pair.
  it("popover is fixed at 296px wide (matches DateBadge)", async () => {
    const user = userEvent.setup();
    render(<RegionMetaBadge noteId="n1" primary={{ region: "서울", lat: 37.56, lng: 126.97 }} />);
    await user.click(screen.getByTestId("region-meta-badge"));
    const popover = screen.getByTestId("region-meta-popover");
    expect(popover.style.width).toBe("296px");
  });

  it("forwards isGlow onto the chip (per-badge AI glow, not the meta row)", () => {
    render(
      <RegionMetaBadge
        noteId="n1"
        primary={{ region: "서울", lat: 37.56, lng: 126.97 }}
        isGlow="active"
      />,
    );
    expect(screen.getByTestId("region-meta-badge").getAttribute("data-ai-glow")).toBe("active");
  });

  it("omits data-ai-glow when isGlow is false/undefined", () => {
    const { rerender } = render(
      <RegionMetaBadge noteId="n1" primary={{ region: null, lat: null, lng: null }} />,
    );
    expect(screen.getByTestId("region-meta-badge").hasAttribute("data-ai-glow")).toBe(false);
    rerender(
      <RegionMetaBadge
        noteId="n1"
        primary={{ region: null, lat: null, lng: null }}
        isGlow={false}
      />,
    );
    expect(screen.getByTestId("region-meta-badge").hasAttribute("data-ai-glow")).toBe(false);
  });

  // PLAN-2026-09-19-date-region-ui.md §P3 Phase B 항목 2 — 넛지 점.
  describe("detected-region nudge dot", () => {
    it("is absent when there are no candidates", () => {
      render(<RegionMetaBadge noteId="n1" primary={{ region: "서울", lat: 37.56, lng: 126.97 }} />);
      expect(screen.queryByTestId("region-meta-badge-detected-dot")).toBeNull();
    });

    it("is present for this note and the title mentions the detected count", () => {
      useRegionNudgeStore.setState({
        noteId: "n1",
        candidates: [
          { name: "경주", lat: 35.85, lng: 129.22 },
          { name: "부산", lat: 35.18, lng: 129.08 },
        ],
        dismissedNames: new Set<string>(),
      });
      render(<RegionMetaBadge noteId="n1" primary={{ region: "서울", lat: 37.56, lng: 126.97 }} />);
      const dot = screen.getByTestId("region-meta-badge-detected-dot");
      expect(dot).toBeTruthy();
      expect(dot.getAttribute("aria-hidden")).toBe("true");
      expect(screen.getByTestId("region-meta-badge").title).toContain("2");
    });

    it("is absent when the store's candidates belong to a different note", () => {
      useRegionNudgeStore.setState({
        noteId: "n2",
        candidates: [{ name: "경주", lat: 35.85, lng: 129.22 }],
        dismissedNames: new Set<string>(),
      });
      render(<RegionMetaBadge noteId="n1" primary={{ region: "서울", lat: 37.56, lng: 126.97 }} />);
      expect(screen.queryByTestId("region-meta-badge-detected-dot")).toBeNull();
    });
  });
});
