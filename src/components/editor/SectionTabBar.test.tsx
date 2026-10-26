import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";

const callMock = vi.fn();
const emitNoticeMock = vi.fn();
const flushAllMock = vi.fn(async () => {});

vi.mock("../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  emitNotice: (...args: unknown[]) => emitNoticeMock(...args),
  flushAll: () => flushAllMock(),
  registerFlush: () => () => {},
}));

const saveMock = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: (...args: unknown[]) => saveMock(...args),
}));

import { useRef } from "react";
import { SectionTabBar } from "./SectionTabBar";
import { useSectionActions } from "./useSectionActions";
import { useSettingsStore } from "../../stores/settings";
import { useUiStore } from "../../stores/ui";
import { useAiStore } from "../../stores/ai";
import { useNotesStore } from "../../stores/notes";
import { useExportModalStore } from "../../stores/exportModal";
import { registerSectionInserter } from "../../lib/aiSectionBridge";
import { t } from "../../i18n/t";
import type { NoteDetail } from "../../lib/commands.gen";

function makeNote(overrides: Partial<NoteDetail["note"]> = {}): NoteDetail {
  return {
    note: {
      id: "note-1",
      title: "Note 1",
      folder_id: "f1",
      year: null,
      region_id: null,
      status: null,
      favorite: false,
      pinned: false,
      ...overrides,
    } as NoteDetail["note"],
    sections: [
      {
        id: "s1",
        note_id: "note-1",
        name: "Overview",
        body_md: "hello",
        position: 0,
        kind: "text",
      } as any,
    ],
    sources: [],
    attachments: [],
  };
}

const noop = async () => {};

function renderBar(opts: { aiEnabled?: boolean; note?: NoteDetail } = {}) {
  const note = opts.note ?? makeNote();
  useSettingsStore.setState({ aiEnabled: opts.aiEnabled ?? false } as any);
  return render(
    <SectionTabBar
      activeNote={note}
      activeSectionId={note.sections[0]?.id ?? null}
      previewItem={null}
      onSwitchSection={noop}
      onDeleteSection={noop}
      onReorderSection={noop}
      onAskAi={() => {}}
    />,
  );
}

function makeTwoSectionNote(): NoteDetail {
  const note = makeNote();
  return {
    ...note,
    sections: [
      note.sections[0],
      { ...note.sections[0], id: "s2", name: "Details", position: 1 },
    ],
  };
}

function openAddMenu() {
  // "+" is the last flex child in the section-tabs strip (no dedicated testid).
  const tabs = screen.getByTestId("section-tabs");
  const plus = tabs.lastElementChild as HTMLElement;
  fireEvent.click(plus);
}

describe("SectionTabBar — AI new section (Wave 3B)", () => {
  let insertSectionMock: (
    name: string,
    body_md: string,
    targetNoteId: string,
    kind?: "text" | "diagram" | "sheet",
  ) => Promise<null>;

  beforeEach(() => {
    callMock.mockReset();
    emitNoticeMock.mockReset();
    flushAllMock.mockClear();
    callMock.mockImplementation((cmd: string) => {
      // Loopback ollama + ai_enabled false still passes refreshTranslateGate (local privacy).
      if (cmd === "settings_get_all") {
        return Promise.resolve({
          settings: { ai_enabled: false, ai_provider: "ollama", ai_endpoint: "" },
        });
      }
      if (cmd === "ai_generate_from_prompt") {
        return Promise.resolve({ generated: "<p>AI body</p>" });
      }
      return Promise.resolve({});
    });
    useAiStore.setState({
      translateGateOk: null,
      promptPending: false,
      generateFromPrompt: useAiStore.getState().generateFromPrompt,
    } as never);
    useNotesStore.setState({
      activeNote: makeNote() as any,
    } as never);
    insertSectionMock = vi.fn(async () => null);
    registerSectionInserter(insertSectionMock);
  });

  it("does not show the AI menu item when aiEnabled is off", () => {
    renderBar({ aiEnabled: false });
    openAddMenu();
    expect(screen.queryByTestId("add-section-ai")).toBeNull();
    // 글/관계도 행은 프리셋 목록과 중복이라 제거됨(2026-08-11) — 메뉴엔 프리셋 목록만 남는다.
    expect(screen.getByTestId("preset-list")).toBeTruthy();
  });

  it("shows the AI menu item when aiEnabled is on", () => {
    renderBar({ aiEnabled: true });
    openAddMenu();
    expect(screen.getByTestId("add-section-ai")).toBeTruthy();
  });

  it("prompt → generateFromPrompt(null context) → insertAiSection with fixed targetNoteId", async () => {
    renderBar({ aiEnabled: true });
    openAddMenu();
    fireEvent.click(screen.getByTestId("add-section-ai"));

    // Gate opens PromptDialog (modal shell).
    await waitFor(() => expect(screen.getByTestId("modal-shell")).toBeTruthy());

    const input = screen.getByPlaceholderText(/./) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "write a short blurb" } });
    fireEvent.click(screen.getByRole("button", { name: /^(생성|Generate)$/ }));

    await waitFor(() =>
      expect(callMock).toHaveBeenCalledWith(
        "ai_generate_from_prompt",
        expect.objectContaining({
          prompt: "write a short blurb",
          // null context → backend gets undefined / omitted context_text
        }),
      ),
    );
    // context_text must be omitted when we pass null (no existing section body).
    const genCall = callMock.mock.calls.find((c) => c[0] === "ai_generate_from_prompt");
    expect(genCall?.[1]?.context_text).toBeUndefined();

    // W5: the free-form prompt box tags ai_origin "prompt" (aiSectionBridge.ts's
    // insertAiSection unwraps it from opts down to the bare string the low-level registered
    // inserter receives).
    await waitFor(() =>
      expect(insertSectionMock).toHaveBeenCalledWith(
        expect.any(String),
        "<p>AI body</p>",
        "note-1",
        undefined,
        "prompt",
      ),
    );
  });

  it("gate blocked (cloud + ai off) notices and does not open the prompt", async () => {
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "settings_get_all") {
        return Promise.resolve({
          settings: {
            ai_enabled: false,
            ai_provider: "openai",
            ai_endpoint: "https://api.openai.com",
          },
        });
      }
      return Promise.resolve({});
    });
    useAiStore.setState({ translateGateOk: null } as never);

    renderBar({ aiEnabled: true });
    openAddMenu();
    fireEvent.click(screen.getByTestId("add-section-ai"));

    await waitFor(() => expect(emitNoticeMock).toHaveBeenCalled());
    expect(screen.queryByTestId("modal-shell")).toBeNull();
    expect(insertSectionMock).not.toHaveBeenCalled();
  });
});

