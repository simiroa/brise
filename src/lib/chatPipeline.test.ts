import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { runChatPipeline } from "./chatPipeline";
import { call, callSilent } from "./invoke";
import { applyChatSection } from "../plugins/pet/bridge/petChatSection";
import { useSettingsStore } from "../stores/settings";
import { t } from "../i18n/t";

vi.mock(import("./invoke"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    call: vi.fn(),
    callSilent: vi.fn(),
    emitNotice: vi.fn(),
  };
});

vi.mock("./chatMemoryExtractor", () => ({
  extractAndSaveChatMemory: vi.fn(),
}));

vi.mock("../plugins/pet/bridge/petChatSection", () => ({
  applyChatSection: vi.fn(),
}));

vi.mock("../plugins/pet/bridge/petChatHistory", () => ({
  rememberChatExtras: vi.fn(),
}));

describe("runChatPipeline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSettingsStore.setState({ collectChatRegister: false });
  });

  it("should successfully run the pipeline and return success result", async () => {
    (call as Mock).mockResolvedValueOnce({
      reply: "Hello there!",
      user_created_at: "2023-01-01T00:00:00Z",
      assistant_created_at: "2023-01-01T00:00:01Z",
    });

    const userItem = { role: "user" as const, text: "Hi", createdAt: "2023-01-01" };

    const result = await runChatPipeline({
      composed: "Hi",
      allowWrite: false,
      userItem,
      failText: "Failed",
      savedText: "Saved",
      isAborted: () => false,
      onNotice: vi.fn(),
    });

    expect(result.type).toBe("success");
    if (result.type === "success") {
      expect(result.assistantItem.text).toBe("Hello there!");
      expect(result.stampedUser.createdAt).toBe("2023-01-01T00:00:00Z");
    }
  });

  it("uses onCreateSection instead of pet_note_create when provided", async () => {
    (call as Mock).mockImplementation(async (cmd: string) => {
      if (cmd === "pet_chat") {
        return {
          reply: "saved",
          action: "create_section",
          section_title: "제목",
          section_body: "본문",
        };
      }
      throw new Error(`unexpected ${cmd}`);
    });

    const onCreateSection = vi.fn().mockResolvedValue(true);
    const userItem = { role: "user" as const, text: "memo", createdAt: "t" };

    const result = await runChatPipeline({
      composed: "memo",
      allowWrite: true,
      userItem,
      failText: "Failed",
      savedText: "Saved",
      isAborted: () => false,
      onNotice: vi.fn(),
      onCreateSection,
    });

    expect(onCreateSection).toHaveBeenCalledWith({ title: "제목", body: "본문" });
    expect((call as Mock).mock.calls.some((c) => c[0] === "pet_note_create")).toBe(false);
    expect(applyChatSection).not.toHaveBeenCalled();
    expect(result.type).toBe("success");
    if (result.type === "success") {
      expect(result.assistantItem.sectionInserted).toBe(true);
    }
  });

  describe("evidence cards (Rust RAG hits) — one pet_chat per turn", () => {
    const run = (composed: string, extra: Partial<Parameters<typeof runChatPipeline>[0]> = {}) =>
      runChatPipeline({
        composed,
        allowWrite: false,
        userItem: { role: "user" as const, text: composed, createdAt: "t" },
        failText: "Failed",
        savedText: "Saved",
        isAborted: () => false,
        onNotice: vi.fn(),
        ...extra,
      });
    const invokedCommands = () => [
      ...(call as Mock).mock.calls.map((c) => c[0]),
      ...(callSilent as Mock).mock.calls.map((c) => c[0]),
    ];

    it("sends exactly one pet_chat and no search_notes / synonym LLM call", async () => {
      (call as Mock).mockResolvedValueOnce({ reply: "그런 내용은 없었어요", hits: [] });

      const composed = "내가 프랑스 혁명 관련해서 뭐 적었지";
      const result = await run(composed);

      expect(result.type).toBe("success");
      const cmds = invokedCommands();
      expect(cmds.filter((c) => c === "pet_chat")).toHaveLength(1);
      expect(cmds).not.toContain("search_notes");
      expect(cmds).not.toContain("ai_generate_from_prompt");
      // 사용자 문장 그대로 — 예전 [참고할 노트 검색 결과] 블록을 더는 붙이지 않는다.
      const petChatCall = (call as Mock).mock.calls.find((c) => c[0] === "pet_chat");
      expect(petChatCall![1].message).toBe(composed);
    });

    it("passes show_evidence: true for a question-word message", async () => {
      (call as Mock).mockResolvedValueOnce({ reply: "찾아봤어요", hits: [] });
      await run("내가 프랑스 혁명 관련해서 뭐 적었지");
      const petChatCall = (call as Mock).mock.calls.find((c) => c[0] === "pet_chat");
      expect(petChatCall![1].show_evidence).toBe(true);
    });

    it.each(["안녕", "고마워"])("passes show_evidence: false for a plain greeting (%s)", async (composed) => {
      (call as Mock).mockResolvedValueOnce({ reply: "안녕하세요!", hits: [] });
      const result = await run(composed);
      const petChatCall = (call as Mock).mock.calls.find((c) => c[0] === "pet_chat");
      expect(petChatCall![1].show_evidence).toBe(false);
      expect(result.type).toBe("success");
    });

    it("passes show_evidence: false when the caller turns evidence off, even for a question", async () => {
      (call as Mock).mockResolvedValueOnce({ reply: "음", hits: [] });
      await run("뭐 적었지", { showEvidence: false });
      const petChatCall = (call as Mock).mock.calls.find((c) => c[0] === "pet_chat");
      expect(petChatCall![1].show_evidence).toBe(false);
    });

    it("builds the cards from res.hits", async () => {
      const hits = [{ note_id: "n1", title: "프랑스 혁명 정리", snippet: "1789년 여름 파리에서" }];
      (call as Mock).mockResolvedValueOnce({ reply: "정리해 두셨어요", action: "answer", hits });
      const result = await run("내가 프랑스 혁명 관련해서 뭐 적었지");
      expect(result.type).toBe("success");
      if (result.type === "success") {
        expect(result.assistantItem.hits).toEqual(hits);
      }
    });

    it("leaves hits undefined when res.hits is empty", async () => {
      (call as Mock).mockResolvedValueOnce({ reply: "없어요", action: "answer", hits: [] });
      const result = await run("뭐 적었지");
      if (result.type === "success") {
        expect(result.assistantItem.hits).toBeUndefined();
      }
    });
  });

  describe("add_collect_source", () => {
    const userItem = { role: "user" as const, text: "https://example.com/feed 등록해줘", createdAt: "t" };

    it("falls back to a guidance message and skips the IPC when chat write is off", async () => {
      useSettingsStore.setState({ collectChatRegister: true });
      (call as Mock).mockResolvedValueOnce({ reply: "등록할게요", action: "add_collect_source" });

      const result = await runChatPipeline({
        composed: userItem.text,
        allowWrite: false,
        userItem,
        failText: "Failed",
        savedText: "Saved",
        isAborted: () => false,
        onNotice: vi.fn(),
      });

      expect(callSilent as Mock).not.toHaveBeenCalled();
      expect(result.type).toBe("success");
      if (result.type === "success") {
        expect(result.assistantItem.text).toBe(t("search.chat_collect_register_disabled"));
      }
    });

    it("falls back to a guidance message and skips the IPC when collectChatRegister is off", async () => {
      useSettingsStore.setState({ collectChatRegister: false });
      (call as Mock).mockResolvedValueOnce({ reply: "등록할게요", action: "add_collect_source" });

      const result = await runChatPipeline({
        composed: userItem.text,
        allowWrite: true,
        userItem,
        failText: "Failed",
        savedText: "Saved",
        isAborted: () => false,
        onNotice: vi.fn(),
      });

      expect(callSilent as Mock).not.toHaveBeenCalled();
      expect(result.type).toBe("success");
      if (result.type === "success") {
        expect(result.assistantItem.text).toBe(t("search.chat_collect_register_disabled"));
      }
    });

    it("calls collect_source_add_nl with the raw user text when both gates are on", async () => {
      useSettingsStore.setState({ collectChatRegister: true });
      (call as Mock).mockResolvedValueOnce({ reply: "등록할게요", action: "add_collect_source" });
      (callSilent as Mock).mockResolvedValueOnce({ name: "Example Feed" });

      const result = await runChatPipeline({
        composed: userItem.text,
        allowWrite: true,
        userItem,
        failText: "Failed",
        savedText: "Saved",
        isAborted: () => false,
        onNotice: vi.fn(),
      });

      expect(callSilent as Mock).toHaveBeenCalledWith("collect_source_add_nl", { input: userItem.text });
      expect(result.type).toBe("success");
      if (result.type === "success") {
        expect(result.assistantItem.text).toBe(
          t("search.chat_collect_registered", { name: "Example Feed" }),
        );
      }
    });

    it("shows a failure message instead of a silent no-op when collect_source_add_nl rejects", async () => {
      useSettingsStore.setState({ collectChatRegister: true });
      (call as Mock).mockResolvedValueOnce({ reply: "등록할게요", action: "add_collect_source" });
      (callSilent as Mock).mockRejectedValueOnce({ message: "no URL found" });

      const result = await runChatPipeline({
        composed: userItem.text,
        allowWrite: true,
        userItem,
        failText: "Failed",
        savedText: "Saved",
        isAborted: () => false,
        onNotice: vi.fn(),
      });

      expect(result.type).toBe("success");
      if (result.type === "success") {
        expect(result.assistantItem.text).toBe(
          t("search.chat_collect_register_failed", { error: "no URL found" }),
        );
      }
    });

    it("runs the source immediately and reports the count for a local kind (claude_prompts)", async () => {
      useSettingsStore.setState({ collectChatRegister: true });
      const localUserItem = { role: "user" as const, text: "클로드 대화 가져와줘", createdAt: "t" };
      (call as Mock).mockResolvedValueOnce({ reply: "등록할게요", action: "add_collect_source" });
      (callSilent as Mock).mockImplementation(async (cmd: string) => {
        if (cmd === "collect_source_add_nl") {
          return { id: "src-1", name: "클로드 대화", kind: "claude_prompts" };
        }
        if (cmd === "collect_source_run_now") {
          return { ok: true, added: 3, error: null };
        }
        throw new Error(`unexpected ${cmd}`);
      });

      const result = await runChatPipeline({
        composed: localUserItem.text,
        allowWrite: true,
        userItem: localUserItem,
        failText: "Failed",
        savedText: "Saved",
        isAborted: () => false,
        onNotice: vi.fn(),
      });

      expect(callSilent as Mock).toHaveBeenCalledWith("collect_source_run_now", { id: "src-1" });
      expect(result.type).toBe("success");
      if (result.type === "success") {
        expect(result.assistantItem.text).toBe(
          t("search.chat_collect_registered_and_ran", { name: "클로드 대화", n: 3 }),
        );
      }
    });

    it("does not run-now for a non-local kind (rss)", async () => {
      useSettingsStore.setState({ collectChatRegister: true });
      (call as Mock).mockResolvedValueOnce({ reply: "등록할게요", action: "add_collect_source" });
      (callSilent as Mock).mockResolvedValueOnce({ id: "src-2", name: "Example Feed", kind: "rss" });

      const result = await runChatPipeline({
        composed: userItem.text,
        allowWrite: true,
        userItem,
        failText: "Failed",
        savedText: "Saved",
        isAborted: () => false,
        onNotice: vi.fn(),
      });

      expect(callSilent as Mock).not.toHaveBeenCalledWith("collect_source_run_now", expect.anything());
      expect(result.type).toBe("success");
      if (result.type === "success") {
        expect(result.assistantItem.text).toBe(
          t("search.chat_collect_registered", { name: "Example Feed" }),
        );
      }
    });

    it("falls back to the plain registered text when run-now fails", async () => {
      useSettingsStore.setState({ collectChatRegister: true });
      (call as Mock).mockResolvedValueOnce({ reply: "등록할게요", action: "add_collect_source" });
      (callSilent as Mock).mockImplementation(async (cmd: string) => {
        if (cmd === "collect_source_add_nl") {
          return { id: "src-3", name: "브라우저 기록", kind: "browser_history" };
        }
        if (cmd === "collect_source_run_now") {
          throw new Error("locked");
        }
        throw new Error(`unexpected ${cmd}`);
      });

      const result = await runChatPipeline({
        composed: "브라우저 기록 가져와줘",
        allowWrite: true,
        userItem: { role: "user" as const, text: "브라우저 기록 가져와줘", createdAt: "t" },
        failText: "Failed",
        savedText: "Saved",
        isAborted: () => false,
        onNotice: vi.fn(),
      });

      expect(result.type).toBe("success");
      if (result.type === "success") {
        expect(result.assistantItem.text).toBe(
          t("search.chat_collect_registered", { name: "브라우저 기록" }),
        );
      }
    });
  });
});
