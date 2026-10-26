import { createElement } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useNotesStore } from "../../../stores/notes";
import { useSettingsStore } from "../../../stores/settings";
import { useSearchStore } from "../../../stores/search";
import { useUiStore } from "../../../stores/ui";
import { useAiStore } from "../../../stores/ai";
import type { NoteSummary, Suggestion } from "../../../lib/commands.gen";

const callMock = vi.fn();
const insertAiSectionMock = vi.fn();
const fitViewMock = vi.fn();
const zoomInMock = vi.fn();
const zoomOutMock = vi.fn();
const showUndoToastMock = vi.fn();

vi.mock("../../../lib/invoke", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/invoke")>()),
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
}));

vi.mock("../../../lib/aiSectionBridge", () => ({
  insertAiSection: (...args: unknown[]) => insertAiSectionMock(...args),
}));

vi.mock("../../../lib/undo", () => ({
  showUndoToast: (...args: unknown[]) => showUndoToastMock(...args),
}));

vi.mock("@xyflow/react", () => ({
  Position: { Left: "left", Right: "right" },
  ConnectionMode: { Strict: "strict", Loose: "loose" },
  Handle: () => null,
  Controls: () => null,
  BaseEdge: ({ id }: any) => createElement("path", { "data-testid": `edge-path-${id}` }),
  EdgeLabelRenderer: ({ children }: any) => createElement("div", { "data-testid": "edge-label" }, children),
  getStraightPath: () => ["M0 0", 0, 0],
  useInternalNode: () => undefined,
  ReactFlowProvider: ({ children }: { children: React.ReactNode }) => children,
  // jsdom 에는 뷰포트 변환이 없다 — flow 좌표를 그대로 화면 좌표로 본다(항등).
  useReactFlow: () => ({
    fitView: fitViewMock,
    zoomIn: zoomInMock,
    zoomOut: zoomOutMock,
    flowToScreenPosition: (p: { x: number; y: number }) => p,
  }),
  useStore: (selector: (s: any) => any) => selector({ transform: [0, 0, 1] }),
  useViewport: () => ({ x: 0, y: 0, zoom: 1 }),
  ReactFlow: ({
    nodes,
    nodeTypes,
    edges,
    edgeTypes,
    onNodeClick,
    onNodeDoubleClick,
    onNodeMouseEnter,
    onNodeMouseLeave,
    onConnect,
    onConnectStart,
    onConnectEnd,
  }: any) =>
    createElement(
      "div",
      { "data-testid": "mock-graph" },
      nodes.map((node: any) =>
        createElement(
          "button",
          {
            key: node.id,
            type: "button",
            className: node.className,
            "data-testid": `graph-node-${node.id}`,
            "data-just-connected": node.data?.justConnected ? "true" : undefined,
            "data-x": node.position?.x,
            "data-y": node.position?.y,
            onClick: (e: any) => onNodeClick?.(e || {}, node),
            onDoubleClick: () => onNodeDoubleClick?.({}, node),
            onMouseEnter: () => onNodeMouseEnter?.({}, node),
            onMouseLeave: () => onNodeMouseLeave?.({}, node),
          },
          createElement(nodeTypes.note, { data: node.data, selected: node.selected }),
        ),
      ),
      (edges || []).map((edge: any) => {
        const Comp = edgeTypes?.[edge.type] || edgeTypes?.graphEdge;
        return Comp
          ? createElement(
              "div",
              {
                key: edge.id,
                className: edge.className,
                "data-testid": `mock-edge-${edge.id}`,
                "data-just-created": edge.data?.justCreated ? "true" : undefined,
              },
              createElement(Comp, {
                id: edge.id,
                source: edge.source,
                target: edge.target,
                sourceX: 0,
                sourceY: 0,
                targetX: 100,
                targetY: 100,
                data: edge.data,
                style: edge.style,
              }),
            )
          : null;
      }),
      createElement("div", {
        "data-testid": "mock-connect-trigger",
        onClick: (e: any) => {
          if (e.target.dataset.connectSource && e.target.dataset.connectTarget) {
            onConnect?.({
              source: e.target.dataset.connectSource,
              target: e.target.dataset.connectTarget,
              sourceHandle: "s",
              targetHandle: "t",
            });
          }
        },
      }),
      createElement("div", {
        "data-testid": "mock-connect-start-trigger",
        onClick: (e: any) => {
          if (e.target.dataset.nodeId) {
            onConnectStart?.(e, { nodeId: e.target.dataset.nodeId, handleType: "source" });
          }
        },
      }),
      createElement("div", {
        "data-testid": "mock-connect-end-trigger",
        onClick: (e: any) => {
          onConnectEnd?.(e);
        },
      }),
    ),
}));

import { resetNodePositionCacheForTests, type DashboardGraphResult } from "./GraphCanvas";
import { GraphTab } from "./GraphTab";

function graph(id: string): DashboardGraphResult {
  return {
    nodes: [
      { id, folder_id: "f", title: id, year: 2026, snippet: "", degree: 1 },
      { id: `${id}-peer`, folder_id: "f", title: `${id}-peer`, year: 2026, snippet: "", degree: 1 },
    ],
    edges: [{ source: id, target: `${id}-peer`, kind: "backlink", weight: 1 }],
    total: 2,
    cap: 500,
    capped: false,
    edge_total: 1,
    edge_cap: 2500,
    edges_capped: false,
  };
}

