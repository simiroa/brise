import { describe, it, expect, vi, beforeEach } from "vitest";

const callMock = vi.fn();
vi.mock("../../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
}));

vi.mock("../../../lib/noteActions", () => ({
  appendSectionWithBody: (noteId: string, name: string | undefined, bodyMd: string) =>
    callMock("section_create_with_body", { note_id: noteId, name, body_md: bodyMd }),
  createInboxMemo: (text: string, title?: string) => callMock("pet_note_create", { text, title }),
}));

// listen()/emit() mocks — listen captures registered handlers by event name so tests can fire
// them directly (petSuggestionsBridge.test.ts 판례와 같은 모양).
const listenMock = vi.fn();
const emitMock = vi.fn();
vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
  emit: (...args: unknown[]) => emitMock(...args),
}));

import { listenPetLinkBridge } from "./petLinkBridge";

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

// P2 3단계 후행 제안(docs/PLAN-2026-08-07-second-brain.md Q5) — "pet-accept-link-suggestion"을
// 받아 대상 노트 유무로 갈리는 브리지 동작(section_create_with_body vs pet_note_create)을 검증한다.
describe("listenPetLinkBridge", () => {
  beforeEach(() => {
    callMock.mockReset();
    callMock.mockResolvedValue({});
    listenMock.mockReset();
    listenMock.mockResolvedValue(vi.fn());
    emitMock.mockReset();
    emitMock.mockResolvedValue(undefined);
  });

  it("appends a section to the target note when target_note_id is set", async () => {
    listenPetLinkBridge();
    await flush();

    await fire("pet-accept-link-suggestion", {
      id: "s1",
      target_note_id: "note-b",
      title: "세종대왕",
      summary: "훈민정음 창제 요약",
      url: "https://example.com/sejong",
    });
    await flush();

    expect(callMock).toHaveBeenCalledWith("section_create_with_body", {
      note_id: "note-b",
      name: "세종대왕",
      body_md: "훈민정음 창제 요약\n\nhttps://example.com/sejong",
    });
    expect(callMock).not.toHaveBeenCalledWith("pet_note_create", expect.anything());
    expect(callMock).toHaveBeenCalledWith("suggestion_set_status", { id: "s1", status: "accepted" });
    expect(emitMock).toHaveBeenCalledWith("pet-suggestions-refresh");
  });

  it("creates a new inbox note when target_note_id is null", async () => {
    listenPetLinkBridge();
    await flush();

    await fire("pet-accept-link-suggestion", {
      id: "s2",
      target_note_id: null,
      title: "제목",
      summary: "요약",
      url: "https://example.com/article",
    });
    await flush();

    expect(callMock).toHaveBeenCalledWith("pet_note_create", {
      text: "요약\n\nhttps://example.com/article",
      title: "제목",
    });
    expect(callMock).not.toHaveBeenCalledWith("section_create_with_body", expect.anything());
    expect(callMock).toHaveBeenCalledWith("suggestion_set_status", { id: "s2", status: "accepted" });
  });

  it("still requests a refresh even if the append call fails", async () => {
    listenPetLinkBridge();
    await flush();
    callMock.mockRejectedValueOnce(new Error("note deleted"));

    await fire("pet-accept-link-suggestion", {
      id: "s3",
      target_note_id: "note-x",
      title: "t",
      summary: "s",
      url: "https://example.com",
    });
    await flush();

    expect(emitMock).toHaveBeenCalledWith("pet-suggestions-refresh");
    expect(callMock).not.toHaveBeenCalledWith("suggestion_set_status", expect.anything());
  });

  it("unregisters the listener on cleanup", async () => {
    const unlisten = vi.fn();
    listenMock.mockResolvedValue(unlisten);

    const cleanup = listenPetLinkBridge();
    await flush();
    cleanup();

    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});
