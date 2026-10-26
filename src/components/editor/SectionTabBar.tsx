import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { NoteDetail, Section } from "../../lib/commands.gen";
import { useUiStore, type PreviewItem } from "../../stores/ui";
import { renameSection } from "../../stores/notes";
import { useSettingsStore } from "../../stores/settings";
import { emitNotice, flushAll } from "../../lib/invoke";
import { isBrowser } from "../../lib/env";
import { ContextMenuShell } from "../common/ContextMenuShell";
import { FluidHoverHighlight, useFluidHover } from "../common/FluidHover";
import { t } from "../../i18n/t";
import { formatRelativeTime } from "../../lib/dateUtils";
import type { AskAiTarget } from "../AskAiModal";
import { AskAiModal } from "../../lazySurfaces";
import { preloadIntentProps } from "../../lib/lazyPreload";
import { PromptDialog } from "../PromptDialog";
import { IconClose, IconGraph, IconSheet, IconPlus, IconAi, IconEye, IconShare, IconExternalLink } from "../icons";
import { ensureAiAskGate, useAiGlow, useAiStore, AI_GLOW_KEYS } from "../../stores/ai";
import { getActiveSection, insertAiSection, getPendingAiInsertId, setPendingAiInsertId } from "../../lib/aiSectionBridge";
import { PresetList } from "../PresetList";
import { openExportModal } from "../../stores/exportModal";
import { startNoteDrag, noteDropTargetProps } from "../../lib/noteDrag";
import { InternalNotePicker } from "../attachments/InternalNotePicker";
import { exportSheetAsCsv } from "../../lib/sheet/exportCsv";
import { parseSheet } from "../../lib/sheet/types";
import { useSectionWindowsStore, startSectionWindowsSync, openSectionWindow } from "../../stores/sectionWindows";
import { beginLongPress, cancelLongPress, consumeLongPress } from "../../lib/longPress";

export interface SectionTabBarProps {
  activeNote: NoteDetail;
  activeSectionId: string | null;
  previewItem: PreviewItem | null;
  /** Parent CRUD that depends on editor/flushRef — pure callbacks. */
  onSwitchSection: (section: Section) => void | Promise<void>;
  onDeleteSection: (section: Section) => void | Promise<void>;
  onReorderSection: (section: Section, direction: -1 | 1) => void | Promise<void>;
  /** 우클릭 "다른 노트로 이동…" — 드래그 경로와 같은 useSectionActions::handleMoveSection 이다. */
  onMoveSection?: (section: Section, targetNoteId: string) => void | Promise<void>;
  /** askAiTarget lives in EditorPanel — open via this callback. */
  onAskAi: (target: AskAiTarget) => void;
  /**
   * True while tab rename / section context menu / note picker is open — parent uses this for
   * BubbleMenu hide + selection-context-menu suppression (same gate as the pre-extract inline state).
   */
  onUiBusyChange?: (busy: boolean) => void;
}

/** W5 섹션 provenance — 탭의 작은 AI 점(dot) 툴팁이 보여줄 액션 이름을 ai_origin 값에서
 *  구한다. BUILTIN_DEFS id(src/stores/aiPrompts.ts)는 전부 i18n/ai.json의
 *  "action_default_name_<id>" 관례를 그대로 따르므로(설정 화면이 이미 그렇게 쓴다) 그 규칙
 *  하나로 대부분을 커버한다. "translate"/"prompt"는 BUILTIN_DEFS에 없는 두 예외
 *  (lib/aiSectionBridge.ts::insertAiSection opts.aiOrigin 주석 참고) — 이미 있는 기존 키를
 *  재사용한다. 매칭되는 키가 없으면(커스텀 프리셋 등) origin 원문을 그대로 보여준다 — 깨진
 *  자리표시자 문자열보다 낫다. */
function aiOriginActionLabel(origin: string): string {
  if (origin === "translate") return t("ai.translate_section_name") || origin;
  if (origin === "prompt") return t("editor.ai_prompt_section_name") || origin;
  const key = `ai.action_default_name_${origin}`;
  const label = t(key);
  return label === key ? origin : label;
}

/** 탭 X 롱프레스 삭제 — 파괴적 동작이라 상수로 따로 둔다(2026-09-30 600→400ms, 오너). */
const DELETE_HOLD_MS = 400;

