import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MobileChatView } from "./MobileChatView";
import { useNotesStore } from "../stores/notes";
import { useAiPresetsStore } from "../stores/aiPresets";
import { useSettingsStore } from "../stores/settings";
import { builtinDefault } from "../stores/aiPrompts";
import { resetChatExtrasCache } from "../plugins/pet/bridge/petChatHistory";

const callMock = vi.fn();
const reportFallbackMock = vi.fn();

vi.mock("../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  flushAll: vi.fn(),
  registerFlush: () => () => {},
  emitNotice: vi.fn(),
}));

vi.mock("../lib/diag", async (orig) => ({
  ...(await orig<typeof import("../lib/diag")>()),
  reportFallback: (...args: unknown[]) => reportFallbackMock(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn().mockResolvedValue(undefined),
}));

if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
if (!URL.createObjectURL) {
  URL.createObjectURL = () => "blob:test";
  URL.revokeObjectURL = () => {};
}

const PROVIDER_429 = {
  code: "IO",
  message: "Gemini request failed with status 429 Too Many Requests (retryable): quota exceeded",
};

describe("MobileChatView", () => {
  let chatShouldFail = true;

  beforeEach(() => {
    chatShouldFail = true;
    callMock.mockReset();
    reportFallbackMock.mockReset();
    resetChatExtrasCache();
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "pet_chat_history") return { messages: [] };
      if (cmd === "pet_session_list") return { sessions: [] };
      if (cmd === "pet_chat_rewind") return { truncated: 2, messages: [] };
      if (cmd === "pet_chat") {
        if (chatShouldFail) throw PROVIDER_429;
        return { reply: "hello back", action: "answer", hits: [] };
      }
      return {};
    });
    useNotesStore.setState({ selectNote: vi.fn().mockResolvedValue(undefined), activeNote: null } as never);
    useAiPresetsStore.setState({ list: [builtinDefault("list")!], loaded: true });
    useSettingsStore.setState({ chatWriteEnabled: true });
  });

  it("hosts the shared SidebarChat inside the phone container", async () => {
    render(<MobileChatView onOpenNote={vi.fn()} />);
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("pet_chat_history", {}));
    const host = screen.getByTestId("mobile-chat");
    expect(host.querySelector('[data-testid="view-chat"]')).toBeTruthy();
  });

  it("a provider 429 shows a categorized inline error, is recorded to diag, and Retry resends", async () => {
    render(<MobileChatView onOpenNote={vi.fn()} />);
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("pet_chat_history", {}));

    const input = screen.getByPlaceholderText(/Ask anything|무엇이든|Posez/);
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.keyDown(input, { key: "Enter" });

    const row = await screen.findByTestId("chat-failure");
    expect(row.getAttribute("data-kind")).toBe("quota");
    expect(row.textContent).toMatch(/429/);
    expect(reportFallbackMock).toHaveBeenCalledWith(
      "chat",
      "send_failed_quota",
      expect.stringContaining("429"),
    );
    // the failed turn is persisted by pet_chat itself (fail_text) — no separate record call
    expect(callMock).toHaveBeenCalledWith("pet_chat", expect.objectContaining({ fail_text: expect.any(String) }));
    expect(callMock.mock.calls.some(([cmd]) => cmd === "pet_chat_record_failure")).toBe(false);

    // Retry: the failure row clears while the resend is in flight, and a second pet_chat goes out.
    chatShouldFail = false;
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "pet_chat_history") {
        return {
          messages: [
            { role: "user", text: "hello", created_at: "2026-10-06T00:00:00.000Z" },
            { role: "assistant", text: "failed", created_at: "2026-10-06T00:00:01.000Z", meta: JSON.stringify({ failed: true }) },
          ],
        };
      }
      if (cmd === "pet_chat_rewind") return { truncated: 2, messages: [] };
      if (cmd === "pet_chat") return { reply: "hello back", action: "answer", hits: [] };
      return {};
    });
    fireEvent.click(screen.getByTestId("chat-failure-retry"));
    await waitFor(() => expect(screen.queryByTestId("chat-failure")).toBeNull());
    await waitFor(() => expect(screen.getByText("hello back")).toBeTruthy());
  });
});
