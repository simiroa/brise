import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { RegionDetectedSection } from "./RegionDetectedSection";
import { useRegionNudgeStore } from "../../stores/regionNudge";
import type { PrimaryRegion } from "../attachments/regionDisplay";

const callMock = vi.fn();
const callSilentMock = vi.fn();
vi.mock("../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callSilentMock(...args),
}));

const invalidateRegionRegistryMock = vi.fn();
vi.mock("../../lib/regionRegistry", () => ({
  invalidateRegionRegistry: (...args: unknown[]) => invalidateRegionRegistryMock(...args),
}));

// PLAN-2026-09-19-date-region-ui.md §P3 D11 — 같은 mock 관용구를 RegionEntryPopover.test.tsx에서
// 그대로 가져왔다(원본 write 경로 둘 중 하나의 테스트). activeNote는 module-level 가변 변수라
// setRegionMock이 "롤백 없이 성공"을 흉내낼 수 있고, mockImplementationOnce로 D11 회귀(롤백)도
// 흉내낼 수 있다.
let activeNote: { note: { id: string; region: string | null } } | null = {
  note: { id: "note-1", region: null },
};
const setRegionMock = vi.fn(async (region: string | null) => {
  if (activeNote) activeNote = { note: { ...activeNote.note, region } };
});
const setLocationMock = vi.fn(async () => {});
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

const HAS_PRIMARY: PrimaryRegion = { region: "서울", lat: 37.56, lng: 126.97 };
const NO_PRIMARY: PrimaryRegion = { region: null, lat: null, lng: null };

