import { describe, it, expect, vi, beforeEach } from "vitest";

const callMock = vi.fn();
const emitNoticeMock = vi.fn();

vi.mock("../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  emitNotice: (...args: unknown[]) => emitNoticeMock(...args),
}));

import {
  usePresetsStore,
  BUILTIN_PRESETS,
  TODO_PRESET_BODY_MD,
  DAILY_PRESET_BODY_MD,
  TRAVEL_PRESET_BODY_MD,
  RETRO_PRESET_BODY_MD,
} from "./presets";

describe("presets store — custom preset save/rename/delete (empty-state preset system)", () => {
  beforeEach(() => {
    callMock.mockReset();
    emitNoticeMock.mockReset();
    callMock.mockResolvedValue({ ok: true });
    usePresetsStore.setState({
      customPresets: [],
      hiddenBuiltinIds: [],
      loaded: false,
      hovered: null,
      targetState: "ready",
    });
  });

  it("built-ins: blank has no content, todo carries the checklist HTML skeleton, ai has none (topic flow instead)", () => {
    expect(BUILTIN_PRESETS.find((p) => p.id === "blank")?.bodyMd).toBe("");
    expect(BUILTIN_PRESETS.find((p) => p.id === "todo")?.bodyMd).toBe(TODO_PRESET_BODY_MD);
    expect(TODO_PRESET_BODY_MD).toContain('data-type="taskItem"');
    expect(BUILTIN_PRESETS.find((p) => p.id === "ai")?.bodyMd).toBeUndefined();
  });

  it("W8-f: diagram has no bodyMd (seeds a section via applyDiagramPreset, not section-0 text); the three new prose built-ins carry finished skeletons", () => {
    expect(BUILTIN_PRESETS.find((p) => p.id === "diagram")?.bodyMd).toBeUndefined();
    expect(BUILTIN_PRESETS.find((p) => p.id === "daily")?.bodyMd).toBe(DAILY_PRESET_BODY_MD);
    expect(BUILTIN_PRESETS.find((p) => p.id === "travel")?.bodyMd).toBe(TRAVEL_PRESET_BODY_MD);
    expect(BUILTIN_PRESETS.find((p) => p.id === "retro")?.bodyMd).toBe(RETRO_PRESET_BODY_MD);
    // Travel's 준비물 section is a real checklist, same passthrough-HTML shape TODO_PRESET_BODY_MD uses.
    expect(TRAVEL_PRESET_BODY_MD).toContain('data-type="taskItem"');
    // Every new preset has actual guiding headings, not an empty string like "blank".
    for (const body of [DAILY_PRESET_BODY_MD, TRAVEL_PRESET_BODY_MD, RETRO_PRESET_BODY_MD]) {
      expect(body).toContain("## ");
    }
  });

  it("saveFromNote rejects a blank or default literal title 'Untitled Note' regardless of locale without touching the backend", async () => {
    const okBlank = await usePresetsStore.getState().saveFromNote("   ", "body");
    const okDefault = await usePresetsStore.getState().saveFromNote("Untitled Note", "body");
    expect(okBlank).toBe(false);
    expect(okDefault).toBe(false);
    expect(callMock).not.toHaveBeenCalled();
    expect(usePresetsStore.getState().customPresets).toHaveLength(0);
  });

  it("saveFromNote persists a new custom preset and re-saving the same title overwrites in place", async () => {
    const ok1 = await usePresetsStore.getState().saveFromNote("Trip log", "- pack bags");
    expect(ok1).toBe(true);
    expect(usePresetsStore.getState().customPresets).toHaveLength(1);
    expect(usePresetsStore.getState().customPresets[0]).toMatchObject({ name: "Trip log", bodyMd: "- pack bags" });
    // settings_set called with the full list under the note_presets key (kv persistence, no migration).
    expect(callMock).toHaveBeenCalledWith(
      "settings_set",
      expect.objectContaining({ entries: expect.objectContaining({ note_presets: expect.any(Array) }) })
    );
    const firstId = usePresetsStore.getState().customPresets[0].id;

    const ok2 = await usePresetsStore.getState().saveFromNote("Trip log", "- pack bags\n- book flight");
    expect(ok2).toBe(true);
    const list = usePresetsStore.getState().customPresets;
    expect(list).toHaveLength(1); // same name -> overwrite, not a second entry
    expect(list[0].id).toBe(firstId); // same identity, just updated content
    expect(list[0].bodyMd).toBe("- pack bags\n- book flight");
  });

  it("create-preset-from-tab (TabBar's handleSaveAsPreset shape) appears in the store synchronously, before persist() resolves — every consumer (PresetList, TreeHeaderActions' modal, MobileCapturePresets) reads this same customPresets field, so no separate refresh/subscription wiring is needed", async () => {
    // Model TabBar.tsx: settings_set is in flight (unresolved) while the optimistic update lands.
    let resolveCall!: (v: unknown) => void;
    callMock.mockReturnValueOnce(new Promise((r) => (resolveCall = r)));

    const savePromise = usePresetsStore.getState().saveFromNote("Trip log", "- pack bags");
    // Not awaited yet — a consumer subscribed to the store must already see the new preset.
    expect(usePresetsStore.getState().customPresets).toEqual([
      expect.objectContaining({ name: "Trip log", bodyMd: "- pack bags" }),
    ]);

    resolveCall({ ok: true });
    expect(await savePromise).toBe(true);
    // Still there after the backend round-trip settles.
    expect(usePresetsStore.getState().customPresets).toHaveLength(1);
  });

  it("rename updates the name in place; remove drops it", async () => {
    await usePresetsStore.getState().saveFromNote("Draft", "hello");
    const id = usePresetsStore.getState().customPresets[0].id;

    await usePresetsStore.getState().rename(id, "Journal entry");
    expect(usePresetsStore.getState().customPresets[0].name).toBe("Journal entry");

    await usePresetsStore.getState().remove(id);
    expect(usePresetsStore.getState().customPresets).toHaveLength(0);
  });

  // 칩 스트립(PresetList variant="panel")의 아이콘/색 지정 — 새 저장소 없이 note_presets 항목에
  // 선택 필드 둘을 얹는다(설정 kv JSON 그대로, Rust validate_setting 은 id/name/bodyMd 만 본다).
  it("setStyle stores icon/color on the same note_presets array, and null clears them back to the default look", async () => {
    await usePresetsStore.getState().saveFromNote("Draft", "hello");
    const id = usePresetsStore.getState().customPresets[0].id;

    await usePresetsStore.getState().setStyle(id, { icon: "book", color: "info" });
    expect(usePresetsStore.getState().customPresets[0]).toMatchObject({ icon: "book", color: "info" });
    const lastCall = callMock.mock.calls[callMock.mock.calls.length - 1];
    const persisted = lastCall[1].entries.note_presets[0];
    expect(persisted).toMatchObject({ id, icon: "book", color: "info" });

    // 하나만 건드리면 나머지는 그대로.
    await usePresetsStore.getState().setStyle(id, { color: null });
    expect(usePresetsStore.getState().customPresets[0].icon).toBe("book");
    expect(usePresetsStore.getState().customPresets[0].color).toBeUndefined();

    await usePresetsStore.getState().setStyle(id, { icon: null });
    expect(usePresetsStore.getState().customPresets[0].icon).toBeUndefined();
  });

  it("load() parses the persisted array and ignores malformed entries", async () => {
    callMock.mockResolvedValueOnce({
      settings: {
        note_presets: [
          { id: "a", name: "Good", bodyMd: "x" },
          { id: "b", name: "Missing body" }, // dropped: no bodyMd
          "not an object", // dropped
          // icon/color 는 선택 필드 — 모르는 색 이름은 통째로 떨어져 기본 모습으로 그려진다.
          { id: "c", name: "Styled", bodyMd: "y", icon: "book", color: "info" },
          { id: "d", name: "Bad color", bodyMd: "z", color: "hotpink", icon: 7 },
        ],
      },
    });
    await usePresetsStore.getState().load();
    expect(usePresetsStore.getState().loaded).toBe(true);
    expect(usePresetsStore.getState().customPresets).toEqual([
      { id: "a", name: "Good", bodyMd: "x" },
      { id: "c", name: "Styled", bodyMd: "y", icon: "book", color: "info" },
      { id: "d", name: "Bad color", bodyMd: "z" },
    ]);
  });

  it("load() parses hidden builtin ids and drops unknown/malformed entries", async () => {
    callMock.mockResolvedValueOnce({
      settings: {
        note_presets_hidden_builtins: ["blank", "diagram", "not_a_builtin", 42, ""],
      },
    });
    await usePresetsStore.getState().load();
    expect(usePresetsStore.getState().hiddenBuiltinIds).toEqual(["blank", "diagram"]);
  });

  it("hideBuiltin: 제거 hides a builtin (persisted, not deleted — no content to lose) and restoreHiddenBuiltins un-hides everything", async () => {
    await usePresetsStore.getState().hideBuiltin("blank");
    expect(usePresetsStore.getState().hiddenBuiltinIds).toEqual(["blank"]);
    expect(callMock).toHaveBeenCalledWith(
      "settings_set",
      expect.objectContaining({ entries: { note_presets_hidden_builtins: ["blank"] } })
    );

    await usePresetsStore.getState().hideBuiltin("diagram");
    expect(usePresetsStore.getState().hiddenBuiltinIds).toEqual(["blank", "diagram"]);

    // Hiding the same id twice is a no-op (no duplicate persist call with a repeated id).
    callMock.mockClear();
    await usePresetsStore.getState().hideBuiltin("blank");
    expect(usePresetsStore.getState().hiddenBuiltinIds).toEqual(["blank", "diagram"]);
    expect(callMock).not.toHaveBeenCalled();

    await usePresetsStore.getState().restoreHiddenBuiltins();
    expect(usePresetsStore.getState().hiddenBuiltinIds).toEqual([]);
    expect(callMock).toHaveBeenCalledWith(
      "settings_set",
      expect.objectContaining({ entries: { note_presets_hidden_builtins: [] } })
    );
  });

  it("hideBuiltin rolls back on a failed persist", async () => {
    callMock.mockRejectedValueOnce(new Error("nope"));
    await usePresetsStore.getState().hideBuiltin("todo");
    expect(usePresetsStore.getState().hiddenBuiltinIds).toEqual([]);
    expect(emitNoticeMock).toHaveBeenCalled();
  });

  // hovered/targetState are the ghost's whole wiring — one global slot several PresetList
  // instances write to, read by EditorPanel.
  it("clearHovered only clears its own id — a second list's stale cleanup must not wipe a live hover", () => {
    const s = usePresetsStore.getState();
    s.setHovered("todo", "body");
    s.clearHovered("blank");
    expect(usePresetsStore.getState().hovered).toEqual({ id: "todo", bodyMd: "body" });
    s.clearHovered("todo");
    expect(usePresetsStore.getState().hovered).toBeNull();
  });

  it("setTargetState transitions and holds — EditorPanel republishes it on every ProseMirror transaction, so repeats must be inert", () => {
    const s = usePresetsStore.getState();
    s.setTargetState("ready");
    expect(usePresetsStore.getState().targetState).toBe("ready");
    s.setTargetState("has_content");
    s.setTargetState("has_content");
    expect(usePresetsStore.getState().targetState).toBe("has_content");
  });
});
