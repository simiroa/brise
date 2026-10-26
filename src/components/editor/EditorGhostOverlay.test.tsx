import { describe, it, expect, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import { EditorGhostOverlay, ghostDiagram, renderPresetGhostHtml, resolveGhostBody } from "./EditorGhostOverlay";
import { LAYOUT_HOVER_PREFIX } from "../../stores/presets";
import { usePresetsStore, TODO_PRESET_BODY_MD } from "../../stores/presets";
import { DIAGRAM_PRESET_SEED, DIAGRAM_MINDMAP_SEED, diagramTemplateSource } from "../diagram/diagramStarter";
import { parseDiagramJson } from "../diagram/diagramSchema";
import { createEmptySheetJson } from "../sheet/sheetStarter";

describe("EditorGhostOverlay component", () => {
  beforeEach(() => {
    act(() => {
      usePresetsStore.setState({
        targetState: "has_content",
        hovered: null,
      });
    });
  });

  it("renders with opacity 0 when nothing is hovered", () => {
    const { container } = render(<EditorGhostOverlay />);
    const ghostEl = container.querySelector(".ghost-preview") as HTMLElement;
    expect(ghostEl).toBeTruthy();
    expect(ghostEl.style.opacity).toBe("0");
  });

  it("renders with opacity 1 and displays HTML when targetState is ready and preset is hovered", async () => {
    const scrollEl = document.createElement("div");
    const { container } = render(<EditorGhostOverlay scrollEl={scrollEl} />);

    act(() => {
      usePresetsStore.setState({
        targetState: "ready",
        hovered: { id: "todo", bodyMd: TODO_PRESET_BODY_MD },
      });
    });

    const ghostEl = container.querySelector(".ghost-preview") as HTMLElement;
    expect(ghostEl).toBeTruthy();
    expect(ghostEl.style.opacity).toBe("1");
    expect(ghostEl.innerHTML).toContain('type="checkbox"');
    expect(scrollEl.getAttribute("data-preset-preview")).toBe("true");
  });

  it("clears data-preset-preview when unhovered or targetState is not ready", () => {
    const scrollEl = document.createElement("div");
    render(<EditorGhostOverlay scrollEl={scrollEl} />);

    act(() => {
      usePresetsStore.setState({
        targetState: "ready",
        hovered: { id: "todo", bodyMd: TODO_PRESET_BODY_MD },
      });
    });
    expect(scrollEl.getAttribute("data-preset-preview")).toBe("true");

    act(() => {
      usePresetsStore.setState({
        targetState: "has_content",
        hovered: { id: "todo", bodyMd: TODO_PRESET_BODY_MD },
      });
    });
    expect(scrollEl.getAttribute("data-preset-preview")).toBeNull();
  });
});

describe("renderPresetGhostHtml & resolveGhostBody exports", () => {
  it("renderPresetGhostHtml generates valid HTML for markdown", () => {
    const html = renderPresetGhostHtml("# Heading\n\n- item 1");
    expect(html).toContain("<h1>");
    expect(html).toContain("Heading");
    expect(html).toContain("<li>");
  });

  it("resolveGhostBody returns null when not ready", () => {
    expect(resolveGhostBody("has_content", { id: "todo", bodyMd: "test" })).toBeNull();
    expect(resolveGhostBody("diagram", { id: "todo", bodyMd: "test" })).toBeNull();
  });

  it("resolveGhostBody returns bodyMd when ready and valid body", () => {
    expect(resolveGhostBody("ready", { id: "todo", bodyMd: "test" })).toBe("test");
  });
});

// PLAN-2026-09-20 W1 — 관계도 프리셋 호버 시 고스트에 정적 SVG. 게이트는 여전히 resolveGhostBody 하나:
// 같은 targetState 에서 같은 hovered.bodyMd 를 받고, 그 문자열이 관계도 JSON 이면 SVG 로 갈릴 뿐이다.
describe("EditorGhostOverlay — 관계도 시드는 마크다운이 아니라 SVG 로 그린다", () => {
  beforeEach(() => {
    act(() => {
      usePresetsStore.setState({ targetState: "has_content", hovered: null });
    });
  });

  it("ghostDiagram: 관계도 JSON 만 모델을 돌려주고 산문·시트 JSON·빈 관계도·null 은 null", () => {
    expect(ghostDiagram(DIAGRAM_PRESET_SEED)?.nodes.length).toBe(3);
    expect(ghostDiagram(TODO_PRESET_BODY_MD)).toBeNull();
    expect(ghostDiagram(createEmptySheetJson())).toBeNull();
    expect(ghostDiagram('{"v":1,"nodes":[],"edges":[]}')).toBeNull();
    expect(ghostDiagram(null)).toBeNull();
  });

  it.each([
    ["diagram", DIAGRAM_PRESET_SEED],
    ["diagram_mindmap", DIAGRAM_MINDMAP_SEED],
    ["people", diagramTemplateSource("people")],
  ])("%s 호버 → <svg> 존재 + 노드 수 = <g data-node> 수, ProseMirror 고스트는 없다", (id, seed) => {
    const scrollEl = document.createElement("div");
    const { container } = render(<EditorGhostOverlay scrollEl={scrollEl} />);
    act(() => {
      usePresetsStore.setState({ targetState: "ready", hovered: { id, bodyMd: seed } });
    });
    const ghostEl = container.querySelector(".ghost-preview") as HTMLElement;
    expect(ghostEl.style.opacity).toBe("1");
    expect(container.querySelector("svg")).toBeTruthy();
    expect(container.querySelectorAll("g[data-node]").length).toBe(parseDiagramJson(seed).nodes.length);
    expect(container.querySelector(".ProseMirror")).toBeNull();
    expect(scrollEl.getAttribute("data-preset-preview")).toBe("true");
  });

  // PLAN-2026-09-21 W1: 관계도의 타입 27장은 이제 어시스트의 **시작** 모드에서만 뜨고, 시작은 항상
  // targetState "ready" 다 — "diagram" 상태(내용 있는 관계도) 위에서 타입을 다시 호버할 길이 없으니
  // PLAN-2026-09-20 §5 함정 12 의 특례(diagram+시드 인정)를 되돌린다. 게이트는 다시 `ready` 한 줄.
  it("diagram 탭(targetState diagram)에서는 관계도 시드를 호버해도 그리지 않는다", () => {
    const { container } = render(<EditorGhostOverlay />);
    act(() => {
      usePresetsStore.setState({ targetState: "diagram", hovered: { id: "diagram", bodyMd: DIAGRAM_PRESET_SEED } });
    });
    expect(container.querySelector("svg")).toBeNull();
    const ghostEl = container.querySelector(".ghost-preview") as HTMLElement;
    expect(ghostEl.style.opacity).toBe("0");
    expect(ghostEl.getAttribute("data-over-content")).toBeNull();
  });

  it("빈 시트(ready)에서 시트 템플릿 JSON 호버 → 산문 고스트로 새지 않는다(셀 고스트는 SheetGhostOverlay 몫)", () => {
    const { container } = render(<EditorGhostOverlay />);
    act(() => {
      usePresetsStore.setState({ targetState: "ready", hovered: { id: "budget", bodyMd: createEmptySheetJson() } });
    });
    expect((container.querySelector(".ghost-preview") as HTMLElement).style.opacity).toBe("0");
    expect(container.querySelector(".ProseMirror")?.innerHTML ?? "").not.toContain("cells");
  });

  it("diagram/has_content 에서는 산문·시트 JSON 은 물론 관계도 시드도 그리지 않는다(ready 한 줄 게이트)", () => {
    expect(resolveGhostBody("diagram", { id: "todo", bodyMd: TODO_PRESET_BODY_MD })).toBeNull();
    expect(resolveGhostBody("diagram", { id: "budget", bodyMd: createEmptySheetJson() })).toBeNull();
    expect(resolveGhostBody("has_content", { id: "diagram", bodyMd: DIAGRAM_PRESET_SEED })).toBeNull();
    expect(resolveGhostBody("diagram", { id: "people", bodyMd: diagramTemplateSource("people") })).toBeNull();
  });

  it("관계도 → 산문으로 호버가 옮겨가면 SVG 가 내려가고 마크다운 고스트가 선다", () => {
    const { container } = render(<EditorGhostOverlay />);
    act(() => {
      usePresetsStore.setState({ targetState: "ready", hovered: { id: "diagram", bodyMd: DIAGRAM_PRESET_SEED } });
    });
    expect(container.querySelector("svg")).toBeTruthy();
    act(() => {
      usePresetsStore.setState({ hovered: { id: "todo", bodyMd: TODO_PRESET_BODY_MD } });
    });
    expect(container.querySelector("svg")).toBeNull();
    expect(container.innerHTML).toContain('type="checkbox"');
  });
});

// 배치 바꾸기(베타) 호버 — 내용 있는 관계도(targetState "diagram") 위에 "이 배치면 이렇게" 고스트. 게이트는 여전히 하나.
describe("EditorGhostOverlay — 배치 행 호버는 diagram 상태에서만, 불투명 바탕으로", () => {
  const laid = JSON.stringify({ ...JSON.parse(DIAGRAM_PRESET_SEED), layout: "radial" });
  it("resolveGhostBody: layout: 행은 diagram 에서 통과, ready 에서 막힘; 산문·시드는 그대로", () => {
    expect(resolveGhostBody("diagram", { id: `${LAYOUT_HOVER_PREFIX}radial`, bodyMd: laid })).toBe(laid);
    expect(resolveGhostBody("ready", { id: `${LAYOUT_HOVER_PREFIX}radial`, bodyMd: laid })).toBeNull();
    expect(resolveGhostBody("diagram", { id: "diagram", bodyMd: DIAGRAM_PRESET_SEED })).toBeNull();
    expect(resolveGhostBody("ready", { id: "todo", bodyMd: "test" })).toBe("test");
  });
  it("diagram 상태에서 layout:radial 호버 → SVG + data-over-content, 떠나면 둘 다 내려간다", () => {
    const { container } = render(<EditorGhostOverlay />);
    act(() => {
      usePresetsStore.setState({ targetState: "diagram", hovered: { id: `${LAYOUT_HOVER_PREFIX}radial`, bodyMd: laid } });
    });
    const ghostEl = container.querySelector(".ghost-preview") as HTMLElement;
    expect(container.querySelector("svg")).toBeTruthy();
    expect(ghostEl.style.opacity).toBe("1");
    expect(ghostEl.getAttribute("data-over-content")).toBe("true");
    act(() => {
      usePresetsStore.setState({ hovered: null });
    });
    expect(ghostEl.style.opacity).toBe("0");
    expect(ghostEl.getAttribute("data-over-content")).toBeNull();
  });
});
