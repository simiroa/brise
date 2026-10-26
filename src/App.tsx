import React, { Suspense, useEffect, useRef, useState, useCallback } from "react";
import "./styles/tokens.css";
import { useSettingsStore } from "./stores/settings";
import { useAiStore } from "./stores/ai";
import { HOME_TAB_ID, isHomeTab, isNoteTabId, useTabsStore } from "./stores/tabs";
import { useNotesStore } from "./stores/notes";
import { useSearchStore } from "./stores/search";
import { useUiStore } from "./stores/ui";
import { callSilent, emitNotice, flushAll } from "./lib/invoke";
import { noteHasSaveFailure, retryFailedSaves } from "./lib/sectionSaveFailures";
import { applyThemeGeometryAndShow, trackWindowGeometry } from "./lib/bootWindow";
import { bootMark } from "./lib/bootMark";
import { startIdlePreload } from "./lib/lazyPreload";
import { checkForUpdates } from "./lib/updater";
import { runCollectDetectOnce } from "./lib/collectDetectOnce";

/**
 * 설정 열기 — 2026-08-14 부터 모달이 아니라 **별도 OS 창**이다(이유: src-tauri/src/settings_window.rs
 * 헤더). 창 생성/포커스는 전부 Rust 가 소유하므로 여기선 커맨드 한 번이 전부다.
 *
 * ponytail: 동기화 브라우저 탭(/app)에는 OS 창이 없어 이 커맨드가 라우팅되지 않는다 — 버튼이
 * 조용히 아무 일도 안 한다. 그 클라이언트에서 바꿀 만한 설정이 사실상 없어 지금은 그대로 둔다.
 * 필요해지면 브라우저에서만 예전처럼 인앱 패널로 SettingsPanel 을 띄우면 된다(컴포넌트는 그대로다).
 */
function openSettingsWindow() {
  void callSilent("settings_window_open", {}).catch(() => {});
}

/**
 * 활동 이력 열기 — 2026-08-14 부터 모달이 아니라 **별도 OS 창**이다(이유: activity_window.rs).
 *
 * 데스크톱(Tauri) 전용 — 이 함수를 부르는 버튼은 App.tsx 에서 `!browser` 로 가려져 있어 동기화
 * 브라우저 탭(/app)에서는 아예 렌더되지 않는다(호출 자체가 없다). W5 는 한때 이걸 인앱
 * ActivityHistoryPanel 오버레이로 대체하려 했으나 W2b(WORKORDER 작업 B)에서 철회됐다 —
 * activity_list/note_snapshot_* 전부가 http:false 라(specs/commands/activity.yaml·snapshots.yaml,
 * docs/CLIENT-RULES.md §2-5) 원격 클라이언트에서 영원히 도달 불가능하고, 열어봐야 빈 목록 +
 * 복원 404 뿐이었다. 되돌리려면 먼저 그 백엔드 결정(CLIENT-RULES.md §8 갱신)부터 바뀌어야 한다.
 */
function openActivityWindow() {
  void callSilent("activity_window_open", {}).catch(() => {});
}

import { listenDataReplaced, listenRemoteNoteWrite } from "./lib/remoteNoteWrite";
import { notifyDesktopRemoteChange } from "./components/RemoteChangeBanner";
import { listenSettingsChanged } from "./lib/settingsChanged";
import { listenWorkspacesChanged } from "./lib/workspacesChanged";
import { listenActivityWindowBridge } from "./lib/activityWindowBridge";
import { listenPetSuggestionsBridge } from "./plugins/pet/bridge/petSuggestionsBridge";
import { listenPetClipboardBridge } from "./plugins/pet/bridge/petClipboardBridge";
import { listenPetScreenshotBridge } from "./plugins/pet/bridge/petScreenshotBridge";
import { listenPetLinkBridge } from "./plugins/pet/bridge/petLinkBridge";
import { listenPetThemeBridge } from "./plugins/pet/bridge/petThemeBridge";
import { listenPetCollectBridge } from "./plugins/pet/bridge/petCollectBridge";
import { useEmojiRenderSync } from "./lib/emojiBase";
import { LeftPanel } from "./components/leftpanel/index";
import { TabBar } from "./components/TabBar";
import { TitleBar } from "./components/TitleBar";
import { SourcePanel } from "./components/SourcePanel";
import { ErrorBoundary } from "./components/common/ErrorBoundary";
import { HomeTab } from "./components/home/HomeTab";
import { AttachmentsBar } from "./components/AttachmentsBar";

import { ContextMenu } from "./components/ContextMenu";
import { GlobalModalsHost, LazyOnboardingWizard } from "./components/GlobalModalsHost";
import { useOnboardingSession } from "./stores/onboardingSession";
import { runDataMove, useDataMoveStore } from "./lib/dataMove";
import { Spinner } from "./components/settings/collect/Spinner";
import { useWindowControls } from "./lib/hooks/useWindowControls";
import { useAppHotkeys } from "./lib/hooks/useAppHotkeys";
import { PetSuggestionReviewBridge } from "./components/PetSuggestionReviewBridge";
import { PetChatPlanReviewBridge } from "./components/PetChatPlanReviewBridge";
import { useTrashStore } from "./stores/trash";
import { useArchiveStore } from "./stores/archive";
import { IconSettings, IconMinimize, IconMaximize, IconCaret, IconLock, IconFocus, IconExitFocus, IconPin, IconHistory, IconSmile } from "./components/icons";
import { ReminderBell } from "./components/home/ReminderBell";
import { BriefingButton } from "./briefing/BriefingButton";
import { WindowCloseButton } from "./components/common/WindowCloseButton";
import { listenMany } from "./lib/tauriListen";
import { onAttachmentMetaApplied, type AttachmentMetaApplied } from "./lib/attachmentMetaToast";
import { t } from "./i18n/t";
import { isBrowser } from "./lib/env";
import { useBriefingAutoShow } from "./briefing/useBriefingAutoShow";

import { clamp, useMediaQuery, NARROW_WINDOW_QUERY, ASSIST_COLLAPSE_QUERY } from "./lib/ui";
import { useEscapeConsumer } from "./lib/overlayStack";
import type { SavedState } from "./stores/notes";
import type { DiagNotice } from "./lib/commands.gen";
import { EditorPanel } from "./lazySurfaces";

// Frame-top activity button doubles as the save-state indicator (moved off TitleBar — see
// docs/AI.md-adjacent note.* i18n keys, reused here rather than duplicated). No active note =
// don't reflect any save state (there's nothing being saved), regardless of the store's
// leftover savedState value.
export function activityButtonInfo(hasActiveNote: boolean, savedState: SavedState): {
  title: string;
  ariaLabel?: string;
  color?: string;
} {
  const button = t("activity.header_button");
  if (!hasActiveNote) return { title: button };
  const state =
    savedState === "saving"
      ? t("note.saving")
      : savedState === "failed"
        ? `${t("note.save_failed")} — ${t("note.save_failed_hint")}`
        : savedState === "ai_organized"
          ? t("note.ai_organized")
          : t("note.saved_dot_just_now");
  const title = t("activity.header_button_with_state", { button, state });
  return {
    title,
    ariaLabel: savedState === "failed" ? `${t("note.save_failed")} — ${t("common.retry")}` : undefined,
    color: savedState === "saving" ? "var(--accent)" : savedState === "failed" ? "var(--danger)" : undefined,
  };
}

