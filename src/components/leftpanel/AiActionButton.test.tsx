import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AiActionButton } from "./AiActionButton";
import { useSettingsStore } from "../../stores/settings";
import { useAiStore } from "../../stores/ai";
import { useNotesStore } from "../../stores/notes";
import { AskAiModal as LazyAskAiModal } from "../../lazySurfaces";

// 이 화면들은 지연 청크다(lazySurfaces) — 앱이 유휴 시간에 미리 받듯 여기서 미리 받아 클릭 직후 바로 그려지게 한다.
beforeAll(async () => {
  await LazyAskAiModal.preload();
}, 30_000);

vi.mock("../../lib/invoke", () => ({
  call: vi.fn().mockResolvedValue({}),
  callSilent: vi.fn().mockResolvedValue({}),
  flushAll: vi.fn(async () => {}),
  registerFlush: () => () => {},
  emitNotice: vi.fn(),
}));

// AskAiModal drags in the whole AI action stack (runAiAction/aiSectionBridge/presetBridge) — this
// file only cares that the button opens it with the right target kind, same stub PresetList's own
// test uses.
vi.mock("../AskAiModal", () => ({
  AskAiModal: ({ target }: { target: { kind: string; noteId?: string; noteTitle?: string } }) => (
    <div data-testid="ask-ai-modal-stub">{`${target.kind}:${target.noteId ?? ""}:${target.noteTitle ?? ""}`}</div>
  ),
}));

describe("AiActionButton (sidebar footer AI entry)", () => {
  beforeEach(() => {
    useSettingsStore.setState({ aiEnabled: true, uiLang: "en" } as never);
    useAiStore.setState({ aiReachable: true } as never);
    useNotesStore.setState({ activeNote: null } as never);
  });

  it("hides the footer AI icon when AI is off", () => {
    useSettingsStore.setState({ aiEnabled: false } as never);
    render(<AiActionButton />);
    expect(screen.queryByTestId("ai-action-btn")).toBeNull();
    expect(screen.queryByTestId("ask-ai-modal-stub")).toBeNull();
  });

  it("disables the button with a hint when AI is on but unreachable", () => {
    useSettingsStore.setState({ aiEnabled: true, uiLang: "en" } as never);
    useAiStore.setState({ aiReachable: false } as never);
    render(<AiActionButton />);
    const btn = screen.getByTestId("ai-action-btn") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute("title")).toBe("Cannot connect to AI — check Settings");
    expect(screen.queryByTestId("ask-ai-modal-stub")).toBeNull();
  });

  it("disables the button with a hint when AI is on but checking", () => {
    useSettingsStore.setState({ aiEnabled: true, uiLang: "en" } as never);
    useAiStore.setState({ aiReachable: null } as never);
    render(<AiActionButton />);
    const btn = screen.getByTestId("ai-action-btn") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute("title")).toBe("Checking AI connection…");
    expect(screen.queryByTestId("ask-ai-modal-stub")).toBeNull();
  });

  it("with an active note: opens AskAiModal straight onto that note (no action dropdown in between)", () => {
    useNotesStore.setState({
      activeNote: { note: { id: "n1", title: "Trip log" } } as never,
    } as never);

    render(<AiActionButton />);
    expect(screen.queryByTestId("ask-ai-modal-stub")).toBeNull();

    fireEvent.click(screen.getByTestId("ai-action-btn"));
    expect(screen.getByTestId("ask-ai-modal-stub").textContent).toBe("note:n1:Trip log");
  });

  it("with no active note: opens the kind:'new' target (topic -> generated note), creating nothing up front", () => {
    const newNote = vi.fn(async () => {});
    useNotesStore.setState({ activeNote: null, newNote } as never);

    render(<AiActionButton />);
    fireEvent.click(screen.getByTestId("ai-action-btn"));

    expect(screen.getByTestId("ask-ai-modal-stub").textContent).toBe("new::");
    // applyPreset (inside the modal) owns note creation — the button must not pre-create one.
    expect(newNote).not.toHaveBeenCalled();
  });
});
