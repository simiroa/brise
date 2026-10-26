import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AssistPanel } from "./AssistPanel";
import { useSettingsStore } from "../../stores/settings";
import { useAiStore } from "../../stores/ai";
import { usePresetsStore } from "../../stores/presets";
import { useAiPresetsStore } from "../../stores/aiPresets";
import { useNotesStore } from "../../stores/notes";
import { useSheetFocus } from "../../stores/sheetFocus";
import { emptySheet, type SheetDoc } from "../../lib/sheet/types";
import { SheetEngine } from "../../lib/sheet/engine";
import { t } from "../../i18n/t";
import { SheetAssist as LazySheetAssist } from "../../lazySurfaces";

// 시트 어시스트는 지연 청크다(lazySurfaces) — 앱이 유휴 시간에 미리 받듯 여기서 미리 받아 바로 그려지게 한다.
beforeAll(async () => {
  await LazySheetAssist.preload();
}, 30_000);

// 수식·서식 프리셋(PLAN-2026-09-21 W3, D5) — SheetAssist 는 AssistPanel 을 통해 그려진다(kind/blank
// 판정이 거기 있으므로). mock 구성은 AssistPanel.test.tsx 원본과 같다.

vi.mock("../../lib/aiSectionBridge", () => ({
  insertAiSection: vi.fn().mockResolvedValue(null),
  getActiveSection: vi.fn(() => null),
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

vi.mock("../PromptDialog", () => ({ PromptDialog: () => null }));

vi.mock("../AskAiModal", () => ({
  runMetadataProposal: vi.fn().mockResolvedValue(undefined),
  runTagsProposal: vi.fn().mockResolvedValue(undefined),
  runNoteSummary: vi.fn().mockResolvedValue(undefined),
  AskAiModal: () => null,
}));

vi.mock("../../lib/presetBridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/presetBridge")>();
  return { ...actual, applyPreset: vi.fn().mockResolvedValue(undefined), applyDiagramPreset: vi.fn().mockResolvedValue(undefined) };
});

function resetStores() {
  useAiPresetsStore.setState({ list: [], loaded: true, load: async () => {} } as never);
  useSettingsStore.setState({ aiEnabled: false } as never);
  useAiStore.setState({ aiReachable: null, ensureAiReachable: async () => {}, generateFromPrompt: async () => null } as never);
  usePresetsStore.setState({
    customPresets: [],
    hiddenBuiltinIds: [],
    loaded: true,
    load: async () => {},
    targetState: "sheet",
    activeEditorKind: "sheet",
    setHovered: vi.fn(),
    clearHovered: vi.fn(),
  } as never);
  useNotesStore.setState({ activeNote: null, activeDraft: false } as never);
}

describe("SheetAssist · 수식·서식 프리셋 그룹", () => {
  const doc: SheetDoc = {
    ...emptySheet(),
    cells: { A1: { raw: "1월" }, A2: { raw: "2월" }, B1: { raw: "100" }, B2: { raw: "200" } },
  };
  const ops = { setCells: vi.fn(), setColFormat: vi.fn(), sortRange: vi.fn(), insertRow: vi.fn(), insertCol: vi.fn(), deleteRows: vi.fn() };
  const focusWith = (range: { r1: number; c1: number; r2: number; c2: number } | null) =>
    useSheetFocus.setState({ focus: { noteId: "n1", sectionId: "sec-sheet-1", range, doc, engine: new SheetEngine(doc), addChart: vi.fn(), ops } });

  beforeEach(() => {
    resetStores();
    Object.values(ops).forEach((fn) => fn.mockClear());
    useNotesStore.setState({
      activeNote: { note: { id: "n1", title: "t" }, sections: [{ id: "sec-sheet-1", name: "시트1", body_md: JSON.stringify(doc), kind: "sheet" }] },
      activeDraft: false,
    } as never);
  });
  afterEach(() => {
    useSheetFocus.setState({ focus: null });
    vi.restoreAllMocks();
  });

  it("선택 범위가 없으면 그룹 자체가 없다", () => {
    focusWith(null);
    render(<AssistPanel />);
    expect(screen.queryByText(t("presets.sheet_assist_title"))).toBeNull();
  });

  it("추천이 있으면 그룹 헤더와 행이 뜨고, 클릭하면 해당 assist 의 apply 가 ops 를 정확히 1회 부른다", () => {
    focusWith({ r1: 0, c1: 0, r2: 1, c2: 1 });
    render(<AssistPanel />);
    expect(screen.getByText(t("presets.sheet_assist_title"))).toBeTruthy();
    const row = screen.getByTestId("assist-sheet-sum_row");
    expect(row).toBeTruthy();
    fireEvent.click(row);
    expect(ops.setCells).toHaveBeenCalledTimes(1);
    expect(ops.setCells).toHaveBeenCalledWith({
      A3: { raw: t("presets.sheet_assist_label_sum") },
      B3: { raw: "=SUM(B2:B2)" },
    });
  });

  it("dedupe_rows 는 중복 행을 찾아 ops.deleteRows 를 정확히 1회, 그 행 배열로 부른다(2차, PLAN-2026-09-21 §4 W3)", () => {
    const dupDoc: SheetDoc = {
      ...emptySheet(),
      cells: { A1: { raw: "철수" }, B1: { raw: "1" }, A2: { raw: "철수" }, B2: { raw: "1" }, A3: { raw: "영희" }, B3: { raw: "2" } },
    };
    const dupOps = { setCells: vi.fn(), setColFormat: vi.fn(), sortRange: vi.fn(), insertRow: vi.fn(), insertCol: vi.fn(), deleteRows: vi.fn() };
    useSheetFocus.setState({
      focus: { noteId: "n1", sectionId: "sec-sheet-1", range: { r1: 0, c1: 0, r2: 2, c2: 1 }, doc: dupDoc, engine: new SheetEngine(dupDoc), addChart: vi.fn(), ops: dupOps },
    });
    useNotesStore.setState({
      activeNote: { note: { id: "n1", title: "t" }, sections: [{ id: "sec-sheet-1", name: "시트1", body_md: JSON.stringify(dupDoc), kind: "sheet" }] },
      activeDraft: false,
    } as never);
    render(<AssistPanel />);
    const row = screen.getByTestId("assist-sheet-dedupe_rows");
    fireEvent.click(row);
    expect(dupOps.deleteRows).toHaveBeenCalledTimes(1);
    expect(dupOps.deleteRows).toHaveBeenCalledWith([1]);
  });

  it("ops 가 없는 focus(옛 테스트 형태)에서는 그룹이 조용히 부재한다", () => {
    useSheetFocus.setState({
      focus: { noteId: "n1", sectionId: "sec-sheet-1", range: { r1: 0, c1: 0, r2: 1, c2: 1 }, doc, engine: new SheetEngine(doc), addChart: vi.fn() },
    });
    render(<AssistPanel />);
    expect(screen.queryByText(t("presets.sheet_assist_title"))).toBeNull();
  });
});
