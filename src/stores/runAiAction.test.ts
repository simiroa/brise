import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const callMock = vi.fn();
const emitNoticeMock = vi.fn();
const flushAllMock = vi.fn(async (..._args: unknown[]) => {});

vi.mock("../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  emitNotice: (...args: unknown[]) => emitNoticeMock(...args),
  flushAll: (...args: unknown[]) => flushAllMock(...args),
  registerFlush: () => () => {},
}));

import {
  runAiAction,
  buildFormulaHelperPrompt,
  normalizeFormula,
  runSheetFormulaHelper,
  generateDiagramWithRepair,
  generateSheetWithRepair,
} from "./runAiAction";
import { emptySheet, parseSheet, type SheetDoc } from "../lib/sheet/types";
import { DIAGRAM_EDIT_ID, DIAGRAM_PROGRESS_ID, DIAGRAM_EXPAND_BRANCH_ID, SHEET_EDIT_ID, type AiActionPreset } from "./aiPrompts";
import { useAiStore } from "./ai";
import { useSettingsStore } from "./settings";
import { useAiResultGateStore, registerAiResultGateHost } from "./aiResultGate";
import { registerActiveSectionGetter, registerSectionInserter, registerDiagramTarget } from "../lib/aiSectionBridge";
import { t } from "../i18n/t";

