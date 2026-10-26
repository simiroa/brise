import { create } from "zustand";
import { call, emitNotice } from "../lib/invoke";
import { uniqueId } from "../lib/ids";
import { t } from "../i18n/t";

/**
 * Empty-state preset system (빈 노트 프리셋). Two layers:
 *   - Built-in presets (blank / todo / diagram / daily / travel / retro / ai) — fixed ids, static
 *     content, never persisted.
 *   - Custom presets — saved from an existing note's title+body via TabBar's "Save as preset"
 *     tab-context-menu item, kept in the simplest storage that already exists: the settings kv
 *     table (call("settings_set")/settings_get_all — same mechanism openTabs/inbox ids use, see
 *     stores/settings.ts) as one JSON array under a single key. No DB migration — a handful of
 *     note-shaped presets doesn't earn a new table.
 *
 * W8-f (고품질 프리셋 확충): "diagram" is not a prose body like the others — applying it seeds a
 * whole kind:'diagram' SECTION, not markdown text for section 0. It therefore has no bodyMd here
 * (see BuiltinPreset.bodyMd's comment) and is applied through lib/presetBridge.ts's
 * applyDiagramPreset(), a separate small entry point next to the generic applyPreset() bridge —
 * see that file for why a second entry point was the honest minimal extension rather than folding
 * kind into PresetApplyRequest (that would force EditorPanel's registered callback, which only
 * knows how to load prose into the live Tiptap instance, to also grow diagram-section-creation
 * logic it doesn't otherwise need).
 */

export const BUILTIN_PRESET_IDS = [
  "blank",
  "todo",
  "diagram",
  "diagram_mindmap",
  "diagram_sequence",
  "sheet",
  "budget",
  "sheet_schedule",
  "sheet_tracker",
  "daily",
  "travel",
  "retro",
  "ai",
] as const;
export type BuiltinPresetId = (typeof BUILTIN_PRESET_IDS)[number];

// TaskList/TaskItem parseHTML rules match on `ul[data-type="taskList"]` / `li[data-type=
// "taskItem"]` (@tiptap/extension-list) — literal HTML through editor.commands.setContent(string)
// lands as real, checkable nodes, exactly like table/mark passthrough already relies on
// elsewhere (see mdSerialize.ts's "passthrough HTML" block comment). Building it via chained
// editor commands instead would need the live editor instance up front; a static string is the
// one shape both the todo builtin (no editor yet) and updateSectionBody's draft path (plain
// body_md string) can share unmodified.
const TASK_ITEM_HTML = '<li data-type="taskItem" data-checked="false"><label><input type="checkbox"></label><div><p></p></div></li>';
export const TODO_PRESET_BODY_MD = `<ul data-type="taskList">${TASK_ITEM_HTML.repeat(3)}</ul>`;

// W8-f built-ins below: each is a finished skeleton (headings + a blank line to type into, real
// checklists where the use case is actually actionable) for a recurring life-record use, not a
// bare list of headings — see the PresetList row comment for the case each one earns its slot
// with. Same markdown+passthrough-HTML shape TODO_PRESET_BODY_MD already relies on (raw HTML task
// list blocks survive @tiptap/markdown's parse untouched, same citation as above).
export const DAILY_PRESET_BODY_MD =
  "## 오늘 있었던 일\n\n\n" +
  "## 오늘 감사했던 것\n\n\n" +
  "## 내일 할 일\n\n" +
  `<ul data-type="taskList">${TASK_ITEM_HTML.repeat(2)}</ul>\n`;

export const TRAVEL_PRESET_BODY_MD =
  "## 언제 · 어디로\n\n\n" +
  "## 일정\n\n\n" +
  "## 준비물\n\n" +
  `<ul data-type="taskList">${TASK_ITEM_HTML.repeat(3)}</ul>\n\n` +
  "## 다녀와서 기억할 것\n\n";

export const RETRO_PRESET_BODY_MD =
  "## 이 시기를 한 문장으로 요약하면\n\n\n" +
  "## 잘한 것\n\n\n" +
  "## 아쉬웠던 것\n\n\n" +
  "## 다음엔 이렇게\n\n";

