import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, waitFor, within } from "@testing-library/react";

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

// FlowCanvas(lazy)의 첫 import 는 vitest 변환 비용만 ~9s(2026-10-07 실측, reactflow 포함)다. 미리
// 데워 두지 않으면 실캔버스를 기다리는 테스트가 단독 실행·부하 걸린 전체 스위트에서 5s 대기/10s
// 타임아웃 안에 못 끝나 "diagram-legend 없음"으로 실패했다 — 제품 결함이 아니라 콜드 로드 시간.
// 여기서 한 번 로드하면 아래 lazy() 는 이미 해결된 모듈을 받는다.
beforeAll(() => import("./FlowCanvas"), 60_000);

const updateSectionBodyMock = vi.fn();
// note는 대부분의 기존 테스트에 없다(activeNote?.note?.content_locked처럼 항상 이중
// optional-chaining으로 읽는 이유) — 내용잠금 테스트만 채워 넣는다.
let mockActiveNote: { sections: Section[]; note?: { content_locked: boolean } } | null = null;
const setStateMock = vi.fn((patch: { activeNote?: { sections: Section[] } }) => {
  if (patch.activeNote) mockActiveNote = patch.activeNote;
});

// DiagramSection이 이제 content_locked 표시(textarea readOnly)를 위해 useNotesStore를 zustand
// 훅처럼(selector 인자로) 부른다 — getState/setState만 있는 예전 모양의 목으로는
// "useNotesStore is not a function"으로 죽는다. 실제 zustand 스토어처럼 callable + getState/
// setState를 함께 붙인다.
vi.mock("../../stores/notes", () => {
  const getState = () => ({
    updateSectionBody: updateSectionBodyMock,
    activeNote: mockActiveNote,
    selectNote: vi.fn(),
  });
  const useNotesStore = Object.assign(
    (selector?: (s: ReturnType<typeof getState>) => unknown) => {
      const state = getState();
      return selector ? selector(state) : state;
    },
    {
      getState,
      setState: (patch: { activeNote?: { sections: Section[] } }) => setStateMock(patch),
    },
  );
  return { useNotesStore };
});

vi.mock("../../lib/noteSummaries", () => ({
  fetchNoteSummary: vi.fn().mockResolvedValue({ id: "note-1", title: "Target Note" }),
  fetchNoteSummariesMap: vi.fn().mockResolvedValue({}),
}));

import { DiagramSection } from "./DiagramSection";
import { parseDiagram } from "./diagramModel";
import { getDiagramTarget } from "../../lib/aiSectionBridge";
import { flushAll } from "../../lib/invoke";
import * as invoke from "../../lib/invoke";
import type { Section } from "../../lib/commands.gen";

const SAMPLE_JSON = JSON.stringify({
  v: 1,
  nodes: [
    { id: "n1", label: "김철수", shape: "rect" },
    { id: "n2", label: "김영수", shape: "rect" },
  ],
  edges: [
    { id: "e1", from: "n1", to: "n2", label: "아들", line: "solid", arrow: "end" },
  ],
});

const diagramSection = (overrides: Partial<Section> = {}): Section => ({
  id: "sec-1",
  name: "Relations",
  body_md: SAMPLE_JSON,
  position: 0,
  kind: "diagram",
  ...overrides,
});