describe("SectionTabBar keyboard navigation", () => {
  it("uses a real add button and roving tab focus with Arrow/Home/End", () => {
    const note = makeTwoSectionNote();
    const onSwitchSection = vi.fn();
    useSettingsStore.setState({ aiEnabled: false } as any);
    render(
      <SectionTabBar
        activeNote={note}
        activeSectionId="s1"
        previewItem={null}
        onSwitchSection={onSwitchSection}
        onDeleteSection={noop}
        onReorderSection={noop}
        onAskAi={() => {}}
      />,
    );

    const tabs = screen.getAllByRole("tab");
    expect(tabs[0].tabIndex).toBe(0);
    expect(tabs[1].tabIndex).toBe(-1);
    expect(screen.getByRole("button", { name: /새 (탭|섹션)|New section|Nouvelle section/i })).toBeTruthy();

    tabs[0].focus();
    fireEvent.keyDown(tabs[0], { key: "ArrowRight" });
    expect(document.activeElement).toBe(tabs[1]);
    expect(onSwitchSection).toHaveBeenCalledWith(note.sections[1]);
    fireEvent.keyDown(tabs[1], { key: "Home" });
    expect(document.activeElement).toBe(tabs[0]);
    fireEvent.keyDown(tabs[0], { key: "End" });
    expect(document.activeElement).toBe(tabs[1]);
  });
});

describe("SectionTabBar — AI origin dot (W5 provenance)", () => {
  function renderWithSection(sectionOverrides: Record<string, unknown>) {
    const note = makeNote();
    note.sections = [{ ...note.sections[0], ...sectionOverrides } as any];
    useSettingsStore.setState({ aiEnabled: false, uiLang: "ko" } as any);
    render(
      <SectionTabBar
        activeNote={note}
        activeSectionId={note.sections[0].id}
        previewItem={null}
        onSwitchSection={noop}
        onDeleteSection={noop}
        onReorderSection={noop}
        onAskAi={() => {}}
      />,
    );
  }

  it("does not render the dot for a plain user-authored section (ai_origin absent)", () => {
    renderWithSection({});
    expect(screen.queryByTestId("section-ai-origin-dot")).toBeNull();
  });

  it("does not render the dot when ai_origin is explicitly null", () => {
    renderWithSection({ ai_origin: null });
    expect(screen.queryByTestId("section-ai-origin-dot")).toBeNull();
  });

  it("renders the dot with a tooltip naming the action for a known BUILTIN_DEFS id", () => {
    renderWithSection({ ai_origin: "summarize", updated_at: new Date().toISOString() });
    const dot = screen.getByTestId("section-ai-origin-dot");
    // ai.action_default_name_summarize (ko) = "요약하기" — proves the id→label lookup, not just presence.
    expect(dot.title).toContain("요약하기");
  });

  it("uses the existing translate/prompt labels for the two non-BUILTIN_DEFS origins", () => {
    renderWithSection({ ai_origin: "translate", updated_at: new Date().toISOString() });
    const dot = screen.getByTestId("section-ai-origin-dot");
    expect(dot.title).not.toContain("ai.action_default_name_translate");
    expect(dot.title.length).toBeGreaterThan(0);
  });

  it("falls back to the raw origin string when no matching i18n key exists (custom preset id)", () => {
    renderWithSection({ ai_origin: "my_custom_preset_id", updated_at: new Date().toISOString() });
    const dot = screen.getByTestId("section-ai-origin-dot");
    expect(dot.title).toContain("my_custom_preset_id");
  });
});

