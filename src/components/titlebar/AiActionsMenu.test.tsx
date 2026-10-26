import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AiActionsMenu } from "./AiActionsMenu";
import { useSettingsStore } from "../../stores/settings";
import { useNotesStore } from "../../stores/notes";
import { AskAiModal as LazyAskAiModal } from "../../lazySurfaces";

// 이 화면들은 지연 청크다(lazySurfaces) — 앱이 유휴 시간에 미리 받듯 여기서 미리 받아 클릭 직후 바로 그려지게 한다.
beforeAll(async () => {
  await LazyAskAiModal.preload();
}, 30_000);

vi.mock("../../lib/invoke", () => ({
  call: vi.fn(),
  callSilent: vi.fn(),
  emitNotice: vi.fn(),
  flushAll: vi.fn(async () => {}),
  registerFlush: () => () => {},
}));

describe("AiActionsMenu — Unified AI button triggering AskAiModal", () => {
  beforeEach(() => {
    useSettingsStore.setState({ uiLang: "en" } as never);
    useNotesStore.setState({ activeNote: null } as never);
  });

  // 2026-09-26: AI 진입점은 노트 제목 줄(☆ 옆) 한 곳 — 이웃과 같은 아이콘 버튼, 글리프 발광(ai-entry).
  it("renders the title-row icon button (glowing glyph, no label) and opens AskAiModal on click", async () => {
    render(<AiActionsMenu />);
    const button = screen.getByRole("button", { name: /AI/i });
    expect(button.className).toContain("icon-btn");
    expect(button.className).toContain("ai-entry");
    expect(button.textContent ?? "").not.toMatch(/AI/);

    expect(screen.queryByRole("dialog")).toBeNull();
    await userEvent.click(button);
    expect(screen.getByRole("dialog")).toBeTruthy();

    // Close via close button
    const closeBtn = screen.getByTestId("modal-close-btn");
    await userEvent.click(closeBtn);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("resolves active note target when a note is open", async () => {
    useNotesStore.setState({
      activeNote: {
        note: { id: "note-1", title: "Project Plan" },
        sections: [{ id: "sec-1", name: "Intro", body_md: "Hello world", kind: "text" }],
      },
    } as never);

    render(<AiActionsMenu />);
    await userEvent.click(screen.getByRole("button", { name: /AI/i }));

    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeTruthy();
    expect(screen.getAllByText("Intro").length).toBeGreaterThan(0);
  });

  // F-N09 확장: 번역/프롬프트/정리는 전부 쓰기 기능이라 잠긴 노트에서는 진입점 자체를 막는다.
  it("disables the button and shows the locked tooltip when the active note is content_locked", async () => {
    useNotesStore.setState({
      activeNote: {
        note: { id: "note-1", title: "Locked note", content_locked: true },
        sections: [{ id: "sec-1", name: "Intro", body_md: "Hello world", kind: "text" }],
      },
    } as never);

    render(<AiActionsMenu />);
    const button = screen.getByRole("button", { name: "Content is locked — editing disabled" });
    expect((button as HTMLButtonElement).disabled).toBe(true);

    await userEvent.click(button);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