describe("DiagramSection — JSON IR v1 integration suite", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    updateSectionBodyMock.mockReset();
    setStateMock.mockClear();
    mockActiveNote = null;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const flush = (ms = 0) => act(() => vi.advanceTimersByTimeAsync(ms));

  it("renders toolbar and canvas on mount, without showing source textarea", async () => {
    render(<DiagramSection section={diagramSection()} />);
    await flush();

    expect(screen.getByTestId("diagram-section")).toBeTruthy();
    expect(screen.getByTestId("diagram-view-tools")).toBeTruthy();
    expect(screen.queryByTestId("diagram-source-textarea")).toBeNull();
  });

  it("switches to source edit mode and back with diagram-edit-source and done button", async () => {
    render(<DiagramSection section={diagramSection()} />);
    await flush();

    fireEvent.click(screen.getByTestId("diagram-edit-source"));
    expect(screen.getByTestId("diagram-source-panel")).toBeTruthy();
    const textarea = screen.getByTestId("diagram-source-textarea") as HTMLTextAreaElement;
    expect(textarea.value).toBe(SAMPLE_JSON);

    fireEvent.click(screen.getByTestId("diagram-source-done"));
    expect(screen.queryByTestId("diagram-source-panel")).toBeNull();
  });

  it("autosaves edited source on 700ms debounce", async () => {
    render(<DiagramSection section={diagramSection()} />);
    await flush();

    fireEvent.click(screen.getByTestId("diagram-edit-source"));
    const textarea = screen.getByTestId("diagram-source-textarea");
    const nextJson = JSON.stringify({ v: 1, nodes: [{ id: "n1", label: "이순신" }], edges: [] });
    fireEvent.change(textarea, { target: { value: nextJson } });

    expect(updateSectionBodyMock).not.toHaveBeenCalled();
    await flush(700);
    expect(updateSectionBodyMock).toHaveBeenCalledWith("sec-1", nextJson);
  });

  it("blurring or leaving edit mode saves immediately without waiting out debounce", async () => {
    render(<DiagramSection section={diagramSection()} />);
    await flush();

    fireEvent.click(screen.getByTestId("diagram-edit-source"));
    const textarea = screen.getByTestId("diagram-source-textarea");
    const nextJson = JSON.stringify({ v: 1, nodes: [{ id: "n1", label: "강감찬" }], edges: [] });
    fireEvent.change(textarea, { target: { value: nextJson } });
    fireEvent.click(screen.getByTestId("diagram-source-done"));
    await flush();

    expect(updateSectionBodyMock).toHaveBeenCalledWith("sec-1", nextJson);
  });

  it("patches activeNote.sections on save to prevent stale body_md revert", async () => {
    const target = diagramSection();
    const other = diagramSection({ id: "sec-other", body_md: "other" });
    mockActiveNote = { sections: [target, other] };

    render(<DiagramSection section={target} />);
    await flush();

    fireEvent.click(screen.getByTestId("diagram-edit-source"));
    const textarea = screen.getByTestId("diagram-source-textarea");
    const nextJson = JSON.stringify({ v: 1, nodes: [{ id: "n1", label: "을지문덕" }], edges: [] });
    fireEvent.change(textarea, { target: { value: nextJson } });
    fireEvent.click(screen.getByTestId("diagram-source-done"));
    await flush();

    expect(mockActiveNote?.sections.find((s) => s.id === "sec-1")?.body_md).toBe(nextJson);
    expect(mockActiveNote?.sections.find((s) => s.id === "sec-other")?.body_md).toBe("other");
  });

  it("renders empty state pointing at the assist panel, with no template grid, and a ghost overlay mounted in the stage", async () => {
    render(<DiagramSection section={diagramSection({ body_md: "  " })} />);
    await flush();

    expect(screen.getByTestId("diagram-empty-state")).toBeTruthy();
    // PLAN-2026-09-21 W2 — 타입 그리드는 어시스트 패널로 일원화됐다. 빈 상태엔 더 이상 없다.
    expect(screen.queryByTestId("diagram-tpl-people")).toBeNull();
    expect(screen.queryByTestId("diagram-tpl-process")).toBeNull();
    expect(screen.queryByTestId("diagram-tpl-decision")).toBeNull();
    // 호버 고스트는 항상 stage 안에 마운트돼 있다(안 보일 땐 opacity 0) — DiagramAssist 의 타입 행을
    // 호버하면 여기(.diagram-stage)에 실물 크기로 뜬다.
    expect(document.querySelector(".diagram-stage .ghost-preview")).toBeTruthy();
  });

  it("빈 상태 '텍스트로 시작' → 입력 → 확정하면 파싱 결과가 그대로 본문이 된다", async () => {
    render(<DiagramSection section={diagramSection({ body_md: "" })} />);
    await flush();

    fireEvent.click(screen.getByTestId("diagram-text-start-toggle"));
    fireEvent.change(screen.getByTestId("diagram-text-input"), { target: { value: "A -> B: 관계" } });
    fireEvent.click(screen.getByTestId("diagram-text-apply"));
    await flush(700);

    expect(updateSectionBodyMock).toHaveBeenCalled();
    const savedBody = updateSectionBodyMock.mock.calls[updateSectionBodyMock.mock.calls.length - 1][1] as string;
    const model = parseDiagram(savedBody);
    expect(model.nodes.map((n) => n.label)).toEqual(["A", "B"]);
    expect(model.edges[0]).toMatchObject({ from: "n1", to: "n2", label: "관계" });
    expect(screen.queryByTestId("diagram-empty-state")).toBeNull();
  });

  it("빈 상태 텍스트 입력이 실패하면 본문이 그대로고 오류 줄이 보인다", async () => {
    render(<DiagramSection section={diagramSection({ body_md: "" })} />);
    await flush();

    fireEvent.click(screen.getByTestId("diagram-text-start-toggle"));
    fireEvent.change(screen.getByTestId("diagram-text-input"), { target: { value: "A\n    B" } });
    fireEvent.click(screen.getByTestId("diagram-text-apply"));

    expect(screen.getByTestId("diagram-text-error")).toBeTruthy();
    expect(updateSectionBodyMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("diagram-empty-state")).toBeTruthy();
  });

  it("registers aiSectionBridge target on mount and unregisters on unmount", async () => {
    expect(getDiagramTarget()).toBeNull();
    const view = render(<DiagramSection section={diagramSection()} />);
    await flush();

    const target = getDiagramTarget();
    expect(target).not.toBeNull();
    expect(target?.sectionId).toBe("sec-1");
    expect(target?.source).toBe(SAMPLE_JSON);

    view.unmount();
    expect(getDiagramTarget()).toBeNull();
  });

  it("aiSectionBridge live draft source updates as user types in source mode", async () => {
    render(<DiagramSection section={diagramSection()} />);
    await flush();

    fireEvent.click(screen.getByTestId("diagram-edit-source"));
    const textarea = screen.getByTestId("diagram-source-textarea");
    const nextJson = JSON.stringify({ v: 1, nodes: [{ id: "n1", label: "세종대왕" }], edges: [] });
    fireEvent.change(textarea, { target: { value: nextJson } });

    expect(getDiagramTarget()?.source).toBe(nextJson);
  });

  it("aiSectionBridge replaceSection replaces body and supports undo", async () => {
    const sec = diagramSection();
    mockActiveNote = { sections: [sec] };
    render(<DiagramSection section={sec} />);
    await flush();

    const nextJson = JSON.stringify({ v: 1, nodes: [{ id: "n99", label: "AI생성노드" }], edges: [] });
    await act(async () => {
      await getDiagramTarget()!.replaceSection(nextJson);
    });
    await flush(700);

    expect(updateSectionBodyMock).toHaveBeenLastCalledWith("sec-1", nextJson);
    expect(mockActiveNote.sections[0].body_md).toBe(nextJson);
    expect((screen.getByTestId("diagram-undo") as HTMLButtonElement).disabled).toBe(false);

    // Undo reverts back to SAMPLE_JSON
    fireEvent.click(screen.getByTestId("diagram-undo"));
    await flush(700);
    expect(updateSectionBodyMock).toHaveBeenLastCalledWith("sec-1", SAMPLE_JSON);
  });

  // F-N09 확장: 다이어그램/캔버스 섹션도 시트와 같은 원칙으로 잠긴다 — 모든 구조 편집
  // (makeDiagramActions)과 원본 텍스트 편집이 applyMutation 한 지점으로 모이므로 여기서 막히면
  // 툴바 조작 전부가 막힌다. AI "관계도 수정하기"(replaceSection)는 명시적 적용 동작이라 알림도 함께 확인한다.
  it("잠긴 노트에서는 AI 관계도 수정하기(replaceSection)가 문서를 바꾸지 않고 잠금 안내를 띄운다", async () => {
    const sec = diagramSection();
    mockActiveNote = { sections: [sec], note: { content_locked: true } };
    render(<DiagramSection section={sec} />);
    await flush();

    const emitNoticeSpy = vi.spyOn(invoke, "emitNotice");
    const nextJson = JSON.stringify({ v: 1, nodes: [{ id: "n99", label: "AI생성노드" }], edges: [] });
    await act(async () => {
      await getDiagramTarget()!.replaceSection(nextJson);
    });
    await flush(700);

    expect(updateSectionBodyMock).not.toHaveBeenCalled();
    expect(emitNoticeSpy).toHaveBeenCalledWith("Content is locked — editing disabled");
  });

  it("잠긴 노트에서는 원본 텍스트(JSON) 편집도 저장되지 않는다", async () => {
    const sec = diagramSection();
    mockActiveNote = { sections: [sec], note: { content_locked: true } };
    render(<DiagramSection section={sec} />);
    await flush();

    fireEvent.click(screen.getByTestId("diagram-edit-source"));
    const textarea = screen.getByTestId("diagram-source-textarea") as HTMLTextAreaElement;
    expect(textarea.readOnly).toBe(true);
    fireEvent.change(textarea, { target: { value: '{"v":1,"nodes":[],"edges":[]}' } });
    await flush(700);

    expect(updateSectionBodyMock).not.toHaveBeenCalled();
  });

  // 손 타이핑은 구조 편집 이력을 양방향 모두 비운다 — 안 그러면 되돌리기가 방금 친 텍스트를
  // 조용히 삼킨다. JSON IR 전환(88195857) 때 옛 setHistory 헬퍼와 함께 유실됐던 계약이라,
  // 이 테스트가 재발 감시자다.
  it("hand-typing clears the structured undo history so 되돌리기 can never eat typed text", async () => {
    render(<DiagramSection section={diagramSection()} />);
    await flush();

    const undoBtn = () => screen.getByTestId("diagram-undo") as HTMLButtonElement;
    const redoBtn = () => screen.getByTestId("diagram-redo") as HTMLButtonElement;

    const mutated = JSON.stringify({ v: 1, nodes: [{ id: "n1", label: "구조편집" }], edges: [] });
    await act(async () => {
      await getDiagramTarget()!.replaceSection(mutated);
    });
    await flush(700);
    expect(undoBtn().disabled).toBe(false);

    // 되돌리기를 한 번 눌러 앞으로(redo)까지 살려 둔다 — 양방향 모두 비워지는지 봐야 한다.
    fireEvent.click(undoBtn());
    await flush(700);
    expect(redoBtn().disabled).toBe(false);

    fireEvent.click(screen.getByTestId("diagram-edit-source"));
    const typed = JSON.stringify({ v: 1, nodes: [{ id: "n1", label: "손으로 친 것" }], edges: [] });
    fireEvent.change(screen.getByTestId("diagram-source-textarea"), { target: { value: typed } });
    await flush(700);
    expect(updateSectionBodyMock).toHaveBeenLastCalledWith("sec-1", typed);

    // 되돌리기/앞으로 버튼은 그림 모드에만 있다 — 소스 모드를 나온 뒤가 사용자가 그 버튼을
    // 다시 만나는 시점이고, 그때 둘 다 죽어 있어야 손으로 친 것이 안전하다.
    fireEvent.click(screen.getByTestId("diagram-source-done"));
    await flush(700);

    expect(undoBtn().disabled).toBe(true);
    expect(redoBtn().disabled).toBe(true);
  });

  it("undo and redo buttons correctly step through mutations", async () => {
    render(<DiagramSection section={diagramSection()} />);
    await flush();

    const undoBtn = () => screen.getByTestId("diagram-undo") as HTMLButtonElement;
    const redoBtn = () => screen.getByTestId("diagram-redo") as HTMLButtonElement;

    expect(undoBtn().disabled).toBe(true);
    expect(redoBtn().disabled).toBe(true);

    const step1 = JSON.stringify({ v: 1, nodes: [{ id: "n1", label: "1단계" }], edges: [] });
    const step2 = JSON.stringify({ v: 1, nodes: [{ id: "n1", label: "2단계" }], edges: [] });

    await act(async () => {
      await getDiagramTarget()!.replaceSection(step1);
    });
    await flush(700);

    await act(async () => {
      await getDiagramTarget()!.replaceSection(step2);
    });
    await flush(700);

    expect(undoBtn().disabled).toBe(false);
    expect(redoBtn().disabled).toBe(true);

    // Undo step2 -> step1
    fireEvent.click(undoBtn());
    await flush(700);
    expect(updateSectionBodyMock).toHaveBeenLastCalledWith("sec-1", step1);
    expect(redoBtn().disabled).toBe(false);

    // Redo step1 -> step2
    fireEvent.click(redoBtn());
    await flush(700);
    expect(updateSectionBodyMock).toHaveBeenLastCalledWith("sec-1", step2);
    expect(redoBtn().disabled).toBe(true);
  });

  it("shows the hint bar on desktop view mode, with node/edge counts in the canvas legend", async () => {
    vi.useRealTimers();
    render(<DiagramSection section={diagramSection()} />);

    expect(screen.getByTestId("diagram-hint-bar")).toBeTruthy();
    // 실타이머 + FlowCanvas 첫 로드라 기본 1s 를 자주 넘긴다(실측 ~1.25s) — 대기만 늘린다.
    const legend = await screen.findByTestId("diagram-legend", undefined, { timeout: 5000 });
    expect(legend.textContent).toContain("2");
    expect(legend.textContent).toContain("1");
    vi.useFakeTimers();
  });

  it("mounts touch surface DiagramControls when touch prop is true", async () => {
    render(<DiagramSection section={diagramSection()} touch />);
    await flush();

    const controls = screen.getByTestId("diagram-controls");
    expect(controls).toBeTruthy();
    expect(controls.querySelector('[data-testid="diagram-add-node-toggle"]')).toBeTruthy();
    expect(controls.querySelector('[data-testid="diagram-add-edge-toggle"]')).toBeTruthy();
  });
});

