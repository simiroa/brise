import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AssistPanel } from "./AssistPanel";
import { useSettingsStore } from "../../stores/settings";
import { useAiStore } from "../../stores/ai";
import { usePresetsStore } from "../../stores/presets";
import { useAiPresetsStore, builtinDefaults } from "../../stores/aiPresets";
import { t } from "../../i18n/t";
import { applyPreset, applyDiagramPreset } from "../../lib/presetBridge";
import { useNotesStore } from "../../stores/notes";
import { runTranslateAction, generateDiagramWithRepair, runAiAction } from "../../stores/runAiAction";
import { runMetadataProposal, runTagsProposal, runNoteSummary } from "../AskAiModal";
import { emitNotice } from "../../lib/invoke";
import { diagramTemplateSource } from "../diagram/diagramStarter";
import { DIAGRAM_TYPES } from "../diagram/types/registry";
import { useSheetFocus } from "../../stores/sheetFocus";
import { emptySheet, type SheetDoc } from "../../lib/sheet/types";
import { SheetEngine } from "../../lib/sheet/engine";
import * as addChartMod from "../../lib/sheet/addChart";
import { useDiagramFocus } from "../../stores/diagramFocus";
import { runAutoFootnoteAction } from "../editor/autoFootnote";
import { AskAiModal as LazyAskAiModal, SheetAssist as LazySheetAssist, TextAssist as LazyTextAssist } from "../../lazySurfaces";

// 이 화면들은 지연 청크다(lazySurfaces) — 앱이 유휴 시간에 미리 받듯 여기서 미리 받아 클릭 직후 바로 그려지게 한다.
beforeAll(async () => {
  await Promise.all([LazyAskAiModal.preload(), LazyTextAssist.preload(), LazySheetAssist.preload()]);
}, 30_000);

// PLAN-2026-09-21 W1 — PresetList.tsx 의 strips 분기가 여기로 옮겨왔다. mock 구성은 원본 그대로
// (경로만 assist/ 한 단계 아래로 조정).

vi.mock("../../lib/aiSectionBridge", () => ({
  insertAiSection: vi.fn().mockResolvedValue(null),
  getActiveSection: vi.fn(() => null),
  getActiveEditor: vi.fn(() => null),
  getDiagramTarget: vi.fn(() => null),
}));

vi.mock("../../lib/invoke", () => ({
  call: vi.fn(async () => ({})),
  callSilent: vi.fn(async () => ({})),
  registerFlush: () => () => {},
  flushAll: vi.fn(async () => {}),
  emitNotice: vi.fn(),
}));

vi.mock("../../stores/runAiAction", () => ({
  runAiAction: vi.fn().mockResolvedValue(true),
  runTranslateAction: vi.fn().mockResolvedValue(undefined),
  generateDiagramWithRepair: vi.fn().mockResolvedValue({ ok: false, attempts: 0, errors: ["mock"] }),
}));

vi.mock("../PromptDialog", () => ({
  PromptDialog: () => null,
}));

// 자동 각주(호출자 0개 발굴, AUDIT-2026-09-22 후속) — 자체 토스트/에러 처리를 갖고 있으므로 여기선
// 어시스트 행이 이 함수를 부르는지만 본다(구현은 autoFootnote.test.ts 가 덮는다).
vi.mock("../editor/autoFootnote", () => ({
  runAutoFootnoteAction: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../AskAiModal", () => ({
  runMetadataProposal: vi.fn().mockResolvedValue(undefined),
  runTagsProposal: vi.fn().mockResolvedValue(undefined),
  runNoteSummary: vi.fn().mockResolvedValue(undefined),
  AskAiModal: ({ target }: { target: { kind: string; initialPrompt?: string; presetId?: string; autoSend?: boolean } }) => (
    <div
      data-testid="ask-ai-modal"
      data-target-kind={target.kind}
      data-initial-prompt={target.initialPrompt}
      data-preset-id={target.presetId}
      data-auto-send={target.autoSend ? "true" : "false"}
    />
  ),
}));

