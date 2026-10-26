import { create } from "zustand";
import { call, emitNotice } from "../lib/invoke";
import { uniqueId } from "../lib/ids";
import { t } from "../i18n/t";
import { whenLocaleReady } from "../i18n/locales";
import {
  type AiActionPreset,
  type AskAiKind,
  type CustomAiActionKind,
  LIST_PROMPT,
  ORGANIZE_PROMPT,
  PROOFREAD_PROMPT,
  SUMMARIZE_PROMPT,
  TEXT_PROMPT_LEGACY_HTML_V1,
  ENGINE_INSTRUCTION_DEFS,
  METADATA_PROMPT,
  METADATA_PROMPT_LEGACY_V1,
  DIAGRAM_EDIT_ID,
  DIAGRAM_PROGRESS_ID,
  healDiagramEditPrompt,
  healDiagramPrompt,
  healDiagramProgressPrompt,
  BUILTIN_DEFS,
  isAgentPlanPreset,
  isChatBuiltinPreset,
} from "./aiPrompts";
import { askAiBuiltinTiles, defaultTileOrder } from "../components/ai/askAiPresets";
import { getEngineInstruction, useAiInstructionsStore } from "./aiInstructions";
import { reportFallback } from "../lib/diag";

/**
 * AI 프리셋 목록 — 설정 키 `ai_action_presets` 하나(JSON 배열). PLAN-2026-09-27 §7 이후 담는 것:
 *   - **타일**: 요청 문장 템플릿(내장 = components/ai/askAiPresets.ts DEFS, 사용자가 이름·문장·숨김·순서를 고친다)
 *   - **사용자 프리셋**(isBuiltin false)
 *   - **액션 자리**: 타일이 없는 바로 실행 액션(`organize`·엔진 전용 id)의 숨김 값만(`isActionSlot`)
 * 배열 순서가 곧 모든 표면의 단일 순서다(§7-1). 옛 형식(엔진 장문을 든 빌트인, `order` 없음)은 로드 때 한 번
 * 이관해 저장한다(`parseStored` → `finishMigration`). 바로 실행 표면(모바일 AI 시트·사이드바 챗)은 채울 입력창이
 * 없어 타일 대신 `runnableActionPresets` 를 쓴다.
 */

const SETTINGS_KEY = "ai_action_presets";

function isValidPreset(item: unknown): item is AiActionPreset {
  if (!item || typeof item !== "object") return false;
  const p = item as Record<string, unknown>;
  return (
    typeof p.id === "string" &&
    p.id.length > 0 &&
    typeof p.name === "string" &&
    typeof p.prompt === "string" &&
    (p.kind === "text" ||
      p.kind === "metadata" ||
      p.kind === "diagram" ||
      p.kind === "template" ||
      p.kind === "sheet" ||
      p.kind === "tool") &&
    typeof p.isBuiltin === "boolean" &&
    typeof p.hidden === "boolean"
  );
}

const tileIdSet = (): Set<string> => new Set(askAiBuiltinTiles().map((p) => p.id));

/**
 * 타일이 없는 바로 실행 액션(`organize` · 엔진 전용 id)의 **숨김 값 자리**. AI 기능 카탈로그(lib/aiCapabilities.ts)의
 * 켜고 끄기가 여기 `hidden` 을 쓰고, 바로 실행 표면이 그 값을 따른다. 문장은 비운다 — 실제 문장은 BUILTIN_DEFS 와
 * 엔진 지침(stores/aiInstructions)이 소유한다. AI 프리셋 UI(편집기·타일·어시스트)는 이 자리를 보이지 않는다.
 */
function actionSlot(def: { id: string; nameKey: string; kind: AiActionPreset["kind"] }, hidden = false): AiActionPreset {
  return { id: def.id, name: t(def.nameKey), prompt: "", kind: def.kind, isBuiltin: true, hidden };
}

export function isActionSlot(p: Pick<AiActionPreset, "id" | "isBuiltin">): boolean {
  return p.isBuiltin && !tileIdSet().has(p.id) && BUILTIN_DEFS.some((d) => d.id === p.id);
}

/**
 * 처음 목록(아무것도 저장되지 않았을 때) — 타일을 대상별 옛 순서(ASKAI_TILE_ORDER, 노트 → 섹션 → 선택 → 관계도 →
 * 시트)로 이어 붙인 한 줄 순서 + 액션 자리. 단일 순서의 **기본값**일 뿐이고, 저장되면 사용자 순서가 이긴다(§7-1).
 */
