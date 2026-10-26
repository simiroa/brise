/**
 * M-15 앱이 백그라운드로 가면(visibilitychange hidden) 서버에 못 보낸 글을 조용히 보관한다 — 진짜 MobileNote + 진짜 Tiptap + 진짜 스토어.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";
import { createRef } from "react";
import type { Editor } from "@tiptap/core";

const callMock = vi.fn();
vi.mock("../lib/invoke", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/invoke")>()),
  call: (...a: unknown[]) => callMock(...a),
  callSilent: (...a: unknown[]) => callMock(...a),
  emitNotice: vi.fn(),
}));
vi.mock("../lib/noteSummaries", () => ({ fetchNoteSummary: vi.fn() }));
vi.mock("../lib/regionRegistry", () => ({ loadRegionRegistry: vi.fn(async () => []) }));
vi.mock("../components/home/useNoteWaypoints", () => ({ useNoteWaypoints: () => [] }));
vi.mock("../lib/tauriListen", () => ({ listenMany: () => () => {} }));
vi.mock("../components/diagram/DiagramSection", () => ({ DiagramSection: () => null }));
vi.mock("../components/sheet/SheetChart", () => ({ SheetChart: () => null }));

import { useNotesStore } from "../stores/notes";
import { useSettingsStore } from "../stores/settings";
import { useAiStore } from "../stores/ai";
import { usePresetsStore } from "../stores/presets";
import { MobileNote, type MobileNoteHandle } from "./MobileNote";

const liveEditor = (): Editor => (document.querySelector(".ProseMirror") as any).editor;
const settle = (ms = 0) => act(() => vi.advanceTimersByTimeAsync(ms));

function noteDetail(id: string, sections: { id: string; body_md: string; kind?: string }[]) {
  return {
    note: {
      id,
      folder_id: "inbox1",
      title: id === "__draft__" ? "Untitled Note" : "T",
      year: 2026,
      month: 10,
      day: 7,
      is_favorite: false,
      content_locked: false,
      exported_at: null,
      has_image: false,
      tag_names: [],
      region: null,
      status: null,
      icon: null,
      lat: null,
      lng: null,
      created_at: "",
      updated_at: "",
    },
    sections: sections.map((s, i) => ({ name: `S${i}`, position: i, kind: "text", ...s })),
    sources: [],
    attachments: [],
  } as any;
}

let failSectionUpdate = true;
beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  failSectionUpdate = true;
  callMock.mockReset().mockImplementation(async (cmd: string) => {
    if (cmd === "workspace_status_list") return { statuses: [] };
    if (cmd === "note_create") return noteDetail("real1", [{ id: "sec_real", body_md: "" }]);
    if (cmd === "section_update") {
      if (failSectionUpdate) throw { code: "IO", message: "HTTP 502" };
      return { section_updated_at: "t9", updated_at: "t9" };
    }
    if (cmd === "note_get") return noteDetail("real1", [{ id: "sec_real", body_md: "" }]); // 서버본 — 본문이 비어 있다
    return {};
  });
  useSettingsStore.setState({ aiEnabled: false, uiLang: "en", dateNudgeEnabled: false } as any);
  useAiStore.setState({ aiReachable: false, ensureAiReachable: vi.fn().mockResolvedValue(undefined) } as any);
  usePresetsStore.setState({ customPresets: [], loaded: true, load: vi.fn() } as any);
});
afterEach(async () => {
  cleanup();
  await vi.advanceTimersByTimeAsync(1000); // Tiptap 의 지연 destroy 가 가짜 시계에 걸려 있다
  vi.useRealTimers();
  useNotesStore.setState({ activeNote: null, activeDraft: false, savedState: "saved" } as any);
});


function mount() {
  const ref = createRef<MobileNoteHandle>();
  render(<MobileNote ref={ref} capture={false} onBack={() => {}} onOpenNote={() => {}} />);
  return ref;
}
const setVisibility = (state: "hidden" | "visible") => {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
};
const stashed = () => JSON.parse(localStorage.getItem("brise.unsavedStash.v1") ?? "[]");

describe("M-15 숨김 시 보관", () => {
  it("저장 실패가 남은 채 숨겨지면 보관하고(반복해도 한 건), 돌아오면 거둔다", async () => {
    useNotesStore.setState({
      activeNote: noteDetail("note-1", [{ id: "s1", body_md: "first" }]),
      activeDraft: false,
      activeBodyEmpty: false,
      savedState: "saved",
      saveConflict: null,
    } as any);
    mount();
    await settle();
    act(() => {
      liveEditor().commands.insertContent("edit ");
    });
    await settle(800); // section_update 실패 → bodyUnsaved
    expect(screen.getByTestId("mobile-save-failed")).toBeTruthy();

    await act(async () => setVisibility("hidden"));
    await settle();
    expect(stashed()).toHaveLength(1);
    expect(stashed()[0]).toMatchObject({ noteId: "note-1", sectionId: "s1" });
    expect(stashed()[0].bodyMd).toContain("edit");

    await act(async () => setVisibility("hidden"));
    await settle();
    expect(stashed()).toHaveLength(1); // 쌓이지 않는다

    await act(async () => setVisibility("visible"));
    expect(stashed()).toHaveLength(0);
  });

  it("실패가 없으면 아무것도 보관하지 않는다", async () => {
    failSectionUpdate = false;
    useNotesStore.setState({
      activeNote: noteDetail("note-1", [{ id: "s1", body_md: "first" }]),
      activeDraft: false,
      activeBodyEmpty: false,
      savedState: "saved",
      saveConflict: null,
    } as any);
    mount();
    await settle();
    act(() => {
      liveEditor().commands.insertContent("edit ");
    });
    await act(async () => setVisibility("hidden"));
    await settle(800);
    expect(localStorage.length).toBe(0);
    await act(async () => setVisibility("visible"));
  });
});
