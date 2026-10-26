import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ReactFlowProvider, useReactFlow } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./GraphTab.css";
import { call, callSilent } from "../../../lib/invoke";
import { insertAiSection } from "../../../lib/aiSectionBridge";
import { addInternalAttachment, removeInternalBacklink } from "../../../lib/attachmentService";
import type {
  NoteDetail,
  Suggestion,
  SuggestionsListOutput,
} from "../../../lib/commands.gen";
import { folderColorCss, snippetText } from "../../../lib/ui";
import { t } from "../../../i18n/t";
import { useNotesStore, displayTitle } from "../../../stores/notes";
import { useAiStore } from "../../../stores/ai";
import { useSettingsStore } from "../../../stores/settings";
import { useUiStore } from "../../../stores/ui";
import { GraphCanvas, type DashboardGraphEdge, type DashboardGraphResult } from "./GraphCanvas";
import { GraphSuggestionsPanel } from "./GraphSuggestionsPanel";
import { linkName, useGraphConnect } from "./useGraphConnect";
import { CheatsheetPopover, Gesture, Key, Sep, type CheatsheetItem } from "../../common/CheatsheetPopover";
import { useDashboardSearchHits } from "../useDashboardSearchHits";
import { useDashboardReveal } from "../useDashboardReveal";
import { useActiveTabResize } from "../useActiveTabResize";
import {
  IconClose,
  IconExternalLink,
  IconGrab,
  IconMaximize2,
  IconMinus,
  IconMouse,
  IconMouseDoubleClick,
  IconMousePointerClick,
  IconPlus,
  IconSparkles,
} from "../../icons";