function seedCandidates(noteId: string | null, candidates: { name: string; lat: number; lng: number }[]) {
  useRegionNudgeStore.setState({ noteId, candidates, dismissedNames: new Set<string>() });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("RegionDetectedSection", () => {
  beforeEach(() => {
    callMock.mockReset();
    callSilentMock.mockReset();
    invalidateRegionRegistryMock.mockReset();
    setRegionMock.mockClear();
    setLocationMock.mockClear();
    bumpAttachmentRevisionMock.mockClear();
    activeNote = { note: { id: "note-1", region: null } };
    useRegionNudgeStore.setState({ noteId: null, candidates: [], dismissedNames: new Set<string>() });
  });
  afterEach(() => cleanup());

  it("renders nothing when there are no candidates", () => {
    seedCandidates("note-1", []);
    const { container } = render(<RegionDetectedSection noteId="note-1" primary={HAS_PRIMARY} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when the store's candidates belong to a different note", () => {
    seedCandidates("note-2", [{ name: "경주", lat: 1, lng: 2 }]);
    const { container } = render(<RegionDetectedSection noteId="note-1" primary={HAS_PRIMARY} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the header and one row per candidate", () => {
    seedCandidates("note-1", [
      { name: "경주", lat: 1, lng: 2 },
      { name: "부산", lat: 3, lng: 4 },
    ]);
    render(<RegionDetectedSection noteId="note-1" primary={HAS_PRIMARY} />);
    expect(screen.getByTestId("region-detected-section")).toBeTruthy();
    expect(screen.getByText("경주")).toBeTruthy();
    expect(screen.getByText("부산")).toBeTruthy();
    expect(screen.getByTestId("region-detected-accept-경주")).toBeTruthy();
    expect(screen.getByTestId("region-detected-dismiss-경주")).toBeTruthy();
  });

  it("caps visible rows at 5 and shows a +N overflow line", () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ name: `place${i}`, lat: i, lng: i }));
    seedCandidates("note-1", many);
    render(<RegionDetectedSection noteId="note-1" primary={HAS_PRIMARY} />);
    for (let i = 0; i < 5; i++) {
      expect(screen.getByTestId(`region-detected-accept-place${i}`)).toBeTruthy();
    }
    expect(screen.queryByTestId("region-detected-accept-place5")).toBeNull();
    expect(screen.queryByTestId("region-detected-accept-place6")).toBeNull();
    expect(screen.getByText("+2")).toBeTruthy();
  });

  it("dismiss adds the name to the session dismiss set and the row disappears", () => {
    seedCandidates("note-1", [{ name: "경주", lat: 1, lng: 2 }]);
    render(<RegionDetectedSection noteId="note-1" primary={HAS_PRIMARY} />);

    fireEvent.click(screen.getByTestId("region-detected-dismiss-경주"));

    expect(useRegionNudgeStore.getState().dismissedNames.has("경주")).toBe(true);
    expect(screen.queryByTestId("region-detected-accept-경주")).toBeNull();
  });

  it("accept on a note WITH a primary reads note_regions_list then adds a waypoint, and invalidates+bumps on success", async () => {
    seedCandidates("note-1", [{ name: "경복궁", lat: 37.58, lng: 126.97 }]);
    callSilentMock.mockResolvedValue({ regions: [{ position: 0 }, { position: 1 }] });
    callMock.mockResolvedValue({ id: "new-waypoint" });
    render(<RegionDetectedSection noteId="note-1" primary={HAS_PRIMARY} />);

    fireEvent.click(screen.getByTestId("region-detected-accept-경복궁"));
    await flush();

    expect(setRegionMock).not.toHaveBeenCalled();
    expect(callSilentMock).toHaveBeenCalledWith("note_regions_list", { note_id: "note-1" });
    expect(callMock).toHaveBeenCalledWith("note_region_add", {
      note_id: "note-1",
      name: "경복궁",
      lat: 37.58,
      lng: 126.97,
      position: 2,
    });
    expect(invalidateRegionRegistryMock).toHaveBeenCalledTimes(1);
    expect(bumpAttachmentRevisionMock).toHaveBeenCalledTimes(1);
  });

  it("accept on a note WITHOUT a primary uses the notes store setRegion/setLocation path", async () => {
    activeNote = { note: { id: "note-1", region: null } };
    seedCandidates("note-1", [{ name: "경복궁", lat: 37.58, lng: 126.97 }]);
    render(<RegionDetectedSection noteId="note-1" primary={NO_PRIMARY} />);

    fireEvent.click(screen.getByTestId("region-detected-accept-경복궁"));
    await flush();

    expect(setRegionMock).toHaveBeenCalledWith("경복궁");
    expect(setLocationMock).toHaveBeenCalledWith(37.58, 126.97);
    expect(callMock).not.toHaveBeenCalledWith("note_region_add", expect.anything());
    expect(invalidateRegionRegistryMock).toHaveBeenCalledTimes(1);
    expect(bumpAttachmentRevisionMock).toHaveBeenCalledTimes(1);
  });

  // §P3 D11 — patchActiveNote는 실패를 삼키고 롤백만 한다(다시 throw하지 않는다). 이 테스트는
  // setRegion이 "성공한 것처럼 resolve하지만 실제로는 region이 안 바뀐" 그 실패 모양을 흉내낸다.
  // 재확인 가드가 없으면 이 accept가 성공으로 오인돼 후보가 사라지고 revision이 bump된다.
  it("D11 regression: a silently-rolled-back setRegion must NOT invalidate/bump, and the candidate stays", async () => {
    activeNote = { note: { id: "note-1", region: null } };
    setRegionMock.mockImplementationOnce(async () => {
      // patchActiveNote 롤백 흉내 — region이 그대로다(안 바뀜), throw도 없다.
    });
    seedCandidates("note-1", [{ name: "경복궁", lat: 37.58, lng: 126.97 }]);
    render(<RegionDetectedSection noteId="note-1" primary={NO_PRIMARY} />);

    fireEvent.click(screen.getByTestId("region-detected-accept-경복궁"));
    await flush();

    expect(invalidateRegionRegistryMock).not.toHaveBeenCalled();
    expect(bumpAttachmentRevisionMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("region-detected-accept-경복궁")).toBeTruthy();
  });

  it("note_region_add rejection leaves the candidate in place and skips invalidate/bump", async () => {
    seedCandidates("note-1", [{ name: "경복궁", lat: 37.58, lng: 126.97 }]);
    callSilentMock.mockResolvedValue({ regions: [] });
    callMock.mockRejectedValue(new Error("network down"));
    render(<RegionDetectedSection noteId="note-1" primary={HAS_PRIMARY} />);

    fireEvent.click(screen.getByTestId("region-detected-accept-경복궁"));
    await flush();

    expect(invalidateRegionRegistryMock).not.toHaveBeenCalled();
    expect(bumpAttachmentRevisionMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("region-detected-accept-경복궁")).toBeTruthy();
  });
});
