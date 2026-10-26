import { describe, it, expect, vi, beforeEach } from "vitest";

const call = vi.fn(async (_cmd: string, _args?: Record<string, unknown>): Promise<unknown> => ({
  id: "att-new",
}));
const callSilent = vi.fn(async (_cmd: string, _args?: Record<string, unknown>): Promise<unknown> => ({
  title: "Article Title",
  text: "extracted body",
}));
const emitNotice = vi.fn();
const reloadActive = vi.fn(async () => {});
const insertAiSection = vi.fn(async (_name: string, _body: string, _noteId: string) => ({ id: "sec-1" }));
let activeAttachments: Array<{ kind: string; url: string; id: string }> = [];

vi.mock("./invoke", () => ({
  call: (cmd: string, args?: Record<string, unknown>) => call(cmd, args),
  callSilent: (cmd: string, args?: Record<string, unknown>) => callSilent(cmd, args),
  emitNotice: (...a: unknown[]) => emitNotice(...a),
  registerFlush: vi.fn(() => () => {}),
  flushAll: vi.fn(async () => {}),
}));
// withSourceLine 은 실제 것을 쓴다(순수 함수) — 목으로 가리면 출처 한 줄이 붙는지 자체를
// 검증할 수 없다. insertAiSection 만 목이다.
vi.mock("./aiSectionBridge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./aiSectionBridge")>()),
  insertAiSection: (name: string, body: string, noteId: string) => insertAiSection(name, body, noteId),
}));
vi.mock("../stores/notes", () => ({
  useNotesStore: {
    getState: () => ({
      activeNote: { attachments: activeAttachments },
      reloadActive,
    }),
  },
}));

import { importLinkToSection, importLinksToSections } from "./linkImport";

const URL_ = "https://example.com/article";

describe("importLinkToSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    call.mockImplementation(async () => ({ id: "att-new" }));
    callSilent.mockImplementation(async () => ({ title: "Article Title", text: "extracted body" }));
    insertAiSection.mockImplementation(async () => ({ id: "sec-1" }));
    activeAttachments = [];
  });

  it("reuses an existing link attachment for the same URL instead of creating another", async () => {
    activeAttachments = [{ kind: "link", url: URL_, id: "att-existing" }];

    const sec = await importLinkToSection(URL_, "", "note-1", "raw");

    expect(sec).toBeTruthy();
    expect(call).not.toHaveBeenCalledWith("attachment_add_link", expect.anything());
    expect(reloadActive).not.toHaveBeenCalled(); // 새로 만든 첨부가 아니므로 재수화도 없다
  });

  it("returns false and notifies when the reader yields no text", async () => {
    callSilent.mockImplementation(async () => ({ title: "", text: "   " }));

    const sec = await importLinkToSection(URL_, "", "note-1", "raw");

    expect(sec).toBeNull();
    expect(insertAiSection).not.toHaveBeenCalled();
    expect(emitNotice).toHaveBeenCalled();
  });

  it("mode raw: creates the section from the extracted title/body with no AI origin", async () => {
    const sec = await importLinkToSection(URL_, "", "note-1", "raw");

    expect(sec).toBeTruthy();
    // 본문 = 추출한 원문 + 출처 한 줄(오너 2026-09-10). insertAiSection 인자가 3개뿐인 것도
    // 계약이다 — aiOrigin 을 넘기지 않으므로 모델이 안 만든 섹션에 AI 작성 점이 붙지 않는다.
    const [name, body, target] = insertAiSection.mock.calls[0];
    expect([name, target]).toEqual(["Article Title", "note-1"]);
    expect(body).toMatch(/^extracted body\n\n> [^\n:]+: \[Article Title\]/);
    expect(body).toContain(`(${URL_})`);
    // 새 링크 첨부를 만들었으면 첨부 스트립이 그것을 보도록 재수화한다 — 그리고 그 순서는
    // 섹션 삽입 **전**이어야 한다(삽입은 switchSection 까지 하므로 뒤에 오면 경합한다).
    expect(call).toHaveBeenCalledWith("attachment_add_link", expect.anything());
    expect(reloadActive).toHaveBeenCalled();
    expect(reloadActive.mock.invocationCallOrder[0]).toBeLessThan(
      insertAiSection.mock.invocationCallOrder[0],
    );
  });

  it("N개 배치: 못 읽은 링크는 성공으로 세지 않는다", async () => {
    const other = "https://example.com/second";
    // 첫 링크는 본문이 있고, 두 번째는 빈 추출(= 못 읽는 페이지).
    callSilent.mockImplementation(async (_cmd, args) =>
      (args as { id: string }).id === "att-2" ? { title: "", text: "" } : { title: "T1", text: "body1" },
    );
    call.mockImplementation(async (cmd, args) => {
      if (cmd !== "attachment_add_link") return {};
      return { id: (args as { url: string }).url === other ? "att-2" : "att-1" };
    });

    const created = await importLinksToSections([URL_, other], "note-1", "raw");

    expect(created).toHaveLength(1);
    expect(insertAiSection).toHaveBeenCalledTimes(1);
    // 두 링크 다 시도했다 — 하나가 실패해도 배치가 멈추지 않는다(runBatch 관례).
    expect(call.mock.calls.filter(([cmd]) => cmd === "attachment_add_link")).toHaveLength(2);
  });
});