// ─── Touch add-forms (recovered from the mermaid-era suite — DiagramControls' collapsed/expanded
// forms are the one authoring surface that never depends on the lazily-loaded FlowCanvas, so these
// stay on fake timers like the rest of this file) ───────────────────────────────────────────────
describe("DiagramSection — touch add-forms collapse/expand", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    updateSectionBodyMock.mockReset();
    setStateMock.mockClear();
    mockActiveNote = null;
  });
  afterEach(() => vi.useRealTimers());
  const flush = (ms = 0) => act(() => vi.advanceTimersByTimeAsync(ms));

  const BODY_JSON = JSON.stringify({
    v: 1,
    nodes: [{ id: "n1", label: "김철수" }, { id: "n2", label: "김영수" }],
    edges: [],
  });
  const mountTouch = () => render(<DiagramSection section={diagramSection({ body_md: BODY_JSON })} touch />);

  it("the add-forms start collapsed, expand one at a time, and collapse again once the item is added", async () => {
    mountTouch();
    await flush();

    expect(screen.queryByTestId("diagram-node-label")).toBeNull();
    expect(screen.queryByTestId("diagram-edge-from")).toBeNull();

    fireEvent.click(screen.getByTestId("diagram-add-node-toggle"));
    expect(screen.getByTestId("diagram-node-label")).toBeTruthy();
    // Only ever one open — the quiet toggle buttons are gone while a form is showing.
    expect(screen.queryByTestId("diagram-add-edge-toggle")).toBeNull();

    fireEvent.change(screen.getByTestId("diagram-node-label"), { target: { value: "김민수" } });
    fireEvent.click(screen.getByTestId("diagram-add-node"));
    await flush(700);

    expect(updateSectionBodyMock).toHaveBeenCalled();
    const savedBody = updateSectionBodyMock.mock.calls[updateSectionBodyMock.mock.calls.length - 1][1] as string;
    const model = parseDiagram(savedBody);
    expect(model.nodes.some((n) => n.label === "김민수")).toBe(true);
    // …and the form collapsed back to the two quiet toggle buttons.
    expect(screen.queryByTestId("diagram-node-label")).toBeNull();
    expect(screen.getByTestId("diagram-add-node-toggle")).toBeTruthy();
  });

  it("Enter submits and Esc collapses, and both still write through diagramModel", async () => {
    mountTouch();
    await flush();

    fireEvent.click(screen.getByTestId("diagram-add-node-toggle"));
    const input = screen.getByTestId("diagram-node-label");
    fireEvent.change(input, { target: { value: "김민수" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await flush(700);

    const savedBody = updateSectionBodyMock.mock.calls[updateSectionBodyMock.mock.calls.length - 1][1] as string;
    expect(parseDiagram(savedBody).nodes.some((n) => n.label === "김민수")).toBe(true);

    fireEvent.click(screen.getByTestId("diagram-add-edge-toggle"));
    expect(screen.getByTestId("diagram-edge-from")).toBeTruthy();
    fireEvent.keyDown(screen.getByTestId("diagram-edge-label"), { key: "Escape" });
    expect(screen.queryByTestId("diagram-edge-from")).toBeNull();
    expect(screen.getByTestId("diagram-add-edge-toggle")).toBeTruthy();
  });
});

// ─── The picture surface's leftover-height contract (recovered) ───────────────────────────────────
// `.diagram-stage` no longer carries a data-testid (the mermaid-era suite's `getByTestId` would find
// nothing now — this wraps FlowCanvas via React.lazy/Suspense instead of a centred, auto-scrolling
// SVG, so it is queried by className instead). The behavioural contract survives the rebuild even
// though the exact CSS values changed (overflow:hidden + React Flow's own pan/zoom replaces
// overflow:auto + centring margins): the stage grows into the section's leftover space instead of
// sizing to the diagram, identically whether there is a diagram to show or the section is empty.
describe("DiagramSection — picture stage fills leftover height", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    updateSectionBodyMock.mockReset();
    setStateMock.mockClear();
    mockActiveNote = null;
  });
  afterEach(() => vi.useRealTimers());
  const flush = (ms = 0) => act(() => vi.advanceTimersByTimeAsync(ms));

  const stageFillContract = () => {
    const stage = document.querySelector<HTMLElement>(".diagram-stage");
    expect(stage).toBeTruthy();
    return { flex: stage!.style.flex, minHeight: stage!.style.minHeight };
  };

  it("the picture surface fills the section's leftover height instead of sizing to the diagram", async () => {
    render(<DiagramSection section={diagramSection()} />);
    await flush();
    expect(stageFillContract()).toEqual({ flex: "1 1 0%", minHeight: "0px" });
  });

  it("the empty state fills the SAME way, so switching sections cannot move the panel", async () => {
    render(<DiagramSection section={diagramSection({ body_md: "  " })} />);
    await flush();
    expect(screen.getByTestId("diagram-empty-state")).toBeTruthy();
    expect(stageFillContract()).toEqual({ flex: "1 1 0%", minHeight: "0px" });
  });
});

