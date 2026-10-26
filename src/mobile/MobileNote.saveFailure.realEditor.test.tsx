/**
 * 폰 저장 실패 정직성(P0-2·P0-3·M-11·M-14) — 진짜 MobileNote + 진짜 Tiptap + 진짜 스토어(ensureMaterialized·updateSectionBody) +
 * 진짜 flushAll/registerFlush. 가짜는 IPC(call) 하나뿐이다.
 * (MobileNote.draftLeave.realEditor.test.tsx 는 ensureMaterialized 를 가짜로 바꿔 note_create 성공 뒤 실패 길이 한 번도 안 돌았다.)
 * 가짜 타이머 아래에서는 waitFor 가 멈추므로 settle() 로 시간을 밀고 동기 쿼리로 확인한다.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
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

import { flushAll } from "../lib/invoke";
import { useNotesStore } from "../stores/notes";
import { useSettingsStore } from "../stores/settings";
import { useAiStore } from "../stores/ai";
import { usePresetsStore } from "../stores/presets";
import { serializeSheet } from "../lib/sheet/types";
import { MobileNote, type MobileNoteHandle } from "./MobileNote";
import { MobileSheetEditor } from "./MobileSheetEditor";

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

function mount(capture = true) {
  const ref = createRef<MobileNoteHandle>();
  const view = render(<MobileNote ref={ref} capture={capture} onBack={() => {}} onOpenNote={() => {}} />);
  return { ref, view };
}
const sectionUpdates = () => callMock.mock.calls.filter((c) => c[0] === "section_update").map((c) => c[1]);

describe("P0-2 새 노트 첫 저장: note_create 성공 뒤 다음 호출 실패", () => {
  it("flushAll 이 영원히 걸리지 않고, 배너가 뜨고, 친 글이 에디터에 남고, 다시 시도가 본문을 다시 보낸다", async () => {
    useNotesStore.setState({
      activeNote: noteDetail("__draft__", [{ id: "draft_sec", body_md: "" }]),
      activeDraft: true,
      activeBodyEmpty: true,
      savedState: "saved",
      saveConflict: null,
      loadTree: vi.fn(async () => {}),
    } as any);
    const { ref } = mount();
    await settle();
    act(() => {
      liveEditor().commands.insertContent("typed text");
    });
    await settle(800); // 자동 저장 → note_create 성공 → section_update 실패

    // 예전엔 catch 의 selectNote → flushAll 이 폰 flush(자기 쓰기 줄 안)를 기다려 여기서 영구 정지했다.
    const outcome = await Promise.race([flushAll().then(() => "resolved"), (async () => { await settle(5000); return "hang"; })()]);
    expect(outcome).toBe("resolved");

    expect(screen.getByTestId("mobile-save-failed")).toBeTruthy();
    expect(ref.current!.hasUnsavedFailure()).toBe(true);
    expect(liveEditor().getText()).toBe("typed text"); // 빈 서버 본문으로 다시 칠하지 않았다
    expect(useNotesStore.getState().savedState).not.toBe("saved");
    expect(callMock.mock.calls.map((c) => c[0])).not.toContain("note_get");

    failSectionUpdate = false;
    callMock.mockClear();
    await act(async () => {
      fireEvent.click(screen.getByText("Retry"));
    });
    await settle();
    expect(sectionUpdates()).toEqual([expect.objectContaining({ id: "sec_real", body_md: "typed text" })]);
    expect(screen.queryByTestId("mobile-save-failed")).toBeNull();
    expect(ref.current!.hasUnsavedFailure()).toBe(false);
  });

  it("M-14: 첫 저장 왕복 중에 더 친 글이 지워지지 않고 서버에도 나간다", async () => {
    useNotesStore.setState({
      activeNote: noteDetail("__draft__", [{ id: "draft_sec", body_md: "" }]),
      activeDraft: true,
      activeBodyEmpty: true,
      savedState: "saved",
      saveConflict: null,
      loadTree: vi.fn(async () => {}),
    } as any);
    failSectionUpdate = false;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let gateDone = false;
    const base = callMock.getMockImplementation()!;
    callMock.mockImplementation(async (cmd: string, args?: any) => {
      if (cmd === "section_update" && !gateDone) await gate;
      return base(cmd, args);
    });
    mount();
    await settle();
    act(() => {
      liveEditor().commands.insertContent("Hello wor");
    });
    await settle(800); // note_create 성공, section_update 대기 중
    act(() => {
      liveEditor().commands.insertContent("ld");
    });
    gateDone = true;
    release();
    await settle(2000);
    expect(liveEditor().getText()).toBe("Hello world");
    const bodies = sectionUpdates().map((a: any) => a.body_md);
    expect(bodies[bodies.length - 1]).toBe("Hello world");
  });
});

describe("P0-3 저장 실패 뒤 섹션 전환", () => {
  it("실패한 섹션에 머문다 — 본문이 에디터에 남고 나가기는 계속 막힌다. 복구 뒤 다시 시도가 재전송한다", async () => {
    useNotesStore.setState({
      activeNote: noteDetail("note-1", [
        { id: "s1", body_md: "first" },
        { id: "s2", body_md: "second" },
      ]),
      activeDraft: false,
      activeBodyEmpty: false,
      savedState: "saved",
      saveConflict: null,
    } as any);
    const { ref } = mount(false);
    await settle();
    expect(liveEditor().getText()).toBe("second");
    act(() => {
      liveEditor().commands.insertContent("edit ");
    });
    await settle(800);
    expect(screen.getByTestId("mobile-save-failed")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByTestId("mobile-section-tab-s1"));
    });
    await settle();
    expect(liveEditor().getText()).toContain("edit"); // 첫 섹션 본문("first")으로 갈아타지 않았다
    expect(ref.current!.hasUnsavedFailure()).toBe(true);
    expect(screen.getByTestId("mobile-save-failed")).toBeTruthy();

    failSectionUpdate = false;
    callMock.mockClear();
    await act(async () => {
      fireEvent.click(screen.getByText("Retry"));
    });
    await settle();
    expect(sectionUpdates()).toEqual([expect.objectContaining({ id: "s2" })]);
    expect((sectionUpdates()[0] as any).body_md).toContain("edit");
    expect(ref.current!.hasUnsavedFailure()).toBe(false);
  });
});

describe("M-11 시트 저장 실패", () => {
  const sheetBody = serializeSheet({
    v: 1,
    rows: 3,
    cols: [{ w: 90, fmt: "checkbox" }],
    cells: { A1: { raw: "TRUE" } },
    charts: [],
  });
  const section = { id: "sheet-1", name: "Sheet", position: 0, kind: "sheet", body_md: sheetBody } as any;

  it("일반 실패면 보낸 본문 표시를 되돌려 다음 flush 가 실제로 다시 보내고, 실패는 나가기 차단이 아는 곳에 남는다", async () => {
    const { anySaveFailed } = await import("../lib/sectionSaveFailures");
    const update = vi.fn(async () => {
      useNotesStore.setState({ savedState: "failed" } as any); // 비초안 updateSectionBody 의 계약: reject 하지 않고 failed
    });
    useNotesStore.setState({
      activeNote: noteDetail("note-1", [{ id: "sheet-1", body_md: sheetBody, kind: "sheet" }]),
      activeDraft: false,
      savedState: "saved",
      saveConflict: null,
      updateSectionBody: update,
    } as any);
    const { container } = render(<MobileSheetEditor section={section} />);
    fireEvent.click(container.querySelector("td svg.lucide-square-check-big")!.closest("td")!); // 체크박스 토글 = 즉시 편집
    await act(async () => {
      await flushAll();
    });
    expect(update).toHaveBeenCalledTimes(1);
    expect(anySaveFailed(["sheet-1"])).toBe(true);

    update.mockImplementation(async () => {
      useNotesStore.setState({ savedState: "saved" } as any);
    });
    await act(async () => {
      await flushAll(); // 다시 시도 — 예전엔 sentRef 가 이미 앞당겨져 있어 아무것도 안 보내고 "저장됨" 이 됐다
    });
    expect(update).toHaveBeenCalledTimes(2);
    expect(anySaveFailed(["sheet-1"])).toBe(false);
  });
});
