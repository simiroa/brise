import { describe, it, expect, vi, beforeEach } from "vitest";

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

const reportFallbackMock = vi.fn();
vi.mock("../../lib/diag", () => ({ reportFallback: (...a: unknown[]) => reportFallbackMock(...a), reportDiag: vi.fn() }));

import { dispatchAskAi, resolveRefs, buildPrompt, whereOptions, defaultWhere } from "./askAiDispatch";
import { __resetSectionTokens, seedSectionTokens, setSectionToken } from "../../lib/sectionTokens";
import { t } from "../../i18n/t";
import type { AskAiTarget } from "./askAiTypes";
import { useAiStore, AI_GLOW_KEYS } from "../../stores/ai";
import { useAiPresetsStore } from "../../stores/aiPresets";
import { useAiInstructionsStore } from "../../stores/aiInstructions";
import { DIAGRAM_EDIT_ID, DIAGRAM_EXPAND_BRANCH_ID, SHEET_CREATE_ID, type AiActionPreset } from "../../stores/aiPrompts";
import { useNotesStore } from "../../stores/notes";
import { registerSectionInserter, registerDiagramTarget, registerActiveSectionGetter, registerActiveEditor } from "../../lib/aiSectionBridge";
import { clearWeatherCache } from "../../lib/weather";
import { useSettingsStore } from "../../stores/settings";

// AI 프리셋 목록의 실제 모양 — 타일은 요청 문장(여기선 "TILE SENTENCE")을, 타일이 없는 id 는 문장 없는 자리를 든다.
// 엔진 장문(관계도·시트 규칙, 메타데이터 기준)은 지침 저장소가 든다(beforeEach). 두 곳의 값이 달라야, 관계도·시트
// 경로가 **지침**을 읽는지 검증된다 — 2026-09-28 검토 전엔 목록에서 타일 문장을 읽거나 null 을 받아 깨져 있었다.
const PRESETS: AiActionPreset[] = [
  { id: "metadata", name: "데이터 자동 채우기", prompt: "TILE SENTENCE", kind: "metadata", isBuiltin: true, hidden: false },
  { id: DIAGRAM_EDIT_ID, name: "관계도 수정하기", prompt: "", kind: "diagram", isBuiltin: true, hidden: false },
  { id: DIAGRAM_EXPAND_BRANCH_ID, name: "분기 전개", prompt: "TILE SENTENCE", kind: "diagram", isBuiltin: true, hidden: false },
  { id: "diagram", name: "관계도 만들기", prompt: "TILE SENTENCE", kind: "diagram", isBuiltin: true, hidden: false },
  { id: SHEET_CREATE_ID, name: "시트 만들기", prompt: "", kind: "sheet", isBuiltin: true, hidden: false },
];

const noteTarget: AskAiTarget = { kind: "note", noteId: "note-1", noteTitle: "Note 1" };
const sectionTarget: AskAiTarget = { kind: "section", sectionId: "s1", sectionName: "Overview", sectionBody: "hello world", isDiagram: false, diagramMounted: false };
const selectionTarget: AskAiTarget = { kind: "selection", selectedText: "picked", from: 1, to: 7 };
const diagramTarget: AskAiTarget = { kind: "section", sectionId: "d1", sectionName: "Flow", sectionBody: "{}", isDiagram: true, diagramMounted: true };
const sheetTarget: AskAiTarget = { kind: "section", sectionId: "t1", sectionName: "Sheet", sectionBody: "", isDiagram: false, diagramMounted: false, isSheet: true, sheetMounted: false };

const live = { selectionAlive: true, diagramMounted: true, sheetMounted: true };
const dead = { selectionAlive: false, diagramMounted: false, sheetMounted: false };

