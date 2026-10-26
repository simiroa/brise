import { useEffect, useRef, useState } from "react";
import {
  usePresetsStore,
  BUILTIN_PRESETS,
  presetColorVar,
  type BuiltinPresetId,
  type CustomPreset,
} from "../../stores/presets";
import { useAiPresetsStore, templateActionPresets } from "../../stores/aiPresets";
import { applyPreset, applyDiagramPreset, applySheetPreset } from "../../lib/presetBridge";
import { insertAiSection } from "../../lib/aiSectionBridge";
import { generateDiagramWithRepair } from "../../stores/runAiAction";
import { useSettingsStore } from "../../stores/settings";
import { emitNotice } from "../../lib/invoke";
import { bump as bumpDiagramTypeUsage } from "../../lib/diagramTypeUsage";
import { DIAGRAM_PROMPT } from "../../stores/aiPrompts";
import { type DiagramTypeDef, type DiagramTypeGroup } from "../diagram/types/registry";
import { diagramTemplateSource } from "../diagram/diagramStarter";
import { useNotesStore } from "../../stores/notes";
import { noteIconComp } from "../../lib/noteIcons";
import { useAiStore, selectAiAvailability } from "../../stores/ai";
import { useMenuPos } from "../../lib/ui";
import { t } from "../../i18n/t";
import { IconNote } from "../icons";
import {
  BUILTIN_CHIPS,
  type Entry,
} from "../presets/presetConstants";

/** 어시스트 패널의 관계도 그룹 헤더 라벨 — 레지스트리 `group` 4개(순서는 DIAGRAM_TYPE_GROUPS). */
export const DIAGRAM_GROUP_LABEL_KEY: Record<DiagramTypeGroup, string> = {
  structure: "presets.diagram_group_structure",
  flow: "presets.diagram_group_flow",
  state: "presets.diagram_group_state",
  layout: "presets.diagram_group_layout",
};

/** 빌트인 관계도 칩(`+` 메뉴·관리 모달) ↔ 레지스트리 타입. 적용과 고스트가 같은 시드를 본다. */
const DIAGRAM_KIND_TYPE: Record<string, string> = {
  diagram: "basic",
  diagram_mindmap: "mindmap",
  diagram_sequence: "sequence",
};
const diagramKindSeed = (id: string) => diagramTemplateSource(DIAGRAM_KIND_TYPE[id] ?? "basic");

const isSheetKey = (key: string) => key.startsWith("sheet") || key === "budget";
const isDiagramKey = (key: string) => key.startsWith("diagram");
const isTextKey = (key: string) => !isSheetKey(key) && !isDiagramKey(key);

/**
 * 빌트인·커스텀·AI 템플릿(kind:"template") → Entry[] + 호버/컨텍스트 메뉴/적용 헬퍼 — PresetList
 * (menu/manage 모드)와 어시스트(TextAssist/SheetAssist 의 시작 모드)가 공유한다(PLAN-2026-09-21 W1,
 * PresetList.tsx 에서 그대로 옮김 — 로직 무변, `strips` 였던 자리는 `!manage && !inMenu` 로 대체).
 */