import {
  createBudgetSheetJson,
  createEmptySheetJson,
  createScheduleSheetJson,
  createTrackerSheetJson,
} from "../components/sheet/sheetStarter";

export interface BuiltinPreset {
  id: BuiltinPresetId;
  /** undefined for "ai" (topic->generateFromPrompt flow) and "diagram" (seeds a separate
   *  kind:'diagram' section via presetBridge's applyDiagramPreset) — neither has static prose to
   *  preview here. Sheet presets provide their initial JSON grid structure. */
  bodyMd?: string;
}

export const BUILTIN_PRESETS: BuiltinPreset[] = [
  { id: "blank", bodyMd: "" },
  { id: "todo", bodyMd: TODO_PRESET_BODY_MD },
  { id: "diagram" },
  { id: "diagram_mindmap" },
  { id: "diagram_sequence" },
  { id: "sheet", bodyMd: createEmptySheetJson() },
  { id: "budget", bodyMd: createBudgetSheetJson() },
  { id: "sheet_schedule", bodyMd: createScheduleSheetJson() },
  { id: "sheet_tracker", bodyMd: createTrackerSheetJson() },
  { id: "daily", bodyMd: DAILY_PRESET_BODY_MD },
  { id: "travel", bodyMd: TRAVEL_PRESET_BODY_MD },
  { id: "retro", bodyMd: RETRO_PRESET_BODY_MD },
  { id: "ai" },
];


export interface CustomPreset {
  id: string;
  name: string;
  bodyMd: string;
  /** lib/noteIcons.ts 의 팔레트 키 (노트 아이콘과 같은 저장 규약: 미지정 = 기본 IconNote). */
  icon?: string;
  /** PRESET_COLORS 의 토큰 이름 (미지정 = --muted). 새 색을 tokens.css 에 추가하지 않는다 —
   *  lib/status.ts 가 같은 이유로 기존 상태 토큰만 재사용한다. */
  color?: PresetColor;
}

/** 프리셋 칩 색 — 전부 tokens.css 에 이미 있는 토큰 이름이다(대비 검증 완료, status.ts 참고). */
export const PRESET_COLORS = ["accent", "ok", "info", "danger-soft", "danger"] as const;
export type PresetColor = (typeof PRESET_COLORS)[number];

/** 저장된 색 이름 → CSS var(). 미지정/미지의 값은 기존과 같은 muted 로 폴백한다(하위호환). */
export function presetColorVar(color: string | null | undefined): string {
  return (PRESET_COLORS as readonly string[]).includes(color ?? "") ? `var(--${color})` : "var(--muted)";
}

const SETTINGS_KEY = "note_presets";
// "제거"한 빌트인 프리셋 id 목록 — stores/aiPresets.ts의 hidden:true 패턴과 같은 동작(제거는
// 숨김, 위치/내용은 그대로) 이지만 빌트인은 정적 프런트 상수(BUILTIN_PRESETS)라 name/prompt를
// 담아 되돌릴 게 없으므로, note_presets(커스텀 전용) 배열에 필드를 얹는 대신 별도 키에 "숨긴
// id 집합"만 둔다 — src-tauri/src/repo/settings_schema.rs의 validate_setting arm 참고.
const HIDDEN_BUILTINS_KEY = "note_presets_hidden_builtins";

function parseCustomPresets(raw: unknown): CustomPreset[] {
  if (!Array.isArray(raw)) return [];
  const out: CustomPreset[] = [];
  for (const item of raw) {
    if (
      item &&
      typeof item === "object" &&
      typeof (item as any).id === "string" &&
      typeof (item as any).name === "string" &&
      typeof (item as any).bodyMd === "string"
    ) {
      // icon/color 는 선택 필드다 — 없거나 모르는 값이면 통째로 떨어뜨려 예전 프리셋과 똑같이
      // (IconNote + muted) 그려진다. 검증은 여기 한 곳에서만 한다(저장 경계).
      const icon = (item as any).icon;
      const color = (item as any).color;
      out.push({
        id: (item as any).id,
        name: (item as any).name,
        bodyMd: (item as any).bodyMd,
        ...(typeof icon === "string" && icon ? { icon } : {}),
        ...((PRESET_COLORS as readonly string[]).includes(color) ? { color: color as PresetColor } : {}),
      });
    }
  }
  return out;
}

