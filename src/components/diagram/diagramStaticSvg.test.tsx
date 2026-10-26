import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render } from "@testing-library/react";
import { DiagramStaticSvg } from "./diagramStaticSvg";
import { parseDiagramJson, createEmptyDiagramModel } from "./diagramSchema";
import { DIAGRAM_TILES, diagramTemplateSource } from "./diagramStarter";
import { STATE_SLOT_DEFS } from "./diagramStyles";

describe("DiagramStaticSvg", () => {
  it("파일 소스에 xyflow 가 없다 — 정적 렌더러는 캔버스 청크를 끌고 오지 않는다", () => {
    const src = readFileSync(resolve(__dirname, "diagramStaticSvg.tsx"), "utf8");
    expect(src.includes("xyflow")).toBe(false);
  });

  it.each(DIAGRAM_TILES.map((t) => [t.id, t.source] as [string, string]))(
    "%s — <svg> 하나, 노드 수 = <g data-node> 수, 엣지 수 = <g data-edge> 수",
    (_id, source) => {
      const model = parseDiagramJson(source);
      const { container } = render(<DiagramStaticSvg model={model} />);
      const svgs = container.querySelectorAll("svg");
      expect(svgs.length).toBe(1);
      expect(container.querySelectorAll("g[data-node]").length).toBe(model.nodes.length);
      expect(container.querySelectorAll("g[data-edge]").length).toBe(model.edges.length);
      expect(container.querySelectorAll("path[d]").length).toBeGreaterThanOrEqual(model.edges.length);
      // viewBox 는 내용 bbox + 여백 — 폭·높이가 양수다.
      const [, , w, h] = (svgs[0].getAttribute("viewBox") ?? "").split(" ").map(Number);
      expect(w).toBeGreaterThan(0);
      expect(h).toBeGreaterThan(0);
    },
  );

  it("도형 5종이 SVG 요소로 갈린다 — rect/round 는 rect, stadium 은 rx=h/2, circle 은 ellipse, diamond 는 polygon", () => {
    const model = parseDiagramJson(diagramTemplateSource("decision"));
    const { container } = render(<DiagramStaticSvg model={model} />);
    expect(container.querySelector('g[data-node="n1"] polygon')).toBeTruthy(); // diamond
    expect(container.querySelector('g[data-node="n2"] rect')).toBeTruthy(); // rect
    const stadium = container.querySelector('g[data-node="n4"] rect')!;
    expect(Number(stadium.getAttribute("rx"))).toBe(Number(stadium.getAttribute("height")) / 2);
    const sys = parseDiagramJson(diagramTemplateSource("system"));
    const { container: c2 } = render(<DiagramStaticSvg model={sys} />);
    expect(c2.querySelector('g[data-node="n4"] ellipse')).toBeTruthy(); // circle
  });

  it("상태 슬롯 색은 stateSlotDef 의 토큰 그대로, 플래그는 accent, 화살촉은 arrow 값을 따른다", () => {
    const model = parseDiagramJson(diagramTemplateSource("comparison"));
    const { container } = render(<DiagramStaticSvg model={model} />);
    // n2 state 0 → slot 0 colorVar
    expect(container.querySelector('g[data-node="n2"] rect')!.getAttribute("stroke")).toBe(STATE_SLOT_DEFS[0].colorVar);
    // n3 state 2 → slot 2 는 dashed
    expect(container.querySelector('g[data-node="n3"] rect')!.getAttribute("stroke-dasharray")).toBe("4 3");
    // n1 flag → accent
    expect(container.querySelector('g[data-node="n1"] rect')!.getAttribute("stroke")).toBe("var(--accent)");

    const people = parseDiagramJson(diagramTemplateSource("people"));
    const { container: c2 } = render(<DiagramStaticSvg model={people} />);
    const both = c2.querySelector('g[data-edge="e3"] path')!; // arrow: both
    expect(both.getAttribute("marker-start")).toContain("url(#");
    expect(both.getAttribute("marker-end")).toContain("url(#");
    const mind = parseDiagramJson(diagramTemplateSource("mindmap"));
    const { container: c3 } = render(<DiagramStaticSvg model={mind} />);
    const none = c3.querySelector('g[data-edge="e1"] path')!; // arrow: none
    expect(none.getAttribute("marker-end")).toBeNull();
    expect(none.getAttribute("marker-start")).toBeNull();
  });

  it("엣지 라벨과 그룹 상자가 그려지고, 빈/비구조 모델은 아무것도 그리지 않는다", () => {
    const model = parseDiagramJson(
      JSON.stringify({
        v: 1,
        nodes: [
          { id: "a", label: "A", group: "g1" },
          { id: "b", label: "B", group: "g1" },
        ],
        edges: [{ id: "e", from: "a", to: "b", label: "관계" }],
        groups: [{ id: "g1", title: "묶음" }],
      }),
    );
    const { container } = render(<DiagramStaticSvg model={model} />);
    expect(container.querySelector('g[data-group="g1"] rect')).toBeTruthy();
    expect(container.querySelector('g[data-group="g1"] text')!.textContent).toBe("묶음");
    expect(container.querySelector('g[data-edge="e"] text')!.textContent).toBe("관계");

    expect(render(<DiagramStaticSvg model={createEmptyDiagramModel()} />).container.querySelector("svg")).toBeNull();
    expect(render(<DiagramStaticSvg model={parseDiagramJson("not json")} />).container.querySelector("svg")).toBeNull();
  });

  it("드래그된 pos 가 있으면 그 자리를 쓴다 — 편집한 관계도의 고스트/프리뷰가 캔버스와 같은 자리", () => {
    const model = parseDiagramJson(
      JSON.stringify({
        v: 1,
        nodes: [
          { id: "a", label: "A", pos: [300, 400] },
          { id: "b", label: "B", pos: [10, 20] },
        ],
        edges: [],
      }),
    );
    const { container } = render(<DiagramStaticSvg model={model} />);
    const a = container.querySelector('g[data-node="a"] rect')!;
    expect(Number(a.getAttribute("x"))).toBe(300);
    expect(Number(a.getAttribute("y"))).toBe(400);
  });
});

