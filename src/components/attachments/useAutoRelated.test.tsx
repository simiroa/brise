import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement } from "react";
import { act, render } from "@testing-library/react";
import { useAutoRelated } from "./useAutoRelated";
import type { NoteSummary } from "../../lib/commands.gen";
import { useNotesStore } from "../../stores/notes";

const callMock = vi.fn();

vi.mock("../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  // noteMeta.ts → stores/notes 가 모듈 로드 시 쓴다.
  flushAll: vi.fn(async () => {}),
  registerFlush: vi.fn(() => () => {}),
  emitNotice: vi.fn(),
}));

function makeSummary(id: string): NoteSummary {
  return {
    id,
    folder_id: "f1",
    title: id,
    year: 1500,
    is_favorite: false,
    exported_at: null,
    has_image: false,
    tag_names: [],
    region: null,
    status: null,
    icon: null,
    lat: null,
    lng: null,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
    month: null,
    day: null,
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise<void>((r) => setTimeout(r, 0));
  });
}

describe("useAutoRelated", () => {
  beforeEach(() => {
    callMock.mockReset();
  });

  it("re-fetches when refreshKey bumps without noteId change", async () => {
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "note_related") {
        return { notes: [makeSummary(`n-${callMock.mock.calls.length}`)] };
      }
      return {};
    });

    let latest: ReturnType<typeof useAutoRelated> = [];
    function Probe({ refreshKey }: { refreshKey: number }) {
      latest = useAutoRelated("note-a", refreshKey);
      return null;
    }
    const { rerender } = render(createElement(Probe, { refreshKey: 0 }));
    await flush();
    expect(callMock).toHaveBeenCalledTimes(1);
    expect(latest.map((n) => n.id)).toEqual(["n-1"]);

    rerender(createElement(Probe, { refreshKey: 1 }));
    await flush();
    expect(callMock).toHaveBeenCalledTimes(2);
    expect(latest.map((n) => n.id)).toEqual(["n-2"]);
  });

  it("does not call note_related for draft / missing ids", async () => {
    function Probe() {
      useAutoRelated("__draft__", 0);
      useAutoRelated(undefined, 0);
      return null;
    }
    render(createElement(Probe));
    await flush();
    expect(callMock).not.toHaveBeenCalled();
  });

  it("a remount within the same note open reuses the shared fetch; a new open refetches", async () => {
    callMock.mockImplementation(async (cmd: string) =>
      cmd === "note_related" ? { notes: [makeSummary(`n-${callMock.mock.calls.length}`)] } : {},
    );
    let latest: ReturnType<typeof useAutoRelated> = [];
    function Probe() {
      latest = useAutoRelated("note-a", 0);
      return null;
    }
    const first = render(createElement(Probe));
    await flush();
    first.unmount();
    // 집중 모드 토글·대시보드를 거쳐 잠깐 다시 붙는 것 — 같은 열기 안이라 IPC 없이 바로 값이 있다.
    render(createElement(Probe));
    expect(latest.map((n) => n.id)).toEqual(["n-1"]);
    await flush();
    expect(callMock).toHaveBeenCalledTimes(1);

    // selectNote 가 loadingNoteId 를 세우면 "열기" — 다른 노트 본문에 달린 값이라 새로 읽는다.
    act(() => {
      useNotesStore.setState({ loadingNoteId: "note-a" });
    });
    await flush();
    expect(callMock).toHaveBeenCalledTimes(2);
    expect(latest.map((n) => n.id)).toEqual(["n-2"]);
    act(() => {
      useNotesStore.setState({ loadingNoteId: null });
    });
  });
});