export function usePresetEntries({
  manage,
  inMenu,
  onApplied,
}: {
  manage: boolean;
  inMenu: boolean;
  onApplied?: () => void;
}) {
  const strips = !manage && !inMenu;
  const customPresets = usePresetsStore((s) => s.customPresets);
  const hiddenBuiltinIds = usePresetsStore((s) => s.hiddenBuiltinIds);
  const loaded = usePresetsStore((s) => s.loaded);
  const load = usePresetsStore((s) => s.load);
  const renamePreset = usePresetsStore((s) => s.rename);
  const setPresetStyle = usePresetsStore((s) => s.setStyle);
  const removePreset = usePresetsStore((s) => s.remove);
  const reorderPreset = usePresetsStore((s) => s.reorder);
  const hideBuiltin = usePresetsStore((s) => s.hideBuiltin);
  const restoreHiddenBuiltins = usePresetsStore((s) => s.restoreHiddenBuiltins);

  const aiPresetList = useAiPresetsStore((s) => s.list);
  const aiPresetsLoaded = useAiPresetsStore((s) => s.loaded);
  const loadAiPresets = useAiPresetsStore((s) => s.load);
  const ensureAiReachable = useAiStore((s) => s.ensureAiReachable);

  const hasOpenNote = useNotesStore((s) => !!s.activeNote && !s.activeDraft);
  const hidden = new Set(hiddenBuiltinIds);
  const hasHiddenBuiltins = hiddenBuiltinIds.length > 0;

  const [ctx, setCtx] = useState<{ preset: CustomPreset; x: number; y: number } | null>(null);
  const [styleCtx, setStyleCtx] = useState<{ id: string; x: number; y: number } | null>(null);
  const [renameTarget, setRenameTarget] = useState<CustomPreset | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CustomPreset | null>(null);
  const [deleteBuiltinTarget, setDeleteBuiltinTarget] = useState<{ id: BuiltinPresetId; label: string } | null>(null);
  const [makeMenu, setMakeMenu] = useState<{ entry: Entry; x: number; y: number } | null>(null);
  const { ref: styleRef, x: styleX, y: styleY } = useMenuPos(styleCtx);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  useEffect(() => {
    if (!aiPresetsLoaded) void loadAiPresets();
  }, [aiPresetsLoaded, loadAiPresets]);

  useEffect(() => {
    void ensureAiReachable();
  }, [ensureAiReachable]);

  // Hover handoff — 이 훅 인스턴스가 마지막으로 세운 hover 만 unmount 시 지운다(store 는 전역
  // 싱글턴이라 다른 인스턴스의 hover 를 지우면 안 된다. PresetList.tsx 원본 주석 그대로).
  const myHoverRef = useRef<string | null>(null);
  const hoverRow = (id: string, bodyMd: string) => {
    myHoverRef.current = id;
    usePresetsStore.getState().setHovered(id, bodyMd);
  };
  const unhoverRow = (id: string) => {
    if (myHoverRef.current === id) myHoverRef.current = null;
    usePresetsStore.getState().clearHovered(id);
  };
  useEffect(
    () => () => {
      if (myHoverRef.current) usePresetsStore.getState().clearHovered(myHoverRef.current);
    },
    []
  );
  const builtinBody = (id: BuiltinPresetId) => BUILTIN_PRESETS.find((p) => p.id === id)?.bodyMd ?? "";
  // bodyMd 는 함수여도 된다 — 배치 행처럼 호버 때만 만들 값(관계도 재직렬화)을 렌더마다 9번 만들지 않게.
  const hoverProps = (id: string, bodyMd: string | (() => string)) =>
    manage
      ? {}
      : {
          onMouseEnter: () => hoverRow(id, typeof bodyMd === "function" ? bodyMd() : bodyMd),
          onMouseLeave: () => unhoverRow(id),
        };

  // 이름 입력 상태로 여는 조건 = "지금 열린 노트에 섹션이 append 된다". "+" 메뉴(inMenu)는 항상 그렇고,
  // 어시스트 패널은 열린 노트가 있고 new-note 강제가 아닐 때만. 새 노트/초안의 첫 섹션·AI 생성·manage 는 제외.
  const renameOnAppend = (landing?: "new-note" | "new-section") => {
    if (manage) return false;
    if (inMenu) return true;
    const n = useNotesStore.getState();
    return landing !== "new-note" && !!n.activeNote && !n.activeDraft;
  };

  const applyBuiltin = (id: Exclude<BuiltinPresetId, "ai" | "diagram">) => {
    unhoverRow(id);
    const notes = useNotesStore.getState();
    if (id === "blank" && notes.activeNote && !notes.activeDraft) {
      void insertAiSection(t("presets.new_section_name"), "", notes.activeNote.note.id, undefined, {
        postProcess: false,
        renameOnInsert: renameOnAppend(),
      });
      onApplied?.();
      return;
    }
    void applyPreset({ title: null, bodyMd: builtinBody(id) });
    onApplied?.();
  };

  const aiTemplates = templateActionPresets(aiPresetList);

  const applyDiagramKind = (id: string) => (landing?: "new-note" | "new-section") => {
    unhoverRow(id);
    void applyDiagramPreset({
      title: null,
      bodyMd: diagramKindSeed(id),
      sectionName: t(BUILTIN_CHIPS.find((b) => b.id === id)?.labelKey ?? "presets.diagram_name"),
      renameOnInsert: renameOnAppend(landing),
      landing,
    });
    onApplied?.();
  };

  /** 어시스트 패널의 레지스트리 타입 행 — 클릭 = 시드로 새 관계도 섹션. 고스트도 같은 시드(hoverProps). */
  const applyDiagramType = (def: DiagramTypeDef) => {
    unhoverRow(def.id);
    void applyDiagramPreset({ title: null, bodyMd: diagramTemplateSource(def.id), sectionName: t(def.nameKey), renameOnInsert: renameOnAppend() });
    bumpDiagramTypeUsage(def.id, "seed");
    onApplied?.();
  };

  // "AI로 채우기" — 관계도 타입 행 우측 버튼. AI 가 켜져 있고 닿을 때만 존재(비활성이 아니라 부재).
  const aiEnabled = useSettingsStore((s) => s.aiEnabled);
  const aiReachable = useAiStore((s) => s.aiReachable);
  const availability = selectAiAvailability({ aiEnabled }, { aiReachable });
  const showDiagramAiFill = availability === "ready";
  const [aiFillPending, setAiFillPending] = useState<string | null>(null);
  const fillDiagramWithAi = async (def: DiagramTypeDef) => {
    if (aiFillPending) return;
    setAiFillPending(def.id);
    try {
      const basePrompt = useAiPresetsStore.getState().list.find((p) => p.id === "diagram")?.prompt || DIAGRAM_PROMPT;
      const request = [
        t(def.aiHintKey),
        def.seed.states?.length ? `states: ${JSON.stringify(def.seed.states)}` : "",
        `route: "${def.seed.route ?? "curve"}"`,
      ]
        .filter(Boolean)
        .join("\n");
      const res = await generateDiagramWithRepair(`${basePrompt}\n\n[사용자 요청]\n${request}`, null);
      if (!res.ok || !res.json) {
        emitNotice(t("editor.diagram_ai_error", { error: res.errors?.join(", ") ?? t("editor.diagram_ai_empty") }));
        return;
      }
      await applyDiagramPreset({ title: null, bodyMd: res.json, sectionName: t(def.nameKey) });
      bumpDiagramTypeUsage(def.id, "ai");
      onApplied?.();
    } catch (e) {
      emitNotice(t("editor.diagram_ai_error", { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setAiFillPending(null);
    }
  };

  const applySheetKind = (id: string) => async (landing?: "new-note" | "new-section") => {
    unhoverRow(id);
    const { createBudgetSheetJson, createEmptySheetJson, createScheduleSheetJson, createTrackerSheetJson } = await import("../sheet/sheetStarter");
    let bodyMd = createEmptySheetJson();
    if (id === "budget") bodyMd = createBudgetSheetJson();
    else if (id === "sheet_schedule") bodyMd = createScheduleSheetJson();
    else if (id === "sheet_tracker") bodyMd = createTrackerSheetJson();
    void applySheetPreset({
      title: null,
      bodyMd,
      sectionName: t(BUILTIN_CHIPS.find((b) => b.id === id)?.labelKey ?? "presets.sheet_name"),
      renameOnInsert: renameOnAppend(landing),
      landing,
    });
    onApplied?.();
  };

  const builtinRemoveHandler = (id: BuiltinPresetId, label: string) =>
    manage ? () => setDeleteBuiltinTarget({ id, label }) : undefined;

  /** 커스텀 프리셋의 아이콘 — 미지정이면 예전과 똑같이 IconNote + muted (하위호환). */
  const customIcon = (p: CustomPreset) => {
    const Comp = noteIconComp(p.icon, IconNote);
    return <Comp size={15} strokeWidth={1.8} style={{ color: presetColorVar(p.color), flex: "none" }} />;
  };

  // "+" 새 섹션 메뉴(inMenu)는 "무슨 종류의 섹션을 만들까"만 묻는다(텍스트/관계도/시트) — 프리셋
  // 고르기가 아니다. 숨김(hidden) 설정은 메뉴엔 적용하지 않는다.
  const MENU_KINDS: ReadonlySet<BuiltinPresetId> = new Set(["blank", "diagram", "sheet"]);
  const builtinRows = inMenu
    ? BUILTIN_CHIPS.filter((b) => MENU_KINDS.has(b.id))
    : strips
    ? BUILTIN_CHIPS.filter((b) => b.id !== "blank" && !hidden.has(b.id))
    : BUILTIN_CHIPS.filter((b) => !hidden.has(b.id));

  const entries: Entry[] = [
    ...builtinRows.map(({ id, labelKey, Icon }) => ({
      key: id,
      label: inMenu && id === "blank" ? t("presets.blank_menu_name") : t(labelKey),
      icon: <Icon size={15} strokeWidth={1.8} style={{ color: "var(--accent)", flex: "none" }} />,
      locked: true,
      onApply:
        id.startsWith("diagram")
          ? applyDiagramKind(id)
          : id.startsWith("sheet") || id === "budget"
          ? applySheetKind(id)
          : () => applyBuiltin(id as Exclude<BuiltinPresetId, "ai" | "diagram" | "diagram_mindmap" | "diagram_sequence" | "sheet" | "budget" | "sheet_schedule" | "sheet_tracker">),
      onMake: manage
        ? (landing: "new-note" | "new-section") => {
            if (id === "blank" && landing === "new-section") {
              const notes = useNotesStore.getState();
              if (notes.activeNote && !notes.activeDraft) {
                void insertAiSection(t("presets.new_section_name"), "", notes.activeNote.note.id, undefined, {
                  postProcess: false,
                });
              }
              onApplied?.();
              return;
            }
            if (id.startsWith("diagram")) void applyDiagramKind(id)(landing);
            else if (id.startsWith("sheet") || id === "budget") void applySheetKind(id)(landing);
            else void applyPreset({ title: null, bodyMd: builtinBody(id), landing });
            onApplied?.();
          }
        : undefined,
      hover: hoverProps(id, id.startsWith("diagram") ? diagramKindSeed(id) : builtinBody(id)),
      onRemove: builtinRemoveHandler(id, t(labelKey)),
    })),
    ...(inMenu ? [] : customPresets).map((p, i) => ({
      key: p.id,
      label: p.name,
      icon: customIcon(p),
      locked: false,
      onApply: () => {
        unhoverRow(p.id);
        void applyPreset({ title: null, bodyMd: p.bodyMd });
        onApplied?.();
      },
      onMake: manage
        ? (landing: "new-note" | "new-section") => {
            void applyPreset({ title: null, bodyMd: p.bodyMd, landing });
            onApplied?.();
          }
        : undefined,
      hover: hoverProps(p.id, p.bodyMd),
      canMoveUp: i > 0,
      canMoveDown: i < customPresets.length - 1,
      onMoveUp: () => void reorderPreset(p.id, -1),
      onMoveDown: () => void reorderPreset(p.id, 1),
      onRename: () => setRenameTarget(p),
      onRemove: () => setDeleteTarget(p),
      custom: p,
    })),
    ...(inMenu ? [] : aiTemplates).map((p) => ({
      key: p.id,
      label: p.name,
      icon: <IconNote size={12} strokeWidth={1.8} style={{ color: "var(--muted)", flex: "none" }} />,
      locked: true,
      onApply: () => {
        unhoverRow(p.id);
        void applyPreset({ title: null, bodyMd: p.prompt });
        onApplied?.();
      },
      onMake: manage
        ? (landing: "new-note" | "new-section") => {
            void applyPreset({ title: null, bodyMd: p.prompt, landing });
            onApplied?.();
          }
        : undefined,
      hover: hoverProps(p.id, p.prompt),
    })),
  ];

  const textEntries = entries.filter((e) => isTextKey(e.key));
  const sheetEntries = entries.filter((e) => isSheetKey(e.key));

  /** 커스텀 프리셋에만 붙는 우클릭 메뉴(이름변경/아이콘·색/제거) — manage 모드는 버튼이 대신한다. */
  const contextMenuFor = (e: Entry) =>
    e.custom && !manage
      ? (ev: React.MouseEvent) => {
          ev.preventDefault();
          setCtx({ preset: e.custom!, x: ev.clientX, y: ev.clientY });
        }
      : undefined;

  const styleTarget = styleCtx ? customPresets.find((p) => p.id === styleCtx.id) ?? null : null;
  const openStyle = (id: string, e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setStyleCtx({ id, x: r.left, y: r.bottom + 4 });
  };

  return {
    entries,
    textEntries,
    sheetEntries,
    hoverProps,
    contextMenuFor,
    applyDiagramType,
    showDiagramAiFill,
    aiFillPending,
    fillDiagramWithAi,
    hasHiddenBuiltins,
    restoreHiddenBuiltins,
    // 다이얼로그/팝오버 상태 — 컨텍스트 메뉴·이름변경·삭제·"만들기"·아이콘·색.
    ctx,
    setCtx,
    styleCtx,
    setStyleCtx,
    renameTarget,
    setRenameTarget,
    deleteTarget,
    setDeleteTarget,
    deleteBuiltinTarget,
    setDeleteBuiltinTarget,
    makeMenu,
    setMakeMenu,
    hasOpenNote,
    renamePreset,
    removePreset,
    hideBuiltin,
    setPresetStyle,
    styleTarget,
    openStyle,
    styleRef,
    styleX,
    styleY,
  };
}

export { isSheetKey, isDiagramKey, isTextKey };
