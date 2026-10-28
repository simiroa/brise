import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import { SidebarChat } from "./SidebarChat";
import { useNotesStore } from "../../stores/notes";
import { useAiPresetsStore } from "../../stores/aiPresets";
import { useSettingsStore } from "../../stores/settings";
import { builtinDefault } from "../../stores/aiPrompts";
import { PET_REVIEW_CHAT_PLAN_EVENT } from "../../plugins/pet/bridge/petChatPlan";
import { PET_CHAT_UPDATED_EVENT, resetChatExtrasCache } from "../../plugins/pet/bridge/petChatHistory";

const callMock = vi.fn();
const emitMock = vi.fn();
const emitNoticeMock = vi.fn();
const applyChatSectionMock = vi.fn().mockResolvedValue(true);
const listenHandlers: Record<string, (e: { payload?: unknown }) => void> = {};

vi.mock("../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  flushAll: vi.fn(),
  registerFlush: () => () => {},
  emitNotice: (...args: unknown[]) => emitNoticeMock(...args),
}));

vi.mock("../../plugins/pet/bridge/petChatSection", () => ({
  applyChatSection: (...args: unknown[]) => applyChatSectionMock(...args),
  PET_APPLY_CHAT_SECTION_EVENT: "pet-apply-chat-section",
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((event: string, handler: (e: { payload?: unknown }) => void) => {
    listenHandlers[event] = handler;
    return Promise.resolve(() => {});
  }),
  emit: (...args: unknown[]) => emitMock(...args),
}));

if (!Element.prototype.scrollTo) {
  Element.prototype.scrollTo = () => {};
}
if (!URL.createObjectURL) {
  URL.createObjectURL = () => "blob:test";
  URL.revokeObjectURL = () => {};
}