describe("runAiAction — the one entry point both desktop and mobile call", () => {
  beforeEach(() => {
    callMock.mockReset();
    emitNoticeMock.mockReset();
    flushAllMock.mockClear();
    // PLAN-2026-09-05 §2 B-6: 이 파일의 기존 테스트는 모두 "게이트 없이 즉시 삽입"(설정 꺼짐)
    // 시나리오다 — 회귀 테스트 ④(aiConfirmBeforeApply=false 는 현행 그대로)를 이 스위트 전체가
    // 대신 못박는다. 게이트 자체(대기/버리기/재시도)는 아래 별도 describe에서 켠 채로 검증한다.
    useSettingsStore.setState({ aiConfirmBeforeApply: false } as never);
    useAiResultGateStore.setState({ session: null });
  });

  const metadataPreset: AiActionPreset = { id: "metadata", name: "메타데이터", prompt: "unused", kind: "metadata", isBuiltin: true, hidden: false };
  const textPreset: AiActionPreset = { id: "list", name: "리스트로 만들기", prompt: "P", kind: "text", isBuiltin: true, hidden: false };
  const diagramPreset: AiActionPreset = { id: "diagram", name: "관계도 만들기", prompt: "DP", kind: "diagram", isBuiltin: true, hidden: false };

  it("refuses agent plan presets (not text insert path)", async () => {
    const agent: AiActionPreset = {
      id: "agent_split",
      name: "split",
      prompt: "g",
      kind: "text",
      isBuiltin: true,
      hidden: false,
    };
    const ok = await runAiAction(agent);
    expect(ok).toBe(false);
    expect(emitNoticeMock).toHaveBeenCalled();
  });

  it("refuses sidebar chat builtins (not text insert path)", async () => {
    const chat: AiActionPreset = {
      id: "ask_note",
      name: "이 노트 설명",
      prompt: "g",
      kind: "text",
      isBuiltin: true,
      hidden: false,
    };
    const ok = await runAiAction(chat);
    expect(ok).toBe(false);
    expect(emitNoticeMock).toHaveBeenCalledWith(t("ai.chat_preset_not_runnable"));
  });

  it("metadata kind calls organizeCurrentNote with the supported fields AND preset.prompt as guidance", async () => {
    const organizeCurrentNote = vi.fn(async () => {});
    useAiStore.setState({ organizeCurrentNote } as never);
    const ok = await runAiAction(metadataPreset);
    expect(ok).toBe(true);
    expect(organizeCurrentNote).toHaveBeenCalledWith(undefined, ["title", "tags", "year", "region", "folder"], "unused");
  });

  it("text kind with explicit ctx: empty contextText notices and never calls generateFromPrompt", async () => {
    const generateFromPrompt = vi.fn(async () => "should not run");
    useAiStore.setState({ generateFromPrompt } as never);
    const insertSection = vi.fn(async () => null);
    const ok = await runAiAction(textPreset, { contextText: "   ", insertSection });
    expect(ok).toBe(false);
    expect(generateFromPrompt).not.toHaveBeenCalled();
    expect(insertSection).not.toHaveBeenCalled();
    expect(emitNoticeMock).toHaveBeenCalled();
  });

  it("text kind with explicit ctx: runs the prompt against contextText and inserts the result under preset.name", async () => {
    const generateFromPrompt = vi.fn(async (prompt: string, ctx: string) => `generated from ${prompt}/${ctx}`);
    useAiStore.setState({ generateFromPrompt } as never);
    const insertSection = vi.fn(async () => null);
    const ok = await runAiAction(textPreset, {
      contextText: "note body",
      insertSection,
      targetNoteId: "note-1",
    });
    expect(ok).toBe(true);
    // WB(2026-09-05) B1: 3rd arg carries the request_id runWithAiResultGate minted for this call
    // (crypto/uniqueId-generated even in the ungated immediate-apply path this suite runs under).
    // W1(2026-09-22): carries presetId to wire into CallCtx for audit call_log.
    expect(generateFromPrompt).toHaveBeenCalledWith("P", "note body", {
      requestId: expect.any(String),
      presetId: "list",
      purpose: "transform",
    });
    // W5: the preset's own id is forwarded as ai_origin (opts, not a bare positional string —
    // insertSection's real signature mirrors insertAiSection's public opts shape).
    expect(insertSection).toHaveBeenCalledWith(
      "리스트로 만들기",
      "generated from P/note body",
      "note-1",
      undefined,
      { aiOrigin: "list" },
    );
  });

  it("text kind with no ctx falls back to the aiSectionBridge (desktop's EditorPanel wiring)", async () => {
    const generateFromPrompt = vi.fn(async () => "bridged result");
    useAiStore.setState({ generateFromPrompt } as never);
    const inserted = vi.fn(async () => null);
    const unregisterGetter = registerActiveSectionGetter(() => ({ id: "s1", body_md: "bridged body" }));
    const unregisterInserter = registerSectionInserter(inserted);
    // no-ctx path captures activeNote id before generate and forwards it as targetNoteId
    const { useNotesStore } = await import("./notes");
    useNotesStore.setState({
      activeNote: { note: { id: "note-bridge" }, sections: [] },
    } as never);
    try {
      const ok = await runAiAction(textPreset);
      expect(ok).toBe(true);
      expect(flushAllMock).toHaveBeenCalled();
      expect(generateFromPrompt).toHaveBeenCalledWith("P", "bridged body", {
        requestId: expect.any(String),
        presetId: "list",
        purpose: "transform",
      });
      // No-ctx path runs through the REAL insertAiSection, which unwraps opts.aiOrigin down to
      // the bare string before calling the low-level registered SectionInserter (`inserted`) —
      // unlike the ctx.insertSection mock above, this one sees the unwrapped string, not the
      // opts object (lib/aiSectionBridge.ts's insertAiSection is the unwrap point).
      expect(inserted).toHaveBeenCalledWith("리스트로 만들기", "bridged result", "note-bridge", undefined, "list");
    } finally {
      unregisterGetter();
      unregisterInserter();
    }
  });

  it("diagram kind with explicit ctx: runs the prompt against contextText and inserts valid JSON IR under preset.name WITH kind:'diagram'", async () => {
    const validJson = JSON.stringify({
      v: 1,
      nodes: [{ id: "n1", label: "A" }, { id: "n2", label: "B" }],
      edges: [{ id: "e1", from: "n1", to: "n2" }],
    });
    const generateFromPrompt = vi.fn(async () => `\`\`\`json\n${validJson}\n\`\`\``);
    useAiStore.setState({ generateFromPrompt } as never);
    const insertSection = vi.fn(async () => null);
    const ok = await runAiAction(diagramPreset, {
      contextText: "note body",
      insertSection,
      targetNoteId: "note-1",
    });
    expect(ok).toBe(true);
    expect(generateFromPrompt).toHaveBeenCalledWith("DP", "note body", {
      requestId: expect.any(String),
      presetId: "diagram",
      purpose: "json",
    });
    expect(insertSection).toHaveBeenCalledWith(
      "관계도 만들기",
      expect.stringContaining('"v": 1'),
      "note-1",
      "diagram",
      { aiOrigin: "diagram" },
    );
  });

  it("diagram kind sanitizes coordinates (pos) generated by AI upon insertion", async () => {
    const jsonWithPos = JSON.stringify({
      v: 1,
      nodes: [{ id: "n1", label: "A", pos: [100, 200] }, { id: "n2", label: "B", pos: [300, 400] }],
      edges: [{ id: "e1", from: "n1", to: "n2" }],
    });
    const generateFromPrompt = vi.fn(async () => jsonWithPos);
    useAiStore.setState({ generateFromPrompt } as never);
    const insertSection = vi.fn(async (_kind: string, _body: string) => null);
    const ok = await runAiAction(diagramPreset, {
      contextText: "note body",
      insertSection,
      targetNoteId: "note-1",
    });
    expect(ok).toBe(true);
    const insertedBody = insertSection.mock.calls[0]![1];
    expect(insertedBody).not.toContain('"pos"');
  });

  it("test_diagram_ai_validation_and_repair_loop", async () => {
    const broken1 = JSON.stringify({ v: 1, nodes: [{ id: "n1", label: "A" }], edges: [{ id: "e1", from: "n999", to: "n1" }] });
    const broken2 = "invalid json";
    const valid = JSON.stringify({ v: 1, nodes: [{ id: "n1", label: "A" }, { id: "n2", label: "B" }], edges: [{ id: "e1", from: "n1", to: "n2" }] });

    const generateFromPrompt = vi.fn()
      .mockResolvedValueOnce(broken1)
      .mockResolvedValueOnce(broken2)
      .mockResolvedValueOnce(valid);
    useAiStore.setState({ generateFromPrompt } as never);

    const insertSection = vi.fn(async () => null);
    const ok = await runAiAction(diagramPreset, {
      contextText: "note body",
      insertSection,
      targetNoteId: "note-1",
    });

    expect(ok).toBe(true);
    expect(generateFromPrompt).toHaveBeenCalledTimes(3);
    expect(insertSection).toHaveBeenCalledTimes(1);
  });

  it("W2: AI 가 모르는 layout(\"banana\") 을 내면 자동수리 재요청 뒤 통과하고, 재요청 프롬프트가 그 오류를 실어 보낸다", async () => {
    const banana = JSON.stringify({ v: 1, layout: "banana", nodes: [{ id: "n1", label: "A" }], edges: [] });
    const fixed = JSON.stringify({ v: 1, layout: "radial", nodes: [{ id: "n1", label: "A" }, { id: "n2", label: "B" }], edges: [{ id: "e1", from: "n1", to: "n2" }] });
    const generateFromPrompt = vi.fn().mockResolvedValueOnce(banana).mockResolvedValueOnce(fixed);
    useAiStore.setState({ generateFromPrompt } as never);

    const insertSection = vi.fn(async () => null);
    const ok = await runAiAction(diagramPreset, { contextText: "note body", insertSection, targetNoteId: "note-1" });

    expect(ok).toBe(true);
    expect(generateFromPrompt).toHaveBeenCalledTimes(2);
    expect(generateFromPrompt.mock.calls[1][0]).toContain('Unknown layout: "banana"');
    expect(insertSection).toHaveBeenCalledWith("관계도 만들기", expect.stringContaining('"layout": "radial"'), "note-1", "diagram", { aiOrigin: "diagram" });
  });

  it("diagram validation failure: fails after 3 consecutive bad responses and emits notice with reason and raw text", async () => {
    const broken = JSON.stringify({ v: 1, nodes: [{ id: "n1", label: "A" }], edges: [{ id: "e1", from: "n999", to: "n1" }] });
    const generateFromPrompt = vi.fn().mockResolvedValue(broken);
    useAiStore.setState({ generateFromPrompt } as never);

    const insertSection = vi.fn(async () => null);
    const ok = await runAiAction(diagramPreset, {
      contextText: "note body",
      insertSection,
      targetNoteId: "note-1",
    });

    expect(ok).toBe(false);
    expect(generateFromPrompt).toHaveBeenCalledTimes(3);
    expect(insertSection).not.toHaveBeenCalled();
    expect(emitNoticeMock).toHaveBeenCalled();
    const noticeText = emitNoticeMock.mock.calls[0][0] as string;
    expect(noticeText).toContain("3");
    expect(noticeText).toContain("n999");
  });

  // ── 관계도 수정하기 (DIAGRAM_EDIT_ID) ──────────────────────────────────────────
  const editPreset: AiActionPreset = { id: DIAGRAM_EDIT_ID, name: "관계도 수정하기", prompt: "RULES", kind: "diagram", isBuiltin: true, hidden: false };

  const VALID_JSON_SOURCE = JSON.stringify({
    v: 1,
    nodes: [
      { id: "n1", label: "세종" },
      { id: "n2", label: "장영실" },
    ],
    edges: [{ id: "e1", from: "n1", to: "n2", label: "등용" }],
  });

  it("diagram_edit builds prompt with source + instruction and replaces section body", async () => {
    const editedJson = JSON.stringify({
      v: 1,
      nodes: [
        { id: "n1", label: "세종" },
        { id: "n2", label: "장영실" },
        { id: "n3", label: "정인지" },
      ],
      edges: [
        { id: "e1", from: "n1", to: "n2", label: "등용" },
        { id: "e2", from: "n1", to: "n3", label: "명령" },
      ],
    });
    const generateFromPrompt = vi.fn(async () => editedJson);
    useAiStore.setState({ generateFromPrompt } as never);
    const replaceSection = vi.fn(async () => {});

    const ok = await runAiAction(editPreset, {
      contextText: VALID_JSON_SOURCE,
      insertSection: vi.fn(async () => null),
      diagram: { source: VALID_JSON_SOURCE, instruction: "정인지 추가하고 세종과 연결해줘", replaceSection },
    });

    expect(ok).toBe(true);
    expect(generateFromPrompt).toHaveBeenCalledTimes(1);
    expect(replaceSection).toHaveBeenCalledTimes(1);
  });

  // ── 진행 상황 갱신 (DIAGRAM_PROGRESS_ID) ──────────────────────────────────────
  const progressPreset: AiActionPreset = {
    id: DIAGRAM_PROGRESS_ID,
    name: "진행 상황 갱신",
    prompt: "PROGRESS_RULES",
    kind: "diagram",
    isBuiltin: true,
    hidden: false,
  };

  const PROGRESS_SOURCE = JSON.stringify({
    v: 1,
    states: ["준비", "진행중", "완료"],
    nodes: [
      { id: "n1", label: "기획", state: 1 },
      { id: "n2", label: "개발", state: 0 },
    ],
    edges: [{ id: "e1", from: "n1", to: "n2" }],
  });

  it("diagram_progress updates state indices and keeps structural elements intact", async () => {
    const updatedStateJson = JSON.stringify({
      v: 1,
      states: ["준비", "진행중", "완료"],
      nodes: [
        { id: "n1", label: "기획", state: 2 },
        { id: "n2", label: "개발", state: 1 },
      ],
      edges: [{ id: "e1", from: "n1", to: "n2" }],
    });
    const generateFromPrompt = vi.fn(async () => updatedStateJson);
    useAiStore.setState({ generateFromPrompt } as never);
    const replaceSection = vi.fn(async () => {});

    const ok = await runAiAction(progressPreset, {
      contextText: "오늘 기획 완료 및 개발 착수",
      insertSection: vi.fn(async () => null),
      diagram: { source: PROGRESS_SOURCE, replaceSection },
    });

    expect(ok).toBe(true);
    expect(replaceSection).toHaveBeenCalledTimes(1);
  });

  it("diagram_progress rejects structural changes (adding/removing nodes or edges)", async () => {
    // Model illegally added a new node "n3"
    const alteredStructureJson = JSON.stringify({
      v: 1,
      states: ["준비", "진행중", "완료"],
      nodes: [
        { id: "n1", label: "기획", state: 2 },
        { id: "n2", label: "개발", state: 1 },
        { id: "n3", label: "배포", state: 0 },
      ],
      edges: [{ id: "e1", from: "n1", to: "n2" }],
    });
    const generateFromPrompt = vi.fn(async () => alteredStructureJson);
    useAiStore.setState({ generateFromPrompt } as never);
    const replaceSection = vi.fn(async () => {});

    const ok = await runAiAction(progressPreset, {
      contextText: "배포 단계 추가",
      insertSection: vi.fn(async () => null),
      diagram: { source: PROGRESS_SOURCE, replaceSection },
    });

    expect(ok).toBe(false);
    expect(replaceSection).not.toHaveBeenCalled();
    expect(emitNoticeMock).toHaveBeenCalledWith(t("ai.diagram_progress_structure_changed"));
  });

  // ── 하위 단계 분기 전개 (DIAGRAM_EXPAND_BRANCH_ID) ──────────────────────────
  const branchPreset: AiActionPreset = {
    id: DIAGRAM_EXPAND_BRANCH_ID,
    name: "하위 단계 분기 전개",
    prompt: "EXPAND_BRANCH_RULES",
    kind: "diagram",
    isBuiltin: true,
    hidden: false,
  };

  it("diagram_expand_branch notices if no selected node id is provided", async () => {
    const ok = await runAiAction(branchPreset, {
      contextText: "",
      insertSection: vi.fn(async () => null),
      diagram: { source: VALID_JSON_SOURCE, replaceSection: vi.fn(async () => {}) },
    });
    expect(ok).toBe(false);
    expect(emitNoticeMock).toHaveBeenCalledWith(expect.stringContaining("선택"));
  });

  it("diagram_expand_branch generates repairable JSON and replaces section", async () => {
    const expandedJson = JSON.stringify({
      v: 1,
      nodes: [
        { id: "n1", label: "세종" },
        { id: "n2", label: "장영실" },
        { id: "n3", label: "측우기 발명" },
      ],
      edges: [
        { id: "e1", from: "n1", to: "n2", label: "등용" },
        { id: "e2", from: "n2", to: "n3", label: "제작" },
      ],
    });
    const generateFromPrompt = vi.fn(async () => expandedJson);
    useAiStore.setState({ generateFromPrompt } as never);
    const replaceSection = vi.fn(async (_body: string) => {});

    const registerDiagramTarget = (await import("../lib/aiSectionBridge")).registerDiagramTarget;
    registerDiagramTarget(() => ({
      source: VALID_JSON_SOURCE,
      selectedNodeId: "n2",
      selectedNodeLabel: "장영실",
      replaceSection,
    }));

    const ok = await runAiAction(branchPreset, {
      contextText: "",
      insertSection: vi.fn(async () => null),
    });

    expect(ok).toBe(true);
    expect(JSON.parse(replaceSection.mock.calls[0][0])).toEqual(JSON.parse(expandedJson));
    const [prompt] = generateFromPrompt.mock.calls[0] as unknown as [string, string | null];
    expect(prompt).toContain("장영실");
    expect(prompt).toContain("n2");
  });

  // ── 수식 도우미 — `=` 뒤 자연어 → 수식 1개. 프리셋이 아니고, 시트를 절대 건드리지 않는다 ──────
  const budgetDoc: SheetDoc = {
    ...emptySheet(),
    cells: {
      A1: { raw: "날짜" },
      B1: { raw: "항목" },
      C1: { raw: "금액" },
      A2: { raw: "2026-08-01" },
      C2: { raw: "12000" },
      C3: { raw: "9000" },
    },
  };

  it("프롬프트에 헤더 행(열 문자 포함)·대상 셀·사용 범위·요청이 모두 들어간다", () => {
    const prompt = buildFormulaHelperPrompt({
      header: "A: 날짜 | B: 항목 | C: 금액",
      usedRange: "A1:C3",
      target: "C4",
      request: "이번 달 금액 합계",
    });
    expect(prompt).toContain("A: 날짜");
    expect(prompt).toContain("C: 금액");
    expect(prompt).toContain("A1:C3");
    expect(prompt).toContain("C4");
    expect(prompt).toContain("이번 달 금액 합계");
  });

  it("출력 정규화: 코드 펜스를 걷어내고 `=` 가 없으면 붙인다", () => {
    expect(normalizeFormula("=SUM(C2:C3)")).toBe("=SUM(C2:C3)");
    expect(normalizeFormula("```excel\n=SUM(C2:C3)\n```")).toBe("=SUM(C2:C3)");
    expect(normalizeFormula("```\nSUM(C2:C3)\n```")).toBe("=SUM(C2:C3)");
    expect(normalizeFormula("  \n SUM(C2:C3) \n")).toBe("=SUM(C2:C3)");
    expect(normalizeFormula("")).toBe("");
    expect(normalizeFormula(null)).toBe("");
  });

  it("시트 컨텍스트를 담아 모델을 부르고 수식 문자열만 돌려준다 (시트는 그대로)", async () => {
    const generateFromPrompt = vi.fn(async () => "```\n=SUM(C2:C3)\n```");
    useAiStore.setState({ generateFromPrompt, refreshTranslateGate: async () => true } as never);

    const formula = await runSheetFormulaHelper({
      doc: budgetDoc,
      targetRef: "C4",
      request: "=금액 합계",
      sectionId: "sec-1",
    });

    expect(formula).toBe("=SUM(C2:C3)");
    const [prompt, context] = generateFromPrompt.mock.calls[0] as unknown as [string, string | null];
    expect(prompt).toContain("A: 날짜 | B: 항목 | C: 금액");
    expect(prompt).toContain("A1:C3"); // 사용 범위
    expect(prompt).toContain("C4"); // 대상 셀
    expect(prompt).toContain("금액 합계"); // 요청(앞의 `=` 는 벗겨서)
    expect(context).toBeNull();
  });

  it("빈 결과는 토스트만 띄우고 null — 편집칸에 아무것도 채우지 않는다", async () => {
    useAiStore.setState({
      generateFromPrompt: vi.fn(async () => "  \n "),
      refreshTranslateGate: async () => true,
    } as never);
    const formula = await runSheetFormulaHelper({ doc: budgetDoc, targetRef: "C4", request: "합계" });
    expect(formula).toBeNull();
    expect(emitNoticeMock).toHaveBeenCalledWith(t("ai.sheet_formula_helper_empty"));
  });

  it("AI 가 꺼져 있으면(게이트) 모델을 부르지 않는다", async () => {
    const generateFromPrompt = vi.fn(async () => "should not run");
    useAiStore.setState({ generateFromPrompt, refreshTranslateGate: async () => false } as never);
    const formula = await runSheetFormulaHelper({ doc: budgetDoc, targetRef: "C4", request: "합계" });
    expect(formula).toBeNull();
    expect(generateFromPrompt).not.toHaveBeenCalled();
  });

  it("빈 요청은 게이트도 모델도 건드리지 않는다", async () => {
    const refreshTranslateGate = vi.fn(async () => true);
    useAiStore.setState({ refreshTranslateGate } as never);
    expect(await runSheetFormulaHelper({ doc: budgetDoc, targetRef: "C4", request: "=  " })).toBeNull();
    expect(refreshTranslateGate).not.toHaveBeenCalled();
  });

  // ── G2(WG, 2026-09-06): 게이트를 열기 전 입력 길이 사전 확인 ──────────────────────────────
  describe("G2 — 캡(32,000자)을 넘는 입력은 게이트조차 열지 않는다", () => {
    const overCap = "x".repeat(32_001);
    const editPresetForG2: AiActionPreset = { id: DIAGRAM_EDIT_ID, name: "관계도 수정하기", prompt: "RULES", kind: "diagram", isBuiltin: true, hidden: false };
    const sheetEditPresetForG2: AiActionPreset = { id: SHEET_EDIT_ID, name: "시트 수정하기", prompt: "SHEET_RULES", kind: "sheet", isBuiltin: true, hidden: false };

    it("text kind: preset.prompt + contextText가 캡을 넘으면 generate 미호출·게이트 미오픈·안내", async () => {
      const generateFromPrompt = vi.fn(async () => "should not run");
      useAiStore.setState({ generateFromPrompt } as never);
      const insertSection = vi.fn(async () => null);

      const ok = await runAiAction(textPreset, { contextText: overCap, insertSection, targetNoteId: "note-1" });

      expect(ok).toBe(false);
      expect(generateFromPrompt).not.toHaveBeenCalled();
      expect(insertSection).not.toHaveBeenCalled();
      expect(useAiResultGateStore.getState().session).toBeNull();
      // textPreset.prompt("P", 1자) + overCap(32,001자) = 32,002자.
      expect(emitNoticeMock).toHaveBeenCalledWith(t("aiResult.preflight_input_too_long_notice", { chars: "32,002", cap: "32,000" }));
    });

    it("diagram_edit: source+instruction이 캡을 넘으면 generate 미호출·replaceSection 미호출", async () => {
      const generateFromPrompt = vi.fn(async () => "should not run");
      useAiStore.setState({ generateFromPrompt } as never);
      const replaceSection = vi.fn(async () => {});

      const ok = await runAiAction(editPresetForG2, {
        contextText: "",
        insertSection: vi.fn(async () => null),
        diagram: { source: overCap, instruction: "정인지 추가", replaceSection },
      });

      expect(ok).toBe(false);
      expect(generateFromPrompt).not.toHaveBeenCalled();
      expect(replaceSection).not.toHaveBeenCalled();
      expect(emitNoticeMock).toHaveBeenCalled();
    });

    it("sheet_edit: source+instruction이 캡을 넘으면 generate 미호출·replaceSection 미호출", async () => {
      const generateFromPrompt = vi.fn(async () => "should not run");
      useAiStore.setState({ generateFromPrompt } as never);
      const replaceSection = vi.fn(async () => {});

      const ok = await runAiAction(sheetEditPresetForG2, {
        contextText: "",
        insertSection: vi.fn(async () => null),
        sheet: { source: overCap, instruction: "정리해줘", replaceSection },
      });

      expect(ok).toBe(false);
      expect(generateFromPrompt).not.toHaveBeenCalled();
      expect(replaceSection).not.toHaveBeenCalled();
      expect(emitNoticeMock).toHaveBeenCalled();
    });

    it("캡 바로 아래(경계값)는 정상 통과한다 — false-positive 방지", async () => {
      const atCap = "x".repeat(32_000 - 1); // preset.prompt("P", 1자) + context = 정확히 32,000
      const generateFromPrompt = vi.fn(async () => "generated");
      useAiStore.setState({ generateFromPrompt } as never);
      const insertSection = vi.fn(async () => null);

      const ok = await runAiAction(textPreset, { contextText: atCap, insertSection, targetNoteId: "note-1" });

      expect(ok).toBe(true);
      expect(generateFromPrompt).toHaveBeenCalled();
    });
  });

  it("empty generation result notices instead of inserting an empty section", async () => {
    const generateFromPrompt = vi.fn(async () => "   ");
    useAiStore.setState({ generateFromPrompt } as never);
    const insertSection = vi.fn(async () => null);
    const ok = await runAiAction(textPreset, {
      contextText: "body",
      insertSection,
      targetNoteId: "note-1",
    });
    expect(ok).toBe(false);
    expect(insertSection).not.toHaveBeenCalled();
    expect(emitNoticeMock).toHaveBeenCalled();
  });

  // ── W4: 관계도 손배치 보존 및 수리 루프 강화 ─────────────────────────────────────
  describe("W4: 관계도 손배치 보존 및 수리 루프 강화", () => {
    it("runDiagramEdit preserves original node positions while stripping pos for new nodes", async () => {
      const sourceWithPos = JSON.stringify({
        v: 1,
        nodes: [
          { id: "n1", label: "세종", pos: [120, 240] },
          { id: "n2", label: "장영실", pos: [300, 450] },
        ],
        edges: [{ id: "e1", from: "n1", to: "n2" }],
      });

      const aiEditedWithInventedPos = JSON.stringify({
        v: 1,
        nodes: [
          { id: "n1", label: "세종", pos: [999, 999] },
          { id: "n2", label: "장영실 (대호군)", pos: [888, 888] },
          { id: "n3", label: "이천", pos: [500, 500] },
        ],
        edges: [
          { id: "e1", from: "n1", to: "n2" },
          { id: "e2", from: "n1", to: "n3" },
        ],
      });

      const generateFromPrompt = vi.fn(async () => aiEditedWithInventedPos);
      useAiStore.setState({ generateFromPrompt } as never);
      const replaceSection = vi.fn(async (_body: string) => {});

      const ok = await runAiAction(editPreset, {
        contextText: sourceWithPos,
        insertSection: vi.fn(async () => null),
        diagram: { source: sourceWithPos, instruction: "이천 추가", replaceSection },
      });

      expect(ok).toBe(true);
      expect(replaceSection).toHaveBeenCalledTimes(1);
      const replacedJson = JSON.parse(replaceSection.mock.calls[0]![0]);
      // n1 and n2 keep original coordinates
      expect(replacedJson.nodes.find((n: { id: string }) => n.id === "n1").pos).toEqual([120, 240]);
      expect(replacedJson.nodes.find((n: { id: string }) => n.id === "n2").pos).toEqual([300, 450]);
      // newly added n3 has pos removed for auto-layout
      expect(replacedJson.nodes.find((n: { id: string }) => n.id === "n3").pos).toBeUndefined();
    });

    it("generateDiagramWithRepair truncates previous output if repair prompt exceeds 32k cap", async () => {
      // 35,000 char broken response
      const hugeBrokenOutput = "x".repeat(35_000);
      const valid = JSON.stringify({
        v: 1,
        nodes: [{ id: "n1", label: "A" }],
        edges: [],
      });

      const generateFromPrompt = vi.fn()
        .mockResolvedValueOnce(hugeBrokenOutput)
        .mockResolvedValueOnce(valid);
      useAiStore.setState({ generateFromPrompt } as never);

      const res = await generateDiagramWithRepair("BASE_PROMPT", null, 3);
      expect(res.ok).toBe(true);
      expect(generateFromPrompt).toHaveBeenCalledTimes(2);

      const retryPrompt = generateFromPrompt.mock.calls[1]![0] as string;
      expect([...retryPrompt].length).toBeLessThanOrEqual(32_000);
      expect(retryPrompt).toContain("...(truncated)");
    });

    it("generateDiagramWithRepair halts and distinguishes null response from empty response", async () => {
      const generateFromPrompt = vi.fn().mockResolvedValue(null);
      useAiStore.setState({ generateFromPrompt } as never);

      const res = await generateDiagramWithRepair("BASE_PROMPT", null, 3);
      expect(res.ok).toBe(false);
      // Immediately breaks on backend error/null without wasting attempts on "빈 응답"
      expect(res.attempts).toBe(1);
      expect(res.errors).toEqual(["AI generation request failed"]);
    });
  });

  // ── W5: 시트 수리 루프 (generateSheetWithRepair / runSheetEdit) ─────────────────
  describe("W5: 시트 계약 및 수리 루프", () => {
    it("generateSheetWithRepair repairs invalid JSON on second attempt", async () => {
      const brokenSheet = "{ broken sheet json";
      const validSheet = JSON.stringify({
        v: 1,
        rows: 10,
        cols: [{ fmt: "text" }, { fmt: "number" }],
        cells: {
          A1: { raw: "항목" },
          B1: { raw: "100" },
        },
        charts: [],
      });

      const generateFromPrompt = vi.fn()
        .mockResolvedValueOnce(brokenSheet)
        .mockResolvedValueOnce(validSheet);
      useAiStore.setState({ generateFromPrompt } as never);

      const res = await generateSheetWithRepair("MAKE_SHEET", "context", 3);
      expect(res.ok).toBe(true);
      expect(res.attempts).toBe(2);
      expect(res.doc?.cells.A1.raw).toBe("항목");
      expect(res.doc?.cells.B1.raw).toBe("100");

      const secondCallPrompt = generateFromPrompt.mock.calls[1]![0] as string;
      expect(secondCallPrompt).toContain("[이전 출력 유효성 검사 실패 (1회차)]");
      expect(secondCallPrompt).toContain("{ broken sheet json");
    });

    it("runSheetEdit successfully applies repair loop when first attempt fails schema", async () => {
      const sheetEditPreset: AiActionPreset = { id: SHEET_EDIT_ID, name: "시트 수정하기", prompt: "SHEET_RULES", kind: "sheet", isBuiltin: true, hidden: false };
      const originalSheet = JSON.stringify({
        v: 1,
        rows: 5,
        cols: [],
        cells: { A1: { raw: "원본" } },
        charts: [],
      });

      // 1st attempt: invalid cells object
      const badAttempt = JSON.stringify({ v: 1, cells: "not an object" });
      // 2nd attempt: valid updated sheet
      const fixedAttempt = JSON.stringify({
        v: 1,
        rows: 5,
        cols: [],
        cells: { A1: { raw: "수정됨" } },
        charts: [],
      });

      const generateFromPrompt = vi.fn()
        .mockResolvedValueOnce(badAttempt)
        .mockResolvedValueOnce(fixedAttempt);
      useAiStore.setState({ generateFromPrompt } as never);
      const replaceSection = vi.fn(async (_body: string) => {});

      const ok = await runAiAction(sheetEditPreset, {
        contextText: "",
        insertSection: vi.fn(async () => null),
        sheet: { source: originalSheet, instruction: "A1을 수정됨으로 변경", replaceSection },
      });

      expect(ok).toBe(true);
      expect(generateFromPrompt).toHaveBeenCalledTimes(2);
      expect(replaceSection).toHaveBeenCalledTimes(1);
      const replacedDoc = parseSheet(replaceSection.mock.calls[0]![0]);
      expect(replacedDoc?.cells.A1.raw).toBe("수정됨");
    });
  });
});

