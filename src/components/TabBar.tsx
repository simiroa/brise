import { useEffect, useMemo, useRef, useState, Suspense } from "react";
import { useShallow } from "zustand/react/shallow";
import { useNotesStore, displayTitle } from "../stores/notes";
import { useSettingsStore } from "../stores/settings";
import { HOME_TAB_ID, isHomeTab, isNoteTabId, useTabsStore } from "../stores/tabs";
import { usePresetsStore } from "../stores/presets";
import { IconClose, IconHome, IconPlus, IconAi } from "./icons";
import { NoteIcon } from "./leftpanel/NoteIconControl";
import type { NoteDetail } from "../lib/commands.gen";
import { ContextMenuShell } from "./common/ContextMenuShell";
import { FluidHoverHighlight, useFluidHover } from "./common/FluidHover";
import { call, flushAll } from "../lib/invoke";
import { t } from "../i18n/t";
import { ensureAiAskGate, useAiGlow, AI_GLOW_KEYS } from "../stores/ai";
import type { AskAiTarget } from "./AskAiModal";
import { followPreviewToNote } from "./attachments/useRelatedClickPreview";
import { AskAiModal, EditorPanel } from "../lazySurfaces";
import { preloadIntentProps } from "../lib/lazyPreload";

// 노트 탭·새 노트 버튼 = 에디터를 여는 의도 — 대시보드에서 처음 노트로 갈 때 대기 화면을 피한다.
const editorIntent = preloadIntentProps(EditorPanel);

function activateHome() {
  useNotesStore.getState().discardDraft();
  useNotesStore.setState({ activeNote: null, activeDraft: false });
  void useTabsStore.getState().setActiveTab(HOME_TAB_ID);
}