/**
 * 설정/활동 버튼과 Ctrl+, 이 브라우저(태블릿)에서는 인앱 오버레이로, Tauri 데스크톱에서는 기존
 * OS 창 커맨드로 갈라지는 분기 — App 전체를 마운트하지 않고 단위테스트하기 위해 추출했다
 * (activityButtonInfo 와 같은 이유. App.langRemount.test.tsx 주석 참고: 전체 마운트는
 * LeftPanel/TitleBar/EditorPanel 등 무거운 의존 트리를 전부 끌고 온다).
 */
export function resolveAuxOpen(browser: boolean): "overlay" | "window" {
  return browser ? "overlay" : "window";
}

/**
 * AUDIT-2026-09-26-fallback-observability.md §7 item 6 — 부팅 시(+포커스·60초마다) diag_take_notices
 * 로 drain 한 Notice 한 건을 사용자에게 보일 문구로 바꾼다. PINNED code 둘(diag.rs 헤더 주석
 * 참고)만 전용 문구가 있고, 나머지(미지 code — 다른 웨이브가 새 notify_user() 호출을 추가해도
 * 이 창을 다시 안 고치도록)는 feature/code 를 보여주는 공용 문구로 떨어진다. 순수 함수로 뽑아
 * activityButtonInfo/resolveAuxOpen 과 같은 이유로 App 전체를 마운트하지 않고 테스트할 수 있게 한다.
 */
export function diagWorkerDisplayName(worker: string): string {
  if (worker === "schedule") return t("common.diag_worker_schedule");
  if (worker === "collect") return t("common.diag_worker_collect");
  return worker;
}

export function diagNoticeMessage(notice: DiagNotice): string {
  switch (notice.code) {
    case "db_restored_from_backup":
      return t("common.diag_notice_db_restored_from_backup", {
        backup: notice.params.backup ?? "",
        quarantine: notice.params.quarantine ?? "",
      });
    case "worker_stopped":
      return t("common.diag_notice_worker_stopped", {
        worker: diagWorkerDisplayName(notice.params.worker ?? ""),
      });
    default:
      return t("common.diag_notice_generic", { feature: notice.feature, code: notice.code });
  }
}

// Split (source/editor) drag-collapse — same hysteresis pattern as leftpanel/index.tsx
// (COLLAPSE_ENTER/EXIT): dragging past ENTER previews a collapse (last good sourcePct kept
// untouched), dragging back past EXIT cancels the preview.
// W24: %(14/18) → px — %는 넓은 창에서 임계가 커져(본문 1600px면 224px 지점에서 발동)
// "너무 일찍 닫힌다"(오너). 사이드바와 같은 px 문법·같은 수치로 통일한다.
const SPLIT_COLLAPSE_ENTER = 70;
const SPLIT_COLLAPSE_EXIT = 100;
// 드래그 중 어시스트 패널의 최소 레이아웃 폭 — 이 아래로는 내용을 리플로우하지 않고(찌그러짐
// 방지) 클립한다. 드래그 플로어(onMove의 minPct)와 같은 값이어야 한다.
const SPLIT_MIN_W = 140;