describe("SectionTabBar — section context menu export (kind branching)", () => {
  beforeEach(() => {
    callMock.mockReset().mockResolvedValue({ written_path: "x" });
    emitNoticeMock.mockReset();
    saveMock.mockReset();
    useSettingsStore.setState({ aiEnabled: false } as any);
  });

  function renderWithSections(sections: any[]) {
    const note = { ...makeNote(), sections };
    render(
      <SectionTabBar
        activeNote={note}
        activeSectionId={sections[0].id}
        previewItem={null}
        onSwitchSection={noop}
        onDeleteSection={noop}
        onReorderSection={noop}
        onAskAi={() => {}}
      />,
    );
  }

  it("kind==='text' → opens the export modal scoped to this section (no save dialog / export call here)", () => {
    useExportModalStore.setState({ request: null });
    renderWithSections([{ id: "s1", note_id: "note-1", name: "Overview", body_md: "hello", position: 0, kind: "text" }]);

    fireEvent.contextMenu(screen.getAllByRole("tab")[0]);
    fireEvent.click(screen.getByText(t("ctx.export_section")));

    expect(useExportModalStore.getState().request).toEqual({
      noteId: "note-1",
      noteTitle: "Note 1",
      sectionId: "s1",
    });
    expect(saveMock).not.toHaveBeenCalled();
    expect(callMock).not.toHaveBeenCalledWith("export_section_md", expect.anything());
  });

  it("kind==='sheet' → parses body_md then save dialog (.csv) then export_sheet_csv", async () => {
    const sheetDoc = { v: 1, rows: 10, cols: [{}], cells: { A1: { raw: "hi" } }, charts: [] };
    renderWithSections([
      { id: "s2", note_id: "note-1", name: "Budget", body_md: JSON.stringify(sheetDoc), position: 0, kind: "sheet" },
    ]);
    saveMock.mockResolvedValue("C:/out/Budget.csv");

    fireEvent.contextMenu(screen.getAllByRole("tab")[0]);
    fireEvent.click(screen.getByText(t("ctx.export_section")));

    await waitFor(() =>
      expect(callMock).toHaveBeenCalledWith("export_sheet_csv", { dest_path: "C:/out/Budget.csv", csv: "hi" }),
    );
    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: "Budget.csv", filters: [{ name: "CSV", extensions: ["csv"] }] }),
    );
    expect(callMock).not.toHaveBeenCalledWith("export_section_md", expect.anything());
  });

  it("does not show the export menu item for kind==='diagram' (PNG export stays on the diagram toolbar)", () => {
    renderWithSections([{ id: "s3", note_id: "note-1", name: "Map", body_md: "graph TD;", position: 0, kind: "diagram" }]);

    fireEvent.contextMenu(screen.getAllByRole("tab")[0]);
    expect(screen.queryByText(t("ctx.export_section"))).toBeNull();
  });
});