export function builtinDefaults(): AiActionPreset[] {
  const tiles = defaultTileOrder();
  const tileIds = new Set(tiles.map((p) => p.id));
  const slots = BUILTIN_DEFS.filter((d) => !tileIds.has(d.id)).map((d) => actionSlot(d));
  return [...tiles, ...slots].map((p, order) => ({ ...p, order }));
}

export function builtinDefault(id: string): AiActionPreset | null {
  return builtinDefaults().find((p) => p.id === id) ?? null;
}

const LEGACY_TEXT_PROMPTS: Record<string, string[]> = {
  list: [LIST_PROMPT, TEXT_PROMPT_LEGACY_HTML_V1.list].filter(Boolean) as string[],
  organize: [ORGANIZE_PROMPT, TEXT_PROMPT_LEGACY_HTML_V1.organize].filter(Boolean) as string[],
  summarize: [SUMMARIZE_PROMPT, TEXT_PROMPT_LEGACY_HTML_V1.summarize].filter(Boolean) as string[],
  proofread: [PROOFREAD_PROMPT, TEXT_PROMPT_LEGACY_HTML_V1.proofread].filter(Boolean) as string[],
};

const ENGINE_IDS = new Set<string>(ENGINE_INSTRUCTION_DEFS.map((d) => d.id));

/**
 * 옛 목록에 저장된 엔진 지침을 "지금 코드가 알아볼 수 있는 모양"으로 되돌린다 — 치유 함수(정확 일치로만
 * 옛 판을 새 판으로 바꾸던 것)와 용어 개명(워크스페이스 → 노트북, 기본값 문구에만 들어갔다)을 거친다.
 * 결과가 지금 기본값과 같으면 사람이 고친 것이 아니다.
 */
function normalizeStoredEngine(id: string, prompt: string): string {
  let p = prompt;
  if (id === "metadata" && p === METADATA_PROMPT_LEGACY_V1) p = METADATA_PROMPT;
  if (id === "diagram") p = healDiagramPrompt(p);
  if (id === DIAGRAM_EDIT_ID) p = healDiagramEditPrompt(p);
  if (id === DIAGRAM_PROGRESS_ID) p = healDiagramProgressPrompt(p);
  return p.split("워크스페이스").join("노트북").trim();
}

/**
 * 엔진 지침 중 옛 목록의 값을 **재정의로 옮기는** 것 — 메타데이터 기준 하나(PLAN-2026-09-27 §7.1: 사용자가
 * 고칠 만한 유일한 지침). 나머지(관계도·시트 JSON 규칙, 에이전트 계획, 챗)는 옛 값을 버리고 코드 기본값을 쓴다.
 *
 * 왜: 옛 저장 방식은 AI 액션을 **하나라도** 고치면 빌트인까지 목록 전체를 통째로 저장했다. 그래서 다른 값은
 * 거의 전부 "그때의 코드 기본값" 사본이고, 형식 계약이라 옛 판이 남으면 실제로 틀린 결과가 나온다(2026-09-28
 * 오너 DB 실측: 관계도·시트·시트 수정 셋 다 라벨 언어·헤더 행·숫자 쉼표 규칙이 빠진 옛 판이었다).
 * ponytail: 이 규칙들을 일부러 고쳐 쓴 사용자가 있었다면 그 수정은 사라진다 — 버린 id 는 진단에 남긴다.
 * 그런 보고가 오면 이관 전 목록은 settings 백업(노트북 내보내기)에서 되살릴 수 있다.
 */
const MIGRATED_ENGINE_IDS = new Set<string>(["metadata"]);

interface ParsedPresets {
  list: AiActionPreset[];
  /** 옛 목록에서 넘어온 엔진 지침 — 문자열 = 재정의, null = 고친 적 없음. */
  instructionUpdates: Record<string, string | null>;
  /** 옛 목록에 들어 있던 엔진 지침 원문(applyMigration 이 옛 이관이 넣은 값을 알아보는 데 쓴다). */
  snapshots: Record<string, string>;
  /** 옛 형식에서 옮긴 것이 있거나 빠진 빌트인을 채웠다 — 이 결과를 한 번 저장해야 이관이 다시 돌지 않는다. */
  changed: boolean;
}

