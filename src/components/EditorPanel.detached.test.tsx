import { describe, it, expect, vi, beforeEach } from "vitest";

const callMock = vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => ({}));
vi.mock("../lib/invoke", async (orig) => ({
  ...(await orig<typeof import("../lib/invoke")>()),
  call: (cmd: string, args?: unknown) => callMock(cmd, args),
  callSilent: (cmd: string, args?: unknown) => callMock(cmd, args),
}));
const reportFallback = vi.fn();
vi.mock("../lib/diag", async (orig) => ({
  ...(await orig<typeof import("../lib/diag")>()),
  reportFallback: (...a: unknown[]) => reportFallback(...a),
}));
const serialized = vi.hoisted(() => ({ value: null as string | null }));
vi.mock("../lib/mdSerialize", async (orig) => {
  const m = await orig<typeof import("../lib/mdSerialize")>();
  return { ...m, mdSerializeEditor: (e: Parameters<typeof m.mdSerializeEditor>[0]) => serialized.value ?? m.mdSerializeEditor(e) };
});

import { render, screen, act } from "@testing-library/react";
import { EditorPanel, dropIfDetached } from "./EditorPanel";
import { useNotesStore } from "../stores/notes";
import { useSectionWindowsStore } from "../stores/sectionWindows";
import type { NoteDetail } from "../lib/commands.gen";
import type { Editor } from "@tiptap/react";

const liveEditor = () => ({}) as unknown as Editor; // 직렬화는 위 mdSerialize 목이 대신한다

beforeEach(() => {
  callMock.mockClear();
  reportFallback.mockClear();
  useSectionWindowsStore.setState({ ids: [] });
});

// 배타 소유 — 분리된 섹션은 새 창이 저장한다. 본 창의 자동저장·flush 가 이 가드를 지난다.
describe("dropIfDetached (autosave + flush guard)", () => {
  it("not detached → lets the save through", () => {
    expect(dropIfDetached({ id: "s1", body: "a" }, liveEditor())).toBe(false);
  });

  it("detached → refuses the save; records a fallback only when an edit would actually be lost", () => {
    useSectionWindowsStore.setState({ ids: ["s1"] });

    serialized.value = "same";
    expect(dropIfDetached({ id: "s1", body: "same" }, liveEditor())).toBe(true);
    expect(reportFallback).not.toHaveBeenCalled();

    serialized.value = "typed after detach";
    expect(dropIfDetached({ id: "s1", body: "same" }, liveEditor())).toBe(true);
    expect(reportFallback).toHaveBeenCalledWith("section_window", "detached_edit_dropped");
    serialized.value = null;
  });
});

describe("EditorPanel — detached section in the main window", () => {
  it("shows the placeholder instead of the editor and never saves the section", async () => {
    const note = {
      note: { id: "n1", title: "T", content_locked: false },
      sections: [{ id: "s1", name: "S", body_md: "hello", kind: "text", position: 0 }],
      attachments: [],
    } as unknown as NoteDetail;
    useSectionWindowsStore.setState({ ids: ["s1"] });
    useNotesStore.setState({ activeNote: note, isBooting: false });
    render(<EditorPanel />);
    expect(await screen.findByTestId("detached-section-placeholder")).toBeTruthy();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 800)); // 자동저장 디바운스(700ms)보다 길게
    });
    expect(callMock.mock.calls.some(([cmd]) => cmd === "section_update")).toBe(false);
  });
});