describe("SidebarChat", () => {
  beforeEach(() => {
    callMock.mockReset();
    emitMock.mockReset();
    emitNoticeMock.mockReset();
    applyChatSectionMock.mockReset();
    applyChatSectionMock.mockResolvedValue(true);
    resetChatExtrasCache();
    for (const key of Object.keys(listenHandlers)) delete listenHandlers[key];
    emitMock.mockResolvedValue(undefined);
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "pet_chat_history") return { messages: [] };
      if (cmd === "pet_session_list") return { sessions: [] };
      if (cmd === "pet_session_new") return { session_id: "s-live", messages: [] };
      if (cmd === "pet_chat") {
        return {
          reply: "found it",
          action: "search",
          hits: [{ note_id: "n1", title: "Alpha", snippet: "snippet" }],
        };
      }
      if (cmd === "pet_note_create") return { note_id: "n2", title: "Memo" };
      if (cmd === "search_notes") return { results: [], total: 0 };
      return {};
    });
    useNotesStore.setState({
      selectNote: vi.fn().mockResolvedValue(undefined),
      activeNote: null,
    } as never);
    useAiPresetsStore.setState({
      list: [builtinDefault("list")!, builtinDefault("ask_note")!, builtinDefault("fill_note")!],
      loaded: true,
    });
    useSettingsStore.setState({ chatWriteEnabled: true });
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it("loads history and shows empty hint", async () => {
    render(<SidebarChat />);
    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("pet_chat_history", {});
    });
    expect(screen.getByTestId("view-chat")).toBeTruthy();
    expect(screen.getByText(/Ask anything|메모해줘|Mémo/)).toBeTruthy();
  });

  it("sends via pet_chat and renders search tool card", async () => {
    render(<SidebarChat />);
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("pet_chat_history", {}));

    const input = screen.getByPlaceholderText(/Ask anything|무엇이든|Posez/);
    fireEvent.change(input, { target: { value: "find alpha" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith(
        "pet_chat",
        expect.objectContaining({ message: expect.stringMatching(/^find alpha/), allow_write: true }),
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId("chat-search-tool-card")).toBeTruthy();
      expect(screen.getByText("Alpha")).toBeTruthy();
    });
  });

  it("has no image attach button or hidden file picker", async () => {
    render(<SidebarChat />);
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("pet_chat_history", {}));
    expect(screen.queryByRole("button", { name: /^(Image|이미지)$/ })).toBeNull();
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });

  it("composer field is textarea plus stacked preset/send actions only", async () => {
    render(<SidebarChat />);
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("pet_chat_history", {}));
    const field = screen.getByTestId("chat-composer-field");
    const buttons = field.querySelectorAll("button");
    expect(buttons).toHaveLength(2);
    expect(buttons[0].getAttribute("data-testid")).toBe("chat-presets-btn");
    expect(buttons[1].getAttribute("aria-label")).toMatch(/Send|보내기|Envoyer/);
    expect(screen.queryByRole("button", { name: /Save content|내용저장|Enregistrer le contenu/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Save chat|대화저장|Enregistrer le dialogue/ })).toBeNull();
    expect(screen.getByTestId("chat-tools-btn")).toBeTruthy();
    expect(screen.getByTestId("chat-presets-btn")).toBeTruthy();
  });

  it("drops a File onto the chat panel as a pending thumb", async () => {
    render(<SidebarChat />);
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("pet_chat_history", {}));
    const file = new File(["hello body"], "note.txt", { type: "text/plain" });
    fireEvent.drop(screen.getByTestId("view-chat"), {
      dataTransfer: { files: [file], types: ["Files"] },
    });
    await waitFor(() => {
      expect(screen.getByTestId("chat-pending-attaches").textContent).toContain("note.txt");
    });
    fireEvent.click(screen.getByRole("button", { name: /Send|보내기|Envoyer/ }));
    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith(
        "pet_chat",
        expect.objectContaining({
          message: expect.stringContaining("[첨부: note.txt]"),
        }),
      );
    });
    expect(callMock).toHaveBeenCalledWith(
      "pet_chat",
      expect.objectContaining({ message: expect.stringContaining("hello body") }),
    );
  });

  it("drops an image File with empty MIME as a pending thumb", async () => {
    render(<SidebarChat />);
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("pet_chat_history", {}));
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "shot.png", { type: "" });
    fireEvent.drop(screen.getByTestId("view-chat"), {
      dataTransfer: { files: [file], types: ["Files"] },
    });
    await waitFor(() => {
      const pending = screen.getByTestId("chat-pending-attaches");
      expect(pending.querySelector("img")).toBeTruthy();
    });
  });

  it("saves memo via the virtual preset and pet_note_create", async () => {
    render(<SidebarChat />);
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("pet_chat_history", {}));

    fireEvent.click(screen.getByTestId("chat-presets-btn"));
    const save = screen.getByTestId("chat-preset-save_memo") as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    const input = screen.getByPlaceholderText(/Ask anything|무엇이든|Posez/);
    fireEvent.change(input, { target: { value: "quick note" } });
    fireEvent.click(screen.getByTestId("chat-preset-save_memo"));

    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("pet_note_create", { text: "quick note" });
    });
    expect(callMock.mock.calls.some((c) => c[0] === "pet_chat")).toBe(false);
    expect(screen.queryByText("quick note")).toBeNull();
    expect(emitNoticeMock).toHaveBeenCalled();
  });

  it("passes the active note excerpt on pet_chat", async () => {
    useNotesStore.setState({
      selectNote: vi.fn().mockResolvedValue(undefined),
      activeNote: {
        note: { id: "n-active", title: "현재 노트" },
        sections: [{ id: "s", name: "Overview", body_md: "<p>본문 앞부분</p>", position: 0, kind: "text" }],
      },
    } as never);
    render(<SidebarChat />);
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("pet_chat_history", {}));
    const input = screen.getByPlaceholderText(/Ask anything|무엇이든|Posez/);
    fireEvent.change(input, { target: { value: "이 노트 설명해줘" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith(
        "pet_chat",
        expect.objectContaining({
          message: "이 노트 설명해줘",
          active_note_id: "n-active",
          active_note_title: "현재 노트",
          active_note_excerpt: "본문 앞부분",
          allow_write: true,
        }),
      );
    });
  });

  it("renders a plan chip and emits the review event", async () => {
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "pet_chat_history") return { messages: [] };
      if (cmd === "pet_chat") {
        return {
          reply: "정리할까요?",
          action: "propose_plan",
          plan_kind: "prune_plan",
          plan_id: "plan-1",
          hits: [],
        };
      }
      return {};
    });
    render(<SidebarChat />);
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("pet_chat_history", {}));
    const input = screen.getByPlaceholderText(/Ask anything|무엇이든|Posez/);
    fireEvent.change(input, { target: { value: "정리해줘" } });
    fireEvent.keyDown(input, { key: "Enter" });
    const chip = await screen.findByTestId("chat-plan-chip");
    expect(chip.textContent).toMatch(/자세히 보기|See details|Voir le détail/);
    fireEvent.click(chip);
    expect(emitMock).toHaveBeenCalledWith(
      PET_REVIEW_CHAT_PLAN_EVENT,
      expect.objectContaining({ plan_kind: "prune_plan", instruction: "정리해줘" }),
    );
  });

  it("fills the composer with the preset prompt instead of sending immediately, selected for editing", async () => {
    render(<SidebarChat />);
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("pet_chat_history", {}));
    fireEvent.change(screen.getByTestId("chat-composer-textarea"), { target: { value: "draft" } });
    fireEvent.click(screen.getByTestId("chat-presets-btn"));
    fireEvent.click(screen.getByTestId("chat-preset-ask_note"));
    const textarea = screen.getByTestId("chat-composer-textarea") as HTMLTextAreaElement;
    expect(textarea.value).toBe(builtinDefault("ask_note")!.prompt);
    expect(callMock.mock.calls.some((c) => c[0] === "pet_chat")).toBe(false);
    expect(screen.queryByTestId("chat-preset-list")).toBeNull();
  });

  it("sends the unedited preset prompt tagged with the preset's display name", async () => {
    render(<SidebarChat />);
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("pet_chat_history", {}));
    fireEvent.click(screen.getByTestId("chat-presets-btn"));
    fireEvent.click(screen.getByTestId("chat-preset-ask_note"));
    fireEvent.keyDown(screen.getByTestId("chat-composer-textarea"), { key: "Enter" });
    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith(
        "pet_chat",
        expect.objectContaining({
          message: builtinDefault("ask_note")!.prompt,
          display_text: builtinDefault("ask_note")!.name,
        }),
      );
    });
    expect((screen.getByTestId("chat-composer-textarea") as HTMLTextAreaElement).value).toBe("");
  });

  it("saves the conversation via pet_conversation_save", async () => {
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "pet_chat_history") {
        return {
          messages: [
            { role: "user", text: "hello", created_at: "t1" },
            { role: "assistant", text: "hi", created_at: "t2" },
          ],
        };
      }
      if (cmd === "pet_conversation_save") return { note_id: "n3", title: "대화" };
      return {};
    });
    render(<SidebarChat />);
    await waitFor(() => expect(screen.getByText("hello")).toBeTruthy());
    fireEvent.click(screen.getByTestId("chat-tools-btn"));
    fireEvent.click(screen.getByTestId("chat-tool-save_session"));
    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("pet_conversation_save", {
        messages: [
          { role: "user", text: "hello", created_at: "t1" },
          { role: "assistant", text: "hi", created_at: "t2" },
        ],
      });
    });
  });

  it("archives the live session via pet_session_new after confirm", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "pet_chat_history") {
        return {
          messages: [
            { role: "user", text: "hello", created_at: "t1" },
            { role: "assistant", text: "hi", created_at: "t2" },
          ],
        };
      }
      if (cmd === "pet_session_list") return { sessions: [] };
      if (cmd === "pet_session_new") {
        return { session_id: "s-new", archived_id: "s-old", messages: [] };
      }
      return {};
    });
    render(<SidebarChat />);
    await waitFor(() => expect(screen.getByText("hello")).toBeTruthy());
    fireEvent.click(screen.getByTestId("chat-new-session"));
    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("pet_session_new", {});
    });
    expect(callMock.mock.calls.some((c) => c[0] === "pet_chat_clear")).toBe(false);
    expect(confirmSpy).toHaveBeenCalledWith(
      expect.stringMatching(/보관하고 새로|Archive this conversation|Archiver cette conversation/),
    );
    expect(screen.queryByText("hello")).toBeNull();
    expect(screen.queryByText("hi")).toBeNull();
    confirmSpy.mockRestore();
  });

  it("does not confirm or call pet_session_new when the conversation is empty", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<SidebarChat />);
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("pet_chat_history", {}));
    const btn = screen.getByTestId("chat-new-session") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(callMock.mock.calls.some((c) => c[0] === "pet_session_new")).toBe(false);
    confirmSpy.mockRestore();
  });

  it("loads pet_session_list when session history opens", async () => {
    render(<SidebarChat />);
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("pet_chat_history", {}));
    expect(callMock.mock.calls.some((c) => c[0] === "pet_session_list")).toBe(false);
    fireEvent.click(screen.getByTestId("chat-history-btn"));
    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("pet_session_list", {});
    });
  });

  it("opens a closed session and renders its messages", async () => {
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "pet_chat_history") {
        return { messages: [{ role: "user", text: "live now", created_at: "t1" }] };
      }
      if (cmd === "pet_session_list") {
        return {
          sessions: [
            {
              id: "s-live",
              title: "live now",
              live: true,
              created_at: "2026-08-13T00:00:00Z",
              message_count: 1,
              preview: "live now",
            },
            {
              id: "s-old",
              title: "old chat",
              live: false,
              created_at: "2026-08-12T00:00:00Z",
              closed_at: "2026-08-12T01:00:00Z",
              message_count: 2,
              preview: "archived preview",
            },
          ],
        };
      }
      if (cmd === "pet_session_open") {
        return {
          session_id: "s-old",
          messages: [
            { role: "user", text: "old hello", created_at: "o1" },
            { role: "assistant", text: "old hi", created_at: "o2" },
          ],
        };
      }
      return {};
    });
    render(<SidebarChat />);
    await waitFor(() => expect(screen.getByText("live now")).toBeTruthy());
    fireEvent.click(screen.getByTestId("chat-history-btn"));
    await waitFor(() => expect(screen.getByTestId("chat-session-s-old")).toBeTruthy());
    expect(screen.getByTestId("chat-session-s-live").textContent).toMatch(/Live|진행 중|En cours/);
    expect(screen.getByTestId("chat-session-s-old").textContent).toContain("archived preview");
    fireEvent.click(screen.getByTestId("chat-session-s-old"));
    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("pet_session_open", { session_id: "s-old" });
      expect(screen.getByText("old hello")).toBeTruthy();
      expect(screen.getByText("old hi")).toBeTruthy();
    });
    expect(screen.queryByText("live now")).toBeNull();
  });

  it("stacks the preset icon above send inside the field and overlays the list upward", async () => {
    render(<SidebarChat />);
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("pet_chat_history", {}));
    const presets = screen.getByTestId("chat-presets-btn");
    const field = screen.getByTestId("chat-composer-field");
    const send = field.querySelector('button[aria-label*="보내기"], button[aria-label*="Send"], button[aria-label*="Envoyer"]');
    expect(field.contains(presets)).toBe(true);
    expect(presets.compareDocumentPosition(send!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(presets);
    // 컨테이너 testid 가 빌트인 프리셋 id `list` (`chat-preset-list`) 와 겹친다.
    const list = document.querySelector(".pet-chat__presets") as HTMLElement;
    expect(list?.classList.contains("pet-chat__presets--overlay")).toBe(true);
    expect(list.compareDocumentPosition(presets) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("rewinds a persisted user bubble into the composer", async () => {
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "pet_chat_history") {
        return {
          messages: [
            { role: "user", text: "first", created_at: "t1" },
            { role: "assistant", text: "ok", created_at: "t2" },
            { role: "user", text: "second", created_at: "t3" },
            { role: "assistant", text: "later", created_at: "t4" },
          ],
        };
      }
      if (cmd === "pet_chat_rewind") {
        return {
          truncated: 2,
          messages: [
            { role: "user", text: "first", created_at: "t1" },
            { role: "assistant", text: "ok", created_at: "t2" },
          ],
        };
      }
      return {};
    });
    render(<SidebarChat />);
    await waitFor(() => expect(screen.getByText("second")).toBeTruthy());
    fireEvent.click(screen.getByText("second"));
    fireEvent.click(screen.getByRole("button", { name: /Rewind|리와인드|Rembobiner/ }));
    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("pet_chat_rewind", { created_at: "t3" });
    });
    expect(screen.queryByText("later")).toBeNull();
    expect((screen.getByTestId("chat-composer-textarea") as HTMLTextAreaElement).value).toBe("second");
  });

  it("deletes a persisted turn pair", async () => {
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "pet_chat_history") {
        return {
          messages: [
            { role: "user", text: "keep", created_at: "t1" },
            { role: "assistant", text: "keep-a", created_at: "t2" },
            { role: "user", text: "drop", created_at: "t3" },
            { role: "assistant", text: "drop-a", created_at: "t4" },
          ],
        };
      }
      if (cmd === "pet_chat_delete") {
        return {
          deleted: 2,
          messages: [
            { role: "user", text: "keep", created_at: "t1" },
            { role: "assistant", text: "keep-a", created_at: "t2" },
          ],
        };
      }
      return {};
    });
    render(<SidebarChat />);
    await waitFor(() => expect(screen.getByText("drop")).toBeTruthy());
    fireEvent.click(screen.getByText("drop"));
    fireEvent.click(screen.getByRole("button", { name: /Delete|삭제|Supprimer/ }));
    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("pet_chat_delete", { created_at: "t3", role: "user" });
    });
    expect(screen.queryByText("drop-a")).toBeNull();
    expect(screen.getByText("keep")).toBeTruthy();
  });

  it("keeps search and plan extras after send and remount when timestamps differ", async () => {
    let history: { messages: { role: string; text: string; created_at: string }[] } = { messages: [] };
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "pet_chat_history") return history;
      if (cmd === "pet_chat") {
        history = {
          messages: [
            { role: "user", text: "정리해줘", created_at: "2026-08-13T00:00:00.100Z" },
            { role: "assistant", text: "정리할까요?", created_at: "2026-08-13T00:00:00.101Z" },
          ],
        };
        return {
          reply: "정리할까요?",
          action: "propose_plan",
          plan_kind: "prune_plan",
          plan_id: "plan-1",
          hits: [{ note_id: "n1", title: "Alpha", snippet: "snippet" }],
          user_created_at: "2026-08-13T00:00:00.100Z",
          assistant_created_at: "2026-08-13T00:00:00.101Z",
        };
      }
      return {};
    });
    const { unmount } = render(<SidebarChat />);
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("pet_chat_history", {}));
    const input = screen.getByPlaceholderText(/Ask anything|무엇이든|Posez/);
    fireEvent.change(input, { target: { value: "정리해줘" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      expect(screen.getByTestId("chat-plan-chip")).toBeTruthy();
      expect(screen.getByTestId("chat-search-tool-card")).toBeTruthy();
      expect(screen.getByText("Alpha")).toBeTruthy();
    });
    expect(callMock.mock.calls.filter((c) => c[0] === "pet_chat_history")).toHaveLength(1);
    unmount();
    render(<SidebarChat />);
    await waitFor(() => {
      expect(screen.getByTestId("chat-plan-chip")).toBeTruthy();
      expect(screen.getByTestId("chat-search-tool-card")).toBeTruthy();
      expect(screen.getByText("Alpha")).toBeTruthy();
    });
  });

  it("reloads history on pet-chat-updated when not pending", async () => {
    render(<SidebarChat />);
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("pet_chat_history", {}));
    await waitFor(() => expect(listenHandlers[PET_CHAT_UPDATED_EVENT]).toBeTruthy());
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "pet_chat_history") {
        return { messages: [{ role: "user", text: "from pet", created_at: "t9" }] };
      }
      return {};
    });
    listenHandlers[PET_CHAT_UPDATED_EVENT]({ payload: { reason: "append" } });
    await waitFor(() => {
      expect(screen.getByText("from pet")).toBeTruthy();
    });
  });

  it("ignores pet-chat-updated while a send is pending", async () => {
    let resolveChat: ((value: unknown) => void) | undefined;
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "pet_chat_history") return Promise.resolve({ messages: [] });
      if (cmd === "pet_chat") {
        return new Promise((resolve) => {
          resolveChat = resolve;
        });
      }
      return Promise.resolve({});
    });
    render(<SidebarChat />);
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("pet_chat_history", {}));
    await waitFor(() => expect(listenHandlers[PET_CHAT_UPDATED_EVENT]).toBeTruthy());
    const input = screen.getByPlaceholderText(/Ask anything|무엇이든|Posez/);
    fireEvent.change(input, { target: { value: "hi" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(callMock.mock.calls.some((c) => c[0] === "pet_chat")).toBe(true));
    const histBefore = callMock.mock.calls.filter((c) => c[0] === "pet_chat_history").length;
    listenHandlers[PET_CHAT_UPDATED_EVENT]({ payload: { reason: "append" } });
    expect(callMock.mock.calls.filter((c) => c[0] === "pet_chat_history")).toHaveLength(histBefore);
    resolveChat?.({
      reply: "ok",
      action: "answer",
      hits: [],
      user_created_at: "u",
      assistant_created_at: "a",
    });
    await waitFor(() => expect(screen.getByText("ok")).toBeTruthy());
  });

  it("drops the late reply when another surface starts a new session while pending", async () => {
    let resolveChat: ((value: unknown) => void) | undefined;
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "pet_chat_history") return Promise.resolve({ messages: [] });
      if (cmd === "pet_chat") {
        return new Promise((resolve) => {
          resolveChat = resolve;
        });
      }
      return Promise.resolve({});
    });
    render(<SidebarChat />);
    await waitFor(() => expect(listenHandlers[PET_CHAT_UPDATED_EVENT]).toBeTruthy());
    const input = screen.getByPlaceholderText(/Ask anything|무엇이든|Posez/);
    fireEvent.change(input, { target: { value: "old turn" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(callMock.mock.calls.some((c) => c[0] === "pet_chat")).toBe(true));
    const histBefore = callMock.mock.calls.filter((c) => c[0] === "pet_chat_history").length;
    // 트레이/펫 "새 세션 열기" — 새 라이브(빈 세션)를 다시 읽는다.
    listenHandlers[PET_CHAT_UPDATED_EVENT]({ payload: { reason: "session" } });
    await waitFor(() =>
      expect(callMock.mock.calls.filter((c) => c[0] === "pet_chat_history").length).toBe(histBefore + 1),
    );
    await waitFor(() => expect(screen.queryByText("old turn")).toBeNull());
    // 늦은 답은 Rust 가 시작 세션에 저장했다 — 새 세션 화면에 붙지 않는다.
    resolveChat?.({ reply: "late", action: "answer", hits: [], user_created_at: "u", assistant_created_at: "a" });
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText("late")).toBeNull();
  });

  it("shows the bracketed preset name in the user bubble, reveals the full prompt on click, and keeps it for rewind", async () => {
    const preset = builtinDefault("ask_note")!;
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "pet_chat_history") return { messages: [] };
      if (cmd === "pet_chat") {
        return {
          reply: "설명할게요",
          action: "answer",
          hits: [],
          user_created_at: "t1",
          assistant_created_at: "t2",
        };
      }
      if (cmd === "pet_chat_rewind") return { truncated: 2, messages: [] };
      return {};
    });
    render(<SidebarChat />);
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("pet_chat_history", {}));
    fireEvent.click(screen.getByTestId("chat-presets-btn"));
    fireEvent.click(screen.getByTestId("chat-preset-ask_note"));
    // Filled into the composer, not sent yet — send the unedited prompt as-is.
    fireEvent.keyDown(screen.getByTestId("chat-composer-textarea"), { key: "Enter" });
    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith(
        "pet_chat",
        expect.objectContaining({ message: preset.prompt, display_text: preset.name }),
      );
    });
    const reveal = screen.getByTestId("chat-preset-reveal");
    expect(reveal.textContent).toBe(`[${preset.name}]`);
    expect(screen.queryByText(preset.prompt)).toBeNull();

    fireEvent.click(reveal);
    expect(screen.getByTestId("chat-preset-reveal").textContent).toBe(preset.prompt);
    fireEvent.click(screen.getByTestId("chat-preset-reveal"));
    expect(screen.getByTestId("chat-preset-reveal").textContent).toBe(`[${preset.name}]`);

    // Clicking the reveal label toggles the body instead of selecting the bubble — select via the
    // bubble container itself to reach the rewind toolbar.
    fireEvent.click(document.querySelector("[data-chat-bubble]")!);
    fireEvent.click(screen.getByRole("button", { name: /Rewind|리와인드|Rembobiner/ }));
    await waitFor(() => {
      expect((screen.getByTestId("chat-composer-textarea") as HTMLTextAreaElement).value).toBe(
        preset.prompt,
      );
    });
  });

  it("a failed send shows the server-recorded failure once, without a second user row", async () => {
    let history: { messages: { role: string; text: string; created_at: string; meta?: string }[] } = {
      messages: [],
    };
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "pet_chat_history") return history;
      if (cmd === "pet_chat") {
        // Rust 가 턴 시작 때 user 행을, 실패 시 fail_text 로 실패 행을 시작 세션에 남긴 뒤 거절한다.
        history = {
          messages: [
            { role: "user", text: "hello", created_at: "u1" },
            {
              role: "assistant",
              text: "잘 안 됐어요. 잠시 뒤 다시 시도해 주세요.",
              created_at: "a1",
              meta: JSON.stringify({ failed: true }),
            },
          ],
        };
        throw { code: "IO", message: "down" };
      }
      return {};
    });
    render(<SidebarChat />);
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("pet_chat_history", {}));
    const input = screen.getByPlaceholderText(/Ask anything|무엇이든|Posez/);
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      expect(document.querySelector('[data-failed="true"]')).toBeTruthy();
    });
    expect(callMock).toHaveBeenCalledWith(
      "pet_chat",
      expect.objectContaining({
        message: "hello",
        fail_text: expect.stringMatching(/Try again|잘 안 됐어요|Réessayez/i),
      }),
    );
    expect(callMock.mock.calls.some(([cmd]) => cmd === "pet_chat_record_failure")).toBe(false);
    expect(document.querySelectorAll("[data-chat-bubble]").length).toBe(2);
  });

  it("stop waiting clears pending and ignores late setItems from that send", async () => {
    let resolveChat: ((value: unknown) => void) | undefined;
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "pet_chat_history") return Promise.resolve({ messages: [] });
      if (cmd === "pet_chat") {
        return new Promise((resolve) => {
          resolveChat = resolve;
        });
      }
      return Promise.resolve({});
    });
    render(<SidebarChat />);
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("pet_chat_history", {}));
    await waitFor(() => expect(listenHandlers[PET_CHAT_UPDATED_EVENT]).toBeTruthy());
    const input = screen.getByPlaceholderText(/Ask anything|무엇이든|Posez/);
    fireEvent.change(input, { target: { value: "hi" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.getByTestId("chat-stop-wait")).toBeTruthy());
    fireEvent.click(screen.getByTestId("chat-stop-wait"));
    expect(screen.queryByTestId("chat-stop-wait")).toBeNull();
    await act(async () => {
      resolveChat?.({
        reply: "late",
        action: "answer",
        hits: [],
        user_created_at: "u",
        assistant_created_at: "a",
      });
    });
    expect(screen.queryByText("late")).toBeNull();
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "pet_chat_history") {
        return {
          messages: [
            { role: "user", text: "hi", created_at: "u" },
            { role: "assistant", text: "late", created_at: "a" },
          ],
        };
      }
      return {};
    });
    listenHandlers[PET_CHAT_UPDATED_EVENT]({ payload: { reason: "append" } });
    await waitFor(() => {
      expect(screen.getByText("late")).toBeTruthy();
    });
  });

  it("restores a plan chip from history meta", async () => {
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "pet_chat_history") {
        return {
          messages: [
            { role: "user", text: "정리해줘", created_at: "t1" },
            {
              role: "assistant",
              text: "정리할까요?",
              created_at: "t2",
              meta: JSON.stringify({ plan_kind: "prune_plan", plan_id: "plan-9" }),
            },
          ],
        };
      }
      return {};
    });
    render(<SidebarChat />);
    const chip = await screen.findByTestId("chat-plan-chip");
    expect(chip.textContent).toMatch(/자세히 보기|See details|Voir le détail/);
  });

  it("copies bubble text", async () => {
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "pet_chat_history") {
        return { messages: [{ role: "user", text: "copy me", created_at: "t1" }] };
      }
      return {};
    });
    render(<SidebarChat />);
    await waitFor(() => expect(screen.getByText("copy me")).toBeTruthy());
    fireEvent.click(screen.getByText("copy me"));
    fireEvent.click(screen.getByRole("button", { name: /Copy|복사|Copier/ }));
    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith("copy me");
    });
  });

  it("top bar: tools · new session · history · settings · labelled edit switch (side-chat 2026-10-16)", async () => {
    render(<SidebarChat />);
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("pet_chat_history", {}));
    expect(screen.getByTestId("chat-tools-btn")).toBeTruthy();
    expect(screen.getByTestId("chat-new-session").getAttribute("aria-label")).toMatch(
      /새 세션|New session|Nouvelle session/,
    );
    expect(screen.getByTestId("chat-history-btn")).toBeTruthy();
    fireEvent.click(screen.getByTestId("chat-settings-btn"));
    expect(callMock).toHaveBeenCalledWith("settings_window_open", { page: "ai_chat" });
    const toggle = screen.getByTestId("chat-write-toggle");
    expect(toggle.getAttribute("role")).toBe("switch");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText(/편집 허용|Allow edits|Autoriser les modifs/)).toBeTruthy();
    fireEvent.click(toggle);
    expect(screen.getByTestId("chat-write-toggle").getAttribute("aria-checked")).toBe("false");
    // 도구 메뉴는 포털(document.body)로 뜬다 — 사이드바 overflow 에 잘리지 않게.
    fireEvent.click(screen.getByTestId("chat-tools-btn"));
    const menu = screen.getByTestId("chat-tools-list");
    expect(menu.parentElement).toBe(document.body);
    expect(screen.queryByTestId("chat-tool-clear_session")).toBeNull();
  });

  describe("기억 추출(도구 메뉴)", () => {
    const mockHistory = (generate: () => Promise<unknown>) => {
      useSettingsStore.setState({ aiEnabled: true } as never);
      callMock.mockImplementation(async (cmd: string) => {
        if (cmd === "pet_chat_history") {
          return {
            messages: [
              { role: "user", text: "나는 디자이너야", created_at: "t1" },
              { role: "assistant", text: "반가워요", created_at: "t2" },
            ],
          };
        }
        if (cmd === "settings_get_all") return { settings: {} };
        if (cmd === "ai_generate_from_prompt") return generate();
        return {};
      });
    };
    const runExtract = async () => {
      render(<SidebarChat />);
      await waitFor(() => expect(screen.getByText("나는 디자이너야")).toBeTruthy());
      fireEvent.click(screen.getByTestId("chat-tools-btn"));
      fireEvent.click(screen.getByTestId("chat-tool-extract_memory"));
      await waitFor(() => expect(callMock).toHaveBeenCalledWith("ai_generate_from_prompt", expect.anything()));
      // 요청이 끝나고 상태가 정리될 때까지 흘려보낸다.
      await act(async () => {
        await new Promise((r) => setTimeout(r, 30));
      });
    };

    it("모델 호출이 실패하면 모달을 열지 않는다 — '후보 없음' 으로 보이면 안 된다", async () => {
      mockHistory(async () => {
        throw new Error("403 forbidden");
      });
      await runExtract();
      expect(screen.queryByTestId("chat-memory-extract-modal")).toBeNull();
    });

    it("성공했지만 후보가 없으면 '후보 없음' 모달을 연다", async () => {
      mockHistory(async () => ({ generated: "[]" }));
      await runExtract();
      expect(await screen.findByTestId("chat-memory-extract-empty")).toBeTruthy();
    });

    it("후보가 있으면 체크 목록 모달을 연다", async () => {
      mockHistory(async () => ({ generated: '["사용자는 디자이너다"]' }));
      await runExtract();
      expect(await screen.findByTestId("chat-memory-extract-item-0")).toBeTruthy();
    });
  });

  it("persona dropdown: reuses pet_persona keys, custom deep-links to settings", async () => {
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "settings_get_all") {
        return { settings: { pet_persona_preset: "friend", pet_persona_prompt: "keep me" } };
      }
      if (cmd === "pet_chat_history") return { messages: [] };
      return {};
    });
    render(<SidebarChat />);
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("settings_get_all"));
    fireEvent.click(screen.getByTestId("chat-persona-btn"));
    const menu = screen.getByTestId("chat-persona-list");
    expect(menu.parentElement).toBe(document.body);
    await waitFor(() =>
      expect(screen.getByTestId("chat-persona-friend").getAttribute("aria-checked")).toBe("true"),
    );
    fireEvent.click(screen.getByTestId("chat-persona-secretary"));
    expect(callMock).toHaveBeenCalledWith("settings_set", {
      entries: { pet_persona_preset: "secretary", pet_persona_prompt: "keep me" },
    });
    fireEvent.click(screen.getByTestId("chat-persona-btn"));
    fireEvent.click(screen.getByTestId("chat-persona-custom"));
    expect(callMock).toHaveBeenCalledWith("settings_window_open", { page: "ai_chat" });
  });

  it("session history shows 3 recent and opens the full list modal via more", async () => {
    const sessions = [1, 2, 3, 4, 5].map((n) => ({
      id: `s${n}`,
      title: `chat ${n}`,
      live: n === 1,
      created_at: "2026-08-12T00:00:00Z",
      message_count: 1,
      preview: `p${n}`,
    }));
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "pet_chat_history") return { messages: [] };
      if (cmd === "pet_session_list") return { sessions };
      return {};
    });
    render(<SidebarChat />);
    fireEvent.click(screen.getByTestId("chat-history-btn"));
    await waitFor(() => expect(screen.getByTestId("chat-session-s3")).toBeTruthy());
    expect(screen.queryByTestId("chat-session-s4")).toBeNull();
    fireEvent.click(screen.getByTestId("chat-history-more"));
    const all = await screen.findByTestId("chat-history-all");
    expect(all.querySelectorAll("[data-testid^='chat-session-']").length).toBe(5);
  });

  it("passes allow_write false after the write toggle is off", async () => {
    render(<SidebarChat />);
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("pet_chat_history", {}));
    fireEvent.click(screen.getByTestId("chat-write-toggle"));
    expect(useSettingsStore.getState().chatWriteEnabled).toBe(false);
    const input = screen.getByPlaceholderText(/Ask anything|무엇이든|Posez/);
    fireEvent.change(input, { target: { value: "find alpha" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith(
        "pet_chat",
        expect.objectContaining({ allow_write: false }),
      );
    });
  });

  it("inserts a create_section reply into the active note", async () => {
    useNotesStore.setState({
      selectNote: vi.fn().mockResolvedValue(undefined),
      activeNote: {
        note: { id: "n-active", title: "현재 노트" },
        sections: [{ id: "s", name: "Overview", body_md: "old", position: 0, kind: "text" }],
      },
    } as never);
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "pet_chat_history") return { messages: [] };
      if (cmd === "pet_chat") {
        return {
          reply: "요청을 구체화했습니다.",
          action: "create_section",
          section_title: "업무일지 템플릿",
          section_body: "# 템플릿\n- 날짜",
          hits: [],
        };
      }
      return {};
    });
    render(<SidebarChat />);
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("pet_chat_history", {}));
    fireEvent.change(screen.getByTestId("chat-composer-textarea"), {
      target: { value: "100줄짜리 템플릿으로 만들어줘" },
    });
    fireEvent.keyDown(screen.getByTestId("chat-composer-textarea"), { key: "Enter" });
    await waitFor(() => {
      expect(applyChatSectionMock).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "업무일지 템플릿",
          body: "# 템플릿\n- 날짜",
          note_id: "n-active",
        }),
      );
    });
    expect(screen.getByText("요청을 구체화했습니다.")).toBeTruthy();
  });
});