/** 저장된 목록 → 지금 형식. **순수 함수**다: 설정을 쓰지 않고, 옮길 지침은 돌려주기만 한다(load 가 한 번 반영). */
function parseStored(raw: unknown): ParsedPresets | null {
  if (!Array.isArray(raw)) return null;

  const tileMap = new Map(askAiBuiltinTiles().map((b) => [b.id, b]));
  const defMap = new Map(BUILTIN_DEFS.map((d) => [d.id, d]));
  const engineDefMap = new Map(ENGINE_INSTRUCTION_DEFS.map((d) => [d.id, d.prompt]));

  const out: AiActionPreset[] = [];
  const customFromLegacyText: AiActionPreset[] = [];
  const instructionUpdates: Record<string, string | null> = {};
  const snapshots: Record<string, string> = {};
  const dropped: string[] = [];
  let changed = false;

  for (const p of raw.filter(isValidPreset)) {
    const tile = p.isBuiltin ? tileMap.get(p.id) : undefined;
    const def = p.isBuiltin ? defMap.get(p.id) : undefined;
    // 옛 형식(2026-09-27 이전) — 빌트인이 타일 문장이 아니라 실행 액션의 장문을 들고 있고 `order` 가 없다. 새 형식은
    // 모든 항목에 order 를 쓰므로(아래 끝, reorder), 새 편집기에서 고친 타일 문장을 옛 장문으로 오판하지 않는다.
    const legacy = !!def && p.order === undefined && p.prompt !== "";
    if (legacy) {
      changed = true;
      if (ENGINE_IDS.has(p.id)) {
        snapshots[p.id] = p.prompt;
        const edited = normalizeStoredEngine(p.id, p.prompt) !== (engineDefMap.get(p.id) ?? "").trim();
        if (edited && MIGRATED_ENGINE_IDS.has(p.id)) instructionUpdates[p.id] = p.prompt;
        else {
          instructionUpdates[p.id] = null;
          if (edited) dropped.push(p.id);
        }
      } else if (LEGACY_TEXT_PROMPTS[p.id]) {
        const isKnownDefault = LEGACY_TEXT_PROMPTS[p.id].includes(p.prompt.trim());
        if (!isKnownDefault && p.prompt.trim()) {
          // 사용자가 과거에 고친 텍스트 변환 장문 → 사용자 프리셋으로 보존(버리지 않는다)
          customFromLegacyText.push({
            id: uniqueId(),
            name: `${p.name} (${t("ai.custom_edit_suffix")})`,
            prompt: p.prompt,
            kind: "text",
            isBuiltin: false,
            hidden: false,
            targets: ["note", "section"],
          });
        }
      }
    }

    if (tile) {
      // 내장 타일 — DEFS 의 모양(아이콘·대상·위치·필요 참조)에 저장된 이름·숨김, 그리고 새 형식이면 사용자가 고친 문장.
      out.push({ ...tile, name: p.name || tile.name, hidden: p.hidden, prompt: legacy || !p.prompt.trim() ? tile.prompt : p.prompt, order: p.order });
    } else if (def) {
      out.push({ ...actionSlot(def, p.hidden), order: p.order });
    } else if (p.isBuiltin) {
      changed = true; // 코드에서 사라진 빌트인 id — 버린다
    } else {
      out.push(p);
    }
  }

  if (dropped.length) reportFallback("ai_presets", "legacy_engine_prompt_dropped", dropped.join(","));
  if (customFromLegacyText.length > 0) out.push(...customFromLegacyText);

  // 빠진 내장 타일·액션 자리 채우기(코드에 새로 생긴 것) — 기본 순서대로 끝에.
  const presentIds = new Set(out.map((p) => p.id));
  for (const b of builtinDefaults()) {
    if (!presentIds.has(b.id)) {
      out.push(b);
      changed = true;
    }
  }
  if (out.some((p, index) => p.order !== index)) changed = true;

  // 단일 순서 — 배열 순서가 진실이고, order 는 그 사본이다.
  return {
    list: out.map((p, index) => ({ ...p, order: index })),
    instructionUpdates,
    snapshots,
    changed,
  };
}

/**
 * 옛 형식이었으면 한 번 이관한다: 지침 재정의를 먼저 한 번에 반영하고, 그다음 목록을 새 형식으로 저장한다.
 * 목록이 저장되면 다음 로드부터는 옮길 것이 없어 다시 돌지 않는다. 지침 저장이 실패하면 목록도 저장하지
 * 않는다 — 다음 로드에 처음부터 다시(멱등).
 */