// W1 (PLAN-2026-09-10 D1): 탭 드래그는 HTML5 DnD 가 아니라 포인터 이벤트다(lib/noteDrag.ts) —
// tauri 창의 dragDropEnabled 기본값 탓에 웹뷰까지 dragover/drop 이 오지 않아 HTML5 경로는 앱에서
// 죽어 있었다(jsdom 에서만 통과하던 테스트가 그 사실을 가렸다). 그래서 여기서는 실제 앱과 같은
// 경로 — pointerdown → 4px 초과 pointermove → 대상 위 pointerup — 을 그대로 밟고, 드롭 처리도
// SectionTabBar 의 콜백이 아니라 useSectionActions 가 등록한 핸들러가 맡는 것까지 함께 확인한다.
describe("SectionTabBar — 탭 포인터 드래그 재정렬 (W1)", () => {
  function Harness({ note }: { note: NoteDetail }) {
    const sectionRef = useRef<{ id: string; body: string; kind: string } | null>(null);
    const bodyCacheRef = useRef<Record<string, string>>({});
    useSectionActions(sectionRef, noop, bodyCacheRef);
    return (
      <SectionTabBar
        activeNote={note}
        activeSectionId={note.sections[0].id}
        previewItem={null}
        onSwitchSection={noop}
        onDeleteSection={noop}
        onReorderSection={noop}
        onAskAi={() => {}}
      />
    );
  }

  let elementFromPointSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    callMock.mockReset().mockResolvedValue({});
    emitNoticeMock.mockReset();
    useSettingsStore.setState({ aiEnabled: false } as any);
    const note = makeTwoSectionNote();
    useNotesStore.setState({ activeNote: note as any } as never);
    // jsdom 은 레이아웃이 없어 elementFromPoint 가 쓸모없다 — 커서 아래 요소를 테스트가 지정한다.
    elementFromPointSpy = vi.fn(() => null);
    (document as unknown as { elementFromPoint: unknown }).elementFromPoint = elementFromPointSpy;
  });

  function renderDraggable() {
    render(<Harness note={makeTwoSectionNote()} />);
    return screen.getAllByRole("tab");
  }

  it("첫 탭을 둘째 탭 위로 끌면 section_reorder 가 뒤바뀐 순서로 한 번 호출된다", async () => {
    const tabs = renderDraggable();
    elementFromPointSpy.mockReturnValue(tabs[1]);

    fireEvent.pointerDown(tabs[0], { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { clientX: 40, clientY: 10 });
    fireEvent.pointerUp(window, { clientX: 40, clientY: 10 });

    await waitFor(() =>
      expect(callMock).toHaveBeenCalledWith("section_reorder", {
        note_id: "note-1",
        ordered_ids: ["s2", "s1"],
      }),
    );
    expect(callMock.mock.calls.filter((c) => c[0] === "section_reorder")).toHaveLength(1);
  });

  it("각 탭이 section:<id> 드롭 대상이다", () => {
    const tabs = renderDraggable();
    expect(tabs[0].getAttribute("data-note-drop-target")).toBe("section:s1");
    expect(tabs[1].getAttribute("data-note-drop-target")).toBe("section:s2");
    // 유동 hover 배선과 같은 요소에 공존한다.
    expect(tabs[0].getAttribute("data-fh-item")).toBe("true");
  });

  it("4px 임계를 못 넘긴 누름은 드래그가 아니다 — 더블클릭 개명이 그대로 열린다", () => {
    const tabs = renderDraggable();
    elementFromPointSpy.mockReturnValue(tabs[1]);

    fireEvent.pointerDown(tabs[0], { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { clientX: 12, clientY: 11 });
    fireEvent.pointerUp(window, { clientX: 12, clientY: 11 });
    expect(callMock).not.toHaveBeenCalledWith("section_reorder", expect.anything());

    fireEvent.doubleClick(tabs[0]);
    expect((screen.getByDisplayValue("Overview") as HTMLInputElement).tagName).toBe("INPUT");
  });

  it("자기 자신 위에 놓으면 아무 일도 없다", () => {
    const tabs = renderDraggable();
    elementFromPointSpy.mockReturnValue(tabs[0]);

    fireEvent.pointerDown(tabs[0], { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { clientX: 40, clientY: 10 });
    fireEvent.pointerUp(window, { clientX: 40, clientY: 10 });
    expect(callMock).not.toHaveBeenCalledWith("section_reorder", expect.anything());
  });
});

// 오너 2026-09-24: 섹션 삭제는 데이터가 사라지는 동작이라 한 번 묻는다(PLAN-2026-09-10 D7 "확인 없음"
// 을 뒤집음). 마우스(X)·키보드(Delete)·우클릭 메뉴가 전부 같은 확인 → 같은 함수를 타고, 삭제 뒤에는
// 되돌리기 토스트가 section_restore + 원래 순서 복원으로 되살린다.
describe("SectionTabBar — 활성 섹션이 분리되면 인접 섹션으로 자동 전환", () => {
  it("새로 분리된 활성 섹션이면 오른쪽 이웃으로, 이미 분리돼 있던 채 마운트하면 그대로", async () => {
    const { useSectionWindowsStore } = await import("../../stores/sectionWindows");
    useSectionWindowsStore.setState({ ids: [] });
    const onSwitch = vi.fn();
    const note = makeTwoSectionNote();
    render(
      <SectionTabBar
        activeNote={note}
        activeSectionId="s1"
        previewItem={null}
        onSwitchSection={onSwitch}
        onDeleteSection={noop}
        onReorderSection={noop}
        onAskAi={() => {}}
      />,
    );
    expect(onSwitch).not.toHaveBeenCalled();
    act(() => useSectionWindowsStore.setState({ ids: ["s1"] }));
    await waitFor(() => expect(onSwitch).toHaveBeenCalledWith(expect.objectContaining({ id: "s2" })));
    useSectionWindowsStore.setState({ ids: [] });
  });
});

describe("SectionTabBar — 섹션 삭제는 확인 후 휴지통, 되돌리기 가능", () => {
  function Harness() {
    const sectionRef = useRef<{ id: string; body: string; kind: string } | null>(null);
    const bodyCacheRef = useRef<Record<string, string>>({});
    const { handleDeleteSection } = useSectionActions(sectionRef, noop, bodyCacheRef);
    const note = makeTwoSectionNote();
    return (
      <SectionTabBar
        activeNote={note}
        activeSectionId="s1"
        previewItem={null}
        onSwitchSection={noop}
        onDeleteSection={handleDeleteSection}
        onReorderSection={noop}
        onAskAi={() => {}}
      />
    );
  }

  beforeEach(() => {
    callMock.mockReset().mockResolvedValue({});
    emitNoticeMock.mockReset();
    useSettingsStore.setState({ aiEnabled: false } as any);
    useNotesStore.setState({
      activeNote: makeTwoSectionNote() as any,
      selectNote: vi.fn(async () => {}),
    } as never);
  });

  const confirmButton = () =>
    screen.getByRole("button", { name: t("editor.section_delete_confirm_action") });

  it("우클릭 메뉴의 '휴지통으로 이동' 은 확인을 거쳐야 section_delete 를 부른다", async () => {
    render(<Harness />);
    fireEvent.contextMenu(screen.getAllByRole("tab")[0]);
    fireEvent.click(screen.getByTestId("section-ctx-trash"));

    expect(callMock).not.toHaveBeenCalledWith("section_delete", expect.anything());
    fireEvent.click(confirmButton());
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("section_delete", { id: "s1" }));
  });

  it("탭에서 Delete 키도 같은 확인 경로이고, 취소하면 지우지 않는다", async () => {
    render(<Harness />);
    fireEvent.keyDown(screen.getAllByRole("tab")[0], { key: "Delete" });

    expect(confirmButton()).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: t("common.cancel") }));
    await waitFor(() => expect(screen.queryByTestId("modal-shell")).toBeNull());
    expect(callMock).not.toHaveBeenCalledWith("section_delete", expect.anything());
  });

  it("탭 X 는 짧은 클릭이면 안내만 하고 모달을 열지 않는다", () => {
    render(<Harness />);
    const x = screen.getAllByRole("button", { name: t("editor.delete_section") })[0];
    fireEvent.pointerDown(x, { button: 0 });
    fireEvent.pointerUp(x);
    fireEvent.click(x);
    expect(emitNoticeMock).toHaveBeenCalledWith(t("editor.delete_section_hold_hint"));
    expect(screen.queryByTestId("modal-shell")).toBeNull();
  });

  it("탭 X 를 길게 누르면 확인 모달이 뜨고, 뒤따르는 click 은 안내를 또 띄우지 않는다", async () => {
    render(<Harness />);
    const x = screen.getAllByRole("button", { name: t("editor.delete_section") })[0];
    fireEvent.pointerDown(x, { button: 0 });
    await waitFor(() => expect(confirmButton()).toBeTruthy()); // 실제 400ms 타이머
    fireEvent.pointerUp(x);
    fireEvent.click(x);
    expect(emitNoticeMock).not.toHaveBeenCalledWith(t("editor.delete_section_hold_hint"));
    expect(callMock).not.toHaveBeenCalledWith("section_delete", expect.anything());
  });

  it("삭제 뒤 되돌리기(Ctrl+Z 슬롯)가 section_restore 후 원래 순서로 되돌린다", async () => {
    render(<Harness />);
    fireEvent.keyDown(screen.getAllByRole("tab")[0], { key: "Delete" });
    fireEvent.click(confirmButton());
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("section_delete", { id: "s1" }));

    // section_restore 는 맨 뒤에 붙인다 — 복구 직후 스토어가 [s2, s1] 인 상황을 흉내 낸다.
    const restored = makeTwoSectionNote();
    useNotesStore.setState({
      activeNote: { ...restored, sections: [restored.sections[1], restored.sections[0]] } as any,
    } as never);
    const { undoLast } = await import("../../lib/undo");
    expect(undoLast()).toBe(true);

    await waitFor(() => expect(callMock).toHaveBeenCalledWith("section_restore", { id: "s1" }));
    await waitFor(() =>
      expect(callMock).toHaveBeenCalledWith("section_reorder", {
        note_id: restored.note.id,
        ordered_ids: ["s1", "s2"],
      }),
    );
  });
});

