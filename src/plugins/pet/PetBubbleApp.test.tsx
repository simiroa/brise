import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

// jsdom doesn't implement Element.scrollTo — PetChat's list-autoscroll effect calls it on mount
// (same shim as PetChat.test.tsx).
if (!Element.prototype.scrollTo) {
  Element.prototype.scrollTo = () => {};
}

/** call()/callSilent() 커맨드별 그럴싸한 기본값 — PetApp.test.tsx와 같은 패턴. */
function defaultCall(cmd: string) {
  switch (cmd) {
    case "pet_bubble_state":
      return Promise.resolve({ mode: "chat", text: "", note_id: null });
    case "pet_chat_history":
      return Promise.resolve({ messages: [] });
    case "pet_bubble_resize":
    case "pet_bubble_close":
    case "pet_open_main":
    case "pet_conversation_save":
      return Promise.resolve({});
    default:
      return Promise.reject(new Error("unexpected pet cmd: " + cmd));
  }
}
const callMock = vi.fn(defaultCall);
vi.mock("../../lib/invoke", () => ({
  call: (...args: unknown[]) => (callMock as (...a: unknown[]) => unknown)(...args),
  callSilent: (...args: unknown[]) => (callMock as (...a: unknown[]) => unknown)(...args),
  emitNotice: vi.fn(),
  registerFlush: vi.fn(),
  flushAll: vi.fn(async () => {}),
}));

const listenHandlers: Record<string, (e: { payload: unknown }) => void> = {};
const listenMock = vi.fn((event: string, handler: (e: { payload: unknown }) => void) => {
  listenHandlers[event] = handler;
  return Promise.resolve(() => {
    delete listenHandlers[event];
  });
});
const emitMock = vi.fn();
vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => (listenMock as (...a: unknown[]) => unknown)(...args),
  emit: (...args: unknown[]) => emitMock(...args),
}));

vi.mock("../../lib/tauriListen", () => ({
  listenMany: () => () => {},
}));

vi.mock("./usePetTheme", () => ({
  usePetTheme: () => ({ aiEnabled: true, chatWriteEnabled: true, captureScreenshot: false, petDblclickAction: "new_note" }),
}));

vi.mock("../../lib/appearance", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/appearance")>();
  return { ...actual, applySavedAppearanceSeed: () => {} };
});

const runChatPipelineMock = vi.fn();
vi.mock("../../lib/chatPipeline", () => ({
  runChatPipeline: (...args: unknown[]) => runChatPipelineMock(...args),
}));

import { PetBubbleApp } from "./PetBubbleApp";

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

function reset() {
  callMock.mockClear();
  callMock.mockImplementation(defaultCall);
  listenMock.mockClear();
  for (const key of Object.keys(listenHandlers)) delete listenHandlers[key];
  emitMock.mockReset();
  emitMock.mockResolvedValue(undefined);
  runChatPipelineMock.mockReset();
}

describe("PetBubbleApp — create_section auto-send never claims a confirmed insert (U3, AUDIT-2026-09-26)", () => {
  beforeEach(() => {
    reset();
  });

  it("marks the resulting bubble sectionAutoSent (not sectionInserted) and emits the section event exactly once", async () => {
    runChatPipelineMock.mockImplementation(async (params: { onCreateSection?: (req: { title?: string; body: string }) => Promise<boolean> }) => {
      // Reproduces chatPipeline.ts's own call shape: only invoked when the backend actually
      // asked for a new section.
      const inserted = await params.onCreateSection?.({ title: "요약", body: "본문 내용" });
      return {
        type: "success" as const,
        stampedUser: { role: "user" as const, text: "이거 메모해줘", createdAt: "t0", persisted: true },
        assistantItem: {
          role: "assistant" as const,
          text: "메모해 뒀어요",
          sectionTitle: "요약",
          sectionBody: "본문 내용",
          sectionInserted: inserted,
        },
      };
    });

    render(<PetBubbleApp />);
    await flush();

    const textarea = screen.getByPlaceholderText("무엇이든 물어보세요") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "이거 메모해줘" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await flush();

    // U3: the create-section request WAS sent to the main window over the pet event bridge...
    expect(emitMock).toHaveBeenCalledWith(
      "pet-apply-chat-section",
      expect.objectContaining({ title: "요약", body: "본문 내용" }),
    );
    expect(emitMock.mock.calls.filter((c) => c[0] === "pet-apply-chat-section")).toHaveLength(1);

    // ...but this window cannot know whether it actually landed — so the chip must read "sent",
    // never a confirmed "inserted" state (that was the exact bug: onCreateSection always
    // returning true regardless of outcome, per audit D3/U3).
    const sentChip = await screen.findByTestId("chat-section-sent");
    expect(sentChip).toBeDefined();
    expect(screen.queryByTestId("chat-insert-section")).toBeNull();
  });
});

// C(AUDIT-2026-09-26): accepting the "collect" suggestion card in the pet bubble removed the card
// BEFORE the emit() that hands the request to the main window — same defect as SidebarChat.tsx's
// matching card. If that emit itself fails, the card must come back instead of vanishing silently.
describe("PetBubbleApp — collect suggestion card accept failure restores the card (C, AUDIT-2026-09-26)", () => {
  beforeEach(() => {
    reset();
  });

  function fireCollectSuggestion() {
    const suggestions = [
      {
        id: "sug-1",
        kind: "collect_post_process",
        note_id: "note-collected",
        note_title: "수집된 노트",
        related_note_id: "note-collected",
        related_note_title: "",
        payload: JSON.stringify({ source_name: "RSS 피드", post_process_model: null }),
        score: 1,
        created_at: "2026-09-26T00:00:00.000Z",
      },
    ];
    act(() => {
      listenHandlers["pet-suggestions-pending"]?.({ payload: { suggestions } });
    });
  }

  it("restores the card when emit('pet-accept-collect-suggestion') fails", async () => {
    emitMock.mockImplementation((event: string) =>
      event === "pet-accept-collect-suggestion" ? Promise.reject(new Error("ipc down")) : Promise.resolve(undefined),
    );

    render(<PetBubbleApp />);
    await flush();

    fireCollectSuggestion();
    const card = await screen.findByTestId("pet-suggestion-card");
    fireEvent.click(card.querySelector(".pet-suggestion__review") as HTMLButtonElement);
    await flush();

    expect(await screen.findByTestId("pet-suggestion-card")).toBeDefined();
  });
});