function parseHiddenBuiltinIds(raw: unknown): BuiltinPresetId[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is BuiltinPresetId =>
    (BUILTIN_PRESET_IDS as readonly string[]).includes(v as string),
  );
}

/**
 * PRESET TARGET STATE — 프리셋이 **어떻게 적용되는지**와 호버 고스트를 **그릴 수 있는지**가
 * 공유하는 유일한 판정 기준. 프리셋 클릭은 어떤 상태에서도 막지 않는다(오너 피드백): 막는 대신
 * 착지점이 달라지고, 리스트는 그 착지점을 한 줄로 미리 밝힌다.
 *
 * EditorPanel 이 **라이브 Tiptap 인스턴스에서 직접** publish 한다(notes 스토어의 activeBodyEmpty가
 * 아니라): 그 플래그는 700ms 자동저장 디바운스 뒤에야 갱신되고(방금 친 글자/방금 지운 본문이
 * 반영 안 됨) 다중 섹션에서는 스토어 sections 가 stale해 부정확하다 — notesActive.ts 의
 * updateSectionBody ponytail 주석 참고.
 *   ready       — 지금 편집 중인 노트가 비어 있다. sections[0] 에 제자리 적용하고, 겹칠 본문이
 *                 없으므로 호버 고스트도 그린다.
 *   has_content — 본문이 있다. 새 섹션으로 추가된다(notesActive::applyPreset). 고스트는 실제
 *                 본문 위에 겹치므로 그리지 않는다.
 *   diagram     — 활성 섹션이 관계도다. 역시 새 섹션으로 추가된다(산문이 mermaid 소스 칸이나 다른
 *                 탭에 조용히 써지는 일이 없다). 고스트를 그릴 EditorContent 자체가 없다.
 */
export type PresetTargetState = "ready" | "has_content" | "diagram" | "sheet";
/** DiagramAssist 의 배치 행이 `setHovered(prefix + name, 재직렬화 본문)` 으로 알린다 — 고스트(EditorGhostOverlay)가
 *  이 접두로 배치 행을 가린다. 여기 두는 이유: 에디터 쪽 파일에 두면 보조 패널이 상수 하나 때문에 에디터 스택을 정적으로 끌고 온다. */
export const LAYOUT_HOVER_PREFIX = "layout:";

export type EditorKind = "text" | "sheet" | "diagram";