// PLAN 더보기 메뉴 개편: "내용잠금"(content_locked) — 섹션 추가/삭제 버튼 비활성화.
// F-N09 (specs/features/notes.yaml).
describe("SectionTabBar — content_locked이면 섹션 추가/삭제가 막힌다", () => {
  function LockedHarness({ locked }: { locked: boolean }) {
    const sectionRef = useRef<{ id: string; body: string; kind: string } | null>(null);
    const bodyCacheRef = useRef<Record<string, string>>({});
    const { handleDeleteSection } = useSectionActions(sectionRef, noop, bodyCacheRef);
    const note = makeTwoSectionNote();
    note.note = { ...note.note, content_locked: locked } as any;
    return (
      <>
        {/* chokepoint 자체를 UI 비활성화와 독립적으로 검증하기 위한 테스트 전용 트리거 —
            실제 UI(X 버튼/우클릭 메뉴)는 이미 disabled라 클릭이 handler에 닿지도 않는다. */}
        <button
          type="button"
          data-testid="force-delete-s1"
          onClick={() => void handleDeleteSection(note.sections[0])}
        />
        <SectionTabBar
          activeNote={note}
          activeSectionId="s1"
          previewItem={null}
          onSwitchSection={noop}
          onDeleteSection={handleDeleteSection}
          onReorderSection={noop}
          onAskAi={() => {}}
        />
      </>
    );
  }

  beforeEach(() => {
    callMock.mockReset().mockResolvedValue({});
    emitNoticeMock.mockReset();
    useSettingsStore.setState({ aiEnabled: false, uiLang: "en" } as any);
    // 잠기지 않은 케이스는 "+" 를 실제로 클릭해 PresetList 를 마운트한다 — 그 컴포넌트의 마운트
    // effect(ensureAiReachable, 실제 구현이 callSilent("settings_get_all")을 탄다)가 여기 위의
    // 단순 mockResolvedValue({}) 와 부딪히지 않도록 no-op 으로 바꿔둔다(PresetList.test.tsx와
    // 동일한 패턴 — 이 파일의 AI 관련 describe들과 독립적인 테스트로 유지하기 위함).
    useAiStore.setState({ ensureAiReachable: async () => {} } as never);
  });

  it("잠기지 않았으면 '+' 버튼과 삭제 버튼 모두 활성 상태다", () => {
    useNotesStore.setState({
      activeNote: { ...makeTwoSectionNote(), note: { ...makeTwoSectionNote().note, content_locked: false } } as any,
      selectNote: vi.fn(async () => {}),
    } as never);
    render(<LockedHarness locked={false} />);
    const plusButton = screen.getByTestId("section-tabs").lastElementChild as HTMLButtonElement;
    expect(plusButton.disabled).toBe(false);
    fireEvent.click(plusButton);
    // PresetList 메뉴가 실제로 열린다(잠겨있지 않으므로 클릭이 씹히지 않음).
    expect(screen.queryByTestId("preset-list")).not.toBeNull();
  });

  it("잠겨 있으면 '+' 버튼이 비활성 + 이유 툴팁을 보여주고 클릭해도 메뉴가 안 열린다", () => {
    useNotesStore.setState({
      activeNote: { ...makeTwoSectionNote(), note: { ...makeTwoSectionNote().note, content_locked: true } } as any,
      selectNote: vi.fn(async () => {}),
    } as never);
    render(<LockedHarness locked={true} />);
    const plusButton = screen.getByTestId("section-tabs").lastElementChild as HTMLButtonElement;
    expect(plusButton.disabled).toBe(true);
    expect(plusButton.title).toBe("Content is locked — editing disabled");
    fireEvent.click(plusButton);
    expect(screen.queryByTestId("preset-list")).toBeNull();
  });

  it("잠겨 있으면 탭의 삭제(X) 버튼 클릭이 section_delete 를 부르지 않는다", async () => {
    useNotesStore.setState({
      activeNote: { ...makeTwoSectionNote(), note: { ...makeTwoSectionNote().note, content_locked: true } } as any,
      selectNote: vi.fn(async () => {}),
    } as never);
    render(<LockedHarness locked={true} />);
    const deleteBtn = screen.getAllByLabelText("Delete this tab")[0];
    expect(deleteBtn.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(deleteBtn);
    await Promise.resolve();
    expect(callMock).not.toHaveBeenCalledWith("section_delete", expect.anything());
  });

  it("useSectionActions::handleDeleteSection 자체가 잠금이면 알림만 띄우고 삭제하지 않는다 (chokepoint — UI disabled와 무관하게)", async () => {
    useNotesStore.setState({
      activeNote: { ...makeTwoSectionNote(), note: { ...makeTwoSectionNote().note, content_locked: true } } as any,
      selectNote: vi.fn(async () => {}),
    } as never);
    render(<LockedHarness locked={true} />);
    fireEvent.click(screen.getByTestId("force-delete-s1"));
    await waitFor(() =>
      expect(emitNoticeMock).toHaveBeenCalledWith("Content is locked — editing disabled"),
    );
    expect(callMock).not.toHaveBeenCalledWith("section_delete", expect.anything());
  });
});

// W3 (PLAN-2026-09-10 D1 트리 쪽 + D3): 드래그와 우클릭이 같은 handleMoveSection 하나로 간다.
// 트리 노트 행은 `note:<id>` 대상 속성만 달고(TreeListRow.tsx) 처리는 여기 등록된 핸들러가 한다.
describe("SectionTabBar — 다른 노트로 섹션 이동 (W3)", () => {
  const selectNoteMock = vi.fn(async () => {});

  function Harness({ note }: { note: NoteDetail }) {
    const sectionRef = useRef<{ id: string; body: string; kind: string } | null>(null);
    const bodyCacheRef = useRef<Record<string, string>>({});
    const { handleMoveSection } = useSectionActions(sectionRef, noop, bodyCacheRef);
    return (
      <>
        {/* 트리 노트 행 대역 — 실제 행과 같은 드롭 대상 속성만 갖는다. */}
        <div data-testid="tree-note-2" data-note-drop-target="note:note-2" />
        <SectionTabBar
          activeNote={note}
          activeSectionId={note.sections[0].id}
          previewItem={null}
          onSwitchSection={noop}
          onDeleteSection={noop}
          onReorderSection={noop}
          onMoveSection={(s, targetNoteId) => void handleMoveSection(s.id, targetNoteId)}
          onAskAi={() => {}}
        />
      </>
    );
  }

  let elementFromPointSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    callMock.mockReset().mockImplementation((cmd: string) => {
      if (cmd === "note_query") {
        return Promise.resolve({
          notes: [
            { id: "note-2", folder_id: "f1", title: "Target note", tag_names: [] },
          ],
          total: 1,
        });
      }
      return Promise.resolve({});
    });
    emitNoticeMock.mockReset();
    selectNoteMock.mockClear();
    useSettingsStore.setState({ aiEnabled: false } as any);
    useNotesStore.setState({
      activeNote: makeTwoSectionNote() as any,
      folders: [],
      selectNote: selectNoteMock,
    } as never);
    elementFromPointSpy = vi.fn(() => null);
    (document as unknown as { elementFromPoint: unknown }).elementFromPoint = elementFromPointSpy;
  });

  it("탭을 트리 노트 행 위에 놓으면 section_move 1회 + 원 노트 재로드", async () => {
    render(<Harness note={makeTwoSectionNote()} />);
    const tabs = screen.getAllByRole("tab");
    elementFromPointSpy.mockReturnValue(screen.getByTestId("tree-note-2"));

    fireEvent.pointerDown(tabs[0], { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { clientX: 40, clientY: 60 });
    fireEvent.pointerUp(window, { clientX: 40, clientY: 60 });

    await waitFor(() =>
      expect(callMock).toHaveBeenCalledWith("section_move", { id: "s1", target_note_id: "note-2" }),
    );
    expect(callMock.mock.calls.filter((c) => c[0] === "section_move")).toHaveLength(1);
    await waitFor(() => expect(selectNoteMock).toHaveBeenCalledWith("note-1"));
    // 재정렬 경로로 새지 않았다.
    expect(callMock).not.toHaveBeenCalledWith("section_reorder", expect.anything());
  });

  it("우클릭 → 다른 노트로 이동 → 선택기에서 고르면 같은 호출", async () => {
    render(<Harness note={makeTwoSectionNote()} />);
    fireEvent.contextMenu(screen.getAllByRole("tab")[0]);
    fireEvent.click(screen.getByTestId("section-ctx-move"));

    const row = await screen.findByTestId("internal-note-row-note-2");
    fireEvent.click(row);

    await waitFor(() =>
      expect(callMock).toHaveBeenCalledWith("section_move", { id: "s1", target_note_id: "note-2" }),
    );
    await waitFor(() => expect(selectNoteMock).toHaveBeenCalledWith("note-1"));
  });

  it("유일 섹션이면 백엔드 CONFLICT 로 끝난다 — 낙관적 갱신이 없어 화면은 원상", async () => {
    callMock.mockImplementation((cmd: string) =>
      cmd === "section_move" ? Promise.reject(new Error("CONFLICT")) : Promise.resolve({}),
    );
    const one = makeNote();
    useNotesStore.setState({ activeNote: one as any } as never);
    render(<Harness note={one} />);
    const tabs = screen.getAllByRole("tab");
    elementFromPointSpy.mockReturnValue(screen.getByTestId("tree-note-2"));

    fireEvent.pointerDown(tabs[0], { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { clientX: 40, clientY: 60 });
    fireEvent.pointerUp(window, { clientX: 40, clientY: 60 });

    await waitFor(() =>
      expect(callMock).toHaveBeenCalledWith("section_move", { id: "s1", target_note_id: "note-2" }),
    );
    // 실패했으니 재로드도 없고, 탭도 그대로 서 있다(토스트는 call() 이 띄운다).
    expect(selectNoteMock).not.toHaveBeenCalled();
    expect(useNotesStore.getState().activeNote?.sections.map((s) => s.id)).toEqual(["s1"]);
    expect(screen.getAllByRole("tab")).toHaveLength(1);
  });
});

// 섹션 탭을 미리보기 카드(preview:card)에 드롭하면 그 섹션이 미리보기에 고정된다(오너
// 2026-09-10 — 첨부 바의 시트 파생 타일을 대신하는 진입점, docs/NOTES.md). IPC 없는 순수 UI
// 상태라 section_move/section_reorder 와 달리 call() 이 아니라 useUiStore.previewItem 만 본다.
describe("SectionTabBar — 미리보기 카드에 드롭하면 고정", () => {
  function Harness({ note }: { note: NoteDetail }) {
    const sectionRef = useRef<{ id: string; body: string; kind: string } | null>(null);
    const bodyCacheRef = useRef<Record<string, string>>({});
    useSectionActions(sectionRef, noop, bodyCacheRef);
    return (
      <>
        {/* SourcePanel 의 실제 카드 대역 — 같은 드롭 대상 속성만 갖는다. */}
        <div data-testid="preview-card" data-note-drop-target="preview:card" />
        <SectionTabBar
          activeNote={note}
          activeSectionId={note.sections[0].id}
          previewItem={null}
          onSwitchSection={noop}
          onDeleteSection={noop}
          onReorderSection={noop}
          onAskAi={() => {}}
        />
      </>
    );
  }

  let elementFromPointSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    callMock.mockReset().mockResolvedValue({});
    emitNoticeMock.mockReset();
    useSettingsStore.setState({ aiEnabled: false } as any);
    useUiStore.setState({ previewItem: null } as any);
    const note = makeTwoSectionNote();
    useNotesStore.setState({ activeNote: note as any } as never);
    elementFromPointSpy = vi.fn(() => null);
    (document as unknown as { elementFromPoint: unknown }).elementFromPoint = elementFromPointSpy;
  });

  it("탭을 미리보기 카드 위에 놓으면 previewItem 이 그 섹션으로 고정되고 IPC 는 안 탄다", async () => {
    render(<Harness note={makeTwoSectionNote()} />);
    const tabs = screen.getAllByRole("tab");
    elementFromPointSpy.mockReturnValue(screen.getByTestId("preview-card"));

    fireEvent.pointerDown(tabs[0], { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { clientX: 40, clientY: 60 });
    fireEvent.pointerUp(window, { clientX: 40, clientY: 60 });

    await waitFor(() =>
      expect(useUiStore.getState().previewItem).toEqual({ kind: "section", noteId: "note-1", sectionId: "s1" }),
    );
    expect(callMock).not.toHaveBeenCalledWith("section_move", expect.anything());
    expect(callMock).not.toHaveBeenCalledWith("section_reorder", expect.anything());
  });
});