// "+" 새 섹션 메뉴를 클릭 지점에서 당기는 거리 — 첫 행 중앙이 커서 밑에 오도록(행 높이 ≈ 36px, 메뉴 패딩 ≈ 5px).
const ADD_MENU_OFFSET = { x: 20, y: 12 };

export function SectionTabBar({
  activeNote,
  activeSectionId,
  previewItem,
  onSwitchSection,
  onDeleteSection,
  onReorderSection,
  onMoveSection,
  onAskAi,
  onUiBusyChange,
}: SectionTabBarProps) {
  const setPreviewItem = useUiStore((s) => s.setPreviewItem);
  // 섹션 분리 창 — 분리는 이 탭 메뉴로만 시작되므로 여기서 동기화를 켠다(멱등, stores/sectionWindows.ts).
  useEffect(() => startSectionWindowsSync(), []);
  const detachedIds = useSectionWindowsStore((s) => s.ids);
  const canDetach = !isBrowser();
  // 활성 섹션이 방금 분리되면(드래그 아웃·메뉴·"창으로 이동" 어느 경로든) 인접 섹션으로 자동 전환한다 —
  // 안 그러면 본 창이 플레이스홀더만 보여 준다. "새로 분리된 순간"에만 발동: 이미 분리된 탭을 일부러
  // 눌러 플레이스홀더를 보는 경우(ids 불변)는 건드리지 않는다. 오른쪽 이웃 우선, 없으면 왼쪽, 분리 안 된 것만.
  const prevDetachedRef = useRef<string[]>(detachedIds);
  useEffect(() => {
    const prev = prevDetachedRef.current;
    prevDetachedRef.current = detachedIds;
    const active = activeNote.sections.find((s) => s.id === activeSectionId) ??
      activeNote.sections[activeNote.sections.length - 1];
    if (!active || !detachedIds.includes(active.id) || prev.includes(active.id)) return;
    const idx = activeNote.sections.findIndex((s) => s.id === active.id);
    const free = (s: Section) => !detachedIds.includes(s.id);
    const target = activeNote.sections.slice(idx + 1).find(free) ??
      activeNote.sections.slice(0, idx).reverse().find(free);
    if (target) void onSwitchSection(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detachedIds]);
  const aiEnabled = useSettingsStore((s) => s.aiEnabled);
  const uiLang = useSettingsStore((s) => s.uiLang);
  // 더보기 메뉴 "내용잠금"(TitleBar.tsx) — 켜져 있으면 섹션 추가/삭제를 막는다(본문 편집 금지는
  // EditorPanel.tsx가 별도로 담당). activeNote prop이 이미 NoteDetail(= note: NoteSummary 포함)을
  // 들고 오므로 별도 스토어 구독 없이 그대로 읽는다.
  const contentLocked = activeNote.note.content_locked ?? false;

  // Section-tab rename — local UI state only.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  // Guards against Enter+blur / Escape+blur double-fire — see startRename/commitRename/cancelRename.
  const renameInFlightRef = useRef(false);
  const skipNextBlurRef = useRef(false);

  /** "다른 노트로 이동…" 이 연 노트 선택기의 대상 섹션. */
  const [movingSection, setMovingSection] = useState<Section | null>(null);
  const [hoverTabId, setHoverTabId] = useState<string | null>(null);

  const [sectionCtx, setSectionCtx] = useState<{ section: Section; x: number; y: number } | null>(null);
  // "+" new-section picker — text / diagram / (optional) AI-generated section.
  const [addSectionMenu, setAddSectionMenu] = useState<{ x: number; y: number } | null>(null);
  // PromptDialog for "+" → "AI로 새 섹션 만들기" — bypasses runAiAction's non-empty body guard by
  // calling generateFromPrompt(prompt, null) directly (Wave 3B).
  const [aiNewSectionPrompt, setAiNewSectionPrompt] = useState(false);
  // 섹션 삭제 확인(오너 2026-09-24: 데이터가 사라지는 동작이라 한 번 묻는다 — PLAN-2026-09-10 D7
  // "확인 없음"을 뒤집음). 탭 X·키보드 Delete·우클릭 세 경로가 모두 여기로 모인다. 되돌리기 토스트는
  // 삭제 성공 뒤 useSectionActions.ts::handleDeleteSection 이 띄운다.
  const [pendingDelete, setPendingDelete] = useState<Section | null>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  // 유동 hover — 섹션 탭 스트립. tabsRef 가 스크롤 컨테이너이자 항목의 직계 부모라 그대로
  // fh-host 로 쓴다(TabBar.tsx 와 같은 구조).
  const hover = useFluidHover(tabsRef, { axis: "x", itemSelector: "[data-fh-item]" });

  // 새 섹션 메뉴가 만든 섹션 → 탭이 곧바로 이름 입력 상태. 섹션이 activeNote 에 붙은 뒤에야 잡히므로
  // sections 를 의존성에 둔다. ponytail: 80ms 지연은 섹션 전환 직후 에디터 포커스 이동(blur→커밋)을
  // 피하려는 경험적 값 — 실기에서 어긋나면 전환 완료 신호로 바꾼다.
  const renameSectionId = useUiStore((s) => s.renameSectionId);
  useEffect(() => {
    if (!renameSectionId) return;
    const sec = activeNote.sections.find((s) => s.id === renameSectionId);
    if (!sec) return;
    useUiStore.setState({ renameSectionId: null });
    const timer = setTimeout(() => startRename(sec), 80);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renameSectionId, activeNote.sections]);

  const uiBusy = !!(renamingId || sectionCtx || movingSection);
  useLayoutEffect(() => {
    onUiBusyChange?.(uiBusy);
    return () => onUiBusyChange?.(false);
  }, [uiBusy, onUiBusyChange]);

  const startRename = (s: Section) => {
    setRenameDraft(s.name);
    setRenamingId(s.id);
  };

  const cancelRename = () => {
    skipNextBlurRef.current = true;
    setRenamingId(null);
  };

  const commitRename = async (s: Section) => {
    if (renameInFlightRef.current) return;
    renameInFlightRef.current = true;
    setRenamingId(null);
    try {
      await renameSection(s.id, s.name, renameDraft); // 규칙·IPC·스토어 갱신은 stores/notes.ts 한 곳
    } finally {
      renameInFlightRef.current = false;
    }
  };

  // Match EditorPanel's resolveActiveSection fallback (last section when id is stale/null).
  const activeSection =
    activeNote.sections.find((sec) => sec.id === activeSectionId) ??
    activeNote.sections[activeNote.sections.length - 1];

  // sectionCtx "AI에게 묻기" — same gate-before-open discipline as ContextMenu/TabBar.
  // diagramMounted compares against resolved activeSection, not raw activeSectionId.
  const openSectionAskAi = () => {
    if (!sectionCtx) return;
    const s = sectionCtx.section;
    const isDiagram = s.kind === "diagram";
    const isSheet = s.kind === "sheet";
    const isMountedSection = s.id === activeSection?.id;
    setSectionCtx(null);
    void (async () => {
      if (!(await ensureAiAskGate())) return;
      // activeNote.sections body can be stale for the mounted text section — flush + live read.
      let body = s.body_md;
      if (isMountedSection && !isDiagram && !isSheet) {
        await flushAll();
        body = getActiveSection()?.body_md ?? body;
      }
      onAskAi({
        kind: "section",
        sectionId: s.id,
        sectionName: s.name,
        sectionBody: body,
        isDiagram,
        diagramMounted: isDiagram && isMountedSection,
        isSheet,
        sheetMounted: isSheet && isMountedSection,
      });
    })();
  };


  // 섹션 탭 우클릭 "내보내기…" — kind로 갈린다. diagram은 이 메뉴에 없다(PNG 내보내기는 캔버스가
  // 마운트돼 있어야 해서 다이어그램 툴바에 그대로 남는다 — DiagramToolbar.tsx). sheet는
  // SheetSection.tsx의 툴바 버튼과 같은 exportSheetAsCsv(lib/sheet/exportCsv.ts)를 공유한다 —
  // 로직을 복제하지 않는다. text 는 내보내기 모달(components/export/ExportModal).
  const runExportSection = async (s: Section) => {
    if (s.kind === "sheet") {
      const doc = parseSheet(s.body_md);
      if (!doc) {
        emitNotice(t("editor.sheet_export_failed"));
        return;
      }
      await exportSheetAsCsv(doc, `${s.name || "sheet"}.csv`);
      return;
    }
    // 텍스트 섹션 — 노트 우클릭 "내보내기"와 같은 내보내기 모달을 "이 섹션" 범위로 연다.
    openExportModal({ noteId: activeNote.note.id, noteTitle: activeNote.note.title, sectionId: s.id });
  };

  // "+" menu "AI로 새 섹션 만들기" — gate at click (before PromptDialog), same as openSectionAskAi.
  const openAiNewSection = () => {
    setAddSectionMenu(null);
    void (async () => {
      if (!(await ensureAiAskGate())) return;
      setAiNewSectionPrompt(true);
    })();
  };

  // Free-form prompt → new section. No existing section body is required (context is null);
  // generateFromPrompt owns the editor glow (AI_GLOW_KEYS.editor) for the request lifetime.
  const runAiNewSection = async (promptText: string) => {
    const targetNoteId = activeNote.note.id;
    if (!targetNoteId) {
      emitNotice(t("editor.note_required_for_section"));
      return;
    }
    const generated = await useAiStore.getState().generateFromPrompt(promptText, null);
    if (generated == null) return;
    if (!generated.trim()) {
      emitNotice(t("editor.ai_empty_result"));
      return;
    }
    await insertAiSection(t("editor.ai_prompt_section_name"), generated, targetNoteId, undefined, {
      aiOrigin: "prompt",
    });
  };

  const tabStyle = (on: boolean): React.CSSProperties => ({
    // W24: 상하 패딩 제거 + flex 세로 중앙 — 예전 상하 --space-4(10px) 패딩이 행 콘텐츠를
    // --row-tabs(36px)보다 크게 만들어 행이 minHeight를 넘겨 자랐고, 어시스트 헤더(고정 36px)의
    // 하단선과 어긋났다. 행 높이의 단일 소스는 컨테이너의 height: var(--row-tabs)다.
    display: "flex",
    alignItems: "center",
    padding: "0 var(--space-6)",
    fontSize: "var(--text-md)",
    fontWeight: 600,
    whiteSpace: "nowrap",
    cursor: "pointer",
    borderRight: "1px solid var(--divider)",
    color: on ? "var(--accent)" : "var(--muted)",
    // Selected section tab: accent tint + bottom bar only.
    background: on ? "var(--sel)" : "transparent",
    boxShadow: on ? "inset 0 -2px 0 var(--accent)" : undefined,
  });

  return (
    <>
      <div
        ref={tabsRef}
        className="scroll noscroll fh-host"
        data-testid="section-tabs"
        role="tablist"
        style={{
          display: "flex",
          // stretch (not center): every tab/button fills the row's height exactly, so the active
          // tab's `inset 0 -2px` accent underline always sits on this row's own bottom border —
          // regardless of section count or --fs (was: shorter 1-section tab left a hairline gap).
          alignItems: "stretch",
          overflowX: "auto",
          borderBottom: "1px solid var(--divider)",
          flex: "none",
          // W24: minHeight → height 고정 — 탭 상하 패딩(구 --space-4)이 이 행을 36px 너머로
          // 키워 어시스트 헤더 하단선과 어긋나던 것의 구조적 수정. 행 높이는 이 토큰이 유일한
          // 소스이고, 탭·버튼은 stretch로 정확히 이 높이를 채운다(세로 정렬은 각 탭의 flex).
          height: "var(--row-tabs)",
        }}
        {...hover.handlers}
      >
        <FluidHoverHighlight hover={hover} />
        {activeNote.sections.map((s, idx) => {
          const isActive = s.id === activeSection?.id;
          const isDetached = detachedIds.includes(s.id);
          const canDelete = activeNote.sections.length > 1;
          if (renamingId === s.id) {
            return (
              <input
                key={s.id}
                autoFocus
                value={renameDraft}
                onChange={(e) => setRenameDraft(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
                onFocus={(e) => e.currentTarget.select()}
                onBlur={() => {
                  if (skipNextBlurRef.current) {
                    skipNextBlurRef.current = false;
                    return;
                  }
                  void commitRename(s);
                }}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void commitRename(s);
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    cancelRename();
                  }
                }}
                style={{
                  ...tabStyle(isActive),
                  border: "none",
                  outline: "1px solid var(--accent)",
                  outlineOffset: -1,
                  background: "transparent",
                  font: "inherit",
                  minWidth: 80,
                  width: `${Math.max(6, renameDraft.length + 1)}ch`,
                }}
              />
            );
          }
          return (
            <SectionTabItem
              key={s.id}
              sectionId={s.id}
              role="tab"
              tabIndex={isActive ? 0 : -1}
              aria-selected={isActive}
              title={t("editor.rename_section_hint")}
              // 드래그는 포인터 이벤트다(lib/noteDrag.ts) — HTML5 DnD 는 tauri 창의
              // dragDropEnabled 기본값 때문에 웹뷰까지 dragover/drop 이 오지 않아 앱에서 죽는다.
              // 4px 임계를 넘겨야 드래그가 시작되므로 클릭(전환)·더블클릭(개명)·우클릭은 그대로다.
              // 창 밖(또는 가장자리)에 잠시 머문 뒤 놓으면 그 자리에 새 창으로 분리(2단계).
              onPointerDown={(e) => startNoteDrag(e, activeNote.note.id, s.name, {
                section: { id: s.id, noteId: activeNote.note.id },
                outsideLabel: t("sectionWindow.drop_to_open"),
                // 브라우저(동기화 웹)엔 OS 창이 없다 — section_window_open 은 http:false 라 항상 실패한다.
                onOutsideDrop: canDetach
                  ? (x, y) => void openSectionWindow(activeNote.note.id, s, activeNote.note.title, { x, y })
                  : undefined,
              })}
              onClick={() => void onSwitchSection(s)}
              onDoubleClick={() => startRename(s)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  void onSwitchSection(s);
                } else if (e.key === "F2") {
                  e.preventDefault();
                  startRename(s);
                } else if (e.key === "Delete" && activeNote.sections.length > 1 && !contentLocked) {
                  // Keyboard path for delete (X is hover-only) — 마우스 경로와 같은 함수를 탄다.
                  e.preventDefault();
                  setPendingDelete(s);
                } else if ((e.ctrlKey || e.metaKey) && e.key === "ArrowLeft") {
                  // Keyboard reorder so drag is not the only path (replaces former ◀/▶ buttons).
                  e.preventDefault();
                  if (idx > 0) void onReorderSection(s, -1);
                } else if ((e.ctrlKey || e.metaKey) && e.key === "ArrowRight") {
                  e.preventDefault();
                  if (idx < activeNote.sections.length - 1) void onReorderSection(s, 1);
                } else if (!(e.ctrlKey || e.metaKey) && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) {
                  e.preventDefault();
                  const tabs = Array.from(tabsRef.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? []);
                  const nextIndex = e.key === "Home"
                    ? 0
                    : e.key === "End"
                      ? tabs.length - 1
                      : (idx + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
                  tabs[nextIndex]?.focus();
                  const target = activeNote.sections[nextIndex];
                  if (target) void onSwitchSection(target);
                }
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setSectionCtx({ section: s, x: e.clientX, y: e.clientY });
              }}
              onMouseEnter={() => setHoverTabId(s.id)}
              onMouseLeave={() => setHoverTabId((cur) => (cur === s.id ? null : cur))}
              data-detached={isDetached || undefined}
              style={{
                ...tabStyle(isActive),
                // 분리된 탭 — 선택 틴트(--sel)보다 한 단 옅은 --hover 틴트. 선택돼 있으면 선택이 이긴다.
                ...(isDetached && !isActive ? { background: "var(--hover)" } : null),
                display: "flex",
                alignItems: "center",
                gap: "var(--space-3)",
              }}
            >
              {s.kind === "diagram" && (
                <IconGraph size={12} strokeWidth={2} style={{ flex: "none", opacity: 0.75 }} />
              )}
              {s.kind === "sheet" && (
                <IconSheet size={12} strokeWidth={2} style={{ flex: "none", opacity: 0.75 }} />
              )}
              {s.name}
              {isDetached && (
                <span
                  data-testid="section-detached-icon"
                  title={t("sectionWindow.detached_badge")}
                  style={{ display: "inline-flex", flex: "none", opacity: 0.75 }}
                >
                  <IconExternalLink size={11} strokeWidth={2} />
                </span>
              )}
              {!!s.ai_origin && (
                <span
                  data-testid="section-ai-origin-dot"
                  title={t("editor.ai_origin_tooltip", {
                    action: aiOriginActionLabel(s.ai_origin),
                    date: formatRelativeTime(s.updated_at ?? "", uiLang),
                  })}
                  style={{ display: "inline-flex", flex: "none", opacity: 0.75 }}
                >
                  <IconAi size={9} strokeWidth={2} />
                </span>
              )}
              {previewItem?.kind === "section" && previewItem.sectionId === s.id && (
                <span
                  data-testid="section-preview-dot"
                  title={t("editor.section_previewing")}
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    backgroundColor: "var(--accent)",
                    flex: "none",
                  }}
                />
              )}
              {/* Last remaining section cannot be deleted. Slot always reserved so width doesn't jump.
                  content_locked이면 존재는 하되(호버 시 보임) 비활성 + 이유 툴팁 — TitleBar.tsx의
                  데스크톱 전용 가져오기 버튼과 같은 disabled+opacity+title 조합. */}
              {canDelete && (
                <span
                  role="button"
                  tabIndex={-1}
                  aria-disabled={contentLocked || undefined}
                  aria-label={t("editor.delete_section")}
                  title={contentLocked ? t("editor.content_locked_tooltip") : t("editor.delete_section_hold")}
                  // 실수로 X 를 누르는 일이 잦아(오너 2026-09-30) 짧은 클릭은 안내만 하고, 길게 눌러야
                  // 확인 모달이 뜬다. 포인터다운을 여기서 끊어 X 에서 탭 드래그가 시작되지도 않게 한다.
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    if (contentLocked || e.button !== 0) return;
                    beginLongPress(() => setPendingDelete(s), DELETE_HOLD_MS);
                  }}
                  onPointerUp={cancelLongPress}
                  onPointerLeave={cancelLongPress}
                  onPointerCancel={cancelLongPress}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (contentLocked) return;
                    if (consumeLongPress()) return; // 길게 눌러 모달이 이미 떴다 — 뒤따르는 click 은 삼킨다
                    emitNotice(t("editor.delete_section_hold_hint"));
                  }}
                  style={{
                    display: "grid",
                    placeItems: "center",
                    width: 16,
                    height: 16,
                    flex: "none",
                    borderRadius: "var(--radius-sm)",
                    color: "var(--muted)",
                    opacity: contentLocked ? "var(--dim-disabled)" : 1,
                    cursor: contentLocked ? "default" : "pointer",
                    visibility: hoverTabId === s.id || isActive ? "visible" : "hidden",
                  }}
                >
                  <IconClose size={12} />
                </span>
              )}
            </SectionTabItem>
          );
        })}
        <button
          type="button"
          className="section-add-btn"
          // 스트립 안에 있으니 하이라이트의 목적지이기도 하다 — 빼두면 "+" 위에서 엉뚱한 탭에
          // 불이 들어온다. 그래서 아래 hover 규칙은 배경을 칠하지 않는다(하이라이트가 그 일을 한다).
          data-fh-item="true"
          disabled={contentLocked}
          onClick={(e) => {
            if (contentLocked) return;
            // 메뉴를 클릭 지점 쪽으로 끌어당겨 첫 행이 커서 밑에 오게 — 마우스를 옮기지 않고 바로 클릭/Enter.
            setAddSectionMenu({ x: e.clientX - ADD_MENU_OFFSET.x, y: e.clientY - ADD_MENU_OFFSET.y });
          }}
          title={contentLocked ? t("editor.content_locked_tooltip") : t("editor.new_section")}
          aria-label={t("editor.new_section")}
          style={{
            display: "grid",
            placeItems: "center",
            width: 34,
            // No fixed height — stretches to the row's height (alignItems:"stretch" above) so it
            // never fights --row-tabs at any --fs.
            flex: "none",
            cursor: contentLocked ? "default" : "pointer",
            opacity: contentLocked ? "var(--dim-disabled)" : 1,
            background: "transparent",
            border: 0,
            padding: 0,
          }}
        >
          <IconPlus size={14} strokeWidth={2.2} />
        </button>
      </div>

      <ContextMenuShell
        anchor={addSectionMenu}
        onClose={() => setAddSectionMenu(null)}
        minWidth={140}
        autoFocusFirst
      >
        {/* 종류 4행이 동등하게 선다(오너 2026-08-19): 빈 노트 · 관계도 · 가계부 · AI로 생성.
            앞 셋은 variant="menu" 프리셋 목록(종류만 그린다), AI 행은 같은 menu-row 로 그 뒤에.
            구분선·안내 줄 없음 — 위계를 나눌 이유가 없다. */}
        <PresetList variant="menu" onApplied={() => setAddSectionMenu(null)} />
        {aiEnabled && (
          // 위 세 행(PresetList 목록의 gap)과 같은 행 간격 — 패딩이라 버튼의 1px 마진과 겹치지 않는다.
          <div style={{ paddingTop: "var(--space-1)" }}>
          <button
            type="button"
            data-testid="add-section-ai"
            className="menu-row menu-item"
            onClick={openAiNewSection}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--space-3)",
              color: "inherit",
            }}
          >
            <IconAi size={15} strokeWidth={1.8} style={{ color: "var(--accent)", flex: "none" }} />
            <span>{t("editor.new_section_ai_row")}</span>
          </button>
          </div>
        )}
      </ContextMenuShell>

      {pendingDelete && (
        <PromptDialog
          title={t("editor.section_delete_confirm_title")}
          description={t("editor.section_delete_confirm_description", {
            name: pendingDelete.name || t("editor.new_section"),
          })}
          mode="confirm"
          danger
          confirmLabel={t("editor.section_delete_confirm_action")}
          onCancel={() => setPendingDelete(null)}
          onSubmit={() => {
            const s = pendingDelete;
            setPendingDelete(null);
            void onDeleteSection(s);
          }}
        />
      )}

      {aiNewSectionPrompt && (
        <PromptDialog
          title={t("editor.new_section_ai")}
          description={t("editor.new_section_ai_desc")}
          mode="input"
          placeholder={t("editor.ai_prompt_placeholder")}
          confirmLabel={t("editor.ai_prompt_submit")}
          onCancel={() => setAiNewSectionPrompt(false)}
          onSubmit={(value) => {
            const promptText = (typeof value === "string" ? value : "").trim();
            setAiNewSectionPrompt(false);
            if (!promptText) return;
            void runAiNewSection(promptText);
          }}
        />
      )}

      {movingSection && (
        <InternalNotePicker
          excludeNoteId={activeNote.note.id}
          onPick={(noteId) => {
            const s = movingSection;
            setMovingSection(null);
            void onMoveSection?.(s, noteId);
          }}
          onCancel={() => setMovingSection(null)}
        />
      )}

      <ContextMenuShell
        anchor={sectionCtx}
        onClose={() => setSectionCtx(null)}
        minWidth={160}
      >
        <button
          type="button"
          className="menu-row menu-item"
          onClick={() => {
            if (!sectionCtx) return;
            const s = sectionCtx.section;
            setSectionCtx(null);
            startRename(s);
          }}
          style={{ color: "inherit" }}
        >
          <span>{t("ctx.rename")}</span>
        </button>
        {sectionCtx?.section.kind !== "diagram" && (
          <button
            type="button"
            className="menu-row menu-item"
            onClick={() => {
              if (!sectionCtx) return;
              const s = sectionCtx.section;
              setSectionCtx(null);
              void runExportSection(s);
            }}
            style={{ color: "inherit" }}
          >
            <IconShare size={15} strokeWidth={1.8} />
            <span>{t("ctx.export_section")}</span>
          </button>
        )}
        {canDetach && (
          <button
            type="button"
            data-testid="section-ctx-open-window"
            className="menu-row menu-item"
            onClick={() => {
              if (!sectionCtx) return;
              const s = sectionCtx.section;
              setSectionCtx(null);
              void openSectionWindow(activeNote.note.id, s, activeNote.note.title);
            }}
            style={{ color: "inherit" }}
          >
            <IconExternalLink size={15} strokeWidth={1.8} />
            <span>{t("sectionWindow.open_in_window")}</span>
          </button>
        )}
        <button
          type="button"
          data-testid="section-ctx-move"
          className="menu-row menu-item"
          onClick={() => {
            if (!sectionCtx) return;
            const s = sectionCtx.section;
            setSectionCtx(null);
            setMovingSection(s);
          }}
          style={{ color: "inherit" }}
        >
          <span>{t("ctx.move_section_to_note")}</span>
        </button>
        {(() => {
          const isPreviewing =
            sectionCtx &&
            previewItem?.kind === "section" &&
            previewItem.sectionId === sectionCtx.section.id;
          return (
            <button
              type="button"
              data-testid="section-ctx-preview-toggle"
              className="menu-row menu-item"
              onClick={() => {
                if (!sectionCtx) return;
                const s = sectionCtx.section;
                setSectionCtx(null);
                if (isPreviewing) {
                  setPreviewItem(null);
                } else {
                  setPreviewItem({ kind: "section", noteId: activeNote.note.id, sectionId: s.id });
                }
              }}
              style={{ color: "inherit" }}
            >
              <IconEye size={15} strokeWidth={1.8} />
              <span>{isPreviewing ? t("ctx.unpreview_section") : t("ctx.preview_section")}</span>
            </button>
          );
        })()}
        {aiEnabled && (
          <button
            type="button"
            className="menu-row menu-item"
            onClick={openSectionAskAi}
            // 이 행은 EditorPanel 이 렌더하는 지연 AskAiModal 을 연다.
            {...preloadIntentProps(AskAiModal)}
            style={{ color: "inherit" }}
          >
            <IconAi size={15} strokeWidth={1.8} />
            <span>{t("ai.ask_ai")}</span>
          </button>
        )}
        {activeNote.sections.length > 1 && (
          <button
            type="button"
            data-testid="section-ctx-trash"
            className="menu-row menu-item"
            disabled={contentLocked}
            title={contentLocked ? t("editor.content_locked_tooltip") : undefined}
            onClick={() => {
              if (!sectionCtx) return;
              const s = sectionCtx.section;
              setSectionCtx(null);
              // 확인 대화상자(pendingDelete)를 거친다. 실제 잠금 강제는
              // useSectionActions.ts::handleDeleteSection 한 곳(chokepoint)에서.
              setPendingDelete(s);
            }}
            style={{ color: "inherit", opacity: contentLocked ? "var(--dim-disabled)" : 1 }}
          >
            <span>{t("ctx.trash_section")}</span>
          </button>
        )}
      </ContextMenuShell>
    </>
  );
}