// ─── Structured authoring through the REAL canvas (recovered) ─────────────────────────────────────
// FlowCanvas is React.lazy + Suspense, and React Flow measures real DOM nodes/edges — jsdom reports
// every box as 0×0 and never lays out an edge's path at all (see FlowCanvas.test.tsx's own note on
// this). Fake timers can't wait out a dynamic import resolving, so this block uses REAL timers with
// `waitFor` to let the lazy chunk mount, and `flushAll()` (the same app-wide flush a note switch or
// window close triggers) instead of advancing the 700ms save debounce, so each test still runs fast.
describe("DiagramSection — structured authoring through the real canvas", () => {
  beforeEach(() => {
    updateSectionBodyMock.mockReset();
    setStateMock.mockClear();
    mockActiveNote = null;
  });

  const TWO_NODE_ONE_EDGE = JSON.stringify({
    v: 1,
    nodes: [{ id: "n1", label: "김철수" }, { id: "n2", label: "김영수" }],
    edges: [{ id: "e1", from: "n1", to: "n2", label: "아들" }],
  });
  const TWO_NODES_NO_EDGE = JSON.stringify({
    v: 1,
    nodes: [{ id: "n1", label: "김철수" }, { id: "n2", label: "김영수" }],
    edges: [],
  });

  const mountReal = (body: string, touch = false) =>
    render(<DiagramSection section={diagramSection({ body_md: body })} touch={touch} />);
  const waitForNode = (id: string) => waitFor(() => expect(screen.getByTestId(`rf__node-${id}`)).toBeTruthy());

  it("deleting the selected node cascades its edge and is one undoable step", async () => {
    mountReal(TWO_NODE_ONE_EDGE, true);
    await waitForNode("n1");

    fireEvent.click(screen.getByTestId("rf__node-n1"));
    await waitFor(() => expect(screen.getByTestId("diagram-delete-node")).toBeTruthy());
    fireEvent.click(screen.getByTestId("diagram-delete-node"));
    await flushAll();

    expect(updateSectionBodyMock).toHaveBeenCalledTimes(1);
    const afterDelete = parseDiagram(updateSectionBodyMock.mock.calls[0][1] as string);
    expect(afterDelete.nodes.map((n) => n.id)).toEqual(["n2"]);
    expect(afterDelete.edges).toEqual([]);

    // ONE 되돌리기 undoes the whole cascade — node, edge and all — in a single press.
    await waitFor(() => expect((screen.getByTestId("diagram-undo") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("diagram-undo"));
    await flushAll();
    const afterUndo = parseDiagram(updateSectionBodyMock.mock.calls[updateSectionBodyMock.mock.calls.length - 1][1] as string);
    expect(afterUndo.nodes.map((n) => n.id).sort()).toEqual(["n1", "n2"]);
    expect(afterUndo.edges).toHaveLength(1);
  });

  it("폰의 연결 = 관계 추가 폼(from/to 고르기) — 노드 동사에 여기서 연결은 더 없다 (GRILL-2026-10-19 R6)", async () => {
    mountReal(TWO_NODES_NO_EDGE, true);
    await waitForNode("n1");

    fireEvent.click(screen.getByTestId("rf__node-n2"));
    await waitFor(() => expect(screen.getByTestId("diagram-node-actions")).toBeTruthy());
    expect(screen.queryByTestId("diagram-connect")).toBeNull();

    fireEvent.click(screen.getByTestId("diagram-add-edge-toggle"));
    fireEvent.click(screen.getByTestId("diagram-edge-from"));
    fireEvent.click(within(screen.getByTestId("diagram-edge-from-list")).getByText("김영수"));
    fireEvent.click(screen.getByTestId("diagram-edge-to"));
    fireEvent.click(within(screen.getByTestId("diagram-edge-to-list")).getByText("김철수"));
    fireEvent.click(screen.getByTestId("diagram-add-edge"));
    await flushAll();

    expect(updateSectionBodyMock).toHaveBeenCalledTimes(1);
    const written = parseDiagram(updateSectionBodyMock.mock.calls[0][1] as string);
    expect(written.edges).toHaveLength(1);
    expect(written.edges[0]).toMatchObject({ from: "n2", to: "n1" });
  });

  it("도형/선 do not exist at all until something is selected — a dead control is unreachable", async () => {
    mountReal(TWO_NODE_ONE_EDGE, true);
    await waitForNode("n1");

    // Nothing selected: neither menu exists in the DOM (not merely disabled).
    expect(screen.queryByTestId("diagram-shape")).toBeNull();
    expect(screen.queryByTestId("diagram-style")).toBeNull();

    fireEvent.click(screen.getByTestId("rf__node-n1"));
    await waitFor(() => expect(screen.getByTestId("diagram-shape")).toBeTruthy());
    // A node has a shape; it has no line style, so 선 stays absent rather than appearing disabled.
    expect(screen.queryByTestId("diagram-style")).toBeNull();
    expect(screen.getByTestId("diagram-shape").tagName).toBe("BUTTON");
  });

  it("the 도형 menu renders every shape the MODEL can write, and picking one mutates through diagramModel", async () => {
    mountReal(TWO_NODE_ONE_EDGE, true);
    await waitForNode("n2");

    fireEvent.click(screen.getByTestId("rf__node-n2"));
    await waitFor(() => expect(screen.getByTestId("diagram-shape")).toBeTruthy());
    fireEvent.click(screen.getByTestId("diagram-shape"));
    const list = screen.getByTestId("diagram-shape-list");
    // rect / round / stadium / circle / diamond — every shape diagramModel's SHAPES table can write.
    expect(list.querySelectorAll('[role="option"]')).toHaveLength(5);
    expect(list.parentElement).toBe(document.body); // portaled: no ancestor overflow can clip it
    fireEvent.click(list.querySelector('[data-value="diamond"]')!);
    await flushAll();

    expect(updateSectionBodyMock).toHaveBeenCalledTimes(1);
    const written = parseDiagram(updateSectionBodyMock.mock.calls[0][1] as string);
    expect(written.nodes.find((n) => n.id === "n2")?.shape).toBe("diamond");
  });

  it("clicking the picture's empty space clears selection", async () => {
    mountReal(TWO_NODE_ONE_EDGE);
    await waitForNode("n1");

    fireEvent.click(screen.getByTestId("rf__node-n1"));
    await waitFor(() => expect(screen.getByTestId("diagram-subject-chip")).toBeTruthy());

    const pane = document.querySelector(".react-flow__pane")!;
    fireEvent.click(pane);
    await waitFor(() => expect(screen.queryByTestId("diagram-subject-chip")).toBeNull());
    // …and the toolbar is what's back, not a dead end.
    expect(screen.getByTestId("diagram-view-tools")).toBeTruthy();
  });

  it("도형/선 appear on the touch surface too, gated by selection the same way as desktop", async () => {
    mountReal(TWO_NODE_ONE_EDGE, true);
    await waitForNode("n1");

    // No direction toggle on touch either — vertical is the unchangeable default (both surfaces).
    const controls = screen.getByTestId("diagram-controls");
    expect(controls.querySelector('[data-testid^="diagram-dir"]')).toBeNull();

    expect(screen.queryByTestId("diagram-shape")).toBeNull();
    fireEvent.click(screen.getByTestId("rf__node-n1"));
    await waitFor(() => expect(screen.getByTestId("diagram-node-actions")).toBeTruthy());
    expect(screen.getByTestId("diagram-node-actions").querySelector('[data-testid="diagram-shape"]')).toBeTruthy();
    expect(screen.getByTestId("diagram-node-actions").querySelector('[data-testid="diagram-style"]')).toBeNull();
  });
});
