import { describe, it, expect, vi, beforeEach } from "vitest";
import { applyChatSection } from "./petChatSection";
import { useNotesStore } from "../../../stores/notes";

const insertAiSection = vi.fn();
const emitNotice = vi.fn();

vi.mock("../../../lib/aiSectionBridge", () => ({
  insertAiSection: (...args: unknown[]) => insertAiSection(...args),
}));

vi.mock("../../../lib/invoke", () => ({
  call: vi.fn(),
  callSilent: vi.fn(),
  flushAll: vi.fn(),
  registerFlush: () => () => {},
  emitNotice: (...args: unknown[]) => emitNotice(...args),
}));

describe("applyChatSection", () => {
  beforeEach(() => {
    insertAiSection.mockReset();
    emitNotice.mockReset();
    insertAiSection.mockResolvedValue({ id: "s1" });
    useNotesStore.setState({
      activeNote: { note: { id: "n1", title: "Open" } },
    } as never);
  });

  it("inserts a new section on the open note", async () => {
    await expect(
      applyChatSection({ title: "템플릿", body: "# 템플릿\n- 날짜" }),
    ).resolves.toBe(true);
    // No BUILTIN_DEFS id fits "펫/사이드바 비서" chat itself, so the raw secretary write is not
    // tagged with an ai_origin (W5) — undefined is forwarded, not a made-up id.
    expect(insertAiSection).toHaveBeenCalledWith("템플릿", "# 템플릿\n- 날짜", "n1", undefined, {
      aiOrigin: undefined,
    });
    expect(emitNotice).toHaveBeenCalled();
  });

  it("uses the first heading when title is missing", async () => {
    await applyChatSection({ body: "# 업무일지\n\n내용" });
    expect(insertAiSection).toHaveBeenCalledWith("업무일지", "# 업무일지\n\n내용", "n1", undefined, {
      aiOrigin: undefined,
    });
  });

  it("W5: forwards an explicit aiOrigin through to insertAiSection (generateAndInsertFillSection's fill_note tag)", async () => {
    await applyChatSection({ title: "초안", body: "# 초안\n내용", aiOrigin: "fill_note" });
    expect(insertAiSection).toHaveBeenCalledWith("초안", "# 초안\n내용", "n1", undefined, {
      aiOrigin: "fill_note",
    });
  });

  it("does not insert when no note is open", async () => {
    useNotesStore.setState({ activeNote: null } as never);
    await expect(applyChatSection({ body: "x" })).resolves.toBe(false);
    expect(insertAiSection).not.toHaveBeenCalled();
  });
});
