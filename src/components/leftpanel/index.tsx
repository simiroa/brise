import React, { useCallback, useEffect, useRef, useState } from "react";
import { useNotesStore } from "../../stores/notes";
import { useSettingsStore } from "../../stores/settings";
import { useSearchStore } from "../../stores/search";
import { useUiStore } from "../../stores/ui";
import { callSilent } from "../../lib/invoke";
import { IconPlus } from "../icons";
import { t } from "../../i18n/t";
import { clamp } from "../../lib/ui";
import { SearchBox } from "./SearchBox";
import { YearFilter } from "./YearFilter";
import { ActiveFilterChips } from "./ActiveFilterChips";
import { NoteTree } from "./notetree/index";
import { ExpandedFilterView } from "./expanded";
import { RegionExpanded } from "./expanded/RegionExpanded";
import { useWorkspacesStore } from "../../stores/workspaces";
import { WorkspaceSwitcher } from "../WorkspaceSwitcher";
import { AiActionButton } from "./AiActionButton";

// Task B (auto-collapse): drag the grip below COLLAPSE_ENTER and the sidebar folds away live
// instead of shrinking into an unusable sliver. COLLAPSE_EXIT sits above COLLAPSE_ENTER so the
// two form a dead zone below the 180px usable minimum — dragging back and forth right around a
// single threshold would otherwise flap open/closed every pixel; two thresholds fix that.
const COLLAPSE_ENTER = 120;
const COLLAPSE_EXIT = 160;