async function finishMigration(parsed: ParsedPresets): Promise<void> {
  const instr = useAiInstructionsStore.getState();
  if (!instr.loaded) await instr.load();
  const ok = await useAiInstructionsStore.getState().applyMigration(parsed.instructionUpdates, parsed.snapshots);
  if (!ok) return;
  try {
    await persist(parsed.list);
  } catch (e) {
    // call() 이 토스트를 띄웠다 — 다음 로드에 이관이 다시 돈다(멱등).
    reportFallback("ai_presets", "migration_persist_failed", String(e));
  }
}

/** 편집기에 보이는 AI 프리셋(숨기지 않은 타일·사용자 프리셋), 저장 순서대로. 액션 자리는 빠진다. */
export function visiblePresets(list: AiActionPreset[]): AiActionPreset[] {
  return list.filter((p) => !p.hidden && !isActionSlot(p));
}

/**
 * 입력창 없이 프리셋을 **바로 실행하는** 표면(모바일 AI 시트, 사이드바 챗 프리셋)의 목록 — BUILTIN_DEFS(텍스트 변환
 * 4 + 엔진 지침 16, 엔진은 사용자 재정의 반영) + 사용자 프리셋. 같은 id 를 목록에서 숨겼으면(타일·액션 자리) 숨긴다.
 * 2026-09-28 검토에서 복원: 목록이 타일 문장(채울 칸이 있는 템플릿)이 된 뒤 이 표면들이 칸을 채울 곳 없이 타일을
 * 돌리거나(관계도·시트 규칙 없이, `{{lang}}` 그대로) 항목을 잃었다.
 * ponytail: 이 표면들까지 타일로 통일하려면 슬롯을 채울 입력(모바일 시트의 작은 요청문 상자)이 먼저 필요하다.
 */
export function runnableActionPresets(list: AiActionPreset[]): AiActionPreset[] {
  const hidden = new Set(list.filter((p) => p.hidden).map((p) => p.id));
  const builtins: AiActionPreset[] = BUILTIN_DEFS.map((d) => ({
    id: d.id,
    name: t(d.nameKey),
    prompt: ENGINE_IDS.has(d.id) ? getEngineInstruction(d.id) : d.prompt,
    kind: d.kind,
    isBuiltin: true,
    hidden: hidden.has(d.id),
  }));
  return [...builtins, ...list.filter((p) => !p.isBuiltin)];
}

/**
 * Action menus (desktop AI menu, mobile AI sheet) — agent plan presets are guidance-only
 * (plan generation has its own entry points) so they must not appear as clickable text actions,
 * and kind:"template" is a note scaffold with no model call at all (Q7): it belongs in the
 * new-note preset picker, never in a "이 노트를 변환" menu.
 */
export function menuActionPresets(list: AiActionPreset[]): AiActionPreset[] {
  return runnableActionPresets(list).filter(
    (p) => !p.hidden && !isAgentPlanPreset(p) && !isChatBuiltinPreset(p) && p.kind !== "template" && p.kind !== "tool",
  );
}

/** Sidebar-only virtual item — not in BUILTIN_DEFS / Settings / runAiAction. */
export const SIDEBAR_SAVE_MEMO_ID = "save_memo";

export function isSidebarSaveMemoPreset(p: { id: string }): boolean {
  return p.id === SIDEBAR_SAVE_MEMO_ID;
}

function sidebarSaveMemoPreset(): AiActionPreset {
  return {
    id: SIDEBAR_SAVE_MEMO_ID,
    name: t("search.chat_save_content"),
    prompt: "",
    kind: "text",
    isBuiltin: false,
    hidden: false,
  };
}

/** 사이드바 챗 프리셋: 가상 내용저장 + 메뉴에 뜨는 AI 작업 + 챗 전용 빌트인 5 (숨김·템플릿·agent_* 제외). */
export function sidebarChatPresets(list: AiActionPreset[]): AiActionPreset[] {
  const items = runnableActionPresets(list).filter((p) => {
    if (p.hidden || p.kind === "template" || p.kind === "tool") return false;
    if (isChatBuiltinPreset(p)) return true;
    return !isAgentPlanPreset(p);
  });
  return [sidebarSaveMemoPreset(), ...items];
}

/** kind:"template" 항목만 — PresetList 가 note_presets 쪽 템플릿과 한 목록에 합쳐 그린다. */
export function templateActionPresets(list: AiActionPreset[]): AiActionPreset[] {
  return list.filter((p) => !p.hidden && p.kind === "template");
}

