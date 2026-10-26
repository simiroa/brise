import { describe, it, expect, vi, beforeEach } from "vitest";

const callMock = vi.fn();
vi.mock("../../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
}));

const appendMock = vi.fn();
const createInboxMock = vi.fn();
vi.mock("../../../lib/noteActions", () => ({
  appendSectionWithBody: (...args: unknown[]) => appendMock(...args),
  createInboxMemo: (...args: unknown[]) => createInboxMock(...args),
}));

const listenMock = vi.fn();
const emitMock = vi.fn();
vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
  emit: (...args: unknown[]) => emitMock(...args),
}));

import { listenPetClipboardBridge, routeClipboardText, clipCardPayload } from "./petClipboardBridge";

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

describe("routeClipboardText", () => {
  beforeEach(() => {
    callMock.mockReset();
    appendMock.mockReset();
    createInboxMock.mockReset();
    listenMock.mockReset();
    listenMock.mockResolvedValue(vi.fn());
  });

  it("빈 클립보드는 계획을 만들지 않는다", async () => {
    expect(await routeClipboardText("   \n ")).toBeNull();
    expect(callMock).not.toHaveBeenCalled();
  });

  it("단독 URL 은 link_preview 로 라우팅해 요약·대상 노트를 계획에 담는다", async () => {
    callMock.mockResolvedValue({
      ok: true,
      title: "세종",
      summary: "훈민정음 반포.",
      target_note_id: "n1",
      target_note_title: "한글 메모",
    });

    const plan = await routeClipboardText(" https://example.com/a ");

    expect(callMock).toHaveBeenCalledWith("link_preview", { url: "https://example.com/a" });
    expect(callMock).not.toHaveBeenCalledWith("search_notes", expect.anything()); // URL 경로는 유사 노트 검색을 타지 않는다
    expect(plan).toEqual({
      body: "훈민정음 반포.\n\nhttps://example.com/a",
      title: "세종",
      targetNoteId: "n1",
      targetTitle: "한글 메모",
      isLink: true,
    });
  });

  it("게이트 OFF(ok:false)면 라우팅 없이 URL 그대로 인박스 저장 계획으로 강등한다", async () => {
    callMock.mockResolvedValue({ ok: false, title: "", summary: "" });

    const plan = await routeClipboardText("https://example.com/a");

    expect(plan).toEqual({
      body: "https://example.com/a",
      targetNoteId: null,
      targetTitle: null,
      isLink: true,
    });
  });

  it("link_preview 가 던져도(오프라인 등) 같은 강등 경로를 탄다", async () => {
    callMock.mockRejectedValue(new Error("network"));
    const plan = await routeClipboardText("https://example.com/a");
    expect(plan?.targetNoteId).toBeNull();
    expect(plan?.body).toBe("https://example.com/a");
  });

  it("문장 속 링크는 URL 이 아니라 텍스트로 본다 — 외부 fetch 를 타지 않는다", async () => {
    callMock.mockResolvedValue({ results: [], degraded: true });

    const plan = await routeClipboardText("see https://example.com for more");

    expect(callMock).not.toHaveBeenCalledWith("link_preview", expect.anything());
    expect(callMock).toHaveBeenCalledWith("search_notes", {
      query: "see https://example.com for more",
    });
    expect(plan).toEqual({
      body: "see https://example.com for more",
      targetNoteId: null,
      targetTitle: null,
      isLink: false,
    });
  });

  it("텍스트는 유사 노트 1건을 병합 후보로 담고, 질의 길이를 잘라 보낸다", async () => {
    callMock.mockResolvedValue({ results: [{ id: "n9", title: "여행", snippet: "" }] });
    const long = "가".repeat(500);

    const plan = await routeClipboardText(long);

    expect((callMock.mock.calls[0][1] as { query: string }).query).toHaveLength(300);
    expect(plan).toMatchObject({ body: long, targetNoteId: "n9", targetTitle: "여행", isLink: false });
  });

  it("검색이 실패해도 저장은 막히지 않는다 — 대상 없는 계획으로 이어진다", async () => {
    callMock.mockRejectedValue(new Error("db"));
    const plan = await routeClipboardText("메모할 내용");
    expect(plan).toMatchObject({ body: "메모할 내용", targetNoteId: null, isLink: false });
  });
});

describe("clipCardPayload", () => {
  it("미리보기를 180자로 자르고 행선지를 그대로 싣는다", () => {
    const payload = clipCardPayload({
      body: "나".repeat(400),
      targetNoteId: "n1",
      targetTitle: "노트 A",
      isLink: false,
    });
    expect(payload.preview).toHaveLength(180);
    expect(payload).toMatchObject({ target_title: "노트 A", is_link: false });
  });
});

