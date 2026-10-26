import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import { SelectionContextMenu, type SelectionContextMenuOpen } from "./SelectionContextMenu";
import { t } from "../../i18n/t";
import { useAiStore } from "../../stores/ai";
import { useNotesStore } from "../../stores/notes";
import { useSettingsStore } from "../../stores/settings";
import { openDateEntry } from "../../lib/dateEntryBridge";
import { parseNlDate } from "../../lib/nlDate";
import { emitNotice } from "../../lib/invoke";

vi.mock("../../lib/invoke", () => ({
  call: vi.fn(async () => ({})),
  callSilent: vi.fn(async () => ({})),
  emitNotice: vi.fn(),
  registerFlush: vi.fn(() => () => {}),
  flushAll: vi.fn(async () => {}),
}));

vi.mock("../../lib/dateEntryBridge", () => ({
  openDateEntry: vi.fn(),
}));

vi.mock("../../lib/nlDate", () => ({
  parseNlDate: vi.fn(),
}));

afterEach(() => {
  cleanup();
});

describe("SelectionContextMenu UI and actions", () => {
  let editor: Editor;

  beforeEach(() => {
    vi.clearAllMocks();
    editor = new Editor({
      extensions: [StarterKit, Link.configure({ openOnClick: false })],
      content: "<p>Hello world testing selection context menu</p>",
    });
    useAiStore.setState({
      translateGateOk: true,
      refreshTranslateGate: vi.fn(async () => true),
      generateFromPrompt: vi.fn(async () => "Bonjour le monde"),
    } as never);
    useNotesStore.setState({
      activeNote: { note: { id: "note-1", folder_id: "folder-1" }, sections: [{ id: "sec-1" }] },
      ensureMaterialized: vi.fn(async () => "note-1"),
      loadTree: vi.fn(async () => {}),
    } as never);
  });

  afterEach(() => {
    editor.destroy();
  });

  it("renders all context menu items on non-empty selection right click", async () => {
    const openRef = { current: null as SelectionContextMenuOpen | null };
    render(
      <SelectionContextMenu
        editor={editor}
        tabUiBusy={false}
        flush={vi.fn(async () => {})}
        openRef={openRef}
      />
    );

    // Select text "Hello world" (from 1 to 12)
    editor.commands.setTextSelection({ from: 1, to: 12 });

    act(() => {
      openRef.current?.({
        clientX: 100,
        clientY: 100,
        preventDefault: vi.fn(),
      } as unknown as React.MouseEvent);
    });

    expect(screen.getByText(t("ctx.copy"))).toBeDefined();
    expect(screen.getByText(t("ctx.paste_replace"))).toBeDefined();
    expect(screen.getByText(t("ctx.translate"))).toBeDefined();
    expect(screen.getByText(t("ctx.footnote"))).toBeDefined();
    expect(screen.getByText(t("ctx.excerpt_to_note"))).toBeDefined();
    expect(screen.getByText(t("ctx.link"))).toBeDefined();
  });

  it("opens translation popover and provides 3 follow-up actions", async () => {
    const openRef = { current: null as SelectionContextMenuOpen | null };
    render(
      <SelectionContextMenu
        editor={editor}
        tabUiBusy={false}
        flush={vi.fn(async () => {})}
        openRef={openRef}
      />
    );

    editor.commands.setTextSelection({ from: 1, to: 12 });

    act(() => {
      openRef.current?.({
        clientX: 100,
        clientY: 100,
        preventDefault: vi.fn(),
      } as unknown as React.MouseEvent);
    });

    const translateBtn = screen.getByText(t("ctx.translate"));
    await act(async () => {
      fireEvent.click(translateBtn);
    });

    expect(screen.getByTestId("translate-popover")).toBeDefined();
    expect(screen.getByText("Bonjour le monde")).toBeDefined();
    expect(screen.getByText(t("ctx.translate_replace"))).toBeDefined();
    expect(screen.getByText(t("ctx.translate_footnote"))).toBeDefined();
    expect(screen.getByText(t("ctx.translate_section"))).toBeDefined();

    // Clicking replace replaces the selected text
    const replaceBtn = screen.getByText(t("ctx.translate_replace"));
    act(() => {
      fireEvent.click(replaceBtn);
    });

    expect(editor.getText()).toContain("Bonjour le monde");
  });

  it("opens link popover and applies link when confirmed", async () => {
    const openRef = { current: null as SelectionContextMenuOpen | null };
    render(
      <SelectionContextMenu
        editor={editor}
        tabUiBusy={false}
        flush={vi.fn(async () => {})}
        openRef={openRef}
      />
    );

    editor.commands.setTextSelection({ from: 1, to: 12 });

    act(() => {
      openRef.current?.({
        clientX: 100,
        clientY: 100,
        preventDefault: vi.fn(),
      } as unknown as React.MouseEvent);
    });

    const linkBtn = screen.getByText(t("ctx.link"));
    act(() => {
      fireEvent.click(linkBtn);
    });

    expect(screen.getByTestId("link-popover")).toBeDefined();
    const input = screen.getByPlaceholderText("https://...");
    fireEvent.change(input, { target: { value: "https://example.com" } });

    const confirmBtn = screen.getByText(t("editor.link_apply"));
    act(() => {
      fireEvent.click(confirmBtn);
    });

    expect(editor.getHTML()).toContain('href="https://example.com"');
  });

  // PLAN-2026-09-18-nl-dates.md §W2 — "일정으로 등록" 선택 메뉴 항목.
  describe("일정으로 등록", () => {
    beforeEach(() => {
      useSettingsStore.setState({ uiLang: "ko" } as never);
    });

    function openMenu(openRef: { current: SelectionContextMenuOpen | null }) {
      editor.commands.setTextSelection({ from: 1, to: 12 });
      act(() => {
        openRef.current?.({ clientX: 100, clientY: 100, preventDefault: vi.fn() } as unknown as React.MouseEvent);
      });
    }

    it("renders the menu row", () => {
      const openRef = { current: null as SelectionContextMenuOpen | null };
      render(<SelectionContextMenu editor={editor} tabUiBusy={false} flush={vi.fn(async () => {})} openRef={openRef} />);
      openMenu(openRef);
      expect(screen.getByText(t("ctx.register_as_date"))).toBeDefined();
    });

    it("parses the selection with nlDate(uiLang) and opens the date-entry bridge with the parsed prefill", () => {
      vi.mocked(parseNlDate).mockReturnValue({
        start: { year: 2026, month: 9, day: 20 },
        startTime: null,
        end: { end_year: null, end_month: null, end_day: null },
        endTime: null,
        rrule: null,
        title: "경복궁방문",
        matchRange: [0, 5],
        confidence: "high",
      });
      const openRef = { current: null as SelectionContextMenuOpen | null };
      render(<SelectionContextMenu editor={editor} tabUiBusy={false} flush={vi.fn(async () => {})} openRef={openRef} />);
      openMenu(openRef);

      fireEvent.click(screen.getByTestId("sel-ctx-date"));

      expect(parseNlDate).toHaveBeenCalledWith(editor.state.doc.textBetween(1, 12, "\n"), "ko");
      expect(openDateEntry).toHaveBeenCalledWith({
        noteId: "note-1",
        anchorX: 100,
        anchorY: 100,
        range: { from: 1, to: 12 },
        prefill: {
          start: { year: 2026, month: 9, day: 20 },
          end: { end_year: null, end_month: null, end_day: null },
          label: "경복궁방문",
          startTime: null,
          endTime: null,
        },
      });
      // 본문은 건드리지 않는다(D6) — 선택 텍스트 자체가 이미 평문 한 줄 역할.
      expect(editor.state.doc.textBetween(1, 12, " ")).toBe("Hello world");
    });

    // 2026-09-19 후속 — 오너의 원 예시가 실제로 시각까지 넘어가는지(처음엔 빠져 있었다).
    it("carries nlDate's parsed startTime/endTime through to the bridge prefill", () => {
      vi.mocked(parseNlDate).mockReturnValue({
        start: { year: 2026, month: 9, day: 20 },
        startTime: "14:00",
        end: { end_year: null, end_month: null, end_day: null },
        endTime: "22:00",
        rrule: null,
        title: "경복궁방문",
        matchRange: [0, 5],
        confidence: "high",
      });
      const openRef = { current: null as SelectionContextMenuOpen | null };
      render(<SelectionContextMenu editor={editor} tabUiBusy={false} flush={vi.fn(async () => {})} openRef={openRef} />);
      openMenu(openRef);

      fireEvent.click(screen.getByTestId("sel-ctx-date"));

      expect(openDateEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          prefill: expect.objectContaining({ startTime: "14:00", endTime: "22:00" }),
        }),
      );
    });

    it("parse failure (null) still opens the popover, with prefill undefined — blank-form fallback", () => {
      vi.mocked(parseNlDate).mockReturnValue(null);
      const openRef = { current: null as SelectionContextMenuOpen | null };
      render(<SelectionContextMenu editor={editor} tabUiBusy={false} flush={vi.fn(async () => {})} openRef={openRef} />);
      openMenu(openRef);

      fireEvent.click(screen.getByTestId("sel-ctx-date"));

      expect(openDateEntry).toHaveBeenCalledWith(
        expect.objectContaining({ noteId: "note-1", prefill: undefined }),
      );
    });

    it("no active note — notices instead of opening the bridge", () => {
      useNotesStore.setState({ activeNote: null } as never);
      const openRef = { current: null as SelectionContextMenuOpen | null };
      render(<SelectionContextMenu editor={editor} tabUiBusy={false} flush={vi.fn(async () => {})} openRef={openRef} />);
      openMenu(openRef);

      fireEvent.click(screen.getByTestId("sel-ctx-date"));

      expect(openDateEntry).not.toHaveBeenCalled();
      expect(emitNotice).toHaveBeenCalledWith(t("editor.note_required_for_section"));
    });
  });
});