function GraphRailLeft({
  result,
  visibleNodesCount,
  visibleEdgesCount,
  suggestionsCount,
  onShowSuggestions,
}: {
  result: DashboardGraphResult | null;
  visibleNodesCount: number;
  visibleEdgesCount: number;
  /** 선택이 있을 때만 0 보다 크게 넘긴다 — 선택이 없으면 우측 패널이 이미 제안 목록이다(R9). */
  suggestionsCount: number;
  /** 칩 = 건수 바로가기. 선택을 풀어 우측 패널이 제안 목록으로 돌아가게 한다. */
  onShowSuggestions: () => void;
}) {
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const showOverlay = Boolean(result?.capped || result?.edges_capped || suggestionsCount > 0);

  return (
    <div className="dashboard-rail-left" data-testid="graph-rail-left">
      <div className="dashboard-rail-left__top">
        {showOverlay && (
          <div className="graph-overlay" data-testid="graph-overlay">
            {result?.capped && <span>{t("home.graph_top_k", { total: result.total, shown: visibleNodesCount })}</span>}
            {result?.edges_capped && (
              <span>{t("home.graph_edges_capped", { total: result.edge_total, shown: visibleEdgesCount })}</span>
            )}
            {suggestionsCount > 0 && (
              <button type="button" className="graph-suggestion-chip" onClick={onShowSuggestions}>
                {t("home.graph_suggestions", { count: suggestionsCount })}
              </button>
            )}
          </div>
        )}
      </div>

      <div className="dashboard-rail-left__bottom">
        <div className="dashboard-zoom-controls" data-testid="graph-zoom-controls">
          <button
            type="button"
            className="icon-btn icon-btn--sm icon-btn--glow"
            title={t("home.graph_zoom_in")}
            aria-label={t("home.graph_zoom_in")}
            onClick={() => void zoomIn()}
          >
            <IconPlus size={14} />
          </button>
          <button
            type="button"
            className="icon-btn icon-btn--sm icon-btn--glow"
            title={t("home.graph_zoom_out")}
            aria-label={t("home.graph_zoom_out")}
            onClick={() => void zoomOut()}
          >
            <IconMinus size={14} />
          </button>
          <button
            type="button"
            className="icon-btn icon-btn--sm icon-btn--glow"
            title={t("home.graph_zoom_fit")}
            aria-label={t("home.graph_zoom_fit")}
            onClick={() => void fitView({ padding: 0.28, maxZoom: 1.1, duration: 250 })}
          >
            <IconMaximize2 size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}

/** 우하단 ? 치트시트 — CheatsheetPopover 계약(EditorPanel/DiagramSection 선례): 실제로 동작이
 *  확인된 제스처만 싣는다. 전부 GraphCanvas 의 핸들러에서 나온 목록이다. */
function graphGestures(): CheatsheetItem[] {
  return [
    {
      rule: [Gesture(IconGrab, t("common.gesture_drag")), Sep("·"), Gesture(IconMouse, t("common.gesture_wheel"))],
      desc: t("home.graph_cs_pan_desc"),
    },
    {
      rule: [
        Gesture(IconMousePointerClick, t("common.gesture_click")),
        Sep("·"),
        Key(t("common.key_shift")),
        Sep("+"),
        Gesture(IconMousePointerClick, t("common.gesture_click")),
      ],
      desc: t("home.graph_cs_select_desc"),
    },
    { rule: [Gesture(IconMouseDoubleClick, t("common.gesture_dbl_click"))], desc: t("home.graph_cs_open_desc") },
    { rule: [Gesture(IconGrab, t("home.graph_cs_connect_rule"))], desc: t("home.graph_cs_connect_desc") },
    { rule: [Gesture(IconClose, t("home.graph_cs_cut_rule"))], desc: t("home.graph_cs_cut_desc") },
    {
      rule: [Key(t("common.key_alt")), Sep("+"), Gesture(IconGrab, t("common.gesture_drag"))],
      desc: t("home.graph_cs_laser_desc"),
    },
  ];
}

export function GraphTab({ active = true }: { active?: boolean } = {}) {
  useActiveTabResize(active);
  const workspaceId = useSettingsStore((state) => state.activeWorkspaceId);
  const folders = useNotesStore((state) => state.folders);
  const selectNote = useNotesStore((state) => state.selectNote);
  const loadTree = useNotesStore((state) => state.loadTree);
  const searchHits = useDashboardSearchHits();
  const aiEnabled = useSettingsStore((state) => state.aiEnabled);
  const aiPending = useAiStore((state) => state.promptPending);
  const [result, setResult] = useState<DashboardGraphResult | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // 그래프 로드 뒤 첫 제안 조회가 끝났는가 — 그 전에는 패널이 "제안 없음"을 단정하지 않는다.
  const [suggestionsReady, setSuggestionsReady] = useState(false);
  // 제안 카드 호버/포커스 — 그 쌍만 그래프에서 밝게 남긴다(highlightIds).
  const [hoveredSuggestionId, setHoveredSuggestionId] = useState<string | null>(null);
  // Dashboard-wide folder filter (nav row dot control, stores/ui.ts) — replaces the old local
  // useState + the graph-legend folder bubbles. Removal (not dim) semantics below (`visible`,
  // `neighbours`) are unchanged from before the move.
  const folderFilter = useUiStore((state) => state.dashboardFolderFilter);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const requestGeneration = useRef(0);
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelPendingClick = useCallback(() => {
    if (clickTimer.current != null) clearTimeout(clickTimer.current);
    clickTimer.current = null;
  }, []);

  // latest-wins: generation 가드는 워크스페이스 전환 같은 "세대" 교체만 막는다. 같은 세대 안에서
  // 연결/절단이 연달아 refetch 를 쏘면 먼저 시작한(=구버전 스냅샷) 응답이 늦게 도착해 최신 결과를
  // 덮어쓸 수 있다 — 그 스냅샷에는 방금 만든 엣지·노트가 없어서, stabilizePositions 가 이를
  // "절단"으로 오판해 유령 밀어내기 애니메이션을 만들고 새 노트는 화면에서 사라졌다(2026-08-20
  // 오너 실기 버그 2건의 공통 뿌리). 단조 증가 seq 로 마지막에 시작한 요청만 반영한다.
  const fetchSeqRef = useRef(0);
  // 제안 조회도 같은 latest-wins — 수락/무시의 낙관적 제거 직전에 출발한 옛 응답이 뒤늦게 와서
  // 방금 뺀 카드를 되살리지 않게 한다. resolveSuggestion 이 제거·확정 시점에 seq 를 올려 그 전에
  // 출발한 응답을 버리고, 처리 중인 id 는 resolvingIdsRef 로 걸러 확정 전에 출발한 응답도 막는다.
  const suggestionsSeqRef = useRef(0);
  const resolvingIdsRef = useRef<Set<string>>(new Set());
  const loadSuggestions = useCallback(async (generation = requestGeneration.current) => {
    if (!workspaceId) {
      if (requestGeneration.current === generation) {
        setSuggestions([]);
        setSuggestionsReady(true);
      }
      return;
    }
    const seq = ++suggestionsSeqRef.current;
    try {
      // 선택적 조회 — 그래프 재조회마다 돈다. 실패는 logError 에 남기고 토스트는 띄우지 않는다(함정 8).
      const response = await callSilent<SuggestionsListOutput>("suggestions_list", { workspace_id: workspaceId, status: "pending" });
      if (requestGeneration.current === generation && suggestionsSeqRef.current === seq) {
        setSuggestions(response.suggestions.filter(
          (suggestion) => suggestion.kind === "overlap" && !resolvingIdsRef.current.has(suggestion.id),
        ));
        setSuggestionsReady(true);
      }
    } catch {
      // Suggestions are optional; a polling failure must not hide the graph (callSilent logged it).
    }
  }, [workspaceId]);

  // 제안(kind='overlap') 행은 dashboard_graph 가 연관 엣지를 계산하면서 쓴다 — 그래서 제안은
  // 그래프가 끝난 **뒤에** 읽는다(GRILL-2026-10-19 코디네이터 결정). 같이 쏘면 첫 진입에서 제안이
  // 0건으로 보였다. 연결·절단·수락·무시 뒤의 다시 읽기도 전부 loadGraph 를 지나므로 여기 한 곳이다.
  const loadGraph = useCallback(async (generation = requestGeneration.current) => {
    if (!workspaceId) {
      if (requestGeneration.current !== generation) return;
      setResult({ nodes: [], edges: [], total: 0, cap: 500, capped: false, edge_total: 0, edge_cap: 2500, edges_capped: false });
      setLoading(false);
      setError(false);
      void loadSuggestions(generation);
      return;
    }
    const seq = ++fetchSeqRef.current;
    setLoading(true);
    setError(false);
    try {
      const next = await call<DashboardGraphResult>("dashboard_graph", { workspace_id: workspaceId });
      if (requestGeneration.current === generation && fetchSeqRef.current === seq) setResult(next);
    } catch {
      if (requestGeneration.current === generation && fetchSeqRef.current === seq) setError(true);
    } finally {
      if (requestGeneration.current === generation && fetchSeqRef.current === seq) setLoading(false);
    }
    // 그래프가 실패해도 이미 쌓인 제안 행은 읽는다. 늦게 끝난 옛 요청(seq 뒤처짐)은 건너뛴다 —
    // 최신 요청이 끝나면서 어차피 다시 읽는다.
    if (requestGeneration.current === generation && fetchSeqRef.current === seq) void loadSuggestions(generation);
  }, [loadSuggestions, workspaceId]);

  // 연결·절단 후의 refetch 는 전부 이 디바운스를 탄다 — 레이저 한 스트로크가 엣지 N개를 자르거나
  // 연결을 연달아 만들 때 refetch 를 한 번으로 묶는다(위 latest-wins 의 1차 방어선). 즉시성이
  // 필요한 경로(생성 직후 선택 등)만 loadGraph 를 직접 await 한다.
  const reloadDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 레이저 스트로크 도중에는 그래프를 다시 그리지 않는다. 컷 하나로 재배치가 돌면 노드가 새
  // 위치로 날아가는데, 그 사이 아직 눌려 있는 레이저 선분 위로 **엣지가 스스로 지나가** 자르지도
  // 않은 링크가 연달아 잘린다 — 한 번 잘랐는데 컷 애니메이션이 여러 군데서 터지던 실기 버그의
  // 정체다(2026-08-20 오너). 커서가 선을 지나야 컷이지, 선이 커서를 지나는 건 컷이 아니다.
  const laserActiveRef = useRef(false);
  const reloadPendingRef = useRef(false);
  const scheduleGraphReload = useCallback(() => {
    if (laserActiveRef.current) {
      reloadPendingRef.current = true;
      return;
    }
    if (reloadDebounceRef.current) clearTimeout(reloadDebounceRef.current);
    reloadDebounceRef.current = setTimeout(() => {
      reloadDebounceRef.current = null;
      void loadGraph();
    }, 120);
  }, [loadGraph]);

  const handleLaserActiveChange = useCallback((active: boolean) => {
    laserActiveRef.current = active;
    if (!active && reloadPendingRef.current) {
      reloadPendingRef.current = false;
      scheduleGraphReload();
    }
  }, [scheduleGraphReload]);
  useEffect(() => () => {
    if (reloadDebounceRef.current) clearTimeout(reloadDebounceRef.current);
  }, []);

  // 노트끼리 연결 한 벌(링크 첨부 + in-flight 잠금 + 방금 만든 엣지 표식). 워크스페이스 전환 초기화가
  // 아래 effect 에서 resetConnect 를 부르므로 그 effect 보다 먼저 선언한다.
  const { justCreatedKeys, markJustCreated, resetConnect, connectNote, connectMany, connectAmong } =
    useGraphConnect({
      nodes: result?.nodes,
      edges: result?.edges,
      loading,
      scheduleGraphReload,
    });

  // Reveal handler (search-hit "go to note" navigation) — selects the node on the graph.
  // Shared consumption/tab-guard ordering lives in useDashboardReveal (fixes stale replay: see
  // that file's doc comment).
  useDashboardReveal("graph", setSelectedId);

  useEffect(() => {
    const generation = ++requestGeneration.current;

    setResult(null);
    setSuggestions([]);
    setSuggestionsReady(false);
    setHoveredSuggestionId(null);
    setSelectedId(null);
    setSelectedIds(new Set());
    setLoading(true);
    setError(false);
    resetConnect();
    cancelPendingClick();
    // 제안은 loadGraph 가 끝나며 읽는다(loadGraph 주석).
    void loadGraph(generation);
    return () => {
      cancelPendingClick();
      if (requestGeneration.current === generation) requestGeneration.current += 1;
    };
  }, [cancelPendingClick, loadGraph, resetConnect]);

  const selectAfterClick = useCallback((id: string, isMulti = false) => {
    cancelPendingClick();
    if (!id) {
      setSelectedId(null);
      setSelectedIds(new Set());
      return;
    }
    if (isMulti) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) {
          next.delete(id);
        } else {
          next.add(id);
        }
        if (next.size === 1) {
          setSelectedId(Array.from(next)[0]);
        } else {
          setSelectedId(null);
        }
        return next;
      });
      return;
    }
    clickTimer.current = setTimeout(() => {
      clickTimer.current = null;
      setSelectedId(id);
      setSelectedIds(new Set([id]));
    }, 220);
  }, [cancelPendingClick]);

  // 선택 전부 해제 — 우측 패널이 연결 제안 목록으로 돌아간다(R9). 선택 패널의 닫기와 ✦ 칩이 쓴다.
  // selectedId 만 비우면 selectedIds 에 남은 한 개 때문에 노드는 여전히 선택돼 보이고 패널은
  // 다중 선택 안내로 빠진다.
  const clearSelection = useCallback(() => {
    cancelPendingClick();
    setSelectedId(null);
    setSelectedIds(new Set());
  }, [cancelPendingClick]);

  /** 낙관적으로 뺀 제안 카드를 원래 자리에 되돌린다(함정 9) — 그 사이 목록이 다시 읽혀 이미
   *  들어와 있으면 두 번 넣지 않는다. */
  const restoreSuggestion = useCallback((suggestion: Suggestion, index: number) => {
    setSuggestions((current) => {
      if (current.some((item) => item.id === suggestion.id)) return current;
      const next = current.slice();
      next.splice(Math.min(Math.max(index, 0), next.length), 0, suggestion);
      return next;
    });
  }, []);

  /** 수락·무시 공통 — 카드를 먼저 빼고(낙관적), 실패하면 되돌린다. 성공하면 그래프를 다시 읽고
   *  (수락 = 백링크가 생김, 무시 = 연관 쌍이 점수에서 빠짐) 제안은 loadGraph 끝에서 다시 읽힌다. */
  const resolveSuggestion = async (
    suggestion: Suggestion,
    command: "graph_suggestion_accept" | "graph_suggestion_dismiss",
  ) => {
    const generation = requestGeneration.current;
    const index = suggestions.findIndex((item) => item.id === suggestion.id);
    // 이미 출발한 제안 조회(그 스냅샷엔 이 카드가 있다)를 버리고, 확정 전까지 새 조회에서도 거른다.
    resolvingIdsRef.current.add(suggestion.id);
    suggestionsSeqRef.current += 1;
    setSuggestions((current) => current.filter((item) => item.id !== suggestion.id));
    setHoveredSuggestionId((current) => (current === suggestion.id ? null : current));
    let failed = false;
    try {
      await call(command, { id: suggestion.id });
    } catch {
      failed = true;
    } finally {
      // 확정(또는 실패) 전에 출발한 조회는 커밋 전 스냅샷일 수 있다 — 버린다.
      resolvingIdsRef.current.delete(suggestion.id);
      suggestionsSeqRef.current += 1;
    }
    if (failed) {
      // call() 이 토스트로 알렸다 — 화면이 데이터에 대해 거짓말하지 않게 카드를 되돌린다.
      if (requestGeneration.current === generation) {
        restoreSuggestion(suggestion, index);
        // 위 finally 가 처리 중에 출발한 정당한 재조회(연결·절단·다른 수락)까지 버렸다 — 다시 읽는다.
        void loadSuggestions(generation);
      }
      return;
    }
    if (requestGeneration.current !== generation) return;
    if (command === "graph_suggestion_accept") markJustCreated(suggestion.note_id, suggestion.related_note_id);
    await loadGraph(generation);
  };

  const visible = useMemo(() => {
    if (!result) return null;
    const nodes = result.nodes.filter((node) => {
      if (folderFilter && node.folder_id !== folderFilter) return false;
      return true;
    });
    const ids = new Set(nodes.map((node) => node.id));
    return {
      ...result,
      nodes,
      edges: result.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)),
    };
  }, [folderFilter, result]);
  const selected = result?.nodes.find((node) => node.id === selectedId) ?? null;
  const neighbours = useMemo(() => {
    if (!selected || !result) return [];
    return result.edges.flatMap((edge) => {
      if (edge.source !== selected.id && edge.target !== selected.id) return [];
      const id = edge.source === selected.id ? edge.target : edge.source;
      const node = result.nodes.find((candidate) => candidate.id === id);
      if (!node || (folderFilter && node.folder_id !== folderFilter)) return [];
      return [{ node, edge }];
    }).sort((a, b) => b.edge.weight - a.edge.weight);
  }, [folderFilter, result, selected]);
  const folderById = useMemo(() => new Map(folders.map((folder) => [folder.id, folder])), [folders]);

  useEffect(() => {
    if (!selectedId || !visible) return;
    // 선택 노드가 필터로 사라지면 선택을 통째로 푼다 — selectedId 만 비우면 selectedIds 에 남은
    // 한 개가 "선택 있음"으로 남아 패널이 제안 목록으로 돌아가지 못한다.
    // (대기 중인 클릭 선택은 건드리지 않는다 — 그건 다른 노드를 고르는 중이다.)
    if (!visible.nodes.some((node) => node.id === selectedId)) {
      setSelectedId(null);
      setSelectedIds(new Set());
    }
  }, [selectedId, visible]);

  const hasSelection = selectedId != null || selectedIds.size > 0;

  // 제안 카드 호버 → 그래프에서 그 쌍만 밝게(GraphCanvas highlightIds). 화면에 없는 노트(폴더
  // 필터·상한 밖)는 뺀다 — 둘 다 없으면 강조하지 않는다(전부 흐려지기만 하는 것을 막는다).
  const highlightIds = useMemo(() => {
    if (!hoveredSuggestionId || !visible) return null;
    const suggestion = suggestions.find((item) => item.id === hoveredSuggestionId);
    if (!suggestion) return null;
    const pair = [suggestion.note_id, suggestion.related_note_id];
    const ids = new Set(pair.filter((id) => visible.nodes.some((node) => node.id === id)));
    return ids.size > 0 ? ids : null;
  }, [hoveredSuggestionId, suggestions, visible]);

  const createInsight = async () => {
    if (!selected || !aiEnabled) return;
    const targetNoteId = selected.id;
    const context = [selected, ...neighbours.map(({ node }) => node)]
      .map((node) => `${node.title} (${node.year})\n${snippetText(node.snippet)}`)
      .join("\n\n");
    try {
      const generated = await useAiStore.getState().generateFromPrompt(
        t("home.graph_ai_prompt"),
        context,
      );
      if (!generated) return;
      await insertAiSection(t("home.graph_ai_insight"), generated, targetNoteId);
    } catch {
      // AI/store and section owner already report their own failures; the button stays retryable.
    }
  };

  const getFolderColor = useCallback((noteId: string) => {
    const node = result?.nodes.find((n) => n.id === noteId);
    if (node) {
      const folder = folderById.get(node.folder_id);
      if (folder && folder.color_hue != null) return folderColorCss(folder.color_hue);
    }
    return "var(--muted)";
  }, [folderById, result?.nodes]);

  const handleConnectSelected = useCallback(
    () => connectAmong(Array.from(selectedIds)),
    [connectAmong, selectedIds],
  );

  const handleCreateNoteAndConnect = useCallback(
    async (sourceIds: string[]) => {
      if (!sourceIds || sourceIds.length === 0) return;
      try {
        const created = await call<NoteDetail>("note_create", {
          title: "",
        });
        const newNoteId = created.note.id;
        const name = linkName(created.note);

        for (const sId of sourceIds) {
          if (sId === newNoteId) continue;
          await addInternalAttachment(sId, newNoteId, name);
          markJustCreated(sId, newNoteId);
        }

        await loadTree();
        await loadGraph();
        selectAfterClick(newNoteId, false);
      } catch {
        // Handled/reported by invoke call
      }
    },
    [markJustCreated, loadGraph, loadTree, selectAfterClick],
  );

  const handleCutEdge = useCallback(
    async (edge: DashboardGraphEdge) => {
      if (edge.kind !== "backlink") return;
      const res = await removeInternalBacklink(edge.source, edge.target, {
        onRestored: () => {
          markJustCreated(edge.source, edge.target);
          scheduleGraphReload();
        },
      });
      if (res.removed) {
        scheduleGraphReload();
      }
    },
    [markJustCreated, scheduleGraphReload],
  );

  return (
    <div className="graph-tab" data-testid="graph-tab">
      <div className="graph-main">
        <div className="graph-canvas">
          {loading && !result && <div className="graph-state">{t("home.graph_loading")}</div>}
          {error && !result && <div className="graph-state"><button type="button" onClick={() => void loadGraph()}>{t("home.graph_retry")}</button></div>}
          {!loading && !error && visible && visible.nodes.length === 0 && <div className="graph-state">{t("home.graph_empty")}</div>}
          {visible && visible.nodes.length > 0 && (
            <ReactFlowProvider>
              <GraphCanvas
                result={visible}
                folders={folders}
                selectedId={selectedId}
                selectedIds={selectedIds}
                searchHits={searchHits}
                highlightIds={highlightIds}
                justCreatedKeys={justCreatedKeys}
                onSelect={selectAfterClick}
                onOpen={(id) => {
                  cancelPendingClick();
                  void selectNote(id);
                }}
                onConnectNote={connectNote}
                onConnectMultipleNotes={connectMany}
                onCreateNoteAndConnect={handleCreateNoteAndConnect}
                onCutEdge={handleCutEdge}
                onLaserActiveChange={handleLaserActiveChange}
              />
              {selectedIds.size >= 2 && (
                <div className="graph-multi-action-bar" data-testid="graph-multi-action-bar">
                  <span className="graph-multi-count">
                    {t("selection.n_selected", { n: selectedIds.size })}
                  </span>
                  <button
                    type="button"
                    className="graph-multi-btn graph-multi-btn--primary"
                    data-testid="graph-multi-connect-btn"
                    onClick={handleConnectSelected}
                  >
                    <IconPlus size={13} strokeWidth={2.2} />
                    <span>{t("home.graph_connect_selected")}</span>
                  </button>
                  <button
                    type="button"
                    className="graph-multi-btn"
                    data-testid="graph-multi-clear-btn"
                    onClick={clearSelection}
                  >
                    <IconClose size={13} strokeWidth={2.2} />
                    <span>{t("selection.clear")}</span>
                  </button>
                </div>
              )}
              <GraphRailLeft
                result={result}
                visibleNodesCount={visible.nodes.length}
                visibleEdgesCount={visible.edges.length}
                suggestionsCount={hasSelection ? suggestions.length : 0}
                onShowSuggestions={clearSelection}
              />
            </ReactFlowProvider>
          )}
          {/* 2026-08-20 오너: 제스처(Alt+드래그 컷 등)는 발견 가능성이 없다 — 에디터 하단 ? 와
              같은 CheatsheetPopover 를 우하단에 상시 노출. 목록은 GraphCanvas 실제 핸들러 기준. */}
          <div style={{ position: "absolute", right: "var(--space-4)", bottom: "var(--space-4)", zIndex: "var(--z-overlay)" }}>
            <CheatsheetPopover title={t("home.graph_cheatsheet_title")} items={graphGestures()} />
          </div>
        </div>
        <aside
          className="dashboard-rail"
          data-testid="graph-rail"
          aria-label={selected ? displayTitle(selected.title) : hasSelection ? t("home.graph_filters") : t("home.graph_suggestions_title")}
        >
          {selected ? (
            <div className="dashboard-detail">
              <header>
                {(() => {
                  const folder = folderById.get(selected.folder_id);
                  const color = folder?.color_hue == null ? "var(--muted)" : folderColorCss(folder.color_hue);
                  return <span className="dashboard-folder-chip"><i style={{ background: color }} />{folder?.name ?? "—"}</span>;
                })()}
                <div className="dashboard-detail-actions">
                  <button
                    type="button"
                    className="icon-btn icon-btn--sm icon-btn--glow"
                    data-testid="graph-open-selected"
                    title={t("home.graph_open_note")}
                    aria-label={t("home.graph_open_note")}
                    onClick={() => {
                      cancelPendingClick();
                      void selectNote(selected.id);
                    }}
                  >
                    <IconExternalLink size={13} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn icon-btn--sm icon-btn--glow"
                    aria-label={t("home.graph_close")}
                    title={t("home.graph_close")}
                    onClick={clearSelection}
                  >
                    <IconClose size={13} strokeWidth={2} />
                  </button>
                </div>
              </header>
              <h2>{displayTitle(selected.title)}</h2>
              <time>{selected.year}</time>
              <p className="dashboard-snippet">{snippetText(selected.snippet)}</p>
              {/* 예전 제안 모달의 바닥 버튼(R9) — 선택 노트 + 연관 노트로 인사이트를 만든다. */}
              <button
                type="button"
                className="graph-insight-button"
                data-testid="graph-ai-insight"
                disabled={!aiEnabled || !selected || aiPending}
                onClick={() => void createInsight()}
              >
                <IconSparkles size={13} />
                <span>{t("home.graph_ai_insight")}</span>
              </button>
              <h3>{t("home.graph_related")} {neighbours.length}</h3>
              <div className="dashboard-list">
                {neighbours.map(({ node, edge }) => {
                  const folder = folderById.get(node.folder_id);
                  const color = folder?.color_hue == null ? "var(--muted)" : folderColorCss(folder.color_hue);
                  return (
                    <button
                      type="button"
                      key={`${edge.source}:${edge.target}:${edge.kind}`}
                      data-search-dim={searchHits !== null && !searchHits.has(node.id) ? "true" : undefined}
                      onClick={() => {
                        cancelPendingClick();
                        setSelectedId(node.id);
                      }}
                      onDoubleClick={() => {
                        cancelPendingClick();
                        void selectNote(node.id);
                      }}
                    >
                      <i style={{ background: color }} />
                      <span>{displayTitle(node.title)}</span>
                      <small>{edge.weight}</small>
                      <em data-kind={edge.kind}>{t(`home.graph_${edge.kind}`)}</em>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : hasSelection ? (
            // 다중 선택 중 — 제안 목록 대신 안내만(목록이 다중 선택 동작과 섞이지 않게).
            <p className="dashboard-select-hint">{t("home.graph_select_hint")}</p>
          ) : (
            <GraphSuggestionsPanel
              suggestions={suggestions}
              ready={suggestionsReady}
              getFolderColor={getFolderColor}
              onAccept={(suggestion) => void resolveSuggestion(suggestion, "graph_suggestion_accept")}
              onDismiss={(suggestion) => void resolveSuggestion(suggestion, "graph_suggestion_dismiss")}
              onHover={setHoveredSuggestionId}
            />
          )}
        </aside>
      </div>
    </div>
  );
}