function App() {
  const loadSettings = useSettingsStore((s) => s.load);
  const applyRoot = useSettingsStore((s) => s.applyRoot);
  const theme = useSettingsStore((s) => s.theme);
  const accent = useSettingsStore((s) => s.accent);
  const fontScale = useSettingsStore((s) => s.fontScale);
  const bgDim = useSettingsStore((s) => s.bgDim);
  const sourcePct = useSettingsStore((s) => s.sourcePct);
  const setSourcePct = useSettingsStore((s) => s.setSourcePct);
  const uiLock = useSettingsStore((s) => s.uiLock);
  const setUiLock = useSettingsStore((s) => s.setUiLock);
  // Wave 2: home dashboard replaces the note chrome (title / source / editor / attachments).
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const showHome = isHomeTab(activeTabId);
  // Reactive (not getState()) so a language change re-renders App itself, which re-keys the
  // subtree below and forces every t()-calling descendant to remount and re-read the new
  // language — t() (i18n/t.ts) reads uiLang imperatively via getState(), so components that
  // only call t() (never subscribe to uiLang) would otherwise keep showing stale text until an
  // unrelated re-render happened to hit them.
  const uiLang = useSettingsStore((s) => s.uiLang);
  const loadTree = useNotesStore((s) => s.loadTreeForBoot);
  // Activity button (frame-top) doubles as the save-state indicator — see activityButtonInfo().
  const hasActiveNote = useNotesStore((s) => !!s.activeNote);
  const savedState = useNotesStore((s) => s.savedState);
  // §2.6 HANDOFF-calendar-onboarding.md: reactive gate, not a one-time boot check — reading this
  // live (rather than snapshotting it once at boot) is what lets Settings' "redo onboarding"
  // button (DataManagementSection.tsx) show the wizard immediately just by flipping this flag back
  // to false, with no separate "which overlay is open" state needed.
  const onboardingCompleted = useSettingsStore((s) => s.onboardingCompleted);
  const updateCheckAuto = useSettingsStore((s) => s.updateCheckAuto);
  const focusMode = useUiStore((s) => s.focusMode);
  const toggleFocus = useUiStore((s) => s.toggleFocus);
  const previewCollapsed = useUiStore((s) => s.previewCollapsed);
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const toggleSidebarCollapsed = useUiStore((s) => s.toggleSidebarCollapsed);
  const loadSidebarCollapsed = useUiStore((s) => s.loadSidebarCollapsed);

  // 좁은 창에서는 사이드바를 자동으로 접어 본문에 폭을 돌려준다. 창의 하한 자체는
  // tauri.conf.json 의 minWidth 가 잡고, 이건 그 위 구간의 완충이다.
  // 저장된 sidebarCollapsed 는 **건드리지 않는다** — 창을 잠깐 좁힌 것이 "사이드바 접힘"
  // 설정으로 굳어 다음 실행까지 따라오면 안 되고, 창을 도로 넓혔을 때 사용자가 고른 상태로
  // 돌아오는 것도 그래야 공짜다. 좁은 동안 사용자가 굳이 펴면 narrowSidebarOpen 이 그 에피소드
  // 동안만 살고, 넓어지는 순간 스스로 꺼진다.
  const narrow = useMediaQuery(NARROW_WINDOW_QUERY);
  const [narrowSidebarOpen, setNarrowSidebarOpen] = useState(false);
  useEffect(() => {
    if (!narrow) setNarrowSidebarOpen(false);
  }, [narrow]);
  const sidebarHidden = narrow ? !narrowSidebarOpen : sidebarCollapsed;

  // 다음 단계: 사이드바를 접었는데도 창이 더 좁아지면 어시스트(SourcePanel)도 접어 에디터에
  // 폭을 돌려준다. previewCollapsed 는 비영속(항상 false로 시작)이라 여기서 직접 세팅해도
  // 사용자가 고른 상태를 해치지 않는다 — 단, 사이드바와 달리 창을 다시 넓혀도 자동으로 펴지진
  // 않는다(오너 요청): extraNarrow 로 진입하는 전이 한 번에만 접고, 그 뒤엔 사용자 선택을 존중한다.
  const extraNarrow = useMediaQuery(ASSIST_COLLAPSE_QUERY);
  useEffect(() => {
    if (extraNarrow && !useUiStore.getState().previewCollapsed) {
      useUiStore.setState({ previewCollapsed: true });
    }
  }, [extraNarrow]);

  // 동기화(beta) 브라우저 탭: 창 자체가 없으므로(브라우저 탭이 창이다) 이 파일의 Tauri
  // getCurrentWindow() 호출 전부(최소화/최대화/닫기/핀/지오메트리 복원-저장)를 건너뛴다.
  const browser = isBrowser();
  // W5/W2b: 태블릿(브라우저) 인앱 설정 오버레이가 열려 있는지. !browser 경로는 절대 이 상태를
  // 쓰지 않는다(resolveAuxOpen 이 "window"를 돌려주면 기존 OS 창 커맨드로 간다). 활동 이력은
  // 여기 없다(W2b, WORKORDER 작업 B — activity_list/note_snapshot_* 가 전부 http:false 라 태블릿
  // 에서 열어봤자 항상 빈 목록 + 복원 404, BrowserAuxOverlay.tsx 헤더 참고) — 그 버튼은 아래에서
  // `!browser` 로 가려 데스크톱 OS 창 전용으로 되돌아갔다.
  const [browserSettingsOpen, setBrowserSettingsOpen] = useState(false);
  const [booted, setBooted] = useState(false);
  // 온보딩 모달 표시 게이트 — X(이번 실행만 닫기)는 세션 스토어가 기억한다(stores/onboardingSession.ts).
  const onboardingDismissed = useOnboardingSession((s) => s.dismissed);
  const onboardingShown = booted && !onboardingCompleted && !onboardingDismissed;
  // 설정의 "온보딩 다시 시작하기"(GeneralSection) — 설정은 별도 OS 창이라 Tauri 이벤트로 오고,
  // 브라우저/태블릿 인앱 설정은 같은 창이라 window 이벤트로 온다. X 로 닫았어도 다시 연다.
  useEffect(() => {
    // 온보딩 다시 시작은 설정 창(다른 웹뷰)에서 누르므로 이 창에서 미리 받을 수 있는 가장 이른 때가 이 신호다.
    const onRestart = () => {
      void LazyOnboardingWizard.preload().finally(() => useOnboardingSession.getState().restart());
    };
    window.addEventListener("onboarding-restart-requested", onRestart);
    const unlisten = listenMany([["onboarding-restart-requested", onRestart]]);
    return () => {
      window.removeEventListener("onboarding-restart-requested", onRestart);
      unlisten();
    };
  }, []);

  // AI 도달성 자동 probe — 대시보드로 바로 시작해도 앱 레벨에서 백그라운드 확인을 시작한다.
  useEffect(() => {
    void useAiStore.getState().ensureAiReachable();
  }, []);
  // 데이터 이동 요청 — 설정(별도 OS 창)의 "위치 변경"과 온보딩 요약(같은 창)이 이 창(main)에게
  // 실제 이동을 부탁한다. 같은 이중 채널(window 이벤트 + Tauri 이벤트, 위 온보딩 재시작과 같은
  // 패턴) — GeneralSection.tsx 가 둘 다 쏜다. 이동은 lib/dataMove.ts 의 단일 관문 하나뿐이다
  // (오너 규칙: 유사 기능은 같은 경로). runDataMove 실패는 이미 토스트가 뜬 뒤이므로(그 관문 안의
  // invoke 래퍼가 띄운다) 여기서 더 할 일이 없다 — 요청한 쪽(설정 창)은 재시작이 대신 닫아줄 뿐
  // 이 실패를 따로 돌려받지 않는다(§6 지시).
  const moving = useDataMoveStore((s) => s.moving);
  useEffect(() => {
    const onMoveRequest = (e: Event) => {
      const path = (e as CustomEvent<{ path?: string }>).detail?.path;
      // silent-ok: runDataMove 가 이미 토스트/moving 정리를 끝냈다 — 요청자는 재시작이 닫아준다(위 주석).
      if (path) void runDataMove(path).catch(() => {});
    };
    window.addEventListener("data-move-request", onMoveRequest);
    const unlisten = listenMany([
      [
        "data-move-request",
        (e) => {
          const path = (e.payload as { path?: string } | undefined)?.path;
          // silent-ok: 위 window 리스너와 같은 이유.
          if (path) void runDataMove(path).catch(() => {});
        },
      ],
    ]);
    return () => {
      window.removeEventListener("data-move-request", onMoveRequest);
      unlisten();
    };
  }, []);
  // 창 제어 로직 (alwaysOnTop, minimizeWindow, toggleMaximizeWindow, closeWindow 등)
  const {
    alwaysOnTop,
    alwaysOnTopBusy,
    toggleAlwaysOnTop,
    minimizeWindow,
    toggleMaximizeWindow,
    closeWindow,
  } = useWindowControls(browser);

  const [petEnabled, setPetEnabled] = useState(false);
  const [petVisible, setPetVisible] = useState(true);
  const togglePetVisible = useCallback(async () => {
    const next = !petVisible;
    setPetVisible(next);
    await callSilent("pet_set_visible", { visible: next }).catch(() => setPetVisible(!next));
  }, [petVisible]);
  const bodyRef = useRef<HTMLDivElement>(null);
  const dragSrc = useRef(false);
  // Mirrors leftpanel's collapsingRef/dragCollapsing — collapsingRef is read synchronously
  // inside onMove (state updates are async), splitDragCollapsing drives the live preview render.
  const splitCollapsingRef = useRef(false);
  const [splitDragCollapsing, setSplitDragCollapsing] = useState(false);

  useEmojiRenderSync(browser);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const rawSettings = await loadSettings();
      bootMark("settings");
      if (!browser && rawSettings) {
        setPetEnabled((rawSettings.pet_enabled as string) === "1");
        // pet_visible 미시딩(기존 DB 등)이면 기본 보임 — settings_schema.rs::pet_visible_setting
        // 의 fail-open과 같은 규칙.
        setPetVisible((rawSettings.pet_visible as string | undefined) !== "0");
      }
      // QA8 Wave 3A — hydrate device-local search history (same store as sidebar + dashboard
      // header). settings_get_all already ran in loadSettings; this re-reads the key into
      // useSearchStore.recentSearches. Fire-and-forget is fine — empty list until it lands.
      void useSearchStore.getState().loadRecentSearches();
      // H2: theme + surface CSS, geometry, one painted frame, then show — before loadTree so
      // the user gets a correctly themed/placed empty shell without waiting on the tree IPC.
      // Browser mode: no native window to size/position/show — the tab is already visible, so
      // just apply the theme root and skip bootWindow.ts's Tauri-only geometry dance.
      if (browser) {
        useSettingsStore.getState().applyRoot();
      } else {
        await applyThemeGeometryAndShow(() => useSettingsStore.getState().applyRoot(), rawSettings);
        await useSettingsStore.getState().applySurfaceEffectAfterShow();
      }
      await loadTree(rawSettings);
      bootMark("tree");
      await loadSidebarCollapsed();
      // Trash badge: intentionally NOT in the boot window. note_trash_list used to pay a
      // ~500ms folder-join scan at 100k even with zero trash rows; loadTrashCount is deferred
      // until after setBooted (first paint) so boot stays on the meta/tree path only.
      if (cancelled) return;

      const tabsState = useTabsStore.getState();
      // Wave A-4: no full corpus at boot — prune open tabs via note_summaries_map by-id.
      // openTabs is note ids only (home sentinel is never persisted there).
      const openTabs = tabsState.openTabs;
      const resolved = await useNotesStore.getState().ensureNoteSummaries(openTabs);
      if (cancelled) return;
      const prunedTabs = openTabs.filter((id) => resolved.has(id));
      let activeTabId = tabsState.activeTabId;
      // Home is virtual — keep it. A missing note active falls back to last remaining note tab,
      // then home (not null — home replaced the empty/draft default for "no note tab active").
      if (isNoteTabId(activeTabId) && !prunedTabs.includes(activeTabId)) {
        activeTabId = prunedTabs[prunedTabs.length - 1] ?? HOME_TAB_ID;
      }
      if (
        prunedTabs.length !== tabsState.openTabs.length ||
        activeTabId !== tabsState.activeTabId
      ) {
        useTabsStore.setState({ openTabs: prunedTabs, activeTabId });
        void callSilent("settings_set", {
          entries: { open_tabs: prunedTabs, active_tab_id: activeTabId },
        });
      }

      if (isNoteTabId(activeTabId)) {
        await useNotesStore.getState().selectNote(activeTabId);
        if (cancelled) return;
        if (useNotesStore.getState().activeNote?.note.id !== activeTabId) {
          const tabs = useTabsStore.getState().openTabs.filter((t) => t !== activeTabId);
          const nextActive = tabs[tabs.length - 1] ?? HOME_TAB_ID;
          useTabsStore.setState({ openTabs: tabs, activeTabId: nextActive });
          void callSilent("settings_set", {
            entries: { open_tabs: tabs, active_tab_id: nextActive },
          });
        }
      }

      if (!cancelled) {
        setBooted(true);
        bootMark("booted");
        // 부팅이 끝났다 — 자주 여는 지연 화면(대시보드 탭·에디터·AI 모달 등, src/lazySurfaces.ts 의 idle:"main")을
        // 한가할 때 미리 받아 첫 열기의 대기 화면(React 19 의 300ms)을 없앤다. 폰(브라우저 모드)은 받지 않는다.
        startIdlePreload("main", browser);
        // scripts/smoke.mjs polls this over CDP to know when boot has settled. The previous
        // signal (__brisePerf.series.boot_to_tree_paint) was deleted as "0 references" dead code
        // in 3091321e — a script isn't `src/`, so that sweep's grep never saw smoke.mjs depend on
        // it, and the smoke gate silently timed out on every run since. Dev-only, no prod cost.
        if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__briseSmokeBooted = true;
        // After first paint: trash badge count (cheap COUNT via note_trash_count + v19 index).
        void useTrashStore.getState().loadTrashCount();
        // W7-f: archive badge count — same deferred-until-first-paint posture (v36 idx_notes_archived).
        void useArchiveStore.getState().loadArchiveCount();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadSettings, loadTree, loadSidebarCollapsed, browser]);

  useEffect(() => {
    applyRoot();
  }, [theme, accent, fontScale, bgDim, applyRoot, booted]);

  // 자동 업데이트 확인(docs/RELEASING.md) — 부팅 후 15초 지연, 세션당 1회, 완전 무음(실패·미발견은
  // 표시 없음). 업데이트를 찾으면 무음 여부와 무관하게 lib/updater.ts 가 자체 ask() 확인창을 띄운다.
  // E4: update_check_auto 가 꺼져 있으면 자동 확인을 건너뛴다.
  useEffect(() => {
    if (browser || !booted || !updateCheckAuto) return;
    const timer = setTimeout(() => {
      void checkForUpdates({ silent: true });
    }, 15000);
    return () => clearTimeout(timer);
  }, [browser, booted, updateCheckAuto]);

  // 로컬 소스 자동 감지(PLAN-2026-09-04-local-import §3b) — 부팅 후 5초 지연, 세션(런타임)당
  // 1회(lib/collectDetectOnce.ts 의 모듈 가드), collect_detect_seen 이 아직 false 일 때만 조용히
  // 훑어 설정 > 수집 레일 뱃지 숫자를 남긴다. 5초는 위 업데이트 확인(15초)보다 짧게 잡았다 —
  // 로컬 파일 몇 개를 읽는 가벼운 훑기라 네트워크를 타는 업데이트 확인만큼 부팅 경쟁을 피할
  // 이유가 크지 않다.
  useEffect(() => {
    if (browser || !booted) return;
    const timer = setTimeout(() => {
      void runCollectDetectOnce();
    }, 5000);
    return () => clearTimeout(timer);
  }, [browser, booted]);

  // 전역 단축키(앱 레벨). 모달이 열려 있으면 억제한다 — 열린 ModalShell 은 role="dialog" 를
  // 달고 있으므로 그 존재로 감지한다(모달은 자체 Escape/Tab 을 소유). Ctrl(Win/Linux)·⌘(mac)
  // 공통. Ctrl/⌘+W(탭 닫기)는 창 닫기 관례와 충돌 소지가 있어 넣지 않았다.
  // 동기화(beta) 모바일 편집 반영 — 실제 로직은 lib/remoteNoteWrite.ts(App.tsx 없이 테스트 가능).
  useEffect(() => listenRemoteNoteWrite({ onFocusSkipped: notifyDesktopRemoteChange }), []);

  // 설정 창(별도 웹뷰)의 변경을 본 창 스토어에 반영한다 — 실제 로직은 lib/settingsChanged.ts.
  useEffect(() => listenSettingsChanged(), []);

  // 설정 창의 노트북 생성/삭제(테스트 DB 토글)를 본 창에 반영 — 실제 로직은 lib/workspacesChanged.ts.
  useEffect(() => listenWorkspacesChanged(), []);

  // 초기화·백업 복원·대체 가져오기로 데이터가 통째로 바뀌면 창을 다시 불러온다 — lib/remoteNoteWrite.ts::listenDataReplaced.
  useEffect(() => listenDataReplaced(), []);

  // 활동 이력 창의 스냅샷 복원 — 본 창이 flushAll 한 뒤에 restore 한다.
  useEffect(() => listenActivityWindowBridge(), []);

  // 브리핑 자동 표시(PLAN-2026-09-30 W5) — 본 창 1곳. 판정은 briefing/shouldShowBriefing.ts.
  useBriefingAutoShow();

  // 펫 다리 6개 — 전부 "펫 창(별 웹뷰)의 좁은 allowlist(PET_ALLOWED_COMMANDS, pet_window.rs)에
  // 없는 커맨드를 메인 창이 대행한다"는 같은 이유로 존재하고, 같은 게이트(petEnabled)를 쓰므로
  // useEffect 하나로 묶는다:
  //  - listenPetSuggestionsBridge: P2 2단계 후행 제안(docs/PLAN-2026-08-07-second-brain.md Q5)
  //    폴링 + 브로드캐스트.
  //  - listenPetClipboardBridge: 펫 우클릭 "클립보드 저장"(docs/PLAN-2026-08-08-presets-schedule.md
  //    Q9) 라우팅 + 저장.
  //  - listenPetScreenshotBridge: 펫 우클릭 "화면 저장"(docs/PLAN-2026-08-09-pet-capture.md
  //    Phase 1) 캡처 + 요약 + 저장 — 클립보드 다리와 같은 모양, 입구만 다르다.
  //  - listenPetLinkBridge / listenPetThemeBridge / listenPetCollectBridge: 펫 채팅 카드의
  //    "추가하기"/"모으기"/"정리하기" 수락 처리.
  // 펫이 꺼져 있으면(petEnabled=false) 아무도 안 들을 방송이니 마운트조차 하지 않는다 — "펫이
  // 꺼진 사용자는 제안을 못 본다"(의도된 v1 한계)가 자연히 성립한다.
  useEffect(() => {
    if (browser || !petEnabled) return;
    const cleanups = [
      listenPetSuggestionsBridge(),
      listenPetClipboardBridge(),
      listenPetScreenshotBridge(),
      listenPetLinkBridge(),
      listenPetThemeBridge(),
      listenPetCollectBridge(),
    ];
    return () => cleanups.forEach((fn) => fn());
  }, [browser, petEnabled]);

  // 펫 창(별 웹뷰)의 알림/노트 칩 클릭 — commands::pet::pet_open_main 이 창을 띄우고 이 이벤트를
  // 보낸다. 펫은 메인 앱의 스토어에 직접 닿을 수 없어 이벤트가 유일한 경로다(W6-d2).
  useEffect(() => {
    // listen() 보일러플레이트(cancelled 플래그·unlisten 누적·테스트 환경 reject 삼킴 .catch)는
    // listenMany 가 한다(lib/tauriListen.ts) — 이 파일의 나머지 listen 구독도 전부.
    return listenMany([
      [
        // 범용 "본 창에서 이 노트 열기" 채널 — 펫·활동 이력·섹션 분리 창이 쓴다. 이름은 역사적(펫 접두).
        "pet-open-note",
        (e: { payload?: { note_id?: string } }) => {
          const id = e.payload?.note_id;
          if (id) void useNotesStore.getState().selectNote(id);
        },
      ],
    ]);
  }, []);

  // 펫 더블클릭 "new_note"(W18 B2) — pet_open_main 으로 이 창을 띄운 뒤 이 이벤트로 새 노트
  // 생성을 트리거한다(펫 창은 스토어에 직접 못 닿는다, 위 "pet-open-note"와 같은 이유). 새
  // Rust 커맨드를 만들지 않고 기존 Ctrl+N 경로(useNotesStore.newNote())를 그대로 재사용한다.
  useEffect(() => {
    return listenMany([
      [
        "pet-action-new-note",
        () => {
          void useNotesStore.getState().newNote();
        },
      ],
    ]);
  }, []);

  // 일정 알림의 메인 창 채널(docs/PLAN-schedule-system.md §5.3 3채널 중 셋째) — Rust 틱 스레드가
  // events::emit_desktop_json("app-notice", ..) 로 쏘고, 여기서 기존 notice 채널(invoke.ts ↔
  // Toast.tsx)에 그대로 흘린다. 클릭 가능한 표면은 펫 말풍선이 담당하므로 여기는 텍스트만.
  useEffect(() => {
    return listenMany([
      [
        "app-notice",
        (e: { payload?: { text?: string } }) => {
          const text = e.payload?.text;
          if (text) emitNotice(text);
        },
      ],
    ]);
  }, []);

  // AUDIT-2026-09-26-fallback-observability.md §7 item 6 — Rust 쪽 diag::notify_user()/
  // worker_stopped() 가 쌓아 둔 사용자 알림 대기열을 메인 창이 drain 해 표시한다(부팅 알림 —
  // P0 DB 자동복구 등). 대기열은 diag_take_notices 가 부를 때마다 통째로 비우므로(drain, diag.rs
  // take_notices() 주석 참고) 한 창만 가져가면 된다 — 그게 메인 창이다. 포커스마다 + 60초마다도
  // 다시 가져간다: 앱이 백그라운드에 떠 있는 동안 새로 쌓였을 수 있어서다(예: 스케줄러가 창이
  // 숨겨진 채로 죽는 경우). callSilent 라서 실패해도 조용히 다음 기회에 다시 시도한다 — 이 알림은
  // "있으면 보여주는" 성격이지 사용자 행동의 성패가 아니다.
  // booted 뒤에만: 본 창은 visible:false 로 떠서 applyThemeGeometryAndShow 가 끝나야 보인다 —
  // 그 전에 가져가면 P0 복구 알림 토스트가 아무도 못 본 채 사라진다(DB 복구가 첫 설정 조회를
  // 늦추는 바로 그 부팅이 문제의 경우다). 브라우저 모드는 diag_take_notices 가 http:false 라 건너뛴다.
  useEffect(() => {
    if (!booted || browser) return;
    const drain = () => {
      void callSilent<{ items: DiagNotice[] }>("diag_take_notices")
        .then((res) => {
          for (const notice of res.items) emitNotice(diagNoticeMessage(notice));
        })
        .catch(() => {});
    };
    drain();
    window.addEventListener("focus", drain);
    const interval = setInterval(drain, 60_000);
    return () => {
      window.removeEventListener("focus", drain);
      clearInterval(interval);
    };
  }, [booted, browser]);

  // 사진 EXIF·음성 업로드 메타 자동 반영(repo::attachments::exif_region, photo_meta_mode=auto) —
  // 백엔드는 요약과 되돌리기용 행 id 를 보내고, 토스트 문구는 프론트 i18n 으로 조립한다.
  // [되돌리기] 는 기존 note_date_remove/note_region_remove 를 재사용한다(lib/attachmentMetaToast.ts).
  useEffect(() => {
    return listenMany([
      [
        "attachment-meta-applied",
        (e: { payload?: AttachmentMetaApplied }) => {
          if (e.payload) onAttachmentMetaApplied(e.payload);
        },
      ],
    ]);
  }, []);

  // 트레이 "펫 표시/숨기기" 또는 설정(PetSection.tsx)에서 바뀌면 이 창 스트립의 버튼도 따라간다
  // — tray::reconcile 이 emit_to("main", ..) 로 쏘는 이벤트(W8-g: {enabled, visible} 두 값 함께).
  // 같은 "main" 웹뷰 안에 리스너가 여럿(여기 + PetSection.tsx)이라도 Tauri 이벤트는 멀티
  // 구독이라 문제없다.
  useEffect(() => {
    return listenMany([
      [
        "pet-enabled-changed",
        (e: { payload: { enabled: boolean; visible: boolean } }) => {
          setPetEnabled(e.payload.enabled);
          setPetVisible(e.payload.visible);
        },
      ],
    ]);
  }, []);

  const handleOpenSettings = useCallback(() => {
    if (resolveAuxOpen(browser) === "overlay") {
      setBrowserSettingsOpen(true);
    } else {
      openSettingsWindow();
    }
  }, [browser]);

  useAppHotkeys({
    browser,
    onOpenSettings: handleOpenSettings,
  });

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragSrc.current || uiLock || !bodyRef.current) return;
      e.preventDefault();
      const rect = bodyRef.current.getBoundingClientRect();
      const px = rect.right - e.clientX; // 어시스트 패널이 우측에 있다 — 폭은 오른쪽 끝 기준
      const p = (px / rect.width) * 100;
      // W22 ⑫: leftpanel과 같은 히스테리시스 2단 + 프리뷰 — SPLIT_COLLAPSE_ENTER 아래로 내리면
      // 접힘을 미리보기(폭만 즉시 접힌 것처럼 보이되 sourcePct·previewCollapsed는 그대로 유지, 마지막
      // 유효값을 보존)만 하고, mouseup에서 실제로 커밋한다. SPLIT_COLLAPSE_EXIT 위로 다시 올려야
      // 프리뷰가 취소된다(중간에서 계속 토글되는 flapping 방지). W24: 판정은 px 기준(상수 주석 참고).
      const wasCollapsing = splitCollapsingRef.current;
      const nowCollapsing = wasCollapsing ? px <= SPLIT_COLLAPSE_EXIT : px < SPLIT_COLLAPSE_ENTER;
      if (nowCollapsing !== wasCollapsing) {
        splitCollapsingRef.current = nowCollapsing;
        setSplitDragCollapsing(nowCollapsing);
      }
      if (!nowCollapsing) {
        // W24: 최소폭을 고정 %(24%)로 뒀더니 넓은 창에서 384px씩 되어, 패널이 거기서 멈춘 채
        // 포인터만 한참 더 가야 접혀 "아직 넓은데 갑자기 닫힌다"로 느껴졌다(오너 2차) — 그래서
        // px 기준으로 바꿨다. 2026-09-19 재확인: 그 뒤 안전판으로 넣은 `Math.max(12, …)`가
        // 같은 증상을 다시 불러왔다 — 넓은 창에서는 결국 창 폭의 12%(2000px 창이면 240px)까지
        // 벌어져 있었다. 순수 px→% 변환만 남겨 모든 창 폭에서 정확히 SPLIT_MIN_W(px)로 고정한다
        // (위 SPLIT_MIN_W 주석의 "드래그 플로어와 같은 값이어야 한다"가 이제 문자 그대로 성립).
        // 상한 74 는 mouseup 커밋 시점 clamp(24,74)의 상한과 같다(Rust settings_schema).
        const minPct = (SPLIT_MIN_W / rect.width) * 100;
        setSourcePct(clamp(p, minPct, 74));
      }
    };
    const onUp = () => {
      if (dragSrc.current) {
        dragSrc.current = false;
        document.body.style.cursor = "";
        if (splitCollapsingRef.current) {
          // Commit the preview: sourcePct was never touched while previewing, so it still holds
          // the last good value — expanding later restores exactly that width.
          splitCollapsingRef.current = false;
          setSplitDragCollapsing(false);
          if (!useUiStore.getState().previewCollapsed) {
            useUiStore.setState({ previewCollapsed: true });
          }
        } else {
          const rawPct = useSettingsStore.getState().sourcePct;
          const pct = Math.round(clamp(rawPct, 24, 74));
          void callSilent("settings_set", { entries: { source_pct: pct } }).catch(() => {});
        }
      }
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, [uiLock, setSourcePct]);

  // 지오메트리 영속화는 부팅이 끝난 뒤에만 — 복원(setSize/setPosition)과 show() 자체가
  // resize/move 이벤트를 낳으므로, 마운트 시점에 리스너를 붙이면 우리가 일으킨 전이를 우리가
  // 되받아 저장한다. 종료 중 저장 억제는 trackWindowGeometry 가 소유한다(lib/bootWindow.ts).
  useEffect(() => {
    if (!booted || browser) return; // no native window to track in a browser tab
    return trackWindowGeometry((geometry) => {
      void callSilent("settings_set", { entries: { window_geometry: geometry } }).catch(() => {});
    });
  }, [booted, browser]);

  const onSplitDown = useCallback(
    (e: React.MouseEvent) => {
      if (uiLock) return;
      e.preventDefault();
      dragSrc.current = true;
      splitCollapsingRef.current = false;
      setSplitDragCollapsing(false);
      document.body.style.cursor = "col-resize";
    },
    [uiLock]
  );

  // 집중 모드는 노트 편집 전용 — 대시보드에선 탭바·사이드바만 빠진 화면이 될 뿐이다.
  // 마지막 노트 탭을 닫아 대시보드에 떨어지는 경로 등, 진입 버튼(위에서 !showHome 로 숨김)을
  // 우회해 집중 모드인 채로 대시보드에 도착하는 경우를 여기서 정리한다.
  useEffect(() => {
    if (showHome && focusMode) toggleFocus();
  }, [showHome, focusMode, toggleFocus]);

  // Escape 로 집중 모드 탈출 — 스택(LIFO)이라 나중에 열린 메뉴/모달/팝오버가 먼저 소비한다.
  useEscapeConsumer(focusMode, toggleFocus);

  const chrome = !focusMode;
  const activityBtn = activityButtonInfo(hasActiveNote, savedState);



  return (
    <>
    <div
      className="app"
      // Force-remount the whole chrome/editor subtree on language change (see uiLang comment
      // above). 온보딩 페이지도 이 안에 있어 함께 리마운트되므로 이동 상태(화면·쪽·노트북 이름
      // 초안·X)는 컴포넌트가 아니라 stores/onboardingSession.ts 에 둔다. 설정은 2026-08-14 부터
      // 이 트리에 없다 — 별도 OS 창이라 언어 변경 리마운트와 무관하게 자기 창에서 자기 uiLang 을 구독한다.
      key={uiLang}
      data-theme={theme}
      style={{
        position: "relative",
        height: "100vh",
        width: "100vw",
        display: "flex",
        flexDirection: "row",
        // Sheet paint (--bg + repeat/size/position) and the text colour now live on the `.app`
        // class rule in tokens.css, not here — an inline style here shadowed the class and never
        // reached the aux windows' own `.app` roots (sheet 2026-08-15; colour GRILL-2026-10-19 R1-A,
        // aux h1 measured rgb(255,255,255)).
        overflow: "hidden",
      }}
    >
      {/* Sidebar: full window height, workspace switcher + search/tree + new-note (see leftpanel/index.tsx).
          Collapsed = zero width (unmounted), never rendered narrow-but-visible.
          W13: boundary sits OUTSIDE LeftPanel (not inside it) so a render crash in the tree/search
          subtree only takes out this slot, not the whole app (that used to bubble to the root
          boundary in main.tsx and blank the entire window — see CLAUDE.md 함정 #1). */}
      {chrome && !sidebarHidden && (
        <ErrorBoundary fallbackTitle={t("common.boundary_sidebar")}>
          <LeftPanel />
        </ErrorBoundary>
      )}

      {/* Main column: window strip / tab row / title bar / body split / attachments.
          No background of its own — it sits directly over .app's own --bg (single sheet,
          SINGLE-SHEET ACRYLIC CONTRACT in tokens.css); giving this div a background too would
          just repaint the identical layer a second time for zero visual difference. */}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* Window strip: draggable, right-aligned settings + minimize/maximize/close.
            Always rendered (even in focus mode) so the custom frame stays draggable
            and the window controls stay reachable. */}
        <div
          data-tauri-drag-region=""
          // in-flow 크롬(SINGLE-SHEET ACRYLIC CONTRACT) — 배경을 칠하지 않아 `.app` 의 시트(flat=
          // 불투명, acrylic=단일 반투명 틴트)가 그대로 비친다.
          style={{
            display: "flex",
            alignItems: "center",
            height: "var(--row-chrome)",
            flex: "none",
          }}
        >
          {/* Sidebar toggle: always reachable (open or closed) regardless of leftWidth/collapsed
              state. Hidden in focus mode — chrome already hides the sidebar there, so a toggle
              that visibly does nothing would just be confusing. */}
          {chrome && (
            <div
              data-tauri-drag-region="false"
              style={{ display: "flex", alignItems: "center", height: "100%", paddingLeft: "var(--space-3)" }}
            >
              <button
                type="button"
                className="icon-btn"
                onClick={narrow ? () => setNarrowSidebarOpen((v) => !v) : toggleSidebarCollapsed}
                title={sidebarHidden ? t("sidebar.expand") : t("sidebar.collapse")}
              >
                <IconCaret dir={sidebarHidden ? "right" : "left"} size={16} />
              </button>
            </div>
          )}

          {/* Draggable spacer */}
          <div data-tauri-drag-region="" style={{ flex: 1, height: "100%" }} />

          <div style={{ display: "flex", height: "100%", alignItems: "center", gap: "var(--space-2)", paddingRight: "var(--space-3)" }} data-tauri-drag-region="false">
            {/* ── 플러그인 아이콘 영역 (PLAN-2026-08-27-space-plugin-rebuild §2) ──────────
                동봉 플러그인의 진입점만 사는 구간. 그룹 맨 앞에 서고 뒤 구분선으로 기능
                아이콘들과 갈린다. 표시할 플러그인이 0이면 구분선까지 통째로 렌더하지 않는다. */}
            {!browser && petEnabled && (
              <>
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => void togglePetVisible()}
                  title={t("settings.pet_enable")}
                  aria-label={t("settings.pet_enable")}
                  aria-pressed={petVisible}
                  style={{ color: petVisible ? "var(--accent)" : undefined }}
                >
                  <IconSmile size={16} strokeWidth={1.8} />
                </button>
                <div style={{ width: 1, height: 20, background: "var(--divider)", margin: "0 var(--space-2)" }} />
              </>
            )}
            {/* 잠금/크게보기/항상보이기 — Tauri 창 API·전역 토글이라 활성 노트 유무와 무관하게
                항상 조작 가능해야 한다(TitleBar의 rowDisabledStyle을 여기 적용하지 않는다).
                단, 잠금은 집중 모드에선 숨긴다 — 잠그는 대상(사이드바/스플릿/첨부 그립)이
                전부 집중 모드에서 이미 숨어 있어 조작할 게 없다. */}
            {/* QA8 Wave 4A — app-wide activity history (moved from TitleBar note-favorite area).
                Same "global toggles that work without active note" contract as the lock button.
                Also doubles as the save-state indicator (moved off TitleBar) — see
                activityButtonInfo() above for the saving/failed/saved → color+tooltip mapping.
                W2b: desktop-OS-window only, same `!browser` pattern as pin/minimize/maximize below —
                activity_list/note_snapshot_* are all http:false (BrowserAuxOverlay.tsx header), so a
                browser tab has nothing to show here; the button itself is hidden rather than routed
                to a permanently-empty overlay. */}
            {!browser && (
              <button
                type="button"
                className="icon-btn"
                onClick={
                  savedState === "failed"
                    ? async () => {
                        await retryFailedSaves();
                        await flushAll();
                        const n = useNotesStore.getState().activeNote;
                        if (n && !noteHasSaveFailure(n.note.id, n.sections.map((s) => s.id))) {
                          useNotesStore.getState().setSavedState("saved");
                        }
                      }
                    : openActivityWindow
                }
                title={activityBtn.title}
                aria-label={activityBtn.ariaLabel ?? activityBtn.title}
                style={{ color: activityBtn.color }}
              >
                {/* 저장 중에도 아이콘을 돌리지 않는다 — 자동저장이 잦아 쉬지 않고 도는 게 거슬렸다(오너
                    2026-10-13). 저장 상태는 색(강조/위험)과 툴팁으로만 알린다. */}
                <IconHistory size={16} strokeWidth={1.8} />
              </button>
            )}
            {chrome && (
              <button
                type="button"
                className="icon-btn"
                onClick={() => setUiLock(!uiLock)}
                title={t("editor.lock_layout")}
                aria-pressed={uiLock}
                style={{ color: uiLock ? "var(--accent)" : undefined }}
              >
                <IconLock size={16} strokeWidth={1.8} />
              </button>
            )}
            {focusMode ? (
              // 집중모드: 아이콘만 있던 버튼을 라벨 pill로 바꿔 "나가기" 동작을 명시한다 —
              // 예전엔 FocusExit가 콘텐츠 우상단에 따로 떠서 창 X(닫기)와 겹쳤다(진짜 문제).
              // 같은 toggleFocus로 진입/탈출을 토글하므로 별도 버튼이 아니라 이 버튼의 분기.
              <button
                type="button"
                className="icon-btn"
                onClick={toggleFocus}
                title={t("editor.exit_focus")}
                aria-pressed={focusMode}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 5,
                  width: "auto",
                  padding: "5px 9px",
                  border: "1px solid var(--accent)",
                  borderRadius: "var(--radius-sm)",
                  color: "var(--accent)",
                  fontSize: "var(--text-xs)",
                  fontWeight: 600,
                }}
              >
                <IconExitFocus size={16} strokeWidth={1.8} />
                {t("editor.exit_focus")}
              </button>
            ) : (
              // 집중 모드는 노트 편집 전용 — 대시보드에선 탭바·사이드바만 빠진 화면이 될
              // 뿐이라 진입 버튼 자체를 숨긴다(탈출 pill 은 위 분기라 그대로 남는다).
              !showHome && (
                <button
                  type="button"
                  className="icon-btn"
                  onClick={toggleFocus}
                  title={t("editor.focus_mode")}
                  aria-pressed={focusMode}
                >
                  <IconFocus size={16} strokeWidth={1.8} />
                </button>
              )
            )}
            {/* 항상 위에 표시(핀) — Tauri 창 API 전용, 브라우저 탭엔 대응 개념이 없다. */}
            {!browser && (
              <button
                type="button"
                className="icon-btn"
                onClick={() => void toggleAlwaysOnTop()}
                disabled={alwaysOnTopBusy}
                title={t("window.always_on_top")}
                aria-pressed={alwaysOnTop}
                aria-busy={alwaysOnTopBusy}
                style={{
                  color: alwaysOnTop ? "var(--accent)" : undefined,
                  opacity: alwaysOnTopBusy ? 0.6 : 1,
                }}
              >
                <IconPin size={16} strokeWidth={1.8} />
              </button>
            )}
            {!browser && <BriefingButton />}
            <ReminderBell />

            <div style={{ width: 1, height: 20, background: "var(--divider)", margin: "0 var(--space-2)" }} />

            <button
              type="button"
              className="icon-btn"
              onClick={() => (resolveAuxOpen(browser) === "overlay" ? setBrowserSettingsOpen(true) : openSettingsWindow())}
              title={`${t("common.nav_settings")} (Ctrl+,)`}
            >
              <IconSettings size={18} strokeWidth={1.8} />
            </button>

            {/* 최소화/최대화/닫기 — 네이티브 창 프레임 전용. 브라우저 탭엔 이미 브라우저 자체의
                창 컨트롤이 있으므로 통째로 렌더하지 않는다(비활성 버튼으로 남겨 둘 이유가 없다). */}
            {!browser && (
              <>
                <div style={{ width: 1, height: 20, background: "var(--divider)", margin: "0 var(--space-2)" }} />
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => void minimizeWindow()}
                  title={t("window.minimize")}
                >
                  <IconMinimize size={14} strokeWidth={2} />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => void toggleMaximizeWindow()}
                  title={t("window.maximize")}
                >
                  <IconMaximize size={12} strokeWidth={2} />
                </button>
                <WindowCloseButton onClose={() => void closeWindow()} />
              </>
            )}
          </div>
        </div>

        {/* content-canvas 래퍼(W22 ⑪, 결정 번복): TabBar부터 showHome 분기 전체(HomeTab, 또는
            TitleBar+본문 split+첨부)를 하나의 라운드 외곽선으로 묶는다 — "창 안의 또 하나의 창"
            인상. LeftPanel(사이드바)·창 상단 컨트롤 스트립은 계속 바깥. 상시 렌더 — focusMode 에
            따라 넣었다 뺐다 하면 EditorPanel 서브트리가 리마운트되어 TipTap 인스턴스가 파괴된다
            (CLAUDE.md 함정 #2). border/radius/틴트/인셋만 --focus 로 지운다. */}
        {/* 데이터 이동 중 전체 창 차단 — ModalShell 이 아니라 직접(닫기 버튼·Escape·바깥 클릭
            전부 없음, #3 지시: 편집 중 데이터를 옮기다 쓴 내용이 스냅샷 뒤에 쓰여 사라지는 사고
            방지). .modal-scrim 은 position:fixed;inset:0 이라 에디터까지 통째로 덮는다. */}
        {moving && (
          <div className="modal-scrim" data-testid="data-move-overlay">
            <div
              className="overlay"
              role="alertdialog"
              aria-live="assertive"
              aria-label={t("common.data_move_overlay")}
              style={{
                padding: "var(--space-6)",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: "var(--space-3)",
                width: 360,
                textAlign: "center",
              }}
            >
              <Spinner size={28} />
              <p style={{ margin: 0, fontSize: "var(--text-md)", fontWeight: 600 }}>{t("common.data_move_overlay")}</p>
            </div>
          </div>
        )}
        {/* 온보딩 모달 — ModalShell 이 포털로 띄우므로 자리는 상관없다. */}
        {onboardingShown && (
          <ErrorBoundary>
            <Suspense fallback={null}>
              <LazyOnboardingWizard />
            </Suspense>
          </ErrorBoundary>
        )}
        <div
          className={focusMode ? "content-canvas content-canvas--focus" : "content-canvas"}
          style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}
        >
          {/* Tab row: separate row below the window strip */}
          {chrome && <TabBar />}

          {/* Wave 2: home dashboard replaces note title + source/editor split entirely. */}
          {showHome ? (
            <HomeTab />
          ) : (
            <>
              {/* 타이틀 = 헤더 크롬(SINGLE-SHEET ACRYLIC CONTRACT): 탭바와 같은 in-flow 크롬이라
                  배경을 칠하지 않는다 — `.app` 의 시트(flat=불투명, acrylic=단일 반투명 틴트)가 그대로
                  비친다.
                  W23: 제목-스트립 아래 구분선 — content-canvas 안쪽이라 캔버스 외곽선과 겹치지
                  않는다(오너 확정). 래퍼가 캔버스 전폭이라 양끝이 캔버스 외곽선 안쪽 면에 자동으로
                  닿는다(풀블리드). TitleBar 컴포넌트 내부는 건드리지 않는다. */}
              <div style={{ flex: "none", margin: 0, height: "var(--row-header)", borderBottom: "1px solid var(--divider)" }}>
                {/* W13: boundary wraps TitleBar from the outside — its own internals stay untouched
                    (hook-order pitfall, CLAUDE.md 함정 #1). A crash here used to bubble to the root
                    boundary and blank the whole window. */}
                <ErrorBoundary fallbackTitle={t("common.boundary_titlebar")}>
                  <TitleBar />
                </ErrorBoundary>
              </div>

              {/* body split: source | editor */}
              <div
                ref={bodyRef}
                style={{
                  flex: 1,
                  minHeight: 0,
                  display: "flex",
                  flexDirection: "row-reverse", // 어시스트(SourcePanel) 컬럼을 우측에 둔다
                  padding: focusMode ? "8px var(--focus-inset) 20px" : 0,
                }}
              >
                {!focusMode && (
                  <div
                    style={{
                      // W22 ⑫: 드래그 중 접힘 프리뷰 — splitDragCollapsing이면 실제 접힘 폭(28px,
                      // SourcePanel의 collapsed rail과 동일)으로 즉시 줄여 보여주되 previewCollapsed/
                      // sourcePct는 mouseup까지 건드리지 않는다(leftpanel의 width:0 프리뷰와 같은 문법).
                      width: previewCollapsed ? "auto" : splitDragCollapsing ? 28 : `${sourcePct}%`,
                      flex: "none",
                      minWidth: 0,
                      display: "flex",
                      position: "relative",
                    }}
                  >
                    {/* W24: 클립은 이 안쪽 레이어가 소유(leftpanel과 같은 패턴 — 바깥에서 clip하면
                        right:-5 그립 오버레이까지 잘린다). 내용은 드래그 최소폭(180px) 아래로
                        리플로우하지 않는다 — 접힘 프리뷰(28px)에서 내용이 그 폭에 맞춰 세로로
                        구겨지던("찌그러짐") 원인은 클립이 아니라 리플로우였다. 이제 내용은 180px
                        레이아웃을 유지한 채 잘려 나간다. 접힘 상태(rail 28px)는 최소폭 미적용. */}
                    <div style={{ flex: 1, minWidth: 0, overflow: "hidden", display: "flex" }}>
                      {/* 프리뷰 중 내용 페이드아웃(오너) — 잘린 텍스트가 커튼 뒤에 남아 보이는 것도
                          거슬린다. 접힘이 확정될 상태임을 "비워지는 폭"으로 보여준다. */}
                      <div
                        style={{
                          flex: 1,
                          minWidth: previewCollapsed ? 0 : SPLIT_MIN_W,
                          display: "flex",
                          opacity: splitDragCollapsing ? 0 : 1,
                          transition: "opacity var(--dur-med) ease",
                        }}
                      >
                        <SourcePanel />
                      </div>
                    </div>
                    {/* W24 구조 개편(오너: 땜빵 대신 구조로): 예전 10px 인플로우 rgrip은 레이아웃
                        공간을 차지하고 경계선이 그 가운데 떠 있어, 에디터 컬럼의 모든 가로선(섹션
                        탭·툴바·상태줄)이 경계선에서 5px 끊겼다(W23 D1 브리지는 그중 한 줄만 잇던
                        땜빵 — 삭제). 이제 경계선은 에디터 래퍼의 borderLeft가 소유하고, 그립은
                        사이드바 그립과 같은 문법의 레이아웃 밖 절대배치 히트존이다 — 선과 살짝
                        떨어진 rbar가 hover에서 발광하는 공용 어포던스(.rgrip .rbar, tokens.css). */}
                    {!previewCollapsed && !uiLock && (
                      <div
                        className="rgrip"
                        onMouseDown={onSplitDown}
                        style={{
                          position: "absolute",
                          top: 0,
                          bottom: 0,
                          left: -5,
                          width: 10,
                          display: "grid",
                          placeItems: "center",
                          cursor: "col-resize",
                          zIndex: "var(--z-dropdown)",
                        }}
                      >
                        {/* W24: 바를 선에 겹치지 않게 어시스트 쪽으로 4px 이동 — 바 오른끝과
                            경계선 사이 3px, 첨부 그립(선 아래 ~3px)과 같은 간격 언어. */}
                        <div className="rbar" style={{ width: 2, height: 40, marginLeft: 8 }} />
                      </div>
                    )}
                  </div>
                )}

                <div
                  // W22 ②: 워크스페이스 내부 평탄화 — .card/.card-reading 제거, 외곽선은 content-canvas
                  // 하나로 통일(SINGLE-SHEET ACRYLIC CONTRACT: 배경은 계속 칠하지 않는다).
                  // W24: 어시스트/에디터 경계선을 이 래퍼의 borderLeft로 — 접힘 레일에서도 상시
                  // 유지(W22 ⑧ 요구가 구조로 충족), 에디터 내부 가로선들이 전부 이 선에 닿는다.
                  style={{
                    flex: 1,
                    minWidth: 0,
                    display: "flex",
                    flexDirection: "column",
                    overflow: "hidden",
                    borderRight: focusMode ? undefined : "1px solid var(--divider)",
                  }}
                >
                  <ErrorBoundary>
                    <React.Suspense fallback={null}>
                      <EditorPanel />
                    </React.Suspense>
                  </ErrorBoundary>
                </div>
              </div>

              {chrome && <AttachmentsBar />}
            </>
          )}
        </div>
      </div>

      <ContextMenu />
      {/* Lazy-loaded global modals hosted under ErrorBoundary and Suspense */}
      <GlobalModalsHost
        browser={browser}
        browserSettingsOpen={browserSettingsOpen}
        onCloseBrowserSettings={() => setBrowserSettingsOpen(false)}
      />
      {!browser && <PetChatPlanReviewBridge />}
      {!browser && petEnabled && <PetSuggestionReviewBridge />}
    </div>
    {/* W5: 태블릿 세로 안내 — CSS 전용(tokens.css), JS 0줄·상태 0개. pointer:coarse 가 아니면
        (Tauri 데스크톱 포함) 이 media query 자체가 성립하지 않아 항상 숨어 있다(D3). */}
    <div className="tablet-portrait-banner overlay">{t("common.tablet_rotate_hint")}</div>
    </>
  );
}

export default App;
