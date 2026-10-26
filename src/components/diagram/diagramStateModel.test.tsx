import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { t } from "../../i18n/t";
import { DiagramLegend } from "./FlowCanvas";
import { parseDiagramJson, serializeDiagram, type DiagramModel, type DiagramNode } from "./diagramSchema";
import { makeDiagramActions } from "./diagramActions";
import { nodeVerbs } from "./verbs";
import { STATE_SLOT_DEFS, stateSlotDef } from "./diagramStyles";
import koEditor from "../../i18n/ko/editor.json";
import enEditor from "../../i18n/en/editor.json";
import frEditor from "../../i18n/fr/editor.json";

describe("W1b: Diagram State Model, Flags, Badges, and Legend", () => {
  const SAMPLE_IR_8_NODES: DiagramModel = {
    v: 1,
    empty: false,
    structured: true,
    route: "curve",
    states: ["예약완료", "미정", "취소"],
    flagLabel: "강조",
    nodes: [
      { id: "n1", label: "노드1", state: 0 },
      { id: "n2", label: "노드2", state: 0 },
      { id: "n3", label: "노드3", state: 0 },
      { id: "n4", label: "노드4", state: 1 },
      { id: "n5", label: "노드5", state: 1 },
      { id: "n6", label: "노드6", state: 1 },
      { id: "n7", label: "노드7", state: 1 },
      { id: "n8", label: "노드8", state: 2 },
    ],
    edges: [],
    groups: [],
    direction: "TD",
  };

  it("renders exact legend counts '예약완료 3 · 미정 4 · 취소 1' for 8 nodes across 3 states", () => {
    render(<DiagramLegend model={SAMPLE_IR_8_NODES} />);

    const legendEl = screen.getByTestId("diagram-legend");
    expect(legendEl).toBeTruthy();
    expect(legendEl.textContent).toContain("예약완료 3");
    expect(legendEl.textContent).toContain("미정 4");
    expect(legendEl.textContent).toContain("취소 1");
    // 스와치는 이제 `■` 글자가 아니라 슬롯 색을 칠하는 CSS 사각형이다 — 순서/색으로 확인한다.
    expect(legendEl.textContent!.replace(/\s+/g, " ")).toContain("예약완료 3 · 미정 4 · 취소 1");
    const markers = legendEl.querySelectorAll<HTMLElement>(".diagram-legend-marker");
    expect(markers.length).toBe(3);
    expect(markers[0].style.color).toBe("var(--danger-soft)");
    expect(markers[1].style.color).toBe("var(--ok)");
    expect(markers[2].style.color).toBe("var(--muted)");
  });

  it("summarises boxes, relations and groups — always, even with no states", () => {
    render(
      <DiagramLegend
        model={{ ...SAMPLE_IR_8_NODES, states: [], groups: [{ id: "g1", title: "G" }] }}
      />
    );
    const summary = screen.getByTestId("diagram-legend-summary");
    expect(summary.textContent).toContain("8 boxes");
    expect(summary.textContent).toContain("1 groups");
  });

  // 상태가 없어도 통계는 남는다 — 예전엔 줄 전체가 사라져 개수조차 못 봤다(오너 지적).
  it("keeps the summary but drops the state chips when model.states is empty", () => {
    const emptyStatesModel: DiagramModel = {
      ...SAMPLE_IR_8_NODES,
      states: [],
    };
    render(<DiagramLegend model={emptyStatesModel} />);
    expect(screen.getByTestId("diagram-legend-summary").textContent).toContain("8");
    expect(screen.queryByTestId("diagram-legend-chip-0")).toBeNull();
  });

  it("triggers onHoverState on mouse enter and leave on legend chips", () => {
    const onHoverState = vi.fn();
    const onToggleState = vi.fn();
    render(
      <DiagramLegend
        model={SAMPLE_IR_8_NODES}
        onHoverState={onHoverState}
        onToggleState={onToggleState}
        hoveredState={1}
      />
    );

    const chip0 = screen.getByTestId("diagram-legend-chip-0");
    const chip1 = screen.getByTestId("diagram-legend-chip-1");

    expect(chip1.getAttribute("data-hovered")).toBe("true");
    expect(chip0.getAttribute("data-hovered")).toBeNull();

    fireEvent.mouseEnter(chip0);
    expect(onHoverState).toHaveBeenCalledWith(0);

    fireEvent.mouseLeave(chip0);
    expect(onHoverState).toHaveBeenCalledWith(null);

    fireEvent.click(chip0);
    expect(onToggleState).toHaveBeenCalledWith(0, false);
  });

  it("omits state verb when model.states is empty, but includes it when present", () => {
    const node: DiagramNode = { id: "n1", label: "호텔" };
    const mockActions = {
      shape: "rect" as const,
      style: "solid" as const,
      setShapeDefault: vi.fn(),
      setStyleDefault: vi.fn(),
      addNode: vi.fn(),
      connect: vi.fn(),
      connectBatch: vi.fn(),
      createChild: vi.fn(),
      addConnected: vi.fn(),
      expandChildren: vi.fn(() => []),
      reparent: vi.fn(),
      retarget: vi.fn(),
      setNodeShape: vi.fn(),
      setNodeMeta: vi.fn(),
      setNodePos: vi.fn(),
      setNodePositions: vi.fn(),
      addGroup: vi.fn(),
      renameGroup: vi.fn(),
      setGroupTone: vi.fn(),
      groupTone: vi.fn(() => "default" as const),
      dissolveGroup: vi.fn(),
      setEdgeStyle: vi.fn(),
      setEdgeLine: vi.fn(),
      setEdgeArrow: vi.fn(),
      setEdgeTone: vi.fn(),
      edgeTone: vi.fn(() => "default" as const),
      setRoute: vi.fn(),
      rename: vi.fn(),
      setEdgeLabel: vi.fn(),
      deleteNode: vi.fn(),
      deleteEdge: vi.fn(),
      setDirection: vi.fn(),
      setLayout: vi.fn(),
      setNodeTone: vi.fn(),
      nodeTone: vi.fn(() => "default" as const),
      setNodeMark: vi.fn(),
      setNodesMark: vi.fn(),
      setNodeState: vi.fn(),
      setNodeFlag: vi.fn(),
      toggleNodeFlag: vi.fn(),
      setNodeTag: vi.fn(),
      setNodeRows: vi.fn(),
      setStates: vi.fn(),
      pickNote: vi.fn(),
      unlinkNote: vi.fn(),
      openNote: vi.fn(),
      addFromText: vi.fn(() => ({ ok: true })),
    };

    // 1. model.states 가 빈 배열일 때
    const emptyStatesModel: DiagramModel = { ...SAMPLE_IR_8_NODES, states: [] };
    const verbsWithoutStates = nodeVerbs({
      node,
      model: emptyStatesModel,
      actions: mockActions,
    });
    expect(verbsWithoutStates.find((v) => v.id === "diagram-state")).toBeUndefined();
    // 플래그 동사는 여전히 존재해야 함 (배지 동사는 2026-10-19 GRILL R6 로 빠졌다)
    expect(verbsWithoutStates.find((v) => v.id === "diagram-flag")).toBeDefined();
    expect(verbsWithoutStates.find((v) => v.id === "diagram-tag")).toBeUndefined();

    // 2. model.states 가 있을 때
    const verbsWithStates = nodeVerbs({
      node,
      model: SAMPLE_IR_8_NODES,
      actions: mockActions,
    });
    const stateVerb = verbsWithStates.find((v) => v.id === "diagram-state");
    expect(stateVerb).toBeDefined();
    expect(stateVerb?.menu?.options.map((o) => o.label)).toEqual([t("editor.diagram_state_none"), "예약완료", "미정", "취소"]);
  });

  it("nodeVerbs keeps the core verbs and drops 배지·아이콘·설명·구획·여기서 연결 (GRILL-2026-10-19 R6)", () => {
    const node: DiagramNode = { id: "n1", label: "호텔", tag: "D-1", state: 0, flag: true };
    const mockActions = {} as any;

    const withRename = nodeVerbs({
      node,
      model: SAMPLE_IR_8_NODES,
      actions: mockActions,
      onRename: vi.fn(),
    }).map((v) => v.id);

    const mobile = nodeVerbs({
      node,
      model: SAMPLE_IR_8_NODES,
      actions: mockActions,
    }).map((v) => v.id);

    for (const ids of [withRename, mobile]) {
      expect(ids).toContain("diagram-shape");
      expect(ids).toContain("diagram-state");
      expect(ids).toContain("diagram-flag");
      expect(ids).toContain("diagram-delete-node");
      for (const gone of ["diagram-tag", "diagram-node-icon", "diagram-node-desc", "diagram-node-rows", "diagram-connect"]) {
        expect(ids).not.toContain(gone);
      }
    }
    // 강조 동사 이름 = 범례·색 칩 이름(flagLabelOf)
    const flagVerb = nodeVerbs({ node, model: { ...SAMPLE_IR_8_NODES, flagLabel: "필수" }, actions: mockActions }).find(
      (v) => v.id === "diagram-flag",
    );
    expect(flagVerb?.label).toBe("필수");
  });

  it("updates node state and reverts via 1 undo step", () => {
    let source = serializeDiagram(SAMPLE_IR_8_NODES);
    const undoStack: string[] = [];

    const apply = (next: string) => {
      undoStack.push(source);
      source = next;
    };

    const actions = makeDiagramActions({
      source: () => source,
      apply,
      select: vi.fn(),
      shape: "rect",
      style: "solid",
      setShapeDefault: vi.fn(),
      setStyleDefault: vi.fn(),
      pickNote: vi.fn(),
      openNote: vi.fn(),
    });

    // n1 노드의 상태를 0에서 2(취소)로 변경
    expect(parseDiagramJson(source).nodes.find((n) => n.id === "n1")?.state).toBe(0);
    actions.setNodeState("n1", 2);
    expect(parseDiagramJson(source).nodes.find((n) => n.id === "n1")?.state).toBe(2);
    expect(undoStack.length).toBe(1);

    // 되돌리기 1스텝
    source = undoStack.pop()!;
    expect(parseDiagramJson(source).nodes.find((n) => n.id === "n1")?.state).toBe(0);
  });

  it("toggles node flag and sets badge tag cleanly with 1-step undo", () => {
    let source = serializeDiagram(SAMPLE_IR_8_NODES);
    const undoStack: string[] = [];
    const apply = (next: string) => {
      undoStack.push(source);
      source = next;
    };

    const actions = makeDiagramActions({
      source: () => source,
      apply,
      select: vi.fn(),
      shape: "rect",
      style: "solid",
      setShapeDefault: vi.fn(),
      setStyleDefault: vi.fn(),
      pickNote: vi.fn(),
      openNote: vi.fn(),
    });

    // Flag toggle
    expect(parseDiagramJson(source).nodes.find((n) => n.id === "n1")?.flag).toBeUndefined();
    actions.toggleNodeFlag("n1");
    expect(parseDiagramJson(source).nodes.find((n) => n.id === "n1")?.flag).toBe(true);

    // Tag set
    actions.setNodeTag("n1", "D-Day");
    expect(parseDiagramJson(source).nodes.find((n) => n.id === "n1")?.tag).toBe("D-Day");

    // Revert tag
    source = undoStack.pop()!;
    expect(parseDiagramJson(source).nodes.find((n) => n.id === "n1")?.tag).toBeUndefined();
    expect(parseDiagramJson(source).nodes.find((n) => n.id === "n1")?.flag).toBe(true);

    // Revert flag
    source = undoStack.pop()!;
    expect(parseDiagramJson(source).nodes.find((n) => n.id === "n1")?.flag).toBeUndefined();
  });

  it("preserves state, flag, tag, states, and flagLabel across round-trip serialization", () => {
    const raw: DiagramModel = {
      v: 1,
      empty: false,
      structured: true,
      route: "curve",
      states: ["대기", "진행중", "완료"],
      flagLabel: "중요",
      nodes: [
        {
          id: "n1",
          label: "인천공항",
          state: 1,
          flag: true,
          tag: "D-3",
          desc: "오전 9시",
          icon: "🛩",
          pos: [10, 20],
        },
      ],
      edges: [],
      groups: [],
      direction: "LR",
    };

    const serialized = serializeDiagram(raw);
    const parsed = parseDiagramJson(serialized);

    expect(parsed.states).toEqual(["대기", "진행중", "완료"]);
    expect(parsed.flagLabel).toBe("중요");
    const n1 = parsed.nodes.find((n) => n.id === "n1");
    expect(n1?.state).toBe(1);
    expect(n1?.flag).toBe(true);
    expect(n1?.tag).toBe("D-3");
    expect(n1?.desc).toBe("오전 9시");
    expect(n1?.icon).toBe("🛩");
    expect(n1?.pos).toEqual([10, 20]);
  });

  it("validates that all 6 slots are defined with valid contrast variables", () => {
    expect(STATE_SLOT_DEFS.length).toBe(6);
    for (let i = 0; i < 6; i++) {
      const def = stateSlotDef(i);
      expect(def.slot).toBe(i);
      expect(def.colorVar).toMatch(/^var\(--(danger-soft|ok|muted|info|danger)\)$/);
      expect(["solid", "dashed"]).toContain(def.borderStyle);
    }
  });

  it("confirms required i18n keys are present in all 3 locales (ko, en, fr)", () => {
    const requiredKeys = [
      "diagram_state",
      "diagram_state_none",
      "diagram_flag",
      "diagram_tag",
      "diagram_tag_placeholder",
      "diagram_states_config",
      "diagram_states_config_title",
      "diagram_states_config_desc",
      "diagram_state_slot_label",
      "diagram_state_slot_placeholder",
      "diagram_flag_label",
      "diagram_flag_label_placeholder",
    ];

    for (const key of requiredKeys) {
      expect(koEditor).toHaveProperty(key);
      expect(enEditor).toHaveProperty(key);
      expect(frEditor).toHaveProperty(key);
    }
  });
});
