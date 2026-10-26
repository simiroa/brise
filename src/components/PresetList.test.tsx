import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PresetList } from "./PresetList";
import { useSettingsStore } from "../stores/settings";
import { useAiStore } from "../stores/ai";
import { usePresetsStore } from "../stores/presets";
import { useAiPresetsStore } from "../stores/aiPresets";
import { t } from "../i18n/t";
import { applyPreset, applyDiagramPreset } from "../lib/presetBridge";
import { insertAiSection } from "../lib/aiSectionBridge";
import { useNotesStore } from "../stores/notes";
import { runAiAction } from "../stores/runAiAction";
import { runMetadataProposal } from "./AskAiModal";
import { DIAGRAM_PRESET_SEED } from "./diagram/diagramStarter";

// PLAN-2026-09-21 W1: strips(어시스트) 분기는 assist/AssistPanel.tsx 로 옮겼다(테스트는
// assist/AssistPanel.test.tsx). 이 파일엔 variant="menu"(탭바 "+")·mode="manage"(관리 모달) 케이스만
// 남는다 — PresetList 는 이제 그 두 자리 전용이다.

// 빈 노트 → 새 빈 섹션 경로가 부르는 유일한 함수만 목한다 (실 구현은 EditorPanel 등록 필요).
vi.mock("../lib/aiSectionBridge", () => ({
  insertAiSection: vi.fn().mockResolvedValue(null),
  getActiveSection: vi.fn(() => null),
  getDiagramTarget: vi.fn(() => null),
}));

vi.mock("../lib/invoke", () => ({
  call: vi.fn(async () => ({})),
  callSilent: vi.fn(async () => ({})),
  registerFlush: () => () => {},
  flushAll: vi.fn(async () => {}),
  emitNotice: vi.fn(),
}));

vi.mock("../stores/runAiAction", () => ({
  runAiAction: vi.fn().mockResolvedValue(true),
  runTranslateAction: vi.fn().mockResolvedValue(undefined),
  generateDiagramWithRepair: vi.fn().mockResolvedValue({ ok: false, attempts: 0, errors: ["mock"] }),
}));

vi.mock("./PromptDialog", () => ({
  PromptDialog: () => null,
}));

vi.mock("./AskAiModal", () => ({
  runMetadataProposal: vi.fn().mockResolvedValue(undefined),
  runTagsProposal: vi.fn().mockResolvedValue(undefined),
  runNoteSummary: vi.fn().mockResolvedValue(undefined),
  AskAiModal: ({ target }: { target: { kind: string; initialPrompt?: string } }) => (
    <div data-testid="ask-ai-modal" data-target-kind={target.kind} data-initial-prompt={target.initialPrompt} />
  ),
}));

// applyDiagramPreset/applyPreset — usePresetEntries 가 부르는 실제 브리지를 스파이로 바꾼다
// (기본 구현은 no-op 이라 안전하긴 하지만 "무엇을 넘겼는지" 확인엔 스파이가 필요하다).
vi.mock("../lib/presetBridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/presetBridge")>();
  return {
    ...actual,
    applyPreset: vi.fn().mockResolvedValue(undefined),
    applyDiagramPreset: vi.fn().mockResolvedValue(undefined),
  };
});