interface PresetsState {
  customPresets: CustomPreset[];
  /** Builtin preset ids the user "removed" — hidden, not deleted (no content to lose, see
   *  HIDDEN_BUILTINS_KEY's comment). */
  hiddenBuiltinIds: BuiltinPresetId[];
  loaded: boolean;
  targetState: PresetTargetState;
  setTargetState: (s: PresetTargetState) => void;
  activeEditorKind: EditorKind;
  isEditorEmpty: boolean;
  setActiveEditorState: (kind: EditorKind, isEmpty: boolean) => void;
  /** Row currently hovered in PresetList — carries the body the ghost should paint, not just an
   *  id. Bridged via this shared store rather than props since PresetList/EditorPanel are sibling
   *  components (SourcePanel / EditorPanel), same reasoning as lib/aiSectionBridge.ts.
   *  Why the body travels along: EditorPanel used to re-resolve id → body itself against
   *  BUILTIN_PRESETS + customPresets, and simply never looked in the THIRD store a picker row can
   *  come from (aiPresets' kind:"template"), so those rows' hover was silently dead. The list is
   *  the only place that knows all three — it hands over what it drew. */
  hovered: { id: string; bodyMd: string } | null;
  setHovered: (id: string, bodyMd: string) => void;
  /** Clears only if `id` is the one still standing — never blow away another PresetList
   *  instance's hover (this is a global singleton and the component renders in several places). */
  clearHovered: (id?: string) => void;
  load: () => Promise<void>;
  /** Saves (or, same-name, overwrites) a custom preset from a note's title+body. Returns false
   *  (and toasts) when the title is blank or still the untouched default. */
  saveFromNote: (title: string, bodyMd: string) => Promise<boolean>;
  rename: (id: string, name: string) => Promise<void>;
  /** 칩 아이콘/색 지정 — rename 과 같은 저장 경로(note_presets JSON 배열 통째로 재저장).
   *  null 을 주면 해당 필드를 지워 기본 모습으로 되돌린다. */
  setStyle: (id: string, style: { icon?: string | null; color?: PresetColor | null }) => Promise<void>;
  remove: (id: string) => Promise<void>;
  /** "제거" on a builtin — hides it (mirrors stores/aiPresets.ts::deleteItem's builtin branch). */
  hideBuiltin: (id: BuiltinPresetId) => Promise<void>;
  /** The one "기본 항목 복원" action — un-hides every hidden builtin. */
  restoreHiddenBuiltins: () => Promise<void>;
  /** W7-d 프리셋 관리: 배열 안에서 위(-1)/아래(+1)로 한 칸 스왑 후 재저장 — note_presets 는
   *  이미 순서가 있는 JSON 배열이라 새 설정 키 없이 그 배열 자체를 재배열한다. 경계
   *  (맨 위에서 -1, 맨 아래에서 +1)는 no-op. */
  reorder: (id: string, direction: -1 | 1) => Promise<void>;
}

async function persist(list: CustomPreset[]) {
  await call("settings_set", { entries: { [SETTINGS_KEY]: list } });
}

async function persistHidden(ids: BuiltinPresetId[]) {
  await call("settings_set", { entries: { [HIDDEN_BUILTINS_KEY]: ids } });
}

