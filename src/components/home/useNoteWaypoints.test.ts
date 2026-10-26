import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useNoteWaypoints } from "./useNoteWaypoints";
import { call } from "../../lib/invoke";
import { useNotesStore } from "../../stores/notes";

vi.mock("../../lib/invoke", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/invoke")>();
  return {
    ...actual,
    call: vi.fn(),
    callSilent: vi.fn(),
  };
});

describe("useNoteWaypoints", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches waypoints for active noteId", async () => {
    const mockCall = vi.mocked(call);
    mockCall.mockResolvedValueOnce({
      regions: [
        { id: "r1", name: "Region 1", lat: 10, lng: 20 },
      ],
    });

    const { result } = renderHook(() => useNoteWaypoints("note-1"));

    await waitFor(() => {
      expect(result.current).toHaveLength(1);
    });

    expect(result.current[0].name).toBe("Region 1");
    expect(mockCall).toHaveBeenCalledWith("note_regions_list", { note_id: "note-1" });
  });

  it("invalidates cache when attachmentRevision changes", async () => {
    const mockCall = vi.mocked(call);
    mockCall
      .mockResolvedValueOnce({ regions: [{ id: "r1", name: "Version 1", lat: 0, lng: 0 }] })
      .mockResolvedValueOnce({ regions: [{ id: "r1", name: "Version 2", lat: 0, lng: 0 }] });

    const { result } = renderHook(() => useNoteWaypoints("note-1"));

    await waitFor(() => {
      expect(result.current[0]?.name).toBe("Version 1");
    });

    act(() => {
      useNotesStore.setState((s) => ({ attachmentRevision: s.attachmentRevision + 1 }));
    });

    await waitFor(() => {
      expect(result.current[0]?.name).toBe("Version 2");
    });

    expect(mockCall).toHaveBeenCalledTimes(2);
  });
});