describe("PresetList component", () => {
  beforeEach(() => {
    vi.mocked(applyPreset).mockClear();
    vi.mocked(runAiAction).mockClear();
    vi.mocked(runMetadataProposal).mockClear();
    useAiPresetsStore.setState({ list: [], loaded: true, load: async () => {} } as never);
    useSettingsStore.setState({ aiEnabled: false } as never);
    useAiStore.setState({
      aiReachable: null,
      ensureAiReachable: async () => {},
      generateFromPrompt: async () => null,
    } as never);
    usePresetsStore.setState({
      customPresets: [],
      hiddenBuiltinIds: [],
      loaded: true,
      load: async () => {},
      targetState: "ready",
      activeEditorKind: "text",
      setHovered: vi.fn(),
      clearHovered: vi.fn(),
    } as never);
  });

  it("kind:'template' 통합 프리셋도 노트 프리셋 목록에 뜨고, 클릭하면 prompt 가 본문으로 적용된다", () => {
    useAiPresetsStore.setState({
      loaded: true,
      load: async () => {},
      list: [
        { id: "list", name: "리스트로 만들기", prompt: "P", kind: "text", isBuiltin: true, hidden: false },
        { id: "tpl-1", name: "주간 회고", prompt: "## 잘한 것\n\n", kind: "template", isBuiltin: false, hidden: false },
        { id: "tpl-hidden", name: "숨긴 템플릿", prompt: "x", kind: "template", isBuiltin: false, hidden: true },
      ],
    } as never);
    render(<PresetList mode="manage" />);

    // 변환 액션(text kind)은 여기 목록이 아니다 — 템플릿만 온다.
    expect(screen.queryByText("리스트로 만들기")).toBeNull();
    expect(screen.queryByText("숨긴 템플릿")).toBeNull();
    expect(screen.getByText("주간 회고")).toBeTruthy();

    // manage 모드는 '적용'이 없다 — 템플릿 행(맨 마지막)의 "만들기" → 새 노트.
    const makeButtons = screen.getAllByText(t("presets.make"));
    fireEvent.click(makeButtons[makeButtons.length - 1]);
    fireEvent.click(screen.getByTestId("preset-make-new-note"));
    expect(applyPreset).toHaveBeenCalledWith(
      expect.objectContaining({ title: null, bodyMd: "## 잘한 것\n\n" })
    );
  });

  it("onApplied 는 프리셋이 실제로 적용된 뒤에만 불린다(모달 자동 닫기용)", () => {
    const onApplied = vi.fn();
    render(<PresetList variant="menu" onApplied={onApplied} />);
    expect(onApplied).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText(t("presets.blank_menu_name")));
    expect(onApplied).toHaveBeenCalledTimes(1);
  });

  it("W8-f: clicking 관계도 goes through applyDiagramPreset (a diagram section), not the plain-text applyPreset bridge", async () => {
    render(<PresetList variant="menu" />);
    fireEvent.click(screen.getByText(t("presets.diagram_name")));
    await vi.waitFor(() => {
      expect(applyDiagramPreset).toHaveBeenCalledTimes(1);
    });
    expect(applyDiagramPreset).toHaveBeenCalledWith(
      expect.objectContaining({ title: null, sectionName: t("presets.diagram_name") })
    );
    const call = vi.mocked(applyDiagramPreset).mock.calls[0][0];
    expect(call.bodyMd).toBe(DIAGRAM_PRESET_SEED);
  });

  it("어시스트 패널(panel): 열린 노트에 append 되면 renameOnInsert, 노트 없음/초안이면 아님", async () => {
    vi.mocked(applyDiagramPreset).mockClear();
    useNotesStore.setState({ activeNote: { note: { id: "n1", title: "여행" }, sections: [] }, activeDraft: false } as never);
    const { unmount } = render(<PresetList />);
    fireEvent.click(screen.getByText(t("presets.diagram_mindmap_name")));
    await vi.waitFor(() => expect(applyDiagramPreset).toHaveBeenCalledTimes(1));
    expect(vi.mocked(applyDiagramPreset).mock.calls[0][0].renameOnInsert).toBe(true);
    unmount();

    vi.mocked(applyDiagramPreset).mockClear();
    useNotesStore.setState({ activeNote: null, activeDraft: false } as never);
    render(<PresetList />);
    fireEvent.click(screen.getByText(t("presets.diagram_mindmap_name")));
    await vi.waitFor(() => expect(applyDiagramPreset).toHaveBeenCalledTimes(1));
    expect(vi.mocked(applyDiagramPreset).mock.calls[0][0].renameOnInsert).toBe(false);
  });

  it("manage mode: a hidden builtin id disappears from the list", () => {
    usePresetsStore.setState({ hiddenBuiltinIds: ["blank", "diagram"] } as never);
    render(<PresetList mode="manage" />);
    expect(screen.queryByText(t("presets.blank_name"))).toBeNull();
    expect(screen.queryByText(t("presets.diagram_name"))).toBeNull();
    // Everything else stays.
    expect(screen.getByText(t("presets.todo_name"))).toBeTruthy();
    expect(screen.getByText(t("presets.daily_name"))).toBeTruthy();
  });

  it("manage mode: 'restore hidden' only shows when something is hidden, and calls the store action", () => {
    const restoreHiddenBuiltins = vi.fn().mockResolvedValue(undefined);
    usePresetsStore.setState({ hiddenBuiltinIds: [], restoreHiddenBuiltins } as never);
    const { rerender } = render(<PresetList mode="manage" />);
    expect(screen.queryByText(t("presets.restore_hidden_builtins"))).toBeNull();

    usePresetsStore.setState({ hiddenBuiltinIds: ["blank"], restoreHiddenBuiltins } as never);
    rerender(<PresetList mode="manage" />);
    const restoreBtn = screen.getByText(t("presets.restore_hidden_builtins"));
    fireEvent.click(restoreBtn);
    expect(restoreHiddenBuiltins).toHaveBeenCalledTimes(1);
  });

  it("manage mode: a locked builtin row gets a 제거 (trash) button too, picker mode does not", () => {
    usePresetsStore.setState({ hiddenBuiltinIds: [] } as never);
    const { unmount } = render(<PresetList mode="manage" />);
    // Every builtin row's remove button shares the same aria-label (t("ctx.remove")) as custom
    // rows' — 12 locked rows in manage mode.
    expect(screen.getAllByLabelText(t("ctx.remove")).length).toBe(12);
    unmount();

    render(<PresetList mode="picker" />);
    expect(screen.queryByLabelText(t("ctx.remove"))).toBeNull();
  });

  // ── manage 모드 탭 (PLAN-2026-08-30 §3 W4 — AI 프리셋을 프리셋 관리 모달로) ──────────────────
  describe("manage mode — '노트 프리셋' / 'AI 액션' 탭", () => {
    it("manage 모드만 탭 2개를 보여주고 기본은 '노트 프리셋'이다 — menu는 탭이 아예 없다", () => {
      const { unmount } = render(<PresetList mode="manage" />);
      expect(screen.getByTestId("preset-manage-tab-notes")).toBeTruthy();
      expect(screen.getByTestId("preset-manage-tab-ai-actions")).toBeTruthy();
      expect(screen.getByTestId("note-templates-group")).toBeTruthy();
      expect(screen.queryByTestId("ai-action-editor")).toBeNull();
      unmount();

      render(<PresetList variant="menu" />);
      expect(screen.queryByTestId("preset-manage-tab-notes")).toBeNull();
    });

    it("'AI 액션' 탭을 누르면 AiActionEditor가 뜨고 '노트 프리셋' 목록은 사라지며, 되돌아가면 원상복구된다", () => {
      useAiPresetsStore.setState({
        loaded: true,
        load: async () => {},
        list: [{ id: "list", name: "리스트로 만들기", prompt: "P1", kind: "text", isBuiltin: true, hidden: false }],
      } as never);
      render(<PresetList mode="manage" />);

      fireEvent.click(screen.getByTestId("preset-manage-tab-ai-actions"));
      expect(screen.getByTestId("ai-action-editor")).toBeTruthy();
      expect(screen.queryByTestId("note-templates-group")).toBeNull();

      fireEvent.click(screen.getByTestId("preset-manage-tab-notes"));
      expect(screen.getByTestId("note-templates-group")).toBeTruthy();
      expect(screen.queryByTestId("ai-action-editor")).toBeNull();
    });

    it("initialManageTab='ai_actions'면 처음부터 'AI 액션' 탭으로 연다(설정의 진입점)", () => {
      useAiPresetsStore.setState({
        loaded: true,
        load: async () => {},
        list: [{ id: "list", name: "리스트로 만들기", prompt: "P1", kind: "text", isBuiltin: true, hidden: false }],
      } as never);
      render(<PresetList mode="manage" initialManageTab="ai_actions" />);
      expect(screen.getByTestId("ai-action-editor")).toBeTruthy();
      expect(screen.queryByTestId("note-templates-group")).toBeNull();
    });
  });

  it("manage mode: '적용'은 '만들기'로 바뀌고, '새 노트로 만들기'는 landing:'new-note'로 applyPreset 을 부른다", () => {
    render(<PresetList mode="manage" />);
    expect(screen.queryByText(t("common.apply"))).toBeNull();
    // 첫 행 = 빈 노트(builtinRows 선두).
    fireEvent.click(screen.getAllByText(t("presets.make"))[0]);
    fireEvent.click(screen.getByTestId("preset-make-new-note"));
    expect(applyPreset).toHaveBeenCalledWith(
      expect.objectContaining({ title: null, landing: "new-note" })
    );
  });

  it("manage mode: '새 섹션으로 추가'는 열린 노트가 없으면 비활성이고, 있으면 landing:'new-section' 으로 간다", () => {
    useNotesStore.setState({ activeNote: null, activeDraft: false } as never);
    const { unmount } = render(<PresetList mode="manage" />);
    fireEvent.click(screen.getAllByText(t("presets.make"))[0]);
    const secBtn = screen.getByTestId("preset-make-new-section") as HTMLButtonElement;
    expect(secBtn.disabled).toBe(true);
    fireEvent.click(secBtn);
    expect(applyPreset).not.toHaveBeenCalled();
    unmount();

    useNotesStore.setState({
      activeNote: { note: { id: "n1", title: "여행" }, sections: [] },
      activeDraft: false,
    } as never);
    try {
      render(<PresetList mode="manage" />);
      // 두 번째 행 = 할 일(본문 있는 빌트인) — blank 특례를 피하려고.
      fireEvent.click(screen.getAllByText(t("presets.make"))[1]);
      const secBtn2 = screen.getByTestId("preset-make-new-section") as HTMLButtonElement;
      expect(secBtn2.disabled).toBe(false);
      fireEvent.click(secBtn2);
      expect(applyPreset).toHaveBeenCalledWith(
        expect.objectContaining({ title: null, landing: "new-section" })
      );
    } finally {
      useNotesStore.setState({ activeNote: null, activeDraft: false } as never);
    }
  });

  it("manage mode: '빈 노트'의 새 섹션은 applyPreset 을 거치지 않고 빈 섹션 삽입으로 직행한다", () => {
    vi.mocked(insertAiSection).mockClear();
    useNotesStore.setState({
      activeNote: { note: { id: "n1", title: "여행" }, sections: [] },
      activeDraft: false,
    } as never);
    try {
      render(<PresetList mode="manage" />);
      fireEvent.click(screen.getAllByText(t("presets.make"))[0]);
      fireEvent.click(screen.getByTestId("preset-make-new-section"));
      expect(insertAiSection).toHaveBeenCalledWith(
        t("presets.new_section_name"), "", "n1", undefined, { postProcess: false });
      expect(applyPreset).not.toHaveBeenCalled();
    } finally {
      useNotesStore.setState({ activeNote: null, activeDraft: false } as never);
    }
  });

  // 오너 2026-08-19: "+" 새 섹션 메뉴는 **종류**만 고르는 자리(빈 노트·관계도·시트). 내용
  // 템플릿(가계부·할 일·커스텀·AI 템플릿)은 어시스트가 맡는다.
  it("variant='menu' shows only the three section kinds — 가계부/할 일 같은 내용 템플릿은 빼고", () => {
    render(<PresetList variant="menu" />);
    expect(screen.getByText(t("presets.blank_menu_name"))).toBeTruthy();
    expect(screen.getByText(t("presets.diagram_name"))).toBeTruthy();
    expect(screen.getByText(t("presets.sheet_name"))).toBeTruthy();
    expect(screen.queryByText(t("presets.budget_name"))).toBeNull();
    expect(screen.queryByText(t("presets.todo_name"))).toBeNull();
  });

  it('variant="menu"/mode="manage" 는 절대 .assist-row(어시스트 전용 한 줄 리스트)를 그리지 않는다 — 그건 AssistPanel 몫', () => {
    const { unmount } = render(<PresetList variant="menu" />);
    expect(document.querySelectorAll(".assist-row").length).toBe(0);
    unmount();

    render(<PresetList mode="manage" />);
    expect(document.querySelectorAll(".assist-row").length).toBe(0);
  });

  it("커스텀 프리셋 칩 우클릭 메뉴에 '아이콘 · 색' 이 있고, 누르면 아이콘 팔레트 + 색 스와치가 뜬다", () => {
    usePresetsStore.setState({
      customPresets: [{ id: "c1", name: "내 템플릿", bodyMd: "x" }],
      setStyle: vi.fn().mockResolvedValue(undefined),
    } as never);
    render(<PresetList mode="manage" />);

    fireEvent.contextMenu(screen.getByText("내 템플릿"));
    expect(screen.queryByText(t("presets.style_title"))).toBeNull(); // manage 모드는 버튼이 대신하므로 우클릭 메뉴가 없다
  });

  it("picker(기본) 모드의 커스텀 프리셋은 우클릭 메뉴로 아이콘·색을 바꿀 수 있다", () => {
    usePresetsStore.setState({
      customPresets: [{ id: "c1", name: "내 템플릿", bodyMd: "x" }],
      setStyle: vi.fn().mockResolvedValue(undefined),
    } as never);
    render(<PresetList />);

    fireEvent.contextMenu(screen.getByText("내 템플릿"));
    fireEvent.click(screen.getByText(t("presets.style_title")));

    const pop = screen.getByTestId("preset-style-popover");
    expect(pop).toBeTruthy();
    expect(screen.getByLabelText(t("ctx.icon_default"))).toBeTruthy();

    fireEvent.click(screen.getByLabelText("book"));
    expect(usePresetsStore.getState().setStyle).toHaveBeenCalledWith("c1", { icon: "book" });
  });

  it("hover hands the ghost its BODY, not just an id", () => {
    render(<PresetList variant="menu" />);
    fireEvent.mouseEnter(screen.getByText(t("presets.blank_menu_name")));
    expect(usePresetsStore.getState().setHovered).toHaveBeenCalledWith("blank", "");
  });

  it("unmount clears ONLY this instance's hover (React fires no mouseleave when the hovered row unmounts mid-hover; the store is a global singleton shared with other PresetLists)", () => {
    const { unmount } = render(<PresetList variant="menu" />);
    fireEvent.mouseEnter(screen.getByText(t("presets.blank_menu_name")));
    unmount();
    expect(usePresetsStore.getState().clearHovered).toHaveBeenCalledWith("blank");
  });

  it('variant="menu"(섹션 + 메뉴)는 노트에 내용이 있어도 언제나 프리셋 목록 — 어시스트도 AI FAB도 없다', () => {
    useSettingsStore.setState({ aiEnabled: true } as never);
    useAiStore.setState({ aiReachable: true } as never);
    usePresetsStore.setState({ targetState: "has_content" } as never);
    render(<PresetList variant="menu" />);

    expect(screen.queryByTestId("note-assist")).toBeNull();
    expect(screen.getByTestId("note-templates-group")).toBeTruthy();
    expect(screen.queryByTestId("assist-ai-fab")).toBeNull();
  });
});