describe("SectionTabBar — 섹션 분리 창(1단계)", () => {
  beforeEach(async () => {
    callMock.mockReset();
    callMock.mockResolvedValue({});
    flushAllMock.mockClear();
    const { useSectionWindowsStore } = await import("../../stores/sectionWindows");
    useSectionWindowsStore.setState({ ids: [] });
  });

  it("우클릭 → 새 창에서 열기: 미저장 편집을 먼저 내보낸 뒤 section_window_open", async () => {
    const order: string[] = [];
    flushAllMock.mockImplementation(async () => {
      order.push("flush");
    });
    callMock.mockImplementation(async (cmd: string) => {
      order.push(cmd);
      return {};
    });
    renderBar();
    fireEvent.contextMenu(screen.getAllByRole("tab")[0]);
    fireEvent.click(screen.getByTestId("section-ctx-open-window"));
    await waitFor(() =>
      expect(callMock).toHaveBeenCalledWith("section_window_open", {
        note_id: "note-1",
        section_id: "s1",
        title: "Overview — Note 1",
      }),
    );
    expect(order.indexOf("flush")).toBeLessThan(order.indexOf("section_window_open"));
  });

  it("분리된 섹션 탭은 창 아이콘을 단다", async () => {
    const { useSectionWindowsStore } = await import("../../stores/sectionWindows");
    renderBar({ note: makeTwoSectionNote() });
    expect(screen.queryByTestId("section-detached-icon")).toBeNull();
    act(() => useSectionWindowsStore.setState({ ids: ["s2"] }));
    const tabs = screen.getAllByRole("tab");
    expect(tabs[1].getAttribute("data-detached")).toBe("true");
    expect(tabs[0].getAttribute("data-detached")).toBeNull();
    expect(screen.getAllByTestId("section-detached-icon")).toHaveLength(1);
  });
});