describe("DiagramStaticSvg — W2 rows · axes · 새 배치", () => {
  it("rows 는 구획선 하나 + 줄마다 <text>; 노드 높이가 rows 만큼 자란다", () => {
    const model = parseDiagramJson(diagramTemplateSource("er"));
    const { container } = render(<DiagramStaticSvg model={model} />);
    const n1 = container.querySelector('g[data-node="n1"]')!;
    expect(n1.querySelectorAll("g[data-rows] line").length).toBe(1);
    expect(Array.from(n1.querySelectorAll("g[data-rows] text")).map((t) => t.textContent)).toEqual(["id: uuid", "email: text", "created_at: timestamp"]);
    expect(Number(n1.querySelector("rect")!.getAttribute("height"))).toBe(36 + 3 * 16);
    expect(container.querySelector('g[data-node="n2"] g[data-rows]')).toBeTruthy();
  });

  it("quadrant 는 축 십자 2줄 + 라벨 4개를 그룹보다 먼저(아래에) 그린다; 다른 배치는 안 그린다", () => {
    const model = parseDiagramJson(diagramTemplateSource("quadrant"));
    const { container } = render(<DiagramStaticSvg model={model} />);
    const axes = container.querySelector("g[data-axes]")!;
    expect(axes.querySelectorAll("line").length).toBe(2);
    expect(Array.from(axes.querySelectorAll("text")).map((t) => t.textContent)).toEqual(["노력 적음", "노력 많음", "효과 낮음", "효과 높음"]);
    const svg = container.querySelector("svg")!;
    const order = Array.from(svg.children).map((c) => (c.hasAttribute("data-axes") ? "axes" : c.hasAttribute("data-group") ? "group" : c.tagName));
    expect(order.indexOf("axes")).toBeLessThan(order.indexOf("group"));
    const { container: c2 } = render(<DiagramStaticSvg model={parseDiagramJson(diagramTemplateSource("stack"))} />);
    expect(c2.querySelector("g[data-axes]")).toBeNull();
  });

  it("sequence 시드: g[data-edge] 4개의 path 가 전부 수평이고 y 가 엣지 순서로 증가, 라이프라인 line 3개 (W2b)", () => {
    const model = parseDiagramJson(diagramTemplateSource("sequence"));
    const { container } = render(<DiagramStaticSvg model={model} />);
    const paths = Array.from(container.querySelectorAll("g[data-edge] path")).map((p) => p.getAttribute("d")!);
    expect(paths.length).toBe(4);
    const ys = paths.map((d) => {
      const m = d.match(/^M (-?[\d.]+),(-?[\d.]+) L (-?[\d.]+),(-?[\d.]+)$/)!;
      expect(m, d).toBeTruthy();
      expect(m[2]).toBe(m[4]);
      return Number(m[2]);
    });
    for (let i = 1; i < ys.length; i++) expect(ys[i]).toBeGreaterThan(ys[i - 1]);
    const lines = container.querySelectorAll("g[data-lifelines] line");
    expect(lines.length).toBe(3);
    // viewBox 가 라이프라인 아래 끝까지 덮는다.
    const [, , , h] = container.querySelector("svg")!.getAttribute("viewBox")!.split(" ").map(Number);
    expect(h).toBeGreaterThan(Number(lines[0].getAttribute("y2")) - 24);
    expect(render(<DiagramStaticSvg model={parseDiagramJson(diagramTemplateSource("stack"))} />).container.querySelector("g[data-lifelines]")).toBeNull();
  });

  it("stack 시드는 모든 노드 rect 의 x 가 같다 — 정적 SVG 도 layoutFor 를 탄다", () => {
    const model = parseDiagramJson(diagramTemplateSource("stack"));
    const { container } = render(<DiagramStaticSvg model={model} />);
    const xs = Array.from(container.querySelectorAll("g[data-node] rect")).map((r) => r.getAttribute("x"));
    expect(new Set(xs).size).toBe(1);
  });
});

// 고스트/프리뷰의 fit — 모든 노드가 보이도록 상자에 맞추되(100%×100% + meet), 자연 크기 이상으로 확대하지 않는다
// (오너 2026-09-20: "너무 확대되면 안 되고 모든 노드가 다 보여야").
describe("DiagramStaticSvg — fit", () => {
  it("fit: width/height 100%, max-width/height = viewBox 크기", () => {
    const model = parseDiagramJson(diagramTemplateSource("basic"));
    const { container } = render(<DiagramStaticSvg model={model} fit />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("width")).toBe("100%");
    expect(svg.getAttribute("height")).toBe("100%");
    const [, , vw, vh] = svg.getAttribute("viewBox")!.split(" ").map(Number);
    expect(svg.style.maxWidth).toBe(`${vw}px`);
    expect(svg.style.maxHeight).toBe(`${vh}px`);
    expect(svg.getAttribute("preserveAspectRatio")).toBeNull(); // 기본 xMidYMid meet
  });
});