export const usePresetsStore = create<PresetsState>((set, get) => ({
  customPresets: [],
  hiddenBuiltinIds: [],
  loaded: false,
  // "ready" until EditorPanel says otherwise — the desktop panel publishes on mount, and the
  // mobile/capture surfaces never render the hover ghost at all.
  targetState: "ready",
  activeEditorKind: "text",
  isEditorEmpty: true,
  setActiveEditorState: (kind, isEmpty) =>
    set((cur) => {
      const nextTargetState: PresetTargetState = isEmpty
        ? "ready"
        : kind === "diagram"
        ? "diagram"
        : kind === "sheet"
        ? "sheet"
        : "has_content";
      if (
        cur.activeEditorKind === kind &&
        cur.isEditorEmpty === isEmpty &&
        cur.targetState === nextTargetState
      ) {
        return {};
      }
      return {
        activeEditorKind: kind,
        isEditorEmpty: isEmpty,
        targetState: nextTargetState,
      };
    }),
  // No-op on an unchanged value: EditorPanel republishes on every ProseMirror transaction,
  // including bare caret moves. (Selector subscribers would bail on an unchanged value anyway —
  // this just keeps the state from churning on every keystroke.)
  setTargetState: (s) =>
    set((cur) => {
      if (cur.targetState === s) return {};
      const nextKind: EditorKind =
        s === "diagram" ? "diagram" : s === "sheet" ? "sheet" : cur.activeEditorKind;
      const nextEmpty = s === "ready";
      return {
        targetState: s,
        activeEditorKind: nextKind,
        isEditorEmpty: nextEmpty,
      };
    }),
  hovered: null,
  setHovered: (id, bodyMd) => set({ hovered: { id, bodyMd } }),
  clearHovered: (id) => set((s) => (!id || s.hovered?.id === id ? { hovered: null } : {})),

  load: async () => {
    try {
      const r = await call<{ settings: Record<string, unknown> }>("settings_get_all");
      set({
        customPresets: parseCustomPresets(r.settings[SETTINGS_KEY]),
        hiddenBuiltinIds: parseHiddenBuiltinIds(r.settings[HIDDEN_BUILTINS_KEY]),
        loaded: true,
      });
    } catch {
      set({ loaded: true });
    }
  },

  saveFromNote: async (title, bodyMd) => {
    const trimmed = title.trim();
    if (!trimmed || trimmed === "Untitled Note") {
      emitNotice(t("presets.save_needs_title"));
      return false;
    }
    const list = get().customPresets;
    const existingIdx = list.findIndex((p) => p.name === trimmed);
    const next =
      existingIdx >= 0
        ? list.map((p, i) => (i === existingIdx ? { ...p, bodyMd } : p))
        : [...list, { id: uniqueId(), name: trimmed, bodyMd }];
    set({ customPresets: next });
    try {
      await persist(next);
      // 오너 피드백(QA7#6): 프리셋은 노트 참조가 아니라 본문 복사본(CustomPreset={id,name,bodyMd})
      // 이라 원본 노트를 지워도 리스트에 남는다는 사실을 매 저장 시 한 줄로 안내한다. 새 토스트
      // 슬롯을 따로 안 쓰고 기존 "저장했습니다" 알림에 이어 붙인다(emitNotice 는 토스트 1개당
      // 메시지 1개 — 뜬금없이 두 개가 겹쳐 뜨는 것보다 한 문장이 낫다).
      emitNotice(`${t("presets.saved", { name: trimmed })} ${t("presets.persists_after_delete")}`);
      return true;
    } catch {
      set({ customPresets: list });
      emitNotice(t("presets.save_failed"));
      return false;
    }
  },

  rename: async (id, name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const list = get().customPresets;
    const next = list.map((p) => (p.id === id ? { ...p, name: trimmed } : p));
    set({ customPresets: next });
    try {
      await persist(next);
    } catch {
      set({ customPresets: list });
      emitNotice(t("presets.save_failed"));
    }
  },

  setStyle: async (id, style) => {
    const list = get().customPresets;
    const next = list.map((p) => {
      if (p.id !== id) return p;
      const merged: CustomPreset = { ...p };
      if ("icon" in style) {
        if (style.icon) merged.icon = style.icon;
        else delete merged.icon;
      }
      if ("color" in style) {
        if (style.color) merged.color = style.color;
        else delete merged.color;
      }
      return merged;
    });
    set({ customPresets: next });
    try {
      await persist(next);
    } catch {
      set({ customPresets: list });
      emitNotice(t("presets.save_failed"));
    }
  },

  remove: async (id) => {
    const list = get().customPresets;
    const next = list.filter((p) => p.id !== id);
    set({ customPresets: next });
    try {
      await persist(next);
    } catch {
      set({ customPresets: list });
      emitNotice(t("presets.save_failed"));
    }
  },

  hideBuiltin: async (id) => {
    const prev = get().hiddenBuiltinIds;
    if (prev.includes(id)) return;
    const next = [...prev, id];
    set({ hiddenBuiltinIds: next });
    try {
      await persistHidden(next);
    } catch {
      set({ hiddenBuiltinIds: prev });
      emitNotice(t("presets.save_failed"));
    }
  },

  restoreHiddenBuiltins: async () => {
    const prev = get().hiddenBuiltinIds;
    if (prev.length === 0) return;
    set({ hiddenBuiltinIds: [] });
    try {
      await persistHidden([]);
    } catch {
      set({ hiddenBuiltinIds: prev });
      emitNotice(t("presets.save_failed"));
    }
  },

  reorder: async (id, direction) => {
    const list = get().customPresets;
    const idx = list.findIndex((p) => p.id === id);
    const swapIdx = idx + direction;
    if (idx < 0 || swapIdx < 0 || swapIdx >= list.length) return; // 경계 — no-op
    const next = [...list];
    [next[idx], next[swapIdx]] = [next[swapIdx], next[idx]];
    set({ customPresets: next });
    try {
      await persist(next);
    } catch {
      set({ customPresets: list });
      emitNotice(t("presets.save_failed"));
    }
  },
}));