interface AiPresetsState {
  list: AiActionPreset[];
  loaded: boolean;
  /** 저장된 목록을 읽지 못했다 — 화면은 기본값으로 보이되 **쓰기는 막는다**(기본값 위에 저장하면 사용자 프리셋이 지워진다). */
  loadFailed: boolean;
  load: () => Promise<void>;
  /** `targets` — 이 프리셋이 타일로 뜰 AI 모달 대상. 없으면 옛 기본(노트·텍스트 섹션). AI 모달의
   *  "+추가"가 관계도·시트·선택 대상에서 만들 때 그 대상에 뜨도록 넘긴다(askAiPresets.tilesForTarget). */
  /** `extra` — AI 모달의 "프리셋으로 저장"이 지금 요청의 위치·필요 참조를 함께 남긴다(없으면 기본: 새 섹션, 참조 없음). */
  addCustom: (
    name: string,
    prompt: string,
    kind?: CustomAiActionKind,
    targets?: AskAiKind[],
    extra?: Pick<AiActionPreset, "where" | "needs">,
  ) => Promise<void>;
  updateItem: (id: string, patch: { name?: string; prompt?: string }) => Promise<void>;
  resetItem: (id: string) => Promise<void>;
  deleteItem: (id: string) => Promise<void>;
  /** PLAN-2026-08-30 §3 W2: AI 기능 카탈로그의 온디맨드 토글이 쓰는 단일-항목 hidden 세터 —
   *  deleteItem(빌트인 한정, hidden:true 전용)과 restoreHiddenBuiltins(전체 un-hide)의 중간,
   *  "이 항목 하나만" 켜고 끈다. 같은 withPersist 경로를 그대로 탄다. */
  setHidden: (id: string, hidden: boolean) => Promise<void>;
  restoreHiddenBuiltins: () => Promise<void>;
  reorder: (id: string, dir: "up" | "down") => Promise<void>;
}

async function persist(list: AiActionPreset[]) {
  // src-tauri/src/repo/settings_schema.rs's validate_setting "ai_action_presets" match arm accepts
  // kind "text"|"metadata"|"diagram"|"template" — the true kind round-trips as-is, no wire-format
  // sanitizing needed (Rust round-trip test: settings_schema.rs::
  // test_ai_action_presets_template_kind_round_trips).
  await call("settings_set", { entries: { ai_action_presets: list } });
}

async function withPersist(
  set: (s: Partial<AiPresetsState>) => void,
  prevList: AiActionPreset[],
  nextList: AiActionPreset[],
) {
  set({ list: nextList });
  try {
    await persist(nextList);
  } catch {
    set({ list: prevList });
    emitNotice(t("ai.action_save_failed"));
  }
}

/**
 * 쓰기 전에 저장된 목록을 읽은 상태인지 확인한다 — 모든 쓰기 동작이 이것부터 부른다. 읽기 전의 목록은 기본값이라,
 * 그 위에 저장하면 사용자 프리셋이 통째로 지워진다(2026-09-28: 편집기의 "+" 가 읽기 전·읽기 실패 뒤에 눌려 실제로
 * 사용자 프리셋 4개가 지워졌다 — 개발 빌드의 핫 리로드가 저장소를 새로 만들 때마다 이 틈이 열렸다).
 */
async function ensureWritable(get: () => AiPresetsState): Promise<boolean> {
  if (!get().loaded) await get().load();
  if (!get().loadFailed) return true;
  reportFallback("ai_presets", "write_blocked_unloaded", "");
  emitNotice(t("ai.action_save_failed"));
  return false;
}

