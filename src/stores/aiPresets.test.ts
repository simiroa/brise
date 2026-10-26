import { describe, it, expect, vi, beforeEach } from "vitest";

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

import { useAiPresetsStore, visiblePresets, menuActionPresets, sidebarChatPresets, templateActionPresets, SIDEBAR_SAVE_MEMO_ID, builtinDefaults, isActionSlot } from "./aiPresets";
import { runAiAction } from "./runAiAction";
import { AI_METADATA_FIELDS, DIAGRAM_PROGRESS_PROMPT_NO_LAYOUT_V1, METADATA_PROMPT, TEXT_PROMPT_LEGACY_HTML_V1, isAgentPlanPreset, type AiActionPreset } from "./aiPrompts";
import { useAiStore } from "./ai";
import { askAiBuiltinTiles } from "../components/ai/askAiPresets";
import { useAiInstructionsStore } from "./aiInstructions";
import { t } from "../i18n/t";

function resetStore() {
  useAiPresetsStore.setState({ list: useAiPresetsStore.getState().list, loaded: false });
}

describe("aiPresets store — built-ins, edit/reset/delete/reorder persistence", () => {
  beforeEach(() => {
    callMock.mockReset();
    emitNoticeMock.mockReset();
    flushAllMock.mockClear();
    callMock.mockResolvedValue({ ok: true });
    resetStore();
    // Fresh in-memory defaults (mirrors module init, but explicit so tests don't depend on order).
    useAiPresetsStore.setState({
      list: [
        { id: "list", name: "리스트로 만들기", prompt: "P1", kind: "text", isBuiltin: true, hidden: false },
        { id: "organize", name: "내용 정리하기", prompt: "P2", kind: "text", isBuiltin: true, hidden: false },
        { id: "summarize", name: "요약하기", prompt: "P3", kind: "text", isBuiltin: true, hidden: false },
        { id: "metadata", name: "데이터 자동 채우기", prompt: "P4", kind: "metadata", isBuiltin: true, hidden: false },
      ],
      loaded: true,
    });
  });

  it("has 4 built-ins in spec order (list/organize/summarize/metadata) with the right kinds", () => {
    const ids = useAiPresetsStore.getState().list.map((p) => p.id);
    expect(ids).toEqual(["list", "organize", "summarize", "metadata"]);
    expect(useAiPresetsStore.getState().list.find((p) => p.id === "metadata")?.kind).toBe("metadata");
    expect(useAiPresetsStore.getState().list.filter((p) => p.kind === "text")).toHaveLength(3);
  });

  it("AI_METADATA_FIELDS matches what ai_organize_note actually supports (title/tags/year/region/folder)", () => {
    expect(AI_METADATA_FIELDS).toEqual(["title", "tags", "year", "region", "folder"]);
  });

  it("menuActionPresets excludes agent plan guidance; visiblePresets keeps them for Settings edit", async () => {
    callMock.mockResolvedValueOnce({ settings: {} });
    await useAiPresetsStore.getState().load();
    const list = useAiPresetsStore.getState().list;
    expect(list.some((p) => isAgentPlanPreset(p))).toBe(true);
    const menuIds = menuActionPresets(list).map((p) => p.id);
    expect(menuIds).not.toContain("agent_split");
    const settingsIds = visiblePresets(list).map((p) => p.id);
    expect(settingsIds).toContain("agent_split");
    const chatIds = sidebarChatPresets(list).map((p) => p.id);
    expect(chatIds[0]).toBe(SIDEBAR_SAVE_MEMO_ID);
    expect(chatIds).toContain("list");
    expect(chatIds).not.toContain("agent_split");
    expect(settingsIds).not.toContain(SIDEBAR_SAVE_MEMO_ID);
    expect(menuIds).not.toContain(SIDEBAR_SAVE_MEMO_ID);
    expect(list.map((p) => p.id)).not.toContain(SIDEBAR_SAVE_MEMO_ID);
  });

  it("sidebarChatPresets prepends virtual save_memo that is not a settings builtin", () => {
    const list = useAiPresetsStore.getState().list;
    const chat = sidebarChatPresets(list);
    expect(chat[0]?.id).toBe(SIDEBAR_SAVE_MEMO_ID);
    expect(chat[0]?.prompt).toBe("");
    expect(visiblePresets(list).some((p) => p.id === SIDEBAR_SAVE_MEMO_ID)).toBe(false);
    expect(menuActionPresets(list).some((p) => p.id === SIDEBAR_SAVE_MEMO_ID)).toBe(false);
  });

  it("load() falls back to built-ins: every tile in the single default order, then the action slots", async () => {
    callMock.mockResolvedValueOnce({ settings: {} });
    await useAiPresetsStore.getState().load();
    const list = useAiPresetsStore.getState().list;
    expect(list.map((p) => p.id)).toEqual(builtinDefaults().map((p) => p.id));
    expect(new Set(list.map((p) => p.id))).toEqual(new Set([...askAiBuiltinTiles().map((p) => p.id), ...list.filter(isActionSlot).map((p) => p.id)]));
    const diagram = list.find((p) => p.id === "diagram")!;
    expect(diagram.kind).toBe("diagram");
    expect(diagram.name).toBe(askAiBuiltinTiles().find((p) => p.id === "diagram")!.name);
    expect(diagram.prompt.length).toBeGreaterThan(0);

    const progress = list.find((p) => p.id === "diagram_progress")!;
    expect(progress.kind).toBe("tool");

    const sheetSum = list.find((p) => p.id === "sheet_sum")!;
    expect(sheetSum.kind).toBe("sheet");

    expect(list.find((x) => x.id === "agent_split")?.kind).toBe("text");
  });

  it("every persisted kind stays inside the Rust validate_setting allowlist ('text'|'metadata'|'diagram'|'template'|'sheet'|'tool')", async () => {
    callMock.mockResolvedValueOnce({ settings: {} });
    await useAiPresetsStore.getState().load();
    for (const p of useAiPresetsStore.getState().list) {
      expect(["text", "metadata", "diagram", "template", "sheet", "tool"]).toContain(p.kind);
    }
  });

  it("persist() writes the true kind (including 'diagram') to the wire as-is — backend validate_setting's ai_action_presets match arm (src-tauri/src/db/migrations.rs) accepts 'text'|'metadata'|'diagram', so no sanitizing is needed", async () => {
    callMock.mockResolvedValueOnce({ settings: {} }); // load() -> real defaults incl. diagram
    await useAiPresetsStore.getState().load();
    callMock.mockClear();
    callMock.mockResolvedValue({ ok: true });

    await useAiPresetsStore.getState().updateItem("list", { name: "changed" });

    const setCall = callMock.mock.calls.find((c) => c[0] === "settings_set")!;
    const wireList = (setCall[1] as { entries: { ai_action_presets: AiActionPreset[] } }).entries.ai_action_presets;
    expect(wireList.find((p) => p.id === "diagram")?.kind).toBe("diagram");
    expect(useAiPresetsStore.getState().list.find((p) => p.id === "diagram")?.kind).toBe("diagram");
  });

  it("load() falls back to built-in defaults when no kv value is stored, and self-heals a list missing a built-in", async () => {
    callMock.mockResolvedValueOnce({ settings: {} });
    await useAiPresetsStore.getState().load();
    expect(useAiPresetsStore.getState().list.map((p) => p.id)).toEqual(builtinDefaults().map((p) => p.id));

    // Simulate an older persisted list missing the (newer) "metadata" built-in — load() appends it.
    callMock.mockResolvedValueOnce({
      settings: {
        ai_action_presets: [
          { id: "list", name: "Custom name", prompt: "custom", kind: "text", isBuiltin: true, hidden: false },
        ],
      },
    });
    await useAiPresetsStore.getState().load();
    const list = useAiPresetsStore.getState().list;
    expect(list.map((p) => p.id)).toContain("metadata");
    expect(list.map((p) => p.id)).toContain("agent_split");
    expect(list.find((p) => p.id === "list")?.name).toBe("Custom name"); // stored edit preserved
  });

  it("load() self-heals a persisted metadata preset that still carries the old documentation-only prompt", async () => {
    const legacyText =
      "이 항목은 노트 본문을 분석해 제목·태그·연도·지역 메타데이터를 제안합니다(지역이 확인되면 위도·경도도 함께 조회됩니다). " +
      "실제 분석 기준은 앱에 고정되어 있어 이 텍스트를 수정해도 결과에는 반영되지 않습니다 — 이 텍스트는 참고용 설명입니다. " +
      "폴더 지정이나 월/일 단위의 정확한 날짜 추론은 현재 지원되지 않으며, 연도만 제안됩니다.";
    callMock.mockResolvedValueOnce({
      settings: {
        ai_action_presets: [
          ...["list", "summarize"].map((id) => ({ id, name: id, prompt: "x", kind: "text" as const, isBuiltin: true, hidden: false })),
          { id: "metadata", name: "데이터 자동 채우기", prompt: legacyText, kind: "metadata" as const, isBuiltin: true, hidden: false },
        ],
      },
    });
    await useAiPresetsStore.getState().load();
    const metadata = useAiPresetsStore.getState().list.find((p) => p.id === "metadata")!;
    expect(metadata.prompt).not.toBe(legacyText);
    expect(metadata.prompt).not.toContain("지원되지 않으며");
  });

  it("load() leaves a user-edited metadata prompt alone by migrating it to aiInstructionsStore", async () => {
    callMock.mockResolvedValueOnce({
      settings: {
        ai_action_presets: [
          { id: "metadata", name: "데이터 자동 채우기", prompt: "내가 직접 쓴 지침", kind: "metadata" as const, isBuiltin: true, hidden: false },
        ],
      },
    });
    await useAiPresetsStore.getState().load();
    expect(useAiInstructionsStore.getState().getInstruction("metadata")).toBe("내가 직접 쓴 지침");
  });

  it("load() migrates legacy HTML text prompts to DEFS tile prompts and retires organize", async () => {
    callMock.mockResolvedValueOnce({
      settings: {
        ai_action_presets: (["list", "organize", "summarize", "proofread"] as const).map((id) => ({
          id,
          name: t(`ai.action_default_name_${id}`),
          prompt: TEXT_PROMPT_LEGACY_HTML_V1[id],
          kind: "text" as const,
          isBuiltin: true,
          hidden: false,
        })),
      },
    });
    await useAiPresetsStore.getState().load();
    const list = useAiPresetsStore.getState().list;
    // 정리는 타일이 없어 숨김 값 자리로만 남는다(AI 기능 카탈로그의 켜고 끄기가 여기 저장된다).
    const organize = list.find((p) => p.id === "organize")!;
    expect(isActionSlot(organize)).toBe(true);
    expect(organize.prompt).toBe("");
    expect(visiblePresets(list).some((p) => p.id === "organize")).toBe(false);
    for (const id of ["list", "summarize", "proofread"] as const) {
      const tile = askAiBuiltinTiles().find((d) => d.id === id)!;
      expect(list.find((p) => p.id === id)!.prompt).toBe(tile.prompt);
    }
  });

  it("load() migrates customized legacy text prompts to a new custom preset", async () => {
    const mine = `${TEXT_PROMPT_LEGACY_HTML_V1.list}\n\n추가 지침: 항상 존댓말로.`;
    callMock.mockResolvedValueOnce({
      settings: {
        ai_action_presets: [{ id: "list", name: "목록", prompt: mine, kind: "text" as const, isBuiltin: true, hidden: false }],
      },
    });
    await useAiPresetsStore.getState().load();
    const custom = useAiPresetsStore.getState().list.find((p) => !p.isBuiltin && p.prompt === mine);
    expect(custom).toBeTruthy();
    expect(custom?.name).toContain("목록");
  });

  it("load() migrates diagram_progress to tool preset", async () => {
    callMock.mockResolvedValueOnce({
      settings: {
        ai_action_presets: [
          { id: "diagram_progress", name: "진행", prompt: DIAGRAM_PROGRESS_PROMPT_NO_LAYOUT_V1, kind: "diagram" as const, isBuiltin: true, hidden: false },
        ],
      },
    });
    await useAiPresetsStore.getState().load();
    const list = useAiPresetsStore.getState().list;
    expect(list.find((p) => p.id === "diagram_progress")?.kind).toBe("tool");
  });

  // 일회 이관(2026-09-28 검토에서 고침) — 예전엔 이관 결과를 저장하지 않아 매 로드마다 다시 돌았고, 파서가
  // 지침 저장소를 직접 써서 설정 화면에서 고친 지침을 옛 값으로 덮었으며, 코드가 나중에 고친 옛 기본값을
  // "사용자 수정"으로 오판해 재정의로 박았다(오너 DB 실측: 관계도·메타데이터·시트·시트 수정 넷 다 옛 기본값).
  describe("old-format list → one-time migration", () => {
    const presetWrites = () =>
      callMock.mock.calls.filter((c) => c[0] === "settings_set" && (c[1] as { entries: Record<string, unknown> }).entries.ai_action_presets);
    const instructionWrites = () =>
      callMock.mock.calls.filter((c) => c[0] === "settings_set" && (c[1] as { entries: Record<string, unknown> }).entries.ai_internal_instructions);
    const oldItem = (id: string, prompt: string, kind: AiActionPreset["kind"] = "text") => ({ id, name: id, prompt, kind, isBuiltin: true, hidden: false });
    beforeEach(() => {
      useAiInstructionsStore.setState({ instructions: {}, loaded: true });
    });

    it("persists the migrated list once, so the next load migrates nothing", async () => {
      callMock.mockResolvedValueOnce({ settings: { ai_action_presets: [oldItem("ask_note", "옛 챗 지침"), oldItem("summarize", "x")] } });
      await useAiPresetsStore.getState().load();
      expect(presetWrites()).toHaveLength(1);
      const saved = (presetWrites()[0][1] as { entries: { ai_action_presets: AiActionPreset[] } }).entries.ai_action_presets;
      // 타일이 없는 엔진 전용 id 는 문장 없는 숨김 값 자리로만 남는다
      expect(saved.find((p) => p.id === "ask_note")?.prompt).toBe("");

      callMock.mockClear();
      callMock.mockResolvedValueOnce({ settings: { ai_action_presets: saved } });
      await useAiPresetsStore.getState().load();
      expect(presetWrites()).toHaveLength(0);
      expect(instructionWrites()).toHaveLength(0);
    });

    it("old code defaults are not user edits — a renamed-term metadata and an old diagram rule set stay on code defaults", async () => {
      const oldTermMetadata = METADATA_PROMPT.split("노트북").join("워크스페이스");
      callMock.mockResolvedValueOnce({
        settings: { ai_action_presets: [oldItem("metadata", oldTermMetadata, "metadata"), oldItem("diagram", "옛 관계도 JSON 규칙", "diagram")] },
      });
      await useAiPresetsStore.getState().load();
      expect(useAiInstructionsStore.getState().instructions).toEqual({});
    });

    it("keeps a real metadata edit as an override", async () => {
      callMock.mockResolvedValueOnce({ settings: { ai_action_presets: [oldItem("metadata", "태그는 한글 세 단어 이내로", "metadata")] } });
      await useAiPresetsStore.getState().load();
      expect(useAiInstructionsStore.getState().instructions).toEqual({ metadata: "태그는 한글 세 단어 이내로" });
    });

    it("clears an override the earlier pass copied from the old list, but keeps one edited in settings", async () => {
      useAiInstructionsStore.setState({ instructions: { diagram: "옛 관계도 JSON 규칙", metadata: "설정에서 고친 기준" }, loaded: true });
      callMock.mockResolvedValueOnce({
        settings: { ai_action_presets: [oldItem("diagram", "옛 관계도 JSON 규칙", "diagram"), oldItem("metadata", "옛 목록의 메타데이터", "metadata")] },
      });
      await useAiPresetsStore.getState().load();
      expect(useAiInstructionsStore.getState().instructions).toEqual({ metadata: "설정에서 고친 기준" });
    });

    it("a failed instructions write leaves the old list unsaved, so the next load retries", async () => {
      callMock.mockImplementation(async (cmd: string, args?: { entries?: Record<string, unknown> }) => {
        if (cmd === "settings_get_all") return { settings: { ai_action_presets: [oldItem("metadata", "태그는 한글로", "metadata")] } };
        if (cmd === "settings_set" && args?.entries?.ai_internal_instructions) throw new Error("disk full");
        return { ok: true };
      });
      await useAiPresetsStore.getState().load();
      expect(presetWrites()).toHaveLength(0);
    });
  });

  // 입력창 없이 바로 실행하는 표면(모바일 AI 시트·사이드바 챗) — 2026-09-28 검토: 목록이 타일 문장이 된 뒤 챗 전용
  // 빌트인이 사라지고({{text}} 가 그대로 가는 타일이 떴고), 관계도·시트는 규칙 없이 돌았다.
  it("direct-run surfaces keep the runnable actions: chat built-ins, engine rules with the user's override, hiding via the list", () => {
    useAiInstructionsStore.setState({ instructions: { diagram: "MY DIAGRAM RULES" }, loaded: true });
    const list = builtinDefaults().map((p) => (p.id === "organize" ? { ...p, hidden: true } : p));
    const chat = sidebarChatPresets(list);
    expect(chat.map((p) => p.id)).toEqual(expect.arrayContaining(["ask_note", "find_related", "fill_note"]));
    const menu = menuActionPresets(list);
    expect(menu.find((p) => p.id === "diagram")?.prompt).toBe("MY DIAGRAM RULES");
    expect(menu.some((p) => p.id === "organize")).toBe(false); // 숨김 자리로 껐다
    expect(menu.some((p) => p.kind === "tool")).toBe(false);
    expect(menu.filter((p) => p.isBuiltin).some((p) => p.prompt.includes("{{"))).toBe(false); // 칸이 있는 타일 문장은 없다
    useAiInstructionsStore.setState({ instructions: {}, loaded: true });
  });

  // 2026-09-28: 편집기의 "+" 가 목록을 읽기 전(기본값 상태)에 눌려 사용자 프리셋 4개가 지워졌다 — 쓰기는 읽은 뒤에만.
  describe("writes never land on an unread list", () => {
    const mine = { id: "mine", name: "내 것", prompt: "내 문장", kind: "text" as const, isBuiltin: false, hidden: false, order: 0 };
    const presetWrites = () =>
      callMock.mock.calls.filter((c) => c[0] === "settings_set" && (c[1] as { entries: Record<string, unknown> }).entries.ai_action_presets);

    it("a write before the list is read loads it first, so the user's presets survive", async () => {
      useAiPresetsStore.setState({ list: builtinDefaults(), loaded: false, loadFailed: false });
      callMock.mockImplementation(async (cmd: string) => (cmd === "settings_get_all" ? { settings: { ai_action_presets: [mine] } } : { ok: true }));
      await useAiPresetsStore.getState().addCustom("새 것", "새 문장");
      const saved = (presetWrites()[presetWrites().length - 1][1] as { entries: { ai_action_presets: AiActionPreset[] } }).entries.ai_action_presets;
      expect(saved.some((p) => p.id === "mine")).toBe(true);
      expect(saved.some((p) => p.name === "새 것")).toBe(true);
    });

    it("a failed read blocks writes (defaults are shown, never saved)", async () => {
      useAiPresetsStore.setState({ list: builtinDefaults(), loaded: false, loadFailed: false });
      callMock.mockImplementation(async (cmd: string) => {
        if (cmd === "settings_get_all") throw new Error("db locked");
        return { ok: true };
      });
      await useAiPresetsStore.getState().load();
      expect(useAiPresetsStore.getState().loadFailed).toBe(true);
      await useAiPresetsStore.getState().addCustom("새 것", "새 문장");
      await useAiPresetsStore.getState().reorder(builtinDefaults()[1].id, "up");
      expect(presetWrites()).toHaveLength(0);
      expect(emitNoticeMock).toHaveBeenCalled();
    });
  });

  it("load() drops malformed entries", async () => {
    callMock.mockResolvedValueOnce({
      settings: { ai_action_presets: [{ id: "x" }, "not an object", { id: "list", name: "n", prompt: "p", kind: "text", isBuiltin: true, hidden: false }] },
    });
    await useAiPresetsStore.getState().load();
    const ids = useAiPresetsStore.getState().list.map((p) => p.id);
    expect(ids).toContain("list");
    expect(ids).not.toContain("x");
  });

  it("addCustom appends a text-kind item and persists under the literal ai_action_presets key", async () => {
    await useAiPresetsStore.getState().addCustom("내 작업", "내 프롬프트");
    const list = useAiPresetsStore.getState().list;
    expect(list).toHaveLength(5);
    expect(list[4]).toMatchObject({ name: "내 작업", prompt: "내 프롬프트", kind: "text", isBuiltin: false, hidden: false });
    expect(callMock).toHaveBeenCalledWith("settings_set", { entries: { ai_action_presets: expect.any(Array) } });
  });

  // 2026-08-08 프리셋 통합(Q5): kind 하드코딩 해제 — 커스텀도 diagram/template 로 만들 수 있다.
  it("addCustom persists the requested kind (diagram/template), not a hardcoded 'text'", async () => {
    await useAiPresetsStore.getState().addCustom("내 관계도", "P", "diagram");
    await useAiPresetsStore.getState().addCustom("내 템플릿", "## 제목", "template");
    const list = useAiPresetsStore.getState().list;
    expect(list[4]).toMatchObject({ name: "내 관계도", kind: "diagram", isBuiltin: false });
    expect(list[5]).toMatchObject({ name: "내 템플릿", prompt: "## 제목", kind: "template", isBuiltin: false });

    const setCalls = callMock.mock.calls.filter((c) => c[0] === "settings_set");
    const wire = setCalls[setCalls.length - 1][1] as { entries: { ai_action_presets: AiActionPreset[] } };
    expect(wire.entries.ai_action_presets.map((p) => p.kind)).toContain("template");
  });

  it("template kind never reaches the AI action menu, and runAiAction refuses it (scaffold, not a model call)", async () => {
    await useAiPresetsStore.getState().addCustom("내 템플릿", "## 제목", "template");
    const list = useAiPresetsStore.getState().list;
    const tpl = list.find((p) => p.kind === "template")!;

    expect(menuActionPresets(list).map((p) => p.id)).not.toContain(tpl.id);
    // 설정 화면(visiblePresets)에서는 여전히 보인다 — 거기서 편집·삭제해야 하므로.
    expect(visiblePresets(list).map((p) => p.id)).toContain(tpl.id);
    expect(templateActionPresets(list).map((p) => p.id)).toEqual([tpl.id]);

    const generateSpy = vi.spyOn(useAiStore.getState(), "generateFromPrompt");
    emitNoticeMock.mockClear();
    expect(await runAiAction(tpl)).toBe(false);
    expect(generateSpy).not.toHaveBeenCalled();
    expect(emitNoticeMock).toHaveBeenCalledWith(t("ai.template_not_runnable"));
    generateSpy.mockRestore();
  });

  it("addCustom no-ops on blank name/prompt", async () => {
    await useAiPresetsStore.getState().addCustom("  ", "x");
    await useAiPresetsStore.getState().addCustom("x", "  ");
    expect(useAiPresetsStore.getState().list).toHaveLength(4);
    expect(callMock).not.toHaveBeenCalled();
  });

  it("updateItem edits name+prompt in place for a built-in", async () => {
    await useAiPresetsStore.getState().updateItem("summarize", { name: "짧게 요약", prompt: "new prompt" });
    const item = useAiPresetsStore.getState().list.find((p) => p.id === "summarize")!;
    expect(item.name).toBe("짧게 요약");
    expect(item.prompt).toBe("new prompt");
    expect(item.isBuiltin).toBe(true); // editing a built-in doesn't turn it into a custom
  });

  it("resetItem restores a built-in's default name+prompt after it was edited; no-ops for a custom id", async () => {
    await useAiPresetsStore.getState().updateItem("summarize", { name: "changed", prompt: "changed" });
    await useAiPresetsStore.getState().resetItem("summarize");
    const item = useAiPresetsStore.getState().list.find((p) => p.id === "summarize")!;
    expect(item.name).not.toBe("changed");
    expect(item.prompt).not.toBe("changed");

    await useAiPresetsStore.getState().addCustom("Custom", "prompt");
    const customId = useAiPresetsStore.getState().list.find((p) => p.name === "Custom")!.id;
    const before = useAiPresetsStore.getState().list;
    await useAiPresetsStore.getState().resetItem(customId);
    expect(useAiPresetsStore.getState().list).toEqual(before); // no default to reset to -> no-op
  });

  it("deleteItem hides a built-in (stays in the array) but removes a custom outright", async () => {
    await useAiPresetsStore.getState().deleteItem("metadata");
    let list = useAiPresetsStore.getState().list;
    expect(list.find((p) => p.id === "metadata")?.hidden).toBe(true);
    expect(list).toHaveLength(4); // still present, just hidden
    expect(visiblePresets(list).map((p) => p.id)).not.toContain("metadata");

    await useAiPresetsStore.getState().addCustom("Custom", "p");
    const customId = useAiPresetsStore.getState().list.find((p) => p.name === "Custom")!.id;
    await useAiPresetsStore.getState().deleteItem(customId);
    list = useAiPresetsStore.getState().list;
    expect(list.find((p) => p.id === customId)).toBeUndefined();
  });

  it("restoreHiddenBuiltins un-hides every hidden built-in and nothing else", async () => {
    await useAiPresetsStore.getState().deleteItem("summarize");
    await useAiPresetsStore.getState().deleteItem("metadata");
    await useAiPresetsStore.getState().restoreHiddenBuiltins();
    const list = useAiPresetsStore.getState().list;
    expect(list.every((p) => !p.hidden)).toBe(true);
  });

  it("reorder swaps with the adjacent VISIBLE item and no-ops at the edges", async () => {
    await useAiPresetsStore.getState().reorder("organize", "up");
    expect(useAiPresetsStore.getState().list.map((p) => p.id)).toEqual(["organize", "list", "summarize", "metadata"]);

    // top item can't move further up -> no-op, no persist call
    callMock.mockClear();
    await useAiPresetsStore.getState().reorder("organize", "up");
    expect(useAiPresetsStore.getState().list.map((p) => p.id)).toEqual(["organize", "list", "summarize", "metadata"]);
    expect(callMock).not.toHaveBeenCalled();

    // hiding "list" makes "organize"'s next VISIBLE neighbor "summarize" — swap skips the hidden one
    await useAiPresetsStore.getState().deleteItem("list");
    await useAiPresetsStore.getState().reorder("organize", "down");
    const ids = useAiPresetsStore.getState().list.map((p) => p.id);
    expect(ids.indexOf("organize")).toBeGreaterThan(ids.indexOf("summarize"));
  });

  it("a failed persist rolls the in-memory list back and notices", async () => {
    callMock.mockRejectedValueOnce(new Error("boom"));
    const before = useAiPresetsStore.getState().list;
    await useAiPresetsStore.getState().addCustom("X", "Y");
    expect(useAiPresetsStore.getState().list).toEqual(before);
    expect(emitNoticeMock).toHaveBeenCalled();
  });
});