describe("listenPetClipboardBridge", () => {
  beforeEach(() => {
    callMock.mockReset();
    appendMock.mockReset();
    createInboxMock.mockReset();
    listenMock.mockReset();
    listenMock.mockResolvedValue(vi.fn());
    emitMock.mockReset();
    emitMock.mockResolvedValue(undefined);
  });

  it("저장 요청을 라우팅해 확인 카드만 띄운다 — 확인 전에는 아무것도 저장하지 않는다", async () => {
    callMock.mockImplementation((cmd: string) =>
      cmd === "search_notes"
        ? Promise.resolve({ results: [{ id: "n1", title: "노트 A", snippet: "" }] })
        : Promise.resolve({ ok: true }),
    );

    listenPetClipboardBridge();
    await flush();
    await fire("pet-clipboard-save", { text: "붙일 내용" });
    await flush();

    expect(appendMock).not.toHaveBeenCalled();
    expect(createInboxMock).not.toHaveBeenCalled();
    const clip = callMock.mock.calls.find((c) => c[0] === "pet_bubble_clip");
    expect(JSON.parse((clip?.[1] as { payload: string }).payload)).toEqual({
      preview: "붙일 내용",
      target_title: "노트 A",
      is_link: false,
    });
    // 카드 표시 성공 직후 펫 창에 task-done 신호를 쏜다.
    expect(emitMock).toHaveBeenCalledWith("pet-signal", { kind: "task-done" });
  });

  it("카드 표시가 실패하면 실패 신호를 쏜다", async () => {
    callMock.mockImplementation((cmd: string) =>
      cmd === "pet_bubble_clip" ? Promise.reject(new Error("no window")) : Promise.resolve({ results: [] }),
    );

    listenPetClipboardBridge();
    await flush();
    await fire("pet-clipboard-save", { text: "붙일 내용" });
    await flush();

    expect(emitMock).toHaveBeenCalledWith("pet-signal", { kind: "failure" });
  });

  it("append 를 고르면 제안된 노트에 섹션을 붙인다", async () => {
    callMock.mockImplementation((cmd: string) =>
      cmd === "search_notes"
        ? Promise.resolve({ results: [{ id: "n1", title: "노트 A", snippet: "" }] })
        : Promise.resolve({ ok: true }),
    );

    listenPetClipboardBridge();
    await flush();
    await fire("pet-clipboard-save", { text: "붙일 내용" });
    await flush();
    await fire("pet-clipboard-accept", { choice: "append" });
    await flush();

    expect(appendMock).toHaveBeenCalledWith("n1", undefined, "붙일 내용");
    expect(createInboxMock).not.toHaveBeenCalled();
    // 수락 처리 시작에 work-start, 저장 성공 뒤 success.
    expect(emitMock).toHaveBeenCalledWith("pet-signal", { kind: "work-start" });
    expect(emitMock).toHaveBeenCalledWith("pet-signal", { kind: "success" });
  });

  it("new 를 고르면 대상 노트가 있어도 인박스에 새 메모로 저장한다", async () => {
    callMock.mockImplementation((cmd: string) =>
      cmd === "search_notes"
        ? Promise.resolve({ results: [{ id: "n1", title: "노트 A", snippet: "" }] })
        : Promise.resolve({ ok: true }),
    );
    createInboxMock.mockResolvedValue({ note_id: "n2", title: "붙일 내용" });

    listenPetClipboardBridge();
    await flush();
    await fire("pet-clipboard-save", { text: "붙일 내용" });
    await flush();
    await fire("pet-clipboard-accept", { choice: "new" });
    await flush();

    expect(createInboxMock).toHaveBeenCalledWith("붙일 내용", undefined);
    expect(appendMock).not.toHaveBeenCalled();
  });

  it("한 번 수락한 계획은 소비된다 — 같은 확인이 두 번 와도 두 번 저장하지 않는다", async () => {
    callMock.mockImplementation((cmd: string) =>
      cmd === "search_notes" ? Promise.resolve({ results: [] }) : Promise.resolve({ ok: true }),
    );
    createInboxMock.mockResolvedValue({ note_id: "n2", title: "t" });

    listenPetClipboardBridge();
    await flush();
    await fire("pet-clipboard-save", { text: "한 번만" });
    await flush();
    await fire("pet-clipboard-accept", { choice: "new" });
    await flush();
    await fire("pet-clipboard-accept", { choice: "new" });
    await flush();

    expect(createInboxMock).toHaveBeenCalledTimes(1);
  });
});