export const useAiPresetsStore = create<AiPresetsState>((set, get) => ({
  // 처음 목록은 사전이 온 뒤에 채운다(아래 whenLocaleReady) — 이름이 번역 문자열이라 모듈 평가 시점엔 못 만든다.
  list: [],
  loaded: false,
  loadFailed: false,

  load: async () => {
    let parsed: ParsedPresets | null = null;
    try {
      const r = await call<{ settings: Record<string, unknown> }>("settings_get_all");
      parsed = parseStored(r.settings[SETTINGS_KEY]);
    } catch (e) {
      reportFallback("ai_presets", "load_failed", String(e));
      set({ list: builtinDefaults(), loaded: true, loadFailed: true });
      return;
    }
    // 엔진 지침은 AI 프리셋과 함께 읽는다 — getEngineInstruction 은 동기라, 안 읽힌 채면 사용자 재정의를
    // 조용히 건너뛰고 코드 기본값을 준다. 프리셋은 AI 모달·어시스트가 가장 먼저 읽으므로 여기가 초크포인트다.
    // 이관은 "읽음" 표시 **전에** 끝낸다 — 표시 뒤에 이관의 저장이 늦게 떨어지면 그 사이의 편집을 덮는다.
    if (parsed?.changed) await finishMigration(parsed);
    else if (!useAiInstructionsStore.getState().loaded) await useAiInstructionsStore.getState().load();
    set({ list: parsed?.list ?? builtinDefaults(), loaded: true, loadFailed: false });
  },

  // kind 는 CUSTOM_KINDS 안에서만 고를 수 있다(metadata 는 빌트인 전용) — 타입으로 강제되고,
  // 넘기지 않으면 예전 동작 그대로 "text".
  addCustom: async (name, prompt, kind = "text", targets, extra) => {
    const trimmedName = name.trim();
    const trimmedPrompt = prompt.trim();
    if (!trimmedName || !trimmedPrompt) return;
    if (!(get().loaded && !get().loadFailed) && !(await ensureWritable(get))) return;
    const prev = get().list;
    const next: AiActionPreset[] = [
      ...prev,
      {
        id: uniqueId(), name: trimmedName, prompt: trimmedPrompt, kind, isBuiltin: false, hidden: false,
        ...(targets ? { targets } : {}),
        ...(extra?.where ? { where: extra.where } : {}),
        ...(extra?.needs?.length ? { needs: extra.needs } : {}),
      },
    ];
    await withPersist(set, prev, next);
  },

  updateItem: async (id, patch) => {
    if (!(get().loaded && !get().loadFailed) && !(await ensureWritable(get))) return;
    const prev = get().list;
    const next = prev.map((p) =>
      p.id === id
        ? { ...p, ...(patch.name !== undefined ? { name: patch.name.trim() || p.name } : {}), ...(patch.prompt !== undefined ? { prompt: patch.prompt } : {}) }
        : p,
    );
    await withPersist(set, prev, next);
  },

  resetItem: async (id) => {
    const def = builtinDefault(id);
    if (!def) return; // custom actions have no default to reset to
    if (!(get().loaded && !get().loadFailed) && !(await ensureWritable(get))) return;
    const prev = get().list;
    const next = prev.map((p) => (p.id === id ? { ...p, name: def.name, prompt: def.prompt } : p));
    await withPersist(set, prev, next);
  },

  deleteItem: async (id) => {
    if (!(get().loaded && !get().loadFailed) && !(await ensureWritable(get))) return;
    const prev = get().list;
    const target = prev.find((p) => p.id === id);
    if (!target) return;
    const next = target.isBuiltin ? prev.map((p) => (p.id === id ? { ...p, hidden: true } : p)) : prev.filter((p) => p.id !== id);
    await withPersist(set, prev, next);
  },

  setHidden: async (id, hidden) => {
    if (!(get().loaded && !get().loadFailed) && !(await ensureWritable(get))) return;
    const prev = get().list;
    const next = prev.map((p) => (p.id === id ? { ...p, hidden } : p));
    await withPersist(set, prev, next);
  },

  restoreHiddenBuiltins: async () => {
    if (!(get().loaded && !get().loadFailed) && !(await ensureWritable(get))) return;
    const prev = get().list;
    const next = prev.map((p) => (p.isBuiltin && p.hidden ? { ...p, hidden: false } : p));
    await withPersist(set, prev, next);
  },

  reorder: async (id, dir) => {
    if (!(get().loaded && !get().loadFailed) && !(await ensureWritable(get))) return;
    const prev = get().list;
    const idx = prev.findIndex((p) => p.id === id);
    if (idx < 0) return;
    const step = dir === "up" ? -1 : 1;
    let swapIdx = idx + step;
    while (swapIdx >= 0 && swapIdx < prev.length && prev[swapIdx].hidden) {
      swapIdx += step;
    }
    if (swapIdx < 0 || swapIdx >= prev.length) return; // already at the edge
    const next = [...prev];
    [next[idx], next[swapIdx]] = [next[swapIdx], next[idx]];
    const reordered = next.map((p, i) => ({ ...p, order: i }));
    await withPersist(set, prev, reordered);
  },
}));

// 저장된 목록을 읽기 전의 처음 목록 = 빌트인 기본값. 창 부팅이 첫 렌더 전에 사전을 기다리므로 화면은 늘 채워진 값을 본다.
whenLocaleReady(() => {
  const s = useAiPresetsStore.getState();
  if (!s.loaded && s.list.length === 0) useAiPresetsStore.setState({ list: builtinDefaults() });
});
