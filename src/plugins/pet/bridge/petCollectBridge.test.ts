import { describe, it, expect, vi, beforeEach } from "vitest";

const callMock = vi.fn();
vi.mock("../../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  emitNotice: vi.fn(),
  // The real notes store (imported below, unmocked) registers an autosave flush at module init
  // (stores/notesActive.ts -> lib/noteAutosave.ts::registerFlush) — without these two, importing
  // it here throws before any test body runs (SidebarChat.test.tsx uses the same pair).
  flushAll: vi.fn(),
  registerFlush: () => () => {},
}));

// listen()/emit() mocks — listen captures registered handlers by event name so tests can fire
// them directly (petSuggestionsBridge.test.ts/petLinkBridge.test.ts 판례와 같은 모양). acceptSuggestion
// (petSuggestionsBridge.ts, 모킹하지 않고 실제로 돈다)도 이 emit 을 쓴다.
const listenMock = vi.fn();
const emitMock = vi.fn();
vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
  emit: (...args: unknown[]) => emitMock(...args),
}));

import { acceptCollectSuggestion, listenPetCollectBridge } from "./petCollectBridge";
import { useAiStore } from "../../../stores/ai";
import { useAiPresetsStore } from "../../../stores/aiPresets";
import { useNotesStore } from "../../../stores/notes";

/** listen() 에 등록된 핸들러를 이름으로 꺼내 직접 쏜다(petSuggestionsBridge.test.ts 와 같은 모양). */
function fire(event: string, payload: unknown): Promise<void> {
  const entry = listenMock.mock.calls.find((c) => c[0] === event);
  if (!entry) throw new Error(`no handler registered for ${event}`);
  return (entry[1] as (e: { payload: unknown }) => void)({ payload }) as unknown as Promise<void>;
}

/** 브리지 안의 fire-and-forget 체인이 다 돌 때까지 마이크로태스크를 흘린다. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

let organizeMock: ReturnType<typeof vi.fn>;
let selectNoteMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  callMock.mockReset();
  callMock.mockResolvedValue({});
  listenMock.mockReset();
  listenMock.mockResolvedValue(vi.fn());
  emitMock.mockReset();
  emitMock.mockResolvedValue(undefined);

  organizeMock = vi.fn(async () => {});
  selectNoteMock = vi.fn(async () => {});
  useAiStore.setState({ organizeCurrentNote: organizeMock as never });
  useNotesStore.setState({ selectNote: selectNoteMock } as never);
  useAiPresetsStore.setState({
    list: [{ id: "metadata", nameKey: "x", prompt: "GUIDANCE", kind: "metadata", isBuiltin: true }],
    loaded: true,
  } as never);
});

// 수락 핸들러(펫 카드/사이드바 카드 공용) — ①acceptSuggestion(petSuggestionsBridge, 실제로 돈다)
// ②노트 열기 ③organizeCurrentNote(silent=false, origin/model 포함), 이 순서로.
describe("acceptCollectSuggestion", () => {
  it("runs accept -> select note -> organize in order, with metadata guidance/silent=false/origin/model", async () => {
    const calls: string[] = [];
    callMock.mockImplementation(async () => {
      calls.push("accept");
      return {};
    });
    selectNoteMock.mockImplementation(async () => {
      calls.push("select");
    });
    organizeMock.mockImplementation(async () => {
      calls.push("organize");
    });

    await acceptCollectSuggestion({ id: "s1", noteId: "n1", model: "gpt-x" });

    expect(callMock).toHaveBeenCalledWith("suggestion_set_status", { id: "s1", status: "accepted" });
    expect(selectNoteMock).toHaveBeenCalledWith("n1");
    expect(organizeMock).toHaveBeenCalledWith(
      "n1",
      ["title", "tags", "year", "region", "folder"],
      "GUIDANCE",
      false,
      { model: "gpt-x", origin: "collect_post_process" },
    );
    expect(calls).toEqual(["accept", "select", "organize"]);
  });

  it("passes model: undefined (falls back to the user's default model) when the suggestion carries none", async () => {
    await acceptCollectSuggestion({ id: "s2", noteId: "n2", model: null });
    expect(organizeMock).toHaveBeenCalledWith("n2", expect.any(Array), "GUIDANCE", false, {
      model: undefined,
      origin: "collect_post_process",
    });
  });

  it("aborts before opening the note or organizing when marking the suggestion accepted fails", async () => {
    callMock.mockRejectedValueOnce(new Error("db down"));
    await expect(acceptCollectSuggestion({ id: "s3", noteId: "n3", model: null })).rejects.toThrow();
    expect(selectNoteMock).not.toHaveBeenCalled();
    expect(organizeMock).not.toHaveBeenCalled();
  });
});

describe("listenPetCollectBridge", () => {
  it("maps the emitted payload (note_id/model) and runs the full accept chain", async () => {
    listenPetCollectBridge();
    await flush();

    await fire("pet-accept-collect-suggestion", { id: "s9", note_id: "n9", model: "local-model" });
    await flush();

    expect(callMock).toHaveBeenCalledWith("suggestion_set_status", { id: "s9", status: "accepted" });
    expect(selectNoteMock).toHaveBeenCalledWith("n9");
    expect(organizeMock).toHaveBeenCalledWith("n9", expect.any(Array), "GUIDANCE", false, {
      model: "local-model",
      origin: "collect_post_process",
    });
  });

  it("still requests a refresh even if the underlying accept fails — badge must not go 60s stale", async () => {
    listenPetCollectBridge();
    await flush();
    callMock.mockRejectedValueOnce(new Error("db down"));

    await fire("pet-accept-collect-suggestion", { id: "s10", note_id: "n10", model: null });
    await flush();

    expect(emitMock).toHaveBeenCalledWith("pet-suggestions-refresh");
    expect(organizeMock).not.toHaveBeenCalled();
  });

  it("unregisters the listener on cleanup", async () => {
    const unlisten = vi.fn();
    listenMock.mockResolvedValue(unlisten);

    const cleanup = listenPetCollectBridge();
    await flush();
    cleanup();

    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});