// PLAN-2026-09-05 §2 (트랙 B) — 결과 프리뷰 게이트. 위 스위트는 전부 aiConfirmBeforeApply:false
// (게이트 꺼짐, 회귀 ④)를 이미 못박고 있으므로, 여기서는 게이트가 켜졌을 때의 대기/버리기/재시도
// 계약만 검증한다.
describe("runAiAction — 결과 프리뷰 게이트 (aiConfirmBeforeApply: true)", () => {
  const textPreset: AiActionPreset = { id: "list", name: "리스트로 만들기", prompt: "P", kind: "text", isBuiltin: true, hidden: false };
  const editPreset: AiActionPreset = { id: DIAGRAM_EDIT_ID, name: "관계도 수정하기", prompt: "RULES", kind: "diagram", isBuiltin: true, hidden: false };
  const sheetEditPreset: AiActionPreset = { id: SHEET_EDIT_ID, name: "시트 수정하기", prompt: "SHEET_RULES", kind: "sheet", isBuiltin: true, hidden: false };
  const VALID_JSON_SOURCE = JSON.stringify({
    v: 1,
    nodes: [{ id: "n1", label: "세종" }, { id: "n2", label: "장영실" }],
    edges: [{ id: "e1", from: "n1", to: "n2", label: "등용" }],
  });

  // runWithAiResultGate는 AiResultModal(GlobalModalsHost)이 실제로 마운트돼 있을 때만 게이트를
  // 건다(§5 — 모바일처럼 host가 없으면 decide()를 부를 사람이 없어 영원히 멈춘다). 이 스위트는
  // 모달을 렌더하지 않는 순수 스토어 테스트라, host가 있는 척 직접 등록해준다.
  let unregisterGateHost: () => void;
  beforeEach(() => {
    callMock.mockReset();
    emitNoticeMock.mockReset();
    flushAllMock.mockClear();
    useSettingsStore.setState({ aiConfirmBeforeApply: true } as never);
    useAiResultGateStore.setState({ session: null });
    unregisterGateHost = registerAiResultGateHost();
  });

  afterEach(() => {
    unregisterGateHost();
  });

  it("① 액션 클릭 즉시(응답 전) 게이트가 열린다 — 응답이 오기 전에는 삽입도 안 된다", async () => {
    let resolveGenerate: (v: string) => void = () => {};
    const generateFromPrompt = vi.fn(
      () => new Promise<string>((resolve) => { resolveGenerate = resolve; }),
    );
    useAiStore.setState({ generateFromPrompt } as never);
    const insertSection = vi.fn(async () => null);

    const runPromise = runAiAction(textPreset, { contextText: "note body", insertSection, targetNoteId: "note-1" });

    await vi.waitFor(() => {
      expect(useAiResultGateStore.getState().session?.status).toBe("pending");
    });
    expect(insertSection).not.toHaveBeenCalled();

    resolveGenerate("generated text");
    await vi.waitFor(() => {
      expect(useAiResultGateStore.getState().session?.status).toBe("result");
    });
    useAiResultGateStore.getState().decide("insert");

    expect(await runPromise).toBe(true);
    expect(insertSection).toHaveBeenCalledWith("리스트로 만들기", "generated text", "note-1", undefined, { aiOrigin: "list" });
  });

  it("② [버리기]를 누르면 섹션이 생기지 않는다(insert 미호출)", async () => {
    const generateFromPrompt = vi.fn(async () => "generated text");
    useAiStore.setState({ generateFromPrompt } as never);
    const insertSection = vi.fn(async () => null);

    const runPromise = runAiAction(textPreset, { contextText: "note body", insertSection, targetNoteId: "note-1" });
    await vi.waitFor(() => {
      expect(useAiResultGateStore.getState().session?.status).toBe("result");
    });
    useAiResultGateStore.getState().decide("discard");

    expect(await runPromise).toBe(false);
    expect(insertSection).not.toHaveBeenCalled();
    expect(useAiResultGateStore.getState().session).toBeNull();
  });

  it("③ diagram_edit에서 [버리기] 시 replaceSection 미호출(원본 섹션 그대로)", async () => {
    const generateFromPrompt = vi.fn(async () => VALID_JSON_SOURCE);
    useAiStore.setState({ generateFromPrompt } as never);
    const replaceSection = vi.fn(async () => {});

    const runPromise = runAiAction(editPreset, {
      contextText: VALID_JSON_SOURCE,
      insertSection: vi.fn(async () => null),
      diagram: { source: VALID_JSON_SOURCE, instruction: "정인지 추가", replaceSection },
    });
    await vi.waitFor(() => {
      expect(useAiResultGateStore.getState().session?.status).toBe("result");
    });
    useAiResultGateStore.getState().decide("discard");

    expect(await runPromise).toBe(false);
    expect(replaceSection).not.toHaveBeenCalled();
  });

  // ── §2 B-2 재대조 — [삽입] 직전 원본 섹션 재확인 ────────────────────────────────────────
  describe("B2 — [삽입] 직전 원본 재대조(제자리 교체 4분기 공유)", () => {
    it("B2① 대기 중 섹션 source가 바뀌면 [삽입]해도 replaceSection 미호출 + 안내", async () => {
      let liveSource = VALID_JSON_SOURCE;
      const replaceSection = vi.fn(async () => {});
      const unregister = registerDiagramTarget(() => ({
        sectionId: "sec-1",
        source: liveSource,
        instruction: "정인지 추가",
        replaceSection,
      }));
      try {
        const generateFromPrompt = vi.fn(async () => VALID_JSON_SOURCE);
        useAiStore.setState({ generateFromPrompt } as never);

        // ctx.diagram을 안 넘겨 desktop 경로(getDiagramTarget 라이브 게터)를 타게 한다 — 주입
        // 경로(target 파라미터)는 시작/재대조가 같은 객체라 변경을 재현할 수 없다.
        const runPromise = runAiAction(editPreset, { contextText: "", insertSection: vi.fn(async () => null) });
        await vi.waitFor(() => expect(useAiResultGateStore.getState().session?.status).toBe("result"));

        // 대기 중 사용자가 다이어그램을 편집했다고 가정 — 라이브 소스가 바뀐다.
        liveSource = "CHANGED";
        useAiResultGateStore.getState().decide("insert");

        expect(await runPromise).toBe(false);
        expect(replaceSection).not.toHaveBeenCalled();
        expect(emitNoticeMock).toHaveBeenCalledWith(t("aiResult.stale_section_notice"));
      } finally {
        unregister();
      }
    });

    it("B2② 대기 중 섹션이 사라지면([게터 null]) [삽입]해도 replaceSection 미호출", async () => {
      let unmounted = false;
      const replaceSection = vi.fn(async () => {});
      const unregister = registerDiagramTarget(() =>
        unmounted ? null : { sectionId: "sec-1", source: VALID_JSON_SOURCE, instruction: "정인지 추가", replaceSection },
      );
      try {
        const generateFromPrompt = vi.fn(async () => VALID_JSON_SOURCE);
        useAiStore.setState({ generateFromPrompt } as never);

        const runPromise = runAiAction(editPreset, { contextText: "", insertSection: vi.fn(async () => null) });
        await vi.waitFor(() => expect(useAiResultGateStore.getState().session?.status).toBe("result"));

        unmounted = true; // 섹션 언마운트·다른 노트로 이동
        useAiResultGateStore.getState().decide("insert");

        expect(await runPromise).toBe(false);
        expect(replaceSection).not.toHaveBeenCalled();
        expect(emitNoticeMock).toHaveBeenCalledWith(t("aiResult.stale_section_notice"));
      } finally {
        unregister();
      }
    });

    it("B2③ 대기 중 아무 것도 안 바뀌면 [삽입] 시 replaceSection이 정상 호출된다", async () => {
      const replaceSection = vi.fn(async (_body: string) => {});
      const generateFromPrompt = vi.fn(async () => VALID_JSON_SOURCE);
      useAiStore.setState({ generateFromPrompt } as never);

      const runPromise = runAiAction(editPreset, {
        contextText: VALID_JSON_SOURCE,
        insertSection: vi.fn(async () => null),
        diagram: { sectionId: "sec-1", source: VALID_JSON_SOURCE, instruction: "정인지 추가", replaceSection },
      });
      await vi.waitFor(() => expect(useAiResultGateStore.getState().session?.status).toBe("result"));
      useAiResultGateStore.getState().decide("insert");

      expect(await runPromise).toBe(true);
      expect(replaceSection).toHaveBeenCalledTimes(1);
      // 재직렬화(serializeDiagram)로 포맷은 달라질 수 있어도 내용은 같아야 한다 — line 391의
      // 기존 diagram_expand_branch 테스트와 같은 비교 방식.
      expect(JSON.parse(replaceSection.mock.calls[0]![0])).toEqual(JSON.parse(VALID_JSON_SOURCE));
    });

    it("B2④ K5 — 모바일(ctx 주입) 경로: getLive가 있으면 대기 중 source 변경을 실제로 감지해 [삽입]해도 replaceSection 미호출 + 안내", async () => {
      // ctx로 target을 주입하는 경로(MobileAiSheet)는 getLive가 없으면 시작 스냅샷과 자기
      // 자신을 비교해 항상 "신선함"으로 판정한다(구버전 결함) — getLive를 주면 그걸로 "지금"
      // 값을 다시 읽어 B2①(데스크톱 라이브 게터 경로)과 동일하게 staleness를 잡아야 한다.
      let liveSource = VALID_JSON_SOURCE;
      const replaceSection = vi.fn(async () => {});
      const generateFromPrompt = vi.fn(async () => VALID_JSON_SOURCE);
      useAiStore.setState({ generateFromPrompt } as never);

      const runPromise = runAiAction(editPreset, {
        contextText: "",
        insertSection: vi.fn(async () => null),
        diagram: {
          sectionId: "sec-1",
          source: VALID_JSON_SOURCE,
          instruction: "정인지 추가",
          replaceSection,
          getLive: () => ({ sectionId: "sec-1", source: liveSource }),
        },
      });
      await vi.waitFor(() => expect(useAiResultGateStore.getState().session?.status).toBe("result"));

      // 대기 중 모바일 사용자가 다이어그램을 편집했다고 가정 — getLive가 돌려주는 값이 바뀐다.
      liveSource = "CHANGED";
      useAiResultGateStore.getState().decide("insert");

      expect(await runPromise).toBe(false);
      expect(replaceSection).not.toHaveBeenCalled();
      expect(emitNoticeMock).toHaveBeenCalledWith(t("aiResult.stale_section_notice"));
    });
  });

  it("③b sheet_edit에서 [버리기] 시 replaceSection 미호출", async () => {
    const sheetJson = JSON.stringify({ version: 1, cols: [{ id: "A" }], cells: { A1: { raw: "1" } } });
    const generateFromPrompt = vi.fn(async () => sheetJson);
    useAiStore.setState({ generateFromPrompt } as never);
    const replaceSection = vi.fn(async () => {});

    const runPromise = runAiAction(sheetEditPreset, {
      contextText: "",
      insertSection: vi.fn(async () => null),
      sheet: { source: sheetJson, instruction: "정리해줘", replaceSection },
    });
    await vi.waitFor(() => {
      expect(useAiResultGateStore.getState().session?.status).toBe("result");
    });
    useAiResultGateStore.getState().decide("discard");

    expect(await runPromise).toBe(false);
    expect(replaceSection).not.toHaveBeenCalled();
  });

  it("⑤ [다시 생성]이면 생성 함수가 다시 호출된다", async () => {
    const generateFromPrompt = vi.fn(async () => "generated text");
    useAiStore.setState({ generateFromPrompt } as never);
    const insertSection = vi.fn(async () => null);

    const runPromise = runAiAction(textPreset, { contextText: "note body", insertSection, targetNoteId: "note-1" });
    await vi.waitFor(() => {
      expect(useAiResultGateStore.getState().session?.status).toBe("result");
    });
    expect(generateFromPrompt).toHaveBeenCalledTimes(1);

    useAiResultGateStore.getState().decide("retry");
    await vi.waitFor(() => {
      expect(generateFromPrompt).toHaveBeenCalledTimes(2);
    });
    await vi.waitFor(() => {
      expect(useAiResultGateStore.getState().session?.status).toBe("result");
    });
    useAiResultGateStore.getState().decide("insert");

    expect(await runPromise).toBe(true);
    expect(insertSection).toHaveBeenCalledTimes(1);
  });

    it("④ aiConfirmBeforeApply=false면 게이트 없이 즉시 삽입된다(이 describe 안에서도 확인)", async () => {
    useSettingsStore.setState({ aiConfirmBeforeApply: false } as never);
    const generateFromPrompt = vi.fn(async () => "generated text");
    useAiStore.setState({ generateFromPrompt } as never);
    const insertSection = vi.fn(async () => null);

    const ok = await runAiAction(textPreset, { contextText: "note body", insertSection, targetNoteId: "note-1" });

    expect(ok).toBe(true);
    expect(insertSection).toHaveBeenCalledTimes(1);
    expect(useAiResultGateStore.getState().session).toBeNull();
  });

  it("W1: text kind 결과 삽입 시 코드 블록 펜스가 제거된 순수 텍스트가 삽입된다", async () => {
    useSettingsStore.setState({ aiConfirmBeforeApply: false } as never);
    const fencedOutput = "```html\n<p>Clean paragraph</p>\n```";
    const generateFromPrompt = vi.fn(async () => fencedOutput);
    useAiStore.setState({ generateFromPrompt } as never);
    const insertSection = vi.fn(async () => null);

    const ok = await runAiAction(textPreset, { contextText: "note body", insertSection, targetNoteId: "note-1" });

    expect(ok).toBe(true);
    expect(insertSection).toHaveBeenCalledWith(
      textPreset.name,
      "<p>Clean paragraph</p>",
      "note-1",
      undefined,
      { aiOrigin: textPreset.id },
    );
    expect(generateFromPrompt).toHaveBeenCalledWith(
      textPreset.prompt,
      "note body",
      expect.objectContaining({ presetId: textPreset.id }),
    );
  });

  it("W1: sheet kind 결과 파싱 실패 시 빈 시트(emptySheet)를 삽입하지 않고 에러 안내 및 false 반환", async () => {
    useSettingsStore.setState({ aiConfirmBeforeApply: false } as never);
    const brokenSheetJson = "```json\n{ not valid json }\n```";
    const generateFromPrompt = vi.fn(async () => brokenSheetJson);
    useAiStore.setState({ generateFromPrompt } as never);
    const insertSection = vi.fn(async () => null);

    const sheetPreset: AiActionPreset = {
      id: "sheet",
      name: "시트 만들기",
      prompt: "PROMPT",
      kind: "sheet",
      isBuiltin: true,
      hidden: false,
    };

    const ok = await runAiAction(sheetPreset, { contextText: "note body", insertSection, targetNoteId: "note-1" });

    expect(ok).toBe(false);
    expect(insertSection).not.toHaveBeenCalled();
    expect(emitNoticeMock).toHaveBeenCalledWith(t("editor.ai_empty_result"));
  });
});

