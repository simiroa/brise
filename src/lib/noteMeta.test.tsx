import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement } from "react";
import { act, render } from "@testing-library/react";
import { useNoteRegions, useNoteDates } from "./noteMeta";
import { useNoteWaypoints } from "../components/home/useNoteWaypoints";
import { useNotesStore } from "../stores/notes";
import { bumpNoteQueryVersion } from "./noteQuery";

const callMock = vi.fn();

vi.mock("./invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  flushAll: vi.fn(async () => {}),
  registerFlush: vi.fn(() => () => {}),
  emitNotice: vi.fn(),
}));

async function flush() {
  await act(async () => {
    await new Promise<void>((r) => setTimeout(r, 0));
  });
}

const regionsCalls = () => callMock.mock.calls.filter(([cmd]) => cmd === "note_regions_list").length;

describe("noteMeta — 노트 메타 조회 공유", () => {
  beforeEach(() => {
    callMock.mockReset();
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "note_regions_list") return { regions: [{ id: `r${regionsCalls()}`, name: "경주", lat: 1, lng: 2, position: 0 }] };
      if (cmd === "note_dates_list") return { dates: [] };
      return {};
    });
    useNotesStore.setState({ attachmentRevision: 0, loadingNoteId: null } as never);
  });

  // 제목줄 지역 칩 · 지역 감지(useNoteWaypoints) · 첨부 바가 한 노트에 동시에 붙는 모양.
  function Consumers({ noteId }: { noteId: string }) {
    useNoteRegions(noteId);
    useNoteWaypoints(noteId);
    useNoteRegions(noteId);
    return null;
  }

  it("three consumers of one note's regions share a single note_regions_list", async () => {
    render(createElement(Consumers, { noteId: "n1" }));
    await flush();
    expect(regionsCalls()).toBe(1);
  });

  it("attachmentRevision and noteQueryVersion bumps refetch once for all consumers", async () => {
    render(createElement(Consumers, { noteId: "n1" }));
    await flush();
    act(() => useNotesStore.getState().bumpAttachmentRevision());
    await flush();
    expect(regionsCalls()).toBe(2);

    vi.useFakeTimers();
    try {
      bumpNoteQueryVersion();
      act(() => {
        vi.advanceTimersByTime(300);
      });
    } finally {
      vi.useRealTimers();
    }
    await flush();
    expect(regionsCalls()).toBe(3);
  });

  it("a remount in the same open shows the cached value at once without IPC", async () => {
    let seen: string[] = [];
    function Probe() {
      seen = useNoteRegions("n1").regions.map((r) => r.id);
      return null;
    }
    const first = render(createElement(Probe));
    await flush();
    first.unmount();
    render(createElement(Probe));
    expect(seen).toEqual(["r1"]);
    await flush();
    expect(regionsCalls()).toBe(1);
  });

  it("skips the draft page and null ids", async () => {
    function Probe() {
      useNoteRegions("__draft__");
      useNoteRegions(null);
      useNoteDates(null, 0);
      return null;
    }
    render(createElement(Probe));
    await flush();
    expect(callMock).not.toHaveBeenCalled();
  });

  it("dates refetch on the caller's local key and on a new open", async () => {
    function Probe({ k }: { k: number }) {
      useNoteDates("n1", k);
      return null;
    }
    const { rerender } = render(createElement(Probe, { k: 0 }));
    await flush();
    rerender(createElement(Probe, { k: 0 }));
    await flush();
    const datesCalls = () => callMock.mock.calls.filter(([cmd]) => cmd === "note_dates_list").length;
    expect(datesCalls()).toBe(1);
    rerender(createElement(Probe, { k: 1 }));
    await flush();
    expect(datesCalls()).toBe(2);
    act(() => useNotesStore.setState({ loadingNoteId: "n1" } as never));
    await flush();
    expect(datesCalls()).toBe(3);
  });
});