function SectionTabItem({
  sectionId,
  children,
  style,
  ...rest
}: {
  sectionId: string;
  children: React.ReactNode;
  style: React.CSSProperties;
} & React.HTMLAttributes<HTMLDivElement>) {
  const isSectionGlow = useAiGlow(AI_GLOW_KEYS.section(sectionId));
  const isDiagramGlow = useAiGlow(AI_GLOW_KEYS.diagram(sectionId));
  const [isArriving, setIsArriving] = useState(() => {
    if (getPendingAiInsertId() === sectionId) {
      setPendingAiInsertId(null);
      return true;
    }
    return false;
  });

  useLayoutEffect(() => {
    if (isArriving) {
      const timer = setTimeout(() => setIsArriving(false), 950);
      return () => clearTimeout(timer);
    }
  }, [isArriving]);

  // Prefer active over fading when either target is lit.
  const isGlow =
    isSectionGlow === "active" || isDiagramGlow === "active"
      ? "active"
      : isSectionGlow || isDiagramGlow || undefined;
  return (
    <div
      data-fh-item="true"
      // 드롭 대상 — 하이라이트(.note-drop-over)는 noteDrag 가 이 요소에 직접 건다. 유동 hover 의
      // data-fh-item 과 같은 요소에 공존한다.
      {...noteDropTargetProps(`section:${sectionId}`)}
      data-ai-glow={isGlow}
      data-ai-glow-inset="true"
      data-ai-arriving={isArriving ? "true" : undefined}
      style={{ ...style, position: "relative" }}
      {...rest}
    >
      {children}
    </div>
  );
}