describe("askAiDispatch", () => {
  let insertSectionMock: ReturnType<typeof vi.fn>;
  let selectNote: ReturnType<typeof vi.fn>;
  let loadTree: ReturnType<typeof vi.fn>;
  let reloadActive: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    callMock.mockReset();
    emitNoticeMock.mockReset();
    flushAllMock.mockClear();
    reportFallbackMock.mockClear();
    __resetSectionTokens();
    registerActiveSectionGetter(() => null);
    registerActiveEditor(() => null);
    registerDiagramTarget(() => null);
    callMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "settings_get_all") return Promise.resolve({ settings: { ai_enabled: false, ai_provider: "ollama", ai_endpoint: "" } });
      if (cmd === "ai_generate_from_prompt") {
        if (args?.preset_id === "sheet") {
          return Promise.resolve({
            generated: JSON.stringify({ version: 1, cols: [{ id: "A" }], cells: { A1: { raw: "표" } } }),
          });
        }
        return Promise.resolve({ generated: "GENERATED" });
      }
      if (cmd === "note_create") return Promise.resolve({ note: { id: "new-1", folder_id: "f-2", title: "T" }, sections: [{ id: "new-s1", name: "Overview", body_md: "", position: 0, kind: "text" }], sources: [], attachments: [] });
      if (cmd === "note_get") return Promise.resolve({ note: { id: "other", title: "Other" }, sections: [{ id: "o1", body_md: "other body", kind: "text" }], sources: [], attachments: [] });
      if (cmd === "section_update") return Promise.resolve({ updated_at: "now" });
      return Promise.resolve({});
    });
    useAiPresetsStore.setState({ list: PRESETS, loaded: true });
    // 엔진 지침은 AI 프리셋 목록이 아니라 지침 저장소가 든다(2026-09-28 검토) — 관계도·시트·메타데이터 경로는 여기서 읽는다.
    useAiInstructionsStore.setState({
      instructions: {
        metadata: "METADATA GUIDANCE",
        [DIAGRAM_EDIT_ID]: "DIAGRAM EDIT RULES",
        [DIAGRAM_EXPAND_BRANCH_ID]: "EXPAND RULES",
        diagram: "DIAGRAM CREATE RULES",
        [SHEET_CREATE_ID]: "SHEET CREATE RULES",
      },
      loaded: true,
    });
    useAiStore.setState({ organizePending: false, lastProposal: null, lastProposalNoteId: null, translateGateOk: null });
    selectNote = vi.fn(async () => {});
    loadTree = vi.fn(async () => {});
    reloadActive = vi.fn(async () => {});
    useNotesStore.setState({
      activeNote: {
        note: { id: "note-1", title: "Note 1", folder_id: "f-1" },
        sections: [{ id: "s1", name: "Overview", body_md: "hello world", position: 0, kind: "text" }],
      },
      selectNote,
      loadTree,
      reloadActive,
    } as never);
    insertSectionMock = vi.fn(async () => null);
    registerSectionInserter(insertSectionMock as never);
  });

  it("section: resolves [body], inserts a new text section with the source line", async () => {
    await dispatchAskAi({
      req: { instruction: "요약해줘 : [본문]", slots: {} }, refs: [{ k: "body" }],
      where: "section",
      target: noteTarget,
      attached: [{ name: "notes.txt", size: 3, content: "abc" }],
      title: "요약",
    });
    const gen = callMock.mock.calls.find((c) => c[0] === "ai_generate_from_prompt")!;
    expect(gen[1].prompt).toContain("요약해줘 : [본문]\n\n[Body]\nhello world");
    expect(gen[1].prompt).toContain("[Attached file: notes.txt]\nabc");
    expect(insertSectionMock).toHaveBeenCalledTimes(1);
    const [name, body, noteId, kind, origin] = insertSectionMock.mock.calls[0];
    expect(name).toBe("AI result");
    expect(body).toContain("GENERATED");
    expect(body).toContain("notes.txt");
    expect(noteId).toBe("note-1");
    expect(kind).toBeUndefined();
    expect(origin).toBe("prompt");
  });

  // AI-GLOW BEAM(오너 2026-09-28) — AskAiModal 은 자기 안에서 이미 빛줄기를 보여주므로, 그 안에서 도는
  // dispatchAskAi 는 에디터 테두리 발광(AI_GLOW_KEYS.editor)을 켜면 안 된다. 모달 밖 직접 호출
  // (generateFromPrompt 를 바로 부르는 SectionTabBar 등)은 그대로 에디터가 켜져야 한다 — 대조군으로 확인.
  it("suppresses the editor-wide glow key while dispatching (the modal shows its own beam)", async () => {
    let resolveGenerate!: (v: unknown) => void;
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "settings_get_all") return Promise.resolve({ settings: { ai_enabled: false, ai_provider: "ollama", ai_endpoint: "" } });
      if (cmd === "ai_generate_from_prompt") return new Promise((resolve) => { resolveGenerate = resolve; });
      return Promise.resolve({});
    });
    const editorKey = AI_GLOW_KEYS.editor("note-1");
    const dispatched = dispatchAskAi({
      req: { instruction: "요약해줘", slots: {} }, refs: [],
      where: "section",
      target: noteTarget,
      attached: [],
      title: "요약",
    });
    await vi.waitFor(() => expect(callMock).toHaveBeenCalledWith("ai_generate_from_prompt", expect.anything()));
    expect(useAiStore.getState().aiGlowTargets.get(editorKey)).toBeUndefined();
    resolveGenerate({ generated: "GENERATED" });
    await dispatched;
  });

  it("(대조군) dispatch 밖에서 직접 부른 generateFromPrompt 는 여전히 에디터 테두리를 켠다", async () => {
    let resolveGenerate!: (v: unknown) => void;
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "settings_get_all") return Promise.resolve({ settings: { ai_enabled: false, ai_provider: "ollama", ai_endpoint: "" } });
      if (cmd === "ai_generate_from_prompt") return new Promise((resolve) => { resolveGenerate = resolve; });
      return Promise.resolve({});
    });
    const editorKey = AI_GLOW_KEYS.editor("note-1");
    const gen = useAiStore.getState().generateFromPrompt("요약해줘", null);
    await vi.waitFor(() => expect(callMock).toHaveBeenCalledWith("ai_generate_from_prompt", expect.anything()));
    expect(useAiStore.getState().aiGlowTargets.get(editorKey)).toBe("active");
    resolveGenerate({ generated: "GENERATED" });
    await gen;
  });

  it("note: note_create in the chosen folder, fills its first section, then opens it", async () => {
    await dispatchAskAi({
      req: { instruction: "새 글", slots: {} }, refs: [],
      where: "note",
      folderId: "f-2",
      target: noteTarget,
      attached: [],
      title: "새 글",
    });
    expect(callMock).toHaveBeenCalledWith("note_create", { folder_id: "f-2", title: "새 글" });
    expect(callMock).toHaveBeenCalledWith("section_update", { id: "new-s1", body_md: "GENERATED", ai_origin: "prompt" });
    expect(insertSectionMock).not.toHaveBeenCalled();
    expect(loadTree).toHaveBeenCalled();
    expect(selectNote).toHaveBeenCalledWith("new-1");
  });

  it("note without folderId falls back to the active note's folder", async () => {
    await dispatchAskAi({ req: { instruction: "x", slots: {} }, refs: [], where: "note", target: noteTarget, attached: [], title: "x" });
    expect(callMock).toHaveBeenCalledWith("note_create", expect.objectContaining({ folder_id: "f-1" }));
  });

  it("replace + selection: replaces the editor range in place", async () => {
    const run = vi.fn();
    const insertContentAt = vi.fn(() => ({ run }));
    const chain = () => ({ focus: () => ({ insertContentAt }) });
    registerActiveEditor(() => ({ isDestroyed: false, chain }) as never);
    await dispatchAskAi({
      req: { instruction: "다듬어줘 : [선택]", slots: {} }, refs: [{ k: "selection" }],
      where: "replace",
      target: selectionTarget,
      attached: [],
      title: "다듬기",
    });
    const gen = callMock.mock.calls.find((c) => c[0] === "ai_generate_from_prompt")!;
    expect(gen[1].prompt).toContain("[Selection]\npicked");
    expect(insertContentAt).toHaveBeenCalledWith({ from: 1, to: 7 }, "GENERATED");
    expect(run).toHaveBeenCalled();
    expect(insertSectionMock).not.toHaveBeenCalled();
  });

  it("replace + text section: flushes, section_update body_md, then reloads the active note", async () => {
    await dispatchAskAi({
      req: { instruction: "교정 : [섹션]", slots: {} }, refs: [{ k: "section", id: "s1" }],
      where: "replace",
      target: sectionTarget,
      attached: [],
      title: "교정",
    });
    expect(flushAllMock).toHaveBeenCalled();
    expect(callMock).toHaveBeenCalledWith("section_update", { id: "s1", body_md: "GENERATED", ai_origin: "prompt" });
    expect(reloadActive).toHaveBeenCalled();
    expect(insertSectionMock).not.toHaveBeenCalled();
  });

  // D2② W4 — AI 본문 교체는 AI 가 섹션을 읽은 시점의 토큰을 들고 쓴다. 그 사이 섹션이 바뀌었으면(CONFLICT) 덮지
  // 않고 새 섹션으로 넣는다.
  describe("replace + text section: read-time token", () => {
    const run = (extra: Record<string, unknown> = {}) =>
      dispatchAskAi({
        req: { instruction: "교정 : [섹션]", slots: {} }, refs: [{ k: "section", id: "s1" }],
        where: "replace", target: sectionTarget, attached: [], title: "교정", ...extra,
      });
    /** section_update 응답을 바꿔 끼우고, 생성 중에 이 기기의 자동 저장이 토큰을 올린 상황을 흉내 낸다. */
    const installGenerateThenWrite = (onUpdate: (args: Record<string, unknown>) => unknown) => {
      const base = callMock.getMockImplementation()!;
      callMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "ai_generate_from_prompt") {
          setSectionToken("s1", "tok-after-local-save"); // 생성 중 저장 → 토큰이 움직였다
          return Promise.resolve({ generated: "GENERATED" });
        }
        if (cmd === "section_update") return onUpdate(args!);
        return base(cmd, args);
      });
    };

    it("sends the token captured when the section was read (not the one at apply time) and reloads with the section marked rewritten", async () => {
      seedSectionTokens([{ id: "s1", updated_at: "tok-read" }]);
      installGenerateThenWrite(() => Promise.resolve({ updated_at: "note-ts", section_updated_at: "tok-ai" }));
      const res = await run();
      expect(res).toMatchObject({ applied: true });
      const updates = callMock.mock.calls.filter((c) => c[0] === "section_update");
      expect(updates).toHaveLength(1);
      expect(updates[0][1]).toEqual({ id: "s1", body_md: "GENERATED", ai_origin: "prompt", expected_updated_at: "tok-read" });
      // 캐시 폐기 + 새 토큰 seed 는 reloadActive 몫(notes.conflict.test.ts 가 실제 스토어로 검증).
      expect(reloadActive).toHaveBeenCalledWith({ rewritten: ["s1"] });
      expect(insertSectionMock).not.toHaveBeenCalled();
      expect(reportFallbackMock).not.toHaveBeenCalled();
    });

    it("CONFLICT: does not retry the overwrite — inserts the result as a new section, records the fallback and tells the user", async () => {
      seedSectionTokens([{ id: "s1", updated_at: "tok-read" }]);
      installGenerateThenWrite(() => Promise.reject({ code: "CONFLICT", message: "section changed since read" }));
      insertSectionMock.mockResolvedValue({ id: "ai-new", name: "AI result", body_md: "GENERATED", position: 1, kind: "text" });
      const res = await run();
      expect(res).toMatchObject({ applied: true });
      expect(callMock.mock.calls.filter((c) => c[0] === "section_update")).toHaveLength(1);
      expect(insertSectionMock).toHaveBeenCalledTimes(1);
      const [name, body, noteId, kind, origin] = insertSectionMock.mock.calls[0];
      expect([name, body, noteId, kind, origin]).toEqual(["AI result", "GENERATED", "note-1", undefined, "prompt"]);
      expect(reportFallbackMock).toHaveBeenCalledWith("askai", "replace_conflict_new_section");
      expect(emitNoticeMock).toHaveBeenCalledWith(t("aiResult.replace_conflict_new_section"));
      expect(reloadActive).not.toHaveBeenCalled();
    });

    it("CONFLICT and the new-section insert also fails → not applied", async () => {
      seedSectionTokens([{ id: "s1", updated_at: "tok-read" }]);
      installGenerateThenWrite(() => Promise.reject({ code: "CONFLICT", message: "x" }));
      const res = await run(); // insertSectionMock 기본값은 null(잠금·노트 전환 등)
      expect(res).toMatchObject({ applied: false });
    });

    it("another failure (e.g. note in trash) is a plain failure: message shown, no new section", async () => {
      seedSectionTokens([{ id: "s1", updated_at: "tok-read" }]);
      installGenerateThenWrite(() => Promise.reject({ code: "NOT_FOUND", message: "note is in trash: note-1" }));
      const res = await run();
      expect(res).toMatchObject({ applied: false });
      expect(insertSectionMock).not.toHaveBeenCalled();
      expect(emitNoticeMock).toHaveBeenCalledWith("note is in trash: note-1");
    });

    it("cached version: sends the token recorded with that version (cachedBase.token)", async () => {
      seedSectionTokens([{ id: "s1", updated_at: "tok-now" }]);
      await run({ cachedResult: "CACHED v1", cachedBase: { sectionId: "s1", source: "hello world", token: "tok-at-generation" } });
      expect(callMock).toHaveBeenCalledWith("section_update", {
        id: "s1", body_md: "CACHED v1", ai_origin: "prompt", expected_updated_at: "tok-at-generation",
      });
    });
  });

  // 버전 비교의 "이전 버전 삽입"(2026-09-27) — 캐시된 텍스트를 생성 없이, 게이트 없이 그대로 적용한다.
  describe("cachedResult", () => {
    it("replace + text section: writes the cached text with no generate call (even though replace always reviews)", async () => {
      const res = await dispatchAskAi({
        req: { instruction: "교정", slots: {} }, refs: [{ k: "section", id: "s1" }],
        where: "replace", target: sectionTarget, attached: [], title: "교정", cachedResult: "CACHED v1",
      });
      expect(res).toMatchObject({ applied: true });
      expect(callMock).toHaveBeenCalledWith("section_update", { id: "s1", body_md: "CACHED v1", ai_origin: "prompt" });
      expect(callMock.mock.calls.some((c) => c[0] === "ai_generate_from_prompt")).toBe(false);
      // 참조도 풀지 않는다(노트 본문 참조는 대상 노트를 열어 탭을 바꿀 수 있다).
      expect(selectNote).not.toHaveBeenCalled();
    });

    it("never lets a cached text reach a diagram route (it would become that route's prompt)", async () => {
      const res = await dispatchAskAi({
        req: { instruction: "x", slots: {} }, refs: [], where: "replace", target: diagramTarget, attached: [], title: "x", cachedResult: "CACHED",
      });
      expect(res).toMatchObject({ applied: false });
      expect(callMock.mock.calls.some((c) => c[0] === "ai_generate_from_prompt")).toBe(false);
    });
  });

  // 메타데이터 스위치(2026-09-26) — 후속 제안은 결과가 **대상 노트 안에** 실제로 쓰였을 때만.
  describe("includeMetadata", () => {
    let organizeCurrentNote: ReturnType<typeof vi.fn>;
    beforeEach(() => {
      organizeCurrentNote = vi.fn(async () => {});
      useAiStore.setState({ organizeCurrentNote } as never);
    });

    it("replace + text section applied → metadata proposal for the target note after the write", async () => {
      const res = await dispatchAskAi({
        req: { instruction: "영어로 번역해줘", slots: {} }, refs: [{ k: "section", id: "s1" }],
        where: "replace", target: sectionTarget, attached: [], title: "번역", includeMetadata: true,
      });
      // 반영됐다는 사실은 후속 제안을 기다리지 않고 바로 돌아온다 — AI 모달이 그 사이 닫힐 수 있게.
      expect(res).toMatchObject({ applied: true });
      await res!.followUp;
      expect(callMock).toHaveBeenCalledWith("section_update", expect.objectContaining({ id: "s1" }));
      expect(organizeCurrentNote).toHaveBeenCalledTimes(1);
      const [noteId, fields, guidance] = organizeCurrentNote.mock.calls[0];
      expect(noteId).toBe("note-1");
      expect(fields).toEqual(["title", "tags", "year", "region"]);
      expect(guidance).toContain("METADATA GUIDANCE");
      expect(guidance).toContain("영어로 번역해줘");
    });

    it("where=note never touches the source note's metadata", async () => {
      await dispatchAskAi({ req: { instruction: "x", slots: {} }, refs: [], where: "note", target: noteTarget, attached: [], title: "x", includeMetadata: true });
      expect(callMock).toHaveBeenCalledWith("note_create", expect.anything());
      expect(organizeCurrentNote).not.toHaveBeenCalled();
    });

    it("the write failed → no metadata proposal", async () => {
      callMock.mockImplementation((cmd: string) => {
        if (cmd === "settings_get_all") return Promise.resolve({ settings: { ai_enabled: false, ai_provider: "ollama", ai_endpoint: "" } });
        if (cmd === "ai_generate_from_prompt") return Promise.resolve({ generated: "GENERATED" });
        if (cmd === "section_update") return Promise.reject(new Error("locked"));
        return Promise.resolve({});
      });
      await dispatchAskAi({
        req: { instruction: "교정", slots: {} }, refs: [], where: "replace", target: sectionTarget, attached: [], title: "교정", includeMetadata: true,
      });
      expect(organizeCurrentNote).not.toHaveBeenCalled();
    });

    it("section applied but the switch is off → content only", async () => {
      await dispatchAskAi({ req: { instruction: "x", slots: {} }, refs: [], where: "section", target: noteTarget, attached: [], title: "x" });
      expect(insertSectionMock).toHaveBeenCalled();
      expect(organizeCurrentNote).not.toHaveBeenCalled();
    });
  });

  // 이전 버전(캐시한 관계도)을 교체로 넣을 때 — 그 결과를 만들 때의 원본과 지금 원본이 다르면 넣지 않는다(교체는 되돌릴
  // 수 없다, runAiAction applyIfFresh 와 같은 규칙). 2026-09-28 검토 B2: 이 확인 없이 덮어썼다.
  describe("cached diagram version into a replace target", () => {
    const cached = JSON.stringify({ v: 1, nodes: [{ id: "n1", label: "A" }, { id: "n2", label: "B" }], edges: [{ id: "e1", from: "n1", to: "n2" }] });
    const input = (cachedBase?: { sectionId?: string; source: string }) => ({
      req: { instruction: "정렬해줘", slots: {} }, refs: [], where: "replace" as const, target: diagramTarget, attached: [], title: "정렬",
      presetKind: "diagram" as const, cachedResult: cached, cachedBase,
    });

    it("inserts when the live diagram is still the one the version was made from", async () => {
      const replaceSection = vi.fn(async () => {});
      registerDiagramTarget(() => ({ sectionId: "d1", source: "SRC-1", replaceSection }));
      const res = await dispatchAskAi(input({ sectionId: "d1", source: "SRC-1" }));
      expect(res?.applied).toBe(true);
      expect(replaceSection).toHaveBeenCalledWith(cached);
    });

    it("refuses (stale notice, nothing written) when the diagram changed since, or the base is unknown", async () => {
      const replaceSection = vi.fn(async () => {});
      registerDiagramTarget(() => ({ sectionId: "d1", source: "SRC-2", replaceSection }));
      expect((await dispatchAskAi(input({ sectionId: "d1", source: "SRC-1" })))?.applied).toBeFalsy();
      expect((await dispatchAskAi(input(undefined)))?.applied).toBeFalsy();
      expect(replaceSection).not.toHaveBeenCalled();
      expect(emitNoticeMock).toHaveBeenCalled();
    });
  });

  it("replace + diagram: routes to the diagram_edit preset with the live source, dropping body/section refs", async () => {
    const replaceSection = vi.fn(async () => {});
    registerDiagramTarget(() => ({ sectionId: "d1", source: '{"nodes":[]}', replaceSection }));
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "settings_get_all") return Promise.resolve({ settings: { ai_enabled: false, ai_provider: "ollama", ai_endpoint: "" } });
      if (cmd === "ai_generate_from_prompt") return Promise.resolve({ generated: '{"nodes":[{"id":"a","label":"A"}],"edges":[]}' });
      return Promise.resolve({});
    });
    await dispatchAskAi({
      req: { instruction: "정렬해줘 : [본문]", slots: {} }, refs: [{ k: "section", id: "d1" }],
      where: "replace",
      target: diagramTarget,
      attached: [],
      title: "정렬",
    });
    const gen = callMock.mock.calls.find((c) => c[0] === "ai_generate_from_prompt")!;
    expect(gen[1].prompt).toContain("DIAGRAM EDIT RULES");
    expect(gen[1].prompt).toContain("정렬해줘");
    expect(gen[1].prompt).not.toContain("[Section]");
    expect(insertSectionMock).not.toHaveBeenCalled();
  });

  it("replace + diagram + expand-branch preset: needs a selected node, then runs the expand prompt with the sentence as [Request]", async () => {
    const replaceSection = vi.fn(async () => {});
    registerDiagramTarget(() => ({ sectionId: "d1", source: '{"nodes":[]}', replaceSection }));
    const base = { req: { instruction: "하위 3개만 전개", slots: {} }, refs: [], where: "replace" as const, target: diagramTarget, attached: [], title: "전개", presetId: DIAGRAM_EXPAND_BRANCH_ID };
    await dispatchAskAi(base);
    expect(emitNoticeMock).toHaveBeenCalledTimes(1);
    expect(callMock.mock.calls.some((c) => c[0] === "ai_generate_from_prompt")).toBe(false);

    registerDiagramTarget(() => ({ sectionId: "d1", source: '{"nodes":[]}', selectedNodeId: "n1", selectedNodeLabel: "A", replaceSection }));
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "settings_get_all") return Promise.resolve({ settings: { ai_enabled: false, ai_provider: "ollama", ai_endpoint: "" } });
      if (cmd === "ai_generate_from_prompt") return Promise.resolve({ generated: '{"nodes":[{"id":"n1","label":"A"}],"edges":[]}' });
      return Promise.resolve({});
    });
    await dispatchAskAi(base);
    const gen = callMock.mock.calls.find((c) => c[0] === "ai_generate_from_prompt")!;
    expect(gen[1].prompt).toContain("EXPAND RULES");
    expect(gen[1].prompt).toContain("[Request]\n하위 3개만 전개");
    expect(gen[1].prompt).toContain('"A" (ID: n1)');
    expect(gen[1].prompt).not.toContain("DIAGRAM EDIT RULES");
  });

  it("presetKind=diagram + section: runs the diagram CREATE preset with the instruction as a [Request] block in the prompt", async () => {
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "settings_get_all") return Promise.resolve({ settings: { ai_enabled: false, ai_provider: "ollama", ai_endpoint: "" } });
      if (cmd === "ai_generate_from_prompt") return Promise.resolve({ generated: '{"nodes":[{"id":"a","label":"A"}],"edges":[]}' });
      return Promise.resolve({});
    });
    await dispatchAskAi({
      req: { instruction: "인물 관계를 관계도로 : [본문]", slots: {} }, refs: [{ k: "body" }],
      where: "section",
      target: noteTarget,
      attached: [],
      title: "관계도",
      presetId: "diagram",
      presetKind: "diagram",
    });
    const gen = callMock.mock.calls.find((c) => c[0] === "ai_generate_from_prompt")!;
    expect(gen[1].prompt).toContain("DIAGRAM CREATE RULES");
    expect(gen[1].prompt).toContain("[Request]\n인물 관계를 관계도로 : [본문]");
    expect(gen[1].context_text).toContain("[Body]\nhello world");
    expect(gen[1].context_text).not.toContain("[Request]");
    expect(insertSectionMock).toHaveBeenCalledTimes(1);
    const [name, , noteId, kind, origin] = insertSectionMock.mock.calls[0];
    expect(name).toBe("관계도 만들기");
    expect(noteId).toBe("note-1");
    expect(kind).toBe("diagram");
    expect(origin).toBe("diagram");
  });

  // AUDIT-2026-09-22 후속 회귀 가드: 요청문이 contextText 에서 preset.prompt 로 옮겨간 뒤,
  // 참조 칩이 하나도 없으면 contextText 가 빈 문자열이 되어 runAiAction 의 빈 본문 가드에
  // 걸리고 모델을 한 번도 부르지 않은 채 조용히 죽었다. AskAiModal 의 새 노트 대상은
  // ctxList 가 빈 배열로 시작하므로 이게 예외가 아니라 기본 경로다.
  it("presetKind=diagram + refs 없음: 요청문만으로도 생성이 돌아간다", async () => {
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "settings_get_all") return Promise.resolve({ settings: { ai_enabled: false, ai_provider: "ollama", ai_endpoint: "" } });
      if (cmd === "ai_generate_from_prompt") return Promise.resolve({ generated: '{"nodes":[{"id":"a","label":"A"}],"edges":[]}' });
      return Promise.resolve({});
    });
    await dispatchAskAi({
      req: { instruction: "A가 B를 관리하는 관계도 그려줘", slots: {} }, refs: [],
      where: "section",
      target: noteTarget,
      attached: [],
      title: "관계도",
      presetId: "diagram",
      presetKind: "diagram",
    });
    const gen = callMock.mock.calls.find((c) => c[0] === "ai_generate_from_prompt");
    expect(gen).toBeTruthy();
    expect(gen![1].prompt).toContain("[Request]\nA가 B를 관리하는 관계도 그려줘");
    // 참조가 없으므로 빈 컨텍스트는 아예 실리지 않는다(센티넬로 채우지 않는다).
    expect(gen![1].context_text).toBeUndefined();
    expect(insertSectionMock).toHaveBeenCalledTimes(1);
  });

  it("presetKind=sheet + note: creates the note only when the gate inserts, then puts the sheet section in it and opens it", async () => {
    await dispatchAskAi({
      req: { instruction: "표로 정리 : [본문]", slots: {} }, refs: [{ k: "body" }],
      where: "note",
      folderId: "f-2",
      target: noteTarget,
      attached: [],
      title: "표",
      presetId: SHEET_CREATE_ID,
      presetKind: "sheet",
    });
    const gen = callMock.mock.calls.find((c) => c[0] === "ai_generate_from_prompt")!;
    expect(gen[1].prompt).toContain("SHEET CREATE RULES");
    expect(gen[1].prompt).toContain("[Request]\n표로 정리");
    expect(gen[1].context_text).toContain("[Body]\nhello world");
    expect(gen[1].context_text).not.toContain("[Request]");
    expect(callMock).toHaveBeenCalledWith("note_create", { folder_id: "f-2", title: "표" });
    expect(insertSectionMock).toHaveBeenCalledTimes(1);
    const [, , noteId, kind] = insertSectionMock.mock.calls[0];
    expect(noteId).toBe("new-1");
    expect(kind).toBe("sheet");
    expect(loadTree).toHaveBeenCalled();
    expect(selectNote).toHaveBeenCalledWith("new-1");
  });

  it("proposal + tags: organizeCurrentNote(noteId, ['tags'], instruction as guidance)", async () => {
    const organizeCurrentNote = vi.fn(async () => {});
    useAiStore.setState({ organizeCurrentNote } as never);
    const res = await dispatchAskAi({
      req: { instruction: "태그 5개만", slots: {} }, refs: [],
      where: "proposal",
      proposal: "tags",
      target: noteTarget,
      attached: [],
      title: "태그",
    });
    expect(res).toBeUndefined();
    expect(organizeCurrentNote).toHaveBeenCalledWith("note-1", ["tags"], "태그 5개만");
  });

  it("proposal + metadata with an empty instruction falls back to the metadata preset prompt", async () => {
    const organizeCurrentNote = vi.fn(async () => {});
    useAiStore.setState({ organizeCurrentNote } as never);
    await dispatchAskAi({ req: { instruction: "  ", slots: {} }, refs: [], where: "proposal", proposal: "metadata", target: noteTarget, attached: [], title: "" });
    expect(organizeCurrentNote).toHaveBeenCalledWith("note-1", ["title", "tags", "year", "region", "folder"], "METADATA GUIDANCE");
  });

  it("missing refs are reported once and the rest still goes out", async () => {
    const { blocks, missing } = await resolveRefs(
      [{ k: "selection" }, { k: "file", name: "gone.txt" }, { k: "note", id: "other" }, { k: "section", id: "nope" }],
      noteTarget,
      [],
    );
    expect(missing).toEqual([{ k: "selection" }, { k: "file", name: "gone.txt" }, { k: "section", id: "nope" }]);
    expect(blocks).toEqual(["[Note]\nother body"]);
    // note ref reads via note_get — never selectNote (side context must not switch the tab)
    expect(callMock).toHaveBeenCalledWith("note_get", { id: "other" });
    expect(selectNote).not.toHaveBeenCalled();

    await dispatchAskAi({ req: { instruction: "x : [선택]", slots: {} }, refs: [{ k: "selection" }], where: "section", target: noteTarget, attached: [], title: "x" });
    expect(emitNoticeMock).toHaveBeenCalledTimes(1);
    expect(emitNoticeMock.mock.calls[0][0]).toContain("Selection");
    expect(insertSectionMock).toHaveBeenCalledTimes(1);
  });

  it("buildPrompt appends attachments not referenced by a file ref, once each", () => {
    const attached = [
      { name: "a.md", size: 1, content: "A" },
      { name: "b.md", size: 1, content: "B" },
    ];
    const out = buildPrompt({ instruction: "do : [파일]", slots: {} }, [{ k: "file", name: "a.md" }], ["[Attached file: a.md]\nA"], attached);
    expect(out).toBe("do : [파일]\n\n[Attached file: a.md]\nA\n\n[Attached file: b.md]\nB");
  });

  it("folder ref: gathers the folder's notes newest-first and stops at the ceiling with a marker", async () => {
    // 상한(20개)을 넘기는 폴더 — 최근 20개만 실리고 마지막 줄이 잘렸다고 말한다.
    const many = Array.from({ length: 25 }, (_, i) => ({ id: `n${i}`, title: `노트 ${i}`, updated_at: `2026-09-${String(i + 1).padStart(2, "0")}` }));
    useNotesStore.setState({ notesByFolder: { "f-1": many } } as never);
    callMock.mockImplementation((cmd: string, args: { id: string }) => {
      if (cmd === "note_get") return Promise.resolve({ note: { id: args.id, title: `제목 ${args.id}` }, sections: [{ id: "s", body_md: `본문 ${args.id}`, kind: "text" }], sources: [], attachments: [] });
      return Promise.resolve({});
    });
    const { blocks, missing } = await resolveRefs([{ k: "folder", id: "f-1" }], noteTarget, []);
    expect(missing).toEqual([]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain("[Notes in folder]");
    // 최근순(updated_at 내림차순) — n24 가 맨 앞, n0..n4 는 아예 빠진다.
    expect(blocks[0]).toContain("## 제목 n24");
    expect(blocks[0]).not.toContain("## 제목 n0" + String.fromCharCode(10));
    expect(blocks[0].match(/^## /gm)).toHaveLength(20);
    expect(blocks[0]).toContain("truncated at the size ceiling");
    expect(blocks[0]).toContain("20 most recent");

    // 빈 폴더는 없는 참조다.
    useNotesStore.setState({ notesByFolder: {} } as never);
    expect((await resolveRefs([{ k: "folder", id: "f-1" }], noteTarget, [])).missing).toEqual([{ k: "folder", id: "f-1" }]);
  });

  it("weather ref: resolves from the saved location, and is a missing ref without one", async () => {
    clearWeatherCache();
    useSettingsStore.setState({ defaultMapLocationCustomized: false } as never);
    expect((await resolveRefs([{ k: "weather" }], noteTarget, [])).missing).toEqual([{ k: "weather" }]);

    useSettingsStore.setState({ defaultMapLocationCustomized: true, defaultMapLocation: { lat: 37.5, lng: 127, zoom: 11 } } as never);
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "weather_forecast") {
        return Promise.resolve({
          entries: [
            { time: "2026-09-15T09:00:00Z", temp_c: 21, symbol_1h: "clearsky_day", symbol_6h: null },
            { time: "2026-09-16T09:00:00Z", temp_c: 17, symbol_1h: "rain", symbol_6h: null },
          ],
        });
      }
      return Promise.resolve({});
    });
    const { blocks, missing } = await resolveRefs([{ k: "weather" }], noteTarget, []);
    expect(missing).toEqual([]);
    expect(blocks[0]).toContain("[Weather]");
    expect(blocks[0]).toContain("Clear");
    expect(blocks[0].split(String.fromCharCode(10))).toHaveLength(3); // 머리말 + 오늘 + 내일
    clearWeatherCache();
  });

  it("whereOptions matrix", () => {
    expect(whereOptions(noteTarget, live).map((o) => o.value)).toEqual(["section", "note"]);
    expect(whereOptions(sectionTarget, live).map((o) => o.value)).toEqual(["section", "note", "replace"]);
    expect(whereOptions(diagramTarget, live).map((o) => o.value)).toEqual(["replace", "section", "note"]);
    expect(whereOptions(sheetTarget, live).map((o) => o.value)).toEqual(["replace", "section", "note"]);
    expect(whereOptions(selectionTarget, live).map((o) => o.value)).toEqual(["section", "note", "replace"]);

    const sel = whereOptions(selectionTarget, dead).find((o) => o.value === "replace")!;
    expect(sel.disabled).toBe(true);
    expect(sel.hint).toBeTruthy();
    const dia = whereOptions(diagramTarget, dead)[0];
    expect(dia.disabled).toBe(true);
    expect(dia.hint).toBeTruthy();
    expect(whereOptions(sheetTarget, dead)[0].disabled).toBe(true);
    expect(whereOptions(sectionTarget, dead).every((o) => !o.disabled)).toBe(true);
  });

  it("defaultWhere: preset's where if allowed, else first enabled, proposal always", () => {
    expect(defaultWhere(diagramTarget, undefined, live)).toBe("replace");
    expect(defaultWhere(diagramTarget, undefined, dead)).toBe("section");
    expect(defaultWhere(selectionTarget, "replace", live)).toBe("replace");
    expect(defaultWhere(selectionTarget, "replace", dead)).toBe("section");
    expect(defaultWhere(noteTarget, "replace", live)).toBe("section");
    expect(defaultWhere(noteTarget, "note", live)).toBe("note");
    expect(defaultWhere(noteTarget, "proposal", dead)).toBe("proposal");
  });
});