export function TabBar() {
  const openTabs = useTabsStore((s) => s.openTabs);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const closeTab = useTabsStore((s) => s.closeTab);
  const closeAllTabs = useTabsStore((s) => s.closeAllTabs);
  const closeOtherTabs = useTabsStore((s) => s.closeOtherTabs);
  const setActiveTab = useTabsStore((s) => s.setActiveTab);
  const recentClosedTabs = useTabsStore((s) => s.recentClosedTabs);
  const reopenClosedTab = useTabsStore((s) => s.reopenClosedTab);
  const noteIndex = useNotesStore((s) => s.noteIndex);
  const activeNoteMeta = useNotesStore(
    useShallow((s) =>
      s.activeNote
        ? {
            id: s.activeNote.note.id,
            title: s.activeNote.note.title,
            icon: s.activeNote.note.icon,
          }
        : null
    )
  );
  const selectNote = useNotesStore((s) => s.selectNote);
  const newNote = useNotesStore((s) => s.newNote);
  const ensureNoteSummaries = useNotesStore((s) => s.ensureNoteSummaries);
  const aiEnabled = useSettingsStore((s) => s.aiEnabled);

  const [tabCtx, setTabCtx] = useState<{ id: string; x: number; y: number } | null>(null);
  const [askAiTarget, setAskAiTarget] = useState<AskAiTarget | null>(null);

  // 유동 hover — 가로 탭 스트립. 스트립 자체가 스크롤 컨테이너이자 항목의 직계 부모라
  // fh-host 를 여기 바로 단다(별도 내부 래퍼 없음 → 스크롤 중에도 하이라이트가 따라온다).
  const stripRef = useRef<HTMLDivElement>(null);
  const hover = useFluidHover(stripRef, { axis: "x", itemSelector: "[data-fh-item]" });

  const handleCloseAll = () => {
    closeAllTabs();
    // After close-all, active is home — clear editor (no note selected).
    useNotesStore.getState().discardDraft();
    useNotesStore.setState({ activeNote: null, activeDraft: false });
    setTabCtx(null);
  };

  const handleCloseOthers = (keepId: string) => {
    closeOtherTabs(keepId);
    if (isHomeTab(keepId)) {
      activateHome();
    } else {
      followPreviewToNote(keepId);
      void selectNote(keepId);
    }
    setTabCtx(null);
  };

  // 프리셋으로 저장 — 우클릭된 탭(활성 탭이 아닐 수도 있다)의 제목+첫 섹션 본문을 그대로
  // 프리셋으로 등록한다. NotePreview.tsx와 같은 관례로 note_get의 첫 섹션만 쓴다(멀티섹션
  // 프리셋은 범위 밖). flushAll 먼저: 지금 편집 중인 탭이면 700ms 디바운스에 걸려 아직
  // 백엔드에 안 간 최신 편집분을 놓치지 않는다.
  const saveAsPreset = usePresetsStore((s) => s.saveFromNote);
  const handleSaveAsPreset = async (id: string) => {
    await flushAll();
    try {
      const detail = await call<NoteDetail>("note_get", { id });
      await saveAsPreset(detail.note.title, detail.sections[0]?.body_md ?? "");
    } catch {
      /* call() 이 이미 토스트를 띄웠다 */
    }
  };

  // Scale quick-win (docs/SCALABILITY.md §Phase 0): only look up the notes that are actually
  // open as tabs (openTabs is small and bounded by user behavior), via the O(1) noteIndex —
  // never rebuild a whole-corpus Map. Subscribing only to activeNoteMeta (id, title, icon)
  // avoids re-running on body/attachment edits.
  const titleById = useMemo(() => {
    const map = new Map<string, string>();
    for (const id of openTabs) {
      const found = noteIndex.get(id);
      if (found) map.set(id, displayTitle(found.title));
    }
    if (activeNoteMeta) {
      map.set(activeNoteMeta.id, displayTitle(activeNoteMeta.title));
    }
    return map;
  }, [openTabs, noteIndex, activeNoteMeta]);

  // 탭 앞 점(활성/비활성 표시만 하던 자리) → 노트 아이콘. titleById 와 같은 소스(noteIndex/
  // activeNoteMeta)에서 icon 만 따로 뽑는다 — icon 없는 노트는 NoteIcon 컴포넌트 자체가 IconNote로
  // 폴백해준다(NoteIconControl.tsx).
  const iconById = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const id of openTabs) {
      const found = noteIndex.get(id);
      if (found) map.set(id, found.icon);
    }
    if (activeNoteMeta) map.set(activeNoteMeta.id, activeNoteMeta.icon);
    return map;
  }, [openTabs, noteIndex, activeNoteMeta]);

  // "AI에게 묻기" — same gate-before-open discipline as ContextMenu.tsx's note row (see
  // AskAiModal.tsx header): check happens here, not inside the modal, so the user never types a
  // prompt into a box that will silently no-op on submit.
  const openAskAi = (id: string) => {
    const target: AskAiTarget = { kind: "note", noteId: id, noteTitle: titleById.get(id) ?? t("note.untitled_note") };
    setTabCtx(null);
    void (async () => {
      if (!(await ensureAiAskGate())) return;
      setAskAiTarget(target);
    })();
  };

  // Bug fix: self-heal (dashboard board/calendar/timeline/map, search, note:// links open a
  // note by id only — selectNote() fetches the detail but the tab-bar title relies on
  // noteIndex, which only loadTree()'s tree window populates). Once a tab isn't activeNote
  // anymore, a titleById miss falls through to "Untitled note" at render. Batch-resolve
  // whatever's missing via the existing ensureNoteSummaries (same pattern App.tsx uses for
  // boot-restored tabs) — also self-heals after loadTree() wholesale-replaces noteIndex.
  const missingKey = useMemo(
    () => openTabs.filter((id) => !titleById.has(id)).join(","),
    [openTabs, titleById]
  );
  const inFlightRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!missingKey) return;
    const missing = missingKey.split(",").filter((id) => !inFlightRef.current.has(id));
    if (missing.length === 0) return;
    for (const id of missing) inFlightRef.current.add(id);
    void ensureNoteSummaries(missing).finally(() => {
      for (const id of missing) inFlightRef.current.delete(id);
    });
  }, [missingKey, ensureNoteSummaries]);

  const homeOn = isHomeTab(activeTabId);

  const tabStyle = (on: boolean) =>
    ({
      display: "flex",
      alignItems: "center",
      gap: "var(--space-4)",
      // W24 위생: 상하 11px 하드코딩 제거 — 행 높이는 컨테이너의 height: 40 이 단일 소스
      // (SectionTabBar 와 같은 구조, W24 섹션 탭 수정 참고), 탭은 stretch+flex 로 세로 중앙.
      padding: "0 var(--space-6)",
      cursor: "pointer",
      borderRight: "1px solid var(--divider)",
      whiteSpace: "nowrap",
      position: "relative",
      // 단일 표면 위에서 "선택된 탭"만 유일하게 배경으로 드러난다 (accent 틴트 + 하단 바).
      background: on ? "var(--sel)" : "transparent",
      boxShadow: on ? "inset 0 -2px 0 var(--accent)" : undefined,
      color: on ? undefined : "var(--muted)",
    }) as const;

  return (
    <div
      // in-flow 크롬(SINGLE-SHEET ACRYLIC CONTRACT) — 배경을 칠하지 않아 `.app` 의 시트가 그대로
      // 비친다(크롬 통일).
      style={{
        display: "flex",
        alignItems: "stretch",
        // Bug fix: height was implicit (driven by tab padding), so the row shrank when openTabs
        // was empty (only the icon-sized tab-new-btn left to size against).
        // W24: minHeight → height 고정 — 탭 상하 패딩을 걷어내 행 높이의 단일 소스를 이 값으로
        // (SectionTabBar 의 --row-tabs 고정과 같은 구조). 0개/N개 탭 모두 같은 높이.
        height: "var(--row-doctabs)",
        borderBottom: "1px solid var(--divider)",
        // 전폭 정렬(2026-07-23): 타이틀/본문과 같은 전폭으로 — App.tsx 타이틀바 주석 참고.
      }}
    >
      <div
        ref={stripRef}
        className="scroll noscroll fh-host"
        style={{ display: "flex", overflowX: "auto", flex: 1, minWidth: 0 }}
        {...hover.handlers}
      >
        <FluidHoverHighlight hover={hover} />
        {/* Fixed dashboard tab (= home internal id / HOME_TAB_ID). Always first, never closeable,
            never in openTabs. Icon-only: lucide Home glyph; accessible name is i18n tabs.home
            → 대시보드 / Dashboard / Tableau de bord. */}
        <div
          data-tab="home"
          data-fh-item="true"
          role="button"
          aria-label={t("tabs.home")}
          onClick={() => activateHome()}
          style={tabStyle(homeOn)}
          title={t("tabs.home")}
        >
          <IconHome
            size={16}
            strokeWidth={2}
            aria-hidden="true"
            style={{ color: homeOn ? "var(--accent)" : undefined }}
          />
          {homeOn && (
            <div
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                bottom: -2,
                height: 2,
                background: "var(--accent)",
              }}
            />
          )}
        </div>

        {openTabs.map((id) => {
          const on = id === activeTabId;
          const title = titleById.get(id) ?? t("note.untitled_note");
          const icon = iconById.get(id) ?? null;
          return (
            <TabRow
              key={id}
              id={id}
              on={on}
              title={title}
              icon={icon}
              tabStyle={tabStyle(on)}
              onClick={() => {
                void setActiveTab(id);
                followPreviewToNote(id);
                void selectNote(id);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setTabCtx({ id, x: e.clientX, y: e.clientY });
              }}
              onClose={(e) => {
                e.stopPropagation();
                const wasActive = id === activeTabId;
                closeTab(id);
                if (wasActive) {
                  const next = useTabsStore.getState().activeTabId;
                  if (isNoteTabId(next)) {
                    followPreviewToNote(next);
                    void selectNote(next);
                  } else {
                    useNotesStore.getState().discardDraft();
                    useNotesStore.setState({ activeNote: null, activeDraft: false });
                  }
                }
              }}
            />
          );
        })}
      </div>
      <button
        type="button"
        className="tab-new-btn"
        {...editorIntent}
        onClick={() => newNote().catch(console.error)}
        title={t("note.new_note")}
      >
        <IconPlus size={16} strokeWidth={2.2} />
      </button>

      <ContextMenuShell
        anchor={tabCtx}
        onClose={() => setTabCtx(null)}
        minWidth={160}
      >
        <button
          type="button"
          className="menu-row menu-item"
          onClick={() => handleCloseOthers(tabCtx!.id)}
          style={{ color: "inherit" }}
        >
          <span>{t("tabs.close_others")}</span>
        </button>
        <button
          type="button"
          className="menu-row menu-item"
          onClick={handleCloseAll}
          style={{ color: "inherit" }}
        >
          <span>{t("tabs.close_all")}</span>
        </button>
        {/* Shift+T 로만 연결돼 있던 reopenClosedTab(stores/tabs.ts)에 메뉴 진입점 추가.
            recentClosedTabs 가 비어 있으면 항목 자체를 숨긴다(목록 최근순 pop, App.tsx의
            Ctrl+Shift+T 핸들러와 동일 호출). */}
        {recentClosedTabs.length > 0 && (
          <button
            type="button"
            className="menu-row menu-item"
            onClick={() => {
              setTabCtx(null);
              const id = reopenClosedTab();
              if (id) {
                followPreviewToNote(id);
                void selectNote(id);
              }
            }}
            style={{ color: "inherit" }}
          >
            <span>{t("tabs.reopen_closed")}</span>
          </button>
        )}
        <button
          type="button"
          className="menu-row menu-item"
          onClick={() => {
            if (!tabCtx) return;
            const id = tabCtx.id;
            setTabCtx(null);
            void handleSaveAsPreset(id);
          }}
          style={{ color: "inherit" }}
        >
          <span>{t("presets.save_as_preset")}</span>
        </button>
        {aiEnabled && (
          <button
            type="button"
            className="menu-row menu-item"
            onClick={() => {
              if (tabCtx) openAskAi(tabCtx.id);
            }}
            style={{ color: "inherit" }}
          >
            <IconAi size={15} strokeWidth={1.8} />
            <span>{t("ai.ask_ai")}</span>
          </button>
        )}
      </ContextMenuShell>

      {askAiTarget && (
        <Suspense fallback={null}>
          <AskAiModal target={askAiTarget} onClose={() => setAskAiTarget(null)} />
        </Suspense>
      )}
    </div>
  );
}