/* ── Left panel shell ── */
export function LeftPanel() {
  const leftWidth = useSettingsStore((s) => s.leftWidth);
  const setLeftWidth = useSettingsStore((s) => s.setLeftWidth);
  const uiLock = useSettingsStore((s) => s.uiLock);
  const toggleSidebarCollapsed = useUiStore((s) => s.toggleSidebarCollapsed);
  const newNote = useNotesStore((s) => s.newNote);
  const filterMode = useSearchStore((s) => s.filterMode);
  // 지도 보기는 한 번 열면 숨긴 채 살려 둔다 — 탭을 오갈 때마다 MapLibre(WebGL 컨텍스트·셰이더·
  // 스타일)를 새로 만들면 클릭마다 0.3~0.6 s 메인 스레드가 멈췄다(2026-10-22, 1만 노트 릴리즈 실측).
  // 숨은 동안의 조회·마커 갱신은 RegionExpanded 의 active 가 멈춘다.
  const regionActive = filterMode === "region";
  const [regionKept, setRegionKept] = useState(regionActive);
  if (regionActive && !regionKept) setRegionKept(true);
  // 숨겨 둔 채 노트북(= workspace)이 바뀌면 내려놓는다 — 다음에 열 때 예전처럼 새 노트북의 기본
  // 위치에서 새로 시작하고, 지도 리스너·WebGL 컨텍스트도 이때 실제로 정리된다. 보이는 중에 바뀌면
  // 예전과 같이 그대로 둔다(보이는 지도를 다시 만들면 전환 순간에 같은 정지가 난다).
  const workspaceId = useWorkspacesStore((s) => s.activeId);
  const [keptWorkspaceId, setKeptWorkspaceId] = useState(workspaceId);
  if (workspaceId !== keptWorkspaceId) {
    setKeptWorkspaceId(workspaceId);
    if (!regionActive) setRegionKept(false);
  }
  const dragRef = useRef(false);
  const startX = useRef(0);
  const startW = useRef(324);
  // Mirrors dragCollapsing synchronously inside the mousemove handler (state updates are
  // batched/async, so a ref is what lets onMove and onUp agree on the current phase within the
  // same drag gesture).
  const collapsingRef = useRef(false);
  const [dragCollapsing, setDragCollapsing] = useState(false);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragRef.current || uiLock) return;
      e.preventDefault();
      const raw = startW.current + (e.clientX - startX.current);
      const wasCollapsing = collapsingRef.current;
      const nowCollapsing = wasCollapsing ? raw <= COLLAPSE_EXIT : raw < COLLAPSE_ENTER;
      if (nowCollapsing !== wasCollapsing) {
        collapsingRef.current = nowCollapsing;
        setDragCollapsing(nowCollapsing);
      }
      // While previewing a collapse, leave the persisted width alone — it still holds the last
      // good pre-drag value, which is exactly what should come back on the next expand.
      if (!nowCollapsing) {
        setLeftWidth(clamp(raw, 180, 460));
      }
    };
    const onUp = () => {
      if (dragRef.current) {
        dragRef.current = false;
        document.body.style.cursor = "";
        if (collapsingRef.current) {
          // Commit the preview: fold the sidebar for real. leftWidth was never written to during
          // the preview, so it's still the last good width — restoring later expands to that,
          // never to the sliver that triggered this collapse.
          collapsingRef.current = false;
          setDragCollapsing(false);
          toggleSidebarCollapsed();
        } else {
          const w = Math.max(160, useSettingsStore.getState().leftWidth);
          void callSilent("settings_set", { entries: { left_width: w } }).catch(() => {});
        }
      }
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, [uiLock, setLeftWidth, toggleSidebarCollapsed]);

  const onGripDown = useCallback(
    (e: React.MouseEvent) => {
      if (uiLock) return;
      e.preventDefault();
      dragRef.current = true;
      collapsingRef.current = false;
      setDragCollapsing(false);
      startX.current = e.clientX;
      startW.current = leftWidth;
      document.body.style.cursor = "col-resize";
    },
    [uiLock, leftWidth]
  );

  return (
    <div
      // in-flow 크롬(SINGLE-SHEET ACRYLIC CONTRACT) — 배경을 칠하지 않아 `.app` 의 시트가 그대로
      // 비친다.
      // W23 A3: 사이드바 우측 세로선 제거 — content-canvas 좌측 외곽선 + 틴트가 사이드바/본문
      // 구분을 전담한다(오너 확정, 중복 크롬 라인 정리).
      style={{
        flex: "none",
        minWidth: 0,
        width: dragCollapsing ? 0 : leftWidth,
        height: "100%",
        position: "relative",
      }}
    >
      {/* Collapse-preview clips content here, not on the outer box: the resize grip below sits
          at right:-3 (deliberately peeking past the sidebar's own edge) and must stay unclipped
          and clickable even while width is being animated down to 0 mid-drag. */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          width: "100%",
          height: "100%",
          overflow: "hidden",
        }}
      >
        {/* sidebar top strip: draggable so the window can be grabbed from the left side too;
            the switcher itself opts out of the drag region so clicks still work. The sidebar's
            own collapse toggle was removed — the one in the main window strip (App.tsx) stays
            reachable even when this panel is collapsed, so keeping a second one here was redundant. */}
        <div
          data-tauri-drag-region=""
          style={{
            display: "flex",
            alignItems: "center",
            // W23: 스트립 하단선 제거(오너 — 캔버스 외곽선이 구분 전담). W24: 48px 고정도 폐기 —
            // 선이 사라져 좌우 y 정렬 근거가 없어졌고, 오너가 "칩 위 여백 = 푸터 새노트 버튼
            // 아래 여백(--space-5)" 대칭을 요구해 높이는 패딩이 결정한다(위 12px = 사이드바
            // 최하단과 데칼코마니, 아래 6px = 검색박스와의 그룹 내 간격).
            flex: "none",
            // W24: 좌우 인셋은 이 스트립이 단독 소유(--sidebar-pad) — 검색박스·트리·푸터와 같은
            // 그리드. WorkspaceSwitcher 자체 패딩은 제거됨(이중 인셋으로 칩이 좁아지던 원인).
            padding: "var(--space-5) var(--sidebar-pad) var(--space-2)",
            boxSizing: "border-box",
          }}
        >
          <div data-tauri-drag-region="false" style={{ flex: 1, minWidth: 0 }}>
            <WorkspaceSwitcher />
          </div>
        </div>

        {/* search / filter — horizontal inset shared with the switcher/tree/footer via --sidebar-pad.
            bottom 간격을 줄여(space-5→space-2) 필터 예약 높이를 키운 만큼 트리와의 틈을 좁힌다. */}
        <div style={{ padding: "0 var(--sidebar-pad) var(--space-2)" }}>
          <SearchBox hideFilterChrome={filterMode === "chat"} />
          <ActiveFilterChips />
          <YearFilter />
        </div>

        {/* 보기 칸 스택: 지도 칸은 숨을 때 같은 상자에 겹쳐(absolute) visibility 로만 감춘다 —
            display:none 이면 MapLibre 가 0×0 을 보고 캔버스를 줄였다가 보일 때 다시 키운다. */}
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", position: "relative" }}>
          {!regionActive && (
            <div
              key={filterMode}
              className="sidebar-view-pane"
            >
              {filterMode === "tree" ? <NoteTree /> : <ExpandedFilterView />}
            </div>
          )}
          {regionKept && (
            <div
              className="sidebar-view-pane"
              data-testid="region-view-pane"
              aria-hidden={regionActive ? undefined : true}
              inert={!regionActive}
              style={
                regionActive
                  ? undefined
                  : { position: "absolute", inset: 0, visibility: "hidden", pointerEvents: "none" }
              }
            >
              <RegionExpanded active={regionActive} deferMap />
            </div>
          )}
        </div>

        {/* new note — 빈 노트(주 버튼) + AI 액션(보조 버튼). 예전 "템플릿으로 새 노트" 진입점은
            제거됐다(SourcePanel 미리보기 임베드·트리 헤더 진입점이 같은 프리셋 목록을 이미 커버해
            중복이었다) — 그 자리를 menuActionPresets() 드롭다운으로 대체한다. */}
        {/* W24 위생: 하드코딩 px → 토큰(12=--space-5, 6=--space-2, 10/14=--space-4/6;
            버튼 폰트 14px는 사다리에 없어 --text-md(13px)로 한 단계 내림 — 사다리 준수 우선). */}
        <div style={{ padding: "var(--space-5) var(--sidebar-pad)", borderTop: "1px solid var(--line)" }}>
          <div style={{ display: "flex", gap: "var(--space-2)" }}>
          <button
            type="button"
            className="addnote"
            onClick={() => newNote().catch(console.error)}
            title={`${t("note.new_note")} (Ctrl+N)`}
            style={{
              flex: 1,
              minWidth: 0,
              display: "flex",
              alignItems: "center",
              gap: 6,
              justifyContent: "flex-start",
              cursor: "pointer",
              border: "none",
              background: "var(--accent)",
              color: "var(--on-accent)",
              borderRadius: "var(--radius-sm)",
              padding: "var(--space-4) var(--space-6)",
              fontWeight: 600,
              fontSize: "var(--text-md)",
              fontFamily: "var(--font-heading)",
            }}
          >
            <IconPlus size={16} strokeWidth={2.2} />
            {t("note.new_note")}
          </button>
          <AiActionButton />
          </div>
        </div>
      </div>

      {/* resize handle — W24: 그립 어포던스 3종 통일(오너). 예전 .lgrip 그라디언트 배경 대신
          스플릿·첨부 그립과 같은 rbar(짧은 바, hover 시 accent 발광, .rgrip .rbar 공용 규칙)를
          쓴다. 히트존은 기존처럼 레이아웃 밖 절대배치. */}
      <div
        className="rgrip"
        onMouseDown={onGripDown}
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          right: -5,
          width: 10,
          cursor: uiLock ? "not-allowed" : "col-resize",
          zIndex: "var(--z-dropdown)",
          display: uiLock ? "none" : "grid",
          placeItems: "center",
        }}
      >
        {/* W24: 바를 content-canvas 좌측 외곽선(사이드바 끝 +8px 지점) 쪽으로 4px 이동 —
            바 오른끝과 선 사이 3px, 스플릿·첨부 그립과 같은 간격 언어. */}
        <div className="rbar" style={{ width: 2, height: 40, marginLeft: 8 }} />
      </div>
    </div>
  );
}