vi.mock("../../lib/presetBridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/presetBridge")>();
  return {
    ...actual,
    applyPreset: vi.fn().mockResolvedValue(undefined),
    applyDiagramPreset: vi.fn().mockResolvedValue(undefined),
  };
});

function resetStores() {
  useAiPresetsStore.setState({ list: builtinDefaults(), loaded: true, load: async () => {} } as never);
  useSettingsStore.setState({ aiEnabled: false, assistPresetAutorun: false } as never);
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
  useNotesStore.setState({ activeNote: null, activeDraft: false } as never);
}

describe("AssistPanel", () => {
  beforeEach(() => {
    vi.mocked(applyPreset).mockClear();
    vi.mocked(applyDiagramPreset).mockClear();
    vi.mocked(runMetadataProposal).mockClear();
    vi.mocked(runTagsProposal).mockClear();
    vi.mocked(runNoteSummary).mockClear();
    vi.mocked(runTranslateAction).mockClear();
    vi.mocked(runAutoFootnoteAction).mockClear();
    vi.mocked(runAiAction).mockClear();
    resetStores();
  });

  // 목표 매트릭스(PLAN-2026-09-21-assist-modes.md §2) — 판정은 {kind, blank} 두 축뿐이다.
  // check-features.mjs 의 covered_by 매칭은 `it("리터럴 제목", ...)` 형태만 찾는다(it.each 의
  // 두 단계 호출 `it.each(table)("title", fn)` 은 "it(" 바로 뒤에 제목이 오지 않아 못 찾는다) —
  // 그래서 표는 그대로 두고 6개를 `it()` 로 펼쳐 각자 리터럴 제목을 준다.
  // 목표 매트릭스(PLAN-2026-09-21-assist-modes.md §2, PLAN-2026-09-27 §7-4) — 판정은 {kind, blank} 두 축.
  // W5: assist-ai-sheet-edit 및 assist-ai-diagram-edit 등 더미 행 제거, 단일 목록으로 일원화.
  const ASSIST_MATRIX = [
    ["text", true,
      ["assist-ai-prompt-start"],
      ["note-assist", "assist-ai-spellcheck", "diagram-type-groups", "sheet-explore-group"]],
    ["text", false,
      ["note-assist", "assist-ai-spellcheck", "assist-ai-reorganize-list", "assist-ai-metadata", "assist-ai-tags", "assist-ai-summary", "assist-ai-translate"],
      ["assist-ai-prompt-start"]],
    ["sheet", true,
      ["assist-ai-sheet-start"],
      ["note-assist", "sheet-explore-group", "diagram-type-groups"]],
    ["sheet", false,
      ["note-assist", "assist-ai-sheet-formula-helper", "assist-ai-sheet-summary-row", "assist-ai-sheet-format"],
      ["assist-ai-sheet-start"]],
    ["diagram", true,
      ["diagram-type-groups", "diagram-type-group-structure", "diagram-type-group-flow", "diagram-type-group-state", "diagram-type-group-layout", "diagram-type-people"],
      ["note-assist", "assist-ai-diagram-start"]],
    ["diagram", false,
      ["note-assist", "assist-ai-diagram-add-node", "assist-ai-diagram-simplify", "assist-ai-diagram-layout"],
      ["diagram-type-groups"]],
  ] as const;

  function runMatrixRow(kind: "text" | "sheet" | "diagram", blank: boolean, visible: readonly string[], hidden: readonly string[]) {
    const targetState = blank ? "ready" : kind === "text" ? "has_content" : kind;
    usePresetsStore.setState({ targetState, activeEditorKind: kind } as never);
    render(<AssistPanel />);
    for (const id of visible) expect(screen.getByTestId(id)).toBeTruthy();
    for (const id of hidden) expect(screen.queryByTestId(id)).toBeNull();
  }

  it("text × blank=true renders the right assist rows", () => runMatrixRow(...ASSIST_MATRIX[0]));
  it("text × blank=false renders the right assist rows", () => runMatrixRow(...ASSIST_MATRIX[1]));
  it("sheet × blank=true renders the right assist rows", () => runMatrixRow(...ASSIST_MATRIX[2]));
  it("sheet × blank=false renders the right assist rows", () => runMatrixRow(...ASSIST_MATRIX[3]));
  it("diagram × blank=true renders the right assist rows", () => runMatrixRow(...ASSIST_MATRIX[4]));
  it("diagram × blank=false renders the right assist rows", () => runMatrixRow(...ASSIST_MATRIX[5]));

  // ── 텍스트 · 작업(has_content) — AI 프리셋 모달 오픈 & 바로 실행 ──────────────────────────────────────────
  describe("텍스트 어시스트 · 작업 모드", () => {
    beforeEach(() => {
      useSettingsStore.setState({ aiEnabled: true, assistPresetAutorun: false } as never);
      useAiStore.setState({ aiReachable: true } as never);
      usePresetsStore.setState({ targetState: "has_content", activeEditorKind: "text" } as never);
      useNotesStore.setState({
        activeNote: { note: { id: "n1", title: "여행" }, sections: [] },
        activeDraft: false,
      } as never);
    });

    it("메타데이터/태그/요약/번역 액션 클릭 시 AI 모달이 해당 presetId 와 함께 열린다 (기본 autoSend: false)", () => {
      render(<AssistPanel />);
      fireEvent.click(screen.getByTestId("assist-ai-metadata"));
      expect(screen.getByTestId("ask-ai-modal").getAttribute("data-preset-id")).toBe("metadata");
      expect(screen.getByTestId("ask-ai-modal").getAttribute("data-auto-send")).toBe("false");

      fireEvent.click(screen.getByTestId("assist-ai-tags"));
      expect(screen.getByTestId("ask-ai-modal").getAttribute("data-preset-id")).toBe("tags");
      expect(screen.getByTestId("ask-ai-modal").getAttribute("data-auto-send")).toBe("false");

      fireEvent.click(screen.getByTestId("assist-ai-summary"));
      expect(screen.getByTestId("ask-ai-modal").getAttribute("data-preset-id")).toBe("summarize");
      expect(screen.getByTestId("ask-ai-modal").getAttribute("data-auto-send")).toBe("false");

      fireEvent.click(screen.getByTestId("assist-ai-translate"));
      expect(screen.getByTestId("ask-ai-modal").getAttribute("data-preset-id")).toBe("translate");
      expect(screen.getByTestId("ask-ai-modal").getAttribute("data-auto-send")).toBe("false");
    });

    it("바로 실행(assist_preset_autorun)이 켜지면 클릭 시 autoSend: true 로 AI 모달이 열린다", () => {
      useSettingsStore.setState({ assistPresetAutorun: true } as never);
      render(<AssistPanel />);
      fireEvent.click(screen.getByTestId("assist-ai-summary"));
      expect(screen.getByTestId("ask-ai-modal").getAttribute("data-preset-id")).toBe("summarize");
      expect(screen.getByTestId("ask-ai-modal").getAttribute("data-auto-send")).toBe("true");
    });

    it("AI 액션 헤더의 바로 실행 토글을 누르면 assistPresetAutorun 설정이 변경된다", () => {
      render(<AssistPanel />);
      const toggle = screen.getByTestId("assist-preset-autorun-toggle");
      expect(toggle.getAttribute("aria-checked")).toBe("false");
      fireEvent.click(toggle);
      expect(useSettingsStore.getState().assistPresetAutorun).toBe(true);
    });

    // 도구 항목 자동 각주(PLAN-2026-09-27 §7-4, Q10) — 어시스트 패널에서 누르면 문장 찍힌 AI 모달 오픈
    it("자동 각주 행이 있고, 클릭하면 auto_footnote presetId로 AI 모달이 열린다", () => {
      render(<AssistPanel />);
      expect(screen.getByTestId("assist-ai-auto-footnote")).toBeTruthy();
      fireEvent.click(screen.getByTestId("assist-ai-auto-footnote"));
      expect(screen.getByTestId("ask-ai-modal").getAttribute("data-preset-id")).toBe("auto_footnote");
    });

    it("어시스트 행에 AI Glow(data-ai-glow='active')가 활성화될 때 속성이 반영된다", () => {
      const targets = new Map<string, "active" | "fading">();
      targets.set("action:metadata", "active");
      useAiStore.setState({ aiGlowTargets: targets } as never);
      try {
        render(<AssistPanel />);
        const metaBtn = screen.getByTestId("assist-ai-metadata");
        expect(metaBtn.getAttribute("data-ai-glow")).toBe("active");
        expect(metaBtn.getAttribute("data-ai-glow-inset")).toBe("true");
        const tagsBtn = screen.getByTestId("assist-ai-tags");
        expect(tagsBtn.getAttribute("data-ai-glow")).toBeNull();
      } finally {
        useAiStore.setState({ aiGlowTargets: new Map() } as never);
      }
    });

    it("맞춤법 교정 클릭 시 proofread presetId로 AI 모달이 열린다", () => {
      render(<AssistPanel />);
      fireEvent.click(screen.getByTestId("assist-ai-spellcheck"));
      expect(screen.getByTestId("ask-ai-modal").getAttribute("data-preset-id")).toBe("proofread");
    });
  });

  // ── 텍스트 · 시작(ready) — 마크다운 템플릿 + 커스텀 위계 ────────────────────────────────────
  describe("텍스트 어시스트 · 시작 모드", () => {
    beforeEach(() => {
      usePresetsStore.setState({ targetState: "ready", activeEditorKind: "text" } as never);
    });

    it("빌트인 템플릿(오늘 기록/여행 기록/회고)이 메인에 보인다", () => {
      render(<AssistPanel />);
      expect(screen.getByText(t("presets.daily_verb"))).toBeTruthy();
      expect(screen.getByText(t("presets.travel_verb"))).toBeTruthy();
      expect(screen.getByText(t("presets.retro_verb"))).toBeTruthy();
    });

    it("커스텀 프리셋이 있으면 구분줄 아래 들여쓴 하위 항목으로 그려지고, 없으면 구분줄도 없다", () => {
      const { unmount } = render(<AssistPanel />);
      expect(screen.queryByText(t("presets.custom_section"))).toBeNull();
      unmount();

      usePresetsStore.setState({
        customPresets: [{ id: "c1", name: "내 템플릿", bodyMd: "본문" }],
      } as never);
      render(<AssistPanel />);
      expect(screen.getByText(t("presets.custom_section"))).toBeTruthy();
      const row = screen.getByText("내 템플릿").closest("button") as HTMLButtonElement;
      expect(row.style.paddingLeft).toBe("var(--space-8)");
    });

    it("커스텀 프리셋 클릭 → applyPreset(본문 그대로)", () => {
      usePresetsStore.setState({
        customPresets: [{ id: "c1", name: "내 템플릿", bodyMd: "본문" }],
      } as never);
      render(<AssistPanel />);
      fireEvent.click(screen.getByText("내 템플릿"));
      expect(applyPreset).toHaveBeenCalledWith({ title: null, bodyMd: "본문" });
    });

    it('variant="panel"(어시스트) 만 한 줄 리스트(.assist-row)다', () => {
      render(<AssistPanel />);
      expect(document.querySelectorAll(".assist-row").length).toBeGreaterThan(0);
    });
  });

  // ── 시트 · 시작(ready) — 시트 템플릿 4 ──────────────────────────────────────────────────────
  it("시트 시작 모드: 시트 템플릿(가계부 등)이 메인에 보이고, 작업 모드에서는 사라진다(D1)", () => {
    usePresetsStore.setState({ targetState: "ready", activeEditorKind: "sheet" } as never);
    const { unmount } = render(<AssistPanel />);
    expect(screen.getByText(t("presets.budget_verb"))).toBeTruthy();
    expect(screen.getByText(t("presets.sheet_schedule_verb"))).toBeTruthy();
    unmount();

    usePresetsStore.setState({ targetState: "sheet", activeEditorKind: "sheet" } as never);
    render(<AssistPanel />);
    expect(screen.queryByText(t("presets.budget_verb"))).toBeNull();
  });

  // ── 관계도 · 시작(ready) — 레지스트리 타입 · AI로 채우기 ────────────────────────────────────
  describe("관계도 어시스트 · 시작 모드 (레지스트리 타입 · AI로 채우기)", () => {
    beforeEach(() => {
      usePresetsStore.setState({ targetState: "ready", activeEditorKind: "diagram" } as never);
    });

    it("레지스트리 타입이 전부 행으로 뜨고, 그룹 헤더 4개가 전부 있다", () => {
      render(<AssistPanel />);
      for (const def of DIAGRAM_TYPES) {
        expect(screen.getByTestId(`diagram-type-${def.id}`)).toBeTruthy();
        expect(screen.getByText(t(def.nameKey))).toBeTruthy();
      }
      expect(screen.getByTestId("diagram-type-group-structure")).toBeTruthy();
      expect(screen.getByTestId("diagram-type-group-flow")).toBeTruthy();
      expect(screen.getByTestId("diagram-type-group-state")).toBeTruthy();
      expect(screen.getByTestId("diagram-type-group-layout")).toBeTruthy();
    });

    it("타입 행 클릭 → 그 타입의 시드로 applyDiagramPreset, 섹션 이름은 타입 이름", async () => {
      render(<AssistPanel />);
      fireEvent.click(screen.getByTestId("diagram-type-people"));
      await vi.waitFor(() => expect(applyDiagramPreset).toHaveBeenCalledTimes(1));
      expect(applyDiagramPreset).toHaveBeenCalledWith({
        title: null,
        bodyMd: diagramTemplateSource("people"),
        sectionName: t("editor.diagram_tpl_people"),
        renameOnInsert: false, // 이 테스트엔 열린 노트가 없다 — 새 노트의 첫 섹션이라 이름 입력을 켜지 않는다
      });
    });

    it("타입 행 호버는 적용과 같은 시드를 고스트에 넘긴다", () => {
      render(<AssistPanel />);
      fireEvent.mouseEnter(screen.getByTestId("diagram-type-people"));
      expect(usePresetsStore.getState().setHovered).toHaveBeenCalledWith("people", diagramTemplateSource("people"));
    });

    it("AI로 채우기 버튼은 AI 켜짐 + 도달일 때만 존재한다(비활성이 아니라 부재)", () => {
      const { unmount } = render(<AssistPanel />);
      expect(screen.queryByTestId("diagram-type-ai-people")).toBeNull();
      unmount();

      useSettingsStore.setState({ aiEnabled: true } as never);
      useAiStore.setState({ aiReachable: false } as never);
      const r2 = render(<AssistPanel />);
      expect(screen.queryByTestId("diagram-type-ai-people")).toBeNull();
      r2.unmount();

      useAiStore.setState({ aiReachable: true } as never);
      render(<AssistPanel />);
      for (const def of DIAGRAM_TYPES) expect(screen.getByTestId(`diagram-type-ai-${def.id}`)).toBeTruthy();
    });

    it("AI로 채우기: aiHintKey 문구 + 시드의 states/route 를 실어 generateDiagramWithRepair → 결과 JSON 으로 새 섹션", async () => {
      useSettingsStore.setState({ aiEnabled: true } as never);
      useAiStore.setState({ aiReachable: true } as never);
      const json = JSON.stringify({ v: 1, nodes: [{ id: "n1", label: "A" }], edges: [] });
      vi.mocked(generateDiagramWithRepair).mockResolvedValue({ ok: true, json, attempts: 1 });
      render(<AssistPanel />);
      fireEvent.click(screen.getByTestId("diagram-type-ai-people"));
      await vi.waitFor(() => expect(applyDiagramPreset).toHaveBeenCalledTimes(1));

      const [prompt, ctx] = vi.mocked(generateDiagramWithRepair).mock.calls[0];
      expect(ctx).toBeNull();
      expect(prompt).toContain(t("editor.diagram_tpl_people_ai_hint"));
      expect(prompt).toContain('states: ["핵심","협력","외부"]');
      expect(prompt).toContain('route: "curve"');
      expect(prompt).toContain("관계도로 만들어줘");
      expect(applyDiagramPreset).toHaveBeenCalledWith({ title: null, bodyMd: json, sectionName: t("editor.diagram_tpl_people") });
      expect(emitNotice).not.toHaveBeenCalled();
    });

    it("AI로 채우기 실패는 토스트(emitNotice) — 조용히 실패하지 않고, 섹션도 만들지 않는다", async () => {
      useSettingsStore.setState({ aiEnabled: true } as never);
      useAiStore.setState({ aiReachable: true } as never);
      vi.mocked(generateDiagramWithRepair).mockResolvedValue({ ok: false, attempts: 3, errors: ["bad json"] });
      render(<AssistPanel />);
      fireEvent.click(screen.getByTestId("diagram-type-ai-system"));
      await vi.waitFor(() => expect(emitNotice).toHaveBeenCalledTimes(1));
      expect(vi.mocked(emitNotice).mock.calls[0][0]).toBe(t("editor.diagram_ai_error", { error: "bad json" }));
      expect(applyDiagramPreset).not.toHaveBeenCalled();

      vi.mocked(generateDiagramWithRepair).mockRejectedValue(new Error("boom"));
      fireEvent.click(screen.getByTestId("diagram-type-ai-system"));
      await vi.waitFor(() => expect(emitNotice).toHaveBeenCalledTimes(2));
      expect(vi.mocked(emitNotice).mock.calls[1][0]).toBe(t("editor.diagram_ai_error", { error: "boom" }));
    });
  });

  // ── 시트 · 작업(has content) — Explore(추천 차트) ───────────────────────────────────────────
  describe("시트 어시스트 · 작업 모드 — Explore 그룹", () => {
    const doc: SheetDoc = {
      ...emptySheet(),
      cells: { A1: { raw: "1월" }, A2: { raw: "2월" }, B1: { raw: "100" }, B2: { raw: "200" } },
    };
    const focus = (range: { r1: number; c1: number; r2: number; c2: number } | null) =>
      useSheetFocus.setState({ focus: { noteId: "n1", sectionId: "sec-sheet-1", range, doc, engine: new SheetEngine(doc), addChart: () => {} } });

    beforeEach(() => {
      usePresetsStore.setState({ targetState: "sheet", activeEditorKind: "sheet" } as never);
      useNotesStore.setState({
        activeNote: { note: { id: "n1", title: "t" }, sections: [{ id: "sec-sheet-1", name: "시트1", body_md: JSON.stringify(doc), kind: "sheet" }] },
        activeDraft: false,
      } as never);
    });
    afterEach(() => {
      useSheetFocus.setState({ focus: null });
      vi.restoreAllMocks();
    });

    it("선택 없음 → 그룹 부재 · 숫자 없는 선택 → 그룹 부재 · 숫자+텍스트 선택 → 추천 카드 1장(1위 pie) + 종류 칩 pie/bar/line", () => {
      const { unmount } = render(<AssistPanel />);
      expect(screen.queryByTestId("sheet-explore-group")).toBeNull();
      unmount();

      focus({ r1: 0, c1: 0, r2: 1, c2: 0 });
      const r2 = render(<AssistPanel />);
      expect(screen.queryByTestId("sheet-explore-group")).toBeNull();
      r2.unmount();

      focus({ r1: 0, c1: 0, r2: 1, c2: 1 });
      render(<AssistPanel />);
      expect(screen.getByTestId("sheet-explore-group")).toBeTruthy();
      expect(screen.getByText(t("presets.sheet_explore_title"))).toBeTruthy();
      // 미리보기는 한 장뿐 — 추천 1위만 그리고 나머지는 칩으로만 있다(PLAN-2026-09-30).
      expect(screen.getAllByTestId("chart-suggest-card")).toHaveLength(1);
      expect(screen.getByTestId("chart-suggest-card").getAttribute("data-chart-type")).toBe("pie");
      expect(document.querySelectorAll('[data-testid^="chart-suggest-preview-"]')).toHaveLength(1);
      for (const tp of ["pie", "bar", "line"]) expect(screen.getByTestId(`chart-suggest-type-${tp}`)).toBeTruthy();
    });

    it("카드 미리보기는 패널 안에 붙는다(시트 위 고스트 아님) — 칩을 누르면 같은 카드가 그 종류로 바뀐다", async () => {
      focus({ r1: 0, c1: 0, r2: 1, c2: 1 });
      render(<AssistPanel />);
      await vi.waitFor(() => expect(screen.getByTestId("chart-suggest-preview-pie").querySelector(".sheet-chart svg")).toBeTruthy());
      fireEvent.click(screen.getByTestId("chart-suggest-type-bar"));
      expect(screen.getByTestId("chart-suggest-card").getAttribute("data-chart-type")).toBe("bar");
      await vi.waitFor(() => expect(screen.getByTestId("chart-suggest-preview-bar").querySelector(".sheet-chart svg")).toBeTruthy());
      expect(usePresetsStore.getState().setHovered).not.toHaveBeenCalled();
    });

    it("고정 클릭 → addChartFromSelection({sectionId, range, type, register:true}) 한 번 — 선택한 종류로", () => {
      const spy = vi.spyOn(addChartMod, "addChartFromSelection").mockResolvedValue({ ok: true, chartId: "c" });
      focus({ r1: 0, c1: 0, r2: 1, c2: 1 });
      render(<AssistPanel />);
      fireEvent.click(screen.getByTestId("chart-suggest-type-line"));
      fireEvent.click(screen.getByTestId("chart-suggest-pin"));
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith({ sectionId: "sec-sheet-1", range: { r1: 0, c1: 0, r2: 1, c2: 1 }, type: "line", register: true });
    });

    it("같은 종류·같은 범위가 이미 고정돼 있으면 버튼이 '고정됨'으로 잠긴다(중복 방지)", () => {
      vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }); // 고정된 차트 카드(SheetChartsPanel)의 ResponsiveContainer
      const spy = vi.spyOn(addChartMod, "addChartFromSelection").mockResolvedValue({ ok: true, chartId: "c" });
      const pinnedDoc: SheetDoc = { ...doc, charts: [{ id: "c1", type: "pie", series: ["B1:B2"], x: "A1:A2" }] };
      useSheetFocus.setState({
        focus: { noteId: "n1", sectionId: "sec-sheet-1", range: { r1: 0, c1: 0, r2: 1, c2: 1 }, doc: pinnedDoc, engine: new SheetEngine(pinnedDoc), addChart: () => {} },
      });
      render(<AssistPanel />);
      const pin = screen.getByTestId("chart-suggest-pin") as HTMLButtonElement;
      expect(pin.disabled).toBe(true);
      fireEvent.click(pin);
      expect(spy).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });

    // 수식·서식 프리셋(PLAN-2026-09-21 W3, D5) — Explore 와 같은 순수 함수 모델, 추천 없으면 그룹 부재.
    it("수식·서식 그룹은 추천이 있을 때만 존재한다", () => {
      const { unmount } = render(<AssistPanel />);
      expect(screen.queryByText(t("presets.sheet_assist_title"))).toBeNull();
      unmount();

      const ops = { setCells: vi.fn(), setColFormat: vi.fn(), sortRange: vi.fn(), insertRow: vi.fn(), insertCol: vi.fn() };
      useSheetFocus.setState({ focus: { noteId: "n1", sectionId: "sec-sheet-1", range: { r1: 0, c1: 0, r2: 1, c2: 1 }, doc, engine: new SheetEngine(doc), addChart: () => {}, ops } });
      render(<AssistPanel />);
      expect(screen.getByText(t("presets.sheet_assist_title"))).toBeTruthy();
    });
  });

  // ── 관계도 · 작업(has content) — 배치 바꾸기(베타, PLAN-2026-09-21 W4/D4) ───────────────────────
  describe("관계도 어시스트 · 작업 모드 — 배치 바꾸기(베타)", () => {
    beforeEach(() => {
      usePresetsStore.setState({ targetState: "diagram", activeEditorKind: "diagram" } as never);
    });
    afterEach(() => {
      useDiagramFocus.setState({ focus: null });
    });

    it("diagram-layout-* 는 diagramFocus 가 있을 때만 존재한다", () => {
      const { unmount } = render(<AssistPanel />);
      expect(screen.queryByTestId("diagram-layout-group")).toBeNull();
      expect(screen.queryByTestId("diagram-layout-radial")).toBeNull();
      unmount();

      useDiagramFocus.setState({ focus: { sectionId: "sec-d1", layout: undefined, source: "", setLayout: vi.fn() } });
      render(<AssistPanel />);
      expect(screen.getByTestId("diagram-layout-group")).toBeTruthy();
      expect(screen.getByTestId("diagram-layout-radial")).toBeTruthy();
    });
  });

  // ── 관계도 · 작업(has content) — 진행 상황 갱신(도구 항목, PLAN-2026-09-27 §7-4) ──
  describe("관계도 어시스트 · 작업 모드 — 진행 상황 갱신", () => {
    beforeEach(() => {
      usePresetsStore.setState({ targetState: "diagram", activeEditorKind: "diagram" } as never);
    });

    it("assist-ai-diagram-progress 행이 있고, 클릭하면 diagram_progress presetId로 AI 모달이 열린다", () => {
      render(<AssistPanel />);
      fireEvent.click(screen.getByTestId("assist-ai-diagram-progress"));
      expect(screen.getByTestId("ask-ai-modal").getAttribute("data-preset-id")).toBe("diagram_progress");
    });

    it("프리셋 목록에 diagram_progress 가 없으면 행이 렌더되지 않는다", () => {
      useAiPresetsStore.setState({ list: [] } as never);
      render(<AssistPanel />);
      expect(screen.queryByTestId("assist-ai-diagram-progress")).toBeNull();
    });
  });

  // ── 단일 프리셋 저장소 반응성 (§7-3) ──
  describe("AI 프리셋 단일 저장소 연동 (§7-3, §7-4)", () => {
    beforeEach(() => {
      usePresetsStore.setState({ targetState: "has_content", activeEditorKind: "text" } as never);
      useNotesStore.setState({
        activeNote: { note: { id: "n1", title: "노트" }, sections: [] },
        activeDraft: false,
      } as never);
    });

    it("이름 변경, 숨김 토글, 새 프리셋 저장이 어시스트 행에 즉시 반영된다", () => {
      const { unmount } = render(<AssistPanel />);
      expect(screen.getByTestId("assist-ai-summary")).toBeTruthy();
      unmount();

      // 숨김 반영
      const list = builtinDefaults().map((p) => (p.id === "summarize" ? { ...p, hidden: true } : p));
      useAiPresetsStore.setState({ list } as never);
      const r2 = render(<AssistPanel />);
      expect(screen.queryByTestId("assist-ai-summary")).toBeNull();
      r2.unmount();

      // 이름 변경 및 새 프리셋 추가
      const customPreset = {
        id: "custom_note_action",
        name: "커스텀 액션",
        prompt: "커스텀 프롬프트",
        kind: "text" as const,
        isBuiltin: false,
        hidden: false,
        targets: ["note" as const],
      };
      useAiPresetsStore.setState({
        list: [
          ...builtinDefaults().map((p) => (p.id === "summarize" ? { ...p, name: "요약하기(수정)" } : p)),
          customPreset,
        ],
      } as never);
      render(<AssistPanel />);
      expect(screen.getByText("요약하기(수정)")).toBeTruthy();
      expect(screen.getByTestId("assist-ai-custom_note_action")).toBeTruthy();
      expect(screen.getByText("커스텀 액션")).toBeTruthy();
    });
  });
});