function TabRow({
  id,
  on,
  title,
  icon,
  tabStyle,
  onClick,
  onContextMenu,
  onClose,
}: {
  id: string;
  on: boolean;
  title: string;
  icon: string | null;
  tabStyle: React.CSSProperties;
  onClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onClose: (e: React.MouseEvent) => void;
}) {
  const isGlow = useAiGlow(AI_GLOW_KEYS.note(id));
  return (
    <div
      data-tab={id}
      data-fh-item="true"
      data-ai-glow={isGlow || undefined} /* "active" | "fading" */
      data-ai-glow-inset="true"
      {...editorIntent}
      onClick={onClick}
      onContextMenu={onContextMenu}
      style={tabStyle}
    >
      {/* 점(활성/비활성 2색) → 노트 아이콘. 활성 표시는 이미 tabStyle의 배경 틴트(var(--sel))
          + 제목 accent 색 + 아래 accent 바가 담당하고 있어(선언 자체가 "단일 표면 위에서
          선택된 탭만 배경으로 드러난다"), 점은 애초에 그 신호를 나르지 않았다 — 그대로 삭제하고
          별도 대체 신호는 추가하지 않는다. */}
      <NoteIcon icon={icon} size={14} />
      <span
        style={{
          fontSize: "var(--text-md)",
          fontWeight: 600,
          color: on ? "var(--accent)" : undefined,
        }}
      >
        {title}
      </span>
      <button
        type="button"
        className="tab-close"
        onClick={onClose}
        aria-label={t("tabs.close_tab", { title })}
        title={t("tabs.close_tab", { title })}
        style={{ marginLeft: "var(--space-2xs)" }}
      >
        <IconClose size={13} strokeWidth={2} aria-hidden="true" />
      </button>
      {on && (
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: -2,
            height: 2,
            background: "var(--accent)",
          }}
        />
      )}
    </div>
  );
}
