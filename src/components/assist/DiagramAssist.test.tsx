import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DiagramAssist } from "./DiagramAssist";
import { useDiagramFocus, type DiagramFocus } from "../../stores/diagramFocus";
import { usePresetsStore } from "../../stores/presets";
import { DIAGRAM_LAYOUTS } from "../diagram/diagramSchema";
import { t } from "../../i18n/t";
import { bump } from "../../lib/diagramTypeUsage";
import type { usePresetEntries } from "./usePresetEntries";

type Entries = ReturnType<typeof usePresetEntries>;

// work(!blank) 분기는 entries 를 쓰지 않는다(레지스트리 타입 목록은 start 전용) — 실제 훅을 돌릴
// 필요가 없어 빈 값으로 충분하다.
// 배치 행 호버(hoverProps)만 쓴다 — 여기선 빈 핸들러.
const entries = { hoverProps: () => ({}) } as unknown as Entries;
const SOURCE = JSON.stringify({ v: 1, nodes: [{ id: "a", label: "A", pos: [10, 10] }, { id: "b", label: "B" }], edges: [{ id: "e", from: "a", to: "b" }] });

// 배치 바꾸기(베타, PLAN-2026-09-21 W4/D4) — 이 그룹을 삭제할 때 함께 지울 describe.
describe("DiagramAssist · 작업 모드 · 배치 바꾸기(베타)", () => {
  afterEach(() => {
    useDiagramFocus.setState({ focus: null });
  });

  function setFocus(patch: Partial<DiagramFocus> = {}) {
    useDiagramFocus.setState({
      focus: { sectionId: "sec-1", layout: undefined, source: SOURCE, setLayout: vi.fn(), ...patch },
    });
  }

  it("diagramFocus 가 없으면 그룹이 없다", () => {
    render(<DiagramAssist blank={false} entries={entries} glowOf={{}} setAskAiTarget={vi.fn()} />);
    expect(screen.queryByTestId("diagram-layout-group")).toBeNull();
    for (const name of DIAGRAM_LAYOUTS) expect(screen.queryByTestId(`diagram-layout-${name}`)).toBeNull();
  });

  it("diagramFocus 가 있으면 9개 배치 행이 DIAGRAM_LAYOUTS 순서대로 나온다", () => {
    setFocus();
    render(<DiagramAssist blank={false} entries={entries} glowOf={{}} setAskAiTarget={vi.fn()} />);
    expect(screen.getByTestId("diagram-layout-group")).toBeTruthy();
    expect(screen.getByText(t("editor.diagram_layout_title"))).toBeTruthy();
    for (const name of DIAGRAM_LAYOUTS) {
      expect(screen.getByTestId(`diagram-layout-${name}`)).toBeTruthy();
    }
  });

  it("행 클릭 → diagramFocus.setLayout 한 번, 인자는 그 행의 배치명", () => {
    const setLayout = vi.fn();
    setFocus({ setLayout });
    render(<DiagramAssist blank={false} entries={entries} glowOf={{}} setAskAiTarget={vi.fn()} />);
    fireEvent.click(screen.getByTestId("diagram-layout-radial"));
    expect(setLayout).toHaveBeenCalledTimes(1);
    expect(setLayout).toHaveBeenCalledWith("radial");
  });

  it("현재 배치 행만 aria-pressed=true(dagre 는 layout undefined 로 표시)", () => {
    setFocus({ layout: "grid" });
    render(<DiagramAssist blank={false} entries={entries} glowOf={{}} setAskAiTarget={vi.fn()} />);
    expect(screen.getByTestId("diagram-layout-grid").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("diagram-layout-dagre").getAttribute("aria-pressed")).toBe("false");
  });

  it("배치 행 호버 → hovered = layout:<name> + 그 배치로 재직렬화한 본문(pos 없음), 떠나면 지운다", () => {
    const hoverProps = vi.fn((id: string, bodyMd: string | (() => string)) => ({
      onMouseEnter: () => usePresetsStore.getState().setHovered(id, typeof bodyMd === "function" ? bodyMd() : bodyMd),
      onMouseLeave: () => usePresetsStore.getState().clearHovered(id),
    }));
    setFocus();
    render(<DiagramAssist blank={false} entries={{ hoverProps } as unknown as Entries} glowOf={{}} setAskAiTarget={vi.fn()} />);
    fireEvent.mouseEnter(screen.getByTestId("diagram-layout-radial"));
    const hovered = usePresetsStore.getState().hovered!;
    expect(hovered.id).toBe("layout:radial");
    const parsed = JSON.parse(hovered.bodyMd);
    expect(parsed.layout).toBe("radial");
    expect(parsed.nodes.every((n: { pos?: unknown }) => n.pos === undefined)).toBe(true);
    fireEvent.mouseLeave(screen.getByTestId("diagram-layout-radial"));
    expect(usePresetsStore.getState().hovered).toBeNull();
  });

  it("sequence 행에는 힌트 title 이 있다", () => {
    setFocus();
    render(<DiagramAssist blank={false} entries={entries} glowOf={{}} setAskAiTarget={vi.fn()} />);
    expect(screen.getByTestId("diagram-layout-sequence").getAttribute("title")).toBe(t("editor.diagram_layout_sequence_hint"));
  });

  // blank(시작) 모드는 diagramFocus 유무와 무관하게 배치 바꾸기 그룹이 없다(그룹이 `!blank` 분기
  // 안에만 있다) — AssistPanel.test.tsx 매트릭스가 blank=true 를 이미 usePresetEntries 실물로 덮는다.
});

// 타입 사용 카운트(오너 제안 #7) — 시작 모드 행 우측 흐린 숫자.
describe("DiagramAssist · 시작 모드 · 타입 사용 카운트", () => {
  const blankEntries = {
    hoverProps: () => ({}),
    applyDiagramType: vi.fn(),
    showDiagramAiFill: false,
    aiFillPending: null,
    fillDiagramWithAi: vi.fn(),
  } as unknown as Entries;

  beforeEach(() => localStorage.clear());

  it("카운트 있는 타입만 숫자가 보인다", () => {
    bump("basic", "seed");
    bump("basic", "seed");
    bump("basic", "ai");
    render(<DiagramAssist blank={true} entries={blankEntries} glowOf={{}} setAskAiTarget={vi.fn()} />);
    expect(screen.getByTestId("diagram-type-usage-basic").textContent).toBe("3");
    expect(screen.queryByTestId("diagram-type-usage-mindmap")).toBeNull();
  });
});