function overlap(id: string, noteId: string, relatedId: string, extra: Partial<Suggestion> = {}): Suggestion {
  return {
    id,
    kind: "overlap",
    note_id: noteId,
    note_title: noteId,
    related_note_id: relatedId,
    related_note_title: relatedId,
    payload: JSON.stringify({ source: "dashboard_graph", score: 40 }),
    score: 40,
    created_at: "2026-08-13T00:00:00Z",
    ...extra,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("GraphTab user boundaries", () => {
  beforeEach(() => {
    // 위치 캐시는 모듈 레벨(리마운트 텔레포트 방지) — 테스트 사이에 새면 같은 노드 id 를 쓰는
    // 다른 케이스의 좌표 단언이 오염된다.
    resetNodePositionCacheForTests();
    callMock.mockReset();
    insertAiSectionMock.mockReset();
    insertAiSectionMock.mockResolvedValue({ id: "insight-section" });
    fitViewMock.mockReset();
    zoomInMock.mockReset();
    zoomOutMock.mockReset();
    useSettingsStore.setState({ activeWorkspaceId: "A", aiEnabled: false, uiLang: "ko" });
    useNotesStore.setState({ folders: [], selectNote: vi.fn() } as never);
    useSearchStore.setState({ query: "", searchResults: [] });
    useUiStore.setState({ dashboardFolderFilter: null });
  });

  it("ignores a late graph response from the previous workspace", async () => {
    const lateA = deferred<DashboardGraphResult>();
    callMock.mockImplementation((command: string, args: { workspace_id?: string }) => {
      if (command === "suggestions_list") return Promise.resolve({ suggestions: [] });
      if (command === "dashboard_graph" && args.workspace_id === "A") return lateA.promise;
      if (command === "dashboard_graph" && args.workspace_id === "B") return Promise.resolve(graph("B-note"));
      return Promise.resolve({});
    });

    render(<GraphTab />);
    act(() => useSettingsStore.setState({ activeWorkspaceId: "B" }));

    expect(await screen.findByTestId("graph-node-B-note")).toBeTruthy();
    act(() => lateA.resolve(graph("A-note")));

    await waitFor(() => expect(screen.queryByTestId("graph-node-A-note")).toBeNull());
    expect(screen.getByTestId("graph-node-B-note")).toBeTruthy();
    expect(screen.queryByText("관계를 불러오는 중…")).toBeNull();
  });

  it("clears selection and the suggestion panel when the workspace changes", async () => {
    const pendingB = deferred<DashboardGraphResult>();
    callMock.mockImplementation((command: string, args: { workspace_id?: string }) => {
      if (command === "dashboard_graph" && args.workspace_id === "A") return Promise.resolve(graph("A-note"));
      if (command === "dashboard_graph" && args.workspace_id === "B") return pendingB.promise;
      if (command === "suggestions_list" && args.workspace_id === "A") {
        return Promise.resolve({
          suggestions: [{
            id: "s1", kind: "overlap", note_id: "A-note", note_title: "A-note",
            related_note_id: "A-other", related_note_title: "A-other", payload: "{}",
            score: 30, created_at: "2026-08-13T00:00:00Z",
          }],
        });
      }
      if (command === "suggestions_list") return Promise.resolve({ suggestions: [] });
      return Promise.resolve({});
    });

    render(<GraphTab />);
    // 선택이 없으면 우측 패널이 곧 제안 목록이다 — 칩은 숨는다(R9).
    expect(await screen.findByTestId("graph-suggestion-s1")).toBeTruthy();
    expect(screen.queryByText("✦ 연결 제안 1건")).toBeNull();

    const node = await screen.findByTestId("graph-node-A-note");
    fireEvent.click(node);
    expect(await screen.findByLabelText("A-note")).toBeTruthy();
    expect(screen.queryByTestId("graph-suggestions-panel")).toBeNull();
    // 선택 중에는 칩이 건수 바로가기 — 누르면 선택을 풀고 패널이 제안 목록으로 돌아간다.
    fireEvent.click(await screen.findByText("✦ 연결 제안 1건"));
    expect(screen.queryByLabelText("A-note")).toBeNull();
    expect(screen.getByTestId("graph-suggestion-s1")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();

    act(() => useSettingsStore.setState({ activeWorkspaceId: "B" }));

    await waitFor(() => expect(screen.getByText("관계를 불러오는 중…")).toBeTruthy());
    expect(screen.queryByLabelText("A-note")).toBeNull();
    expect(screen.queryByTestId("graph-suggestion-s1")).toBeNull();
    expect(screen.queryByTestId("graph-node-A-note")).toBeNull();
  });

  it("delays a single click for 220ms and lets double-click open the note", async () => {
    const selectNote = vi.fn();
    useNotesStore.setState({ folders: [], selectNote } as never);
    const node = (id: string) => ({ id, folder_id: "f", title: id, year: 2026, snippet: "", degree: 1 });
    const connected: DashboardGraphResult = {
      nodes: [node("a"), node("b"), node("c"), node("d")],
      edges: [
        { source: "a", target: "b", kind: "backlink", weight: 1 },
        { source: "a", target: "c", kind: "backlink", weight: 1 },
        { source: "b", target: "c", kind: "backlink", weight: 1 },
      ],
      total: 4,
      cap: 500,
      capped: false,
      edge_total: 3,
      edge_cap: 2500,
      edges_capped: false,
    };
    callMock.mockImplementation((command: string) => {
      if (command === "dashboard_graph") return Promise.resolve(connected);
      if (command === "suggestions_list") return Promise.resolve({ suggestions: [] });
      return Promise.resolve({});
    });

    render(<GraphTab />);
    const aNode = await screen.findByTestId("graph-node-a");

    fireEvent.doubleClick(aNode);
    expect(selectNote).toHaveBeenCalledWith("a");

    fireEvent.click(aNode);
    expect(screen.queryByLabelText("a")).toBeNull();
    expect(await screen.findByLabelText("a")).toBeTruthy();
  });

  it("selects multiple nodes with Shift/Ctrl and opens the note when only one is selected", async () => {
    const selectNote = vi.fn();
    useNotesStore.setState({ folders: [], selectNote } as never);
    const node = (id: string) => ({ id, folder_id: "f", title: id, year: 2026, snippet: "", degree: 1 });
    const connected: DashboardGraphResult = {
      nodes: [node("a"), node("b"), node("c")],
      edges: [{ source: "a", target: "b", kind: "backlink", weight: 1 }],
      total: 3,
      cap: 500,
      capped: false,
      edge_total: 1,
      edge_cap: 2500,
      edges_capped: false,
    };
    callMock.mockImplementation((command: string) => {
      if (command === "dashboard_graph") return Promise.resolve(connected);
      if (command === "suggestions_list") return Promise.resolve({ suggestions: [] });
      return Promise.resolve({});
    });

    render(<GraphTab />);
    const aNode = await screen.findByTestId("graph-node-a");
    const bNode = await screen.findByTestId("graph-node-b");

    fireEvent.click(aNode, { shiftKey: true });
    fireEvent.click(bNode, { shiftKey: true });

    const openBtn = screen.queryByRole("button", { name: "노트 열기" });
    expect(openBtn).toBeNull();
  });

  it("renders the node with snippet, year, tag counts and degree indicator on select", async () => {
    const g: DashboardGraphResult = {
      nodes: [
        { id: "note-1", folder_id: "f", title: "Note With Metadata", year: 2024, snippet: "A meaningful snippet...", degree: 4 },
      ],
      edges: [],
      total: 1,
      cap: 500,
      capped: false,
      edge_total: 0,
      edge_cap: 2500,
      edges_capped: false,
    };
    callMock.mockImplementation((command: string) => {
      if (command === "dashboard_graph") return Promise.resolve(g);
      if (command === "suggestions_list") return Promise.resolve({ suggestions: [] });
      return Promise.resolve({});
    });

    render(<GraphTab />);
    const node = await screen.findByTestId("graph-node-note-1");
    expect(screen.getByText("Note With Metadata")).toBeTruthy();

    fireEvent.click(node);
    expect(await screen.findByText("A meaningful snippet...")).toBeTruthy();
    expect(screen.getByText("2024")).toBeTruthy();
  });

  it("filters graph nodes by active dashboardFolderFilter", async () => {
    const g: DashboardGraphResult = {
      nodes: [
        { id: "note-in-f1", folder_id: "folder-1", title: "In Folder 1", year: 2026, snippet: "", degree: 1 },
        { id: "note-in-f2", folder_id: "folder-2", title: "In Folder 2", year: 2026, snippet: "", degree: 1 },
      ],
      edges: [],
      total: 2,
      cap: 500,
      capped: false,
      edge_total: 0,
      edge_cap: 2500,
      edges_capped: false,
    };
    callMock.mockImplementation((command: string) => {
      if (command === "dashboard_graph") return Promise.resolve(g);
      if (command === "suggestions_list") return Promise.resolve({ suggestions: [] });
      return Promise.resolve({});
    });

    useUiStore.setState({ dashboardFolderFilter: "folder-1" });
    render(<GraphTab />);

    expect(await screen.findByTestId("graph-node-note-in-f1")).toBeTruthy();
    expect(screen.queryByTestId("graph-node-note-in-f2")).toBeNull();
  });

  it("renders search highlights for query hits and dims non-matches", async () => {
    callMock.mockImplementation((command: string) => Promise.resolve(
      command === "dashboard_graph" ? graph("A-note") : { suggestions: [] },
    ));
    render(<GraphTab />);
    expect(await screen.findByTestId("graph-node-A-note")).toBeTruthy();

    const hit: NoteSummary = {
      id: "A-note",
      folder_id: "f",
      title: "A-note",
      year: 2026,
      is_favorite: false,
      exported_at: null,
      has_image: false,
      tag_names: [],
      region: null,
      status: null,
      icon: null,
      lat: null,
      lng: null,
      created_at: "",
      updated_at: "",
      month: null,
      day: null,
    };
    act(() => {
      useSearchStore.setState({ query: "A-note", searchResults: [hit] });
    });

    await waitFor(() => {
      expect(screen.getByTestId("graph-node-A-note").querySelector("[data-search-hit]")).toBeTruthy();
    });
    expect(screen.getByTestId("graph-node-A-note-peer").querySelector("[data-search-dim]")).toBeTruthy();
    expect(screen.getByTestId("graph-node-A-note")).toBeTruthy();
    expect(screen.getByTestId("graph-node-A-note-peer")).toBeTruthy();
  });

  it("renders custom zoom controls on the unified left rail and invokes react-flow methods", async () => {
    callMock.mockImplementation((command: string) => Promise.resolve(
      command === "dashboard_graph" ? graph("A-note") : { suggestions: [] },
    ));
    render(<GraphTab />);
    expect(await screen.findByTestId("graph-rail-left")).toBeTruthy();
    const zoomControls = screen.getByTestId("graph-zoom-controls");
    expect(zoomControls).toBeTruthy();

    const zoomInBtn = screen.getByRole("button", { name: "확대" });
    const zoomOutBtn = screen.getByRole("button", { name: "축소" });
    const fitViewBtn = screen.getByRole("button", { name: "화면 맞춤" });

    fireEvent.click(zoomInBtn);
    expect(zoomInMock).toHaveBeenCalledTimes(1);

    fireEvent.click(zoomOutBtn);
    expect(zoomOutMock).toHaveBeenCalledTimes(1);

    fireEvent.click(fitViewBtn);
    expect(fitViewMock).toHaveBeenCalled();
  });

  it("lists connection suggestions in the right panel when nothing is selected", async () => {
    const suggestionWithReason = overlap("s1", "A-note", "B-note", {
      payload: JSON.stringify({ reason: "공통 키워드 발견" }),
      score: 42,
    });
    const suggestionScoreOnly = overlap("s2", "C-note", "D-note", { payload: "{}", score: 85 });

    callMock.mockImplementation((command: string) => Promise.resolve(
      command === "dashboard_graph"
        ? graph("A-note")
        : { suggestions: [suggestionWithReason, suggestionScoreOnly] },
    ));
    render(<GraphTab />);

    const panel = await screen.findByTestId("graph-suggestions-panel");
    await within(panel).findByTestId("graph-suggestion-s1");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(within(panel).getByText("연결 제안")).toBeTruthy();
    expect(within(panel).getByText("2")).toBeTruthy();

    const first = screen.getByTestId("graph-suggestion-s1");
    expect(within(first).getByText("A-note")).toBeTruthy();
    expect(within(first).getByText("B-note")).toBeTruthy();
    expect(within(first).getByText("공통 키워드 발견")).toBeTruthy();
    expect(within(first).getByText("겹침 42")).toBeTruthy();

    // 근거 줄은 AI 근거가 있는 행에만 — 점수만 있는 행은 점수 줄만.
    const second = screen.getByTestId("graph-suggestion-s2");
    expect(within(second).getByText("C-note")).toBeTruthy();
    expect(within(second).getByText("D-note")).toBeTruthy();
    expect(within(second).getByText("겹침 85")).toBeTruthy();
    expect(second.querySelector(".graph-suggest-card__reason")).toBeNull();

    expect(within(panel).getAllByRole("button", { name: "무시" })).toHaveLength(2);
    expect(within(panel).getAllByRole("button", { name: "수락" })).toHaveLength(2);
  });

  it("reads suggestions only after dashboard_graph resolves, so the first open is not empty", async () => {
    // dashboard_graph 가 제안 행을 쓴다 — 그 전에 읽으면 0건이다(실제 백엔드 순서를 흉내).
    const pendingGraph = deferred<DashboardGraphResult>();
    let rowsWritten = false;
    callMock.mockImplementation((command: string) => {
      if (command === "dashboard_graph") return pendingGraph.promise;
      if (command === "suggestions_list") {
        return Promise.resolve({ suggestions: rowsWritten ? [overlap("s1", "A-note", "A-note-peer")] : [] });
      }
      return Promise.resolve({});
    });
    render(<GraphTab />);

    // 그래프가 오기 전: 제안 없음을 단정하지 않고 안내만.
    const panel = await screen.findByTestId("graph-suggestions-panel");
    expect(within(panel).queryByText("지금은 연결 제안이 없습니다")).toBeNull();
    expect(callMock.mock.calls.some(([command]) => command === "suggestions_list")).toBe(false);

    act(() => {
      rowsWritten = true;
      pendingGraph.resolve(graph("A-note"));
    });

    expect(await screen.findByTestId("graph-suggestion-s1")).toBeTruthy();
  });

  it("shows a calm empty line plus the select hint when there are no suggestions", async () => {
    callMock.mockImplementation((command: string) => Promise.resolve(
      command === "dashboard_graph" ? graph("A-note") : { suggestions: [] },
    ));
    render(<GraphTab />);

    const panel = await screen.findByTestId("graph-suggestions-panel");
    expect(await within(panel).findByText("지금은 연결 제안이 없습니다")).toBeTruthy();
    expect(within(panel).getByText("그래프에서 노트를 선택하면 연관 노트가 여기에 표시됩니다")).toBeTruthy();
  });

  it("accepting a suggestion removes the card at once, then reloads the graph and suggestions", async () => {
    let accepted = false;
    callMock.mockImplementation((command: string) => {
      if (command === "dashboard_graph") return Promise.resolve(graph("A-note"));
      if (command === "suggestions_list") {
        return Promise.resolve({ suggestions: accepted ? [] : [overlap("s1", "A-note", "A-note-peer")] });
      }
      if (command === "graph_suggestion_accept") {
        accepted = true;
        return Promise.resolve("A-note");
      }
      return Promise.resolve({});
    });
    render(<GraphTab />);

    const card = await screen.findByTestId("graph-suggestion-s1");
    const countOf = (name: string) => callMock.mock.calls.filter(([command]) => command === name).length;
    const graphCallsBefore = countOf("dashboard_graph");
    const listCallsBefore = countOf("suggestions_list");
    fireEvent.click(within(card).getByRole("button", { name: "수락" }));

    // 낙관적 제거 — 응답을 기다리지 않고 카드가 빠진다.
    expect(screen.queryByTestId("graph-suggestion-s1")).toBeNull();
    expect(callMock).toHaveBeenCalledWith("graph_suggestion_accept", { id: "s1" });
    await waitFor(() => {
      expect(countOf("dashboard_graph")).toBeGreaterThan(graphCallsBefore);
      expect(countOf("suggestions_list")).toBeGreaterThan(listCallsBefore);
    });
    expect(await screen.findByText("지금은 연결 제안이 없습니다")).toBeTruthy();
    expect(screen.queryByTestId("graph-suggestion-s1")).toBeNull();
  });

  it("puts the card back in place when accept fails (optimistic rollback)", async () => {
    callMock.mockImplementation((command: string) => {
      if (command === "dashboard_graph") return Promise.resolve(graph("A-note"));
      if (command === "suggestions_list") {
        return Promise.resolve({
          suggestions: [overlap("s1", "A-note", "A-note-peer"), overlap("s2", "A-note", "Z-note")],
        });
      }
      if (command === "graph_suggestion_accept") return Promise.reject(new Error("boom"));
      return Promise.resolve({});
    });
    render(<GraphTab />);

    const card = await screen.findByTestId("graph-suggestion-s1");
    fireEvent.click(within(card).getByRole("button", { name: "수락" }));
    expect(screen.queryByTestId("graph-suggestion-s1")).toBeNull();

    expect(await screen.findByTestId("graph-suggestion-s1")).toBeTruthy();
    // 원래 자리(첫 번째)로 돌아온다.
    const cards = screen.getAllByTestId(/^graph-suggestion-s\d$/);
    expect(cards.map((element) => element.dataset.testid)).toEqual(["graph-suggestion-s1", "graph-suggestion-s2"]);
  });

  it("puts the card back when dismiss fails", async () => {
    callMock.mockImplementation((command: string) => {
      if (command === "dashboard_graph") return Promise.resolve(graph("A-note"));
      if (command === "suggestions_list") return Promise.resolve({ suggestions: [overlap("s1", "A-note", "A-note-peer")] });
      if (command === "graph_suggestion_dismiss") return Promise.reject(new Error("boom"));
      return Promise.resolve({});
    });
    render(<GraphTab />);

    const card = await screen.findByTestId("graph-suggestion-s1");
    fireEvent.click(within(card).getByRole("button", { name: "무시" }));
    expect(screen.queryByTestId("graph-suggestion-s1")).toBeNull();
    expect(callMock).toHaveBeenCalledWith("graph_suggestion_dismiss", { id: "s1" });
    expect(await screen.findByTestId("graph-suggestion-s1")).toBeTruthy();
  });

  it("a suggestions read that started before the click does not bring the accepted card back", async () => {
    // s2 수락 → 재조회(대기 중) → 그 사이 s1 수락 → 옛 스냅샷([s1])이 늦게 도착해도 s1 은 안 살아난다.
    const staleList = deferred<{ suggestions: Suggestion[] }>();
    const acceptS1 = deferred<string>();
    let listCalls = 0;
    callMock.mockImplementation((command: string, args: { id?: string }) => {
      if (command === "dashboard_graph") return Promise.resolve(graph("A-note"));
      if (command === "suggestions_list") {
        listCalls += 1;
        if (listCalls === 1) {
          return Promise.resolve({ suggestions: [overlap("s1", "A-note", "A-note-peer"), overlap("s2", "A-note", "Z-note")] });
        }
        if (listCalls === 2) return staleList.promise;
        return Promise.resolve({ suggestions: [] });
      }
      if (command === "graph_suggestion_accept") return args.id === "s1" ? acceptS1.promise : Promise.resolve("A-note");
      return Promise.resolve({});
    });
    render(<GraphTab />);

    fireEvent.click(within(await screen.findByTestId("graph-suggestion-s2")).getByRole("button", { name: "수락" }));
    await waitFor(() => expect(listCalls).toBe(2));
    fireEvent.click(within(screen.getByTestId("graph-suggestion-s1")).getByRole("button", { name: "수락" }));
    expect(screen.queryByTestId("graph-suggestion-s1")).toBeNull();

    await act(async () => {
      staleList.resolve({ suggestions: [overlap("s1", "A-note", "A-note-peer")] });
      await staleList.promise;
    });
    expect(screen.queryByTestId("graph-suggestion-s1")).toBeNull();

    await act(async () => {
      acceptS1.resolve("A-note");
      await acceptS1.promise;
    });
    expect(await screen.findByText("지금은 연결 제안이 없습니다")).toBeTruthy();
    expect(screen.queryByTestId("graph-suggestion-s1")).toBeNull();
  });

  it("a suggestions read that starts while accept is still in flight skips that card", async () => {
    // s1 수락이 아직 확정 전 → s2 수락 성공이 재조회를 부른다 → DB 는 아직 s1 을 pending 으로 돌려준다.
    const acceptS1 = deferred<string>();
    const committed = new Set<string>();
    callMock.mockImplementation((command: string, args: { id?: string }) => {
      if (command === "dashboard_graph") return Promise.resolve(graph("A-note"));
      if (command === "suggestions_list") {
        // s3 = s2 확정 뒤 재조회에서만 나타나는 행 — 그 응답이 반영됐음을 화면으로 확인하는 표식.
        const rows = [overlap("s1", "A-note", "A-note-peer"), overlap("s2", "A-note", "Z-note")];
        if (committed.has("s2")) rows.push(overlap("s3", "A-note", "Y-note"));
        return Promise.resolve({ suggestions: rows.filter((suggestion) => !committed.has(suggestion.id)) });
      }
      if (command === "graph_suggestion_accept") {
        if (args.id === "s1") return acceptS1.promise.then((value) => { committed.add("s1"); return value; });
        committed.add(args.id ?? "");
        return Promise.resolve("A-note");
      }
      return Promise.resolve({});
    });
    render(<GraphTab />);

    fireEvent.click(within(await screen.findByTestId("graph-suggestion-s1")).getByRole("button", { name: "수락" }));
    fireEvent.click(within(screen.getByTestId("graph-suggestion-s2")).getByRole("button", { name: "수락" }));
    // s2 확정 뒤 재조회는 s1 을 아직 pending 으로 돌려준다 — 그 응답이 반영돼도(s3 등장) s1 은 처리 중이라 걸러진다.
    expect(await screen.findByTestId("graph-suggestion-s3")).toBeTruthy();
    expect(screen.queryByTestId("graph-suggestion-s1")).toBeNull();

    await act(async () => {
      acceptS1.resolve("A-note");
      await acceptS1.promise;
    });
    expect(screen.queryByTestId("graph-suggestion-s1")).toBeNull();
    expect(screen.queryByTestId("graph-suggestion-s2")).toBeNull();
    expect(screen.getByTestId("graph-suggestion-s3")).toBeTruthy();
  });

  it("hovering a suggestion card keeps only its pair bright on the graph", async () => {
    const base = graph("A-note");
    const g: DashboardGraphResult = {
      ...base,
      nodes: [...base.nodes, { id: "other", folder_id: "f", title: "other", year: 2026, snippet: "", degree: 0 }],
      total: 3,
    };
    callMock.mockImplementation((command: string) => Promise.resolve(
      command === "dashboard_graph" ? g : { suggestions: [overlap("s1", "A-note", "other")] },
    ));
    render(<GraphTab />);

    const card = await screen.findByTestId("graph-suggestion-s1");
    expect(screen.getByTestId("graph-node-A-note-peer").className).not.toContain("graph-flow-node--dimmed");

    fireEvent.mouseEnter(card);
    await waitFor(() => {
      expect(screen.getByTestId("graph-node-A-note-peer").className).toContain("graph-flow-node--dimmed");
    });
    expect(screen.getByTestId("graph-node-A-note").className).not.toContain("graph-flow-node--dimmed");
    expect(screen.getByTestId("graph-node-other").className).not.toContain("graph-flow-node--dimmed");

    fireEvent.mouseLeave(card);
    await waitFor(() => {
      expect(screen.getByTestId("graph-node-A-note-peer").className).not.toContain("graph-flow-node--dimmed");
    });
  });

  it("closing the selected-note panel clears the whole selection and returns to suggestions", async () => {
    callMock.mockImplementation((command: string) => Promise.resolve(
      command === "dashboard_graph" ? graph("A-note") : { suggestions: [overlap("s1", "A-note", "A-note-peer")] },
    ));
    render(<GraphTab />);

    await screen.findByTestId("graph-suggestion-s1");
    fireEvent.click(screen.getByTestId("graph-node-A-note"));
    expect(await screen.findByLabelText("A-note")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "닫기" }));

    expect(await screen.findByTestId("graph-suggestion-s1")).toBeTruthy();
    expect(screen.queryByText("✦ 연결 제안 1건")).toBeNull();
  });

  it("offers the AI insight button in the selected-note panel", async () => {
    const generateFromPrompt = vi.fn().mockResolvedValue("인사이트 본문");
    useAiStore.setState({ promptPending: false, generateFromPrompt } as never);
    callMock.mockImplementation((command: string) => Promise.resolve(
      command === "dashboard_graph" ? graph("A-note") : { suggestions: [] },
    ));
    render(<GraphTab />);

    // 선택이 없으면 인사이트 버튼도 없다(선택 노트가 있어야 하는 기능).
    await screen.findByTestId("graph-suggestions-panel");
    expect(screen.queryByTestId("graph-ai-insight")).toBeNull();

    fireEvent.click(await screen.findByTestId("graph-node-A-note"));
    const insight = await screen.findByTestId("graph-ai-insight");
    expect((insight as HTMLButtonElement).disabled).toBe(true); // aiEnabled: false

    act(() => useSettingsStore.setState({ aiEnabled: true }));
    await waitFor(() => expect((screen.getByTestId("graph-ai-insight") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("graph-ai-insight"));

    await waitFor(() => expect(insertAiSectionMock).toHaveBeenCalledWith("AI로 인사이트 조합", "인사이트 본문", "A-note"));
    expect(generateFromPrompt).toHaveBeenCalledTimes(1);
  });

  describe("Wave Q: connection drag & drop and edge cut", () => {
    it("connects two nodes via onConnect and creates an internal attachment", async () => {
      const g: DashboardGraphResult = {
        nodes: [
          { id: "node-1", folder_id: "f", title: "First Note", year: 2026, snippet: "", degree: 0 },
          { id: "node-2", folder_id: "f", title: "Second Note", year: 2026, snippet: "", degree: 0 },
        ],
        edges: [],
        total: 2,
        cap: 500,
        capped: false,
        edge_total: 0,
        edge_cap: 2500,
        edges_capped: false,
      };

      callMock.mockImplementation((command: string) => {
        if (command === "dashboard_graph") return Promise.resolve(g);
        if (command === "suggestions_list") return Promise.resolve({ suggestions: [] });
        if (command === "attachment_add_internal") return Promise.resolve({ id: "att-1" });
        return Promise.resolve({});
      });

      render(<GraphTab />);
      expect(await screen.findByTestId("graph-node-node-1")).toBeTruthy();

      // Trigger mock connect
      const trigger = screen.getByTestId("mock-connect-trigger");
      act(() => {
        trigger.dataset.connectSource = "node-1";
        trigger.dataset.connectTarget = "node-2";
        fireEvent.click(trigger);
      });

      await waitFor(() => {
        expect(callMock).toHaveBeenCalledWith("attachment_add_internal", {
          note_id: "node-1",
          target_note_id: "node-2",
          name: "Second Note",
        });
      });
    });

    it("connects multiple selected source nodes to a target node (many-to-one connection)", async () => {
      const g: DashboardGraphResult = {
        nodes: [
          { id: "node-1", folder_id: "f", title: "Note 1", year: 2026, snippet: "", degree: 0 },
          { id: "node-2", folder_id: "f", title: "Note 2", year: 2026, snippet: "", degree: 0 },
          { id: "node-3", folder_id: "f", title: "Target Note", year: 2026, snippet: "", degree: 0 },
        ],
        edges: [],
        total: 3,
        cap: 500,
        capped: false,
        edge_total: 0,
        edge_cap: 2500,
        edges_capped: false,
      };

      callMock.mockImplementation((command: string) => {
        if (command === "dashboard_graph") return Promise.resolve(g);
        if (command === "suggestions_list") return Promise.resolve({ suggestions: [] });
        if (command === "attachment_add_internal") return Promise.resolve({ id: "att-1" });
        return Promise.resolve({});
      });

      render(<GraphTab />);
      expect(await screen.findByTestId("graph-node-node-1")).toBeTruthy();

      // Multi-select node-1 and node-2
      const n1 = screen.getByTestId("graph-node-node-1");
      const n2 = screen.getByTestId("graph-node-node-2");
      fireEvent.click(n1, { shiftKey: true });
      fireEvent.click(n2, { shiftKey: true });

      // Start connect from node-1
      const startTrigger = screen.getByTestId("mock-connect-start-trigger");
      act(() => {
        startTrigger.dataset.nodeId = "node-1";
        fireEvent.click(startTrigger);
      });

      // Connect to node-3
      const trigger = screen.getByTestId("mock-connect-trigger");
      act(() => {
        trigger.dataset.connectSource = "node-1";
        trigger.dataset.connectTarget = "node-3";
        fireEvent.click(trigger);
      });

      await waitFor(() => {
        expect(callMock).toHaveBeenCalledWith("attachment_add_internal", {
          note_id: "node-1",
          target_note_id: "node-3",
          name: "Target Note",
        });
        expect(callMock).toHaveBeenCalledWith("attachment_add_internal", {
          note_id: "node-2",
          target_note_id: "node-3",
          name: "Target Note",
        });
      });
    });

    it("ignores self-loops and duplicate connections without calling attachment_add_internal", async () => {
      const g: DashboardGraphResult = {
        nodes: [
          { id: "node-1", folder_id: "f", title: "First Note", year: 2026, snippet: "", degree: 1 },
          { id: "node-2", folder_id: "f", title: "Second Note", year: 2026, snippet: "", degree: 1 },
        ],
        edges: [{ source: "node-1", target: "node-2", kind: "backlink", weight: 1 }],
        total: 2,
        cap: 500,
        capped: false,
        edge_total: 1,
        edge_cap: 2500,
        edges_capped: false,
      };

      callMock.mockImplementation((command: string) => {
        if (command === "dashboard_graph") return Promise.resolve(g);
        if (command === "suggestions_list") return Promise.resolve({ suggestions: [] });
        return Promise.resolve({});
      });

      render(<GraphTab />);
      expect(await screen.findByTestId("graph-node-node-1")).toBeTruthy();

      const trigger = screen.getByTestId("mock-connect-trigger");

      // 1. Self-loop
      act(() => {
        trigger.dataset.connectSource = "node-1";
        trigger.dataset.connectTarget = "node-1";
        fireEvent.click(trigger);
      });

      // 2. Duplicate connection (node-1 -> node-2 already exists)
      act(() => {
        trigger.dataset.connectSource = "node-1";
        trigger.dataset.connectTarget = "node-2";
        fireEvent.click(trigger);
      });

      // 3. Duplicate connection in reverse (node-2 -> node-1)
      act(() => {
        trigger.dataset.connectSource = "node-2";
        trigger.dataset.connectTarget = "node-1";
        fireEvent.click(trigger);
      });

      expect(callMock).not.toHaveBeenCalledWith("attachment_add_internal", expect.anything());
    });

    it("cuts a backlink edge: calls note_get, attachment_remove, and showUndoToast", async () => {
      const g: DashboardGraphResult = {
        nodes: [
          { id: "note-a", folder_id: "f", title: "Note A", year: 2026, snippet: "", degree: 1 },
          { id: "note-b", folder_id: "f", title: "Note B", year: 2026, snippet: "", degree: 1 },
        ],
        edges: [{ source: "note-a", target: "note-b", kind: "backlink", weight: 1 }],
        total: 2,
        cap: 500,
        capped: false,
        edge_total: 1,
        edge_cap: 2500,
        edges_capped: false,
      };

      callMock.mockImplementation((command: string, args: any) => {
        if (command === "dashboard_graph") return Promise.resolve(g);
        if (command === "suggestions_list") return Promise.resolve({ suggestions: [] });
        if (command === "note_get" && args?.id === "note-a") {
          return Promise.resolve({
            note: { id: "note-a", title: "Note A" },
            attachments: [
              { id: "att-internal-1", name: "Note B", kind: "internal", url: "note-b", position: 0, rel_path: null, size_bytes: null },
            ],
            sections: [],
            sources: [],
          });
        }
        if (command === "attachment_remove") return Promise.resolve({ deleted: true });
        return Promise.resolve({});
      });

      const { container } = render(<GraphTab />);
      expect(await screen.findByTestId("graph-node-note-a")).toBeTruthy();

      // Hover on edge path group
      const edgeGroup = container.querySelector("g");
      expect(edgeGroup).toBeTruthy();
      fireEvent.mouseEnter(edgeGroup!);

      const cutBtn = await screen.findByTestId("graph-edge-cut");
      expect(cutBtn).toBeTruthy();

      fireEvent.click(cutBtn);

      await waitFor(() => {
        expect(callMock).toHaveBeenCalledWith("note_get", { id: "note-a" });
        expect(callMock).toHaveBeenCalledWith("attachment_remove", { id: "att-internal-1" });
        expect(showUndoToastMock).toHaveBeenCalled();
      });
    });

    it("related edge does not have cut button on hover and shows related hint", async () => {
      const g: DashboardGraphResult = {
        nodes: [
          { id: "note-a", folder_id: "f", title: "Note A", year: 2026, snippet: "", degree: 1 },
          { id: "note-b", folder_id: "f", title: "Note B", year: 2026, snippet: "", degree: 1 },
        ],
        edges: [{ source: "note-a", target: "note-b", kind: "related", weight: 50 }],
        total: 2,
        cap: 500,
        capped: false,
        edge_total: 1,
        edge_cap: 2500,
        edges_capped: false,
      };

      callMock.mockImplementation((command: string) => {
        if (command === "dashboard_graph") return Promise.resolve(g);
        if (command === "suggestions_list") return Promise.resolve({ suggestions: [] });
        return Promise.resolve({});
      });

      const { container } = render(<GraphTab />);
      expect(await screen.findByTestId("graph-node-note-a")).toBeTruthy();

      const edgeGroup = container.querySelector("g");
      expect(edgeGroup).toBeTruthy();
      fireEvent.mouseEnter(edgeGroup!);

      expect(screen.queryByTestId("graph-edge-cut")).toBeNull();
      expect(await screen.findByTestId("graph-edge-related-hint")).toBeTruthy();
    });
  });

  describe("Wave S: connection animations, safety guards, and interactions", () => {
    it("marks newly connected edge with justCreated and nodes with justConnected, then clears after timer", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const initialGraph: DashboardGraphResult = {
          nodes: [
            { id: "node-1", folder_id: "f", title: "Note 1", year: 2026, snippet: "", degree: 0 },
            { id: "node-2", folder_id: "f", title: "Note 2", year: 2026, snippet: "", degree: 0 },
          ],
          edges: [],
          total: 2,
          cap: 500,
          capped: false,
          edge_total: 0,
          edge_cap: 2500,
          edges_capped: false,
        };

        const afterConnectGraph: DashboardGraphResult = {
          nodes: [
            { id: "node-1", folder_id: "f", title: "Note 1", year: 2026, snippet: "", degree: 1 },
            { id: "node-2", folder_id: "f", title: "Note 2", year: 2026, snippet: "", degree: 1 },
          ],
          edges: [{ source: "node-1", target: "node-2", kind: "backlink", weight: 1 }],
          total: 2,
          cap: 500,
          capped: false,
          edge_total: 1,
          edge_cap: 2500,
          edges_capped: false,
        };

        let graphState = initialGraph;
        callMock.mockImplementation((command: string) => {
          if (command === "dashboard_graph") return Promise.resolve(graphState);
          if (command === "suggestions_list") return Promise.resolve({ suggestions: [] });
          if (command === "attachment_add_internal") {
            graphState = afterConnectGraph;
            return Promise.resolve({ id: "att-1" });
          }
          return Promise.resolve({});
        });

        render(<GraphTab />);
        expect(await screen.findByTestId("graph-node-node-1")).toBeTruthy();

        // Connect node-1 to node-2
        const trigger = screen.getByTestId("mock-connect-trigger");
        act(() => {
          trigger.dataset.connectSource = "node-1";
          trigger.dataset.connectTarget = "node-2";
          fireEvent.click(trigger);
        });

        await waitFor(() => {
          const edgeEl = screen.getByTestId("mock-edge-backlink:node-1:node-2");
          expect(edgeEl.dataset.justCreated).toBe("true");
          expect(screen.getByTestId("graph-node-node-1").dataset.justConnected).toBe("true");
          expect(screen.getByTestId("graph-node-node-2").dataset.justConnected).toBe("true");
        });

        // Fast-forward past 800ms animation duration
        act(() => {
          vi.advanceTimersByTime(900);
        });

        await waitFor(() => {
          const edgeEl = screen.getByTestId("mock-edge-backlink:node-1:node-2");
          expect(edgeEl.dataset.justCreated).toBeUndefined();
          expect(screen.getByTestId("graph-node-node-1").dataset.justConnected).toBeUndefined();
          expect(screen.getByTestId("graph-node-node-2").dataset.justConnected).toBeUndefined();
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not mark existing edges with justCreated on initial load or normal reload", async () => {
      const g: DashboardGraphResult = {
        nodes: [
          { id: "node-1", folder_id: "f", title: "Note 1", year: 2026, snippet: "", degree: 1 },
          { id: "node-2", folder_id: "f", title: "Note 2", year: 2026, snippet: "", degree: 1 },
        ],
        edges: [{ source: "node-1", target: "node-2", kind: "backlink", weight: 1 }],
        total: 2,
        cap: 500,
        capped: false,
        edge_total: 1,
        edge_cap: 2500,
        edges_capped: false,
      };

      callMock.mockImplementation((command: string) => {
        if (command === "dashboard_graph") return Promise.resolve(g);
        if (command === "suggestions_list") return Promise.resolve({ suggestions: [] });
        return Promise.resolve({});
      });

      render(<GraphTab />);
      expect(await screen.findByTestId("graph-node-node-1")).toBeTruthy();

      const edgeEl = screen.getByTestId("mock-edge-backlink:node-1:node-2");
      expect(edgeEl.dataset.justCreated).toBeUndefined();
      expect(screen.getByTestId("graph-node-node-1").dataset.justConnected).toBeUndefined();
    });

    it("allows connecting nodes that previously only had a related edge (upgrading to backlink)", async () => {
      const gWithRelated: DashboardGraphResult = {
        nodes: [
          { id: "node-1", folder_id: "f", title: "Note 1", year: 2026, snippet: "", degree: 1 },
          { id: "node-2", folder_id: "f", title: "Note 2", year: 2026, snippet: "", degree: 1 },
        ],
        edges: [{ source: "node-1", target: "node-2", kind: "related", weight: 50 }],
        total: 2,
        cap: 500,
        capped: false,
        edge_total: 1,
        edge_cap: 2500,
        edges_capped: false,
      };

      callMock.mockImplementation((command: string) => {
        if (command === "dashboard_graph") return Promise.resolve(gWithRelated);
        if (command === "suggestions_list") return Promise.resolve({ suggestions: [] });
        if (command === "attachment_add_internal") return Promise.resolve({ id: "att-new" });
        return Promise.resolve({});
      });

      render(<GraphTab />);
      expect(await screen.findByTestId("graph-node-node-1")).toBeTruthy();

      // Connecting should succeed even though a related edge exists
      const trigger = screen.getByTestId("mock-connect-trigger");
      act(() => {
        trigger.dataset.connectSource = "node-1";
        trigger.dataset.connectTarget = "node-2";
        fireEvent.click(trigger);
      });

      await waitFor(() => {
        expect(callMock).toHaveBeenCalledWith("attachment_add_internal", {
          note_id: "node-1",
          target_note_id: "node-2",
          name: "Note 2",
        });
      });
    });

    it("cuts all duplicate internal attachment records between a pair on cut edge", async () => {
      const g: DashboardGraphResult = {
        nodes: [
          { id: "node-a", folder_id: "f", title: "Note A", year: 2026, snippet: "", degree: 1 },
          { id: "node-b", folder_id: "f", title: "Note B", year: 2026, snippet: "", degree: 1 },
        ],
        edges: [{ source: "node-a", target: "node-b", kind: "backlink", weight: 200 }],
        total: 2,
        cap: 500,
        capped: false,
        edge_total: 1,
        edge_cap: 2500,
        edges_capped: false,
      };

      callMock.mockImplementation((command: string) => {
        if (command === "dashboard_graph") return Promise.resolve(g);
        if (command === "suggestions_list") return Promise.resolve({ suggestions: [] });
        if (command === "note_get") {
          return Promise.resolve({
            note: { id: "node-a", title: "Note A" },
            attachments: [
              { id: "att-1", name: "Note B", kind: "internal", url: "node-b", position: 0, rel_path: null, size_bytes: null },
              { id: "att-2", name: "Note B", kind: "internal", url: "node-b", position: 1, rel_path: null, size_bytes: null },
            ],
            sections: [],
            sources: [],
          });
        }
        if (command === "attachment_remove") return Promise.resolve({ deleted: true });
        return Promise.resolve({});
      });

      const { container } = render(<GraphTab />);
      expect(await screen.findByTestId("graph-node-node-a")).toBeTruthy();

      const edgeGroup = container.querySelector("g");
      expect(edgeGroup).toBeTruthy();
      fireEvent.mouseEnter(edgeGroup!);

      const cutBtn = await screen.findByTestId("graph-edge-cut");
      fireEvent.click(cutBtn);

      await waitFor(() => {
        expect(callMock).toHaveBeenCalledWith("attachment_remove", { id: "att-1" });
        expect(callMock).toHaveBeenCalledWith("attachment_remove", { id: "att-2" });
        expect(showUndoToastMock).toHaveBeenCalled();
      });
    });

    // 2026-08-20 오너: 컷 트리거 정리 — 클릭 컷은 호버 ✕ 버튼 하나. 수식키+클릭 컷은 Alt 레이저
    // 모드 키와 겹쳐 실수 절단을 만들어 제거됐다. 이 테스트는 그 부재를 계약으로 박는다.
    it("modifier-click on an edge does NOT cut it (hover ✕ is the only click path)", async () => {
      showUndoToastMock.mockClear(); // beforeEach 는 이 목을 리셋하지 않는다 — 앞 컷 테스트의 호출이 샌다
      const g: DashboardGraphResult = {
        nodes: [
          { id: "node-x", folder_id: "f", title: "Note X", year: 2026, snippet: "", degree: 1 },
          { id: "node-y", folder_id: "f", title: "Note Y", year: 2026, snippet: "", degree: 1 },
        ],
        edges: [{ source: "node-x", target: "node-y", kind: "backlink", weight: 100 }],
        total: 2,
        cap: 500,
        capped: false,
        edge_total: 1,
        edge_cap: 2500,
        edges_capped: false,
      };

      callMock.mockImplementation((command: string) => {
        if (command === "dashboard_graph") return Promise.resolve(g);
        if (command === "suggestions_list") return Promise.resolve({ suggestions: [] });
        if (command === "note_get") {
          return Promise.resolve({
            note: { id: "node-x", title: "Note X" },
            attachments: [
              { id: "att-x", name: "Note Y", kind: "internal", url: "node-y", position: 0, rel_path: null, size_bytes: null },
            ],
            sections: [],
            sources: [],
          });
        }
        if (command === "attachment_remove") return Promise.resolve({ deleted: true });
        return Promise.resolve({});
      });

      const { container } = render(<GraphTab />);
      expect(await screen.findByTestId("graph-node-node-x")).toBeTruthy();

      const edgeGroup = container.querySelector("g");
      expect(edgeGroup).toBeTruthy();

      // Ctrl/Alt 클릭 모두 아무 절단도 일으키지 않아야 한다.
      fireEvent.click(edgeGroup!, { ctrlKey: true });
      fireEvent.click(edgeGroup!, { altKey: true });

      await new Promise((r) => setTimeout(r, 50));
      expect(callMock).not.toHaveBeenCalledWith("attachment_remove", expect.anything());
      expect(showUndoToastMock).not.toHaveBeenCalled();
    });

    it("supports multi-selecting nodes with Shift/Ctrl and connecting them via multi-action bar", async () => {
      const g: DashboardGraphResult = {
        nodes: [
          { id: "n-1", folder_id: "f", title: "Note 1", year: 2026, snippet: "", degree: 0 },
          { id: "n-2", folder_id: "f", title: "Note 2", year: 2026, snippet: "", degree: 0 },
          { id: "n-3", folder_id: "f", title: "Note 3", year: 2026, snippet: "", degree: 0 },
        ],
        edges: [],
        total: 3,
        cap: 500,
        capped: false,
        edge_total: 0,
        edge_cap: 2500,
        edges_capped: false,
      };

      callMock.mockImplementation((command: string) => {
        if (command === "dashboard_graph") return Promise.resolve(g);
        if (command === "suggestions_list") return Promise.resolve({ suggestions: [] });
        if (command === "attachment_add_internal") return Promise.resolve({ id: "att-multi" });
        return Promise.resolve({});
      });

      render(<GraphTab />);
      const node1 = await screen.findByTestId("graph-node-n-1");
      const node2 = await screen.findByTestId("graph-node-n-2");
      const node3 = await screen.findByTestId("graph-node-n-3");

      // Shift-click node1, node2, node3
      fireEvent.click(node1, { shiftKey: true });
      fireEvent.click(node2, { shiftKey: true });

      // Action bar should appear when >= 2 selected
      const actionBar = await screen.findByTestId("graph-multi-action-bar");
      expect(actionBar).toBeTruthy();

      fireEvent.click(node3, { shiftKey: true });

      // Click "선택한 노트 연결" button
      const connectBtn = screen.getByTestId("graph-multi-connect-btn");
      fireEvent.click(connectBtn);

      await waitFor(() => {
        expect(callMock).toHaveBeenCalledWith("attachment_add_internal", expect.objectContaining({
          note_id: expect.any(String),
          target_note_id: expect.any(String),
        }));
      });

      // Click clear button to dismiss selection
      const clearBtn = screen.getByTestId("graph-multi-clear-btn");
      fireEvent.click(clearBtn);

      await waitFor(() => {
        expect(screen.queryByTestId("graph-multi-action-bar")).toBeNull();
      });
    });

    it("renders numbered selection badges when multiple nodes are selected", async () => {
      const g: DashboardGraphResult = {
        nodes: [
          { id: "badge-1", folder_id: "f", title: "Badge 1", year: 2026, snippet: "", degree: 0 },
          { id: "badge-2", folder_id: "f", title: "Badge 2", year: 2026, snippet: "", degree: 0 },
        ],
        edges: [],
        total: 2,
        cap: 500,
        capped: false,
        edge_total: 0,
        edge_cap: 2500,
        edges_capped: false,
      };

      callMock.mockImplementation((command: string) => {
        if (command === "dashboard_graph") return Promise.resolve(g);
        if (command === "suggestions_list") return Promise.resolve({ suggestions: [] });
        return Promise.resolve({});
      });

      render(<GraphTab />);
      const n1 = await screen.findByTestId("graph-node-badge-1");
      const n2 = await screen.findByTestId("graph-node-badge-2");

      fireEvent.click(n1, { shiftKey: true });
      fireEvent.click(n2, { shiftKey: true });

      const badges = await screen.findAllByTestId("graph-node-selection-badge");
      expect(badges.length).toBe(2);
      expect(badges[0].textContent).toBe("1");
      expect(badges[1].textContent).toBe("2");
    });

    it("creates a new note and connects selected nodes when drag ends on empty canvas", async () => {
      const g: DashboardGraphResult = {
        nodes: [
          { id: "drag-s1", folder_id: "f", title: "Drag S1", year: 2026, snippet: "", degree: 0 },
          { id: "drag-s2", folder_id: "f", title: "Drag S2", year: 2026, snippet: "", degree: 0 },
        ],
        edges: [],
        total: 2,
        cap: 500,
        capped: false,
        edge_total: 0,
        edge_cap: 2500,
        edges_capped: false,
      };

      callMock.mockImplementation((command: string) => {
        if (command === "dashboard_graph") return Promise.resolve(g);
        if (command === "suggestions_list") return Promise.resolve({ suggestions: [] });
        if (command === "note_create") return Promise.resolve({ note: { id: "new-note-created", title: "" } });
        if (command === "attachment_add_internal") return Promise.resolve({ id: "att-created" });
        return Promise.resolve({});
      });

      render(<GraphTab />);
      const n1 = await screen.findByTestId("graph-node-drag-s1");
      const n2 = await screen.findByTestId("graph-node-drag-s2");

      // Multi-select n1 and n2
      fireEvent.click(n1, { shiftKey: true });
      fireEvent.click(n2, { shiftKey: true });

      // Start drag from n1
      const startTrigger = screen.getByTestId("mock-connect-start-trigger");
      startTrigger.setAttribute("data-node-id", "drag-s1");
      fireEvent.click(startTrigger);

      // End drag on empty space
      const endTrigger = screen.getByTestId("mock-connect-end-trigger");
      fireEvent.click(endTrigger);

      await waitFor(() => {
        expect(callMock).toHaveBeenCalledWith("note_create", expect.objectContaining({
          title: "",
        }));
        expect(callMock).toHaveBeenCalledWith("attachment_add_internal", expect.objectContaining({
          note_id: "drag-s1",
          target_note_id: "new-note-created",
        }));
        expect(callMock).toHaveBeenCalledWith("attachment_add_internal", expect.objectContaining({
          note_id: "drag-s2",
          target_note_id: "new-note-created",
        }));
      });
    });

    it("highlights adjacent edges when a node is hovered", async () => {
      const g: DashboardGraphResult = {
        nodes: [
          { id: "hov-1", folder_id: "f", title: "Hov 1", year: 2026, snippet: "", degree: 1 },
          { id: "hov-2", folder_id: "f", title: "Hov 2", year: 2026, snippet: "", degree: 1 },
        ],
        edges: [{ source: "hov-1", target: "hov-2", kind: "backlink", weight: 1 }],
        total: 2,
        cap: 500,
        capped: false,
        edge_total: 1,
        edge_cap: 2500,
        edges_capped: false,
      };

      callMock.mockImplementation((command: string) => {
        if (command === "dashboard_graph") return Promise.resolve(g);
        if (command === "suggestions_list") return Promise.resolve({ suggestions: [] });
        return Promise.resolve({});
      });

      render(<GraphTab />);
      const n1 = await screen.findByTestId("graph-node-hov-1");
      const edge = await screen.findByTestId("mock-edge-backlink:hov-1:hov-2");

      expect(edge.className).not.toContain("graph-edge--node-hovered");

      fireEvent.mouseEnter(n1);

      await waitFor(() => {
        const updatedEdge = screen.getByTestId("mock-edge-backlink:hov-1:hov-2");
        expect(updatedEdge.className).toContain("graph-edge--node-hovered");
      });

      fireEvent.mouseLeave(n1);

      await waitFor(() => {
        const updatedEdge = screen.getByTestId("mock-edge-backlink:hov-1:hov-2");
        expect(updatedEdge.className).not.toContain("graph-edge--node-hovered");
      });
    });

    // v2 (2026-08-20): 전면 동결(v1)도 전면 재배열도 아니다 — 구경꾼은 제자리, 합류(고립→연결)
    // 노드만 앵커(id 최솟값 파트너) 곁 34px 로 이동한다. 예전 버전은 "아무도 안 움직인다"를
    // 단언했지만 waitFor 첫 틱이 refetch 전에 통과하는 공허한 검사였다 — 지금은 엣지가 실제로
    // 나타난 뒤(=refetch 반영 후)에 단언한다.
    it("D2-1: bystanders stay put; the joining node moves next to its anchor partner", async () => {
      let currentGraph: DashboardGraphResult = {
        nodes: [
          { id: "node-a", folder_id: "f1", title: "Node A", year: 2026, snippet: "", degree: 0 },
          { id: "node-b", folder_id: "f2", title: "Node B", year: 2026, snippet: "", degree: 0 },
          { id: "node-c", folder_id: "f1", title: "Node C", year: 2026, snippet: "", degree: 0 },
        ],
        edges: [],
        total: 3,
        cap: 500,
        capped: false,
        edge_total: 0,
        edge_cap: 2500,
        edges_capped: false,
      };

      callMock.mockImplementation((command: string) => {
        if (command === "dashboard_graph") return Promise.resolve(currentGraph);
        if (command === "suggestions_list") return Promise.resolve({ suggestions: [] });
        if (command === "attachment_add_internal") return Promise.resolve({ id: "att-1" });
        return Promise.resolve({});
      });

      render(<GraphTab />);
      const nA = await screen.findByTestId("graph-node-node-a");
      const nB = await screen.findByTestId("graph-node-node-b");
      const nC = await screen.findByTestId("graph-node-node-c");

      const initAx = nA.getAttribute("data-x");
      const initAy = nA.getAttribute("data-y");
      const initBx = nB.getAttribute("data-x");
      const initBy = nB.getAttribute("data-y");
      const initCx = nC.getAttribute("data-x");
      const initCy = nC.getAttribute("data-y");

      // Connect node-a to node-b
      currentGraph = {
        ...currentGraph,
        nodes: [
          { ...currentGraph.nodes[0]!, degree: 1 },
          { ...currentGraph.nodes[1]!, degree: 1 },
          currentGraph.nodes[2]!,
        ],
        edges: [{ source: "node-a", target: "node-b", kind: "backlink", weight: 1 }],
      };

      const trigger = screen.getByTestId("mock-connect-trigger");
      act(() => {
        trigger.dataset.connectSource = "node-a";
        trigger.dataset.connectTarget = "node-b";
        fireEvent.click(trigger);
      });

      // refetch 가 실제로 반영된 시점 = 새 엣지가 렌더된 시점
      await waitFor(() => {
        expect(screen.getByTestId("mock-edge-backlink:node-a:node-b")).toBeTruthy();
      });

      const afterA = screen.getByTestId("graph-node-node-a");
      const afterB = screen.getByTestId("graph-node-node-b");
      const afterC = screen.getByTestId("graph-node-node-c");

      // 앵커(node-a, id 최솟값)와 구경꾼(node-c)은 제자리
      expect(afterA.getAttribute("data-x")).toBe(initAx);
      expect(afterA.getAttribute("data-y")).toBe(initAy);
      expect(afterC.getAttribute("data-x")).toBe(initCx);
      expect(afterC.getAttribute("data-y")).toBe(initCy);

      // 합류한 node-b 만 이동 — 앵커 곁 반경 34px
      expect({ x: afterB.getAttribute("data-x"), y: afterB.getAttribute("data-y") })
        .not.toEqual({ x: initBx, y: initBy });
      const dist = Math.hypot(
        parseFloat(afterB.getAttribute("data-x")!) - parseFloat(afterA.getAttribute("data-x")!),
        parseFloat(afterB.getAttribute("data-y")!) - parseFloat(afterA.getAttribute("data-y")!),
      );
      expect(dist).toBeCloseTo(34, 5);
    });

    it("D2-2: multi-drag connection connects each selected source to target and calls loadGraph once", async () => {
      const g: DashboardGraphResult = {
        nodes: [
          { id: "src-1", folder_id: "f", title: "Source 1", year: 2026, snippet: "", degree: 0 },
          { id: "src-2", folder_id: "f", title: "Source 2", year: 2026, snippet: "", degree: 0 },
          { id: "src-3", folder_id: "f", title: "Source 3", year: 2026, snippet: "", degree: 0 },
          { id: "tgt", folder_id: "f", title: "Target", year: 2026, snippet: "", degree: 0 },
        ],
        edges: [],
        total: 4,
        cap: 500,
        capped: false,
        edge_total: 0,
        edge_cap: 2500,
        edges_capped: false,
      };

      let loadCount = 0;
      callMock.mockImplementation((command: string) => {
        if (command === "dashboard_graph") {
          loadCount++;
          return Promise.resolve(g);
        }
        if (command === "suggestions_list") return Promise.resolve({ suggestions: [] });
        if (command === "attachment_add_internal") return Promise.resolve({ id: "att" });
        return Promise.resolve({});
      });

      render(<GraphTab />);
      expect(await screen.findByTestId("graph-node-src-1")).toBeTruthy();

      // Multi-select src-1, src-2, src-3
      fireEvent.click(screen.getByTestId("graph-node-src-1"), { shiftKey: true });
      fireEvent.click(screen.getByTestId("graph-node-src-2"), { shiftKey: true });
      fireEvent.click(screen.getByTestId("graph-node-src-3"), { shiftKey: true });

      const initialLoads = loadCount;

      // Start drag from src-1
      const startTrigger = screen.getByTestId("mock-connect-start-trigger");
      act(() => {
        startTrigger.dataset.nodeId = "src-1";
        fireEvent.click(startTrigger);
      });

      // Drop on tgt
      const trigger = screen.getByTestId("mock-connect-trigger");
      act(() => {
        trigger.dataset.connectSource = "src-1";
        trigger.dataset.connectTarget = "tgt";
        fireEvent.click(trigger);
      });

      await waitFor(() => {
        expect(callMock).toHaveBeenCalledWith("attachment_add_internal", {
          note_id: "src-1",
          target_note_id: "tgt",
          name: "Target",
        });
        expect(callMock).toHaveBeenCalledWith("attachment_add_internal", {
          note_id: "src-2",
          target_note_id: "tgt",
          name: "Target",
        });
        expect(callMock).toHaveBeenCalledWith("attachment_add_internal", {
          note_id: "src-3",
          target_note_id: "tgt",
          name: "Target",
        });
      });

      // loadGraph is only called ONCE for the batch — 이제 refetch 는 120ms 트레일링 디바운스를
      // 타므로(연결·절단 공용) 발화를 기다렸다가 세고, 지연 발화가 더 없는지도 확인한다.
      await waitFor(() => {
        expect(loadCount - initialLoads).toBe(1);
      });
      await new Promise((r) => setTimeout(r, 200));
      expect(loadCount - initialLoads).toBe(1);
    });

    // 2026-08-20 오너: 연결하면 노드가 새 레이아웃 위치로 "이동"해야 한다(CSS transform 트랜지션이
    // 그 이동을 애니메이션한다). 예전 위치 동결 캐시(stabilizeConstellationPositions)는 이동 자체를
    // 막았고 리마운트 때만 무전환 텔레포트를 만들었다 — 캐시 제거 후, 그래프가 바뀌면 좌표가 실제로
    // 갱신되는지를 계약으로 박는다.
    it("connecting two isolated nodes moves them to fresh constellation positions", async () => {
      const initialGraph: DashboardGraphResult = {
        nodes: [
          { id: "node-1", folder_id: "f", title: "Note 1", year: 2026, snippet: "", degree: 0 },
          { id: "node-2", folder_id: "f", title: "Note 2", year: 2026, snippet: "", degree: 0 },
        ],
        edges: [],
        total: 2, cap: 500, capped: false, edge_total: 0, edge_cap: 2500, edges_capped: false,
      };
      const afterConnectGraph: DashboardGraphResult = {
        ...initialGraph,
        nodes: [
          { id: "node-1", folder_id: "f", title: "Note 1", year: 2026, snippet: "", degree: 1 },
          { id: "node-2", folder_id: "f", title: "Note 2", year: 2026, snippet: "", degree: 1 },
        ],
        edges: [{ source: "node-1", target: "node-2", kind: "backlink", weight: 1 }],
        edge_total: 1,
      };

      let graphState = initialGraph;
      callMock.mockImplementation((command: string) => {
        if (command === "dashboard_graph") return Promise.resolve(graphState);
        if (command === "suggestions_list") return Promise.resolve({ suggestions: [] });
        if (command === "attachment_add_internal") {
          graphState = afterConnectGraph;
          return Promise.resolve({ id: "att-1" });
        }
        return Promise.resolve({});
      });

      render(<GraphTab />);
      const before = await screen.findByTestId("graph-node-node-2");
      const beforePos = { x: before.dataset.x, y: before.dataset.y };
      const anchorBefore = screen.getByTestId("graph-node-node-1");
      const anchorPos = { x: anchorBefore.dataset.x, y: anchorBefore.dataset.y };

      const trigger = screen.getByTestId("mock-connect-trigger");
      act(() => {
        trigger.dataset.connectSource = "node-1";
        trigger.dataset.connectTarget = "node-2";
        fireEvent.click(trigger);
      });

      // 고립끼리의 연결: id 최솟값(node-1)이 앵커로 제자리에 남고, node-2 가 그 곁으로 이동한다.
      await waitFor(() => {
        const after = screen.getByTestId("graph-node-node-2");
        expect({ x: after.dataset.x, y: after.dataset.y }).not.toEqual(beforePos);
      });
      const anchorAfter = screen.getByTestId("graph-node-node-1");
      expect({ x: anchorAfter.dataset.x, y: anchorAfter.dataset.y }).toEqual(anchorPos);
    });

    // v3 (2026-08-20): 이미 정착한(degree>0) 두 노드를 이으면 — 고립→연결 전환이 없어도 —
    // 서로를 향해 끌려와야 한다. 테스트 DB처럼 대부분이 이미 연결된 그래프에서 "연결해도 아무도
    // 안 움직인다"던 실기 증상의 회귀 방지.
    it("connecting two already-settled nodes pulls them toward each other; bystanders stay", async () => {
      const nodesAt = (degrees: [number, number, number, number]): DashboardGraphResult["nodes"] =>
        (["node-a", "node-b", "node-c", "node-d"] as const).map((id, i) => ({
          id, folder_id: "f", title: id, year: 2026, snippet: "", degree: degrees[i]!,
        }));
      const initialGraph: DashboardGraphResult = {
        nodes: nodesAt([1, 1, 1, 1]),
        edges: [
          { source: "node-a", target: "node-b", kind: "backlink", weight: 1 },
          { source: "node-c", target: "node-d", kind: "backlink", weight: 1 },
        ],
        total: 4, cap: 500, capped: false, edge_total: 2, edge_cap: 2500, edges_capped: false,
      };
      const afterConnectGraph: DashboardGraphResult = {
        ...initialGraph,
        nodes: nodesAt([1, 2, 2, 1]),
        edges: [...initialGraph.edges, { source: "node-b", target: "node-c", kind: "backlink", weight: 1 }],
        edge_total: 3,
      };

      let graphState = initialGraph;
      callMock.mockImplementation((command: string) => {
        if (command === "dashboard_graph") return Promise.resolve(graphState);
        if (command === "suggestions_list") return Promise.resolve({ suggestions: [] });
        if (command === "attachment_add_internal") {
          graphState = afterConnectGraph;
          return Promise.resolve({ id: "att-1" });
        }
        return Promise.resolve({});
      });

      render(<GraphTab />);
      await screen.findByTestId("graph-node-node-a");
      const posOf = (id: string) => {
        const el = screen.getByTestId(`graph-node-${id}`);
        return { x: parseFloat(el.dataset.x!), y: parseFloat(el.dataset.y!) };
      };
      const beforeA = posOf("node-a");
      const beforeB = posOf("node-b");
      const beforeC = posOf("node-c");
      const beforeD = posOf("node-d");
      const distBefore = Math.hypot(beforeC.x - beforeB.x, beforeC.y - beforeB.y);
      expect(distBefore).toBeGreaterThan(50); // 끌림이 실제로 발동하는 배치인지 전제 확인

      const trigger = screen.getByTestId("mock-connect-trigger");
      act(() => {
        trigger.dataset.connectSource = "node-b";
        trigger.dataset.connectTarget = "node-c";
        fireEvent.click(trigger);
      });

      await waitFor(() => {
        expect(screen.getByTestId("mock-edge-backlink:node-b:node-c")).toBeTruthy();
      });

      // 끝점 둘 다 이동, 거리는 절반(최소 갭 50)으로 수축, 구경꾼은 제자리.
      const afterB = posOf("node-b");
      const afterC = posOf("node-c");
      expect(afterB).not.toEqual(beforeB);
      expect(afterC).not.toEqual(beforeC);
      const distAfter = Math.hypot(afterC.x - afterB.x, afterC.y - afterB.y);
      expect(distAfter).toBeCloseTo(Math.max(50, distBefore / 2), 5);
      expect(posOf("node-a")).toEqual(beforeA);
      expect(posOf("node-d")).toEqual(beforeD);
    });

    // v3 ③: 절단하면 끊긴 두 노드가 60px 멀어진다 (끌림의 역방향).
    it("cutting an edge pushes the two endpoints 60px apart", async () => {
      const initialGraph: DashboardGraphResult = {
        nodes: [
          { id: "note-a", folder_id: "f", title: "Note A", year: 2026, snippet: "", degree: 1 },
          { id: "note-b", folder_id: "f", title: "Note B", year: 2026, snippet: "", degree: 1 },
        ],
        edges: [{ source: "note-a", target: "note-b", kind: "backlink", weight: 1 }],
        total: 2, cap: 500, capped: false, edge_total: 1, edge_cap: 2500, edges_capped: false,
      };
      const afterCutGraph: DashboardGraphResult = {
        ...initialGraph,
        nodes: initialGraph.nodes.map((n) => ({ ...n, degree: 0 })),
        edges: [],
        edge_total: 0,
      };

      let graphState = initialGraph;
      callMock.mockImplementation((command: string, args: any) => {
        if (command === "dashboard_graph") return Promise.resolve(graphState);
        if (command === "suggestions_list") return Promise.resolve({ suggestions: [] });
        if (command === "note_get" && args?.id === "note-a") {
          return Promise.resolve({
            note: { id: "note-a", title: "Note A" },
            attachments: [
              { id: "att-internal-1", name: "Note B", kind: "internal", url: "note-b", position: 0, rel_path: null, size_bytes: null },
            ],
            sections: [], sources: [],
          });
        }
        if (command === "attachment_remove") {
          graphState = afterCutGraph;
          return Promise.resolve({ deleted: true });
        }
        return Promise.resolve({});
      });

      const { container } = render(<GraphTab />);
      expect(await screen.findByTestId("graph-node-note-a")).toBeTruthy();
      const posOf = (id: string) => {
        const el = screen.getByTestId(`graph-node-${id}`);
        return { x: parseFloat(el.dataset.x!), y: parseFloat(el.dataset.y!) };
      };
      const beforeA = posOf("note-a");
      const beforeB = posOf("note-b");
      const distBefore = Math.hypot(beforeB.x - beforeA.x, beforeB.y - beforeA.y);

      const edgeGroup = container.querySelector("g");
      fireEvent.mouseEnter(edgeGroup!);
      fireEvent.click(await screen.findByTestId("graph-edge-cut"));

      await waitFor(() => {
        expect(screen.queryByTestId("mock-edge-backlink:note-a:note-b")).toBeNull();
      });
      const afterA = posOf("note-a");
      const afterB = posOf("note-b");
      const distAfter = Math.hypot(afterB.x - afterA.x, afterB.y - afterA.y);
      expect(distAfter).toBeCloseTo(distBefore + 60, 5);
    });


    // 2026-08-20 오너: "다중선택 후 노드를 드래그하면 선택된 모든 노드에서 선이 뽑아져나와야함".
    // 예전 오버레이는 렌더 중 .react-flow__node 를 querySelector 로 찾아 좌표를 얻었고, 그 조회가
    // 실패하면 선이 하나도 안 그려졌다(오버레이 SVG 만 뜨고 path 0개). 이제 flow 좌표로 계산한다.
    it("multi-drag draws a wire from every selected node except the dragged one", async () => {
      const g: DashboardGraphResult = {
        nodes: [
          { id: "s1", folder_id: "f", title: "S1", year: 2026, snippet: "", degree: 0 },
          { id: "s2", folder_id: "f", title: "S2", year: 2026, snippet: "", degree: 0 },
          { id: "s3", folder_id: "f", title: "S3", year: 2026, snippet: "", degree: 0 },
        ],
        edges: [],
        total: 3, cap: 500, capped: false, edge_total: 0, edge_cap: 2500, edges_capped: false,
      };
      callMock.mockImplementation((command: string) => {
        if (command === "dashboard_graph") return Promise.resolve(g);
        if (command === "suggestions_list") return Promise.resolve({ suggestions: [] });
        return Promise.resolve({});
      });
      const { container } = render(<GraphTab />);
      await screen.findByTestId("graph-node-s1");

      fireEvent.click(screen.getByTestId("graph-node-s1"), { shiftKey: true });
      fireEvent.click(screen.getByTestId("graph-node-s2"), { shiftKey: true });
      fireEvent.click(screen.getByTestId("graph-node-s3"), { shiftKey: true });

      const startTrigger = screen.getByTestId("mock-connect-start-trigger");
      act(() => {
        startTrigger.dataset.nodeId = "s1";
        fireEvent.click(startTrigger);
      });
      const canvasEl = container.querySelector(".graph-canvas-container")!;
      fireEvent.pointerMove(canvasEl, { clientX: 50, clientY: 50 });

      expect(screen.queryByTestId("graph-multi-drag-overlay")).toBeTruthy();
      // 3개 선택 중 끄는 노드(s1)를 뺀 2개에서 선이 나온다.
      expect(container.querySelectorAll(".graph-multi-drag-wire").length).toBe(2);
    });


    // 2026-08-20 오너: "한 번 자르면 컷 애니메이션이 여러 군데서 잠깐 등장". 컷 → 재배치가
    // 스트로크 도중 돌면 노드가 새 위치로 날아가고, 아직 눌려 있는 레이저 선분 위로 엣지가
    // 스스로 지나가며 연쇄 절단이 난다. 스트로크가 끝날 때까지 재조회를 미루는 계약을 박는다.
    it("laser: one crossing cuts exactly one edge, and no refetch lands mid-stroke", async () => {
      const g: DashboardGraphResult = {
        nodes: [
          { id: "n1", folder_id: "f", title: "N1", year: 2026, snippet: "", degree: 1 },
          { id: "n2", folder_id: "f", title: "N2", year: 2026, snippet: "", degree: 1 },
          { id: "n3", folder_id: "f", title: "N3", year: 2026, snippet: "", degree: 0 },
        ],
        edges: [{ source: "n1", target: "n2", kind: "backlink", weight: 1 }],
        total: 3, cap: 500, capped: false, edge_total: 1, edge_cap: 2500, edges_capped: false,
      };
      callMock.mockImplementation((command: string, args: any) => {
        if (command === "dashboard_graph") return Promise.resolve(g);
        if (command === "suggestions_list") return Promise.resolve({ suggestions: [] });
        if (command === "note_get") {
          return Promise.resolve({
            note: { id: args?.id, title: args?.id },
            attachments: [{ id: "att-1", name: "N2", kind: "internal", url: "n2", position: 0, rel_path: null, size_bytes: null }],
            sections: [], sources: [],
          });
        }
        return Promise.resolve({});
      });
      const { container } = render(<GraphTab />);
      await screen.findByTestId("graph-node-n1");
      const centre = (id: string) => {
        const el = screen.getByTestId(`graph-node-${id}`);
        return { x: parseFloat(el.dataset.x!) + 12, y: parseFloat(el.dataset.y!) + 12 };
      };
      const a = centre("n1");
      const b = centre("n2");
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      // 엣지에 수직인 짧은 스트로크
      const ex = b.x - a.x, ey = b.y - a.y;
      const len = Math.hypot(ex, ey) || 1;
      const nx = -ey / len, ny = ex / len;
      const canvasEl = container.querySelector(".graph-canvas-container")!;
      act(() => {
        fireEvent.keyDown(window, { key: "Alt" });
      });
      fireEvent.pointerDown(canvasEl, { button: 0, buttons: 1, altKey: true, clientX: mid.x - nx * 20, clientY: mid.y - ny * 20 });
      fireEvent.pointerMove(canvasEl, { buttons: 1, altKey: true, clientX: mid.x + nx * 20, clientY: mid.y + ny * 20 });

      // 크로싱 하나 → 버스트 하나, 절단 하나.
      await waitFor(() => {
        expect(screen.queryAllByTestId("graph-cut-burst").length).toBe(1);
      });
      expect(callMock.mock.calls.filter((c: any[]) => c[0] === "note_get").length).toBe(1);

      // 스트로크가 살아 있는 동안에는 디바운스가 지나도 재조회가 나가지 않는다.
      const graphCallsAfterCut = callMock.mock.calls.filter((c: any[]) => c[0] === "dashboard_graph").length;
      await new Promise((r) => setTimeout(r, 200));
      expect(callMock.mock.calls.filter((c: any[]) => c[0] === "dashboard_graph").length).toBe(graphCallsAfterCut);

      // 손을 떼면 그제야 한 번 나간다.
      fireEvent.pointerUp(canvasEl, { buttons: 0 });
      await waitFor(() => {
        expect(callMock.mock.calls.filter((c: any[]) => c[0] === "dashboard_graph").length).toBe(graphCallsAfterCut + 1);
      });
    });

    // 2026-08-20 오너 실기 버그 2건(유령 절단 밀어내기 · 연결 시 노트 사라짐)의 공통 뿌리:
    // 같은 세대 안에서 먼저 시작한 refetch 가 늦게 도착해 최신 결과를 덮어쓰는 레이스.
    // loadGraph 의 latest-wins seq 가드가 stale 응답을 버리는지 검증한다.
    it("latest-wins: a stale refetch resolving late cannot overwrite a newer graph", async () => {
      const node = (id: string, degree: number) =>
        ({ id, folder_id: "f", title: id, year: 2026, snippet: "", degree });
      const base = { total: 3, cap: 500, capped: false, edge_cap: 2500, edges_capped: false };
      const G0: DashboardGraphResult = {
        ...base, nodes: [node("n1", 0), node("n2", 0), node("n3", 0)], edges: [], edge_total: 0,
      };
      const G1stale: DashboardGraphResult = {
        ...base, nodes: [node("n1", 1), node("n2", 1), node("n3", 0)],
        edges: [{ source: "n1", target: "n2", kind: "backlink", weight: 1 }], edge_total: 1,
      };
      const G2: DashboardGraphResult = {
        ...base, nodes: [node("n1", 2), node("n2", 1), node("n3", 1)],
        edges: [
          { source: "n1", target: "n2", kind: "backlink", weight: 1 },
          { source: "n1", target: "n3", kind: "backlink", weight: 1 },
        ], edge_total: 2,
      };

      let graphCalls = 0;
      const deferreds: Array<(g: DashboardGraphResult) => void> = [];
      callMock.mockImplementation((command: string) => {
        if (command === "dashboard_graph") {
          graphCalls += 1;
          if (graphCalls === 1) return Promise.resolve(G0);
          return new Promise<DashboardGraphResult>((res) => { deferreds.push(res); });
        }
        if (command === "suggestions_list") return Promise.resolve({ suggestions: [] });
        if (command === "attachment_add_internal") return Promise.resolve({ id: "att" });
        return Promise.resolve({});
      });

      render(<GraphTab />);
      expect(await screen.findByTestId("graph-node-n1")).toBeTruthy();

      const trigger = screen.getByTestId("mock-connect-trigger");
      act(() => {
        trigger.dataset.connectSource = "n1";
        trigger.dataset.connectTarget = "n2";
        fireEvent.click(trigger);
      });
      // 디바운스가 발화해 refetch #1 이 in-flight 가 될 때까지
      await waitFor(() => expect(deferreds.length).toBe(1));

      act(() => {
        trigger.dataset.connectSource = "n1";
        trigger.dataset.connectTarget = "n3";
        fireEvent.click(trigger);
      });
      await waitFor(() => expect(deferreds.length).toBe(2));

      // 나중에 시작한 #2 가 먼저 도착(최신), 먼저 시작한 #1 이 늦게 도착(stale)
      act(() => deferreds[1]!(G2));
      await waitFor(() => {
        expect(screen.getByTestId("mock-edge-backlink:n1:n3")).toBeTruthy();
      });
      act(() => deferreds[0]!(G1stale));
      await new Promise((r) => setTimeout(r, 50));
      // stale 스냅샷이 반영됐다면 n1:n3 엣지가 사라졌을 것이다
      expect(screen.queryByTestId("mock-edge-backlink:n1:n3")).toBeTruthy();
    });
  });

  // 노트 연결 핸들러 통합(useGraphConnect) 특성화 — 링크 이름 산출·in-flight 잠금·실패 경로·
  // 선택 전부 연결의 호출 집합·워크스페이스 전환 초기화·절단 되돌리기 표식을 리팩터 전 코드로
  // 먼저 통과시켜 못 박았다.
  describe("connect handlers: link naming, in-flight lock, failure and reset paths", () => {
    const note = (id: string, title: string) => ({ id, folder_id: "f", title, year: 2026, snippet: "", degree: 0 });
    const graphOf = (
      nodes: ReturnType<typeof note>[],
      edges: DashboardGraphResult["edges"] = [],
    ): DashboardGraphResult => ({
      nodes,
      edges,
      total: nodes.length,
      cap: 500,
      capped: false,
      edge_total: edges.length,
      edge_cap: 2500,
      edges_capped: false,
    });
    const drop = (source: string, target: string) => {
      const trigger = screen.getByTestId("mock-connect-trigger");
      act(() => {
        trigger.dataset.connectSource = source;
        trigger.dataset.connectTarget = target;
        fireEvent.click(trigger);
      });
    };
    const addCalls = () => callMock.mock.calls.filter(([command]) => command === "attachment_add_internal");

    it("names the link after the target title and falls back to the untitled label", async () => {
      const g = graphOf([note("a", "Alpha"), note("b", ""), note("c", "Untitled Note"), note("d", "   ")]);
      callMock.mockImplementation((command: string) => {
        if (command === "dashboard_graph") return Promise.resolve(g);
        if (command === "suggestions_list") return Promise.resolve({ suggestions: [] });
        if (command === "attachment_add_internal") return Promise.resolve({ id: "att" });
        return Promise.resolve({});
      });

      render(<GraphTab />);
      expect(await screen.findByTestId("graph-node-a")).toBeTruthy();

      drop("b", "a");
      drop("c", "b");
      drop("a", "c");
      drop("a", "d");

      await waitFor(() => expect(addCalls().length).toBe(4));
      expect(callMock).toHaveBeenCalledWith("attachment_add_internal", { note_id: "b", target_note_id: "a", name: "Alpha" });
      expect(callMock).toHaveBeenCalledWith("attachment_add_internal", { note_id: "c", target_note_id: "b", name: "제목 없음" });
      expect(callMock).toHaveBeenCalledWith("attachment_add_internal", { note_id: "a", target_note_id: "c", name: "제목 없음" });
      expect(callMock).toHaveBeenCalledWith("attachment_add_internal", { note_id: "a", target_note_id: "d", name: "제목 없음" });
    });

    it("holds an in-flight lock per unordered pair until the call settles", async () => {
      const g = graphOf([note("a", "Alpha"), note("b", "Beta")]);
      const pending = deferred<{ id: string }>();
      callMock.mockImplementation((command: string) => {
        if (command === "dashboard_graph") return Promise.resolve(g);
        if (command === "suggestions_list") return Promise.resolve({ suggestions: [] });
        if (command === "attachment_add_internal") {
          return addCalls().length === 1 ? pending.promise : Promise.resolve({ id: "att-2" });
        }
        return Promise.resolve({});
      });

      render(<GraphTab />);
      expect(await screen.findByTestId("graph-node-a")).toBeTruthy();

      drop("a", "b");
      drop("b", "a"); // 역방향도 같은 쌍 — 잠겨 있다
      drop("a", "b");
      expect(addCalls().length).toBe(1);

      await act(async () => {
        pending.resolve({ id: "att-1" });
      });

      drop("a", "b"); // 정착한 뒤에는 다시 나간다
      await waitFor(() => expect(addCalls().length).toBe(2));
    });

    it("releases the lock and skips the marker when the attachment call fails", async () => {
      const g = graphOf([note("a", "Alpha"), note("b", "Beta")]);
      callMock.mockImplementation((command: string) => {
        if (command === "dashboard_graph") return Promise.resolve(g);
        if (command === "suggestions_list") return Promise.resolve({ suggestions: [] });
        if (command === "attachment_add_internal") {
          return addCalls().length === 1 ? Promise.reject(new Error("boom")) : Promise.resolve({ id: "att-2" });
        }
        return Promise.resolve({});
      });

      render(<GraphTab />);
      expect(await screen.findByTestId("graph-node-a")).toBeTruthy();

      drop("a", "b");
      await waitFor(() => expect(addCalls().length).toBe(1));
      await new Promise((r) => setTimeout(r, 30));
      expect(screen.getByTestId("graph-node-a").dataset.justConnected).toBeUndefined();

      drop("a", "b"); // 실패한 뒤에는 잠금이 풀려 재시도할 수 있다
      await waitFor(() => expect(addCalls().length).toBe(2));
      await waitFor(() => expect(screen.getByTestId("graph-node-a").dataset.justConnected).toBe("true"));
    });

    it("connects only the missing pairs among the selection, naming each link after its second node", async () => {
      const g = graphOf(
        [note("a", "Alpha"), note("b", "Beta"), note("c", "Gamma")],
        [{ source: "b", target: "a", kind: "backlink", weight: 1 }],
      );
      callMock.mockImplementation((command: string) => {
        if (command === "dashboard_graph") return Promise.resolve(g);
        if (command === "suggestions_list") return Promise.resolve({ suggestions: [] });
        if (command === "attachment_add_internal") return Promise.resolve({ id: "att" });
        return Promise.resolve({});
      });

      render(<GraphTab />);
      const a = await screen.findByTestId("graph-node-a");
      fireEvent.click(a, { shiftKey: true });
      fireEvent.click(screen.getByTestId("graph-node-b"), { shiftKey: true });
      fireEvent.click(screen.getByTestId("graph-node-c"), { shiftKey: true });

      fireEvent.click(screen.getByTestId("graph-multi-connect-btn"));

      await waitFor(() => expect(addCalls().length).toBe(2));
      expect(callMock).toHaveBeenCalledWith("attachment_add_internal", { note_id: "a", target_note_id: "c", name: "Gamma" });
      expect(callMock).toHaveBeenCalledWith("attachment_add_internal", { note_id: "b", target_note_id: "c", name: "Gamma" });
    });

    it("clears the in-flight lock when the workspace changes", async () => {
      const g = graphOf([note("a", "Alpha"), note("b", "Beta")]);
      const never = deferred<{ id: string }>();
      callMock.mockImplementation((command: string) => {
        if (command === "dashboard_graph") return Promise.resolve(g);
        if (command === "suggestions_list") return Promise.resolve({ suggestions: [] });
        if (command === "attachment_add_internal") {
          return addCalls().length === 1 ? never.promise : Promise.resolve({ id: "att-2" });
        }
        return Promise.resolve({});
      });

      render(<GraphTab />);
      expect(await screen.findByTestId("graph-node-a")).toBeTruthy();

      drop("a", "b");
      expect(addCalls().length).toBe(1);

      act(() => useSettingsStore.setState({ activeWorkspaceId: "B" }));
      await waitFor(() => expect(screen.getByTestId("graph-node-a")).toBeTruthy());

      drop("a", "b"); // 첫 호출이 아직 안 끝났어도 전환이 잠금을 비웠다
      await waitFor(() => expect(addCalls().length).toBe(2));
    });

    it("marks the restored edge as just created when a cut is undone", async () => {
      showUndoToastMock.mockReset();
      const g = graphOf(
        [note("note-a", "Note A"), note("note-b", "Note B")],
        [{ source: "note-a", target: "note-b", kind: "backlink", weight: 1 }],
      );
      callMock.mockImplementation((command: string, args: any) => {
        if (command === "dashboard_graph") return Promise.resolve(g);
        if (command === "suggestions_list") return Promise.resolve({ suggestions: [] });
        if (command === "note_get" && args?.id === "note-a") {
          return Promise.resolve({
            note: { id: "note-a", title: "Note A" },
            attachments: [
              { id: "att-internal-1", name: "Note B", kind: "internal", url: "note-b", position: 0, rel_path: null, size_bytes: null },
            ],
            sections: [],
            sources: [],
          });
        }
        if (command === "attachment_remove") return Promise.resolve({ deleted: true });
        if (command === "attachment_add_internal") return Promise.resolve({ id: "att-restored" });
        return Promise.resolve({});
      });

      const { container } = render(<GraphTab />);
      expect(await screen.findByTestId("graph-node-note-a")).toBeTruthy();
      fireEvent.mouseEnter(container.querySelector("g")!);
      fireEvent.click(await screen.findByTestId("graph-edge-cut"));
      await waitFor(() => expect(showUndoToastMock).toHaveBeenCalled());

      expect(screen.getByTestId("mock-edge-backlink:note-a:note-b").dataset.justCreated).toBeUndefined();
      await act(async () => {
        await showUndoToastMock.mock.calls[0][1]();
      });

      await waitFor(() => {
        expect(callMock).toHaveBeenCalledWith("attachment_add_internal", {
          note_id: "note-a",
          target_note_id: "note-b",
          name: "Note B",
        });
        expect(screen.getByTestId("mock-edge-backlink:note-a:note-b").dataset.justCreated).toBe("true");
      });
    });

    it("names the links to a freshly created note after its title, falling back to the untitled label", async () => {
      const g = graphOf([note("s1", "S1"), note("s2", "S2")]);
      callMock.mockImplementation((command: string) => {
        if (command === "dashboard_graph") return Promise.resolve(g);
        if (command === "suggestions_list") return Promise.resolve({ suggestions: [] });
        if (command === "note_create") return Promise.resolve({ note: { id: "fresh", title: "" } });
        if (command === "attachment_add_internal") return Promise.resolve({ id: "att" });
        return Promise.resolve({});
      });

      render(<GraphTab />);
      fireEvent.click(await screen.findByTestId("graph-node-s1"), { shiftKey: true });
      fireEvent.click(screen.getByTestId("graph-node-s2"), { shiftKey: true });

      const startTrigger = screen.getByTestId("mock-connect-start-trigger");
      startTrigger.setAttribute("data-node-id", "s1");
      fireEvent.click(startTrigger);
      fireEvent.click(screen.getByTestId("mock-connect-end-trigger"));

      await waitFor(() => expect(addCalls().length).toBe(2));
      expect(callMock).toHaveBeenCalledWith("attachment_add_internal", { note_id: "s1", target_note_id: "fresh", name: "제목 없음" });
      expect(callMock).toHaveBeenCalledWith("attachment_add_internal", { note_id: "s2", target_note_id: "fresh", name: "제목 없음" });
    });
  });
});
